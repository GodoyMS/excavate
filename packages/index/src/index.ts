/**
 * `@excavate/index` — depth 2.
 *
 * **Responsibility.** Turn raw Git data into stored facts, once, efficiently. The
 * streaming walk, path interning, rename resolution, identity merging, noise
 * classification, and incremental update detection.
 *
 * **Non-goals.** No interpretation, no scoring, no AI.
 *
 * **The key property: one pass over history.** Every consumer that needs the walk
 * registers a `WalkSink` and the pipeline fans the stream out to all of them.
 * Re-reading history is the single largest avoidable cost on a big repository, so
 * the architecture makes it structurally hard to do twice.
 *
 * This is the package M1 spends three of its three weeks on, and the one LEAN-V1 §7
 * says must not be compressed: a lineage bug found later means every Why answer
 * since has been potentially wrong, and diagnosing it backwards through four
 * milestones is brutal.
 *
 * **What is actually implemented at M0.4.** The *thread*, and nothing else: drive
 * the walk, assign dense ids, write rows in batched transactions, fan out to sinks,
 * report progress. Every substantive decision the package exists to make — who a
 * person is, which file a path belongs to, whether a commit is noise, what it is
 * worth — is a deliberate shortcut living in `m0-resolvers.ts`, which M1 deletes.
 * Read that file's header before trusting anything this package stores.
 */

import { createHash } from 'node:crypto';

import type {
  Change,
  Commit,
  CommitFlag,
  CommitId,
  FileEntity,
  FileFlag,
  FileId,
  Identity,
  IndexState,
  Oid,
  PartialIndexBadge,
  PathId,
  Person,
  PersonId,
  Tier,
  Timestamp,
} from '@excavate/core';
import {
  commitId,
  compareTimestamps,
  ExcavateError,
  NotImplementedError,
} from '@excavate/core';
import type { GitBackend, Mailmap, RawChange, RawCommit, WalkSpec } from '@excavate/git';
import type { Store, Transaction } from '@excavate/store';
import { WRITE_BATCH_ROWS } from '@excavate/store';

import {
  createM0FileTable,
  createM0PeopleTable,
  m0CommitFlags,
  M0_SIGNIFICANCE,
  splitCommitMessage,
} from './m0-resolvers.js';

/* ── The walk ──────────────────────────────────────────────────────────────── */

export interface WalkContext {
  /** The dense ID assigned to the commit currently being processed. */
  readonly commitId: CommitId;
  readonly tx: Transaction;
  readonly signal: AbortSignal;
}

/**
 * A consumer of the single walk.
 *
 * Synchronous by design: a sink that awaits would stall the stream, and everything
 * a sink needs to do (classify, resolve, buffer a row) is CPU-bound. Anything
 * genuinely async belongs in a later pass over stored rows.
 */
export interface WalkSink {
  readonly id: string;
  onCommit(commit: RawCommit, ctx: WalkContext): void;
  onChange(commit: RawCommit, change: RawChange, ctx: WalkContext): void;
  /** Flush accumulated state. Called once, inside a transaction, after the last commit. */
  finish(tx: Transaction): void;
}

export interface IndexProgress {
  readonly tier: Tier;
  readonly done: number;
  /** `null` while unknown — the walk streams rather than counting first. */
  readonly total: number | null;
  readonly note: string | null;
}

export interface IndexRunOptions {
  readonly tiers: readonly Tier[];
  /** Cancellation is an `AbortSignal`, not a job scheduler with priorities (LEAN-V1 §3.1). */
  readonly signal: AbortSignal;
}

export interface IndexPipeline {
  run(options: IndexRunOptions): AsyncIterable<IndexProgress>;
}

export interface IndexPipelineDeps {
  readonly backend: GitBackend;
  readonly store: Store;
  readonly sinks: readonly WalkSink[];
  readonly walkSpec: WalkSpec;
  /**
   * Rows per write transaction, defaulting to the store's `WRITE_BATCH_ROWS`.
   *
   * **The one addition to the M0.1 surface.** Where the flush boundary falls is a
   * correctness property — it is what a crash truncates the index to — so it needs
   * tests, and testing it at the shipped 10,000 would mean synthesising 10,000
   * commits per assertion. Injecting the threshold is cheaper than that and honest
   * about what is being tested. Production callers omit it.
   */
  readonly batchRows?: number;
}

