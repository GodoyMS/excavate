/**
 * `@wise-excavate/store` — depth 1.
 *
 * **Responsibility.** Schema, migrations, transactions, batched writes, typed
 * queries, the derived rollup tables, and FTS5.
 *
 * **Non-goals.** No business logic. Queries live here; decisions do not.
 *
 * **Boundary rule B2: only this package writes SQL.** Schema knowledge leaking into
 * every other package is how a store becomes impossible to migrate.
 *
 * Two lean simplifications from LEAN-V1 §5 are visible in this interface:
 *
 * - **Storage is one file.** `index.db`, with FTS5 virtual tables *inside* it. No
 *   `search/`, no `vectors/`, no `layout/` sidecars — Tantivy and usearch are cut,
 *   and the treemap is fast enough to compute at open and hold in memory.
 * - **The API is synchronous.** `better-sqlite3` is a synchronous binding, and
 *   pretending otherwise would add `async` colouring to the entire graph for no
 *   gain. Writes are batched into short transactions (`WRITE_BATCH_ROWS`), so the
 *   event loop is never held long enough to stall SSE progress.
 */

import type {
  AnalysisQueries,
  HotspotWrite,
  KnowledgeWrite,
  OwnershipWrite,
} from './analysis.js';
import type {
  Commit,
  CommitId,
  Confidence,
  Coupling,
  Era,
  EvidenceBundle,
  FileEntity,
  FileId,
  Hotspot,
  Hunk,
  IndexState,
  Oid,
  Ownership,
  PathId,
  Person,
  PersonId,
  Ref,
  Release,
  RepoId,
  RevertPair,
  Tag,
  Timestamp,
  Change,
  BundleHash,
  AnalyzerId,
} from '@wise-excavate/core';

import { latestSchemaVersion, migrations } from './migrations/index.js';

/** One file, in the XDG cache dir or `--index-dir`. FTS5 tables live inside it. */
export const INDEX_FILE_NAME = 'index.db';

/**
 * Derived from the migration list rather than declared next to it. A constant that
 * disagrees with the migrations produces an index that migrates correctly and then
 * reports itself corrupt on every open, with nothing to point at — so the two are made
 * the same fact instead of two facts that have to be kept equal.
 */
export const SCHEMA_VERSION = latestSchemaVersion();

/**
 * Rows per write transaction during the walk (LEAN-V1 §5.1). Large enough that
 * `better-sqlite3` sustains its >100k inserts/sec, small enough that a failure
 * loses little and the event loop stays responsive.
 */
export const WRITE_BATCH_ROWS = 10_000;

export interface Migration {
  readonly version: number;
  /** `NNNN_snake_case_description`, per Part 14 §14.4. */
  readonly name: string;
  readonly up: string;
}

/* ── Queries ───────────────────────────────────────────────────────────────── */

export interface Page<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | null;
}

export interface CommitQueries {
  byOid(oid: Oid): Commit | null;
  byId(id: CommitId): Commit | null;
  list(page: PageRequest): Page<Commit>;
  count(): number;
  /** Ordered by significance, with noise flags already excluded. */
  mostSignificant(limit: number): readonly Commit[];
  changesIn(commit: CommitId): readonly Change[];
  hunksIn(commit: CommitId, file: FileId): readonly Hunk[];
  /** Ancestry via generation numbers, held in memory (Part 8 §8.7). */
  isAncestor(ancestor: CommitId, descendant: CommitId): boolean;
}

export interface FileQueries {
  byId(id: FileId): FileEntity | null;
  /** Resolves through the alias chain, so a historical path finds its current file. */
  byPath(path: string, at: CommitId | null): FileEntity | null;
  pathOf(id: PathId): string | null;
  changesTo(file: FileId): readonly Change[];
  count(): number;
}

export interface PersonQueries {
  byId(id: PersonId): Person | null;
  all(options: { readonly includeBots: boolean }): readonly Person[];
  count(): number;
}

/** Precomputed during indexing, not aggregated per request — the difference between a 16ms scrub and a 400ms one. */
export interface RollupQueries {
  ownership(file: FileId): Ownership | null;
  hotspots(limit: number): readonly Hotspot[];
  knowledgeIslands(limit: number): readonly Ownership[];
  coupledWith(file: FileId, limit: number): readonly Coupling[];
  revertPairs(): readonly RevertPair[];
  eras(): readonly Era[];
  releases(): readonly Release[];
  timelineBuckets(granularity: 'day' | 'week' | 'month'): readonly TimelineBucket[];
}

export interface TimelineBucket {
  readonly start: Timestamp;
  readonly commitCount: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly distinctAuthors: number;
}

/** FTS5 over commit subjects, bodies, and paths. Enough for ⌘K; no BM25 tuning for code (LEAN-V1 §3.1). */
export interface SearchQueries {
  commits(query: string, limit: number): readonly Commit[];
  paths(query: string, limit: number): readonly FileEntity[];
}

