/**
 * Significance scoring — Part 8 §8.5.1.
 *
 * Used everywhere the product must choose *which commits matter*, which is most places: the
 * Story's key commits, `excavate stats`, and later every evidence bundle's ordering.
 *
 * **The penalties are as important as the rewards, and that is the whole design.** Score
 * only on size and the answer is always the Prettier migration, the licence-header sweep,
 * and a lockfile refresh — commits that are enormous by every naive measure and that nobody
 * wants to read about. §8.5.1 says so directly, and M1's anti-embarrassment test asserts it
 * on every reference repository: no format-only, generated-only, or lockfile-only commit may
 * appear in the top fifty.
 *
 * Two of the ten inputs are properties of the *corpus*, not of a commit, which is why this
 * runs as an analyzer over stored rows rather than inside the walk:
 *
 * - `pathRarity` is an inverse document frequency over touched paths. A commit touching
 *   files that rarely change is more interesting than one touching the churn hotspot, and
 *   "rarely" is only meaningful relative to every other path in the repository.
 * - `messageQuality` penalises subjects that repeat across the repository, which cannot be
 *   known until every subject has been seen.
 */

import type { CommitFlag } from '@wise-excavate/core';

/**
 * The ten rewards and five penalties.
 *
 * Tuned against the reference corpora rather than derived: the target is that the top of the
 * list on a repository someone knows well is recognisable to them, which is a judgement call
 * and is exactly why the weights are versioned with the analyzer.
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

/**
 * The shipped weights.
 *
 * The shape to notice: the five penalties sum to more than any plausible reward total. That
 * is deliberate — a noise commit must not be *ranked lower*, it must be pushed out of the
 * list entirely, because a codemod at position 12 is as embarrassing as one at position 1.
 */
export const DEFAULT_SIGNIFICANCE_WEIGHTS: SignificanceWeights = {
  filesTouched: 0.8,
  churn: 0.7,
  isRelease: 1.6,
  // The single highest reward. A revert/re-land pair is the repository saying "we tried
  // this, it was wrong, we fixed it and tried again" — Part 8 §8.5.3 calls it the highest
  // value evidence type in the product.
  isRevertOrReland: 2.2,
  touchesManifest: 1.1,
  touchesPublicApi: 1.0,
  firstTouchOfNewTopLevelDir: 1.4,
  messageQuality: 1.5,
  pathRarity: 1.2,
  mergesLargeBranch: 0.9,

  penaltyFormatOnly: 4.0,
  penaltyGeneratedOnly: 4.5,
  penaltyVendoredOnly: 4.0,
  penaltyLockfileOnly: 5.0,
  penaltyBulkMechanical: 4.5,
};

/**
 * Where scale stops adding to significance.
 *
 * Fifty files and two thousand lines. Both are a little above the point where a change stops
 * being something one person held in their head at once — `BULK_FILE_THRESHOLD` puts that at
 * thirty — so the cap is reached only by commits that are already large enough for scale to have
 * said everything it can say about them. What separates a genuine 200-file refactor from a
 * 200-file codemod after this change is the *other* nine terms: message quality, path rarity,
 * whether it touched a manifest or a public entry point, whether it was a revert. Those are the
 * terms that carry information, and capping scale is what lets them decide.
 */
export const SCALE_SATURATION = { files: 50, churn: 2000 } as const;

/** `log1p` normalised by the cap and clamped to 0..1, so the term is a fraction of its weight. */
function saturating(value: number, cap: number): number {
  return Math.min(1, Math.log1p(Math.max(0, value)) / Math.log1p(cap));
}

/** Everything the score needs about one commit, gathered by the analyzer from stored rows. */
export interface SignificanceInput {
  readonly filesTouched: number;
  readonly churn: number;
  readonly flags: readonly CommitFlag[];
  /** 0..1, from `messageQuality` in `@wise-excavate/index`. */
  readonly messageQuality: number;
  /** Mean inverse document frequency of the paths this commit touched, 0..1. */
  readonly pathRarity: number;
  readonly touchesManifest: boolean;
  /** A heuristic at M1: a change to a path that looks like a package's public entry point. */
  readonly touchesPublicApi: boolean;
  readonly firstTouchOfNewTopLevelDir: boolean;
  readonly isRelease: boolean;
  /** Merge whose branch contributed more than a handful of commits. */
  readonly mergesLargeBranch: boolean;
}

