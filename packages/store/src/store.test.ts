import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Change,
  Commit,
  CommitId,
  FileEntity,
  FileId,
  Oid,
  PathId,
  Person,
  PersonId,
} from '@wise-excavate/core';
import {
  ExcavateError,
  NotImplementedError,
  bundleHash,
  commitId,
  fileId,
  isExcavateError,
  pathId,
  personId,
  repoId,
  tagId,
  timestamp,
} from '@wise-excavate/core';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeCommitCursor, encodeCommitCursor } from './cursor.js';
import type { Store } from './index.js';
import {
  INDEX_FILE_NAME,
  SCHEMA_VERSION,
  WRITE_BATCH_ROWS,
  migrations,
  openStore,
} from './index.js';
import { HOT_SQL, toMatchExpression } from './queries.js';

/* ── Harness ───────────────────────────────────────────────────────────────── */

const REPO = repoId('test-repo');

const temps: string[] = [];
const stores: Store[] = [];

/**
 * Both loops drain their list before doing anything that can throw, and each item is
 * closed or removed independently. A single `store.close()` throwing must not abandon the
 * remaining handles or skip the temp-directory sweep: on Windows an open handle keeps the
 * file locked and the leak cascades into every later test, and a store left open across
 * the whole run is how a vitest process fails to exit.
 */
afterEach(() => {
  const errors: unknown[] = [];
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'test cleanup failed');
});

/** Narrows away the `undefined` that `noUncheckedIndexedAccess` adds to every index read. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value, got undefined');
  return value;
}

/** A real file, because WAL, reopening, and migrating twice are things `:memory:` cannot exercise. */
function tempIndexPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'excavate-store-'));
  temps.push(dir);
  return join(dir, INDEX_FILE_NAME);
}

function open(path: string, options: { bulkLoad?: boolean } = {}): Store {
  const store =
    options.bulkLoad === undefined
      ? openStore({ path, repoId: REPO })
      : openStore({ path, repoId: REPO, bulkLoad: options.bulkLoad });
  stores.push(store);
  return store;
}

function memoryStore(): Store {
  return open(':memory:');
}

