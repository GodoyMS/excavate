import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Change,
  Commit,
  CommitDetailDto,
  CommitListResponse,
  ErrorResponse,
  HealthResponse,
  Oid,
  Person,
  RepoSummary,
  ServerEvent,
} from '@wise-excavate/core';
import {
  API_VERSION,
  AUTH_SCHEME,
  BIND_HOST,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PROJECTION,
  MAX_PAGE_SIZE,
  ROUTES,
  TIERS,
  commitId,
  fileId,
  parseOid,
  personId,
  repoId,
  timestamp,
} from '@wise-excavate/core';
import type { GitBackend } from '@wise-excavate/git';
import type { Page, PageRequest, Store } from '@wise-excavate/store';
import { describe, expect, it, vi } from 'vitest';

import type { DaemonApp } from './app.js';
import { UNKNOWN_SERVER_VERSION, createApp } from './app.js';
import { listen } from './http.js';
import type { ProgressBus, RepoSession } from './index.js';
import {
  createJobQueue,
  createProgressBus,
  createServer,
  generateSessionToken,
  isAllowedOrigin,
  isAuthorized,
  openSession,
  sessionUrl,
} from './index.js';
import { IMPLEMENTED_TIERS, tierGapBadge, unbuiltTiers } from './session.js';

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const TOKEN = 'kR2zvJ8pVQ0hLxT7bN3mCd9sYfWgA1eU4iOaX6qZjBk';
const PORT = 4242;
const bearer = { authorization: `${AUTH_SCHEME} ${TOKEN}` };

const oidOf = (n: number): Oid => parseOid(n.toString(16).padStart(40, '0'));

const AUTHOR = personId(1);
const COMMITTER = personId(2);

const PEOPLE: readonly Person[] = [
  {
    id: AUTHOR,
    canonicalName: 'Ada Lovelace',
    canonicalEmail: 'ada@example.com',
    identities: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
    firstSeen: timestamp(1_700_000_000),
    lastSeen: timestamp(1_700_000_300),
    commitCount: 4,
    mergeSource: 'exact-email',
    isBot: false,
  },
  {
    id: COMMITTER,
    canonicalName: 'Grace Hopper',
    canonicalEmail: 'grace@example.com',
    identities: [{ name: 'Grace Hopper', email: 'grace@example.com' }],
    firstSeen: timestamp(1_700_000_000),
    lastSeen: timestamp(1_700_000_300),
    commitCount: 4,
    mergeSource: 'exact-email',
    isBot: false,
  },
];

function fakeCommit(n: number, overrides: Partial<Commit> = {}): Commit {
  return {
    id: commitId(n),
    oid: oidOf(n),
    tree: oidOf(n + 1000),
    parents: n > 1 ? [commitId(n - 1)] : [],
    author: AUTHOR,
    committer: COMMITTER,
    authoredAt: timestamp(1_700_000_000 + n * 60, -480),
    committedAt: timestamp(1_700_000_000 + n * 60, -480),
    subject: `commit number ${n}`,
    body: n % 2 === 0 ? `Body of ${n}.\n\nWith a second paragraph.` : null,
    trailers: [],
    generation: n,
    flags: [],
    significance: n / 10,
    ...overrides,
  };
}

const CHANGES_PER_COMMIT = 2;

function changesFor(commit: Commit): readonly Change[] {
  return Array.from({ length: CHANGES_PER_COMMIT }, (_unused, i) => ({
    commit: commit.id,
    file: fileId(commit.id + i),
    kind: 'modify' as const,
    oldPath: null,
    newPath: null,
    similarity: null,
    insertions: 3,
    deletions: 1,
    isBinary: false,
  }));
}

/**
 * A `Store` double built from object literals. The real store and index engines are
 * written in parallel with the daemon and land in M0.2/M1; the routes' contract is with
 * the query *interfaces*, so this is what the daemon should be tested against anyway.
 * Cursors are real — the pagination round-trip below would pass vacuously otherwise.
 */
interface StoreDouble {
  readonly store: Store;
  /** The last page request the routes made, for asserting clamping. */
  lastPage(): PageRequest | null;
}