/**
 * `meta` keys the walk owns, so that `@excavate/server` can read back what only the
 * walk observed. Exported rather than stringly duplicated: a key spelled two ways in
 * two packages is a bug neither the typechecker nor a unit test would catch.
 *
 * Deliberately absent, and both absences are load-bearing:
 *
 * - **Anything from a wall clock.** M1's determinism test requires two indexes of
 *   the same history to compare equal; an `indexed_at` row breaks that forever, and
 *   the index file's own mtime already answers the question.
 * - **`head_oid`.** That is the session's to write. Under `--all --reverse` the last
 *   commit the walk sees is whichever ref tip happens to sort last, which is *not*
 *   HEAD, and a key that merely looks like HEAD would eventually be believed.
 *   `RepoSummary.headOid` and the ref snapshot both belong to whoever owns
 *   `replaceRefs`.
 */
export const META_KEYS = {
  /** The projection the index was built under. Reading it back under another is wrong. */
  projection: 'projection',
  /**
   * The history's time span, as `epochSeconds` plus `offsetMinutes` — two integers
   * rather than a JSON blob the server would have to validate, since `meta.value` is
   * TEXT and a malformed row should be impossible rather than merely unlikely.
   *
   * These are *author* dates, minimum and maximum, because author date is what a
   * human means by "when" (Part 8 §8.2.1) and because author dates are not monotonic
   * in walk order — a rebase reorders them, so first-walked is not earliest.
   */
  firstCommitAt: 'first_commit_at',
  firstCommitOffset: 'first_commit_offset',
  lastCommitAt: 'last_commit_at',
  lastCommitOffset: 'last_commit_offset',
  /**
   * `PartialIndexBadge`, flattened. The empty string means "not partial": the
   * `Transaction` interface has no delete, so absence has to be representable as a
   * value, and a stale badge claiming a complete index is incomplete is the one
   * failure mode worse than no badge at all.
   */
  partialReason: 'partial_reason',
  partialSkipped: 'partial_skipped',
} as const;

export function createIndexPipeline(deps: IndexPipelineDeps): IndexPipeline {
  const batchRows = deps.batchRows ?? WRITE_BATCH_ROWS;
  // Validated at construction rather than on the first flush: `batchRows: 0` would
  // otherwise mean "flush after every commit", which looks like a slow walk rather than
  // like the misconfiguration it is.
  if (!Number.isInteger(batchRows) || batchRows < 1) {
    throw new RangeError(
      `batchRows must be a positive integer, got ${String(deps.batchRows)}`,
    );
  }
  return { run: (options) => runWalk(deps, options, batchRows) };
}

/**
 * M0 implements the `metadata` tier and nothing else, so an `analysis` request is
 * reported rather than silently dropped — and the index is marked partial with the
 * tier named, which is the honest-degradation contract of Part 7 §7.7. `tier-failed`
 * is the closest of the three enumerated reasons; "not written yet" is a failure to
 * produce the tier from the caller's point of view.
 */
const ANALYSIS_DEFERRED: IndexProgress = {
  tier: 'analysis',
  done: 0,
  total: null,
  note: 'the analysis tier is not implemented before M1',
};

const ANALYSIS_SKIPPED: PartialIndexBadge = {
  reason: 'tier-failed',
  skipped: 'analysis tier (significance, ownership, hotspots) — lands in M1',
};

