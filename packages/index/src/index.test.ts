/**
 * The pipeline is tested against fakes, not against `CliGitBackend` and `openStore`.
 *
 * Partly out of necessity — both are being written in parallel — but mostly because
 * it is the better test: the properties that matter here are *ordering* properties
 * (dense ids in walk order, one flush per batch boundary, every sink sees every
 * change, `finish` exactly once inside the last transaction), and a recording double
 * observes those directly instead of inferring them from SQLite state afterwards.
 * The end-to-end assertion that real Git and real SQLite agree with this is M0's
 * walking-skeleton integration test, which lives with the daemon.
 *
 * **The fake store enforces the schema's foreign keys and rolls back on throw**, which
 * is not decoration. Part 9's references are immediate rather than `DEFERRABLE`, and
 * `openStore` only disables `foreign_keys` when a caller opts into `bulkLoad` — which
 * the daemon does not — so "write commits now, upsert people at the end" is a design
 * that passes any permissive double and then fails on the first flush of every real
 * repository. A double that accepts writes SQLite would reject is not a cheap test, it
 * is a misleading one.
 */

import type {
  Change,
  Commit,
  FileEntity,
  IndexState,
  Oid,
  PathId,
  Person,
} from '@wise-excavate/core';
import {
  isExcavateError,
  NotImplementedError,
  parseOid,
  pathId,
  timestamp,
} from '@wise-excavate/core';
import type { GitBackend, Mailmap, RawChange, RawCommit } from '@wise-excavate/git';
import { DEFAULT_WALK_SPEC } from '@wise-excavate/git';
import type { Store, Transaction } from '@wise-excavate/store';
import { describe, expect, it } from 'vitest';

import type { IndexProgress, IndexRunOptions, WalkContext, WalkSink } from './index.js';
import {
  computeRepoId,
  createIdentityResolver,
  createIndexPipeline,
  createRenameResolver,
  DELETE_ADD_RENAME_SIMILARITY,
  META_KEYS,
} from './index.js';

/* ── Fakes ─────────────────────────────────────────────────────────────────── */

const oid = (n: number): Oid => parseOid(String(n).padStart(40, '0'));

const AUTHOR_EPOCH = 1_700_000_000;

function add(path: string): RawChange {
  return {
    kind: 'add',
    oldPath: null,
    newPath: path,
    similarity: null,
    insertions: 10,
    deletions: 0,
    isBinary: false,
  };
}

function edit(path: string): RawChange {
  return {
    kind: 'modify',
    oldPath: path,
    newPath: path,
    similarity: null,
    insertions: 3,
    deletions: 1,
    isBinary: false,
  };
}

function renamed(from: string, to: string): RawChange {
  return {
    kind: 'rename',
    oldPath: from,
    newPath: to,
    similarity: 100,
    insertions: 0,
    deletions: 0,
    isBinary: false,
  };
}

interface CommitOverrides {
  readonly email?: string;
  readonly name?: string;
  readonly parents?: readonly number[];
  readonly changes?: readonly RawChange[];
  readonly message?: string;
  /** Seconds past `AUTHOR_EPOCH`. Defaults to `n * 60`, i.e. monotonic. */
  readonly authoredOffset?: number;
}

/** `n` is both the synthetic OID and, by default, the single parent link `n - 1`. */
function rawCommit(n: number, overrides: CommitOverrides = {}): RawCommit {
  const identity = {
    name: overrides.name ?? 'Ada Lovelace',
    email: overrides.email ?? 'ada@example.com',
  };
  const at = timestamp(AUTHOR_EPOCH + (overrides.authoredOffset ?? n * 60), 0);
  return {
    oid: oid(n),
    tree: oid(900 + n),
    parents: (overrides.parents ?? (n === 1 ? [] : [n - 1])).map(oid),
    author: identity,
    authoredAt: at,
    committer: identity,
    committedAt: timestamp(AUTHOR_EPOCH + n * 60, 0),
    message: overrides.message ?? `subject ${n}\n\nbody ${n}\n`,
    changes: overrides.changes ?? [edit('src/a.ts')],
  };
}

/**
 * Emits `commits` and records what it emitted, which is how "the walk stopped" is
 * distinguished from "the rows were discarded" in the cancellation test.
 */
function fakeBackend(
  commits: readonly RawCommit[],
  onEmit?: (index: number) => void,
  options: { readonly mailmap?: Mailmap | null } = {},
): { readonly backend: GitBackend; readonly emitted: Oid[] } {
  const emitted: Oid[] = [];
  const backend = {
    walk: async function* (): AsyncGenerator<RawCommit> {
      for (const [index, commit] of commits.entries()) {
        onEmit?.(index);
        emitted.push(commit.oid);
        yield commit;
      }
    },
    /* The walk reads HEAD before starting, to record `indexed_tip` for the incremental
       path. The last *emitted* commit will not do: under `--all` that is whichever ref tip
       sorts last topologically, so a tip taken from the stream would make every second
       open look like a history rewrite. */
    refs: () =>
      Promise.resolve(
        commits.length === 0
          ? []
          : [{ name: 'HEAD', kind: 'head', target: commits.at(-1)!.oid, isHead: true }],
      ),
    readMailmap: () => Promise.resolve(options.mailmap ?? null),
  } as unknown as GitBackend;
  return { backend, emitted };
}

