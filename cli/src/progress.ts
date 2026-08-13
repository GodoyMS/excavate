/**
 * Terminal progress and summary phrasing.
 *
 * Part 12 §12.9 is normative here: past two seconds, progress must be **specific,
 * changing facts**, never a bar and never a spinner — and the ROADMAP repeats the rule
 * for M3's indexing screen. The CLI ships months before that screen exists, so this is
 * where the rule is actually set, and a terminal is the least forgiving place to fake
 * it: a reprinted identical line is a spinner with extra steps.
 *
 * The input is the daemon's own `ServerEvent` stream — the same events the SSE route
 * carries — so the terminal and the browser render one source of truth rather than two
 * approximations of it. Everything here is a pure function of an event or a
 * `RepoSummary`, which is what makes the phrasing testable with no repository, no
 * store, and no clock.
 */

import type {
  PartialIndexBadge,
  RepoSummary,
  ServerEvent,
  Tier,
  Timestamp,
} from '@wise-excavate/core';
import { shortOid, toIsoWithOffset } from '@wise-excavate/core';

/** The one event the terminal renders. Narrowed here so the rest of the file is total. */
export type IndexProgressEvent = Extract<ServerEvent, { type: 'index.progress' }>;

/**
 * Commits between progress lines.
 *
 * The walk already batches its events at its flush boundary, but that boundary is the
 * store's business and may shrink; a line per event would then scroll a large
 * repository off the screen. A floor of N commits makes every line carry information
 * the previous one did not, and it behaves identically in a pipe and in a terminal with
 * no carriage-return cursor games to get wrong.
 */
export const DEFAULT_PROGRESS_STRIDE = 2_500;

/** Width of the tier column; the longest tier name is eight characters. */
const TIER_COLUMN = 10;

/**
 * What a tier counts. `metadata` is the history walk, so its unit is a commit — the
 * fact worth printing. No other tier's unit is known yet, and guessing one would put a
 * false noun on a real number, so they get the neutral `step` until each lands.
 */
const TIER_UNIT: Readonly<Record<Tier, string>> = {
  metadata: 'commit',
  // The hunk pass is a second traversal of the same history, so its unit is a commit too.
  content: 'commit',
  analysis: 'step',
};

/**
 * Explicit locale, because `12,481 commits` must not become `12.481 commits` on a
 * machine configured for a different one. Terminal output is part of the contract the
 * tests assert on.
 */
function decimal(value: number): string {
  return value.toLocaleString('en-US');
}

function countOf(value: number, singular: string, plural = `${singular}s`): string {
  return `${decimal(value)} ${value === 1 ? singular : plural}`;
}

/**
 * Calendar day in the commit's *own* offset, per the reasoning in `core/time.ts`: a
 * date normalised to UTC is not the date the author would recognise.
 */
function day(at: Timestamp): string {
  return toIsoWithOffset(at).slice(0, 10);
}

/**
 * One progress line: which tier is running, how far it has got, and whatever the tier
 * said about it. The note is never dropped — it is where the walk reports things like a
 * deferred tier or a cancelled run, and swallowing it is how a partial index becomes a
 * silent one.
 *
 * `null` when the event carries no fact at all, so the caller prints nothing rather than
 * a bare tier name. `total` is included only once the walk knows it; a made-up
 * denominator is exactly the fake progress bar §12.9 forbids.
 */
export function formatIndexProgress(event: IndexProgressEvent): string | null {
  const unit = TIER_UNIT[event.tier];
  const facts: string[] = [];
  if (event.done > 0 || event.total !== null) {
    facts.push(
      event.total === null
        ? countOf(event.done, unit)
        : `${decimal(event.done)} of ${countOf(event.total, unit)}`,
    );
  }
  if (event.note !== undefined && event.note !== '') facts.push(event.note);
  if (facts.length === 0) return null;
  return `${event.tier.padEnd(TIER_COLUMN)}${facts.join(' · ')}`;
}

/** The closing line: the whole repository in one row, with the head it describes. */
export function formatIndexSummary(summary: RepoSummary): string {
  const facts = [
    countOf(summary.commitCount, 'commit'),
    countOf(summary.personCount, 'person', 'people'),
    countOf(summary.fileCount, 'file'),
  ];
  const { firstCommitAt, lastCommitAt } = summary;
  if (firstCommitAt !== null && lastCommitAt !== null) {
    facts.push(`${day(firstCommitAt)} → ${day(lastCommitAt)}`);
  }
  facts.push(`head ${shortOid(summary.headOid)}`);
  return facts.join(' · ');
}

const PARTIAL_REASONS: Readonly<Record<PartialIndexBadge['reason'], string>> = {
  'too-large': 'the repository exceeded the size budget',
  interrupted: 'indexing was interrupted',
  'tier-failed': 'an indexing tier failed',
};

/**
 * Cause, consequence, action — the error shape of §12.9, and the honest-degradation
 * contract of Part 7 §7.7. A partial index that announces itself is a usable index; a
 * silent one is a tool that lies by omission.
 */
/**
 * The badge, plus what the user can actually do about it.
 *
 * The advice is conditional because "re-run `excavate index`" is only true for a gap a
 * re-run would close. A tier this release does not implement is not one of those: there is
 * no incremental walk before M1, so a second run is a no-op, and telling someone to repeat
 * a command that will change nothing is worse than telling them nothing — they would
 * reasonably conclude the tool is broken rather than incomplete.
 */
export function formatPartialBadge(partial: PartialIndexBadge): string {
  const badge = `incomplete index — ${PARTIAL_REASONS[partial.reason]}: ${partial.skipped}.`;
  const advice =
    partial.reason === 'tier-failed'
      ? 'Nothing to re-run: that tier arrives in a later release.'
      : 'Delete the index directory and re-run `excavate index` to rebuild it.';
  return `${badge} ${advice}`;
}

export interface IndexProgressPrinter {
  /**
   * Feed a server event. Emits a line only when it would say something the last line
   * did not, which is the whole point of the §12.9 rule. Every event type other than
   * `index.progress` is ignored rather than guessed at.
   */
  observe(event: ServerEvent): void;
}

export interface IndexProgressOptions {
  /** Commits between lines. Defaults to {@link DEFAULT_PROGRESS_STRIDE}. */
  readonly stride?: number;
}

export function createIndexProgressPrinter(
  emit: (line: string) => void,
  options: IndexProgressOptions = {},
): IndexProgressPrinter {
  const stride = options.stride ?? DEFAULT_PROGRESS_STRIDE;
  let last: { tier: Tier; note: string | undefined; done: number } | null = null;

  return {
    observe(event) {
      if (event.type !== 'index.progress') return;
      const line = formatIndexProgress(event);
      if (line === null) return;
      // A new tier or a new note is always worth a line even with no new commits:
      // switching tiers, or a tier reporting that it was deferred, is the most
      // informative thing that happens in a run. Otherwise the count has to move.
      if (
        last !== null &&
        last.tier === event.tier &&
        last.note === event.note &&
        event.done - last.done < stride
      ) {
        return;
      }
      last = { tier: event.tier, note: event.note, done: event.done };
      emit(line);
    },
  };
}