async function* runWalk(
  deps: IndexPipelineDeps,
  options: IndexRunOptions,
  batchRows: number,
): AsyncGenerator<IndexProgress> {
  const analysisRequested = options.tiers.includes('analysis');
  if (!options.tiers.includes('metadata')) {
    // The walk *is* the metadata tier. With nothing else implemented there is no
    // honest work to do, and writing an index state for work that did not happen is
    // worse than yielding nothing. Nothing is written and no `git log` is spawned.
    if (analysisRequested) yield ANALYSIS_DEFERRED;
    return;
  }

  const { store, sinks } = deps;
  const people = createM0PeopleTable();
  const files = createM0FileTable();

  /** Interned once per distinct path and cached for the life of the walk. */
  const pathIds = new Map<string, PathId>();
  /**
   * Parents precede children under `--reverse`, so this is always already populated.
   *
   * The one structure here that is *not* flat in repository size: it holds every oid
   * walked, which is the price of assigning dense ids at all (a child's parent edge
   * needs its parent's id, and a merge's second parent is not the previous commit).
   * Roughly 100 bytes per commit, so tens of megabytes at the 1M-commit scale LEAN-V1
   * §2.1 names as the point where this walk would be ported rather than tuned.
   */
  const commitIds = new Map<Oid, CommitId>();
  const pending: { readonly raw: RawCommit; readonly id: CommitId }[] = [];

  let walked = 0;
  let bufferedRows = 0;
  let earliest: Timestamp | null = null;
  let latest: Timestamp | null = null;

  /** Paths interned inside the transaction currently open; see `write`. */
  const internedInTx: string[] = [];

  /**
   * One `internPaths` call per *distinct* path, not per row. The store's warning
   * about per-row inserts is about the ~5 changes per commit, and those are batched;
   * distinct paths are bounded by the number of files that have ever existed.
   */
  const pathIdOf = (tx: Transaction, path: string): PathId => {
    const cached = pathIds.get(path);
    if (cached !== undefined) return cached;
    const [interned] = tx.internPaths([path]);
    if (interned === undefined) {
      // A store that interns a path and returns no id cannot be written to
      // correctly. `INDEX_CORRUPT` is the right code because it is the one that
      // offers the user a rebuild (Part 7 §7.7) rather than an obscure failure.
      throw new ExcavateError(
        'INDEX_CORRUPT',
        `path interning returned no id for ${path}`,
      );
    }
    pathIds.set(path, interned);
    internedInTx.push(path);
    return interned;
  };

  /**
   * Every write goes through here, because the path cache outlives a transaction and
   * a rolled-back transaction takes its `paths` rows with it.
   *
   * Without this, a flush that fails leaves the cache holding `PathId`s SQLite has
   * just discarded, and the next transaction writes `changes.new_path_id` values
   * pointing at rows that do not exist — a foreign-key failure at best, and a
   * silently mis-attributed path if foreign keys are off during a bulk load. The
   * cache is therefore rolled back with the transaction it was populated in.
   */
  const write = (fn: (tx: Transaction) => void): void => {
    internedInTx.length = 0;
    try {
      store.transaction(fn);
    } catch (error) {
      for (const path of internedInTx) pathIds.delete(path);
      internedInTx.length = 0;
      throw error;
    }
  };

  const writeBufferedRows = (tx: Transaction): void => {
    const commits: Commit[] = [];
    const changes: Change[] = [];

    for (const { raw, id } of pending) {
      const { subject, body } = splitCommitMessage(raw.message);
      const parents: CommitId[] = [];
      for (const parent of raw.parents) {
        const parentId = commitIds.get(parent);
        // Unwalked parents are dropped, which under the `first-parent` projection
        // means every merge's second parent. That is a projection artifact, not a
        // loss: `flags` still records `merge`, and M1 decides whether the excluded
        // side belongs in the store at all (it is needed for merge reconciliation).
        if (parentId !== undefined) parents.push(parentId);
      }

      commits.push({
        id,
        oid: raw.oid,
        tree: raw.tree,
        parents,
        author: people.resolve(raw.author, raw.authoredAt, 'author'),
        committer: people.resolve(raw.committer, raw.committedAt, 'committer'),
        authoredAt: raw.authoredAt,
        committedAt: raw.committedAt,
        subject,
        body,
        // Empty until the trailer parser lands; see `splitCommitMessage`.
        trailers: [],
        // **Not a commit-graph generation number.** It is the 1-based walk ordinal,
        // which is *a* valid topological order — parents sort before children, so
        // `isAncestor` cannot produce a false positive along the walked spine.
        //
        // That guarantee comes from `--topo-order` in `walkArgs`, not from `--reverse`.
        // `--reverse` alone reverses git's *date* order, which is not topological: a
        // rebase or clock skew yields a commit dated before its own parent, and
        // indexing `rust-analyzer` failed on exactly one such pair in 12,832 commits.
        // See `tests/walk-order.test.ts`.
        //
        // It is still not the real thing: a true generation number is
        // `1 + max(parents)` and is stable under any traversal order, whereas this
        // renumbers if the walk order changes and says nothing about branches the
        // projection skipped. Anything beyond "parent < child" must not rely on it.
        generation: id,
        flags: m0CommitFlags(raw),
        significance: M0_SIGNIFICANCE,
      });

      for (const change of raw.changes) {
        const file = files.observe(change, id);
        if (file === null) continue;
        changes.push({
          commit: id,
          file,
          kind: change.kind,
          oldPath: change.oldPath === null ? null : pathIdOf(tx, change.oldPath),
          newPath: change.newPath === null ? null : pathIdOf(tx, change.newPath),
          similarity: change.similarity,
          insertions: change.insertions,
          deletions: change.deletions,
          isBinary: change.isBinary,
        });
      }
    }

    /*
     * **This order is a schema requirement, not a preference.** Part 9's foreign keys
     * are immediate, not `DEFERRABLE`, and `openStore` only turns `foreign_keys` off
     * when the caller opts into `bulkLoad` — which the daemon does not. So each batch
     * has to satisfy every reference on its own:
     *
     *   people   ← `commits.author_id` / `committer_id` REFERENCES people(id)
     *   commits  ← `files.born_commit`, `file_aliases.from_commit`
     *   files    ← `changes.file_id`
     *   paths    ← `changes.old_path_id` / `new_path_id`, `file_aliases.path_id`
     *             (interned above, during materialisation, in this same transaction)
     *
     * Writing commits before people — the obvious "resolve everything, upsert at the
     * end" shape — fails on the first flush of every real repository.
     */
    const touchedPeople = people.drain();
    if (touchedPeople.length > 0) tx.upsertPeople(touchedPeople);
    if (commits.length > 0) tx.insertCommits(commits);
    const touchedFiles = files.drain((path) => pathIdOf(tx, path));
    if (touchedFiles.length > 0) tx.upsertFiles(touchedFiles);
    if (changes.length > 0) tx.insertChanges(changes);

    // Sinks run after the rows they may reference are in the transaction, so a sink
    // writing a row keyed on this batch's commits is legal under any foreign-key
    // mode. They see *every* raw change, including one the M0 file table could not
    // give an identity to: silently narrowing the stream is how M1 would inherit a
    // bug it never wrote.
    for (const { raw, id } of pending) {
      const ctx: WalkContext = { commitId: id, tx, signal: options.signal };
      for (const sink of sinks) sink.onCommit(raw, ctx);
      for (const change of raw.changes) {
        for (const sink of sinks) sink.onChange(raw, change, ctx);
      }
    }

    pending.length = 0;
    bufferedRows = 0;
  };

  /**
   * The last transaction: the remaining rows and the people and files they point at
   * (all of which `writeBufferedRows` drains), every sink's flush, and the state row —
   * together, so that the state row is never durable ahead of the rows it describes.
   */
  const finalize = (state: IndexState, partial: PartialIndexBadge | null): void => {
    write((tx) => {
      writeBufferedRows(tx);
      for (const sink of sinks) sink.finish(tx);

      tx.setMeta(META_KEYS.projection, deps.walkSpec.projection);
      if (earliest !== null) {
        tx.setMeta(META_KEYS.firstCommitAt, String(earliest.epochSeconds));
        tx.setMeta(META_KEYS.firstCommitOffset, String(earliest.offsetMinutes));
      }
      if (latest !== null) {
        tx.setMeta(META_KEYS.lastCommitAt, String(latest.epochSeconds));
        tx.setMeta(META_KEYS.lastCommitOffset, String(latest.offsetMinutes));
      }
      tx.setMeta(META_KEYS.partialReason, partial?.reason ?? '');
      tx.setMeta(META_KEYS.partialSkipped, partial?.skipped ?? '');
      tx.setIndexState(state);
    });
  };

  // Committed before the walk starts, so a crash mid-walk leaves `walking` rather
  // than a stale `ready` over a half-written index.
  write((tx) => {
    tx.setIndexState('walking');
  });
  yield { tier: 'metadata', done: 0, total: null, note: 'walking history' };

  let cancelled = options.signal.aborted;
  try {
    // Checked before starting so an already-cancelled run never spawns a `git log`.
    if (!cancelled) {
      for await (const raw of deps.backend.walk(deps.walkSpec)) {
        if (options.signal.aborted) {
          // Breaking calls `return()` on the walk's iterator, which is what lets the
          // backend kill its child process instead of leaking it.
          cancelled = true;
          break;
        }

        walked += 1;
        const id = commitId(walked);
        commitIds.set(raw.oid, id);
        pending.push({ raw, id });
        bufferedRows += 1 + raw.changes.length;

        if (earliest === null || compareTimestamps(raw.authoredAt, earliest) < 0) {
          earliest = raw.authoredAt;
        }
        if (latest === null || compareTimestamps(raw.authoredAt, latest) > 0) {
          latest = raw.authoredAt;
        }

        if (bufferedRows >= batchRows) {
          write(writeBufferedRows);
          yield { tier: 'metadata', done: walked, total: null, note: null };
        }
      }
    }
  } catch (error) {
    // Any tier may fail (Part 8 §8.6.1). The rows already buffered came off the wire
    // before the failure and are valid, so they are committed along with the people
    // and files they reference.
    //
    // If the failure came from a *flush* rather than from the walk, that batch is
    // reprocessed here: its transaction rolled back, so no stored row is duplicated,
    // and `write` has already dropped the path ids that rollback invalidated. Two
    // things are counted twice all the same — its authors' `commitCount`, and its
    // deliveries to every registered sink, which already happened inside the
    // transaction that failed. So a `failed` index can overstate a person's commits
    // and any sink's aggregates. That is why `failed` means rebuild rather than serve,
    // and why nothing may read a `failed` index without saying so.
    //
    // A second failure in here is swallowed: the original error is the one that
    // explains the state, and the index state simply stays at `walking`, which is the
    // truthful description of a walk that died mid-flight.
    try {
      finalize('failed', {
        reason: 'tier-failed',
        skipped: `history after ${walked} commits — the walk failed`,
      });
    } catch {
      /* The store is unusable. The rethrown cause below says why. */
    }
    throw error;
  }

  if (cancelled) {
    // The rows are committed first, and `stale` rather than `failed`: a user
    // cancelling is not a failure, and `stale` is the state whose outgoing edge is
    // "walk the difference". So the partial index survives and is usable.
    finalize('stale', {
      reason: 'interrupted',
      skipped: `history after ${walked} ${walked === 1 ? 'commit' : 'commits'}`,
    });
    yield {
      tier: 'metadata',
      done: walked,
      total: null,
      note: `cancelled after ${walked} ${walked === 1 ? 'commit' : 'commits'} — index marked partial`,
    };
    // **And then it throws, which an earlier draft of this did not.** Returning
    // cleanly is indistinguishable from finishing, and `@excavate/server`'s `runIndex`
    // reads exactly that way: after the progress stream ends it publishes
    // `index.tier_complete` for every requested tier, sets the session state to
    // `ready` and resolves the job. A cancelled walk would therefore be announced as a
    // complete index — a partial history presented as the whole one, which is the
    // failure mode this product exists to not have (Part 2 §2.5).
    //
    // Throwing after the commit gets both: the durable state says `stale` with an
    // `interrupted` badge, so nothing is lost, and no caller can mistake it for
    // success. `CANCELLED` is the enumerated code for precisely this.
    throw new ExcavateError(
      'CANCELLED',
      `indexing was cancelled after ${walked} ${walked === 1 ? 'commit' : 'commits'}; the partial index is stored and marked stale`,
      { details: { walked, indexState: 'stale' } },
    );
  }

  finalize('ready', analysisRequested ? ANALYSIS_SKIPPED : null);
  yield {
    tier: 'metadata',
    done: walked,
    total: null,
    note: `indexed ${walked} ${walked === 1 ? 'commit' : 'commits'}`,
  };

  if (analysisRequested) yield ANALYSIS_DEFERRED;
}