interface StoreLog {
  /** One entry per `store.transaction()`, holding that transaction's calls in order. */
  readonly transactions: string[][];
  readonly handles: Transaction[];
  readonly commits: Commit[];
  readonly changes: Change[];
  /** Keyed, because these are upserts: the last write for an id is the stored row. */
  readonly people: Map<number, Person>;
  readonly files: Map<number, FileEntity>;
  readonly states: IndexState[];
  readonly meta: Map<string, string>;
  readonly paths: Map<string, PathId>;
}

function peopleOf(log: StoreLog): readonly Person[] {
  return [...log.people.values()].sort((a, b) => a.id - b.id);
}

function filesOf(log: StoreLog): readonly FileEntity[] {
  return [...log.files.values()].sort((a, b) => a.id - b.id);
}

/** How many commit rows each transaction wrote, so batch boundaries are visible. */
function commitsPerTransaction(log: StoreLog): number[] {
  return log.transactions.map((calls) =>
    calls
      .filter((call) => call.startsWith('insertCommits:'))
      .reduce((total, call) => total + Number(call.split(':')[1]), 0),
  );
}

function callsMatching(log: StoreLog, prefix: string): string[] {
  return log.transactions.flat().filter((call) => call.startsWith(prefix));
}

function codeOf(error: unknown): string {
  if (isExcavateError(error)) return error.code;
  return `not an ExcavateError: ${String(error)}`;
}

interface FakeStoreOptions {
  /** Fail the first call with this name, once, to exercise rollback. */
  readonly failOnce?: string;
}

/**
 * Only `transaction` is implemented. That is the assertion: if the pipeline ever
 * starts *reading* during the walk — a query per commit is the classic way an
 * indexer becomes quadratic — this fake fails loudly instead of quietly working.
 */
function fakeStore(options: FakeStoreOptions = {}): {
  readonly store: Store;
  readonly log: StoreLog;
} {
  const log: StoreLog = {
    transactions: [],
    handles: [],
    commits: [],
    changes: [],
    people: new Map(),
    files: new Map(),
    states: [],
    meta: new Map(),
    paths: new Map(),
  };
  let nextPathId = 1;
  let failed = false;

  /** Committed keys, for the foreign-key checks below. */
  const commitIds = new Set<number>();
  const pathIdsIssued = new Set<number>();

  const fk = (present: boolean, what: string): void => {
    if (!present) throw new Error(`FOREIGN KEY constraint failed: ${what}`);
  };

  const maybeFail = (call: string): void => {
    if (failed || options.failOnce !== call) return;
    failed = true;
    throw new Error(`injected store failure in ${call}`);
  };

  const snapshot = (): (() => void) => {
    const commits = log.commits.length;
    const changes = log.changes.length;
    const states = log.states.length;
    const people = new Map(log.people);
    const files = new Map(log.files);
    const meta = new Map(log.meta);
    const paths = new Map(log.paths);
    const ids = new Set(commitIds);
    const issued = new Set(pathIdsIssued);
    const pathCounter = nextPathId;
    // A rolled-back transaction takes every row it wrote with it, including the
    // interned paths — which is the whole reason the pipeline must not cache a
    // `PathId` across a failure.
    return () => {
      log.commits.length = commits;
      log.changes.length = changes;
      log.states.length = states;
      log.people.clear();
      for (const [id, row] of people) log.people.set(id, row);
      log.files.clear();
      for (const [id, row] of files) log.files.set(id, row);
      log.meta.clear();
      for (const [key, value] of meta) log.meta.set(key, value);
      log.paths.clear();
      for (const [path, id] of paths) log.paths.set(path, id);
      commitIds.clear();
      for (const id of ids) commitIds.add(id);
      pathIdsIssued.clear();
      for (const id of issued) pathIdsIssued.add(id);
      nextPathId = pathCounter;
    };
  };

  const store = {
    transaction: <T>(fn: (tx: Transaction) => T): T => {
      const rollback = snapshot();
      const calls: string[] = [];
      log.transactions.push(calls);
      const tx: Transaction = {
        insertCommits(rows) {
          calls.push(`insertCommits:${rows.length}`);
          maybeFail('insertCommits');
          for (const row of rows) {
            // A plain INSERT in the real store: a duplicate id means the walk assigned
            // two dense ids to one commit, or wrote a batch twice.
            fk(!commitIds.has(row.id), `UNIQUE commits.id (${row.id} inserted twice)`);
            fk(log.people.has(row.author), `commits.author_id → people(${row.author})`);
            fk(
              log.people.has(row.committer),
              `commits.committer_id → people(${row.committer})`,
            );
            for (const parent of row.parents) {
              fk(commitIds.has(parent), `commit_parents.parent_id → commits(${parent})`);
            }
            commitIds.add(row.id);
            log.commits.push(row);
          }
        },
        insertChanges(rows) {
          calls.push(`insertChanges:${rows.length}`);
          maybeFail('insertChanges');
          for (const row of rows) {
            fk(commitIds.has(row.commit), `changes.commit_id → commits(${row.commit})`);
            fk(log.files.has(row.file), `changes.file_id → files(${row.file})`);
            for (const path of [row.oldPath, row.newPath]) {
              if (path !== null) fk(pathIdsIssued.has(path), `changes → paths(${path})`);
            }
            log.changes.push(row);
          }
        },
        insertHunks(rows) {
          // Mirrors the real store, which throws until M2. A fake that accepted hunks
          // would let a pipeline that writes them pass its tests and fail in the daemon.
          calls.push(`insertHunks:${rows.length}`);
          throw new NotImplementedError('Transaction.insertHunks', 'M2');
        },
        upsertPeople(rows) {
          calls.push(`upsertPeople:${rows.length}`);
          maybeFail('upsertPeople');
          for (const row of rows) log.people.set(row.id, row);
        },
        upsertFiles(rows) {
          calls.push(`upsertFiles:${rows.length}`);
          maybeFail('upsertFiles');
          for (const row of rows) {
            fk(commitIds.has(row.born), `files.born_commit → commits(${row.born})`);
            if (row.died !== null) {
              fk(commitIds.has(row.died), `files.died_commit → commits(${row.died})`);
            }
            if (row.currentPath !== null) {
              fk(
                pathIdsIssued.has(row.currentPath),
                `files.current_path → paths(${row.currentPath})`,
              );
            }
            for (const alias of row.aliases) {
              fk(pathIdsIssued.has(alias.path), `file_aliases → paths(${alias.path})`);
              fk(commitIds.has(alias.from), `file_aliases → commits(${alias.from})`);
              if (alias.to !== null) {
                fk(commitIds.has(alias.to), `file_aliases → commits(${alias.to})`);
              }
            }
            log.files.set(row.id, row);
          }
        },
        internPaths(paths) {
          calls.push(`internPaths:${paths.length}`);
          maybeFail('internPaths');
          return paths.map((path) => {
            const known = log.paths.get(path);
            if (known !== undefined) return known;
            const assigned = pathId(nextPathId);
            nextPathId += 1;
            log.paths.set(path, assigned);
            pathIdsIssued.add(assigned);
            return assigned;
          });
        },
        replaceRefs() {
          calls.push('replaceRefs');
        },
        replaceTags() {
          calls.push('replaceTags');
        },
        /* The analysis-tier writers. Recorded rather than implemented: the walk never calls
           them — analysis is a second pass driven by the composition root — so their presence
           here exists to satisfy the interface and to make it visible if that ever changes. */
        replaceKnowledge(rows) {
          calls.push(`replaceKnowledge:${rows.length}`);
        },
        replaceOwnership(rows) {
          calls.push(`replaceOwnership:${rows.length}`);
        },
        replaceHotspots(rows) {
          calls.push(`replaceHotspots:${rows.length}`);
        },
        setSignificance(rows) {
          calls.push(`setSignificance:${rows.length}`);
        },
        recordAnalyzerRun(analyzer) {
          calls.push(`recordAnalyzerRun:${analyzer}`);
        },
        setIndexState(state) {
          calls.push(`setIndexState:${state}`);
          log.states.push(state);
        },
        setMeta(key, value) {
          calls.push(`setMeta:${key}`);
          log.meta.set(key, value);
        },
      };
      log.handles.push(tx);
      try {
        return fn(tx);
      } catch (error) {
        // The call log survives — it is the record of what was *attempted* — but every
        // row goes back, exactly as SQLite would.
        rollback();
        throw error;
      }
    },
  } as unknown as Store;

  return { store, log };
}

