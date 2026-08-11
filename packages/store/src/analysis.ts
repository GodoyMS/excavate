/**
 * The read and write surface the analysis tier needs.
 *
 * **Why a streaming scan rather than per-file queries.** Every M1 analyzer is a fold over the
 * same join — `changes` against `commits` — and the natural-looking shape ("for each file,
 * query its changes") is `O(files)` round trips, which on `rust-analyzer` is 23,000 prepared
 * statement executions to compute what one ordered scan answers. Part 8 §8.7's whole point is
 * that these are materialised once during indexing, so the scan runs once and the analyzers
 * accumulate in memory.
 *
 * Boundary rule B2 is why this lives here at all: the analyzers describe *what* they need, and
 * the SQL that gets it stays inside the store.
 */

import type {
  AnalyzerId,
  ChangeKind,
  CommitFlag,
  CommitId,
  FileId,
  Oid,
  PathId,
  PersonId,
  Timestamp,
} from '@wise-excavate/core';
import type BetterSqlite3 from 'better-sqlite3';

import { decodeChangeKind, decodeCommitFlags, NON_SOURCE_FILE_MASK } from './codec.js';

/** One commit, with the aggregates significance needs, in walk order. */
export interface CommitFact {
  readonly id: CommitId;
  readonly oid: Oid;
  readonly author: PersonId;
  readonly authoredAt: Timestamp;
  readonly subject: string;
  readonly body: string | null;
  readonly trailerCount: number;
  readonly flags: readonly CommitFlag[];
  readonly parentCount: number;
}

/** One change row, joined to the commit that made it. */
export interface ChangeFact {
  readonly commit: CommitId;
  readonly file: FileId;
  readonly kind: ChangeKind;
  readonly pathId: PathId | null;
  readonly insertions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
}

export interface KnowledgeWrite {
  readonly file: FileId;
  readonly person: PersonId;
  readonly accumulated: number;
  readonly lastAt: Timestamp;
  readonly commits: number;
}

export interface OwnershipWrite {
  readonly file: FileId;
  readonly topPerson: PersonId | null;
  readonly topShare: number;
  readonly busFactor: number;
  readonly entropy: number;
  readonly isIsland: boolean;
  readonly contributors: number;
}

export interface HotspotWrite {
  readonly file: FileId;
  readonly score: number;
  readonly churn: number;
  readonly complexity: number;
  readonly recency: number;
  readonly fixDensity: number;
  readonly changeCount: number;
  readonly totalChurn: number;
}

export interface AnalysisQueries {
  /** Every commit, ascending by dense id — which is topological (parents first). */
  commits(): Iterable<CommitFact>;
  /** Every change, grouped by commit in the same order. */
  changes(): Iterable<ChangeFact>;
  /** `PathId` → path, for the path-shape signals (rarity, manifests, top-level directories). */
  paths(): ReadonlyMap<PathId, string>;
  /** Commit ids that a version-shaped tag points at, for the `isRelease` reward. */
  releaseCommits(): ReadonlySet<CommitId>;
  /**
   * Files flagged generated or vendored — lockfiles, build output, `node_modules`.
   *
   * They belong in the index (a lockfile change is how you know a dependency moved) but never
   * in a *file* ranking: Part 8 §8.5.3's stated failure mode is a lockfile appearing as the
   * repository's top file, and it has 400,000 lines of churn to get there with.
   */
  nonSourceFiles(): readonly FileId[];
  /** The version an analyzer last ran at, or `null` if it never has. */
  lastRun(
    analyzer: AnalyzerId,
  ): { readonly version: number; readonly throughOid: string } | null;
}

