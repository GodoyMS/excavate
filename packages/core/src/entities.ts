/**
 * Domain entities, per Part 8.
 *
 * The layer rule from Part 8 §8.1 is load-bearing and holds in the type graph
 * below: **higher layers may never be inputs to lower layers.** No analysis reads a
 * narrative; no ground-truth record is amended by an interpretation. That is what
 * keeps the whole index deterministically rebuildable from `.git` alone.
 *
 * Deliberately absent at v1, per LEAN-V1 §1 ("~40% of the entities aren't needed at
 * v1"): `Symbol` / `SymbolVersion` (v1.4, with tree-sitter), `Decision` (post-v1),
 * `Link` (its one v1 use, revert/re-land, is modelled directly as `RevertPair`),
 * `PullRequest` / `Issue` as stored entities (v1.2, with the forge connector — v1
 * mines PR *references* from commit messages instead).
 */

import type {
  CommitId,
  EraId,
  EvidenceId,
  FileId,
  Oid,
  PathId,
  PersonId,
  ReleaseId,
  TagId,
  BundleHash,
} from './ids.js';
import type { Timestamp, TimeWindow } from './time.js';
import type {
  Certainty,
  ChangeKind,
  CommitFlag,
  ConfidenceLevel,
  ConfidenceReasonCode,
  EraDimension,
  EvidenceKind,
  FileFlag,
  GapCode,
  HunkKind,
  MergeSource,
  RefKind,
} from './vocabulary.js';

/** A 1-based, inclusive line range — the convention Git, editors, and humans share. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/* ── Layer 1: ground truth (immutable, straight from Git objects) ───────────── */

export interface Commit {
  readonly id: CommitId;
  readonly oid: Oid;
  readonly tree: Oid;
  readonly parents: readonly CommitId[];
  readonly author: PersonId;
  readonly committer: PersonId;
  readonly authoredAt: Timestamp;
  readonly committedAt: Timestamp;
  readonly subject: string;
  readonly body: string | null;
  /** Parsed, not merely stored: `Co-authored-by` feeds ownership, `PR-URL` and `Fixes:` feed evidence. */
  readonly trailers: readonly Trailer[];
  /** Commit-graph generation number. Makes ancestry a near-constant-time test, which is what makes time-filtered views feasible (Part 8 §8.2.1). */
  readonly generation: number;
  readonly flags: readonly CommitFlag[];
  readonly significance: number;
}

export interface Trailer {
  readonly key: string;
  readonly value: string;
}

/** The fact table, and the largest in the index at ~5 rows per commit. */
export interface Change {
  readonly commit: CommitId;
  /** Resolved identity, never a raw path — this is what survives renames. */
  readonly file: FileId;
  readonly kind: ChangeKind;
  readonly oldPath: PathId | null;
  readonly newPath: PathId | null;
  /** 0–100, for `rename` and `copy` only. */
  readonly similarity: number | null;
  readonly insertions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
}

export interface Hunk {
  readonly commit: CommitId;
  readonly file: FileId;
  readonly oldStart: number;
  readonly oldLen: number;
  readonly newStart: number;
  readonly newLen: number;
  readonly kind: HunkKind;
}

export interface Ref {
  readonly name: string;
  readonly kind: RefKind;
  readonly target: CommitId;
  readonly isHead: boolean;
}

export interface Tag {
  readonly id: TagId;
  readonly name: string;
  readonly target: CommitId;
  readonly tagger: PersonId | null;
  readonly taggedAt: Timestamp | null;
  readonly message: string | null;
}

/** Inferred from tags that parse as versions. Gives the Timeline its most useful markers and eras their snap points. */
export interface Release {
  readonly id: ReleaseId;
  readonly tag: TagId;
  readonly version: string | null;
  readonly releasedAt: Timestamp;
  readonly prev: ReleaseId | null;
  readonly commitRange: readonly [CommitId, CommitId];
}

/* ── Layer 2: resolved identity (derived, algorithm-versioned) ──────────────── */

export interface Identity {
  readonly name: string;
  readonly email: string;
}

export interface Person {
  readonly id: PersonId;
  readonly canonicalName: string;
  readonly canonicalEmail: string;
  /** Every `(name, email)` pair seen for this person. */
  readonly identities: readonly Identity[];
  readonly firstSeen: Timestamp;
  readonly lastSeen: Timestamp;
  readonly commitCount: number;
  readonly mergeSource: MergeSource;
  /** Bots are retained for provenance but excluded from ownership and the cast of characters. */
  readonly isBot: boolean;
}

/**
 * The hardest identity problem in the project, and the one whose failure is most
 * visible (Part 8 §8.3.2). Named `FileEntity` rather than `File` so it never
 * shadows the DOM `File` inside `@wise-excavate/ui`; the domain term stays "file"
 * everywhere a human reads it.
 */
export interface FileEntity {
  readonly id: FileId;
  /** `null` when the file does not exist at HEAD. */
  readonly currentPath: PathId | null;
  readonly aliases: readonly PathAlias[];
  readonly born: CommitId;
  readonly died: CommitId | null;
  readonly language: string | null;
  readonly flags: readonly FileFlag[];
}

/**
 * Aliases must remain non-overlapping in commit-time (Part 8 §8.8, invariant 2) or
 * every downstream query breaks. This is why a copy gets a new `FileId` with a
 * `copiedFrom` link rather than an alias.
 */
export interface PathAlias {
  readonly path: PathId;
  readonly from: CommitId;
  readonly to: CommitId | null;
}