function fakeStore(rows: readonly Commit[]): StoreDouble {
  let lastPage: PageRequest | null = null;
  const unsupported = (): never => {
    throw new Error('the store double does not implement this query');
  };

  const store: Store = {
    repoId: repoId('fixture'),
    path: '/dev/null/index.db',
    schemaVersion: 1,
    migrate: () => undefined,
    transaction: unsupported,
    integrityCheck: () => ({ ok: true, schemaVersion: 1, problems: [] }),
    close: () => undefined,

    commits: {
      byOid: (oid) => rows.find((row) => row.oid === oid) ?? null,
      byId: (id) => rows.find((row) => row.id === id) ?? null,
      list: (page: PageRequest): Page<Commit> => {
        lastPage = page;
        const from = page.cursor === null ? 0 : Number.parseInt(page.cursor, 10);
        const to = Math.min(from + page.limit, rows.length);
        return {
          rows: rows.slice(from, to),
          nextCursor: to < rows.length ? String(to) : null,
        };
      },
      count: () => rows.length,
      mostSignificant: (limit) => rows.slice(0, limit),
      changesIn: (id) => {
        const commit = rows.find((row) => row.id === id);
        return commit === undefined ? [] : changesFor(commit);
      },
      hunksIn: () => [],
      commitsTouching: unsupported,
      isAncestor: unsupported,
    },
    files: {
      byId: () => null,
      byPath: () => null,
      pathOf: () => null,
      changesTo: () => [],
      count: () => 7,
    },
    people: {
      byId: (id) => PEOPLE.find((person) => person.id === id) ?? null,
      all: () => PEOPLE,
      count: () => PEOPLE.length,
    },
    rollups: {
      ownership: () => null,
      hotspots: () => [],
      knowledgeIslands: () => [],
      coupledWith: () => [],
      revertPairs: () => [],
      eras: () => [],
      releases: () => [],
      timelineBuckets: () => [],
    },
    search: { commits: () => [], paths: () => [] },
    // No route reads meta; the session does, and `session.test.ts` covers it against a
    // real store. An empty double here keeps that boundary visible.
    meta: { get: () => null, indexState: () => null },
    /* No HTTP route reads the analysis scan — it is an indexing-time concern — so the double
       refuses rather than returning empty results. An empty answer here would let a route
       start depending on it and look correct while reporting nothing. */
    analysis: {
      commits: unsupported,
      changes: unsupported,
      paths: unsupported,
      releaseCommits: unsupported,
      nonSourceFiles: unsupported,
      lastRun: unsupported,
    },
    bundles: { get: () => null, put: () => undefined },
  };

  return { store, lastPage: () => lastPage };
}

interface Harness extends DaemonApp {
  readonly session: RepoSession;
  readonly bus: ProgressBus;
  readonly store: StoreDouble;
  request(path: string, headers?: Record<string, string>): Promise<Response>;
}

function harness(commitCount = 3): Harness {
  return harnessOf(
    Array.from({ length: commitCount }, (_unused, i) => fakeCommit(i + 1)),
  );
}

function harnessOf(rows: readonly Commit[]): Harness {
  const commitCount = rows.length;
  const store = fakeStore(rows);
  const bus = createProgressBus();
  const session: RepoSession = {
    repoId: repoId('fixture'),
    root: '/repo',
    store: store.store,
    // Never called by an HTTP route: everything a route needs is already in the store.
    backend: {} as GitBackend,
    bus,
    summary: (): RepoSummary => ({
      repoId: repoId('fixture'),
      root: '/repo',
      headOid: oidOf(commitCount),
      indexState: 'ready',
      commitCount,
      personCount: PEOPLE.length,
      fileCount: 7,
      firstCommitAt: timestamp(1_700_000_060),
      lastCommitAt: timestamp(1_700_000_060 + commitCount * 60),
      partial: null,
    }),
    ensureIndexed: () => Promise.resolve(),
  };

  const app = createApp({
    session,
    token: TOKEN,
    port: () => PORT,
    heartbeatMs: 5,
    indexHtml: '<!doctype html><title>fixture ui</title>',
  });

  return {
    ...app,
    session,
    bus,
    store,
    request: (path, headers = bearer) =>
      Promise.resolve(app.app.request(path, { headers })),
  };
}