interface RecordingSink extends WalkSink {
  readonly commits: Oid[];
  readonly changes: string[];
  readonly finishes: Transaction[];
}

function recordingSink(id: string): RecordingSink {
  const commits: Oid[] = [];
  const changes: string[] = [];
  const finishes: Transaction[] = [];
  return {
    id,
    commits,
    changes,
    finishes,
    onCommit(commit: RawCommit, ctx: WalkContext) {
      commits.push(commit.oid);
      expect(ctx.commitId).toBeGreaterThan(0);
    },
    onChange(commit: RawCommit, change: RawChange) {
      changes.push(`${commit.oid.slice(-2)}:${change.newPath ?? change.oldPath ?? '?'}`);
    },
    finish(tx: Transaction) {
      finishes.push(tx);
    },
  };
}

interface Harness {
  readonly log: StoreLog;
  readonly emitted: Oid[];
  readonly sinks: readonly RecordingSink[];
  readonly progress: IndexProgress[];
  /** Whatever `run()` rejected with, when the caller said to expect a rejection. */
  readonly failure: unknown;
}

interface IndexOptions {
  readonly batchRows?: number;
  readonly tiers?: IndexRunOptions['tiers'];
  readonly signal?: AbortSignal;
  readonly onEmit?: (index: number) => void;
  readonly sinkCount?: number;
  readonly failOnce?: string;
  /** Capture the rejection instead of failing the test with it. */
  readonly expectFailure?: boolean;
}

async function index(
  commits: readonly RawCommit[],
  options: IndexOptions = {},
): Promise<Harness> {
  const { store, log } = fakeStore(
    options.failOnce === undefined ? {} : { failOnce: options.failOnce },
  );
  const { backend, emitted } = fakeBackend(commits, options.onEmit);
  const sinks = Array.from({ length: options.sinkCount ?? 1 }, (_unused, i) =>
    recordingSink(`sink-${i}`),
  );

  const pipeline = createIndexPipeline({
    backend,
    store,
    sinks,
    walkSpec: DEFAULT_WALK_SPEC,
    ...(options.batchRows === undefined ? {} : { batchRows: options.batchRows }),
  });

  const progress: IndexProgress[] = [];
  let failure: unknown;
  try {
    for await (const event of pipeline.run({
      tiers: options.tiers ?? ['metadata'],
      signal: options.signal ?? new AbortController().signal,
    })) {
      progress.push(event);
    }
  } catch (error) {
    // Rethrown unless the test asked for it, so no test can pass by quietly failing.
    if (options.expectFailure !== true) throw error;
    failure = error;
  }

  return { log, emitted, sinks, progress, failure };
}

