/**
 * Read queries.
 *
 * Every statement is prepared once, when the store opens, and reused for the life of
 * the connection. `better-sqlite3` compiles SQL during `prepare()`; preparing inside a
 * query method pays that cost on every call, and is a large part of why "SQLite is
 * slow" benchmarks usually are.
 *
 * Two patterns recur and are worth naming:
 *
 * - **No N+1.** A page of 100 commits fetches its parent edges in *one* statement,
 *   using `json_each()` over a JSON array of ids. The alternative — a parents query per
 *   row — is 101 round trips for one page, which is how a store ends up slower than
 *   the file it replaced.
 * - **Deterministic order everywhere.** Every `ORDER BY` is total, tie-broken down to a
 *   unique column. Part 8 §8.8 invariant 13 requires re-indexing to produce identical
 *   derived output, and a query whose row order is arbitrary when two sort keys tie
 *   makes that untestable.
 *
 * Queries scoped to later milestones stay `NotImplementedError` carrying the milestone
 * that fills them in, so a premature caller fails with a schedule rather than a `null`
 * it will misread as "no data".
 */

import type {
  BundleHash,
  Change,
  Commit,
  CommitId,
  Coupling,
  Era,
  EvidenceBundle,
  FileEntity,
  FileId,
  PersonId,
  Hotspot,
  Hunk,
  Ownership,
  PathId,
  Release,
  RevertPair,
} from '@wise-excavate/core';
import {
  ExcavateError,
  NotImplementedError,
  commitId,
  fileId,
} from '@wise-excavate/core';
import type BetterSqlite3 from 'better-sqlite3';

import type {
  ChangeRow,
  CommitRow,
  FileAliasRow,
  FileRow,
  IdentityRow,
  PersonRow,
} from './codec.js';
import { decodeHunkKind, toChange, toCommit, toFileEntity, toPerson } from './codec.js';
import { decodeCommitCursor, encodeCommitCursor } from './cursor.js';
import type {
  BundleCache,
  CommitQueries,
  FileQueries,
  Page,
  PageRequest,
  PersonQueries,
  RollupQueries,
  SearchQueries,
  TimelineBucket,
} from './index.js';

/**
 * Listed once and joined two ways, because the search query needs them qualified. A
 * `SELECT *` would be shorter and would silently start returning a column added by a
 * later migration into a `CommitRow` that has no field for it.
 */
const COMMIT_FIELDS = [
  'id',
  'oid',
  'tree_oid',
  'author_id',
  'committer_id',
  'authored_at',
  'authored_tz',
  'committed_at',
  'committed_tz',
  'subject',
  'body',
  'trailers',
  'generation',
  'flags',
  'significance',
] as const;

const COMMIT_COLUMNS = COMMIT_FIELDS.join(', ');
const COMMIT_COLUMNS_QUALIFIED = COMMIT_FIELDS.map((field) => `c.${field}`).join(', ');

const CHANGE_COLUMNS =
  'commit_id, file_id, kind, old_path_id, new_path_id, similarity, ' +
  'insertions, deletions, is_binary';

const FILE_FIELDS = [
  'id',
  'current_path',
  'born_commit',
  'died_commit',
  'language',
  'flags',
] as const;
const FILE_COLUMNS = FILE_FIELDS.join(', ');
/* Qualified, for the two path lookups that join `files` to `paths` — both tables have an `id`
   and SQLite rejects the ambiguity rather than guessing. Derived from one list so the qualified
   and unqualified forms cannot drift, which is the same reason `COMMIT_COLUMNS_QUALIFIED` exists. */
const FILE_COLUMNS_QUALIFIED = FILE_FIELDS.map((field) => `f.${field}`).join(', ');

const PERSON_COLUMNS =
  'id, canonical_name, canonical_email, first_seen, first_seen_tz, ' +
  'last_seen, last_seen_tz, commit_count, merge_source, is_bot';

/** Newest first, tie-broken by descending id — exactly the order `idx_commits_time` stores. */
const COMMIT_ORDER = 'ORDER BY committed_at DESC, id DESC';

