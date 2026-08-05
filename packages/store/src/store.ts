/**
 * `openStore` and the four operations that are not queries: `migrate`, `transaction`,
 * `integrityCheck`, `close`.
 *
 * The whole file rests on one property from Part 9 §9.10 that is worth stating before
 * anything else: **the index is a derived cache and `.git` is the source of truth.**
 * That is why `synchronous` can be relaxed during a bulk load, why foreign keys can be
 * deferred and verified afterwards rather than enforced row by row, and why a corrupt
 * index offers a rebuild (Part 7 §7.7) instead of a repair. Every trade below spends
 * durability we do not need to buy speed we do.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { IndexState, RepoId } from '@excavate/core';
import { ExcavateError, INDEX_STATES } from '@excavate/core';
import BetterSqlite3 from 'better-sqlite3';

import {
  INDEX_STATE_KEY,
  REPO_ID_KEY,
  SCHEMA_VERSION_KEY,
  readMeta,
  readSchemaVersion,
  writeMeta,
} from './meta.js';
import {
  assertMigrationsWellFormed,
  latestSchemaVersion,
  migrations,
} from './migrations/index.js';
import type { Queries } from './queries.js';
import { createQueries } from './queries.js';
import { createTransactionApi } from './writes.js';
import type { IntegrityReport, OpenStoreOptions, Store, Transaction } from './index.js';

/** `better-sqlite3` treats this filename specially; it has no directory to create. */
const IN_MEMORY = ':memory:';

