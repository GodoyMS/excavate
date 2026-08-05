/**
 * The HTTP surface.
 *
 * **The daemon boundary is the highest-leverage decision in the project** (Part 7 §7.1):
 * this one file's worth of routing is what buys the CLI, `excavate mcp`, `serve`,
 * shareable links, headless CI use, and remote use over an SSH tunnel. It is nearly free
 * now and impossible to retrofit later.
 *
 * The app is built separately from the listener so it can be exercised through
 * `app.request()` with no socket, and so the composition root can hand it a session
 * without either half knowing how the other was constructed.
 *
 * Route strings, status-bearing error codes, and the event union all come from
 * `@excavate/core`'s `api.ts`. Nothing here invents a path.
 */

import { readFileSync } from 'node:fs';

import type {
  CommitListResponse,
  ErrorCode,
  ErrorResponse,
  HealthResponse,
  HistoryProjection,
  ServerEvent,
} from '@excavate/core';
import {
  API_VERSION,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PROJECTION,
  ExcavateError,
  HISTORY_PROJECTIONS,
  MAX_PAGE_SIZE,
  ROUTES,
  TOKEN_QUERY_PARAM,
  isOid,
  parseOid,
  toErrorPayload,
} from '@excavate/core';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { toCommitDetail, toCommitSummary } from './dto.js';
import type { RepoSession } from './index.js';
import { bearerToken, isAllowedOrigin, isAuthorized } from './security.js';

/**
 * How often an idle stream emits a comment line. Long enough to be negligible traffic,
 * short enough to survive the ~60s idle timeouts that proxies and some OS network stacks
 * impose. A dead-but-unclosed SSE connection is invisible to the user until they notice
 * progress has stopped, so the heartbeat is what makes the failure detectable.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** An SSE comment: ignored by every client, and enough to keep the connection warm. */
const SSE_HEARTBEAT = ': keep-alive\n\n';

export interface AppDeps {
  readonly session: RepoSession;
  readonly token: string;
  /**
   * Late-bound because `port: 0` is the default posture: the real port is not known
   * until the listener is bound, and `Origin` validation must compare against the real
   * one.
   */
  readonly port: () => number;
  /** The document served at `/`. See `ServerOptions.indexHtml`. */
  readonly indexHtml?: string;
  readonly heartbeatMs?: number;
}

export interface DaemonApp {
  readonly app: Hono;
  /**
   * Abort every live SSE stream. Without this a single connected client keeps the
   * listener's socket open and `close()` never resolves.
   *
   * A property rather than a method so it can be destructured without losing `this`.
   */
  readonly closeStreams: () => void;
}

/**
 * HTTP status per error code, exhaustive by construction: adding an `ErrorCode` in
 * `@excavate/core` without deciding its status is a compile error rather than a silent
 * 500 discovered in production.
 */
const ERROR_STATUS: Readonly<Record<ErrorCode, ContentfulStatusCode>> = {
  NOT_A_REPOSITORY: 400,
  GIT_UNAVAILABLE: 500,
  GIT_FAILED: 500,
  INVALID_OID: 400,
  INDEX_CORRUPT: 500,
  SCHEMA_TOO_NEW: 500,
  MIGRATION_FAILED: 500,
  /* The client's view of history is stale, not malformed — 409 is the honest answer. */
  HISTORY_REWRITTEN: 409,
  INVALID_TARGET: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  /* Nothing to serve because the work was abandoned, not because the request was bad. */
  CANCELLED: 503,
  PROVIDER_UNAVAILABLE: 503,
  /* Literally a spending limit, which is the one thing 402 means. */
  BUDGET_EXCEEDED: 402,
  /* The model produced something unusable, so the daemon is a failing gateway. */
  UNCITED_OUTPUT: 502,
  /* A bug in the daemon. `toErrorPayload` maps every non-`ExcavateError` throw here, so
     this is the status an unhandled fault gets — and it must not borrow `GIT_FAILED`'s,
     which would blame git for a defect of ours. */
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
};

