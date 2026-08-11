/**
 * M0.4 — the walking skeleton, asserted end to end.
 *
 * Part 15's objective for M0 is "an end-to-end thread through every architectural layer
 * before any layer is built properly", and D7's reasoning is that the skeleton de-risks
 * every interface simultaneously. This file is the assertion of that thread and the only
 * test that crosses the whole graph:
 *
 *     @wise-excavate/git-fixtures → git → index → store → server → ui
 *
 * It lives in `tests/` rather than in a package because it belongs to none of them. Every
 * package-owned home for it would need a dependency edge ADR-0001 forbids — `store` has no
 * business importing `server`, and `server` must not import `ui`. An end-to-end test is
 * definitionally the thing that crosses boundaries, so it sits outside them and is wired
 * from the workspace root.
 *
 * The M0 acceptance criterion it exists to prove is exact: *`excavate index` on a fixture
 * → 100 commits in SQLite → `GET /commits` → a plain HTML list → click shows the message.*
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CommitDetailDto,
  CommitListResponse,
  RepoSummary,
} from '@wise-excavate/core';
import { AUTH_SCHEME, DEFAULT_PAGE_SIZE, TIERS, parseOid } from '@wise-excavate/core';
import type { FixtureRepo } from '@wise-excavate/git-fixtures';
import { repo } from '@wise-excavate/git-fixtures';
import type { ExcavateServer } from '@wise-excavate/server';
import { createServer } from '@wise-excavate/server';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';
import { skeletonPage } from '@wise-excavate/ui';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The number M0's acceptance criterion names. */
const COMMITS = 100;

/** A commit whose body the "click shows the message" assertion looks for. */
const NARRATED = 'add retry with jitter';
const NARRATED_BODY =
  'A webhook storm took down the delivery worker.\n\nBackoff alone re-synchronised the\nretries, so the jitter is the point.';

let fixture: FixtureRepo;
let server: ExcavateServer;
let indexDir: string;

const api = async (
  path: string,
  token: string | null = server.token,
): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    headers: token === null ? {} : { authorization: `${AUTH_SCHEME} ${token}` },
  });

beforeAll(async () => {
  let builder = repo('walking-skeleton');
  for (let n = 1; n <= COMMITS - 1; n += 1) {
    builder = builder.commit(`commit ${n}`, (c) =>
      c.add(`src/file-${n}.ts`, `export const value = ${n};\n`),
    );
  }
  /* Last, so it is reachable without paging, and with a body — a detail route that only
     ever returned a subject would pass a test written against subject-only commits. */
  builder = builder.commit(NARRATED, (c) =>
    c.add('src/retry.ts', 'export const jitter = true;\n').body(NARRATED_BODY),
  );
  fixture = await builder.build();

  /* An explicit index directory: the default is an XDG cache path keyed by RepoId, and a
     test that wrote there would both pollute the developer's machine and pass on a second
     run for the wrong reason. */
  indexDir = mkdtempSync(join(tmpdir(), 'excavate-e2e-'));

  server = await createServer({
    repoRoot: fixture.path,
    port: 0,
    indexDir,
    indexHtml: skeletonPage(),
  });
  await server.session.ensureIndexed(TIERS);
}, 180_000);

afterAll(async () => {
  await server?.close();
  await fixture?.cleanup();
  if (indexDir !== undefined) rmSync(indexDir, { recursive: true, force: true });
});

