/**
 * `@wise-excavate/index` — depth 2.
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
  FileFlag,
  FileId,
  Hunk,
  IndexState,
  Oid,
  PartialIndexBadge,
  PathId,
  Tier,
  Timestamp,
} from '@wise-excavate/core';
import {
  commitId,
  compareTimestamps,
  ExcavateError,
  parseOid,
} from '@wise-excavate/core';
import type {
  GitBackend,
  Mailmap,
  RawChange,
  RawCommit,
  WalkSpec,
} from '@wise-excavate/git';
import type { Store, Transaction } from '@wise-excavate/store';
import { WRITE_BATCH_ROWS } from '@wise-excavate/store';

import { createIdentityResolver } from './identity.js';
import { coAuthors, splitCommitMessage } from './message.js';
import { classifyCommit, classifyPath } from './noise.js';
import { createRenameResolver } from './renames.js';

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
 * `meta` keys the walk owns, so that `@wise-excavate/server` can read back what only the
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
  /**
   * The commit the index was built up to, so the next open can tell a fast-forward from a
   * rewrite (`detectUpdateKind`).
   *
   * This is HEAD's oid at walk time, not the last commit the walk emitted — under `--all`
   * the last emitted commit is whichever ref tip sorts last topologically, which is usually
   * not HEAD. Storing that instead would make every second open look like a rewrite.
   */
  indexedTip: 'indexed_tip',
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
 * The pipeline builds the `metadata` tier only, and that is no longer a shortfall.
 *
 * At M0 an `analysis` request had to be reported as an unbuilt tier, because nothing built it.
 * At M1 the analysis tier exists — it just is not *here*: it is a second pass over stored
 * rows, driven by the composition root, because this package may not depend on
 * `@wise-excavate/analysis`. So asking the pipeline for `analysis` is a caller mistake rather
 * than a missing feature, and the deferral record below says so.
 */
const ANALYSIS_DEFERRED: IndexProgress = {
  tier: 'analysis',
  done: 0,
  total: null,
  note: 'the analysis tier is a second pass; ask the composition root, not the walk',
};

