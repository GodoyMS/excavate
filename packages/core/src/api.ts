/**
 * The daemon boundary contract.
 *
 * This file is what `excavate-proto` + specta used to be (Part 13 §13.6). With a
 * TypeScript core, generated types vanish: the contract is a shared package, and
 * there is exactly one definition of every type that crosses the wire (LEAN-V1
 * §3.1).
 *
 * It lives in `@wise-excavate/core` rather than `@wise-excavate/server` on purpose. `ui`
 * needs these types and must not depend on `server` — that would pull Hono and
 * `node:*` into the browser build. Both sides depend on the contract; neither
 * depends on the other.
 *
 * Routes are added milestone by milestone. What is here is the M0 walking-skeleton
 * surface plus the streaming plane, which the daemon skeleton needs in M0.2.
 */

import type { ErrorPayload } from './errors.js';
import type { Oid, RepoId } from './ids.js';
import type { Timestamp } from './time.js';
import type { HistoryProjection, IndexState, MergeSource, Tier } from './vocabulary.js';

/** Bumped only on a breaking change to a shipped route or event. */
export const API_VERSION = 1;

/**
 * Non-negotiable, per Part 7 §7.4.2. Never `0.0.0.0`, not even behind a flag — a
 * localhost daemon holding a full index of proprietary code is an attractive
 * target, and remote use goes through SSH tunnelling.
 */
export const BIND_HOST = '127.0.0.1';

export const AUTH_HEADER = 'authorization';
export const AUTH_SCHEME = 'Bearer';

/**
 * Accepted on the initial navigation only, so `excavate .` can hand the browser a
 * URL it can open. The UI strips it from the address bar and uses the header
 * thereafter (LEAN-V1 §2.2).
 */
export const TOKEN_QUERY_PARAM = 'token';

export const ROUTES = {
  health: '/api/health',
  repoSummary: '/api/repo/summary',
  commits: '/api/commits',
  commit: '/api/commits/:oid',
  /** Server-sent events. Progress and streamed tokens are strictly server→client, which is why SSE replaces the WebSocket (LEAN-V1 §5). */
  events: '/api/events',
} as const;

/* ── Requests and responses ────────────────────────────────────────────────── */

export interface HealthResponse {
  readonly apiVersion: number;
  readonly serverVersion: string;
}

export interface RepoSummary {
  readonly repoId: RepoId;
  readonly root: string;
  readonly headOid: Oid;
  readonly indexState: IndexState;
  readonly commitCount: number;
  readonly personCount: number;
  readonly fileCount: number;
  readonly firstCommitAt: Timestamp | null;
  readonly lastCommitAt: Timestamp | null;
  /**
   * Set when the index is knowingly incomplete, with exactly what was skipped.
   * Never silent — this is the honest-degradation contract of Part 7 §7.7 and the
   * stated cost of running on very large repositories (LEAN-V1 §9.1).
   */
  readonly partial: PartialIndexBadge | null;
}

export interface PartialIndexBadge {
  readonly reason: 'too-large' | 'interrupted' | 'tier-failed';
  readonly skipped: string;
}

export interface CommitListQuery {
  readonly limit?: number;
  /** Opaque; pagination is designed in from the first route rather than retrofitted. */
  readonly cursor?: string;
  readonly projection?: HistoryProjection;
}

export interface CommitListResponse {
  readonly commits: readonly CommitSummaryDto[];
  readonly nextCursor: string | null;
  readonly projection: HistoryProjection;
}

/** The list row. Denormalised so the UI computes nothing analytical (boundary rule B4). */
export interface CommitSummaryDto {
  readonly oid: Oid;
  readonly subject: string;
  readonly authorName: string;
  readonly authoredAt: Timestamp;
  readonly insertions: number;
  readonly deletions: number;
  readonly filesChanged: number;
  readonly significance: number;
  readonly isMerge: boolean;
}

export interface CommitDetailDto extends CommitSummaryDto {
  readonly body: string | null;
  readonly parents: readonly Oid[];
  readonly committedAt: Timestamp;
  readonly committerName: string;
}