export function openStore(options: OpenStoreOptions): Store {
  if (options.path !== IN_MEMORY) {
    // An index is a directory (Part 9 §9.1) and this package owns the file inside it.
    // Making the caller create it first would mean every caller — daemon, CLI, test —
    // reimplements the same two lines, and one of them would get it wrong.
    mkdirSync(dirname(options.path), { recursive: true });
  }

  const db = new BetterSqlite3(options.path);
  const bulkLoad = options.bulkLoad ?? false;
  let schemaVersion = 0;

  /**
   * `foreign_keys` cannot be changed inside a transaction, so pragmas are applied before
   * any migration runs — and `journal_mode = WAL` is persistent, so it is set here for
   * new files and re-asserted harmlessly for existing ones.
   */
  function applyPragmas(): void {
    // Concurrent readers during indexing is the whole reason for WAL (Part 9 §9.2.1):
    // the UI serves the partial index while the walk is still writing it. An in-memory
    // database silently keeps journal_mode = memory, which is correct for it.
    db.pragma('journal_mode = WAL');
    db.pragma('cache_size = -262144');
    db.pragma('mmap_size = 1073741824');
    db.pragma('temp_store = MEMORY');

    if (bulkLoad) {
      // Bulk load, per Part 9 §9.2.1. `synchronous = OFF` risks the *cache* on an OS
      // crash mid-walk, and a half-written cache is thrown away and rebuilt from `.git`
      // anyway, so the fsync per commit buys nothing. Foreign keys go off because the
      // walk legitimately writes rows before their parents exist: commits reference
      // people whose aggregate rows are only final once the identity resolver finishes.
      // `integrityCheck()` runs `PRAGMA foreign_key_check` afterwards, which is the
      // "verified after" half of that section's advice and is not optional.
      db.pragma('synchronous = OFF');
      db.pragma('foreign_keys = OFF');
    } else {
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = ON');
    }
  }

  function migrate(): void {
    assertMigrationsWellFormed();
    const latest = latestSchemaVersion();
    const current = readSchemaVersion(db);

    if (current > latest) {
      // Part 9 §9.10: refuse rather than mangle. A newer build may have added a column
      // this one does not write, so opening it read-write would produce rows that the
      // newer build then reads as corrupt. "Upgrade Excavate" is a fixable message; a
      // corrupted shared index is not.
      throw new ExcavateError(
        'SCHEMA_TOO_NEW',
        `index at ${options.path} was written by a newer Excavate (schema v${current}); ` +
          `this build understands up to v${latest}. Upgrade Excavate, or delete the ` +
          `index directory to rebuild it.`,
        { details: { path: options.path, found: current, supported: latest } },
      );
    }

    for (const migration of migrations()) {
      if (migration.version <= current) continue;
      try {
        // One transaction per migration: SQLite applies DDL transactionally, so a
        // migration that fails halfway leaves the previous schema version and its data
        // intact, and the next open retries from the same point.
        db.transaction(() => {
          db.exec(migration.up);
          writeMeta(db, SCHEMA_VERSION_KEY, String(migration.version));
        })();
      } catch (cause) {
        throw new ExcavateError(
          'MIGRATION_FAILED',
          `migration ${migration.name} failed: ${describe(cause)}`,
          { cause, details: { migration: migration.name, path: options.path } },
        );
      }
    }

    schemaVersion = readSchemaVersion(db);
  }

  // Everything that can fail while the handle is ours alone happens inside this guard,
  // `createQueries` and `createTransactionApi` included. Both call `db.prepare()` dozens
  // of times, and `prepare()` throws if a statement does not match the schema — which is
  // precisely what a botched migration produces. Leaving those two outside would mean the
  // one failure mode most likely to occur leaks the handle, holding the WAL file and, on
  // Windows, the database file itself, against a caller whose recovery is to delete the
  // index directory and rebuild.
  const { tx, queries } = ((): { tx: Transaction; queries: Queries } => {
    try {
      applyPragmas();
      migrate();
      // The repo id is claimed on first open and never overwritten: rewriting it would
      // turn "this index belongs to another repository" into a silently wrong answer.
      if (readMeta(db, REPO_ID_KEY) === null) {
        writeMeta(db, REPO_ID_KEY, options.repoId);
      }
      return { tx: createTransactionApi(db), queries: createQueries(db) };
    } catch (error) {
      db.close();
      throw error;
    }
  })();

  return {
    repoId: options.repoId,
    path: options.path,
    get schemaVersion(): number {
      return schemaVersion;
    },

    migrate,

    transaction<T>(fn: (fnTx: Transaction) => T): T {
      // `better-sqlite3` wraps the call in BEGIN/COMMIT and, on a throw, ROLLBACK
      // followed by a re-throw of the original error — which is exactly the contract
      // Part 7 §7.7 needs ("transaction rolls back, prior index remains valid and
      // usable"), so reimplementing it here would only add ways to get it wrong. It also
      // nests through savepoints, so a transaction inside a transaction is safe.
      return db.transaction(fn)(tx);
    },

    integrityCheck(): IntegrityReport {
      return checkIntegrity(db, options.repoId);
    },

    close(): void {
      if (!db.open) return;
      try {
        // SQLite's own recommendation before closing a long-lived connection: it refreshes
        // the stale statistics that make the planner pick the wrong index after a large
        // load. Cheap, and the alternative is a store that gets slower the longer it lives.
        //
        // Best-effort, and in a `try` because `optimize` may run `ANALYZE`, which *writes*
        // — so it can raise `SQLITE_BUSY` against a concurrent walk. Letting that escape
        // would skip `db.close()` and leak the handle along with its WAL file, trading a
        // missing statistics refresh for the one thing `close()` exists to guarantee.
        db.pragma('optimize');
      } catch {
        // Nothing to report: the statistics are a hint, and the caller asked to close.
      } finally {
        db.close();
      }
    },

    commits: queries.commits,
    files: queries.files,
    people: queries.people,
    rollups: queries.rollups,
    search: queries.search,
    bundles: queries.bundles,

    meta: {
      get(key: string): string | null {
        return readMeta(db, key);
      },

      /**
       * An unrecognised value is reported as `null` rather than passed through. The caller
       * uses this to decide whether an index can be trusted, so a state it cannot
       * interpret has to read as "no usable answer" — returning the raw string would let a
       * future state name written by a newer build flow into a comparison that silently
       * takes the wrong branch.
       */
      indexState(): IndexState | null {
        const raw = readMeta(db, INDEX_STATE_KEY);
        return raw !== null && (INDEX_STATES as readonly string[]).includes(raw)
          ? (raw as IndexState)
          : null;
      },
    },
  };
}