/** Read-side verification of things no public query exposes: refs, tags, raw meta. */
function inspect<T>(path: string, fn: (db: BetterSqlite3.Database) => T): T {
  const db = new BetterSqlite3(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function tableNames(db: BetterSqlite3.Database): readonly string[] {
  return db
    .prepare<[], string>(`SELECT name FROM sqlite_schema WHERE type = 'table'`)
    .pluck()
    .all();
}

/**
 * The query plan for one of the statements the store really prepares, on a freshly
 * migrated schema.
 *
 * `HOT_SQL` is imported rather than retyped on purpose: the earlier version of
 * these tests EXPLAINed a hand-copied paraphrase of the paging SQL, which is a test of the
 * paraphrase. Parameters are bound because `EXPLAIN QUERY PLAN` on a statement with `?`
 * placeholders still requires them, and because a plan derived from inlined literals is
 * not necessarily the plan SQLite picks for the parameterised form.
 */
function planFor(sql: string, params: (number | string)[]): string {
  const path = tempIndexPath();
  open(path).close();
  return inspect(path, (db) =>
    db
      .prepare<(number | string)[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail)
      .join(' | '),
  );
}

/* ── Synthetic rows ────────────────────────────────────────────────────────── */

/** Deterministic, well-formed OIDs. Building real repositories is the fixture DSL's job (M0.3). */
function oidFor(n: number): Oid {
  return n.toString(16).padStart(40, '0') as Oid;
}

function personFixture(n: number, overrides: Partial<Person> = {}): Person {
  return {
    id: personId(n),
    canonicalName: `Person ${n}`,
    canonicalEmail: `person${n}@example.com`,
    identities: [{ name: `Person ${n}`, email: `person${n}@example.com` }],
    firstSeen: timestamp(1_700_000_000, 60),
    lastSeen: timestamp(1_700_100_000, 60),
    commitCount: n,
    mergeSource: 'exact-email',
    isBot: false,
    ...overrides,
  };
}

function commitFixture(n: number, overrides: Partial<Commit> = {}): Commit {
  return {
    id: commitId(n),
    oid: oidFor(n),
    tree: oidFor(n + 10_000),
    parents: n > 1 ? [commitId(n - 1)] : [],
    author: personId(1),
    committer: personId(1),
    authoredAt: timestamp(1_700_000_000 + n * 60, -480),
    committedAt: timestamp(1_700_000_000 + n * 60, 120),
    subject: `commit ${n}`,
    body: null,
    trailers: [],
    generation: n,
    flags: [],
    significance: 0,
    ...overrides,
  };
}

function fileFixture(n: number, born: CommitId, path: PathId): FileEntity {
  return {
    id: fileId(n),
    currentPath: path,
    aliases: [{ path, from: born, to: null }],
    born,
    died: null,
    language: 'typescript',
    flags: ['test'],
  };
}

function changeFixture(commit: CommitId, file: FileId, path: PathId): Change {
  return {
    commit,
    file,
    kind: 'modify',
    oldPath: path,
    newPath: path,
    similarity: null,
    insertions: 12,
    deletions: 3,
    isBinary: false,
  };
}

/** One person and a linear chain of commits, so foreign keys are satisfiable. */
function seed(store: Store, commitCount: number, author: PersonId = personId(1)): void {
  store.transaction((tx) => {
    tx.upsertPeople([personFixture(author)]);
    const commits: Commit[] = [];
    for (let n = 1; n <= commitCount; n += 1) {
      commits.push(commitFixture(n, { author, committer: author }));
    }
    tx.insertCommits(commits);
  });
}

function seedCorpus(store: Store): void {
  store.transaction((tx) => {
    tx.upsertPeople([personFixture(1)]);
    tx.insertCommits([
      commitFixture(1, {
        parents: [],
        subject: 'Add retry backoff',
        body: 'The scheduler thundered on every deploy; jitter fixes it.',
      }),
      commitFixture(2, {
        subject: 'Rename the widget module',
        body: 'Pure mechanical rename, no behaviour change.',
      }),
      commitFixture(3, { subject: 'Drop the legacy migration', body: null }),
    ]);
  });
}

/* ── The M0.1 constants ────────────────────────────────────────────────────── */

describe('storage layout', () => {
  it('is a single file, with FTS5 inside it rather than a sidecar', () => {
    expect(INDEX_FILE_NAME).toBe('index.db');
  });

  it('starts at schema version 1', () => {
    // v2 adds the analysis rollups (knowledge, ownership, hotspots, analyzer_runs).
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('batches writes at the size the walk flushes on', () => {
    expect(WRITE_BATCH_ROWS).toBe(10_000);
  });
});

/* ── Migrations ────────────────────────────────────────────────────────────── */

describe('migrations', () => {
  it('are sequential and gapless, so no version is skipped or applied twice', () => {
    migrations().forEach((migration, index) => {
      expect(migration.version).toBe(index + 1);
    });
  });

  it('name themselves in the NNNN_snake_case form Part 14 §14.4 requires', () => {
    for (const migration of migrations()) {
      expect(migration.name).toMatch(/^\d{4}_[a-z0-9_]+$/);
    }
  });

  it('end at the schema version the package advertises', () => {
    const all = migrations();
    expect(all[all.length - 1]?.version).toBe(SCHEMA_VERSION);
  });

  it('create every v1 table and record the version on a fresh database', () => {
    const path = tempIndexPath();
    expect(open(path).schemaVersion).toBe(SCHEMA_VERSION);

    inspect(path, (db) => {
      expect(tableNames(db)).toEqual(
        expect.arrayContaining([
          'changes',
          'commit_parents',
          'commits',
          'commits_fts',
          'file_aliases',
          'files',
          'meta',
          'paths',
          'people',
          'person_identities',
          'refs',
          'releases',
          'tags',
        ]),
      );
      expect(
        db
          .prepare<[], string>(`SELECT value FROM meta WHERE key = 'schema_version'`)
          .pluck()
          .get(),
      ).toBe(String(SCHEMA_VERSION));
    });
  });

  it('leave the hunk and rollup tables to the milestones that populate them', () => {
    const path = tempIndexPath();
    open(path);
    inspect(path, (db) => {
      const tables = tableNames(db);
      for (const deferred of ['hunks', 'coupling', 'eras', 'timeline_buckets']) {
        expect(tables).not.toContain(deferred);
      }
    });
  });

  it('build the indexes the query list in Part 8 §8.7 depends on', () => {
    const path = tempIndexPath();
    open(path);
    inspect(path, (db) => {
      const indexes = db
        .prepare<[], string>(`SELECT name FROM sqlite_schema WHERE type = 'index'`)
        .pluck()
        .all();
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_commits_oid',
          'idx_commits_time',
          'idx_commits_author',
          'idx_changes_file',
          'idx_file_aliases_path',
        ]),
      );
    });
  });

  it('answer "files changed in this commit" from the changes primary key, so no second index is needed', () => {
    const plan = planFor(HOT_SQL.changesIn, [1]);
    expect(plan).toMatch(/SEARCH .*changes/);
    expect(plan).not.toMatch(/SCAN/);
  });

  it('walks the first page straight down the covering time index, with no sort step', () => {
    const plan = planFor(HOT_SQL.firstPage, [10]);
    expect(plan).toContain('idx_commits_time');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('seeks to the cursor rather than scanning down to it, so a deep page is not an OFFSET', () => {
    const plan = planFor(HOT_SQL.nextPage, [1_700_000_000, 3, 10]);
    expect(plan).toContain('idx_commits_time');
    expect(plan).not.toContain('TEMP B-TREE');
    // The assertion that matters, and the one this test previously got wrong. The
    // logically identical `committed_at < ? OR (committed_at = ? AND id < ?)` form plans
    // as `SCAN commits USING INDEX idx_commits_time`: SQLite walks from the newest entry
    // and evaluates the predicate on every row above the cursor, which is `OFFSET`
    // pagination wearing a cursor's clothes (measured: 0.014ms first page, 11ms last page
    // at 300k commits). Because both verbs name the index, asserting only on
    // 'idx_commits_time' passed against the broken form — so assert the verb.
    expect(plan).toMatch(/SEARCH commits USING INDEX idx_commits_time/);
    expect(plan).not.toMatch(/SCAN/);
  });

  it('fetches a whole page of parent edges by primary-key seek, not by scanning the graph', () => {
    // The no-N+1 claim has two halves. That it is one statement is structural. That the one
    // statement is cheap is not: `json_each` feeding an `IN` could equally plan as a scan of
    // every edge in the repository, which for a 100k-commit history would make each page
    // cost the graph. Only the plan can tell the difference.
    const plan = planFor(HOT_SQL.parentsOf, [JSON.stringify([3, 2, 1])]);
    expect(plan).toMatch(/SEARCH commit_parents USING PRIMARY KEY/);
    expect(plan).not.toMatch(/SCAN commit_parents/);
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('are a no-op the second time, leaving the version and the data alone', () => {
    const path = tempIndexPath();
    const first = open(path);
    seed(first, 3);
    first.migrate();
    expect(first.schemaVersion).toBe(SCHEMA_VERSION);
    expect(first.commits.count()).toBe(3);
    first.close();

    const second = open(path);
    expect(second.schemaVersion).toBe(SCHEMA_VERSION);
    expect(second.commits.count()).toBe(3);
    expect(second.integrityCheck().ok).toBe(true);
  });

  it('refuse to read a damaged schema_version as "unmigrated" and re-run the DDL', () => {
    // Coercing this to 0 would send `migrate()` back through 0001 against a populated
    // database, which fails on `CREATE TABLE meta` and blames the migration for a single
    // bad row. Worse, it is the store guessing about its own contents.
    const path = tempIndexPath();
    const store = open(path);
    seed(store, 2);
    store.close();
    inspect(path, (db) => {
      db.prepare<[]>(
        `UPDATE meta SET value = 'banana' WHERE key = 'schema_version'`,
      ).run();
    });

    let caught: unknown;
    try {
      open(path);
    } catch (error) {
      caught = error;
    }
    expect(isExcavateError(caught)).toBe(true);
    expect((caught as ExcavateError).code).toBe('INDEX_CORRUPT');
    expect((caught as ExcavateError).message).toContain('banana');
  });

  it('still produce an integrity report when the schema version itself is unreadable', () => {
    // The report is what tells a human to rebuild, so it has to survive the thing being
    // broken — including when the broken thing is the version the report wants to print.
    //
    // Damaged from a second connection rather than through `setMeta`, which refuses the
    // reserved keys, and rather than before `open`, which refuses the file outright. That
    // leaves the case this branch actually exists for: the ledger going bad underneath a
    // store that is already holding a handle.
    const path = tempIndexPath();
    const store = open(path);
    seed(store, 2);
    inspect(path, (db) => {
      db.prepare<[]>(`UPDATE meta SET value = 'wat' WHERE key = 'schema_version'`).run();
    });

    const report = store.integrityCheck();
    expect(report.ok).toBe(false);
    // 0, not a guess: the store does not know what version this file is.
    expect(report.schemaVersion).toBe(0);
    expect(report.problems.join('\n')).toContain('schema version is unreadable');
    // The other checks still ran rather than being aborted by the first failure.
    expect(report.problems.join('\n')).not.toContain('full-text index');
  });

  it('refuse to let a caller overwrite the meta keys this package owns', () => {
    const store = open(tempIndexPath());
    for (const key of ['schema_version', 'repo_id', 'index_state']) {
      expect(
        () =>
          store.transaction((tx) => {
            tx.setMeta(key, 'nonsense');
          }),
        key,
      ).toThrow(TypeError);
    }
    // And the real values survived, so the refusal happened before the write.
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(store.integrityCheck().ok).toBe(true);
  });

  it('refuse a database written by a newer build rather than mangling it', () => {
    const path = tempIndexPath();
    open(path).close();
    inspect(path, (db) => {
      db.prepare<[string]>(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(
        String(SCHEMA_VERSION + 6),
      );
    });

    let caught: unknown;
    try {
      open(path);
    } catch (error) {
      caught = error;
    }
    expect(isExcavateError(caught)).toBe(true);
    expect((caught as ExcavateError).code).toBe('SCHEMA_TOO_NEW');
    expect((caught as ExcavateError).message).toContain('Upgrade Excavate');
  });
});

/* ── Round trip ────────────────────────────────────────────────────────────── */

describe('a ground-truth round trip', () => {
  it('reads a commit back exactly as it was written, including both UTC offsets', () => {
    const store = memoryStore();
    const author = personFixture(1);
    const committer = personFixture(2, { isBot: true, mergeSource: 'mailmap' });
    const written = commitFixture(7, {
      parents: [],
      author: author.id,
      committer: committer.id,
      subject: 'fix the flaky retry',
      body: 'The backoff was multiplying by zero.\n',
      trailers: [
        { key: 'Co-authored-by', value: 'Person 2 <person2@example.com>' },
        { key: 'Fixes', value: '#41' },
      ],
      flags: ['revert', 'signed'],
      significance: 0.75,
      authoredAt: timestamp(1_701_000_000, -480),
      committedAt: timestamp(1_701_000_500, 330),
    });

    store.transaction((tx) => {
      tx.upsertPeople([author, committer]);
      tx.insertCommits([written]);
    });

    expect(store.commits.byOid(written.oid)).toEqual(written);
    expect(store.commits.byId(written.id)).toEqual(written);
    expect(store.commits.byOid(oidFor(999))).toBeNull();
    expect(store.commits.byId(commitId(999))).toBeNull();
    expect(store.commits.count()).toBe(1);
  });

  it('preserves parent order, so the first parent stays the first parent', () => {
    const store = memoryStore();
    store.transaction((tx) => {
      tx.upsertPeople([personFixture(1)]);
      tx.insertCommits([commitFixture(1, { parents: [] }), commitFixture(2)]);
      tx.insertCommits([
        commitFixture(3, { parents: [commitId(2), commitId(1)], flags: ['merge'] }),
      ]);
    });
    expect(store.commits.byId(commitId(3))?.parents).toEqual([commitId(2), commitId(1)]);
  });

  it('reads people back with their identities, and hides bots when asked', () => {
    const store = memoryStore();
    const human = personFixture(1, {
      identities: [
        { name: 'P1', email: 'p1@corp.example' },
        { name: 'Person 1', email: 'person1@example.com' },
      ],
      mergeSource: 'name-and-domain',
    });
    const bot = personFixture(2, { isBot: true, commitCount: 900 });

    store.transaction((tx) => {
      tx.upsertPeople([human, bot]);
    });

    expect(store.people.byId(human.id)).toEqual(human);
    expect(store.people.byId(personId(99))).toBeNull();
    expect(store.people.count()).toBe(2);
    expect(store.people.all({ includeBots: true }).map((person) => person.id)).toEqual([
      bot.id,
      human.id,
    ]);
    expect(store.people.all({ includeBots: false })).toEqual([human]);
  });

  it('moves an identity to the surviving person when two people are merged', () => {
    const store = memoryStore();
    store.transaction((tx) => {
      tx.upsertPeople([personFixture(1), personFixture(2)]);
    });
    store.transaction((tx) => {
      tx.upsertPeople([
        personFixture(1, {
          identities: [
            { name: 'Person 1', email: 'person1@example.com' },
            { name: 'Person 2', email: 'person2@example.com' },
          ],
          mergeSource: 'normalized-email',
        }),
      ]);
    });

    expect(store.people.byId(personId(1))?.identities).toHaveLength(2);
    expect(store.people.byId(personId(2))?.identities).toEqual([]);
  });

  it('reads files, their aliases, and the changes of a commit back unchanged', () => {
    const store = memoryStore();
    seed(store, 2);

    store.transaction((tx) => {
      const [oldId, currentId] = tx.internPaths(['src/old.ts', 'src/new.ts']);
      const old = must(oldId);
      const current = must(currentId);
      tx.upsertFiles([
        {
          id: fileId(1),
          currentPath: current,
          aliases: [
            { path: old, from: commitId(1), to: commitId(2) },
            { path: current, from: commitId(2), to: null },
          ],
          born: commitId(1),
          died: null,
          language: 'typescript',
          flags: ['generated', 'test'],
        },
      ]);
      tx.insertChanges([
        {
          commit: commitId(2),
          file: fileId(1),
          kind: 'rename',
          oldPath: old,
          newPath: current,
          similarity: 96,
          insertions: 0,
          deletions: 0,
          isBinary: false,
        },
        {
          commit: commitId(1),
          file: fileId(1),
          kind: 'add',
          oldPath: null,
          newPath: old,
          similarity: null,
          insertions: 40,
          deletions: 0,
          isBinary: false,
        },
      ]);
    });

    const file = store.files.byId(fileId(1));
    expect(file).toEqual({
      id: fileId(1),
      currentPath: pathId(2),
      aliases: [
        { path: pathId(1), from: commitId(1), to: commitId(2) },
        { path: pathId(2), from: commitId(2), to: null },
      ],
      born: commitId(1),
      died: null,
      language: 'typescript',
      flags: ['generated', 'test'],
    });
    expect(store.files.byId(fileId(99))).toBeNull();
    expect(store.files.count()).toBe(1);
    expect(store.files.pathOf(pathId(1))).toBe('src/old.ts');
    expect(store.files.pathOf(pathId(404))).toBeNull();

    expect(store.commits.changesIn(commitId(2))).toEqual([
      {
        commit: commitId(2),
        file: fileId(1),
        kind: 'rename',
        oldPath: pathId(1),
        newPath: pathId(2),
        similarity: 96,
        insertions: 0,
        deletions: 0,
        isBinary: false,
      },
    ]);
    expect(store.commits.changesIn(commitId(1))[0]?.kind).toBe('add');
  });

  it('keeps a binary change flagged as binary', () => {
    const store = memoryStore();
    seed(store, 1);
    store.transaction((tx) => {
      const path = must(tx.internPaths(['logo.png'])[0]);
      tx.upsertFiles([fileFixture(1, commitId(1), path)]);
      tx.insertChanges([
        { ...changeFixture(commitId(1), fileId(1), path), kind: 'add', isBinary: true },
      ]);
    });
    expect(store.commits.changesIn(commitId(1))[0]?.isBinary).toBe(true);
  });
});

describe('a batch the size the walk actually flushes', () => {
  it('writes thousands of commits and changes in one transaction and reads them back', () => {
    const store = open(tempIndexPath(), { bulkLoad: true });
    const commitCount = 2_000;
    const filesPerCommit = 5;

    store.transaction((tx) => {
      tx.upsertPeople([personFixture(1)]);
      const paths = tx.internPaths(
        Array.from({ length: filesPerCommit }, (_, i) => `src/module-${i}.ts`),
      );
      tx.upsertFiles(paths.map((path, i) => fileFixture(i + 1, commitId(1), path)));

      const commits: Commit[] = [];
      const changes: Change[] = [];
      for (let n = 1; n <= commitCount; n += 1) {
        commits.push(commitFixture(n));
        for (const [index, path] of paths.entries()) {
          changes.push(changeFixture(commitId(n), fileId(index + 1), path));
        }
      }
      tx.insertCommits(commits);
      tx.insertChanges(changes);
    });

    expect(store.commits.count()).toBe(commitCount);
    expect(store.files.count()).toBe(filesPerCommit);
    expect(store.commits.changesIn(commitId(1_500))).toHaveLength(filesPerCommit);
    expect(store.commits.byId(commitId(commitCount))?.parents).toEqual([
      commitId(commitCount - 1),
    ]);
    // Foreign keys were off for the load, so this is the pass that proves the rows hang
    // together — the "verified after" half of Part 9 §9.2.1.
    expect(store.integrityCheck().ok).toBe(true);
  });
});

/* ── Path interning ────────────────────────────────────────────────────────── */

describe('internPaths', () => {
  it('returns ids in the caller’s order, including for repeats inside one call', () => {
    const store = memoryStore();
    const ids = store.transaction((tx) =>
      tx.internPaths(['b.ts', 'a.ts', 'b.ts', 'c.ts', 'a.ts']),
    );
    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[1]).toBe(ids[4]);
    expect(new Set(ids).size).toBe(3);
    // `must` rather than a cast: a cast would hand `undefined` to `pathOf` and let the
    // failure surface as a confusing SQLite bind error three frames away.
    expect(store.files.pathOf(must(ids[1]))).toBe('a.ts');
    expect(store.files.pathOf(must(ids[3]))).toBe('c.ts');
  });

  it('is idempotent across calls and across transactions', () => {
    const store = memoryStore();
    const first = store.transaction((tx) => tx.internPaths(['src/a.ts', 'src/b.ts']));
    expect(store.transaction((tx) => tx.internPaths(['src/b.ts', 'src/a.ts']))).toEqual([
      first[1],
      first[0],
    ]);
    expect(store.transaction((tx) => tx.internPaths(['src/a.ts']))).toEqual([first[0]]);
  });
});

/* ── Pagination ────────────────────────────────────────────────────────────── */

describe('the paged commit list', () => {
  /** Walk every page and return the ids in the order the cursor produced them. */
  function walk(store: Store, limit: number): CommitId[] {
    const seen: CommitId[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = store.commits.list({ limit, cursor });
      seen.push(...page.rows.map((commit) => commit.id));
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 1_000) throw new Error('the cursor never terminated');
    } while (cursor !== null);
    return seen;
  }

  it('visits every commit exactly once when the page size divides the total', () => {
    const store = memoryStore();
    seed(store, 20);
    const seen = walk(store, 5);
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });

  it('visits every commit exactly once when the page size does not divide the total', () => {
    const store = memoryStore();
    seed(store, 47);
    const seen = walk(store, 7);
    expect(seen).toHaveLength(47);
    expect(new Set(seen).size).toBe(47);
  });

  it('walks newest first and hands back no cursor on the final page', () => {
    const store = memoryStore();
    seed(store, 9);
    expect(walk(store, 4)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1].map(commitId));

    const exact = store.commits.list({ limit: 9, cursor: null });
    expect(exact.rows).toHaveLength(9);
    expect(exact.nextCursor).toBeNull();
  });

  it('neither duplicates nor skips commits that share one committed_at second', () => {
    const store = memoryStore();
    const shared = timestamp(1_700_500_000, 0);
    store.transaction((tx) => {
      tx.upsertPeople([personFixture(1)]);
      const commits: Commit[] = [];
      for (let n = 1; n <= 25; n += 1) {
        commits.push(commitFixture(n, { parents: [], committedAt: shared }));
      }
      tx.insertCommits(commits);
    });

    const seen = walk(store, 6);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('walks a history far larger than one page without losing or repeating a commit', () => {
    // 3,000 commits in 30 tie groups of 100 sharing a second, walked 7 at a time: 429
    // pages, every one of them served from a cursor. This is the shape that broke under
    // the OR-form keyset — not in its answers, which were right, but in the work done to
    // get them — and it is the shape that catches an off-by-one in a tie group, which a
    // 20-commit fixture cannot.
    const store = memoryStore();
    const total = 3_000;
    store.transaction((tx) => {
      tx.upsertPeople([personFixture(1)]);
      const commits: Commit[] = [];
      for (let n = 1; n <= total; n += 1) {
        commits.push(
          commitFixture(n, {
            parents: [],
            committedAt: timestamp(1_700_000_000 + Math.floor(n / 100), 0),
          }),
        );
      }
      tx.insertCommits(commits);
    });

    const seen = walk(store, 7);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // Strictly descending id throughout: a keyset that mishandles a tie group reorders
    // within it long before it duplicates anything.
    expect(seen.every((id, i) => i === 0 || id < (seen[i - 1] ?? 0))).toBe(true);
  });

  it('returns an empty first page with no cursor on an empty index', () => {
    const page = memoryStore().commits.list({ limit: 10, cursor: null });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a limit that cannot describe a page', () => {
    const store = memoryStore();
    expect(() => store.commits.list({ limit: 0, cursor: null })).toThrow(RangeError);
    expect(() => store.commits.list({ limit: -3, cursor: null })).toThrow(RangeError);
    expect(() => store.commits.list({ limit: 1.5, cursor: null })).toThrow(RangeError);
  });

  it('rejects a cursor it did not mint, instead of returning arbitrary rows', () => {
    const store = memoryStore();
    seed(store, 3);
    let caught: unknown;
    try {
      store.commits.list({ limit: 2, cursor: 'not-a-cursor' });
    } catch (error) {
      caught = error;
    }
    expect(isExcavateError(caught)).toBe(true);
    expect((caught as ExcavateError).code).toBe('INVALID_TARGET');
  });
});

describe('the page cursor', () => {
  it('round-trips its sort key without exposing it as a readable field', () => {
    const encoded = encodeCommitCursor({ committedAt: 1_700_000_000, id: 42 });
    expect(encoded).not.toContain('1700000000');
    expect(decodeCommitCursor(encoded)).toEqual({ committedAt: 1_700_000_000, id: 42 });
  });

  it('rejects a cursor minted under a different key shape', () => {
    const stale = Buffer.from('c0:1700000000:42', 'utf8').toString('base64url');
    expect(() => decodeCommitCursor(stale)).toThrow(ExcavateError);
  });

  it('rejects a cursor whose key is not an integer pair', () => {
    const bad = Buffer.from('c1:not-a-time:42', 'utf8').toString('base64url');
    expect(() => decodeCommitCursor(bad)).toThrow(ExcavateError);
  });

  it('rejects a mangled key rather than decoding it into a plausible position', () => {
    // Every one of these is accepted by `Number()` and lands on a safe integer, so a
    // `Number.isSafeInteger` check alone lets them through. `c1::` is the dangerous one:
    // it decodes to (0, 0), which is a well-formed cursor pointing before the start of
    // history, so the page comes back empty with `nextCursor: null` and the caller reads
    // a truncated history as a complete one.
    for (const payload of [
      'c1::',
      'c1:0x1f:42',
      'c1:1e3:42',
      'c1: 42 :7',
      'c1:4.5:7',
      // All digits, but past 2^53, where integer arithmetic silently stops being exact.
      'c1:99999999999999999999:7',
    ]) {
      const encoded = Buffer.from(payload, 'utf8').toString('base64url');
      expect(() => decodeCommitCursor(encoded), payload).toThrow(ExcavateError);
    }
  });

  it('round-trips a pre-1970 commit date, which Git does allow', () => {
    const encoded = encodeCommitCursor({ committedAt: -86_400, id: 3 });
    expect(decodeCommitCursor(encoded)).toEqual({ committedAt: -86_400, id: 3 });
  });
});

/* ── Full text ─────────────────────────────────────────────────────────────── */

describe('full-text search over commits', () => {
  it('finds a commit by a word that appears only in its body', () => {
    const store = memoryStore();
    seedCorpus(store);
    expect(store.search.commits('jitter', 10).map((commit) => commit.id)).toEqual([
      commitId(1),
    ]);
  });

  it('finds a commit by a word in its subject', () => {
    const store = memoryStore();
    seedCorpus(store);
    expect(store.search.commits('widget', 10).map((commit) => commit.id)).toEqual([
      commitId(2),
    ]);
  });

  it('returns nothing for a word that appears in no commit', () => {
    const store = memoryStore();
    seedCorpus(store);
    expect(store.search.commits('kubernetes', 10)).toEqual([]);
  });

  it('requires every word, so two terms from different commits match nothing', () => {
    const store = memoryStore();
    seedCorpus(store);
    expect(store.search.commits('jitter mechanical', 10)).toEqual([]);
    expect(store.search.commits('jitter scheduler', 10).map((c) => c.id)).toEqual([
      commitId(1),
    ]);
  });

  it('hydrates a hit into the same commit an id lookup returns', () => {
    const store = memoryStore();
    seedCorpus(store);
    const [hit] = store.search.commits('jitter', 10);
    expect(hit).toEqual(store.commits.byId(commitId(1)));
  });

  it('honours its limit', () => {
    const store = memoryStore();
    seedCorpus(store);
    expect(store.search.commits('the', 1)).toHaveLength(1);
  });

  it('drops a deleted commit out of the index, keeping the two in step', () => {
    const path = tempIndexPath();
    const store = open(path);
    seedCorpus(store);
    expect(store.search.commits('legacy', 10)).toHaveLength(1);
    store.close();

    // No public query deletes a commit — history is append-only — so the delete trigger
    // has to be exercised through SQL. If it were missing, the FTS index would keep
    // returning a commit that no longer exists.
    inspect(path, (db) => {
      db.prepare<[]>('DELETE FROM commits WHERE id = 3').run();
    });

    const reopened = open(path);
    expect(reopened.search.commits('legacy', 10)).toEqual([]);
    expect(reopened.search.commits('jitter', 10)).toHaveLength(1);
    expect(reopened.integrityCheck().problems).toEqual([]);
  });

  it('is reported by integrityCheck when a stale entry survives a deleted commit', () => {
    const path = tempIndexPath();
    const store = open(path);
    seedCorpus(store);
    store.close();

    // Exactly the damage the delete trigger exists to prevent. Worth asserting because
    // the join in `search.commits` hides a stale FTS row from callers, so the integrity
    // report is the only place this becomes visible.
    inspect(path, (db) => {
      db.exec('DROP TRIGGER commits_fts_after_delete');
      db.prepare<[]>('DELETE FROM commits WHERE id = 3').run();
    });

    const problems = open(path).integrityCheck().problems.join('\n');
    expect(problems).toContain('full-text index is out of step');
  });

  it('is reported by integrityCheck when a commit was never indexed at all', () => {
    // The worse direction, and the one nothing else can catch. A stale entry is hidden by
    // the join, but a *missing* entry means an existing commit is silently absent from
    // every search result: the answer looks complete and is not. Measured against SQLite
    // 3.53.4, the bare `integrity-check` and the `rank = 0` form both report success here
    // and only `rank = 1` raises, which is why the implementation passes the argument.
    const path = tempIndexPath();
    const store = open(path);
    seedCorpus(store);
    store.close();

    inspect(path, (db) => {
      db.exec('DROP TRIGGER commits_fts_after_insert');
      db.prepare<[]>(
        `INSERT INTO commits (id, oid, tree_oid, author_id, committer_id, authored_at,
           authored_tz, committed_at, committed_tz, subject, body, generation)
         VALUES (4, 'f'||hex(randomblob(19)), 'e'||hex(randomblob(19)), 1, 1,
           1700009999, 0, 1700009999, 0, 'unindexed unicorn', NULL, 4)`,
      ).run();
      // The row is really there, so this is a search that lies rather than a missing row.
      expect(db.prepare<[], number>('SELECT count(*) FROM commits').pluck().get()).toBe(
        4,
      );
    });

    const reopened = open(path);
    expect(reopened.commits.byId(commitId(4))?.subject).toBe('unindexed unicorn');
    expect(reopened.search.commits('unicorn', 10)).toEqual([]);
    expect(reopened.integrityCheck().problems.join('\n')).toContain(
      'full-text index is out of step',
    );
  });

  it('survives punctuation that would be FTS5 syntax if it were passed through raw', () => {
    const store = memoryStore();
    seedCorpus(store);
    for (const query of ['foo (', 'C++', '"unbalanced', 'NEAR(', '*', 'a AND', '-x']) {
      expect(() => store.search.commits(query, 10), query).not.toThrow();
    }
  });

  it('turns user text into an implicit-AND expression with a typeahead prefix', () => {
    expect(toMatchExpression('retry backoff')).toBe('"retry" "backoff"*');
    expect(toMatchExpression('C++')).toBe('"C"*');
    expect(toMatchExpression('   ')).toBeNull();
  });
});

/* ── Transactions ──────────────────────────────────────────────────────────── */

describe('transaction', () => {
  it('rolls back on a throw and leaves the store readable afterwards', () => {
    const store = memoryStore();
    seed(store, 2);

    expect(() =>
      store.transaction((tx) => {
        tx.insertCommits([commitFixture(3)]);
        throw new Error('disk full');
      }),
    ).toThrow('disk full');

    expect(store.commits.count()).toBe(2);
    expect(store.commits.byId(commitId(3))).toBeNull();
    expect(store.commits.byId(commitId(2))).not.toBeNull();

    store.transaction((tx) => {
      tx.insertCommits([commitFixture(3)]);
    });
    expect(store.commits.count()).toBe(3);
  });

  it('rolls the full-text index back along with the rows it indexed', () => {
    const store = memoryStore();
    seed(store, 1);
    expect(() =>
      store.transaction((tx) => {
        tx.insertCommits([
          commitFixture(2, { subject: 'introduce quicksilver', body: null }),
        ]);
        throw new Error('cancelled');
      }),
    ).toThrow('cancelled');

    expect(store.search.commits('quicksilver', 10)).toEqual([]);
    expect(store.integrityCheck().problems).toEqual([]);
  });

  it('returns the callback’s value, so a writer can report what it wrote', () => {
    const store = memoryStore();
    expect(store.transaction((tx) => tx.internPaths(['a.ts']).length)).toBe(1);
  });

  it('releases the handle on close even when the closing statistics refresh fails', () => {
    // `close()` runs `PRAGMA optimize`, which may run `ANALYZE`, which *writes* — so under
    // contention it raises SQLITE_BUSY_SNAPSHOT. If that escaped, `db.close()` would never
    // run and the handle would leak with its WAL file, which is the one thing `close()`
    // exists to guarantee. A refreshed query planner is a nice-to-have; releasing the file
    // is not.
    const path = tempIndexPath();
    const store = open(path);
    seed(store, 300);

    const indexer = new BetterSqlite3(path);
    try {
      expect(() =>
        store.transaction(() => {
          store.commits.count(); // takes the WAL read snapshot
          indexer
            .prepare<[]>(
              `INSERT INTO commits (id, oid, tree_oid, author_id, committer_id,
                 authored_at, authored_tz, committed_at, committed_tz, subject,
                 body, generation)
               VALUES (999, 'cc', 'dd', 1, 1, 1, 0, 1, 0, 'from the walk', NULL, 999)`,
            )
            .run(); // commits past it, so the store's next write cannot upgrade
          store.close();
        }),
      ).toThrow();
    } finally {
      indexer.close();
    }

    // A leaked handle would answer this instead of refusing it.
    expect(() => store.commits.count()).toThrow(/not open/i);
  });

  it('refuses a write through a transaction handle that has escaped its scope', () => {
    const store = memoryStore();
    const escaped = store.transaction((tx) => tx);
    expect(() => escaped.internPaths(['a.ts'])).toThrow(TypeError);
  });

  it('records index state and arbitrary metadata for the incremental-update check', () => {
    const path = tempIndexPath();
    const store = open(path);
    store.transaction((tx) => {
      tx.setIndexState('walking');
      tx.setMeta('excavate_version', '0.0.0');
    });
    store.transaction((tx) => {
      tx.setIndexState('ready');
    });
    store.close();

    inspect(path, (db) => {
      const read = (key: string): string | undefined =>
        db
          .prepare<[string], string>('SELECT value FROM meta WHERE key = ?')
          .pluck()
          .get(key);
      expect(read('index_state')).toBe('ready');
      expect(read('excavate_version')).toBe('0.0.0');
      expect(read('repo_id')).toBe(REPO);
    });
  });
});

/* ── Refs and tags ─────────────────────────────────────────────────────────── */

describe('the ref and tag snapshot', () => {
  it('replaces the whole set rather than accumulating stale refs', () => {
    const path = tempIndexPath();
    const store = open(path);
    seed(store, 2);

    store.transaction((tx) => {
      tx.replaceRefs([
        { name: 'refs/heads/main', kind: 'branch', target: commitId(2), isHead: true },
        { name: 'refs/heads/gone', kind: 'branch', target: commitId(1), isHead: false },
      ]);
      tx.replaceTags([
        {
          id: tagId(1),
          name: 'v1.0.0',
          target: commitId(1),
          tagger: personId(1),
          taggedAt: timestamp(1_700_000_100, 60),
          message: 'first release',
        },
        {
          id: tagId(2),
          name: 'nightly',
          target: commitId(2),
          tagger: null,
          taggedAt: null,
          message: null,
        },
      ]);
    });

    store.transaction((tx) => {
      tx.replaceRefs([
        { name: 'refs/heads/main', kind: 'branch', target: commitId(2), isHead: true },
      ]);
      tx.replaceTags([
        {
          id: tagId(1),
          name: 'v1.0.0',
          target: commitId(1),
          tagger: personId(1),
          taggedAt: timestamp(1_700_000_100, 60),
          message: 'first release',
        },
      ]);
    });
    store.close();

    inspect(path, (db) => {
      expect(
        db.prepare<[], string>('SELECT name FROM refs ORDER BY name').pluck().all(),
      ).toEqual(['refs/heads/main']);
      expect(db.prepare<[], number>('SELECT is_head FROM refs').pluck().get()).toBe(1);
      expect(
        db.prepare<[], string>('SELECT name FROM tags ORDER BY name').pluck().all(),
      ).toEqual(['v1.0.0']);
    });
  });
});

/* ── Integrity ─────────────────────────────────────────────────────────────── */

describe('integrityCheck', () => {
  it('reports ok on a freshly migrated database', () => {
    expect(open(tempIndexPath()).integrityCheck()).toEqual({
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      problems: [],
    });
  });

  it('reports ok on a populated database', () => {
    const store = open(tempIndexPath());
    seed(store, 30);
    const report = store.integrityCheck();
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('names the dangling rows a bulk load left behind, rather than reporting ok', () => {
    // Foreign keys are off during a bulk load by design (Part 9 §9.2.1), so this check
    // is the only thing that catches a walk which wrote a commit for a person it never
    // stored — hence "OFF during bulk load, verified after".
    const store = open(tempIndexPath(), { bulkLoad: true });
    store.transaction((tx) => {
      tx.insertCommits([commitFixture(1, { parents: [], author: personId(77) })]);
    });

    const report = store.integrityCheck();
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('foreign key violation');
    expect(report.problems.join('\n')).toContain('commits');
  });

  it('enforces foreign keys on a normal open, rather than only reporting them later', () => {
    const store = open(tempIndexPath());
    expect(() =>
      store.transaction((tx) => {
        tx.insertCommits([commitFixture(1, { parents: [], author: personId(77) })]);
      }),
    ).toThrow(/FOREIGN KEY/i);
    expect(store.commits.count()).toBe(0);
  });

  it('refuses to call a busy index corrupt, because the fix for corrupt is a rebuild', () => {
    // FTS5's integrity-check is an INSERT, so it needs the write lock, so it raises
    // SQLITE_BUSY whenever the indexer is mid-batch — routine under WAL, which exists
    // precisely so the UI can read the partial index while the walk writes it. Reporting
    // that as `ok: false` would offer to destroy and rebuild a perfectly healthy index.
    //
    // Reproduced through a snapshot conflict rather than a held lock: reading inside
    // `store.transaction()` takes a WAL read snapshot, and a commit from another
    // connection makes the later write un-upgradable. That returns SQLITE_BUSY_SNAPSHOT
    // in about a millisecond instead of waiting out the 5s busy timeout, and it is a real
    // scenario — `excavate doctor` inspecting while the walk commits.
    const path = tempIndexPath();
    const store = open(path);
    seed(store, 2);

    const indexer = new BetterSqlite3(path);
    try {
      let caught: unknown;
      try {
        store.transaction(() => {
          // Take the read snapshot, then let the other connection commit past it.
          expect(store.commits.count()).toBe(2);
          indexer
            .prepare<[]>(
              `INSERT INTO commits (id, oid, tree_oid, author_id, committer_id,
                 authored_at, authored_tz, committed_at, committed_tz, subject,
                 body, generation)
               VALUES (3, 'aa', 'bb', 1, 1, 1, 0, 1, 0, 'from the walk', NULL, 3)`,
            )
            .run();
          return store.integrityCheck();
        });
      } catch (error) {
        caught = error;
      }

      expect(isExcavateError(caught)).toBe(true);
      expect((caught as ExcavateError).code).toBe('CANCELLED');
      expect((caught as ExcavateError).message).toContain('retry');
      expect((caught as ExcavateError).details['sqlite']).toBe('SQLITE_BUSY_SNAPSHOT');
    } finally {
      indexer.close();
    }

    // And the index really was fine: once the contention is gone the report is clean.
    expect(store.integrityCheck().ok).toBe(true);
  });

  it('reports an index that was built for a different repository', () => {
    const path = tempIndexPath();
    open(path).close();
    const other = openStore({ path, repoId: repoId('some-other-repo') });
    stores.push(other);
    const report = other.integrityCheck();
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('some-other-repo');
  });
});

/* ── Deferred surface ──────────────────────────────────────────────────────── */

describe('the deferred query surface', () => {
  it('names the milestone that will implement each stub, rather than returning empty', () => {
    const store = memoryStore();
    const deferred: readonly (readonly [string, () => unknown])[] = [
      ['commits.mostSignificant', () => store.commits.mostSignificant(5)],
      ['commits.hunksIn', () => store.commits.hunksIn(commitId(1), fileId(1))],
      ['commits.isAncestor', () => store.commits.isAncestor(commitId(1), commitId(2))],
      ['files.byPath', () => store.files.byPath('a.ts', null)],
      ['files.changesTo', () => store.files.changesTo(fileId(1))],
      ['search.paths', () => store.search.paths('a', 5)],
      ['rollups.ownership', () => store.rollups.ownership(fileId(1))],
      ['rollups.hotspots', () => store.rollups.hotspots(5)],
      ['rollups.knowledgeIslands', () => store.rollups.knowledgeIslands(5)],
      ['rollups.coupledWith', () => store.rollups.coupledWith(fileId(1), 5)],
      ['rollups.revertPairs', () => store.rollups.revertPairs()],
      ['rollups.eras', () => store.rollups.eras()],
      ['rollups.releases', () => store.rollups.releases()],
      ['rollups.timelineBuckets', () => store.rollups.timelineBuckets('week')],
      ['bundles.get', () => store.bundles.get(bundleHash('deadbeef'))],
      [
        'bundles.put',
        () =>
          store.bundles.put({
            target: { kind: 'file', file: fileId(1) },
            items: [],
            confidence: { level: 'low', score: 0, reasons: [] },
            gaps: [],
            hash: bundleHash('deadbeef'),
          }),
      ],
      ['insertHunks', () => store.transaction((tx) => tx.insertHunks([]))],
    ];

    for (const [name, call] of deferred) {
      let caught: unknown;
      try {
        call();
      } catch (error) {
        caught = error;
      }
      expect(caught, name).toBeInstanceOf(NotImplementedError);
      expect((caught as NotImplementedError).milestone, name).toMatch(/^M[1-5]$/);
    }
  });
});