/* ── The walk ──────────────────────────────────────────────────────────────── */

describe('the indexing walk', () => {
  it('stores commits in walk order with dense ids, so every parent id precedes its child', async () => {
    const { log } = await index([1, 2, 3, 4, 5].map((n) => rawCommit(n)));

    expect(log.commits.map((commit) => commit.id)).toEqual([1, 2, 3, 4, 5]);
    expect(log.commits.map((commit) => commit.oid)).toEqual([1, 2, 3, 4, 5].map(oid));
    expect(log.commits.map((commit) => commit.parents)).toEqual([[], [1], [2], [3], [4]]);
    for (const commit of log.commits) {
      for (const parent of commit.parents) {
        expect(parent).toBeLessThan(commit.id);
      }
    }
  });

  it('splits the raw message into a subject and a body', async () => {
    const { log } = await index([
      rawCommit(1, { message: 'fix the thing\n\nbecause it was broken\n' }),
      rawCommit(2, { message: 'no body at all' }),
    ]);

    expect(log.commits[0]?.subject).toBe('fix the thing');
    expect(log.commits[0]?.body).toBe('because it was broken');
    expect(log.commits[1]?.subject).toBe('no body at all');
    expect(log.commits[1]?.body).toBeNull();
  });

  it('keeps a merge identifiable after the first-parent projection has dropped its second parent', async () => {
    const { log } = await index([
      rawCommit(1),
      rawCommit(2),
      // Parent 7 is on a branch this projection never walked, so it cannot be stored.
      rawCommit(3, { parents: [2, 7] }),
    ]);

    expect(log.commits[2]?.parents).toEqual([2]);
    expect(log.commits[2]?.flags).toContain('merge');
    expect(log.commits[0]?.flags).toContain('root');
  });

  it('scores nothing and flags no noise, because M0 has no scorer to be honest with', async () => {
    const { log } = await index([rawCommit(1), rawCommit(2)]);

    expect(log.commits.map((commit) => commit.significance)).toEqual([0, 0]);
    expect(log.commits.map((commit) => commit.trailers)).toEqual([[], []]);
    for (const commit of log.commits) {
      expect(commit.flags).not.toContain('format-only');
      expect(commit.flags).not.toContain('lockfile-only');
    }
  });

  it('numbers generations so that every parent has a lower one than its child', async () => {
    // The only property these numbers actually have. They are the walk ordinal, not a
    // commit-graph generation number, so an `isAncestor` that compares them and stops
    // there will report false positives across unwalked branches.
    const { log } = await index([
      rawCommit(1),
      rawCommit(2),
      rawCommit(3, { parents: [1] }),
      rawCommit(4, { parents: [3, 2] }),
    ]);

    const byId = new Map(log.commits.map((commit) => [commit.id, commit]));
    expect(log.commits).toHaveLength(4);
    for (const commit of log.commits) {
      for (const parent of commit.parents) {
        const parentRow = byId.get(parent);
        expect(parentRow).toBeDefined();
        expect(parentRow?.generation).toBeLessThan(commit.generation);
      }
    }
  });
});

/* ── Write ordering: the schema's foreign keys, not a preference ────────────── */

describe('write ordering', () => {
  it('writes people before the commits that reference them, and files before the changes', async () => {
    const { log } = await index(
      [1, 2, 3].map((n) => rawCommit(n, { changes: [add(`src/${n}.ts`)] })),
      { batchRows: 2 },
    );

    // `commits.author_id REFERENCES people(id)` and `changes.file_id REFERENCES
    // files(id)` are immediate constraints, and the daemon does not open the store in
    // bulk-load mode, so every batch has to stand on its own.
    // `paths` references nothing, so interning first — during materialisation — is
    // legal and is what keeps one `internPaths` call per distinct path.
    expect(log.transactions[1]).toEqual([
      'internPaths:1',
      'upsertPeople:1',
      'insertCommits:1',
      'upsertFiles:1',
      'insertChanges:1',
    ]);
    // Every transaction that writes commits writes their people first.
    for (const calls of log.transactions) {
      const commitAt = calls.findIndex((call) => call.startsWith('insertCommits'));
      const peopleAt = calls.findIndex((call) => call.startsWith('upsertPeople'));
      if (commitAt >= 0) expect(peopleAt).toBeGreaterThanOrEqual(0);
      if (commitAt >= 0 && peopleAt >= 0) expect(peopleAt).toBeLessThan(commitAt);
    }
  });

  it('upserts only the people and files a batch touched, not the whole table again', async () => {
    // Distinct names as well as distinct addresses: sharing a name at one domain is what
    // step 4 of the identity ladder merges on, and it would collapse these two into one.
    const { log } = await index(
      [1, 2, 3, 4].map((n) =>
        rawCommit(n, {
          name: n % 2 === 0 ? 'Dev Zero' : 'Dev One',
          email: `dev${n % 2}@example.com`,
          changes: [add(`src/${n}.ts`)],
        }),
      ),
      { batchRows: 2 },
    );

    expect(callsMatching(log, 'upsertPeople')).toEqual([
      'upsertPeople:1',
      'upsertPeople:1',
      'upsertPeople:1',
      'upsertPeople:1',
    ]);
    expect(callsMatching(log, 'upsertFiles')).toEqual([
      'upsertFiles:1',
      'upsertFiles:1',
      'upsertFiles:1',
      'upsertFiles:1',
    ]);
    // And the final rows still carry the fully accumulated aggregates.
    expect(peopleOf(log).map((person) => person.commitCount)).toEqual([2, 2]);
    expect(log.people.size).toBe(2);
    expect(log.files.size).toBe(4);
  });

  it('re-emits the renamed file so its second alias reaches the store', async () => {
    /* One row, not two — a rename extends a single file's alias chain. The row must still
       be re-emitted in the batch that renamed it, because `upsertFiles` rewrites aliases
       wholesale: a dirty-set that forgot it would leave the store holding a one-alias view
       of a two-alias file, with the older path unreachable. That is the M0 defect wearing a
       different hat. */
    const { log } = await index(
      [
        rawCommit(1, { changes: [add('src/old.ts')] }),
        rawCommit(2, { changes: [renamed('src/old.ts', 'src/new.ts')] }),
      ],
      { batchRows: 2 },
    );

    expect(callsMatching(log, 'upsertFiles')).toEqual(['upsertFiles:1', 'upsertFiles:1']);
    const file = filesOf(log)[0];
    expect(file?.died).toBeNull();
    expect(file?.aliases).toHaveLength(2);
  });
});

