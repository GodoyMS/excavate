/**
 * Hotspots — Part 8 §8.5.3.
 *
 *     hotspot(f) = churn_norm(f) × complexity_norm(f) × recency_weight(f) × (1 + fix_density(f))
 *
 * A **product**, not a sum, and that is the interesting part: a file has to score on more than
 * one axis to rank. The biggest file in the repository is not a hotspot if nobody changes it;
 * the most-changed file is not a hotspot if it is a 30-line config; a file that was churning
 * violently two years ago and has been quiet since is not a hotspot now. Only the combination
 * is dangerous, and summing would let any single axis carry a file to the top.
 *
 * §8.5.3 also requires this never be shown as a bare number — "always with its factor
 * breakdown and links to the commits" — which is why every factor is returned and stored
 * individually rather than only the product.
 */

import type { Timestamp } from '@wise-excavate/core';
import { SECONDS_PER_DAY } from '@wise-excavate/core';

export interface HotspotInput {
  /** Total insertions + deletions across the file's whole life. */
  readonly totalChurn: number;
  readonly changeCount: number;
  /** From `complexityProxy`, in whatever units it produces; normalised here. */
  readonly complexity: number;
  /** When the file was last changed. */
  readonly lastChangedAt: Timestamp;
  /** Fraction of this file's commits classified as fixes, 0..1. */
  readonly fixDensity: number;
}

export interface HotspotFactors {
  readonly score: number;
  readonly churn: number;
  readonly complexity: number;
  readonly recency: number;
  readonly fixDensity: number;
}

/**
 * How quickly a file stops counting as "actively changing".
 *
 * A year, so that a file untouched for a year retains about a third of its recency weight
 * rather than none: the goal is to rank *current* risk without erasing a file that was
 * rewritten eleven months ago and is about to be touched again.
 */
export const RECENCY_HALF_LIFE_DAYS = 365;

export function recencyWeight(lastChangedAt: Timestamp, now: Timestamp): number {
  const days = Math.max(
    0,
    (now.epochSeconds - lastChangedAt.epochSeconds) / SECONDS_PER_DAY,
  );
  return Math.exp((-days * Math.LN2) / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Normalise within the repository, as §8.5.3 requires ("each factor is normalized within the
 * repository").
 *
 * Log-scaled before normalising because churn is heavy-tailed: one lockfile with 400,000 lines
 * of churn would otherwise compress every real source file into the bottom percent of the
 * range, and every hotspot score would round to zero. The log is what keeps the ranking
 * readable on a repository that contains one pathological file — which is all of them.
 */
export function normaliseLog(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.log1p(Math.max(0, value)) / Math.log1p(max);
}

export function hotspotOf(
  input: HotspotInput,
  maxima: { readonly churn: number; readonly complexity: number },
  now: Timestamp,
): HotspotFactors {
  const churn = normaliseLog(input.totalChurn, maxima.churn);
  const complexity = normaliseLog(input.complexity, maxima.complexity);
  const recency = recencyWeight(input.lastChangedAt, now);
  const fixDensity = Math.max(0, Math.min(1, input.fixDensity));

  return {
    score: churn * complexity * recency * (1 + fixDensity),
    churn,
    complexity,
    recency,
    fixDensity,
  };
}

/**
 * The complexity proxy: LOC plus mean indentation depth.
 *
 * LEAN-V1 §3.1 replaces tree-sitter with this — "language-agnostic, zero parsers, ~15 lines" —
 * and the trade is honest. It cannot see cyclomatic complexity, so a 400-line flat data table
 * scores like 400 lines of dense logic. What it does capture is nesting, which correlates well
 * enough with "hard to change safely" to rank files usefully, and it works on every language
 * including ones nobody has written a parser for.
 *
 * At M1 there is no file *content* in the index — blobs arrive with hunks in M2 — so callers
 * pass what they have. The analyzer currently derives it from change size, which is documented
 * where it does so rather than pretended otherwise.
 */
export function complexityProxy(source: string): number {
  const lines = source.split('\n');
  if (lines.length === 0) return 0;

  let indentTotal = 0;
  let counted = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = /^[ \t]*/.exec(line);
    const leading = match?.[0] ?? '';
    // A tab counts as four columns, so mixed-indentation files do not read as flat.
    indentTotal +=
      leading.length +
      leading.split('\t').length -
      1 +
      3 * (leading.match(/\t/g)?.length ?? 0);
    counted += 1;
  }

  const meanIndent = counted === 0 ? 0 : indentTotal / counted;
  return counted * (1 + meanIndent / 4);
}

/**
 * Whether a commit reads as a fix, for `fixDensity`.
 *
 * Conventional-commit prefixes plus the common English forms. Deliberately not a
 * general-purpose classifier: a false positive inflates one file's fix density slightly, which
 * moves it a little up the ranking, and the cost of that is far below the cost of missing the
 * signal entirely on a repository that writes ordinary English commit messages.
 */
const FIX_SUBJECT =
  /^(?:fix|bugfix|hotfix|patch)\b|^fix[(:]|\bfix(?:es|ed)\b|\bbug\b|\bregression\b|\bcrash\b|\bhotfix\b/i;

export function looksLikeFix(subject: string): boolean {
  return FIX_SUBJECT.test(subject.trim());
}