export function createAnalysisQueries(db: BetterSqlite3.Database): AnalysisQueries {
  return {
    *commits(): Iterable<CommitFact> {
      /* `iterate` rather than `all`: a 200,000-commit repository would otherwise materialise
         every row as a JS object before the first one is examined, and the peak memory of the
         analysis tier would exceed that of the walk it follows. */
      const statement = db.prepare(`
        SELECT c.id, c.oid, c.author_id, c.authored_at, c.authored_tz,
               c.subject, c.body, c.trailers, c.flags,
               (SELECT COUNT(*) FROM commit_parents p WHERE p.child_id = c.id) AS parent_count
        FROM commits c
        ORDER BY c.id
      `);
      for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
        const trailers = row['trailers'];
        yield {
          id: row['id'] as CommitId,
          oid: row['oid'] as Oid,
          author: row['author_id'] as PersonId,
          authoredAt: {
            epochSeconds: row['authored_at'] as number,
            offsetMinutes: row['authored_tz'] as number,
          },
          subject: row['subject'] as string,
          body: (row['body'] as string | null) ?? null,
          // Only the count is needed — message quality asks "is this linked to anything",
          // not which trailer it is — and parsing the JSON per commit would cost more than
          // the whole rest of the scan.
          trailerCount: countTrailers(typeof trailers === 'string' ? trailers : '[]'),
          flags: decodeCommitFlags(row['flags'] as number),
          parentCount: row['parent_count'] as number,
        };
      }
    },

    *changes(): Iterable<ChangeFact> {
      const statement = db.prepare(`
        SELECT commit_id, file_id, kind, new_path_id, old_path_id,
               insertions, deletions, is_binary
        FROM changes
        ORDER BY commit_id
      `);
      for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
        yield {
          commit: row['commit_id'] as CommitId,
          file: row['file_id'] as FileId,
          kind: decodeChangeKind(row['kind'] as number),
          pathId: ((row['new_path_id'] ?? row['old_path_id']) as PathId | null) ?? null,
          insertions: row['insertions'] as number,
          deletions: row['deletions'] as number,
          isBinary: (row['is_binary'] as number) === 1,
        };
      }
    },

    paths(): ReadonlyMap<PathId, string> {
      const rows = db.prepare('SELECT id, path FROM paths').all() as {
        id: number;
        path: string;
      }[];
      return new Map(rows.map((row) => [row.id as PathId, row.path]));
    },

    releaseCommits(): ReadonlySet<CommitId> {
      /* Version-shaped tags only. A repository tags all sorts of things — `nightly`,
         `latest`, a personal bookmark — and rewarding every tag would make the significance
         list a list of whatever the maintainer bookmarked. `Release` proper is inferred from
         tags that parse as versions (Part 8 §8.2.4); this is that rule, applied in SQL. */
      const rows = db
        .prepare(
          `SELECT target_id FROM tags
           WHERE name GLOB 'v[0-9]*' OR name GLOB '[0-9]*.[0-9]*'`,
        )
        .all() as { target_id: number }[];
      return new Set(rows.map((row) => row.target_id as CommitId));
    },

    nonSourceFiles(): readonly FileId[] {
      /* The mask comes from `codec.ts` rather than a literal, so reordering the flag bits
         cannot silently stop this matching. Filtering in SQL keeps it one scan instead of
         decoding every row into JS. */
      const rows = db
        .prepare(`SELECT id FROM files WHERE (flags & ${NON_SOURCE_FILE_MASK}) != 0`)
        .all() as { id: number }[];
      return rows.map((row) => row.id as FileId);
    },

    lastRun(analyzer) {
      const row = db
        .prepare('SELECT version, through_oid FROM analyzer_runs WHERE analyzer_id = ?')
        .get(analyzer) as { version: number; through_oid: string } | undefined;
      return row === undefined
        ? null
        : { version: row.version, throughOid: row.through_oid };
    },
  };
}

/** Trailer count without paying to parse the JSON into objects. */
function countTrailers(json: string): number {
  if (json === '' || json === '[]') return 0;
  let count = 0;
  for (let i = 0; i < json.length; i += 1) {
    if (json[i] === '{') count += 1;
  }
  return count;
}
