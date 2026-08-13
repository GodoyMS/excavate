/**
 * The repository session lifecycle of Part 7 §7.5, which is the daemon's unit of work:
 * resolve the repository to a stable `RepoId`, locate or create its index, migrate the
 * schema, then serve instantly or walk the difference.
 *
 * This is the composition root's real job. Every dependency the pipeline needs is wired
 * here and nowhere else (Part 14 §14.2), which is what lets `index`, `analysis`,
 * `evidence`, and `ai` stay unaware of each other.
 *
 * It is also where the honest-degradation contract of Part 7 §7.7 is either kept or
 * broken, because this file is the only place that sees both what the indexer did and
 * what a client is told. Two rules follow from that and are load-bearing below: a tier is
 * never announced complete unless it was built, and a partial index is never reported as
 * a whole one.
 */

import { mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  IndexState,
  Oid,
  PartialIndexBadge,
  RepoId,
  RepoSummary,
  Tier,
  Timestamp,
} from '@wise-excavate/core';
import {
  ExcavateError,
  TIERS,
  isExcavateError,
  parseOid,
  repoId as brandRepoId,
  fromDate,
  timestamp,
  toErrorPayload,
} from '@wise-excavate/core';
import type { GitBackend } from '@wise-excavate/git';
import { CliGitBackend, DEFAULT_WALK_SPEC, discoverRepository } from '@wise-excavate/git';
/* `META_KEYS` rather than the literal strings: the walk writes these rows and the daemon
   reads them, so a key spelled two ways in two packages is a bug neither the typechecker
   nor a unit test would catch — it would simply report `null` forever. */
import { runAnalysis } from '@wise-excavate/analysis';
import { META_KEYS, computeRepoId, createIndexPipeline } from '@wise-excavate/index';
import type { Store } from '@wise-excavate/store';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';

import { createProgressBus } from './bus.js';
import type { RepoSession, ServerOptions } from './index.js';
import { createJobQueue } from './jobs.js';

/** The directory name under the platform cache root. Indexes are keyed by `RepoId` inside it. */
const CACHE_NAMESPACE = 'excavate';

/**
 * One walk at a time per session. It is the only scheduling constraint that has ever
 * mattered here (LEAN-V1 §3.1), and running two walks against one SQLite file would be
 * both slower and wrong.
 */
const SESSION_CONCURRENCY = 1;

/** Git's null object id, used only when a repository has no commits yet to name a HEAD with. */
const NULL_OID: Oid = parseOid('0'.repeat(40));

/**
 * The tiers this release builds.
 *
 * Both, as of M1. At M0 this held `metadata` alone and existed to stop the daemon announcing
 * `index.tier_complete` for a tier nothing had written — a partial index reported as whole,
 * which is the failure Part 7 §7.7 forbids. That risk is gone now that `runAnalysis` exists,
 * but the constant stays: it is what `unbuiltTiers` compares against, and the next tier to be
 * specified before it is implemented (eras, at M5) will need exactly this guard again.
 */
export const IMPLEMENTED_TIERS: readonly Tier[] = ['metadata', 'content', 'analysis'];

/** The requested tiers this release cannot build. */
export function unbuiltTiers(requested: readonly Tier[]): readonly Tier[] {
  return requested.filter((tier) => !IMPLEMENTED_TIERS.includes(tier));
}

/**
 * The badge for an index that is missing whole tiers. `tier-failed` is the same reason
 * `@wise-excavate/index` records for the same situation — from the caller's side "not written
 * yet" is a failure to produce the tier — and using a different one would make the two
 * halves of the same fact disagree.
 */
export function tierGapBadge(missing: readonly Tier[]): PartialIndexBadge | null {
  if (missing.length === 0) return null;
  return {
    reason: 'tier-failed',
    skipped: `${missing.join(', ')} tier${missing.length === 1 ? '' : 's'} — not built by this release`,
  };
}