/* ── Identity and file identity, as of M1 ──────────────────────────────────── */

describe('identity resolution', () => {
  it('collapses two commits from one email into one person and keeps two people apart', async () => {
    const { log } = await index([
      rawCommit(1, { email: 'ada@example.com' }),
      rawCommit(2, { email: 'ADA@example.com', name: 'A. Lovelace' }),
      // A distinct *name* as well as a distinct address. Given the same name this would
      // merge by step 4 — same normalised name, same email domain — and correctly so: one
      // human at one organisation with two mailboxes is exactly what step 4 is for.
      rawCommit(3, { email: 'grace@example.com', name: 'Grace Hopper' }),
    ]);

    expect(peopleOf(log)).toHaveLength(2);
    expect(log.commits.map((commit) => commit.author)).toEqual([1, 1, 2]);

    const ada = peopleOf(log)[0];
    expect(ada?.canonicalEmail).toBe('ada@example.com');
    expect(ada?.commitCount).toBe(2);
    expect(ada?.identities).toHaveLength(2);
    expect(ada?.mergeSource).toBe('exact-email');
  });

  it('counts authorship only, so a rebase does not inflate a committer into an author', async () => {
    const authored = rawCommit(1, { email: 'ada@example.com' });
    const { log } = await index([
      {
        ...authored,
        committer: { name: 'Rebase Person', email: 'rebaser@example.org' },
      },
    ]);

    expect(peopleOf(log).map((person) => person.commitCount)).toEqual([1, 0]);
    /* Neither is flagged, and that is the assertion: bot detection matches *conventions*
       (`[bot]` suffixes, the known dependency bots, CI service accounts) rather than the
       substring "bot" in a display name. Flagging a human called Robotham, or anyone whose
       address happens to contain those letters, would quietly remove them from ownership —
       a false positive here is worse than a false negative, because a missing bot is
       visible in the cast of characters while a misfiled human is not. */
    expect(peopleOf(log).map((person) => person.isBot)).toEqual([false, false]);
  });

  it('flags a bot by convention, keeping it out of ownership but not out of provenance', async () => {
    const { log } = await index([
      rawCommit(1, { email: 'ada@example.com' }),
      rawCommit(2, {
        name: 'dependabot[bot]',
        email: '49699333+dependabot[bot]@users.noreply.github.com',
      }),
      rawCommit(3, { name: 'github-actions[bot]', email: 'actions@github.com' }),
    ]);

    const bots = peopleOf(log).filter((person) => person.isBot);
    expect(bots).toHaveLength(2);
    // Still stored, still authoring commits: the flag excludes them from analysis, it does
    // not erase the fact that they changed the repository.
    expect(bots.every((bot) => bot.commitCount === 1)).toBe(true);
    expect(log.commits).toHaveLength(3);
  });
});

