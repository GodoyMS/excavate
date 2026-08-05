/**
 * `@excavate/analysis` — depth 2.
 *
 * **Responsibility.** Every derived, deterministic fact: significance scoring,
 * ownership with recency decay, bus factor, knowledge islands, co-change coupling,
 * hotspots, revert/re-land detection, and era segmentation.
 *
 * **Non-goals.** No Git I/O — it reads from the store. No AI. No presentation.
 *
 * Everything here is a SQL query or a pass over already-stored rows (LEAN-V1 §5.1),
 * which is why it depends on `store` and not on `git` or `index`.
 */

import type {
  AnalyzerId,
  Coupling,
  Era,
  EraDimension,
  Hotspot,
  Ownership,
  RevertPair,
} from '@excavate/core';
import { NotImplementedError, analyzerId } from '@excavate/core';
import type { Store } from '@excavate/store';

export interface AnalysisContext {
  readonly store: Store;
  readonly signal: AbortSignal;
}

/**
 * Analyzers are independently versioned and independently invalidatable.
 *
 * The `version` + `dependsOn` pair is what gives fine-grained cache invalidation:
 * changing the hotspot formula recomputes hotspots and its dependents, not the whole
 * index. Bumping `version` is the *only* correct way to change an analyzer's output.
 */
export interface Analyzer<TOutput> {
  readonly id: AnalyzerId;
  readonly version: number;
  readonly dependsOn: readonly AnalyzerId[];
  run(ctx: AnalysisContext): Promise<TOutput>;
}

export const ANALYZER_IDS = {
  significance: analyzerId('significance'),
  ownership: analyzerId('ownership'),
  coupling: analyzerId('coupling'),
  hotspot: analyzerId('hotspot'),
  revertPair: analyzerId('revert-pair'),
  era: analyzerId('era'),
} as const;

/* ── Significance (Part 8 §8.5.1) ──────────────────────────────────────────── */

/**
 * The ten rewards and five penalties of the significance formula.
 *
 * **The penalties are as important as the rewards.** Without them, "the most
 * significant commits in this repo" reliably returns the Prettier migration, the
 * license-header sweep, and a lockfile refresh — which is exactly how this feature
 * fails in every naive implementation.
 *
 * Values are tuned in M1 against a hand-labelled fixture set and versioned with the
 * analyzer, which is why no defaults are exported here yet.
 */
export interface SignificanceWeights {
  readonly filesTouched: number;
  readonly churn: number;
  readonly isRelease: number;
  readonly isRevertOrReland: number;
  readonly touchesManifest: number;
  readonly touchesPublicApi: number;
  readonly firstTouchOfNewTopLevelDir: number;
  readonly messageQuality: number;
  readonly pathRarity: number;
  readonly mergesLargeBranch: number;

  readonly penaltyFormatOnly: number;
  readonly penaltyGeneratedOnly: number;
  readonly penaltyVendoredOnly: number;
  readonly penaltyLockfileOnly: number;
  readonly penaltyBulkMechanical: number;
}

export const significanceAnalyzer: Analyzer<void> = {
  id: ANALYZER_IDS.significance,
  version: 1,
  dependsOn: [],
  run: () => {
    throw new NotImplementedError('significanceAnalyzer', 'M1');
  },
};

/* ── Ownership and knowledge (Part 8 §8.5.2) ───────────────────────────────── */

export const ownershipAnalyzer: Analyzer<readonly Ownership[]> = {
  id: ANALYZER_IDS.ownership,
  version: 1,
  dependsOn: [],
  run: () => {
    throw new NotImplementedError('ownershipAnalyzer', 'M1');
  },
};

/** A knowledge island is a bus-factor-1 file whose top owner has been gone this long. */
export const KNOWLEDGE_ISLAND_INACTIVE_DAYS = 183;

/* ── Coupling and hotspots (Part 8 §8.5.3) ─────────────────────────────────── */

/**
 * Commits touching more than this many files are excluded from coupling: they are
 * codemods, and they would couple everything to everything.
 */
export const COUPLING_MAX_FILES_PER_COMMIT = 30;

export const couplingAnalyzer: Analyzer<readonly Coupling[]> = {
  id: ANALYZER_IDS.coupling,
  version: 1,
  dependsOn: [],
  run: () => {
    throw new NotImplementedError('couplingAnalyzer', 'M2');
  },
};

/**
 * Complexity is a language-agnostic proxy — LOC plus mean indentation depth — rather
 * than a parsed metric. LEAN-V1 §3.1 cuts tree-sitter from v1, and this replacement
 * is roughly fifteen lines with zero parsers.
 */
export const hotspotAnalyzer: Analyzer<readonly Hotspot[]> = {
  id: ANALYZER_IDS.hotspot,
  version: 1,
  dependsOn: [ANALYZER_IDS.coupling],
  run: () => {
    throw new NotImplementedError('hotspotAnalyzer', 'M1');
  },
};

export function complexityProxy(_source: string): number {
  throw new NotImplementedError('complexityProxy', 'M1');
}

/* ── Reverts (Part 8 §8.5.3) ───────────────────────────────────────────────── */

/**
 * The single highest-value evidence type in the product. All three confidence tiers:
 * explicit `Revert "…"` with an inverse diff and diff-inverse detection are
 * `observed`; message-based with file overlap is `inferred`.
 */
export const revertPairAnalyzer: Analyzer<readonly RevertPair[]> = {
  id: ANALYZER_IDS.revertPair,
  version: 1,
  dependsOn: [],
  run: () => {
    throw new NotImplementedError('revertPairAnalyzer', 'M2');
  },
};

/* ── Eras (Part 8 §8.5.4, LEAN-V1 §3.3) ────────────────────────────────────── */

/**
 * Binary segmentation over a weekly series of five dimensions, replacing PELT over
 * ten. At the 3–12 segment granularity that actually ships, the output is
 * near-identical for a fifth of the code.
 */
export interface EraDetectorOptions {
  readonly dimensions: readonly EraDimension[];
  readonly minEras: number;
  readonly maxEras: number;
  /** Short eras below this are merged into their neighbour. */
  readonly minEraWeeks: number;
  /** Snap detected boundaries to nearby releases — unchanged from the original design. */
  readonly snapToReleases: boolean;
}

export const MIN_ERAS = 3;
export const MAX_ERAS = 12;

export const eraAnalyzer: Analyzer<readonly Era[]> = {
  id: ANALYZER_IDS.era,
  version: 1,
  dependsOn: [],
  run: () => {
    throw new NotImplementedError('eraAnalyzer', 'M5');
  },
};

/* ── Registry ──────────────────────────────────────────────────────────────── */

/**
 * Declared in dependency order. `Analyzer<unknown>` because the registry is
 * heterogeneous; callers that need a specific output type use the named export.
 */
export const ANALYZERS: readonly Analyzer<unknown>[] = [
  significanceAnalyzer,
  ownershipAnalyzer,
  couplingAnalyzer,
  hotspotAnalyzer,
  revertPairAnalyzer,
  eraAnalyzer,
];