/**
 * The check behind Part 7 §7.7 — "index corrupted: detect via integrity check on open,
 * offer a one-click rebuild".
 *
 * Deliberately *not* invoked from `openStore`. `PRAGMA integrity_check` reads every page
 * in the database, which is seconds on the ~130 MB index a 100k-commit repository
 * produces (Part 9 §9.4), and paying that on every `excavate open` would trade the thing
 * the product is judged on — how fast reopening a repo feels — for a check that matters
 * after a crash. The daemon calls it on open of an index it has reason to distrust, and
 * `excavate doctor` calls it on demand.
 *
 * Four separate checks, because they fail for genuinely different reasons and a single
 * boolean would tell the user nothing about which:
 *
 * 1. `PRAGMA integrity_check` — physical damage: a torn page, a b-tree that disagrees
 *    with its table, an index entry pointing at a row that is not there.
 * 2. `PRAGMA foreign_key_check` — the other half of the bulk-load bargain. With
 *    `foreign_keys = OFF` during the walk, this is the only thing standing between a
 *    dangling `author_id` and a `Commit` that cannot be read back.
 * 3. FTS5's own `integrity-check` — `PRAGMA integrity_check` knows nothing about the
 *    inside of a virtual table, so a desynchronised search index passes it silently and
 *    then either returns commits that no longer exist or, worse, omits commits that do.
 * 4. Schema version and repo id — not corruption in SQLite's sense, but both make every
 *    answer the store gives wrong, which is the same thing from the user's side.
 *
 * Problems are strings because they are shown to a human next to a rebuild button, not
 * branched on. Codes would imply the caller has a distinct recovery per problem; it has
 * exactly one, and it always works.
 *
 * **Throws `CANCELLED` rather than returning a report if a check could not be run at all**
 * — see `check()` below. `ok: false` prompts the user to throw away an index and rebuild
 * it, so it must never be reachable from "the walk happened to hold the write lock".
 */