/** Bundles are assembled at query time and cached by hash (Part 8 §8.7). */
export interface BundleCache {
  get(hash: BundleHash): EvidenceBundle | null;
  put(bundle: EvidenceBundle): void;
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

/**
 * Bulk writers. Every method takes a batch: per-row inserts across a 50k-commit
 * walk is the difference between seconds and minutes.
 */
export interface Transaction {
  insertCommits(rows: readonly Commit[]): void;
  insertChanges(rows: readonly Change[]): void;
  insertHunks(rows: readonly Hunk[]): void;
  upsertPeople(rows: readonly Person[]): void;
  upsertFiles(rows: readonly FileEntity[]): void;
  internPaths(paths: readonly string[]): readonly PathId[];
  replaceRefs(rows: readonly Ref[]): void;
  replaceTags(rows: readonly Tag[]): void;
  setIndexState(state: IndexState): void;
  setMeta(key: string, value: string): void;

  /* ── Analysis rollups (schema v2, written by the analysis tier) ───────────── */

  /**
   * Replace the whole knowledge table.
   *
   * Wholesale, not merged: an analyzer owns its entire output, and a merge would leave rows
   * the current run no longer produces — a contributor whose knowledge has fully decayed, or
   * a file that a corrected rename resolution folded into another. Every one of those stale
   * rows inflates a bus factor, silently, which is the failure this product cannot have.
   */
  replaceKnowledge(rows: readonly KnowledgeWrite[]): void;
  replaceOwnership(rows: readonly OwnershipWrite[]): void;
  replaceHotspots(rows: readonly HotspotWrite[]): void;
  /** Significance is scored after the walk, over stored rows, so it is an update. */
  setSignificance(
    rows: readonly { readonly commit: CommitId; readonly score: number }[],
  ): void;
  /** Records that an analyzer ran, at which version and through which commit (Part 7 §7.2.3). */
  recordAnalyzerRun(analyzer: AnalyzerId, version: number, throughOid: string): void;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly schemaVersion: number;
  readonly problems: readonly string[];
}

/**
 * Reads of the `meta` key-value table.
 *
 * The write side (`Transaction.setMeta`, `Transaction.setIndexState`) shipped first, which
 * left the index able to *record* what it had done and the daemon unable to find out. That
 * asymmetry is not a missing convenience: the walk persists `index_state` and a flattened
 * `PartialIndexBadge`, so without a read path a session that reopened an index truncated by
 * an earlier crash had no way to know, and reported it as `ready`. A partial history
 * presented as a whole one is the exact failure Part 7 §7.7 and LEAN-V1 §9.1 forbid, and
 * the only reason it was reachable is that this interface was write-only.
 *
 * Reads only. Keys are written through the typed writers, never from here.
 */
export interface MetaQueries {
  /** `null` when the key was never written — absence is a legitimate answer, not an error. */
  get(key: string): string | null;
  /** The persisted indexing state from Part 8 §8.6.1, or `null` on an index no walk has finished. */
  indexState(): IndexState | null;
}

export interface Store {
  readonly repoId: RepoId;
  readonly path: string;
  readonly schemaVersion: number;

  /** Applies pending migrations, or fails with `SCHEMA_TOO_NEW` if the file is from a newer build. */
  migrate(): void;
  /** One transaction. Throwing rolls back and leaves the prior index valid and usable. */
  transaction<T>(fn: (tx: Transaction) => T): T;
  /** Run on open, per Part 7 §7.7 — a corrupt index offers a one-click rebuild rather than failing obscurely. */
  integrityCheck(): IntegrityReport;
  close(): void;

  readonly commits: CommitQueries;
  readonly files: FileQueries;
  readonly people: PersonQueries;
  readonly rollups: RollupQueries;
  readonly search: SearchQueries;
  readonly bundles: BundleCache;
  readonly meta: MetaQueries;
  /** The streaming scan and rollup reads the analysis tier runs on. */
  readonly analysis: AnalysisQueries;
}

export interface OpenStoreOptions {
  readonly path: string;
  readonly repoId: RepoId;
  /** Tuned for bulk load during a walk; indexes are created after the load, not before. */
  readonly bulkLoad?: boolean;
}

/**
 * Open (or create) the index, bring its schema up to date, and hand back a working
 * store. Implemented in `./store.ts`; re-exported here so this file stays the contract
 * and nothing outside the package ever imports a submodule.
 */
export type {
  AnalysisQueries,
  ChangeFact,
  CommitFact,
  HotspotWrite,
  KnowledgeWrite,
  OwnershipWrite,
} from './analysis.js';
export { openStore } from './store.js';

/** The ordered migration list. `docs/schema.md` is generated from it. */
export { migrations };

/** Confidence is stored alongside a bundle so a cached answer keeps its enumerated reasons. */
export type StoredConfidence = Confidence;
