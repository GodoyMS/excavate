/**
 * `@excavate/evidence` — the heart of the product.
 *
 * **Responsibility.** Given a target, assemble a ranked, budget-fitted
 * `EvidenceBundle`.
 *
 * **Non-goals.** It does not generate prose and it does not call a model. It
 * produces the input prose generation consumes — and, critically, it produces a
 * *complete, useful answer on its own*. That is what makes the no-key path genuinely
 * good rather than a degraded stub.
 *
 * The gate at the end of M2 is binding: five people who have never seen the tool must
 * be able to explain unfamiliar code from this output alone, with no prose. If they
 * can't, the fix is evidence *ranking*, here — not an LLM later.
 *
 * ---
 *
 * **Deliberate deviation from Part 14 §14.2: this package does not depend on
 * `@excavate/analysis`.**
 *
 * Every analysis output it needs — revert pairs, coupling, ownership — is read from
 * the store's rollup tables, which is precisely what boundary rule B2 buys. Dropping
 * the edge means analyzers and collectors can be developed and tested independently,
 * and the composition order stays the sole responsibility of the composition root
 * (`@excavate/server`).
 */

import type {
  CollectorId,
  Confidence,
  Evidence,
  EvidenceBundle,
  Gap,
  Target,
} from '@excavate/core';
import { NotImplementedError, collectorId } from '@excavate/core';
import type { GitBackend } from '@excavate/git';
import type { Store } from '@excavate/store';

export interface EvidenceContext {
  readonly store: Store;
  /** Blame is the one collector input that must come from the repository. */
  readonly backend: GitBackend;
  readonly signal: AbortSignal;
}

export interface EvidenceCollector {
  readonly id: CollectorId;
  /** Cheap predicate. A collector that cannot contribute to this target is never run. */
  appliesTo(target: Target): boolean;
  collect(target: Target, ctx: EvidenceContext): Promise<readonly Evidence[]>;
}

/**
 * Six collectors, down from ten (LEAN-V1 §3.3). Dropped: CoChange, DocChange,
 * AdjacentComment, DependencyChange — the four lowest-yield and the easiest to add
 * back later. ForgeCollector arrives with the GitHub connector in v1.2.
 */
export const COLLECTOR_IDS = {
  blame: collectorId('blame'),
  commitContext: collectorId('commit-context'),
  prReference: collectorId('pr-reference'),
  revertPair: collectorId('revert-pair'),
  temporalNeighbor: collectorId('temporal-neighbor'),
  testSibling: collectorId('test-sibling'),
} as const;

function unimplementedCollector(id: CollectorId, milestone: string): EvidenceCollector {
  return {
    id,
    appliesTo: () => {
      throw new NotImplementedError(`${id} collector`, milestone);
    },
    collect: () => {
      throw new NotImplementedError(`${id} collector`, milestone);
    },
  };
}

export const blameCollector = unimplementedCollector(COLLECTOR_IDS.blame, 'M2');
export const commitContextCollector = unimplementedCollector(
  COLLECTOR_IDS.commitContext,
  'M2',
);
export const prReferenceCollector = unimplementedCollector(
  COLLECTOR_IDS.prReference,
  'M2',
);
export const revertPairCollector = unimplementedCollector(COLLECTOR_IDS.revertPair, 'M2');
export const temporalNeighborCollector = unimplementedCollector(
  COLLECTOR_IDS.temporalNeighbor,
  'M2',
);
export const testSiblingCollector = unimplementedCollector(
  COLLECTOR_IDS.testSibling,
  'M2',
);

export const COLLECTORS: readonly EvidenceCollector[] = [
  blameCollector,
  commitContextCollector,
  prReferenceCollector,
  revertPairCollector,
  temporalNeighborCollector,
  testSiblingCollector,
];

/* ── Ranking and budget fitting ────────────────────────────────────────────── */

/** The four-factor score. Tuned in M2 against 20 hand-labelled targets. */
export interface RankingWeights {
  /** How close in time the evidence is to the target's own history. */
  readonly recency: number;
  /** How close in the file/line space — a hunk overlapping the target beats one nearby. */
  readonly proximity: number;
  /** A prior per `EvidenceKind`: a revert pair outranks a temporal neighbour. */
  readonly kindPrior: number;
  /** `observed` > `reported` > `inferred`. */
  readonly certainty: number;
}

/**
 * Budget fitting keeps a bundle small enough to be read by a human *and* to fit a
 * prompt. Per-kind floors stop one prolific collector from crowding out the rest —
 * without them, blame attribution fills every slot.
 */
export interface EvidenceBudget {
  readonly maxItems: number;
  readonly maxChars: number;
  readonly perKindFloor: number;
}

export interface Ranker {
  rank(
    items: readonly Evidence[],
    target: Target,
    budget: EvidenceBudget,
  ): readonly Evidence[];
}

export function createRanker(_weights: RankingWeights): Ranker {
  throw new NotImplementedError('createRanker', 'M2');
}

/** Deduplicate before ranking: two collectors citing the same commit is one fact. */
export function dedupe(_items: readonly Evidence[]): readonly Evidence[] {
  throw new NotImplementedError('dedupe', 'M2');
}

/* ── Confidence and gaps ───────────────────────────────────────────────────── */

/**
 * Deterministic, with enumerated reasons, and computed **before** generation. A model
 * never influences the confidence of the answer it is about to write.
 *
 * HIGH is reachable only when a substantive body or a PR reference exists (M2
 * acceptance criterion).
 */
export function computeConfidence(
  _items: readonly Evidence[],
  _target: Target,
  _gaps: readonly Gap[],
): Confidence {
  throw new NotImplementedError('computeConfidence', 'M2');
}

/** Named absences drive honest messaging: "no PR body cached", not silence. */
export function detectGaps(
  _items: readonly Evidence[],
  _ctx: EvidenceContext,
): readonly Gap[] {
  throw new NotImplementedError('detectGaps', 'M2');
}

/**
 * Stable across runs and across incremental updates, given identical inputs (Part 8
 * §8.8, invariant 12). This is the cache key *and* the reproducibility key, so it
 * must not include anything incidental like collection order or wall-clock time.
 */
export function computeBundleHash(
  _target: Target,
  _items: readonly Evidence[],
): EvidenceBundle['hash'] {
  throw new NotImplementedError('computeBundleHash', 'M2');
}

/** The one entry point. Runs applicable collectors, dedupes, ranks, fits, scores. */
export function assembleBundle(
  _target: Target,
  _ctx: EvidenceContext,
  _budget: EvidenceBudget,
): Promise<EvidenceBundle> {
  throw new NotImplementedError('assembleBundle', 'M2');
}
