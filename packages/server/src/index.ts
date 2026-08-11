/**
 * `@wise-excavate/server` — the daemon, and the composition root.
 *
 * **This is the only package that knows about all the others.** That is deliberate
 * (Part 14 §14.2): keeping composition in exactly one place is what keeps the rest of
 * the graph clean. It is also why `ai` and `evidence` can stay decoupled — the wiring
 * that connects an analyzer's output to a collector's input lives here, not in an
 * import between them.
 *
 * Note what it does *not* depend on: `@wise-excavate/ui`. The browser bundle is a build
 * artifact this package serves as static files, not a module it imports. A code edge
 * there would drag React into the daemon's type graph for no reason.
 *
 * **The daemon boundary is the highest-leverage decision in the project** (Part 7
 * §7.1): one HTTP layer buys the CLI, MCP, `serve`, shareable links, headless CI use,
 * and remote use over an SSH tunnel. It is also nearly free now and impossible to
 * retrofit.
 *
 * The implementation is split by concern — `security.ts`, `app.ts`, `http.ts`,
 * `session.ts`, `bus.ts`, `jobs.ts`, `dto.ts` — and this file is the contract those
 * modules implement. Every type that crosses the wire lives in `@wise-excavate/core`'s
 * `api.ts` instead, so `ui` can depend on the contract without depending on the daemon.
 */

import type { RepoId, RepoSummary, ServerEvent, Tier } from '@wise-excavate/core';
import { BIND_HOST, ExcavateError, TOKEN_QUERY_PARAM } from '@wise-excavate/core';
import type { GitBackend } from '@wise-excavate/git';
import type { Store } from '@wise-excavate/store';

import { createApp } from './app.js';
import type { Listener } from './http.js';
import { listen } from './http.js';
import { generateSessionToken } from './security.js';
import { openSession } from './session.js';

/* ── Lifecycle ─────────────────────────────────────────────────────────────── */

export interface ServerOptions {
  readonly repoRoot: string;
  /** `0` picks a random free port, which is the default posture. */
  readonly port: number;
  /** Generated per session when omitted. */
  readonly token?: string;
  /** Directory holding `index.db`. Defaults to the XDG cache location. */
  readonly indexDir?: string;
  /**
   * Run `Store.integrityCheck()` before serving, failing with `INDEX_CORRUPT` if it
   * reports problems.
   *
   * Off by default, and that is `@wise-excavate/store`'s explicit instruction rather than a
   * shortcut: the check reads every page of the file — seconds on the ~130 MB index a
   * 100k-commit repository produces — so running it on every open would trade how fast
   * reopening a repository feels for a check that matters after a crash. `excavate doctor`
   * (M6) and a rebuild prompt are the callers that should pass it.
   */
  readonly verifyIntegrity?: boolean;
  /**
   * The HTML document served at `/`.
   *
   * Passed in rather than imported because ADR-0001 forbids a `server → ui` edge: the
   * browser application is a static artifact the daemon serves, not a module it links
   * against. At M0 the caller supplies `skeletonPage()` from `@wise-excavate/ui`; from M3 it
   * is the bundle's `index.html`. Omitted, `/` explains that no UI was supplied — the
   * API itself is unaffected.
   */
  readonly indexHtml?: string;
}

export interface ExcavateServer {
  /** Includes `?token=…` — the URL handed to the browser or printed by the CLI. */
  readonly url: string;
  readonly port: number;
  readonly token: string;
  readonly session: RepoSession;
  close(): Promise<void>;
}

export async function createServer(options: ServerOptions): Promise<ExcavateServer> {
  /* An explicitly supplied empty token is refused rather than replaced. Replacing it
     would hand back a URL carrying a token the caller did not choose; honouring it would
     bind a daemon that answers 401 to every request, including its own page, with nothing
     to point at. `??` alone catches neither, because `''` is not nullish. */
  if (options.token === '') {
    throw new ExcavateError(
      'UNAUTHORIZED',
      'a session token may not be empty; omit it to have one generated',
    );
  }
  const token = options.token ?? generateSessionToken();
  const session = await openSession(options);

  let bound = options.port;
  const { app, closeStreams } = createApp({
    session,
    token,
    port: () => bound,
    ...(options.indexHtml === undefined ? {} : { indexHtml: options.indexHtml }),
  });

  /* A port that will not bind — the usual cause is a second daemon on an explicit
     `--port` — must not leave the index file open behind it. */
  let listener: Listener;
  try {
    listener = await listen(app, options.port);
  } catch (error) {
    session.store.close();
    throw error;
  }
  bound = listener.port;

  return {
    url: sessionUrl(listener.port, token),
    port: listener.port,
    token,
    session,
    async close(): Promise<void> {
      closeStreams();
      await listener.close();
      session.store.close();
    },
  };
}

/**
 * The URL `excavate .` hands to the browser. The token rides in the query string because
 * a browser navigation cannot carry a header; the page immediately moves it out of the
 * address bar and uses `Authorization` thereafter (LEAN-V1 §2.2).
 */
export function sessionUrl(port: number, token: string): string {
  return `http://${BIND_HOST}:${port}/?${TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * The daemon's unit of work (Part 7 §7.5): resolve the repository to a stable
 * `RepoId`, locate or create its index, migrate the schema, compare stored refs
 * against current refs, then serve instantly or walk the difference.
 */
export interface RepoSession {
  readonly repoId: RepoId;
  readonly root: string;
  readonly store: Store;
  readonly backend: GitBackend;
  /**
   * Where indexing progress is published. On the session rather than on the server
   * because `excavate index` needs progress with no HTTP layer at all, and because it is
   * what the SSE route subscribes to.
   */
  readonly bus: ProgressBus;
  summary(): RepoSummary;
  /** Indexes any missing tiers, publishing progress to the bus. */
  ensureIndexed(tiers: readonly Tier[]): Promise<void>;
}

export { openSession };

/* ── Security (Part 7 §7.4.2) ──────────────────────────────────────────────── */

/**
 * A 256-bit random token, required on every request including the SSE stream.
 *
 * Non-negotiable, because a localhost daemon holding a full index of proprietary code
 * is an attractive target. Compared in constant time — a token check that leaks
 * timing is a token check that leaks the token.
 */
export { generateSessionToken, isAllowedOrigin, isAuthorized } from './security.js';

/* ── The streaming plane ───────────────────────────────────────────────────── */

/**
 * SSE, not WebSocket (LEAN-V1 §5): progress and streamed tokens are strictly
 * server→client, so SSE is about ten lines, reconnects natively, and needs no
 * upgrade-handshake origin validation.
 */
export interface ProgressBus {
  publish(event: ServerEvent): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
}

export { createProgressBus } from './bus.js';

/* ── Jobs ──────────────────────────────────────────────────────────────────── */

/**
 * An async queue with an `AbortSignal`, replacing the scheduler with priorities and
 * preemption (LEAN-V1 §3.1). One concurrent index walk per session is the only
 * scheduling constraint that has ever mattered.
 */
export interface JobQueue {
  submit<T>(kind: string, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancelAll(): void;
  readonly pending: number;
}

export { createJobQueue } from './jobs.js';