/* ── Identity merging (Part 8 §8.3.1) ──────────────────────────────────────── */

/**
 * Resolution order, earlier wins. Each merge records its source so the UI can
 * explain it and the user can override — a heuristic merge shown as fact is how an
 * ownership model loses trust.
 *
 * Never merged: identical names with unrelated emails and *overlapping* activity
 * windows. That is two people named Chen.
 */
export interface IdentityResolver {
  resolve(identity: Identity, seenAt: Timestamp): PersonId;
  /**
   * The merged people, available once the walk completes.
   *
   * **M1 must add an incremental drain beside this, and the reason is not
   * performance.** `commits.author_id REFERENCES people(id)` is an immediate
   * constraint and `openStore` only disables foreign keys under `bulkLoad`, which the
   * daemon does not use — so a person row has to be written in the same transaction as
   * the first commit that references them, and a table available only "once the walk
   * completes" cannot supply it. That is why `M0PeopleTable` exposes `drain()`; the
   * shape it landed on is the one this interface needs. It is also what makes an
   * identity *merge* mid-walk a write rather than a rewrite, which the store's
   * `person_identities` upsert is already built for.
   */
  finish(): readonly Person[];
}

export function createIdentityResolver(_mailmap: Mailmap | null): IdentityResolver {
  throw new NotImplementedError('createIdentityResolver', 'M1');
}