/**
 * The keyset predicate, as a **row-value comparison** rather than the equivalent
 * `committed_at < ? OR (committed_at = ? AND id < ?)`.
 *
 * The two are logically identical and the OR form is what most keyset-pagination advice
 * shows, but SQLite plans them completely differently, and the difference is the entire
 * point of using a cursor:
 *
 * ```
 * OR form:        SCAN   commits USING INDEX idx_commits_time
 * row-value form: SEARCH commits USING INDEX idx_commits_time (committed_at<?)
 * ```
 *
 * `SCAN` means SQLite walks the index from the newest entry and evaluates the predicate
 * on every row until `LIMIT` is satisfied — so a deep page re-walks everything above it
 * and the cursor degenerates into `OFFSET` with extra steps. Measured on 300k commits:
 * 0.014ms for the first page and **11ms** for the last, growing with history. The
 * row-value form seeks straight to the cursor and is flat at 0.013ms either way.
 *
 * Note that `SCAN … USING INDEX x` and `SEARCH … USING INDEX x` both mention the index
 * name, which is why the plan test asserts on the verb and not just on the name — the
 * original test passed against the OR form.
 *
 * Row values need SQLite 3.15+ (2016); `better-sqlite3` 13 bundles 3.53.4.
 */
const COMMIT_KEYSET = '(committed_at, id) < (?, ?)';

/**
 * The statements whose *query plan* is load-bearing rather than merely correct, exported so
 * the plan tests can `EXPLAIN QUERY PLAN` the exact text `createQueries` prepares.
 *
 * Not a stylistic preference. These four are the ones where a wrong plan changes the cost
 * class without changing a single answer, so no behavioural test can see it — and the
 * previous version of these tests EXPLAINed a hand-retyped paraphrase and therefore
 * certified the paraphrase while the real keyset statement was doing a full index scan.
 *
 * @internal
 */
export const HOT_SQL = {
  firstPage: `SELECT ${COMMIT_COLUMNS} FROM commits ${COMMIT_ORDER} LIMIT ?`,
  nextPage: `SELECT ${COMMIT_COLUMNS} FROM commits WHERE ${COMMIT_KEYSET} ${COMMIT_ORDER} LIMIT ?`,
  changesIn: `SELECT ${CHANGE_COLUMNS} FROM changes WHERE commit_id = ? ORDER BY file_id`,
  // One statement for a whole page's parent edges, hence `json_each` over an array of ids
  // rather than a query per row. The plan must stay a per-id primary-key seek: a scan of
  // `commit_parents` would make every page cost the size of the whole graph.
  parentsOf: `SELECT child_id, parent_id FROM commit_parents
     WHERE child_id IN (SELECT value FROM json_each(?))
     ORDER BY child_id, ordinal`,
} as const;

export interface Queries {
  readonly commits: CommitQueries;
  readonly files: FileQueries;
  readonly people: PersonQueries;
  readonly rollups: RollupQueries;
  readonly search: SearchQueries;
  readonly bundles: BundleCache;
}

/** A `hunks` row. NULL on the side that does not exist — see `insertHunks` on why not zero. */
interface HunkRow {
  readonly commit_id: number;
  readonly file_id: number;
  readonly old_start: number | null;
  readonly old_len: number | null;
  readonly new_start: number | null;
  readonly new_len: number | null;
  readonly kind: number;
}

/**
 * Rehydrate a hunk, turning the stored NULLs back into the zero-length form the domain uses.
 *
 * The asymmetry is deliberate and is documented at both ends: the *column* is NULL because "no
 * position" is not position zero and an overlap query must not match it, while the *entity*
 * carries `oldLen: 0` because a consumer computing a range wants arithmetic, not a null check.
 */
function hunkRow(row: HunkRow): Hunk {
  return {
    commit: commitId(row.commit_id),
    file: fileId(row.file_id),
    oldStart: row.old_start ?? 0,
    oldLen: row.old_len ?? 0,
    newStart: row.new_start ?? 0,
    newLen: row.new_len ?? 0,
    kind: decodeHunkKind(row.kind),
  };
}