export function createApp(deps: AppDeps): DaemonApp {
  const { session, token, port } = deps;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const live = new Set<SSEStreamingApi>();
  const app = new Hono();

  /* Headers on every response. `no-referrer` matters specifically: without it the
     `?token=` navigation URL would be sent to any third-party resource the page loads,
     which is a live token in someone else's logs. */
  app.use('*', async (c, next) => {
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });

  app.use('/api/*', authorize(token, port));

  app.get(ROUTES.health, (c) =>
    c.json({
      apiVersion: API_VERSION,
      serverVersion: SERVER_VERSION,
    } satisfies HealthResponse),
  );

  app.get(ROUTES.repoSummary, (c) => c.json(session.summary()));

  app.get(ROUTES.commits, (c) => {
    const projection = readProjection(c);
    const page = session.store.commits.list({
      limit: readLimit(c),
      cursor: c.req.query('cursor') ?? null,
    });

    return c.json({
      commits: page.rows.map((row) => toCommitSummary(session.store, row)),
      nextCursor: page.nextCursor,
      projection,
    } satisfies CommitListResponse);
  });

  app.get(ROUTES.commit, (c) => {
    const raw = c.req.param('oid');
    if (!isOid(raw)) {
      throw new ExcavateError('INVALID_OID', 'not a full object id', {
        details: { length: raw.length },
      });
    }
    const commit = session.store.commits.byOid(parseOid(raw));
    if (commit === null) {
      throw new ExcavateError('NOT_FOUND', `no indexed commit ${raw.slice(0, 12)}`);
    }
    return c.json(toCommitDetail(session.store, commit));
  });

  /**
   * The streaming plane. One unnamed stream carrying JSON-encoded `ServerEvent`s, per
   * Part 7 §7.4.4 — every event is advisory, and a client that misses events across a
   * reconnect reconciles by re-querying rather than by replaying.
   *
   * The subscription is torn down when the client disconnects. A leaked subscription per
   * reconnect is a slow memory leak that only shows up after an afternoon of use, which
   * is the worst way to find it.
   */
  app.get(ROUTES.events, (c) =>
    streamSSE(c, async (stream) => {
      live.add(stream);

      // Every write goes through one chain rather than being fired off in parallel, for
      // two reasons. Two events published in the same tick must reach the client in the
      // order they were published; and a heartbeat racing an event would interleave bytes
      // *inside* a `data:` frame, producing JSON no client can parse — a corrupt frame
      // that looks like a delivered one. The `catch` keeps a failed write from poisoning
      // the chain, and is also what stops a client that vanished mid-write from becoming
      // an unhandled rejection that takes the whole daemon down.
      let queue: Promise<unknown> = Promise.resolve();
      const enqueue = (write: () => Promise<unknown>): void => {
        queue = queue.then(write).catch(() => undefined);
      };

      const unsubscribe = session.bus.subscribe((event: ServerEvent) => {
        enqueue(() => stream.writeSSE({ data: JSON.stringify(event) }));
      });
      const heartbeat = setInterval(() => {
        enqueue(() => stream.write(SSE_HEARTBEAT));
      }, heartbeatMs);
      heartbeat.unref();

      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
        c.req.raw.signal.addEventListener('abort', () => stream.abort(), { once: true });
      });

      clearInterval(heartbeat);
      unsubscribe();
      live.delete(stream);
    }),
  );

  app.get('/', (c) => {
    /* M0's page has an inline script, so `unsafe-inline` is unavoidable here and is
       exactly what M3 removes when the page becomes a bundle with a nonce. Everything
       else is locked down: no plugins, no framing, no form posts, and connections only
       back to the daemon that served the page. */
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    return c.html(deps.indexHtml ?? UNWIRED_UI_HTML);
  });

  app.notFound((c) => errorResponse(c, new ExcavateError('NOT_FOUND', 'no such route')));

  /**
   * One error handler for the whole surface, so every subcommand and every route can
   * throw an `ExcavateError` and get a code-bearing body instead of a stack trace. The
   * response carries only the code, the message, and the structured details the thrower
   * chose — never a stack, and never anything `details` was not meant to hold (Part 7
   * §7.4.3).
   */
  app.onError((error, c) => errorResponse(c, error));

  return {
    app,
    closeStreams: (): void => {
      for (const stream of [...live]) stream.abort();
    },
  };
}

function errorResponse(c: Context, error: unknown): Response {
  const payload = toErrorPayload(error);
  return c.json({ error: payload } satisfies ErrorResponse, ERROR_STATUS[payload.code]);
}

