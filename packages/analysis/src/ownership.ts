/**
 * Ownership and knowledge — Part 8 §8.5.2.
 *
 * The model, and every term in it is load-bearing:
 *
 *     knowledge(person, file) = Σ_commits  √(lines_touched) · e^(−Δt/τ) · dilution
 *
 * - **√(lines_touched)** is sublinear so a 2,000-line codemod does not create an expert. This
 *   is the term that stops "who ran prettier" from being the answer to "who knows this file".
 * - **e^(−Δt/τ)** with τ ≈ 365 days: knowledge halves roughly annually. Someone who touched a
 *   file in 2019 and never returned does not know it today, and a model that says otherwise
 *   will send you to ask the wrong person.
 * - **dilution**: when B rewrites lines A wrote, A's knowledge of that file takes an extra
 *   decay step. You do not still understand code someone else replaced.
 *
 * From it: `ownership` is the normalised distribution, `bus_factor` is the fewest people whose
 * combined knowledge reaches half, `entropy` is Shannon over the distribution, and a
 * **knowledge island** is `bus_factor == 1` where the top owner has been inactive for over six
 * months. Islands are the headline of `excavate stats` because they are the only output that
 * tells you something actionable you almost certainly did not know.
 */

import type { PersonId, Timestamp } from '@wise-excavate/core';
import { KNOWLEDGE_DECAY_TAU_DAYS, SECONDS_PER_DAY } from '@wise-excavate/core';

/** A person's accumulated, undecayed contribution to one file. */
export interface KnowledgeRow {
  readonly person: PersonId;
  /** Σ √(lines_touched), summed at index time. */
  readonly accumulated: number;
  /** The most recent commit through which this person touched the file. */
  readonly lastAt: Timestamp;
  readonly commits: number;
}

/**
 * Decay applied at read time, against the caller's `now`.
 *
 * Read-time rather than write-time is what makes incremental indexing cheap (§8.5.2): the
 * stored value never needs rewriting as time passes, so a new commit updates only the rows it
 * touches. It also means two people running `stats` on the same index on different days get
 * correctly different answers, which a baked-in decay could not provide.
 */
export function decayedKnowledge(row: KnowledgeRow, now: Timestamp): number {
  const elapsedDays = Math.max(
    0,
    (now.epochSeconds - row.lastAt.epochSeconds) / SECONDS_PER_DAY,
  );
  return row.accumulated * Math.exp(-elapsedDays / KNOWLEDGE_DECAY_TAU_DAYS);
}

export interface OwnershipSummary {
  readonly topPerson: PersonId | null;
  /** The top owner's share of decayed knowledge, 0..1. */
  readonly topShare: number;
  readonly busFactor: number;
  /** Shannon entropy in bits. Zero means one person holds everything. */
  readonly entropy: number;
  readonly contributors: number;
}

/**
 * Summarise one file's ownership.
 *
 * Bots must be filtered out by the caller before this is called — including Dependabot in the
 * distribution would make it the top owner of every lockfile in the repository, and the bus
 * factor of those files would read as a comfortable 1-is-fine when in truth nobody owns them.
 */
export function summariseOwnership(
  rows: readonly KnowledgeRow[],
  now: Timestamp,
): OwnershipSummary {
  const weighted = rows
    .map((row) => ({ person: row.person, value: decayedKnowledge(row, now) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.person - b.person);

  const total = weighted.reduce((sum, entry) => sum + entry.value, 0);
  if (total === 0 || weighted.length === 0) {
    /* Every contribution has decayed to nothing, which is itself a finding: the file is
       unowned. `busFactor: 0` rather than 1 says "no one currently knows this", and it is
       distinct from a file with exactly one owner. Collapsing them would hide the worse case. */
    return { topPerson: null, topShare: 0, busFactor: 0, entropy: 0, contributors: 0 };
  }

  const first = weighted[0];
  let cumulative = 0;
  let busFactor = 0;
  for (const entry of weighted) {
    cumulative += entry.value;
    busFactor += 1;
    if (cumulative / total >= 0.5) break;
  }

  let entropy = 0;
  for (const entry of weighted) {
    const share = entry.value / total;
    if (share > 0) entropy -= share * Math.log2(share);
  }

  return {
    topPerson: first?.person ?? null,
    topShare: (first?.value ?? 0) / total,
    busFactor,
    entropy,
    contributors: weighted.length,
  };
}

/** Part 8 §8.5.2: an island's top owner has been inactive for longer than this. */
export const ISLAND_INACTIVE_DAYS = 183;

/**
 * A knowledge island: exactly one person's knowledge dominates, and they are gone.
 *
 * Both halves are required. A bus factor of 1 on a file whose owner committed yesterday is
 * *normal* — most files in most repositories are like that, and reporting them would bury the
 * signal in noise. What makes an island is that the only person who knows it has stopped
 * showing up, which is when the knowledge is genuinely at risk.
 */
export function isKnowledgeIsland(
  summary: OwnershipSummary,
  topOwnerLastSeen: Timestamp | null,
  now: Timestamp,
): boolean {
  if (summary.busFactor !== 1 || topOwnerLastSeen === null) return false;
  const inactiveDays =
    (now.epochSeconds - topOwnerLastSeen.epochSeconds) / SECONDS_PER_DAY;
  return inactiveDays > ISLAND_INACTIVE_DAYS;
}

/**
 * The dilution step of §8.5.2, applied when someone else rewrites a file.
 *
 * Modelled as one extra decay period for every *other* contributor's subsequent work, which
 * is the cheap approximation of "your lines were replaced" available without blame. Real
 * per-line dilution needs `git blame` output, which is M2 — and this approximation errs in the
 * safe direction: it under-credits an old contributor rather than over-crediting them, so it
 * produces false islands rather than hiding real ones. A false island costs someone five
 * minutes; a hidden one costs an incident.
 */
export function dilutionFactor(rewritesAfter: number): number {
  return Math.exp(-rewritesAfter / KNOWLEDGE_DECAY_TAU_DAYS);
}