export function createQueries(db: BetterSqlite3.Database): Queries {
  const selectCommitByOid = db.prepare<[string], CommitRow>(
    `SELECT ${COMMIT_COLUMNS} FROM commits WHERE oid = ?`,
  );
  const selectCommitById = db.prepare<[number], CommitRow>(
    `SELECT ${COMMIT_COLUMNS} FROM commits WHERE id = ?`,
  );
  const selectFirstPage = db.prepare<[number], CommitRow>(HOT_SQL.firstPage);
  // The strict comparison excludes the cursor row itself, which is what makes the walk
  // gap-free and duplicate-free even when many commits share one second — and they do:
  // a scripted migration commits fifty times in the same second.
  const selectNextPage = db.prepare<[number, number, number], CommitRow>(
    HOT_SQL.nextPage,
  );
  const countCommits = db.prepare<[], number>('SELECT count(*) FROM commits').pluck();
  const selectParentsOf = db.prepare<[string], { child_id: number; parent_id: number }>(
    HOT_SQL.parentsOf,
  );
  const selectChangesIn = db.prepare<[number], ChangeRow>(HOT_SQL.changesIn);

  /**
   * Hunk geometry for one file in one commit, in file order.
   *
   * Ordered by the new-side position so a reader walks the file top to bottom, with the old side
   * as the tie-break for a hunk that only deletes (its `new_start` is NULL, and NULLs sort first
   * in SQLite, which puts pure deletions before the additions they sit among — acceptable, and
   * stable, which is what a snapshot test needs).
   */
  const selectHunksIn = db.prepare<[number, number], HunkRow>(
    `SELECT commit_id, file_id, old_start, old_len, new_start, new_len, kind
       FROM hunks WHERE commit_id = ? AND file_id = ?
      ORDER BY new_start, old_start`,
  );

  /**
   * Every commit whose hunks overlap a line range in one file — **blame's pre-filter**.
   *
   * This is the query the `hunks` table exists for. Part 9's blame strategy is to consult only
   * the commits that could possibly have touched the lines in question rather than blaming a
   * whole file and discarding the rest, and "could possibly have touched" is exactly this
   * overlap test. On a 3,000-line file with 400 commits it turns a full blame into a handful.
   *
   * The overlap condition is the standard half-open one, written on the *new* side because that
   * is the geometry a reader's line numbers refer to: two ranges intersect when each starts
   * before the other ends. Hunks with a NULL `new_start` are pure deletions — they removed lines
   * that are no longer there to ask about — and are excluded, because a range in the current
   * file cannot overlap lines that the commit deleted.
   *
   * Newest first, because the most recent commit to touch a line is the one a reader wants
   * first, and a caller that only needs "who last changed this" can stop after one row.
   */
  const selectTouching = db.prepare<[number, number, number], { commit_id: number }>(
    `SELECT DISTINCT commit_id FROM hunks
       WHERE file_id = ?
         AND new_start IS NOT NULL
         AND new_start <= ?
         AND new_start + new_len > ?
       ORDER BY commit_id DESC`,
  );

  const selectMostSignificant = db.prepare<[number], CommitRow>(
    `SELECT ${COMMIT_COLUMNS} FROM commits ORDER BY significance DESC, id DESC LIMIT ?`,
  );
  const generationOf = db
    .prepare<[number], number>('SELECT generation FROM commits WHERE id = ?')
    .pluck();
  /**
   * Ancestry by walking parent edges upward from the descendant.
   *
   * Bounded by `generation`: the recursion never visits a commit older than the candidate
   * ancestor, which on a long history is the difference between touching a handful of rows and
   * touching all of them. `commit_parents` is keyed `(child_id, ordinal)`, so each hop is an
   * index seek rather than a scan.
   */
  const isAncestorOf = db
    .prepare<[number, number, number], number>(
      `WITH RECURSIVE up(id) AS (
         SELECT ?
         UNION
         SELECT p.parent_id FROM commit_parents p
           JOIN up ON up.id = p.child_id
           JOIN commits c ON c.id = p.parent_id
          WHERE c.generation >= (SELECT generation FROM commits WHERE id = ?)
       )
       SELECT EXISTS(SELECT 1 FROM up WHERE id = ?)`,
    )
    .pluck();

  const selectFileById = db.prepare<[number], FileRow>(
    `SELECT ${FILE_COLUMNS} FROM files WHERE id = ?`,
  );
  const selectAliasesOf = db.prepare<[number], FileAliasRow>(
    `SELECT file_id, path_id, from_commit, to_commit FROM file_aliases
     WHERE file_id = ? ORDER BY from_commit`,
  );
  const selectPath = db
    .prepare<[number], string>('SELECT path FROM paths WHERE id = ?')
    .pluck();
  const countFiles = db.prepare<[], number>('SELECT count(*) FROM files').pluck();
  const selectFileByCurrentPath = db.prepare<[string], FileRow>(
    `SELECT ${FILE_COLUMNS_QUALIFIED} FROM files f
       JOIN paths p ON p.id = f.current_path
      WHERE p.path = ?`,
  );
  /* Through the alias chain, and the half-open window is why: an alias covers `[from, to)`, so
     a commit exactly at `to` belongs to the *next* segment. Using `<=` here would make a
     renamed file resolve to two identities at the rename commit itself, breaking Part 8 §8.8's
     first invariant at precisely the commit most likely to be queried. */
  const selectFileByPathAt = db.prepare<[string, number, number], FileRow>(
    `SELECT ${FILE_COLUMNS_QUALIFIED} FROM files f
       JOIN file_aliases a ON a.file_id = f.id
       JOIN paths p ON p.id = a.path_id
      WHERE p.path = ? AND a.from_commit <= ? AND (a.to_commit IS NULL OR a.to_commit > ?)
      LIMIT 1`,
  );
  const selectChangesTo = db.prepare<[number], ChangeRow>(
    `SELECT ${CHANGE_COLUMNS} FROM changes WHERE file_id = ? ORDER BY commit_id`,
  );

  const selectOwnership = db.prepare<
    [number],
    {
      top_person: number | null;
      top_share: number;
      bus_factor: number;
      entropy: number;
      is_island: number;
    }
  >(
    `SELECT top_person, top_share, bus_factor, entropy, is_island
       FROM ownership WHERE file_id = ?`,
  );
  /* Shares are recomputed from `knowledge` rather than stored per person: the ownership row
     holds the *summary* (top share, bus factor, entropy) and the distribution is derivable, so
     storing both would be two representations of one fact that can disagree. */
  const selectShares = db.prepare<[number, number], { person_id: number; share: number }>(
    `SELECT k.person_id,
            k.accumulated / (SELECT SUM(accumulated) FROM knowledge WHERE file_id = ?) AS share
       FROM knowledge k
      WHERE k.file_id = ?
      ORDER BY share DESC, k.person_id`,
  );
  const selectHotspots = db.prepare<
    [number],
    {
      file_id: number;
      score: number;
      churn: number;
      complexity: number;
      recency: number;
      fix_density: number;
      change_count: number;
    }
  >(
    `SELECT file_id, score, churn, complexity, recency, fix_density, change_count
       FROM hotspots ORDER BY score DESC, file_id LIMIT ?`,
  );
  const selectIslands = db.prepare<
    [number],
    {
      file_id: number;
      top_person: number | null;
      top_share: number;
      bus_factor: number;
      entropy: number;
    }
  >(
    /* Ordered by *consequence*, not by share. Every island has `top_share` at or near 1.0 by
       definition — that is what makes it an island — so ordering by it is effectively arbitrary,
       and a `fuzz/.gitignore` would outrank a 900-line module nobody else understands. The
       hotspot score is the right tiebreak: it already encodes churn, size, recency, and fix
       density, which is exactly "how much will it hurt when this file needs changing". Files
       with no hotspot row (excluded as generated, or never ranked) sort last rather than
       vanishing, because a genuine island in a generated file is still worth seeing once. */
    /* `died_commit IS NULL` — a file that no longer exists at HEAD is excluded. Its knowledge
       genuinely is concentrated in one departed person, but nobody can act on that: there is no
       file to change, and it would also render as "file 284" since a dead file has no current
       path. Reporting it crowds out islands someone can do something about. */
    `SELECT o.file_id, o.top_person, o.top_share, o.bus_factor, o.entropy FROM ownership o
       JOIN files f ON f.id = o.file_id
       LEFT JOIN hotspots h ON h.file_id = o.file_id
      WHERE o.is_island = 1 AND f.died_commit IS NULL
      ORDER BY COALESCE(h.score, -1) DESC, o.file_id LIMIT ?`,
  );

  const selectPersonById = db.prepare<[number], PersonRow>(
    `SELECT ${PERSON_COLUMNS} FROM people WHERE id = ?`,
  );
  // Most prolific first: `all()` feeds the cast of characters, where an alphabetical
  // list of 400 contributors is useless and the top twenty are the answer.
  const selectAllPeople = db.prepare<[], PersonRow>(
    `SELECT ${PERSON_COLUMNS} FROM people ORDER BY commit_count DESC, canonical_name, id`,
  );
  const selectHumanPeople = db.prepare<[], PersonRow>(
    `SELECT ${PERSON_COLUMNS} FROM people WHERE is_bot = 0
     ORDER BY commit_count DESC, canonical_name, id`,
  );
  const selectIdentitiesOf = db.prepare<[number], IdentityRow>(
    `SELECT person_id, name, email FROM person_identities
     WHERE person_id = ? ORDER BY name, email`,
  );
  const selectAllIdentities = db.prepare<[], IdentityRow>(
    'SELECT person_id, name, email FROM person_identities ORDER BY person_id, name, email',
  );
  const countPeople = db.prepare<[], number>('SELECT count(*) FROM people').pluck();

  // The FTS table is deliberately not aliased: FTS5's auxiliary functions and its MATCH
  // operator both take the table's own name, and an alias silently turns
  // `bm25(commits_fts)` into "no such column". bm25 is negative-is-better, so plain
  // ascending order is best-first.
  //
  // This is the one query in the file that sorts through a temp b-tree, because ranking
  // cannot be answered from an index. The set being sorted is the match set, not the
  // table, which is what keeps ⌘K inside its 50ms budget. The `c.id DESC` tie-break is
  // there so two commits with identical scores do not swap places between runs.
  const searchCommits = db.prepare<[string, number], CommitRow>(
    `SELECT ${COMMIT_COLUMNS_QUALIFIED}
     FROM commits_fts JOIN commits c ON c.id = commits_fts.rowid
     WHERE commits_fts MATCH ?
     ORDER BY bm25(commits_fts), c.id DESC LIMIT ?`,
  );

  /** One statement for a whole page's parent edges. See the header note on N+1. */
  function hydrate(rows: readonly CommitRow[]): readonly Commit[] {
    if (rows.length === 0) return [];
    const byChild = new Map<number, number[]>();
    for (const edge of selectParentsOf.all(JSON.stringify(rows.map((row) => row.id)))) {
      const existing = byChild.get(edge.child_id);
      if (existing === undefined) byChild.set(edge.child_id, [edge.parent_id]);
      else existing.push(edge.parent_id);
    }
    return rows.map((row) => toCommit(row, byChild.get(row.id) ?? []));
  }

  function hydrateOne(row: CommitRow | undefined): Commit | null {
    return row === undefined ? null : (hydrate([row])[0] ?? null);
  }

  const commits: CommitQueries = {
    byOid(oid) {
      return hydrateOne(selectCommitByOid.get(oid));
    },

    byId(id) {
      return hydrateOne(selectCommitById.get(id));
    },

    list(page: PageRequest): Page<Commit> {
      const limit = assertLimit(page.limit);
      // One row beyond the page, so "is there another page" is answered by the same
      // statement rather than by a second count, and the final page never hands back a
      // cursor that leads to an empty one.
      let rows: readonly CommitRow[];
      if (page.cursor === null) {
        rows = selectFirstPage.all(limit + 1);
      } else {
        const cursor = decodeCommitCursor(page.cursor);
        rows = selectNextPage.all(cursor.committedAt, cursor.id, limit + 1);
      }

      const hasMore = rows.length > limit;
      const kept = hasMore ? rows.slice(0, limit) : rows;
      const last = kept[kept.length - 1];
      return {
        rows: hydrate(kept),
        nextCursor:
          hasMore && last !== undefined
            ? encodeCommitCursor({ committedAt: last.committed_at, id: last.id })
            : null,
      };
    },

    count() {
      return countCommits.get() ?? 0;
    },

    changesIn(commit: CommitId): readonly Change[] {
      return selectChangesIn.all(commit).map(toChange);
    },

    mostSignificant(limit: number): readonly Commit[] {
      /* No `WHERE flags = 0` filter, deliberately. Noise is excluded by *scoring*, not by
         omission: the significance penalties exceed any plausible reward, so a codemod sinks
         to zero and never reaches the top. Filtering here too would make the
         anti-embarrassment test pass for the wrong reason — proving the filter works rather
         than that the scoring does — and would hide the one case where a noise-flagged commit
         legitimately ranks, a revert whose diff happens to be mechanical. */
      // `hydrate` batches the parent edges into one statement; see its note on N+1.
      return hydrate(selectMostSignificant.all(limit));
    },

    hunksIn(commit: CommitId, file: FileId): readonly Hunk[] {
      return selectHunksIn.all(commit, file).map(hunkRow);
    },

    commitsTouching(
      file: FileId,
      startLine: number,
      endLine: number,
    ): readonly CommitId[] {
      /* Half-open, and validated rather than silently coerced: an inverted or empty range is a
           caller bug, and returning "no commits" for it would look exactly like a line nobody
           has ever touched — the one answer this query must never invent. */
      if (endLine <= startLine) {
        throw new ExcavateError(
          'INVALID_TARGET',
          `line range [${startLine}, ${endLine}) is empty; a range must contain at least one line`,
          { details: { startLine, endLine } },
        );
      }
      return selectTouching
        .all(file, endLine - 1, startLine)
        .map((row) => commitId(row.commit_id));
    },

    isAncestor(ancestor: CommitId, descendant: CommitId): boolean {
      /* Generation numbers give a *necessary* condition in constant time — a parent always has
         a lower ordinal than its child — so `false` here is conclusive and free. `true` is not:
         two commits on unrelated branches also satisfy it, which is why the walk up the parent
         edges follows. Part 8 §8.7 asks for near-constant ancestry; it is exactly that for the
         negative case, which is the one every time-window filter hits most often. */
      if (ancestor === descendant) return true;
      const ancestorGen = generationOf.get(ancestor);
      const descendantGen = generationOf.get(descendant);
      if (ancestorGen === undefined || descendantGen === undefined) return false;
      if (ancestorGen >= descendantGen) return false;
      return (isAncestorOf.get(descendant, ancestor, ancestor) ?? 0) === 1;
    },
  };

  const files: FileQueries = {
    byId(id) {
      const row = selectFileById.get(id);
      return row === undefined ? null : toFileEntity(row, selectAliasesOf.all(id));
    },

    byPath(path: string, at: CommitId | null): FileEntity | null {
      /* Resolved through the alias chain, which is the whole reason the chain exists: a
         historical path must find the file it became. `at === null` asks "which file lives here
         now"; a commit id asks "which lived here then", and for any renamed or resurrected path
         those are different files. */
      const row =
        at === null
          ? selectFileByCurrentPath.get(path)
          : selectFileByPathAt.get(path, at, at);
      return row === undefined ? null : toFileEntity(row, selectAliasesOf.all(row.id));
    },

    pathOf(id: PathId): string | null {
      return selectPath.get(id) ?? null;
    },

    changesTo(file: FileId): readonly Change[] {
      return selectChangesTo.all(file).map(toChange);
    },

    count() {
      return countFiles.get() ?? 0;
    },
  };

  const people: PersonQueries = {
    byId(id) {
      const row = selectPersonById.get(id);
      return row === undefined ? null : toPerson(row, selectIdentitiesOf.all(id));
    },

    all(options) {
      const rows = options.includeBots ? selectAllPeople.all() : selectHumanPeople.all();
      const byPerson = new Map<number, IdentityRow[]>();
      for (const identity of selectAllIdentities.all()) {
        const existing = byPerson.get(identity.person_id);
        if (existing === undefined) byPerson.set(identity.person_id, [identity]);
        else existing.push(identity);
      }
      return rows.map((row) => toPerson(row, byPerson.get(row.id) ?? []));
    },

    count() {
      return countPeople.get() ?? 0;
    },
  };

  const search: SearchQueries = {
    commits(query: string, limit: number): readonly Commit[] {
      const match = toMatchExpression(query);
      if (match === null) return [];
      return hydrate(searchCommits.all(match, assertLimit(limit)));
    },

    paths(_query: string, _limit: number): readonly FileEntity[] {
      throw new NotImplementedError('SearchQueries.paths', 'M5');
    },
  };

  const rollups: RollupQueries = {
    ownership(file: FileId): Ownership | null {
      const row = selectOwnership.get(file);
      if (row === undefined) return null;
      return {
        file,
        topPerson: row.top_person === null ? null : (row.top_person as PersonId),
        topShare: row.top_share,
        shares: selectShares.all(file, file).map((s) => ({
          person: s.person_id as PersonId,
          share: s.share,
        })),
        busFactor: row.bus_factor,
        entropy: row.entropy,
        isKnowledgeIsland: row.is_island === 1,
      };
    },
    hotspots(limit: number): readonly Hotspot[] {
      return selectHotspots.all(limit).map((row) => ({
        file: row.file_id as FileId,
        score: row.score,
        changeCount: row.change_count,
        factors: {
          churn: row.churn,
          complexity: row.complexity,
          recency: row.recency,
          fixDensity: row.fix_density,
        },
      }));
    },
    knowledgeIslands(limit: number): readonly Ownership[] {
      return selectIslands.all(limit).map((row) => ({
        file: row.file_id as FileId,
        topPerson: row.top_person === null ? null : (row.top_person as PersonId),
        topShare: row.top_share,
        shares: selectShares.all(row.file_id, row.file_id).map((s) => ({
          person: s.person_id as PersonId,
          share: s.share,
        })),
        busFactor: row.bus_factor,
        entropy: row.entropy,
        isKnowledgeIsland: true,
      }));
    },
    coupledWith(_file: FileId, _limit: number): readonly Coupling[] {
      throw new NotImplementedError('RollupQueries.coupledWith', 'M2');
    },
    revertPairs(): readonly RevertPair[] {
      throw new NotImplementedError('RollupQueries.revertPairs', 'M2');
    },
    eras(): readonly Era[] {
      throw new NotImplementedError('RollupQueries.eras', 'M5');
    },
    releases(): readonly Release[] {
      throw new NotImplementedError('RollupQueries.releases', 'M4');
    },
    timelineBuckets(_granularity: 'day' | 'week' | 'month'): readonly TimelineBucket[] {
      throw new NotImplementedError('RollupQueries.timelineBuckets', 'M4');
    },
  };

  const bundles: BundleCache = {
    get(_hash: BundleHash): EvidenceBundle | null {
      throw new NotImplementedError('BundleCache.get', 'M2');
    },
    put(_bundle: EvidenceBundle): void {
      throw new NotImplementedError('BundleCache.put', 'M2');
    },
  };

  return { commits, files, people, rollups, search, bundles };
}