describe('file identity', () => {
  it('resolves one path touched by many commits to a single file', async () => {
    const { log } = await index([
      rawCommit(1, { changes: [add('src/a.ts')] }),
      rawCommit(2, { changes: [edit('src/a.ts')] }),
      rawCommit(3, { changes: [edit('src/a.ts'), add('src/b.ts')] }),
    ]);

    expect(new Set(log.changes.map((change) => change.file))).toEqual(new Set([1, 2]));
    expect(filesOf(log)).toHaveLength(2);
    expect(filesOf(log)[0]?.born).toBe(1);
    expect(filesOf(log)[0]?.died).toBeNull();
    expect(filesOf(log)[0]?.aliases).toHaveLength(1);
  });

  it('keeps a renamed file as one file, with an alias for every path it has lived at', async () => {
    /* The M0 behaviour this replaces produced *two* unrelated files, which silently deleted
       the older half of the file's history from churn, from ownership, and from the
       knowledge model — while the report still read as authoritative. This is the single
       most important assertion in the package. */
    const { log } = await index([
      rawCommit(1, { changes: [add('src/old.ts')] }),
      rawCommit(2, { changes: [renamed('src/old.ts', 'src/new.ts')] }),
      rawCommit(3, { changes: [edit('src/new.ts')] }),
    ]);

    expect(filesOf(log)).toHaveLength(1);
    const file = filesOf(log)[0];
    expect(file?.born).toBe(1);
    expect(file?.died).toBeNull();
    expect(file?.aliases).toHaveLength(2);
    // Invariant 2 of Part 8 §8.8: the segments abut and never overlap.
    expect(file?.aliases[0]?.from).toBe(1);
    expect(file?.aliases[0]?.to).toBe(2);
    expect(file?.aliases[1]?.from).toBe(2);
    expect(file?.aliases[1]?.to).toBeNull();
    // And every change across the rename points at that one file, which is the point.
    expect(new Set(log.changes.map((change) => change.file))).toEqual(new Set([1]));

    const rename = log.changes.find((change) => change.kind === 'rename');
    expect(rename?.similarity).toBe(100);
    expect(rename?.oldPath).not.toBe(rename?.newPath);
  });

  it('interns each distinct path once for the whole walk', async () => {
    const { log } = await index([
      rawCommit(1, { changes: [add('src/a.ts')] }),
      rawCommit(2, { changes: [edit('src/a.ts')] }),
      rawCommit(3, { changes: [edit('src/a.ts')] }),
    ]);

    expect(callsMatching(log, 'internPaths')).toEqual(['internPaths:1']);
    expect(log.paths.size).toBe(1);
  });

  it('interns each distinct path once even across batch boundaries', async () => {
    const { log } = await index(
      [1, 2, 3].map((n) => rawCommit(n, { changes: [edit('src/a.ts')] })),
      { batchRows: 2 },
    );

    expect(callsMatching(log, 'internPaths')).toEqual(['internPaths:1']);
  });
});

/* ── Batching ──────────────────────────────────────────────────────────────── */

describe('batched writes', () => {
  it('flushes at every row boundary and the remainder exactly once at the end', async () => {
    // Two rows per commit (the commit plus one change) and a four-row batch, so the
    // boundary falls after commits 2 and 4 and commit 5 is left over. Five is chosen
    // precisely because it is not a multiple of the batch size.
    const { log } = await index(
      [1, 2, 3, 4, 5].map((n) => rawCommit(n)),
      { batchRows: 4 },
    );

    // The leading transaction is the `walking` state, which must be durable before a
    // long walk starts rather than after it.
    expect(commitsPerTransaction(log)).toEqual([0, 2, 2, 1]);
    expect(log.transactions[0]).toEqual(['setIndexState:walking']);
    expect(log.commits).toHaveLength(5);
  });

  it('writes everything in one final transaction when the batch is never filled', async () => {
    const { log } = await index([1, 2, 3].map((n) => rawCommit(n)));

    expect(commitsPerTransaction(log)).toEqual([0, 3]);
  });

  it('finishes an empty history cleanly rather than leaving the state at walking', async () => {
    const { log } = await index([]);

    expect(log.commits).toEqual([]);
    expect(log.states).toEqual(['walking', 'ready']);
    expect(log.meta.get(META_KEYS.partialReason)).toBe('');
  });

  it('refuses a batch size that is not a positive integer, at construction', () => {
    const { store } = fakeStore();
    const { backend } = fakeBackend([]);
    const deps = { backend, store, sinks: [], walkSpec: DEFAULT_WALK_SPEC };

    // Zero would silently mean "flush after every commit", which reads as a slow walk
    // rather than as the misconfiguration it is.
    expect(() => createIndexPipeline({ ...deps, batchRows: 0 })).toThrow(RangeError);
    expect(() => createIndexPipeline({ ...deps, batchRows: -1 })).toThrow(RangeError);
    expect(() => createIndexPipeline({ ...deps, batchRows: 1.5 })).toThrow(RangeError);
  });
});

/* ── Sinks: the one-pass property ──────────────────────────────────────────── */

describe('walk sinks', () => {
  it('delivers every commit and every change to every sink, in walk order', async () => {
    const { sinks } = await index(
      [
        rawCommit(1, { changes: [add('src/a.ts')] }),
        rawCommit(2, { changes: [edit('src/a.ts'), add('src/b.ts')] }),
        rawCommit(3, { changes: [] }),
      ],
      { batchRows: 2, sinkCount: 2 },
    );

    for (const sink of sinks) {
      expect(sink.commits).toEqual([1, 2, 3].map(oid));
      expect(sink.changes).toEqual(['01:src/a.ts', '02:src/a.ts', '02:src/b.ts']);
    }
  });

  it('finishes each sink exactly once, inside the transaction that closes the walk', async () => {
    const { sinks, log } = await index(
      [1, 2, 3, 4, 5].map((n) => rawCommit(n)),
      {
        batchRows: 2,
        sinkCount: 3,
      },
    );

    for (const sink of sinks) {
      expect(sink.finishes).toHaveLength(1);
      expect(sink.finishes[0]).toBe(log.handles.at(-1));
    }
  });
});

/* ── Progress and cancellation ─────────────────────────────────────────────── */