/**
 * Token and origin enforcement on every `/api/*` route, including the SSE stream.
 *
 * `?token=` is accepted only where a browser could not have set a header: a top-level
 * navigation, or a non-browser client that sends no `Sec-Fetch-Dest` at all. A page
 * loaded from a foreign origin issues subresource requests with `Sec-Fetch-Dest: empty`,
 * so it cannot fall back to the query parameter even if it somehow learned the token.
 * Keeping the credential out of subresource URLs is also what keeps it out of the
 * browser's history, the disk cache, and anything that logs a URL.
 */
function authorize(token: string, port: () => number): MiddlewareHandler {
  return async (c, next) => {
    if (!isAllowedOrigin(c.req.header('origin') ?? null, port())) {
      throw new ExcavateError(
        'UNAUTHORIZED',
        'origin not allowed; the daemon serves its own origin only',
      );
    }

    const presented = bearerToken(c.req.header('authorization')) ?? navigationToken(c);
    if (!isAuthorized(presented, token)) {
      throw new ExcavateError('UNAUTHORIZED', 'a valid session token is required');
    }

    /* Repository content must not persist in a shared HTTP cache or on disk. */
    c.header('Cache-Control', 'no-store');
    await next();
  };
}

function navigationToken(c: Context): string | null {
  const destination = c.req.header('sec-fetch-dest');
  if (destination !== undefined && destination !== 'document') return null;
  return c.req.query(TOKEN_QUERY_PARAM) ?? null;
}

/**
 * `limit` is clamped rather than rejected: a client asking for more than `MAX_PAGE_SIZE`
 * wants as much as it can get, and a 400 there would be pedantry. Anything unparseable
 * falls back to the default for the same reason.
 */
function readLimit(c: Context): number {
  const raw = c.req.query('limit');
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * v1 walks `first-parent` only and says so plainly rather than silently serving
 * first-parent rows under another projection's name (LEAN-V1 §3.1 cut the UI multiplier,
 * not the concept). Asking for a projection the index does not hold is an error, not a
 * quietly wrong answer.
 */
function readProjection(c: Context): HistoryProjection {
  const raw = c.req.query('projection');
  if (raw === undefined) return DEFAULT_PROJECTION;
  if (!isProjection(raw) || raw !== DEFAULT_PROJECTION) {
    throw new ExcavateError(
      'INVALID_TARGET',
      `unsupported projection ${JSON.stringify(raw)}; v1 indexes ${DEFAULT_PROJECTION} only`,
    );
  }
  return raw;
}

function isProjection(value: string): value is HistoryProjection {
  return (HISTORY_PROJECTIONS as readonly string[]).includes(value);
}

/**
 * The value `/api/health` reports when the manifest could not be read.
 *
 * Deliberately not a plausible version. `'0.0.0'` — which an earlier draft used — is
 * indistinguishable from the real pre-release version, so a manifest that stopped
 * resolving would report a number that looks right and no test could catch it.
 */
export const UNKNOWN_SERVER_VERSION = '0.0.0-unknown';

/**
 * Reported by `/api/health` so a client can tell which build it is talking to. Read from
 * the package manifest rather than duplicated as a literal, which keeps it correct
 * through every release without a build step; the failure is tolerated because a missing
 * version must never be the reason the daemon refuses to start, but it is *named* so it
 * cannot pass for a real one.
 */
const SERVER_VERSION = readServerVersion();

function readServerVersion(): string {
  try {
    /* Both `src/` and `dist/` sit one level under the package root, so this resolves
       identically whether the daemon is running from source under vitest or from its
       published output. */
    const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(manifest);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed;
      if (typeof version === 'string' && version !== '') return version;
    }
  } catch {
    /* Fall through to the named placeholder. */
  }
  return UNKNOWN_SERVER_VERSION;
}

/**
 * The fallback document for `/` when no UI has been handed to the daemon.
 *
 * `@excavate/server` must not import `@excavate/ui` (ADR-0001: the browser bundle is a
 * static artifact the daemon serves, not a module it imports), so the page arrives
 * through `ServerOptions.indexHtml`. When it has not, saying so plainly beats a 404 that
 * looks like a broken daemon.
 */
const UNWIRED_UI_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Excavate</title></head>
  <body>
    <p>The daemon is running, but no UI document was supplied.</p>
    <p>The API is live: try <code>/api/health</code> with your session token.</p>
  </body>
</html>
`;