/**
 * The score. Non-negative, unbounded above, and comparable only *within* one repository —
 * `pathRarity` is normalised against this corpus, so cross-repository comparison is
 * meaningless and no caller should be tempted into it.
 *
 * **The size terms are bounded, and a logarithm alone was not enough.** The first version of
 * this function multiplied the weight by `log1p(value)` directly, which slows growth but never
 * stops it: `style: rustfmt everything` in ripgrep touches 67 files and 4,020 lines, so its churn
 * term alone came to `0.7 × log1p(4020) = 5.8` — larger than every other reward *combined*, and
 * far larger than the 4.5 penalty meant to remove it. It ranked 8th-most-significant in the
 * repository. The stated invariant above ("the penalties sum to more than any plausible reward
 * total") was simply not true of the formula, because an unbounded term has no plausible total.
 *
 * Saturating at {@link SCALE_SATURATION} makes it true: scale can contribute at most
 * `filesTouched + churn` = 1.5 of a maximum 12.4, so a single penalty is decisive against a
 * commit that has nothing else going for it — which is exactly what a sweep is. It also says
 * something defensible about the domain: past roughly fifty files, "bigger" has stopped carrying
 * information about whether a change mattered.
 */
export function significanceOf(
  input: SignificanceInput,
  weights: SignificanceWeights = DEFAULT_SIGNIFICANCE_WEIGHTS,
): number {
  const has = (flag: CommitFlag): boolean => input.flags.includes(flag);

  let score =
    weights.filesTouched * saturating(input.filesTouched, SCALE_SATURATION.files) +
    weights.churn * saturating(input.churn, SCALE_SATURATION.churn) +
    weights.messageQuality * input.messageQuality +
    weights.pathRarity * input.pathRarity;

  if (input.isRelease) score += weights.isRelease;
  if (has('revert') || has('reland')) score += weights.isRevertOrReland;
  if (input.touchesManifest) score += weights.touchesManifest;
  if (input.touchesPublicApi) score += weights.touchesPublicApi;
  if (input.firstTouchOfNewTopLevelDir) score += weights.firstTouchOfNewTopLevelDir;
  if (input.mergesLargeBranch) score += weights.mergesLargeBranch;

  if (has('format-only')) score -= weights.penaltyFormatOnly;
  if (has('generated-only')) score -= weights.penaltyGeneratedOnly;
  if (has('vendored-only')) score -= weights.penaltyVendoredOnly;
  if (has('lockfile-only')) score -= weights.penaltyLockfileOnly;
  if (has('bulk-mechanical')) score -= weights.penaltyBulkMechanical;

  /* An empty commit has nothing to be significant about. Returning 0 rather than letting the
     message-quality term carry it keeps "significant" meaning "changed something important". */
  if (has('empty')) return 0;

  // Clamped at zero: a negative score would sort below an empty commit, and the ordering
  // among noise commits is not information anyone wants.
  return Math.max(0, score);
}

/**
 * Inverse document frequency over paths, for `pathRarity`.
 *
 * `log(total / touched)` normalised into 0..1 by the most-frequent path's own frequency, so
 * the busiest file in the repository scores 0 and a file touched exactly once scores 1.
 * Normalising against the corpus rather than a constant is what makes the term meaningful in
 * both a 200-commit repository and a 200,000-commit one.
 */
export function pathRarity(
  paths: readonly string[],
  changeCountByPath: ReadonlyMap<string, number>,
  totalCommits: number,
): number {
  if (paths.length === 0 || totalCommits === 0) return 0;

  let sum = 0;
  let counted = 0;
  for (const path of paths) {
    const touched = changeCountByPath.get(path) ?? 1;
    // A path touched by every commit yields 0; one touched once yields log(total).
    sum += Math.log(totalCommits / Math.max(1, touched)) / Math.log(totalCommits + 1);
    counted += 1;
  }
  return counted === 0 ? 0 : Math.max(0, Math.min(1, sum / counted));
}

/**
 * Paths that look like a package's public surface.
 *
 * Deliberately shallow. Doing this properly needs an import graph, which needs parsers,
 * which LEAN-V1 §3.1 cuts from v1 entirely — so this recognises the *conventional* entry
 * points and nothing more. A file named `index.ts` at a package root is public by
 * convention in a way that `src/internal/helpers.ts` is not, and that convention is
 * strong enough to be worth a modest reward.
 */
const PUBLIC_API_BASENAMES: ReadonlySet<string> = new Set([
  'index.ts',
  'index.js',
  'mod.rs',
  'lib.rs',
  '__init__.py',
  'index.d.ts',
  'api.ts',
  'public-api.ts',
]);

export function touchesPublicApi(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return PUBLIC_API_BASENAMES.has(base);
  });
}

/** Commits below this contribute nothing to `mergesLargeBranch`. */
export const LARGE_BRANCH_COMMITS = 5;