/** Strip `+tag`, unify Gmail dots, map `NNNN+user@users.noreply.github.com` → `user@…`. */
export function normalizeEmail(_email: string): string {
  throw new NotImplementedError('normalizeEmail', 'M1');
}

/** Bots are flagged, excluded from ownership, and retained for provenance. */
export function isBotIdentity(_identity: Identity): boolean {
  throw new NotImplementedError('isBotIdentity', 'M1');
}

/* ── Rename resolution (Part 8 §8.3.2) ─────────────────────────────────────── */

/**
 * Maintains the `path → FileId` frontier as the walk advances.
 *
 * M1 handles explicit renames and resurrection; the delete+add similarity heuristic
 * and merge reconciliation land in M2 (ROADMAP M1 deliverable 3).
 *
 * The invariants this must uphold are property-tested (Part 8 §8.8): aliases of a
 * `FileId` never overlap in commit-time, and every `(commit, path)` resolves to
 * exactly one `FileId`.
 */
export interface RenameResolver {
  /** Advance the frontier across one commit's changes. */
  advance(commit: RawCommit, commitId: CommitId): void;
  /** The file currently living at `path`, or `null` if none does. */
  resolve(path: string): FileId | null;
  /**
   * Same caveat as `IdentityResolver.finish`, and sharper here: `changes.file_id
   * REFERENCES files(id)` and `files.born_commit REFERENCES commits(id)` are both
   * immediate, so a batch's file rows must be written after its commits and before its
   * changes. A resolver that only materialises at the end cannot be flushed
   * incrementally at all. See `M0FileTable.drain`, and note that a rename dirties two
   * rows, not one.
   */
  finish(): readonly FileEntity[];
}