export interface ErrorResponse {
  readonly error: ErrorPayload;
}

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1_000;

/* ── The streaming plane ───────────────────────────────────────────────────── */

export interface JobRef {
  readonly id: string;
  readonly kind: 'index' | 'analysis' | 'narration' | 'why';
}

/**
 * Carried as JSON in the `data:` field of a single unnamed SSE stream.
 *
 * Every event is **advisory**: the client may miss events across a reconnect and
 * must reconcile by re-querying. Progress is never the source of truth for state
 * (Part 7 §7.4.4).
 */
export type ServerEvent =
  | {
      readonly type: 'index.progress';
      readonly tier: Tier;
      readonly done: number;
      /** `null` while the total is still unknown — the walk streams. */
      readonly total: number | null;
      readonly note?: string;
    }
  | { readonly type: 'index.tier_complete'; readonly tier: Tier }
  | {
      readonly type: 'index.invalidated';
      readonly reason: 'refs_changed' | 'history_rewritten';
    }
  | { readonly type: 'job.started'; readonly job: JobRef }
  | { readonly type: 'job.progress'; readonly job: JobRef; readonly fraction: number }
  | { readonly type: 'job.done'; readonly job: JobRef }
  | { readonly type: 'job.failed'; readonly job: JobRef; readonly error: ErrorPayload }
  /* AI events exist in the contract from M0 so the UI's event handling is written
     once. They are simply never emitted until M7. */
  | { readonly type: 'ai.token'; readonly job: JobRef; readonly text: string }
  | {
      readonly type: 'ai.budget';
      readonly spentUsd: number;
      readonly remainingUsd: number | null;
    }
  | {
      readonly type: 'log';
      readonly level: 'debug' | 'info' | 'warn' | 'error';
      readonly message: string;
    };

export type ServerEventType = ServerEvent['type'];

/* ── The stats report ──────────────────────────────────────────────────────── */

/**
 * Everything `excavate stats` and M3's Overview both display.
 *
 * **Assembled by the daemon, rendered by a presentation surface** — which is boundary rule B4
 * with the CLI included in "UI". The alternative, letting each surface query the store itself,
 * is how the terminal and the browser start disagreeing about the same repository; and Part 7
 * §7.3 names that divergence as the specific thing B4 exists to prevent. It is also why this
 * type lives in `core`: the CLI must not depend on `store` to read it.
 */
export interface StatsReport {
  readonly summary: RepoSummary;
  readonly knowledgeIslands: readonly IslandReport[];
  readonly hotspots: readonly HotspotReport[];
  readonly significantCommits: readonly CommitSummaryDto[];
  readonly people: readonly PersonReport[];
  /**
   * The cast's tail: people not in {@link people}, and the commits they hold between them.
   *
   * Counted here rather than derived by the renderer from `summary.commitCount`, because the two
   * differ by every bot commit — on `rust-analyzer` that is bors's 2,786, so subtracting the
   * listed humans from the repository total credited the tail with a bot's entire output.
   */
  readonly otherPeople: number;
  readonly otherCommits: number;
  /** The instant knowledge decay was measured from, so a consumer can say "as of". */
  readonly generatedFor: Timestamp;
}

export interface IslandReport {
  readonly path: string;
  readonly busFactor: number;
  readonly entropy: number;
  readonly ownerName: string | null;
  readonly ownerLastSeen: Timestamp | null;
  /** The top owner's decayed share, 0..1. */
  readonly topShare: number;
}

/** The factors travel with the score, because Part 8 §8.5.3 forbids showing one without them. */
export interface HotspotReport {
  readonly path: string;
  readonly score: number;
  readonly churn: number;
  readonly complexity: number;
  readonly recency: number;
  readonly fixDensity: number;
  readonly changeCount: number;
}

export interface PersonReport {
  readonly name: string;
  readonly email: string;
  readonly commits: number;
  readonly firstSeen: Timestamp;
  readonly lastSeen: Timestamp;
  readonly mergeSource: MergeSource;
}
