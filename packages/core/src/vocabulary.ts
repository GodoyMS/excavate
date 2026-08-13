/**
 * The normative domain vocabulary from Part 14 §14.4.
 *
 * These names are used identically in the code, the UI, the CLI, and the docs.
 * Vocabulary drift between surfaces is how a product starts feeling incoherent, so
 * the enumerations live in exactly one place.
 *
 * Union-of-string-literals rather than `enum`, because `erasableSyntaxOnly` bans
 * enums — and because these values are serialised across the daemon boundary,
 * where a string is the honest representation anyway.
 */

/* ── History projection ────────────────────────────────────────────────────── */

/**
 * The chosen linearisation of the DAG (Part 8 §8.2.2). History is a DAG, not a
 * line; making the projection explicit is what keeps the product honest about
 * merges.
 *
 * LEAN-V1 §3.1 cut the *UI multiplier*, not the concept: v1 exercises
 * `first-parent` only and states so plainly, with the others switchable in config.
 */
export const HISTORY_PROJECTIONS = [
  'first-parent',
  'topological',
  'author-date',
] as const;
export type HistoryProjection = (typeof HISTORY_PROJECTIONS)[number];
export const DEFAULT_PROJECTION: HistoryProjection = 'first-parent';

/* ── Indexing ──────────────────────────────────────────────────────────────── */