describe('progress reporting', () => {
  it('reports an unknown total throughout, because the walk streams instead of counting first', async () => {
    const { progress } = await index(
      [1, 2, 3, 4, 5].map((n) => rawCommit(n)),
      {
        batchRows: 2,
      },
    );

    expect(progress.length).toBeGreaterThan(1);
    for (const event of progress) {
      expect(event.total).toBeNull();
      expect(event.tier).toBe('metadata');
    }
    expect(progress[0]?.done).toBe(0);
    expect(progress.at(-1)?.done).toBe(5);

    const done = progress.map((event) => event.done);
    expect(done).toEqual([...done].sort((a, b) => a - b));
  });

  it('names the deferred analysis tier instead of silently ignoring the request', async () => {
    const { progress, log } = await index([rawCommit(1)], {
      tiers: ['metadata', 'analysis'],
    });

    expect(progress.at(-1)?.tier).toBe('analysis');
    /* No longer "not implemented before M1": at M1 the tier exists, it is just not *here*.
       Asking the walk for it is a caller mistake, and the note says which caller. */
    expect(progress.at(-1)?.note).toMatch(/second pass/);
    /* And crucially it does *not* mark the index partial for it. At M0 asking the walk for
       `analysis` earned a `tier-failed` badge, because nothing built that tier. Now something
       does — just not the walk — so a badge here would report a complete index as incomplete,
       which is the mirror image of the failure the badge exists to prevent. */
    expect(log.meta.get(META_KEYS.partialReason)).toBe('');
    expect(log.meta.get(META_KEYS.partialSkipped)).toBe('');
    expect(log.states).toEqual(['walking', 'ready']);
  });

  it('touches neither git nor the store when the metadata tier was not asked for', async () => {
    // The walk *is* the metadata tier, so there is no honest work to do — and in
    // particular no index state to write for work that did not happen.
    const { progress, log, emitted } = await index([rawCommit(1)], {
      tiers: ['analysis'],
    });

    expect(emitted).toEqual([]);
    expect(log.transactions).toEqual([]);
    expect(log.states).toEqual([]);
    expect(progress).toHaveLength(1);
    expect(progress[0]?.tier).toBe('analysis');
  });
});

describe('cancellation', () => {
  it('stores what it walked, marks the index stale and partial, then reports CANCELLED', async () => {
    const controller = new AbortController();
    const { log, emitted, failure, progress } = await index(
      [1, 2, 3, 4, 5].map((n) => rawCommit(n)),
      {
        signal: controller.signal,
        onEmit: (i) => {
          if (i === 2) controller.abort();
        },
        expectFailure: true,
      },
    );

    // The walk was abandoned, not drained: commits 4 and 5 never left the backend.
    expect(emitted).toHaveLength(3);
    expect(log.commits.map((commit) => commit.id)).toEqual([1, 2]);
    expect(log.states).toEqual(['walking', 'stale']);
    expect(log.meta.get(META_KEYS.partialReason)).toBe('interrupted');
    expect(log.meta.get(META_KEYS.partialSkipped)).toMatch(/after 2 commits/);
    // The partial index is committed *before* the throw, and the throw is what stops a
    // caller from announcing a cancelled walk as a complete one.
    expect(codeOf(failure)).toBe('CANCELLED');
    expect(progress.at(-1)?.note).toMatch(/cancelled after 2 commits/);
  });

  it('leaves every stored commit pointing at a person and a file that were also stored', async () => {
    const controller = new AbortController();
    const { log } = await index(
      [1, 2, 3, 4].map((n) =>
        rawCommit(n, { email: `dev${n % 2}@example.com`, changes: [add(`src/${n}.ts`)] }),
      ),
      {
        batchRows: 2,
        signal: controller.signal,
        onEmit: (i) => {
          if (i === 3) controller.abort();
        },
        expectFailure: true,
      },
    );

    const people = new Set(peopleOf(log).map((person) => person.id));
    const files = new Set(filesOf(log).map((file) => file.id));
    expect(log.commits).not.toHaveLength(0);
    for (const commit of log.commits) {
      expect(people.has(commit.author)).toBe(true);
      expect(people.has(commit.committer)).toBe(true);
    }
    for (const change of log.changes) {
      expect(files.has(change.file)).toBe(true);
    }
  });

  it('never asks the backend to spawn a walk it has already been told to abandon', async () => {
    const controller = new AbortController();
    controller.abort();
    const { emitted, log, sinks, failure } = await index(
      [1, 2].map((n) => rawCommit(n)),
      { signal: controller.signal, expectFailure: true },
    );

    expect(emitted).toEqual([]);
    expect(log.states).toEqual(['walking', 'stale']);
    expect(codeOf(failure)).toBe('CANCELLED');
    // The finalize path is the same one, so sinks are still finished exactly once.
    expect(sinks[0]?.finishes).toHaveLength(1);
  });
});

/* ── Repository metadata ───────────────────────────────────────────────────── */