/* ── Layer 3: derived analysis (recomputable from layers 1–2) ───────────────── */

/**
 * Stored as incremental state: an accumulated value plus the time it was computed
 * at, with decay applied lazily at read. That is what makes incremental
 * re-indexing cheap (Part 8 §8.5.2).
 */
export interface Knowledge {
  readonly file: FileId;
  readonly person: PersonId;
  readonly accumulated: number;
  readonly computedAt: Timestamp;
}

export interface Ownership {
  readonly file: FileId;
  /** Normalised knowledge distribution, descending. */
  readonly shares: readonly OwnershipShare[];
  /** Fewest people whose combined knowledge reaches 50%. */
  readonly busFactor: number;
  /** Shannon entropy of the distribution. */
  readonly entropy: number;
  /** `busFactor === 1` and the top owner has been inactive for over six months. */
  readonly isKnowledgeIsland: boolean;
}

export interface OwnershipShare {
  readonly person: PersonId;
  readonly share: number;
}

/** Reported only above a support threshold, to suppress coincidence. */
export interface Coupling {
  readonly a: FileId;
  readonly b: FileId;
  readonly coChanges: number;
  /** `coChanges / min(changes(a), changes(b))`. */
  readonly strength: number;
  readonly window: TimeWindow;
}

/** Never shown as a bare number — always with this breakdown and links to the commits. */
export interface Hotspot {
  readonly file: FileId;
  readonly score: number;
  readonly factors: {
    readonly churn: number;
    readonly complexity: number;
    readonly recency: number;
    readonly fixDensity: number;
  };
}

/**
 * The single highest-value evidence type in the product: the repository literally
 * recording "we tried this, it was wrong, we fixed it and tried again."
 */
export interface RevertPair {
  readonly reverted: CommitId;
  readonly revertedBy: CommitId;
  readonly relandedBy: CommitId | null;
  /** `observed` for an explicit or diff-inverse revert; `inferred` for message-based. */
  readonly certainty: Certainty;
}

export interface Era {
  readonly id: EraId;
  readonly window: TimeWindow;
  readonly startCommit: CommitId;
  readonly endCommit: CommitId;
  /** Template-generated at v1.0; model-generated from v1.1. */
  readonly name: string | null;
  /** Always cited when present. `null` on the no-key path. */
  readonly summary: string | null;
  readonly boundaryReason: BoundaryReason;
  readonly keyCommits: readonly CommitId[];
  readonly keyPeople: readonly PersonId[];
  readonly releases: readonly ReleaseId[];
  readonly metrics: EraMetrics;
}

/**
 * User-visible, and non-optional: "eras that cannot explain themselves are not
 * trustworthy" (Part 8 §8.5.4).
 */
export interface BoundaryReason {
  readonly dimensions: readonly EraDimension[];
  readonly zScore: number;
  readonly snappedToRelease: ReleaseId | null;
  readonly description: string;
}

export interface EraMetrics {
  readonly commitCount: number;
  readonly distinctAuthors: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly filesTouched: number;
}

/* ── Layer 4: interpretation (cited, carries confidence) ────────────────────── */

/** The thing a Why question is about. Symbol targets arrive with symbols in v1.4. */
export type Target =
  | { readonly kind: 'line'; readonly file: FileId; readonly range: LineRange }
  | { readonly kind: 'file'; readonly file: FileId }
  | { readonly kind: 'directory'; readonly path: string };

/** A machine-resolvable pointer. Every claim in the product resolves to one of these. */
export type Locator =
  | { readonly kind: 'commit'; readonly oid: Oid }
  | { readonly kind: 'commit-range'; readonly from: Oid; readonly to: Oid }
  | {
      readonly kind: 'file-lines';
      readonly oid: Oid;
      readonly path: string;
      readonly range: LineRange;
    }
  | {
      readonly kind: 'pull-request';
      readonly number: number;
      readonly url: string | null;
    }
  | { readonly kind: 'issue'; readonly number: number; readonly url: string | null }
  | { readonly kind: 'trailer'; readonly oid: Oid; readonly key: string };

export interface Evidence {
  readonly id: EvidenceId;
  readonly kind: EvidenceKind;
  readonly locator: Locator;
  /** Human-readable, capped at `EXCERPT_MAX_CHARS`. */
  readonly excerpt: string;
  readonly occurredAt: Timestamp;
  /** 0–1, from the ranker. */
  readonly relevance: number;
  readonly certainty: Certainty;
}

export const EXCERPT_MAX_CHARS = 400;

export interface ConfidenceReason {
  readonly code: ConfidenceReasonCode;
  readonly detail: string | null;
}

export interface Confidence {
  readonly level: ConfidenceLevel;
  readonly score: number;
  readonly reasons: readonly ConfidenceReason[];
}

/** A named absence — "no PR body cached" — which drives honest messaging. */
export interface Gap {
  readonly code: GapCode;
  readonly message: string;
}

/**
 * The product's central artifact. Note what it is *not*: it contains no prose. The
 * bundle is a complete, useful answer on its own, which is what makes the no-key
 * path genuinely good rather than a degraded stub (Part 7 §7.2.4).
 */
export interface EvidenceBundle {
  readonly target: Target;
  /** Ranked, with stable `E1`…`En` IDs. */
  readonly items: readonly Evidence[];
  readonly confidence: Confidence;
  readonly gaps: readonly Gap[];
  /** Caching and reproducibility key. Stable across runs given identical inputs (Part 8 §8.8, invariant 12). */
  readonly hash: BundleHash;
}
