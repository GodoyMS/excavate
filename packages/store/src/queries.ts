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
  Hotspot,
  Hunk,
  Ownership,
  PathId,
  Release,
  RevertPair,
} from '@excavate/core';
import { NotImplementedError } from '@excavate/core';
import type BetterSqlite3 from 'better-sqlite3';

import type {
  ChangeRow,
  CommitRow,
  FileAliasRow,
  FileRow,
  IdentityRow,
  PersonRow,
} from './codec.js';
import { toChange, toCommit, toFileEntity, toPerson } from './codec.js';
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

const FILE_COLUMNS = 'id, current_path, born_commit, died_commit, language, flags';

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

    mostSignificant(_limit: number): readonly Commit[] {
      throw new NotImplementedError('CommitQueries.mostSignificant', 'M1');
    },

    hunksIn(_commit: CommitId, _file: FileId): readonly Hunk[] {
      throw new NotImplementedError('CommitQueries.hunksIn', 'M2');
    },

    isAncestor(_ancestor: CommitId, _descendant: CommitId): boolean {
      throw new NotImplementedError('CommitQueries.isAncestor', 'M1');
    },
  };

  const files: FileQueries = {
    byId(id) {
      const row = selectFileById.get(id);
      return row === undefined ? null : toFileEntity(row, selectAliasesOf.all(id));
    },

    byPath(_path: string, _at: CommitId | null): FileEntity | null {
      throw new NotImplementedError('FileQueries.byPath', 'M1');
    },

    pathOf(id: PathId): string | null {
      return selectPath.get(id) ?? null;
    },

    changesTo(_file: FileId): readonly Change[] {
      throw new NotImplementedError('FileQueries.changesTo', 'M1');
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
    ownership(_file: FileId): Ownership | null {
      throw new NotImplementedError('RollupQueries.ownership', 'M1');
    },
    hotspots(_limit: number): readonly Hotspot[] {
      throw new NotImplementedError('RollupQueries.hotspots', 'M1');
    },
    knowledgeIslands(_limit: number): readonly Ownership[] {
      throw new NotImplementedError('RollupQueries.knowledgeIslands', 'M1');
    },
    coupledWith(_file: FileId, _limit: number): readonly Coupling[] {
      throw new NotImplementedError('RollupQueries.coupledWith', 'M1');
    },
    revertPairs(): readonly RevertPair[] {
      throw new NotImplementedError('RollupQueries.revertPairs', 'M1');
    },
    eras(): readonly Era[] {
      throw new NotImplementedError('RollupQueries.eras', 'M1');
    },
    releases(): readonly Release[] {
      throw new NotImplementedError('RollupQueries.releases', 'M1');
    },
    timelineBuckets(_granularity: 'day' | 'week' | 'month'): readonly TimelineBucket[] {
      throw new NotImplementedError('RollupQueries.timelineBuckets', 'M1');
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