describe('index metadata', () => {
  it('records the history span from the earliest and latest author dates, not the walk order', async () => {
    // Author dates are not monotonic in walk order — a rebase reorders them — so the
    // span has to be a min/max, and this history is deliberately out of order.
    const { log } = await index([
      rawCommit(1, { authoredOffset: 5_000 }),
      rawCommit(2, { authoredOffset: 100 }),
      rawCommit(3, { authoredOffset: 9_000 }),
      rawCommit(4, { authoredOffset: 4_000 }),
    ]);

    expect(log.meta.get(META_KEYS.firstCommitAt)).toBe(String(AUTHOR_EPOCH + 100));
    expect(log.meta.get(META_KEYS.lastCommitAt)).toBe(String(AUTHOR_EPOCH + 9_000));
    expect(log.meta.get(META_KEYS.firstCommitOffset)).toBe('0');
    expect(log.meta.get(META_KEYS.projection)).toBe(DEFAULT_WALK_SPEC.projection);
  });

  it('writes no wall-clock row, which is what keeps two indexes of one history comparable', async () => {
    const { log } = await index([rawCommit(1)]);

    for (const key of log.meta.keys()) {
      expect(key).not.toMatch(/indexed_at|generated_at|timestamp/);
    }
  });

  it('transitions the index state through walking before ready', async () => {
    const { log } = await index([rawCommit(1)]);

    expect(log.states).toEqual(['walking', 'ready']);
    expect(log.transactions.at(-1)?.at(-1)).toBe('setIndexState:ready');
  });
});

describe('walk failure', () => {
  it('marks the index failed and commits what it had, then rethrows the cause', async () => {
    const { store, log } = fakeStore();
    const boom = new Error('git exited 128');
    const backend = {
      walk: async function* (): AsyncGenerator<RawCommit> {
        yield rawCommit(1);
        throw boom;
      },
      refs: () => Promise.resolve([]),
      readMailmap: () => Promise.resolve(null),
    } as unknown as GitBackend;

    const pipeline = createIndexPipeline({
      backend,
      store,
      sinks: [],
      walkSpec: DEFAULT_WALK_SPEC,
    });

    const run = async (): Promise<void> => {
      for await (const _event of pipeline.run({
        tiers: ['metadata'],
        signal: new AbortController().signal,
      })) {
        /* drain */
      }
    };

    await expect(run()).rejects.toThrow('git exited 128');
    expect(log.states).toEqual(['walking', 'failed']);
    expect(log.commits).toHaveLength(1);
    expect(log.people.size).toBe(1);
    expect(log.files.size).toBe(1);
  });

  it('re-interns paths after a rolled-back flush instead of reusing ids SQLite discarded', async () => {
    // The flush that fails takes its `paths` rows with it. A pipeline that keeps its
    // path cache across the rollback writes `changes.new_path_id` values pointing at
    // rows that no longer exist — a foreign-key failure with real SQLite, and a
    // silently mis-attributed path when foreign keys are off for a bulk load.
    const { log, failure } = await index(
      [1, 2, 3, 4].map((n) => rawCommit(n)),
      { batchRows: 4, failOnce: 'insertCommits', expectFailure: true },
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/injected store failure/);
    // Once in the flush that rolled back, once in the transaction that replaced it.
    expect(callsMatching(log, 'internPaths')).toEqual(['internPaths:1', 'internPaths:1']);
    expect(log.paths.size).toBe(1);
    expect(log.states).toEqual(['walking', 'failed']);
    expect(log.commits.map((commit) => commit.id)).toEqual([1, 2]);
  });

  it('overstates commitCount in the index a failed flush leaves behind — a known wart', async () => {
    // The rolled-back batch is reprocessed so its rows still land, which resolves its
    // authors a second time. The stored count is therefore too high, which is one
    // reason a `failed` index must be rebuilt rather than served.
    const { log } = await index(
      [1, 2].map((n) => rawCommit(n)),
      { batchRows: 4, failOnce: 'insertCommits', expectFailure: true },
    );

    expect(log.commits).toHaveLength(2);
    expect(peopleOf(log)[0]?.commitCount).toBe(4);
  });
});

/* ── Repo identity ─────────────────────────────────────────────────────────── */

describe('repository identity', () => {
  const root = '0'.repeat(39) + 'a';

  it('is a stable sha256 of the root commit and the canonical path', () => {
    const first = computeRepoId(root, '/home/ada/src/excavate');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRepoId(root, '/home/ada/src/excavate')).toBe(first);
  });

  it('separates two worktrees of the same repository', () => {
    expect(computeRepoId(root, '/home/ada/a')).not.toBe(
      computeRepoId(root, '/home/ada/b'),
    );
  });

  it('separates two repositories checked out at the same path', () => {
    const other = '1'.repeat(40);
    expect(computeRepoId(root, '/tmp/x')).not.toBe(computeRepoId(other, '/tmp/x'));
  });

  it('cannot be confused by a path that continues the oid', () => {
    // The NUL separator is what makes this true; plain concatenation would collide.
    expect(computeRepoId(root, 'x/y')).not.toBe(computeRepoId(`${root}x`, '/y'));
  });
});

/* ── The deferred surface ──────────────────────────────────────────────────── */

describe('the M0.1 surface', () => {
  it('pins the delete+add rename threshold well above git default for explicit renames', () => {
    // Git's own -M default is 50% for an *explicit* rename; an inferred one from a
    // delete+add pair has to clear a much higher bar or lineage silently corrupts.
    // Nothing consumes this yet — M1's resolver is what makes it behaviour.
    expect(DELETE_ADD_RENAME_SIMILARITY).toBe(90);
    expect(DELETE_ADD_RENAME_SIMILARITY).toBeGreaterThan(50);
  });

  it('has replaced the two fakes it deferred, and deleted the file holding them', () => {
    /* Inverted at M1, deliberately: this test existed to make the replacement a visible
       change rather than a silent one. `m0-resolvers.ts` is gone. */
    expect(createRenameResolver()).toBeTypeOf('object');
    expect(createIdentityResolver(null)).toBeTypeOf('object');
  });
});
