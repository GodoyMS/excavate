/**
 * The `meta` table's keys and accessors.
 *
 * Keys are string constants rather than inline literals because two of them are read by
 * code that must agree exactly — `schema_version` is written by `migrate()` and read by
 * both `openStore`'s version gate and `integrityCheck()`, and a typo in any one of those
 * places produces a database that migrates fine and then reports itself corrupt.
 *
 * `meta` is also the reason `Transaction.setMeta` exists as a general escape hatch: Part
 * 9 §9.5 needs `analyzer_versions` and a ref snapshot to decide between serving, an
 * incremental walk and a rebuild, and those arrive milestone by milestone. A key-value
 * table absorbs that without a migration each time.
 */

import { ExcavateError } from '@wise-excavate/core';
import type BetterSqlite3 from 'better-sqlite3';

/** Written by `migrate()`; the sole migration ledger (Part 9 §9.10). */
export const SCHEMA_VERSION_KEY = 'schema_version';

/**
 * `hash(root_commit_oid + canonical_path)`, per Part 7 §7.5. Recorded so that an index
 * found at a path can prove it belongs to the repository being opened rather than
 * silently answering questions about a different one.
 */
export const REPO_ID_KEY = 'repo_id';

/** The indexing state machine of Part 8 §8.6.1, as last persisted by the walk. */
export const INDEX_STATE_KEY = 'index_state';

export function readMeta(db: BetterSqlite3.Database, key: string): string | null {
  if (!hasTable(db, 'meta')) return null;
  const value = db
    .prepare<[string], string>('SELECT value FROM meta WHERE key = ?')
    .pluck()
    .get(key);
  return value ?? null;
}

export function writeMeta(db: BetterSqlite3.Database, key: string, value: string): void {
  db.prepare<[string, string]>(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * A database with no `meta` table, or no `schema_version` row in it, is at version 0 —
 * either brand new, or created by a build predating the table. Both mean "run every
 * migration", which is why an absent value is read as a value rather than an error.
 *
 * A value that is *present but unreadable* is the opposite case and must not be folded
 * into the same 0. Coercing it would make `migrate()` re-run `0001` against a populated
 * database and fail on `CREATE TABLE meta`, reporting "table meta already exists" — an
 * error that points at the migration rather than at the one row that is actually wrong.
 * More importantly, silently reading a damaged ledger as "unmigrated" is the store
 * guessing about its own contents, and `schema_version` is the fact every other answer
 * depends on.
 *
 * @throws {ExcavateError} `INDEX_CORRUPT` if `schema_version` is not a non-negative
 *   decimal integer.
 */
export function readSchemaVersion(db: BetterSqlite3.Database): number {
  const raw = readMeta(db, SCHEMA_VERSION_KEY);
  if (raw === null) return 0;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new ExcavateError(
      'INDEX_CORRUPT',
      `meta.${SCHEMA_VERSION_KEY} holds ${JSON.stringify(raw)}, which is not a schema ` +
        `version. The index cannot say what shape it is in; delete the index directory ` +
        `to rebuild it.`,
      { details: { key: SCHEMA_VERSION_KEY, found: raw } },
    );
  }
  return version;
}

export function hasTable(db: BetterSqlite3.Database, name: string): boolean {
  const found = db
    .prepare<[string], string>(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?`,
    )
    .pluck()
    .get(name);
  return found !== undefined;
}