/**
 * The store's own floor. Clamping to `MAX_PAGE_SIZE` belongs to the route that parses
 * the query string, not here: an internal caller asking for 10,000 rows is doing
 * something legitimate, while one asking for 0 or -1 has a bug worth surfacing loudly
 * rather than returning an empty page it will interpret as "end of history".
 */
function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`page limit must be a positive integer, got ${limit}`);
  }
  return limit;
}

/**
 * Build an FTS5 `MATCH` expression from raw user text.
 *
 * User input is never handed to `MATCH` verbatim. FTS5's query grammar gives `"`, `(`,
 * `*`, `:`, `^`, `-`, `AND`, `OR` and `NEAR` special meaning, so a search box that
 * forwards its contents raw turns a half-typed `foo (` into a 500 and a search for
 * `C++` into a syntax error. Tokenising to words and quoting each one yields the
 * implicit-AND semantics a search box is expected to have, and makes a syntax error
 * impossible by construction.
 *
 * The final token carries a `*` so ⌘K matches while the user is still typing, which is
 * the point of a 50ms search budget (LEAN-V1 §3.1). Returns `null` when the query holds
 * no searchable token, so the caller returns nothing rather than matching everything.
 */
export function toMatchExpression(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (tokens === null) return null;
  const last = tokens.length - 1;
  return tokens.map((token, index) => `"${token}"${index === last ? '*' : ''}`).join(' ');
}