describe('the fixture is a real repository', () => {
  it(`builds ${COMMITS} commits with resolvable object ids`, () => {
    expect(fixture.oids.size).toBe(COMMITS);
    expect(fixture.oid(NARRATED)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('indexing writes the history to SQLite', () => {
  it(`stores all ${COMMITS} commits`, () => {
    expect(server.session.store.commits.count()).toBe(COMMITS);
  });

  it('stores the people and files the walk saw', () => {
    expect(server.session.store.people.count()).toBeGreaterThan(0);
    expect(server.session.store.files.count()).toBe(COMMITS);
  });

  it('reaches the same commits the fixture built, by object id', () => {
    // `parseOid` rather than a cast: `@wise-excavate/git-fixtures` is deliberately
    // zero-dependency, so it hands back a plain string and the domain boundary is crossed
    // explicitly here. The friction is the point — it is also a real assertion that what
    // the fixture produced is a well-formed object id.
    const stored = server.session.store.commits.byOid(parseOid(fixture.oid(NARRATED)));
    expect(stored).not.toBeNull();
    expect(stored?.subject).toBe(NARRATED);
  });

  it('is durably marked ready, and says which tier it did not build', () => {
    // Honest degradation (Part 7 §7.7): M0 builds `metadata` only, and an index missing a
    // whole tier must say so rather than present itself as complete.
    expect(server.session.store.meta.indexState()).toBe('ready');
    const summary = server.session.summary();
    expect(summary.indexState).toBe('ready');
    expect(summary.partial?.skipped).toContain('analysis');
  });

  it('recovers the history’s time span from the index, not from a guess', () => {
    const summary = server.session.summary();
    expect(summary.firstCommitAt).not.toBeNull();
    expect(summary.lastCommitAt).not.toBeNull();
    expect(summary.lastCommitAt!.epochSeconds).toBeGreaterThan(
      summary.firstCommitAt!.epochSeconds,
    );
  });
});

describe('the daemon serves it', () => {
  it('binds loopback on a real port and answers /api/health', async () => {
    const response = await api('/api/health');
    expect(response.status).toBe(200);
    expect(server.url).toContain('127.0.0.1');
    expect(server.url).toContain('token=');
  });

  it('refuses /api/commits without the session token', async () => {
    const response = await api('/api/commits', null);
    expect(response.status).toBe(401);
  });

  it(`returns the commits, a page at a time`, async () => {
    const response = await api(`/api/commits?limit=${DEFAULT_PAGE_SIZE}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CommitListResponse;
    expect(body.commits).toHaveLength(COMMITS);
    expect(body.commits[0]?.subject).toBeTruthy();
  });

  it('walks its own cursor across the whole history exactly once', async () => {
    // A cursor that silently restarted, or dropped the tail, would still look fine on a
    // single page — so the assertion is on the union, not on one response.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = `/api/commits?limit=40${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = (await (await api(query)).json()) as CommitListResponse;
      seen.push(...page.commits.map((c) => c.oid));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(COMMITS);
    expect(new Set(seen).size).toBe(COMMITS);
  });

  it('reports a summary that matches the store', async () => {
    const summary = (await (await api('/api/repo/summary')).json()) as RepoSummary;
    expect(summary.commitCount).toBe(COMMITS);
    expect(summary.root).toBe(server.session.root);
  });
});

describe('the skeleton page, and the click', () => {
  it('serves an HTML document at / that fetches the commit list', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const html = await response.text();
    expect(html).toContain('<!doctype html>');
    // The page the CLI passes, not the daemon's "no UI was supplied" placeholder — the
    // wiring this asserts is the one nothing connected until integration.
    expect(html).not.toContain('No user interface was supplied');
    expect(html).toContain('/api/commits');
  });

  it('shows the message for a clicked commit', async () => {
    // The interaction is: click a row → fetch that commit → render its message. The DOM
    // half is asserted in the ui package against the page's own script; what has to hold
    // here is that the endpoint the click calls returns the message from the real index.
    const oid = fixture.oid(NARRATED);
    const response = await api(`/api/commits/${oid}`);
    expect(response.status).toBe(200);

    const detail = (await response.json()) as CommitDetailDto;
    expect(detail.oid).toBe(oid);
    expect(detail.subject).toBe(NARRATED);
    expect(detail.body).toContain('webhook storm');
  });

  it('404s a commit that is not in this history', async () => {
    const response = await api(`/api/commits/${'0'.repeat(40)}`);
    expect(response.status).toBe(404);
  });
});

describe('reopening an index', () => {
  it('serves instantly from the stored rows without walking again', async () => {
    const reopened = await createServer({
      repoRoot: fixture.path,
      port: 0,
      indexDir,
      indexHtml: skeletonPage(),
    });
    try {
      expect(reopened.session.store.commits.count()).toBe(COMMITS);
      expect(reopened.session.summary().indexState).toBe('ready');
      expect(reopened.session.repoId).toBe(server.session.repoId);
    } finally {
      await reopened.close();
    }
  });

  it('reports a truncated index as stale, never as ready', async () => {
    /* The failure this guards is the one worth guarding: a walk killed halfway leaves real
       rows behind, so a session that inferred readiness from `count() > 0` would present a
       partial history as a whole one. That was reachable until `Store.meta` gained a read
       path. Here the durable state is set to what an interrupted walk leaves. */
    const store = openStore({
      path: join(indexDir, INDEX_FILE_NAME),
      repoId: server.session.repoId,
    });
    store.transaction((tx) => {
      tx.setIndexState('stale');
      tx.setMeta('partial_reason', 'interrupted');
      tx.setMeta('partial_skipped', 'history after 40 commits');
    });
    store.close();

    const reopened = await createServer({
      repoRoot: fixture.path,
      port: 0,
      indexDir,
      indexHtml: skeletonPage(),
    });
    try {
      const summary = reopened.session.summary();
      expect(summary.indexState).toBe('stale');
      expect(summary.partial).not.toBeNull();
      expect(summary.partial?.reason).toBe('interrupted');
      expect(summary.partial?.skipped).toContain('40 commits');
    } finally {
      await reopened.close();
    }
  });
});