function checkIntegrity(db: BetterSqlite3.Database, repoId: RepoId): IntegrityReport {
  const problems: string[] = [];

  /**
   * Every check runs through here, which decides between the only two honest outcomes for
   * a check that raised: *this index is damaged* and *I could not tell*.
   *
   * A genuine error becomes a `problem`, because a check that throws would otherwise abort
   * the report and take the remaining checks with it — and `SQLITE_CORRUPT` out of a bare
   * `PRAGMA` is exactly what the sickest databases do. A doctor that crashes on its worst
   * patients is useless; the caller's recovery is reached through `ok: false`.
   *
   * A lock conflict is rethrown instead, and that distinction is the whole reason this
   * function exists. FTS5's `integrity-check` is an `INSERT`, so it needs the write lock,
   * so it raises `SQLITE_BUSY` whenever the indexer is mid-batch — which under WAL is
   * routine, since serving the partial index while the walk writes is the reason WAL is on
   * at all. Folding that into `problems` would report a perfectly healthy 100k-commit index
   * as corrupt and offer to rebuild it, which is the worst failure this package can have:
   * confidently wrong, in the direction that destroys work. `ok: false` has to keep meaning
   * "something is actually wrong", so "ask me again when the walk is finished" leaves by a
   * different door.
   */
  function check(name: string, problem: string, run: () => void): void {
    try {
      run();
    } catch (cause) {
      const code = sqliteCode(cause);
      if (code !== null && UNDETERMINABLE.has(code)) {
        throw new ExcavateError(
          'CANCELLED',
          `${name} could not be run: another connection holds the write lock (${code}). ` +
            `This says nothing about whether the index is healthy — retry once indexing ` +
            `has finished.`,
          { cause, details: { check: name, sqlite: code, path: db.name } },
        );
      }
      problems.push(`${problem}: ${describe(cause)}`);
    }
  }

  // Runs first for one reason: it is the only check that writes, so it is the only one that
  // can raise `SQLITE_BUSY`, and a locked database should give up here rather than after
  // reading every page of a 130 MB file. If it reports damage instead, the checks below
  // still run and the report names everything at once.
  //
  // `rank = 1` is load-bearing, and this is measured rather than assumed. Against SQLite
  // 3.53.4, for all three ways an external-content FTS index can drift — a stale entry for
  // a deleted commit, a *missing* entry for a commit that was never indexed, and a subject
  // edited without the update trigger — the bare `integrity-check` and the `rank = 0` form
  // both report success, and only `rank = 1` raises. The missing-entry case is the
  // dangerous one: `search.commits` joins through the index, so an unindexed commit is
  // silently absent from every search result and nothing else notices. The argument form
  // needs SQLite 3.41+, which `better-sqlite3` 13 bundles.
  check(
    'the full-text index check',
    'full-text index is out of step with the commits table',
    () => {
      db.prepare<[]>(
        "INSERT INTO commits_fts(commits_fts, rank) VALUES('integrity-check', 1)",
      ).run();
    },
  );

  check('the physical integrity check', 'integrity check could not be completed', () => {
    for (const row of db.pragma('integrity_check') as readonly {
      integrity_check: string;
    }[]) {
      if (row.integrity_check !== 'ok') problems.push(row.integrity_check);
    }
  });

  check('the foreign key check', 'foreign key check could not be completed', () => {
    const violations = db.pragma('foreign_key_check') as readonly {
      table: string;
      rowid: number | null;
      parent: string;
    }[];
    for (const violation of violations.slice(0, MAX_REPORTED_VIOLATIONS)) {
      problems.push(
        `foreign key violation: ${violation.table} row ${violation.rowid ?? '?'} ` +
          `references a missing ${violation.parent}`,
      );
    }
    if (violations.length > MAX_REPORTED_VIOLATIONS) {
      problems.push(
        `and ${violations.length - MAX_REPORTED_VIOLATIONS} further foreign key violations`,
      );
    }
  });

  // Through `check()` because `readSchemaVersion` now refuses to coerce an unreadable
  // ledger to 0, and a report is exactly what the caller needs when that is what is wrong.
  // `schemaVersion` stays 0 in that case, which is honest: we do not know what it is.
  let schemaVersion = 0;
  check('the schema version read', 'schema version is unreadable', () => {
    schemaVersion = readSchemaVersion(db);
    const latest = latestSchemaVersion();
    if (schemaVersion !== latest) {
      problems.push(`schema version is ${schemaVersion}, expected ${latest}`);
    }
  });

  check('the repository id read', 'repository id is unreadable', () => {
    const storedRepoId = readMeta(db, REPO_ID_KEY);
    if (storedRepoId !== null && storedRepoId !== repoId) {
      problems.push(
        `index was built for repository ${storedRepoId} but was opened as ${repoId}`,
      );
    }
  });

  return { ok: problems.length === 0, schemaVersion, problems };
}

/** Enough to diagnose a systematic break; a full list of a million dangling rows helps nobody. */
const MAX_REPORTED_VIOLATIONS = 10;

/**
 * SQLite result codes that mean "come back later", never "your data is wrong".
 *
 * `SQLITE_BUSY_SNAPSHOT` deserves its own note because it arrives *instantly* rather than
 * after the busy timeout, and it is easy to hit for real: a caller that reads inside
 * `store.transaction()` takes a WAL read snapshot, and if the indexer commits before the
 * FTS check runs, the write cannot be upgraded and waiting could never help.
 */
const UNDETERMINABLE: ReadonlySet<string> = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE',
  'SQLITE_INTERRUPT',
]);

/** `better-sqlite3` puts the extended result code on `SqliteError.code` as a string. */
function sqliteCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