async function* runWalk(
  deps: IndexPipelineDeps,
  options: IndexRunOptions,
  batchRows: number,
): AsyncGenerator<IndexProgress> {
  const analysisRequested = options.tiers.includes('analysis');
  const contentRequested = options.tiers.includes('content');
  if (!options.tiers.includes('metadata')) {
    // The walk *is* the metadata tier. With nothing else implemented there is no
    // honest work to do, and writing an index state for work that did not happen is
    // worse than yielding nothing. Nothing is written and no `git log` is spawned.
    if (analysisRequested) yield ANALYSIS_DEFERRED;
    return;
  }

  const { store, sinks } = deps;
  /* The real resolvers, as of M1. `m0-resolvers.ts` is deleted: identity is the five-step
     ladder of Part 8 §8.3.1 including `.mailmap` and bot detection, and file identity is
     the alias-chain model of §8.3.2 including resurrection. */
  const people = createIdentityResolver(await readMailmap(deps.backend));
  const files = createRenameResolver();

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

  /* HEAD, read once before the walk. `detectUpdateKind` compares against it on the next
     open, and it must be HEAD rather than the last-emitted commit — see META_KEYS.indexedTip.
     An unborn HEAD is not an error: an empty repository walks as empty. */
  const indexedTip = await headOrNull(deps.backend);

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
      const parsed = splitCommitMessage(raw.message);
      /* Resolved through the same ladder as the author, so a co-author who also commits under
           two addresses merges into one person exactly as they should. The returned ids are not
           stored on the commit at M1 — there is no `commit_coauthors` table until the ownership
           model distributes credit per file — but resolving them here is what makes them exist
           at all: a contributor who is only ever a co-author is otherwise invisible.
           See `IdentityResolver.resolve` for why that mattered. */
      for (const coAuthor of coAuthors(parsed.trailers)) {
        people.resolve(coAuthor, raw.authoredAt, 'co-author');
      }
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
        subject: parsed.subject,
        body: parsed.body,
        trailers: parsed.trailers,
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
        flags: classifyCommit(raw, raw.parents.length > 1).flags,
        /* Left at zero by the walk on purpose. Significance needs corpus-wide facts —
           path rarity is an inverse document frequency over every touched path, and
           message quality depends on which subjects repeat across the whole repository —
           so it cannot be computed one commit at a time. `significanceAnalyzer` fills this
           in during the analysis tier, over stored rows. */
        significance: 0,
      });

      const affected = files.advance(raw, id, classifyPath);
      for (const change of raw.changes) {
        const file = affected.get(change);
        if (file === undefined) continue;
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
    const touchedFiles = files.drain((path: string) => pathIdOf(tx, path));
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
  const finalize = (
    state: IndexState,
    partial: PartialIndexBadge | null,
    indexedTip: Oid | null,
  ): void => {
    write((tx) => {
      writeBufferedRows(tx);
      for (const sink of sinks) sink.finish(tx);

      tx.setMeta(META_KEYS.projection, deps.walkSpec.projection);
      /* Written only for a walk that ran to completion. A cancelled or failed walk must not
         claim a tip: the next open would read it, conclude "fast-forward", and append to an
         index that is missing the middle of its own history. Empty means "walk everything",
         which is the only safe default. */
      tx.setMeta(
        META_KEYS.indexedTip,
        state === 'ready' && indexedTip !== null ? indexedTip : '',
      );
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
      finalize(
        'failed',
        {
          reason: 'tier-failed',
          skipped: `history after ${walked} ${walked === 1 ? 'commit' : 'commits'} — the walk failed`,
        },
        null,
      );
    } catch {
      /* The store is unusable. The rethrown cause below says why. */
    }
    throw error;
  }

  if (cancelled) {
    // The rows are committed first, and `stale` rather than `failed`: a user
    // cancelling is not a failure, and `stale` is the state whose outgoing edge is
    // "walk the difference". So the partial index survives and is usable.
    finalize(
      'stale',
      {
        reason: 'interrupted',
        skipped: `history after ${walked} ${walked === 1 ? 'commit' : 'commits'}`,
      },
      null,
    );
    yield {
      tier: 'metadata',
      done: walked,
      total: null,
      note: `cancelled after ${walked} ${walked === 1 ? 'commit' : 'commits'} — index marked partial`,
    };
    // **And then it throws, which an earlier draft of this did not.** Returning
    // cleanly is indistinguishable from finishing, and `@wise-excavate/server`'s `runIndex`
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

  finalize('ready', null, indexedTip);
  yield {
    tier: 'metadata',
    done: walked,
    total: null,
    note: `indexed ${walked} ${walked === 1 ? 'commit' : 'commits'}`,
  };

  if (contentRequested) yield* runContent(deps, options, batchRows);
  if (analysisRequested) yield ANALYSIS_DEFERRED;
}

/**
 * The content tier: hunk geometry for every commit already in the index.
 *
 * A second `git` traversal, which is unavoidable — `@wise-excavate/git`'s `hunkArgs` explains why
 * patch text cannot share the metadata walk's stream. Run after the walk so every commit and file
 * this attaches to already exists; `changes.file_id REFERENCES files(id)` is immediate, so an
 * out-of-order write would fail loudly rather than produce orphans.
 *
 * **Path resolution reuses the metadata tier's own decisions rather than repeating them.** The
 * hunk pass reports paths, but a path is not an identity — that is the whole point of the alias
 * chains in `renames.ts`. Re-deriving `path → FileId` here would mean running rename resolution
 * a second time and hoping the two agree; instead each commit's stored `changes` rows are read
 * back, which *are* the mapping the walk committed to. If the two ever disagreed, the disagreement
 * would be the bug, and there is now no second opinion to have it with.
 */
async function* runContent(
  deps: IndexPipelineDeps,
  options: IndexRunOptions,
  batchRows: number,
): AsyncGenerator<IndexProgress> {
  const { store, backend } = deps;

  yield { tier: 'content', done: 0, total: null, note: 'reading hunk geometry' };

  /**
   * Files no line-level question is ever asked about.
   *
   * ROADMAP M2 scopes hunk storage to "text files under a size cap", and this is the honest
   * reading of it: nobody asks why line 4,000 of `pnpm-lock.yaml` exists, or why a `.min.js`
   * bundle has the shape it does. Storing that geometry costs real bytes and answers no
   * question — measured on `rust-analyzer`, keeping it put the index at 3.90 KB/commit against
   * ADR-0003's 3 KB budget, and excluding it is what brings it back inside.
   *
   * The same set the hotspot ranking already excludes (`nonSourceFiles`), so a file cannot be
   * unrankable for hotspots and yet carry hunks — one definition of "not source", used twice.
   */
  const excluded = new Set(store.analysis.nonSourceFiles());

  let pending: Hunk[] = [];
  let seen = 0;
  let attached = 0;
  let skipped = 0;
  let excludedHunks = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    const rows = pending;
    pending = [];
    store.transaction((tx) => {
      tx.insertHunks(rows);
    });
  };

  for await (const record of backend.hunks(deps.walkSpec)) {
    /* Cancellation is checked per commit, and the buffered rows are flushed on the way out —
       the same contract the metadata walk keeps. Hunks already read are valid; discarding them
       would make a cancelled run lose work it had genuinely done. */
    if (options.signal.aborted) {
      flush();
      throw new ExcavateError(
        'CANCELLED',
        `the hunk pass was cancelled after ${seen} ${seen === 1 ? 'commit' : 'commits'}`,
        { details: { seen } },
      );
    }
    seen += 1;

    const commit = store.commits.byOid(record.oid);
    /* A commit the metadata walk did not index. Reachable when the two passes see different
       histories — a ref moved between them, or the walk was cancelled and left a partial index.
       Counted and skipped rather than inserted: hunks for a commit that is not in `commits`
       would violate the foreign key, and inventing the commit here would mean the content tier
       writing ground truth, which is the walk's job alone. */
    if (commit === null) {
      skipped += 1;
      continue;
    }

    /* The mapping the walk decided on, read back rather than recomputed. Both sides are
       registered: a rename's hunks are reported against the new path, but a deletion's only
       path is the old one. */
    const fileOf = new Map<string, FileId>();
    for (const change of store.commits.changesIn(commit.id)) {
      for (const pathRef of [change.newPath, change.oldPath]) {
        if (pathRef === null) continue;
        const path = store.files.pathOf(pathRef);
        if (path !== null && !fileOf.has(path)) fileOf.set(path, change.file);
      }
    }

    for (const file of record.files) {
      const fileId = fileOf.get(file.path);
      /* No change row for this path in this commit. git's rename detection ran with the same
         threshold in both passes, so this is rare — but a mode-only change that `--numstat`
         reported and `--patch` rendered differently can land here, and a hunk we cannot attach
         to a file identity is a hunk we must not guess at. */
      if (fileId === undefined) continue;
      if (excluded.has(fileId)) {
        excludedHunks += file.hunks.length;
        continue;
      }
      for (const hunk of file.hunks) {
        pending.push({ ...hunk, commit: commit.id, file: fileId });
        attached += 1;
      }
    }

    if (pending.length >= batchRows) {
      flush();
      yield { tier: 'content', done: seen, total: null, note: null };
    }
  }
  flush();

  yield {
    tier: 'content',
    done: seen,
    total: null,
    /* The excluded count is reported, not silently dropped. A tier that quietly stored less
       than it read would make the index look complete when it is deliberately not, and
       "generated files carry no hunks" is something a reader of `excavate why` output is
       entitled to know before concluding that nothing touched a line. */
    note:
      `${attached.toLocaleString()} ${attached === 1 ? 'hunk' : 'hunks'}` +
      (excludedHunks > 0
        ? ` · ${excludedHunks.toLocaleString()} skipped in generated and vendored files`
        : '') +
      (skipped > 0 ? ` · ${skipped.toLocaleString()} commits not in the index` : ''),
  };
}

/* ── Identity merging and rename resolution ────────────────────────────────── */

/**
 * The two hard problems, implemented in their own modules and re-exported here so this file
 * stays the package's contract.
 *
 * `m0-resolvers.ts` is **deleted** as of M1. It held a one-person-per-email identity table
 * and a one-file-per-path table, both deliberately fake and loudly labelled, because a
 * half-real version of either is worse than an obvious placeholder: the failures are silent
 * and the report stays plausible. What replaces them:
 *
 * - `./identity.ts` — the five-step ladder of Part 8 §8.3.1, `.mailmap` first and
 *   authoritative, with bot detection and a recorded `mergeSource` on every person so a
 *   user can audit why two identities became one.
 * - `./renames.ts` — the alias-chain model of §8.3.2, including resurrection, upholding the
 *   three invariants of §8.8 that every downstream query assumes.
 */
export type { IdentityResolver } from './identity.js';
export {
  createIdentityResolver,
  emailDomain,
  HEURISTIC_NAME_SIMILARITY,
  isBotIdentity,
  jaroWinkler,
  normalizeEmail,
  normalizeName,
} from './identity.js';

export type { PathClassifier, RenameResolver } from './renames.js';
export { createRenameResolver, languageOf } from './renames.js';

export type { ParsedMessage } from './message.js';
export { coAuthors, messageQuality, splitCommitMessage } from './message.js';

export {
  BULK_FILE_THRESHOLD,
  classifyCommit,
  classifyPath,
  CODEMOD_UNIFORMITY,
  firstLine,
  isBinaryPath,
  isGenerated,
  isLockfile,
  isManifest,
  isTestPath,
  isVendored,
} from './noise.js';

/**
 * Read `.mailmap` from the working tree, if there is one.
 *
 * Absence is the common case and is not an error — most repositories have no mailmap, and
 * the resolver simply starts at step 2 of the ladder. A mailmap that exists but cannot be
 * read *is* worth surfacing, since silently ignoring the repository's own declaration of
 * identity would make ownership wrong in exactly the way the file exists to prevent.
 */
export async function readMailmap(backend: GitBackend): Promise<Mailmap | null> {
  return backend.readMailmap();
}

/** HEAD, or `null` for a repository with no commits yet. */
async function headOrNull(backend: GitBackend): Promise<Oid | null> {
  const refs = await backend.refs();
  return refs.find((ref) => ref.name === 'HEAD')?.target ?? null;
}

/** Similarity at or above this counts a delete+add pair as a rename (Part 8 §8.3.2 step 3, M2). */
export const DELETE_ADD_RENAME_SIMILARITY = 90;

/* ── Noise classification ──────────────────────────────────────────────────── */

/**
 * The classifier as an object, for a caller that wants to inject one.
 *
 * The implementations are the two pure functions re-exported above. There is no factory
 * because there is no state: classification is a function of a path or a commit and nothing
 * else, which is what makes it trivially testable and what makes the anti-embarrassment
 * test (no noise commit in the top 50 by significance) meaningful on any repository.
 */
export interface NoiseClassifier {
  classifyCommit(commit: RawCommit, isMerge: boolean): readonly CommitFlag[];
  classifyPath(path: string): readonly FileFlag[];
}

/* ── Incremental update ────────────────────────────────────────────────────── */

/**
 * LEAN-V1 §3.1 cuts targeted rebuild: a rewrite triggers a full rebuild with a
 * progress bar. It is rare, and the invalidation logic is not worth its bug surface.
 */
export type UpdateKind = 'up-to-date' | 'fast-forward' | 'history-rewritten';

export async function detectUpdateKind(
  backend: GitBackend,
  store: Store,
): Promise<UpdateKind> {
  const storedTip = store.meta.get(META_KEYS.indexedTip);
  if (storedTip === null || storedTip === '') {
    // Never indexed, or indexed by a build predating the marker. Either way the only safe
    // reading is "walk everything": claiming a fast-forward would skip history that was
    // never stored, and the result would be a silently short index.
    return 'history-rewritten';
  }

  const refs = await backend.refs();
  const currentTip = refs.find((ref) => ref.name === 'HEAD')?.target ?? null;
  if (currentTip === null) {
    // A repository whose HEAD is unborn has nothing to add. Reporting `up-to-date` would be
    // wrong if the stored index has commits (the history was deleted), so this is a rebuild.
    return 'history-rewritten';
  }
  if (currentTip === storedTip) return 'up-to-date';

  /* The distinction that matters: is the stored tip still an ancestor of the new one?
   *
   * If it is, every commit we indexed is still in the history and the new ones append to
   * it — a fast-forward, and the walk can be limited to `stored..HEAD`. If it is not, the
   * history was rewritten (rebase, amend, force-push, or a squash), and rows already stored
   * describe commits that no longer exist. LEAN-V1 §3.1 cuts targeted invalidation in favour
   * of a full rebuild: it is rare, and the invalidation logic is not worth its bug surface.
   *
   * A tip that is no longer *reachable at all* — the usual outcome of an amend — also lands
   * here, because `isAncestor` on a missing object is false rather than an error.
   */
  const stillContained = await backend.isAncestor(parseOid(storedTip), currentTip);
  return stillContained ? 'fast-forward' : 'history-rewritten';
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