const readJson = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('security posture', () => {
  it('binds loopback only — there is no flag for anything else', () => {
    expect(BIND_HOST).toBe('127.0.0.1');
  });

  it('carries the token as a bearer credential', () => {
    expect(AUTH_SCHEME).toBe('Bearer');
  });
});

describe('the route table', () => {
  it('namespaces every route under /api so the UI can own the rest', () => {
    for (const route of Object.values(ROUTES)) {
      expect(route.startsWith('/api/')).toBe(true);
    }
  });

  it('exposes a single SSE stream rather than a socket', () => {
    expect(ROUTES.events).toBe('/api/events');
  });
});

describe('the session token', () => {
  it('carries 256 bits of entropy in a form that survives a URL unescaped', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(43); // 32 bytes, base64url, unpadded
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('never repeats a token across sessions', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateSessionToken()));
    expect(tokens.size).toBe(50);
  });

  it('accepts the expected token and rejects a token of a different length without throwing', () => {
    // A `timingSafeEqual` fed the raw strings throws on a length mismatch, which would
    // surface as a 500 and, worse, tell an attacker the token's length.
    expect(isAuthorized(TOKEN, TOKEN)).toBe(true);
    expect(isAuthorized('short', TOKEN)).toBe(false);
    expect(isAuthorized(`${TOKEN}${TOKEN}`, TOKEN)).toBe(false);
    expect(isAuthorized('', TOKEN)).toBe(false);
    expect(isAuthorized(null, TOKEN)).toBe(false);
  });

  it('rejects every presented token when the expected token is empty', () => {
    expect(isAuthorized('', '')).toBe(false);
    expect(isAuthorized('anything', '')).toBe(false);
  });

  it('differs from the expected token in one character and still fails', () => {
    const nearMiss = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('k') ? 'j' : 'k'}`;
    expect(isAuthorized(nearMiss, TOKEN)).toBe(false);
  });
});

describe('origin validation', () => {
  it('allows the daemon’s own two spellings of loopback', () => {
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isAllowedOrigin(`http://localhost:${PORT}`, PORT)).toBe(true);
  });

  it('rejects a foreign origin, which is what blocks DNS rebinding', () => {
    expect(isAllowedOrigin('http://evil.example.com', PORT)).toBe(false);
    expect(isAllowedOrigin(`https://127.0.0.1:${PORT}`, PORT)).toBe(false);
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1.evil.com', PORT)).toBe(false);
    expect(isAllowedOrigin('null', PORT)).toBe(false);
  });

  it('allows a request with no Origin at all, because the CLI is not a browser', () => {
    expect(isAllowedOrigin(null, PORT)).toBe(true);
    expect(isAllowedOrigin('', PORT)).toBe(true);
  });
});