export function createRenameResolver(): RenameResolver {
  throw new NotImplementedError('createRenameResolver', 'M1');
}

/** Similarity at or above this counts a delete+add pair as a rename (Part 8 §8.3.2 step 3). */
export const DELETE_ADD_RENAME_SIMILARITY = 90;

/* ── Noise classification ──────────────────────────────────────────────────── */

/**
 * Produces the penalty flags that keep the Prettier migration and the lockfile
 * refresh out of "the most significant commits in this repo".
 */
export interface NoiseClassifier {
  classifyCommit(commit: RawCommit): readonly CommitFlag[];
  classifyPath(path: string): readonly FileFlag[];
}

export function createNoiseClassifier(): NoiseClassifier {
  throw new NotImplementedError('createNoiseClassifier', 'M1');
}

/* ── Incremental update ────────────────────────────────────────────────────── */

/**
 * LEAN-V1 §3.1 cuts targeted rebuild: a rewrite triggers a full rebuild with a
 * progress bar. It is rare, and the invalidation logic is not worth its bug surface.
 */
export type UpdateKind = 'up-to-date' | 'fast-forward' | 'history-rewritten';

export function detectUpdateKind(
  _backend: GitBackend,
  _store: Store,
): Promise<UpdateKind> {
  throw new NotImplementedError('detectUpdateKind', 'M1');
}

/**
 * `hash(root_commit_oid + canonical_path)`, per Part 7 §7.5.
 *
 * The root commit is what lets a repository moved on disk reuse its index; the path
 * is what stops two worktrees of the same project colliding. The NUL byte between
 * them is not decoration — concatenating directly would make `(oid, path)` and
 * `(oid + prefix, suffix)` collide, and a path may contain any byte except NUL, so
 * NUL is the only separator that cannot appear in either half.
 *
 * SHA-256 rather than something shorter because this string ends up in cache
 * directory names that live for years, and truncating later is a migration.
 *
 * Returns the full 64-character hex digest; the caller brands it with `repoId()`.
 */
export function computeRepoId(rootCommitOid: string, canonicalPath: string): string {
  return createHash('sha256')
    .update(`${rootCommitOid}\0${canonicalPath}`, 'utf8')
    .digest('hex');
}