/** LEAN-V1 §3.3 trims four indexing tiers to two. */
export const TIERS = ['metadata', 'analysis'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * The indexing state machine of Part 8 §8.6.1, with the lean two-tier walk.
 *
 * Enumerated at runtime, not just as a type: this value is persisted in the index and read
 * back by a later process, so the reader has to be able to ask whether a string it found
 * on disk is a state it understands. A build that meets a state name from a *newer* build
 * must be able to say "I cannot interpret this" rather than comparing unknown strings.
 */
export const INDEX_STATES = [
  'uninitialized',
  'discovering',
  'walking',
  'analyzing',
  'ready',
  'stale',
  'failed',
] as const;
export type IndexState = (typeof INDEX_STATES)[number];

/* ── Ground truth ──────────────────────────────────────────────────────────── */

export type RefKind = 'branch' | 'tag' | 'remote' | 'head';

export type ChangeKind = 'add' | 'modify' | 'delete' | 'rename' | 'copy' | 'mode';

/**
 * Enumerated at runtime as well as in the type, because the ordinal is what the `hunks.kind`
 * column stores. A reordering here silently reinterprets every row already on disk, so the
 * order is part of the schema and the codec asserts against this list rather than a literal.
 */
export const HUNK_KINDS = ['content', 'whitespace-only', 'moved'] as const;
export type HunkKind = (typeof HUNK_KINDS)[number];

/* ── Typed relations ───────────────────────────────────────────────────────── */

/**
 * What one entity can be to another, stored in `links.link_kind`.
 *
 * `reverts` and `relands` are separate rather than one relation with a direction flag: they
 * answer different questions ("was this undone?" versus "was this brought back?"), both can
 * hold between the same pair, and a reader following one must not be shown the other by
 * accident. `references-pr` points a commit at the pull request that carried it, which is the
 * single highest-yield offline source of *why* — the number is usually in the subject line of
 * every squash-merged commit in the repository.
 */
export const LINK_KINDS = ['reverts', 'relands', 'references-pr'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * The kind of thing a link endpoint is, stored in `links.from_kind` / `to_kind`.
 *
 * `pull-request` has no table of its own: at M2 a PR is known only by its number, mined from
 * a commit message, so the endpoint id *is* the number. Inventing a `pull_requests` table to
 * hold one integer would imply we had fetched the PR — which needs the network, and M2 is
 * offline by construction.
 */
export const ENTITY_KINDS = ['commit', 'file', 'person', 'pull-request'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * How a link was derived, stored in `links.source` — the provenance half of the citation
 * contract, and ordered weakest to strongest for revert detection's three tiers
 * (Part 8 §8.5.3).
 *
 * - `subject-pattern` — the message *looks* like a revert ("Revert \"…\""), but nothing was
 *   verified. The weakest tier, and the one most likely to be wrong: a commit titled
 *   `Revert the retry logic` may be a hand-written change that reverts nothing.
 * - `message-trailer` — git's own `This reverts commit <sha>.`, or `PR-URL:`, `Change-Id`.
 *   The repository states the relation explicitly; we are reading, not guessing.
 * - `diff-inverse` — the diffs are computed inverses of each other. Independent of what
 *   anyone wrote, which is why it can confirm a revert whose message says nothing.
 *
 * Kept distinct from {@link Certainty} deliberately. Certainty is what *kind* of claim this
 * is; source is *how we came to make it*. A diff-inverse revert and a trailer-declared revert
 * are both `observed`, and a reader still deserves to know which one they are looking at.
 */
export const LINK_SOURCES = [
  'subject-pattern',
  'message-trailer',
  'diff-inverse',
] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

/**
 * Computed during indexing. The penalty flags are the mechanism by which noise is
 * excluded from significance ranking — without them, "the most significant commits
 * in this repo" reliably returns the Prettier migration and a lockfile refresh
 * (Part 8 §8.5.1).
 */
export type CommitFlag =
  | 'merge'
  | 'root'
  | 'revert'
  | 'reland'
  | 'empty'
  | 'signed'
  | 'format-only'
  | 'generated-only'
  | 'vendored-only'
  | 'lockfile-only'
  | 'bulk-mechanical';

/** LFS and submodule flags are deferred with their fixture cases (LEAN-V1 §3.3). */
export type FileFlag = 'generated' | 'vendored' | 'test' | 'binary';

/* ── Resolved identity ─────────────────────────────────────────────────────── */

/**
 * Why two identities were merged, in resolution order (Part 8 §8.3.1). Recorded so
 * the UI can explain the merge and the user can override it — a heuristic merge
 * presented as fact is exactly how an ownership model loses trust.
 */
export type MergeSource =
  'mailmap' | 'exact-email' | 'normalized-email' | 'name-and-domain' | 'heuristic';

/* ── Evidence ──────────────────────────────────────────────────────────────── */

/**
 * Three epistemically different things (Part 8 §8.4.1). "A revert exists", "our
 * algorithm thinks this commit caused that bug", and "a human wrote that this was
 * for performance" must not collapse into one — that is how tools become
 * confidently wrong.
 */
export type Certainty = 'observed' | 'inferred' | 'reported';

/**
 * The evidence kinds the six lean collectors can produce (LEAN-V1 §3.3).
 *
 * Deferred with their collectors: `review-comment` (forge, v1.2),
 * `co-change-pattern` / `doc-change` / `dependency-change` / `adjacent-comment`
 * (the four cut collectors), `fix-follows-feature` (SZZ, v1.3), and
 * `signature-change` (symbols, v1.4).
 */
export type EvidenceKind =
  | 'commit-message'
  | 'diff-hunk'
  | 'blame-attribution'
  | 'revert-pair'
  | 'reland'
  | 'pull-request-body'
  | 'issue-link'
  | 'trailer-ref'
  | 'temporal-neighbor'
  | 'test-addition'
  | 'rename-event';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Enumerated because confidence must be explainable, and computed *before*
 * generation (LEAN-V1 §4.5). A confidence score with no reasons attached is a
 * number the user has no way to check.
 */
export type ConfidenceReasonCode =
  /* Raising */
  | 'substantive-body'
  | 'pr-reference'
  | 'revert-reland-pair'
  | 'linked-issue'
  | 'test-sibling'
  | 'corroborating-evidence'
  /* Lowering */
  | 'terse-message'
  | 'squash-merge-only'
  | 'single-evidence'
  | 'no-pr-data'
  | 'stale-blame';

/** Named absences. Honest gaps are what make LOW confidence useful rather than a shrug. */
export type GapCode =
  | 'no-pr-body-cached'
  | 'no-forge-configured'
  | 'no-issue-link'
  | 'binary-file'
  | 'blame-unavailable'
  | 'partial-index';

/* ── Analysis ──────────────────────────────────────────────────────────────── */

/**
 * The five dimensions of the lean era detector (LEAN-V1 §3.3). Binary segmentation
 * over these produces near-identical output to 10-dimension PELT at the 3–12
 * segment granularity that actually ships.
 */
export const ERA_DIMENSIONS = [
  'commit-rate',
  'distinct-authors',
  'toplevel-dir-entropy',
  'loc-delta',
  'extension-mix',
] as const;
export type EraDimension = (typeof ERA_DIMENSIONS)[number];

/* ── Presentation ──────────────────────────────────────────────────────────── */

/** LEAN-V1 §3.3 drops Complexity, which was the weakest and overlapped Hotspot. */
export const LENSES = ['age', 'churn', 'ownership', 'hotspot', 'knowledge-risk'] as const;
export type LensId = (typeof LENSES)[number];

/** The views that survive into lean v1 (LEAN-V1 §3.1 cuts People, Decisions, Search). */
export const VIEWS = ['overview', 'story', 'timeline', 'map', 'files'] as const;
export type ViewId = (typeof VIEWS)[number];