describe('authorization on the API surface', () => {
  it('refuses an unauthenticated request with a code the client can branch on', async () => {
    const response = await harness().request(ROUTES.health, {});
    expect(response.status).toBe(401);
    const body = await readJson<ErrorResponse>(response);
    expect(body.error.code).toBe('UNAUTHORIZED');
    // The payload is exactly `ErrorPayload` — no stack, no cause, nothing incidental.
    expect(Object.keys(body.error).sort()).toEqual(['code', 'details', 'message']);
  });

  it('serves a request carrying the bearer token', async () => {
    const response = await harness().request(ROUTES.health);
    expect(response.status).toBe(200);
    const body = await readJson<HealthResponse>(response);
    expect(body.apiVersion).toBe(API_VERSION);
    // A build number read from the manifest, not the placeholder that means "the manifest
    // stopped resolving" — which is the whole reason the placeholder is not `0.0.0`.
    expect(body.serverVersion).not.toBe(UNKNOWN_SERVER_VERSION);
    expect(body.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('refuses a token of the wrong length rather than failing the request', async () => {
    const response = await harness().request(ROUTES.health, {
      authorization: `${AUTH_SCHEME} short`,
    });
    expect(response.status).toBe(401);
  });

  it('refuses a request from another origin even with a valid token', async () => {
    const response = await harness().request(ROUTES.health, {
      ...bearer,
      origin: 'http://evil.example.com',
    });
    expect(response.status).toBe(401);
  });

  it('accepts a token in the query string only where a header cannot be set', async () => {
    const url = `${ROUTES.health}?token=${TOKEN}`;
    const navigation = await harness().request(url, { 'sec-fetch-dest': 'document' });
    expect(navigation.status).toBe(200);

    // A page on a foreign origin fetching a subresource cannot fall back to the query.
    const subresource = await harness().request(url, { 'sec-fetch-dest': 'empty' });
    expect(subresource.status).toBe(401);
  });

  it('tells clients never to cache repository data', async () => {
    const response = await harness().request(ROUTES.commits);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('GET /api/commits', () => {
  it('returns denormalised rows so the UI computes nothing analytical', async () => {
    const body = await readJson<CommitListResponse>(
      await harness().request(ROUTES.commits),
    );
    expect(body.projection).toBe(DEFAULT_PROJECTION);
    expect(body.commits).toHaveLength(3);
    expect(body.commits[0]).toEqual({
      oid: oidOf(1),
      subject: 'commit number 1',
      authorName: 'Ada Lovelace',
      authoredAt: { epochSeconds: 1_700_000_060, offsetMinutes: -480 },
      insertions: 6,
      deletions: 2,
      filesChanged: 2,
      significance: 0.1,
      isMerge: false,
    });
  });

  it('defaults to the declared page size when no limit is given', async () => {
    const test = harness();
    await test.request(ROUTES.commits);
    expect(test.store.lastPage()?.limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it('honours a smaller limit', async () => {
    const body = await readJson<CommitListResponse>(
      await harness().request(`${ROUTES.commits}?limit=2`),
    );
    expect(body.commits).toHaveLength(2);
    expect(body.nextCursor).toBe('2');
  });

  it('clamps a limit above the maximum instead of trusting the client', async () => {
    const test = harness();
    await test.request(`${ROUTES.commits}?limit=${MAX_PAGE_SIZE * 10}`);
    expect(test.store.lastPage()?.limit).toBe(MAX_PAGE_SIZE);
  });

  it('falls back to the default page size for an unparseable limit', async () => {
    const test = harness();
    await test.request(`${ROUTES.commits}?limit=nonsense`);
    expect(test.store.lastPage()?.limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it('round-trips its cursor to walk the whole history exactly once', async () => {
    const test = harness(5);
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      // Both annotations are load-bearing: without them `cursor`'s narrowed type inside
      // the loop is inferred from a value that depends on `cursor` itself.
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const page: CommitListResponse = await readJson<CommitListResponse>(
        await test.request(`${ROUTES.commits}${query}`),
      );
      seen.push(...page.commits.map((commit) => commit.oid));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(seen).toEqual([1, 2, 3, 4, 5].map(oidOf));
  });

  it('refuses a projection the index does not hold rather than answering with another one', async () => {
    const response = await harness().request(`${ROUTES.commits}?projection=topological`);
    expect(response.status).toBe(400);
    expect((await readJson<ErrorResponse>(response)).error.code).toBe('INVALID_TARGET');
  });
});

describe('GET /api/commits/:oid', () => {
  it('returns the detail DTO, including the body the list omits', async () => {
    const response = await harness().request(`/api/commits/${oidOf(2)}`);
    expect(response.status).toBe(200);
    const body = await readJson<CommitDetailDto>(response);
    expect(body.subject).toBe('commit number 2');
    expect(body.body).toContain('Body of 2.');
    expect(body.parents).toEqual([oidOf(1)]);
    expect(body.committerName).toBe('Grace Hopper');
  });

  it('answers 404 with NOT_FOUND for an object id that is not indexed', async () => {
    const response = await harness().request(`/api/commits/${oidOf(999)}`);
    expect(response.status).toBe(404);
    expect((await readJson<ErrorResponse>(response)).error.code).toBe('NOT_FOUND');
  });

  it('answers 400 with INVALID_OID for an abbreviation or a non-hash', async () => {
    for (const bad of ['abc1234', 'not-a-hash', `${oidOf(1)}00`]) {
      const response = await harness().request(`/api/commits/${bad}`);
      expect(response.status).toBe(400);
      expect((await readJson<ErrorResponse>(response)).error.code).toBe('INVALID_OID');
    }
  });

  it('refuses to serve a commit whose recorded parent is missing from the index', async () => {
    // Filtering the parent out — which an earlier draft did — would report a merge as a
    // single-parent commit: a wrong answer about ancestry that looks exactly like a right
    // one, and the shape every lineage answer downstream is built on.
    const test = harnessOf([fakeCommit(1, { parents: [commitId(404)] })]);
    const response = await test.request(`/api/commits/${oidOf(1)}`);
    expect(response.status).toBe(500);
    const body = await readJson<ErrorResponse>(response);
    expect(body.error.code).toBe('INDEX_CORRUPT');
    expect(body.error.message).toContain('parent');
  });
});

describe('GET /api/repo/summary', () => {
  it('reports the index state and counts the store already knows', async () => {
    const body = await readJson<RepoSummary>(await harness().request(ROUTES.repoSummary));
    expect(body.indexState).toBe('ready');
    expect(body.commitCount).toBe(3);
    expect(body.partial).toBeNull();
  });
});

describe('GET /', () => {
  it('serves the document it was handed, with no token required to load a shell that has no data in it', async () => {
    const response = await harness().request('/', {});
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('fixture ui');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
  });
});

describe('the SSE stream', () => {
  it('delivers a published event as JSON in the data field', async () => {
    const test = harness();
    const response = await test.request(ROUTES.events);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = response.body;
    if (body === null) throw new Error('the event stream has no body');
    const reader = body.getReader();

    const event: ServerEvent = {
      type: 'index.progress',
      tier: 'metadata',
      done: 12,
      total: null,
    };
    test.bus.publish(event);

    const decoder = new TextDecoder();
    let frame = '';
    while (!frame.includes('data:')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('the stream closed before delivering an event');
      frame += decoder.decode(chunk.value);
    }

    expect(frame).toContain(`data: ${JSON.stringify(event)}`);
    await reader.cancel();
  });

  it('unsubscribes from the bus when the client disconnects', async () => {
    // A leaked subscription per reconnect is a slow memory leak, and one that only shows
    // up after an afternoon of use.
    const test = harness();
    let subscribers = 0;
    const counted: ProgressBus = {
      publish: (event) => test.bus.publish(event),
      subscribe: (listener) => {
        subscribers += 1;
        const off = test.bus.subscribe(listener);
        return () => {
          subscribers -= 1;
          off();
        };
      },
    };
    const app = createApp({
      session: { ...test.session, bus: counted },
      token: TOKEN,
      port: () => PORT,
      heartbeatMs: 5,
    });

    const response = await app.app.request(ROUTES.events, { headers: bearer });
    const body = response.body;
    if (body === null) throw new Error('the event stream has no body');
    await vi.waitFor(() => expect(subscribers).toBe(1));

    await body.cancel();
    await vi.waitFor(() => expect(subscribers).toBe(0));
  });

  it('keeps an idle connection warm with a comment line', async () => {
    const test = harness();
    const response = await test.request(ROUTES.events);
    const body = response.body;
    if (body === null) throw new Error('the event stream has no body');
    const reader = body.getReader();

    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe(': keep-alive\n\n');
    await reader.cancel();
  });
});

describe('the progress bus', () => {
  it('delivers to every subscriber even when one of them throws', () => {
    const bus = createProgressBus();
    const received: ServerEvent[] = [];
    bus.subscribe(() => {
      throw new Error('a dropped SSE connection must not abort an index walk');
    });
    bus.subscribe((event) => received.push(event));

    const event: ServerEvent = { type: 'index.tier_complete', tier: 'metadata' };
    expect(() => bus.publish(event)).not.toThrow();
    expect(received).toEqual([event]);
  });

  it('stops delivering after unsubscribe, including from inside a listener', () => {
    const bus = createProgressBus();
    const received: ServerEvent[] = [];
    const off = bus.subscribe((event) => {
      received.push(event);
      off();
    });

    bus.publish({ type: 'index.tier_complete', tier: 'metadata' });
    bus.publish({ type: 'index.tier_complete', tier: 'analysis' });
    expect(received).toHaveLength(1);
  });
});

describe('the job queue', () => {
  it('runs no more jobs at once than its concurrency allows', async () => {
    const queue = createJobQueue(2);
    let running = 0;
    let peak = 0;
    const release: (() => void)[] = [];

    const jobs = Array.from({ length: 5 }, () =>
      queue.submit('probe', async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => release.push(resolve));
        running -= 1;
      }),
    );

    await vi.waitFor(() => expect(release).toHaveLength(2));
    expect(queue.pending).toBe(5);

    for (let released = 0; released < jobs.length; released += 1) {
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
      release.shift()?.();
    }
    await Promise.all(jobs);

    expect(peak).toBe(2);
    expect(queue.pending).toBe(0);
  });

  it('rejects with the job’s own failure rather than swallowing it', async () => {
    const queue = createJobQueue(1);
    await expect(
      queue.submit('boom', () => Promise.reject(new Error('nope'))),
    ).rejects.toThrow('nope');
    expect(queue.pending).toBe(0);
  });

  it('aborts in-flight work and refuses what has not started', async () => {
    const queue = createJobQueue(1);
    let observed: AbortSignal | null = null;

    const first = queue.submit('index', async (signal) => {
      observed = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve()),
      );
      throw new Error('cancelled');
    });
    const second = queue.submit('index', () => Promise.resolve('never runs'));

    await vi.waitFor(() => expect(observed).not.toBeNull());
    expect(queue.pending).toBe(2);

    queue.cancelAll();

    await expect(first).rejects.toThrow('cancelled');
    await expect(second).rejects.toThrow(/CANCELLED|cancelled/);
    expect(queue.pending).toBe(0);
  });
});

describe('the listener', () => {
  it('binds a loopback address on an OS-chosen port and reports the real one', async () => {
    const test = harness();
    const listener = await listen(test.app, 0);
    try {
      expect(listener.host).toBe(BIND_HOST);
      expect(listener.port).toBeGreaterThan(0);

      const response = await fetch(
        `http://${BIND_HOST}:${listener.port}${ROUTES.health}`,
        {
          headers: bearer,
        },
      );
      expect(response.status).toBe(200);
      expect((await readJson<HealthResponse>(response)).apiVersion).toBe(API_VERSION);
    } finally {
      await listener.close();
    }
  });

  it('stops accepting connections once closed', async () => {
    const test = harness();
    const listener = await listen(test.app, 0);
    const url = `http://${BIND_HOST}:${listener.port}${ROUTES.health}`;
    expect((await fetch(url, { headers: bearer })).status).toBe(200);

    await listener.close();
    await expect(fetch(url, { headers: bearer })).rejects.toThrow();
  });

  it('hands the browser a URL that carries the token', () => {
    expect(sessionUrl(1234, TOKEN)).toBe(`http://${BIND_HOST}:1234/?token=${TOKEN}`);
  });
});

describe('createServer', () => {
  it('opens the session before it binds anything, so a bad path never leaves a listener up', async () => {
    // The composition root's whole job is ordering, and "it threw" is not evidence of it:
    // the assertion that matters is that the port it was asked for is still free
    // afterwards. A free port is borrowed and released to get one nothing else wants.
    const probe = await listen(harness().app, 0);
    const { port } = probe;
    await probe.close();

    await expect(
      createServer({ repoRoot: '/excavate/definitely/not/a/repository', port }),
    ).rejects.toMatchObject({ code: 'NOT_A_REPOSITORY' });

    // Binding it again proves nothing was left holding it.
    const after = await listen(harness().app, port);
    try {
      expect(after.port).toBe(port);
    } finally {
      await after.close();
    }
  });

  it('refuses an explicitly empty token instead of serving a daemon that 401s everything', async () => {
    await expect(
      createServer({ repoRoot: process.cwd(), port: 0, token: '' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

/* ── The session lifecycle (Part 7 §7.5) ───────────────────────────────────── */

describe('tier honesty', () => {
  it('no longer reports a tier gap, because every tier is now built', () => {
    /* This is the test its own M0 version said would have to change at M1, and it has.
       `analysis` is built — by the composition root, over stored rows — so nothing is
       unbuilt and no badge is warranted. The constant and the guard both stay: the next tier
       specified ahead of its implementation (eras, at M5) needs exactly this mechanism, and
       re-deriving it then is how a daemon ends up blessing a tier nobody wrote. */
    expect(IMPLEMENTED_TIERS).toEqual(['metadata', 'content', 'analysis']);
    expect(unbuiltTiers(TIERS)).toEqual([]);
    expect(unbuiltTiers(['metadata'])).toEqual([]);
    // The guard still fires for a tier this release does not implement.
    expect(unbuiltTiers(['metadata', 'eras' as never])).toEqual(['eras']);
  });

  it('turns a tier gap into the same badge the indexer records for it', () => {
    expect(tierGapBadge([])).toBeNull();
    expect(tierGapBadge(['analysis'])).toEqual({
      reason: 'tier-failed',
      skipped: 'analysis tier — not built by this release',
    });
    expect(tierGapBadge(['metadata', 'analysis'])?.skipped).toContain('tiers');
  });
});

/**
 * The one test that runs the composition root against real Git, a real SQLite index, and
 * the real walk — the integration my own report called the most valuable thing to write
 * next, now that `@wise-excavate/git`, `@wise-excavate/store`, and `@wise-excavate/index` have landed.
 *
 * It indexes *this* repository, which is the only one guaranteed to exist wherever the
 * suite runs, into a throwaway index directory. Every assertion is therefore phrased
 * against the store's own counts rather than against a fixed history, so it holds whether
 * the checkout has no commits or ten thousand.
 */
describe('openSession, against a real repository', () => {
  it('resolves a repo id, opens an index, indexes it once, and reports what it built', async () => {
    // The temp directory is removed even if `openSession` itself throws; a test that
    // leaves index files in `/tmp` is a test that eventually fills a disk.
    const indexDir = mkdtempSync(join(tmpdir(), 'excavate-session-'));
    const here = fileURLToPath(new URL('.', import.meta.url));

    try {
      const session = await openSession({ repoRoot: here, port: 0, indexDir });
      let commitCount: number;
      try {
        // `discoverRepository` walks up, so the session's root encloses the `src`
        // directory it was pointed at rather than being it. Phrased as a prefix so it
        // holds wherever the checkout lives.
        expect(here.startsWith(session.root)).toBe(true);
        expect(session.root.length).toBeLessThan(here.length);
        expect(session.repoId).toMatch(/^[0-9a-f]{64}$/);
        expect(session.store.path).toBe(join(indexDir, 'index.db'));

        const started: string[] = [];
        const completed: string[] = [];
        session.bus.subscribe((event) => {
          if (event.type === 'job.started') started.push(event.job.id);
          if (event.type === 'index.tier_complete') completed.push(event.tier);
        });

        await session.ensureIndexed(TIERS);

        // Completion is claimed for `metadata` and withheld from `analysis`, which the
        // pipeline deferred — the whole point of `IMPLEMENTED_TIERS`.
        expect(completed).toEqual(['metadata', 'analysis']);

        const summary = session.summary();
        expect(summary.indexState).toBe('ready');
        expect(summary.commitCount).toBe(session.store.commits.count());
        expect(summary.root).toBe(session.root);
        // Asked for a tier it cannot build, the session says so rather than reporting a
        // whole index.
        // No badge: both tiers were built. At M0 this asserted a `tier-failed` badge for
        // `analysis`, which was the honest answer then and would be a lie now.
        expect(summary.partial).toBeNull();
        commitCount = summary.commitCount;

        // A second call must not re-walk: `insertCommits` is a plain INSERT, so a second
        // pass over a populated index would collide on every primary key.
        await session.ensureIndexed(TIERS);
        expect(started).toHaveLength(1);
      } finally {
        session.store.close();
      }

      // Reopening the index the walk just wrote, with the integrity check on. It is opt-in
      // because it reads every page, so the thing worth proving is that it is wired and
      // that a freshly built index passes it — a false positive here would refuse to open
      // every index there is.
      const reopened = await openSession({
        repoRoot: here,
        port: 0,
        indexDir,
        verifyIntegrity: true,
      });
      try {
        expect(reopened.summary().commitCount).toBe(commitCount);
      } finally {
        reopened.store.close();
      }
    } finally {
      rmSync(indexDir, { recursive: true, force: true });
    }
  }, 60_000);
});