export async function openSession(options: ServerOptions): Promise<RepoSession> {
  const { root } = await discoverRepository(options.repoRoot);
  const backend = new CliGitBackend({ repoRoot: root });

  /* Both git reads happen before the store is opened, so a failure in either cannot leak
     an open SQLite handle (and, on Windows, a locked file). */
  const rootOid = await rootCommitOid(backend);
  const headOid = await currentHead(backend);

  const id = brandRepoId(computeRepoId(rootOid, resolve(root)));
  /* `openStore` creates the directory for the file it is given, but the index *directory*
     is the unit the user deletes to force a rebuild, so it is created explicitly. */
  const store = openStore({
    path: join(ensureIndexDir(options, id), INDEX_FILE_NAME),
    repoId: id,
  });

  /* No `store.migrate()` here: `openStore` migrates before it returns a handle, and
     calling it a second time only re-reads the schema version. */

  /* Part 7 §7.7 wants a corrupt index detected on open — but `PRAGMA integrity_check`
     reads every page of a file that is ~130 MB for a 100k-commit repository, and
     `@wise-excavate/store` is explicit that paying that on every open trades the thing the
     product is judged on (how fast reopening feels) for a check that only matters after a
     crash. So it is opt-in, and the daemon has nothing to base "reason to distrust" on
     until the store exposes the durable index state. `excavate doctor` (M6) passes it. */
  if (options.verifyIntegrity === true) {
    const integrity = store.integrityCheck();
    if (!integrity.ok) {
      store.close();
      throw new ExcavateError(
        'INDEX_CORRUPT',
        `index at ${store.path} failed its integrity check`,
        { details: { problems: integrity.problems } },
      );
    }
  }

  const bus = createProgressBus();
  const jobs = createJobQueue(SESSION_CONCURRENCY);

  /** Tiers this session will not walk again, whether or not the walk produced them. */
  const attempted = new Set<Tier>();
  /** Tiers the index is known *not* to contain. Drives `RepoSummary.partial`. */
  const unbuilt = new Set<Tier>();
  /** Set when a walk was cancelled, holding what the indexer said it got through. */
  let interrupted: string | null = null;

  let state: IndexState;
  if (store.commits.count() > 0) {
    /* An index this session did not build.
     *
     * It is taken as-is rather than re-walked: `detectUpdateKind` — the "compare stored
     * refs against current refs, then serve instantly or walk the difference" half of
     * Part 7 §7.5 — is a `NotImplementedError` until M1, and `@wise-excavate/store`'s
     * `insertCommits` is a plain INSERT, so a second walk over a populated index would
     * collide on every primary key rather than update anything.
     *
     * Every tier counts as attempted for the same reason, and the tiers this release
     * cannot build are recorded as missing: no build of Excavate has ever written an
     * `analysis` tier, so an existing index provably lacks one and saying so costs
     * nothing. What the session must not do is stay silent about it.
     *
     * **The state comes from the index, not from the row count.** A walk that was killed
     * or that failed persists `stale`/`failed` and a badge naming what it missed; a
     * populated file therefore does not imply a complete one, and inferring `ready` from
     * `count() > 0` reported a truncated history as whole — the precise failure Part 7 §7.7
     * and LEAN-V1 §9.1 forbid. `null` means no walk ever recorded a state (an index from a
     * build predating `setIndexState`, or one whose meta row is unreadable); `stale` is the
     * honest reading of that, because the one thing that cannot be claimed is completeness.
     */
    state = store.meta.indexState() ?? 'stale';
    for (const tier of TIERS) attempted.add(tier);
    for (const tier of unbuiltTiers(TIERS)) unbuilt.add(tier);
    interrupted = durableInterruption(store);
  } else {
    state = 'uninitialized';
  }

  /**
   * `interrupted` outranks a tier gap: a truncated history is the more serious omission,
   * and `PartialIndexBadge` carries one reason.
   */
  const partialBadge = (): PartialIndexBadge | null =>
    interrupted === null
      ? tierGapBadge([...unbuilt])
      : { reason: 'interrupted', skipped: interrupted };

  /**
   * The guard against two concurrent indexing runs on one session. Both the CLI's
   * `ensureIndexed` and an HTTP client's first request can arrive within the same tick,
   * and the second one must join the first run rather than start a competing walk.
   */
  let inFlight: Promise<void> | null = null;

  const runIndex = async (tiers: readonly Tier[], signal: AbortSignal): Promise<void> => {
    const job = { id: `index-${id}`, kind: 'index' } as const;
    bus.publish({ type: 'job.started', job });
    state = 'walking';
    try {
      const pipeline = createIndexPipeline({
        backend,
        store,
        /* M1 introduces the walk sinks — identity merging, rename resolution, noise
           classification — and wires them here, in the one place that may know about all
           of them. Until then the pipeline has nothing to fan out to. */
        sinks: [],
        walkSpec: DEFAULT_WALK_SPEC,
      });

      /* The metadata tier *is* the walk. Analysis is a second pass over the rows it wrote,
         driven from here rather than from inside the pipeline because `@wise-excavate/index`
         may not depend on `@wise-excavate/analysis` — composition belongs to the composition
         root, and that is this file (Part 14 §14.2). */
      for await (const progress of pipeline.run({ tiers: ['metadata'], signal })) {
        bus.publish({
          type: 'index.progress',
          tier: progress.tier,
          done: progress.done,
          total: progress.total,
          ...(progress.note === null ? {} : { note: progress.note }),
        });
      }
      bus.publish({ type: 'index.tier_complete', tier: 'metadata' });

      if (tiers.includes('analysis')) {
        state = 'analyzing';
        bus.publish({
          type: 'index.progress',
          tier: 'analysis',
          done: 0,
          total: null,
          note: 'scoring commits, ownership, and hotspots',
        });
        const summary = await runAnalysis({
          store,
          /* Read-time decay is measured from now. Passed in rather than read inside the
             analyzer so a test can pin it, and so the *only* wall-clock read in the whole
             indexing path is this one — which is what keeps the determinism test meaningful,
             since nothing derived from it is stored. */
          now: nowTimestamp(),
          signal,
          throughOid: headOid,
        });
        bus.publish({
          type: 'index.progress',
          tier: 'analysis',
          done: summary.commitsScored,
          total: summary.commitsScored,
          note: `${summary.filesRanked} files ranked · ${summary.islands} knowledge ${summary.islands === 1 ? 'island' : 'islands'}`,
        });
        bus.publish({ type: 'index.tier_complete', tier: 'analysis' });
      }

      for (const tier of tiers) attempted.add(tier);
      for (const tier of unbuiltTiers(tiers)) unbuilt.add(tier);
      interrupted = null;
      state = 'ready';
      bus.publish({ type: 'job.done', job });
    } catch (error) {
      if (isExcavateError(error) && error.code === 'CANCELLED') {
        /* `@wise-excavate/index` commits the rows it already had and marks the durable state
           `stale` with an `interrupted` badge *before* throwing `CANCELLED`, so a
           cancelled walk leaves a usable partial index. Reporting that as `failed` would
           overstate it; reporting it as `ready` would hide it. The tiers are marked
           attempted because there is no incremental resume at M0 and a second walk over
           the rows already stored would collide on their primary keys — so the badge is
           the only thing standing between the user and a partial history presented as a
           whole one. */
        state = 'stale';
        interrupted = interruptedAt(error);
        for (const tier of tiers) attempted.add(tier);
      } else {
        state = 'failed';
      }
      bus.publish({ type: 'job.failed', job, error: toErrorPayload(error) });
      throw error;
    }
  };

  return {
    repoId: id,
    root,
    store,
    backend,
    bus,

    summary(): RepoSummary {
      return {
        repoId: id,
        root,
        headOid,
        indexState: state,
        commitCount: store.commits.count(),
        personCount: store.people.count(),
        fileCount: store.files.count(),
        /* Read back from the meta rows the walk wrote (`META_KEYS` in `@wise-excavate/index`)
           through `Store.meta`, so the SQL stays inside the store and boundary rule B2
           holds. A missing or malformed pair still yields `null`, and `formatIndexSummary`
           in the CLI omits the range rather than guessing one. */
        firstCommitAt: metaTimestamp(
          store,
          META_KEYS.firstCommitAt,
          META_KEYS.firstCommitOffset,
        ),
        lastCommitAt: metaTimestamp(
          store,
          META_KEYS.lastCommitAt,
          META_KEYS.lastCommitOffset,
        ),
        partial: partialBadge(),
      };
    },

    async ensureIndexed(tiers: readonly Tier[]): Promise<void> {
      /* A run already under way covers the walk, so joining it beats starting a second
         one even when this caller asked for a tier the running one did not. Per-tier
         scheduling waits until a second tier actually exists (M1); today every caller
         asks for `TIERS`. */
      if (inFlight !== null) return inFlight;
      if (tiers.every((tier) => attempted.has(tier))) return;

      inFlight = jobs
        .submit('index', (signal) => runIndex(tiers, signal))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/**
 * How far a cancelled walk got, phrased for `PartialIndexBadge.skipped` — which is
 * rendered as "incomplete index — indexing was interrupted: <skipped>".
 *
 * The count comes from the error's structured details rather than its message, because
 * parsing a message is how two packages start depending on each other's prose.
 */
/**
 * The interruption an *earlier* process recorded, if any.
 *
 * `@wise-excavate/index` flattens `PartialIndexBadge` into two meta rows and writes the empty
 * string for "not partial", because `Transaction` has no delete and absence has to be
 * representable. Only an `interrupted` reason is carried over: a `tier-failed` badge is
 * recomputed from `unbuiltTiers` on every open and is therefore always current, whereas a
 * truncated history is a fact about the stored rows that no later run can re-derive.
 */
function durableInterruption(store: Store): string | null {
  if (store.meta.get(META_KEYS.partialReason) !== 'interrupted') return null;
  const skipped = store.meta.get(META_KEYS.partialSkipped);
  return skipped !== null && skipped !== '' ? skipped : 'an unknown part of the history';
}

/**
 * A `Timestamp` from the two meta rows the walk wrote for it. Both must be present and
 * parse as integers; a half-written or malformed pair reads as absent, since a plausible
 * wrong date on the Overview is worse than a missing one.
 */
function metaTimestamp(store: Store, atKey: string, offsetKey: string): Timestamp | null {
  const at = Number(store.meta.get(atKey));
  const offset = Number(store.meta.get(offsetKey));
  if (store.meta.get(atKey) === null || !Number.isSafeInteger(at)) return null;
  return timestamp(at, Number.isSafeInteger(offset) ? offset : 0);
}

/**
 * The one wall-clock read in the indexing path.
 *
 * Knowledge decay is measured from "now" and nothing derived from it is stored, which is what
 * keeps the determinism test honest: index the same history twice and every stored row matches,
 * because this value only ever reaches a computation whose output is also recomputed.
 */
function nowTimestamp(): Timestamp {
  return fromDate(new Date());
}

function interruptedAt(error: ExcavateError): string {
  const walked = error.details['walked'];
  return typeof walked === 'number'
    ? `history after ${walked} commits`
    : 'an unknown part of the history';
}

/**
 * Where an index lives when the user has not said.
 *
 * XDG-style, keyed by `RepoId`: two worktrees of the same project get separate indexes,
 * and a repository that moves on disk keeps its own. Windows and macOS get their
 * conventional cache roots rather than a Unix-shaped `~/.cache`, because a cache
 * directory in the wrong place is a directory the OS will not clean up.
 */
export function defaultIndexDir(id: RepoId): string {
  return join(cacheRoot(), CACHE_NAMESPACE, id);
}

function cacheRoot(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  if (xdg !== undefined && xdg !== '' && isAbsolute(xdg)) return xdg;

  const home = homedir();
  const os = platform();
  if (os === 'win32') {
    const local = process.env['LOCALAPPDATA'];
    return local !== undefined && local !== '' ? local : join(home, 'AppData', 'Local');
  }
  if (os === 'darwin') return join(home, 'Library', 'Caches');
  return join(home, '.cache');
}

function ensureIndexDir(options: ServerOptions, id: RepoId): string {
  const dir = options.indexDir ?? defaultIndexDir(id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * `RepoId` is `hash(root_commit_oid + canonical_path)` (Part 7 §7.5): the root commit is
 * what lets a repository that moved on disk reuse its index, and the path is what stops
 * two worktrees from colliding.
 *
 * **`GitBackend` has no `rootCommit()`, and this stand-in is expensive enough to be a
 * blocker rather than a nicety.** `walkArgs` always passes `--reverse`, so the first
 * commit off a walk is the earliest one — but `--reverse` makes git buffer the whole
 * traversal before printing anything, and the walk carries `--raw --numstat`, so naming
 * the index costs a complete diff-computing pass over history on *every* session open,
 * warm index or not. `findCopies` is turned off here because copy detection is the most
 * expensive part of that and nothing in this function looks at a change; the traversal
 * itself cannot be avoided through `WalkSpec`. `includeAllRefs: false` keeps the answer
 * meaningful as well as cheaper: the root of HEAD's first-parent spine, not whichever ref
 * tip happens to sort first.
 *
 * A repository with no commits has no root and keys on its path alone; its `RepoId`
 * therefore changes when its first commit lands, which is correct — a different history
 * deserves a different index.
 *
 * Replace all of this with `GitBackend.rootCommit()` (one `git rev-list --max-parents=0`)
 * in M1 and delete the function.
 */
async function rootCommitOid(backend: GitBackend): Promise<string> {
  for await (const commit of backend.walk({
    ...DEFAULT_WALK_SPEC,
    projection: 'first-parent',
    includeAllRefs: false,
    findCopies: false,
  })) {
    return commit.oid;
  }
  return '';
}

/**
 * Captured once at open, because `RepoSummary` is synchronous and reading HEAD is not.
 * A HEAD that moves under a running daemon shows up as `index.invalidated` on the event
 * stream, which is the mechanism that is supposed to notice it.
 *
 * Read through `refs()` rather than `head()` and a `catch`, deliberately. `refs()` is the
 * accessor that swallows exactly the unborn-HEAD failure and rethrows everything else, so
 * "this repository has no commits" stays distinguishable from "we could not find out" —
 * collapsing those two is the confusion `@wise-excavate/git` exists to prevent, and a session
 * that reported the null oid because git had gone missing would be lying quietly.
 */
async function currentHead(backend: GitBackend): Promise<Oid> {
  const refs = await backend.refs();
  return refs.find((ref) => ref.name === 'HEAD')?.target ?? NULL_OID;
}
