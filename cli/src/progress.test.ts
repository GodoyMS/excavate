import type { RepoSummary, ServerEvent, Tier } from '@wise-excavate/core';
import { parseOid, repoId, timestamp } from '@wise-excavate/core';
import { describe, expect, it } from 'vitest';

import type { IndexProgressEvent } from './progress.js';
import {
  createIndexProgressPrinter,
  formatIndexProgress,
  formatIndexSummary,
  formatPartialBadge,
} from './progress.js';

const at = (iso: string): ReturnType<typeof timestamp> =>
  timestamp(Math.trunc(Date.parse(iso) / 1000));

const summary = (overrides: Partial<RepoSummary> = {}): RepoSummary => ({
  repoId: repoId('9f1c'),
  root: '/repo',
  headOid: parseOid('4f9c2ab'.padEnd(40, '0')),
  indexState: 'walking',
  commitCount: 0,
  personCount: 0,
  fileCount: 0,
  firstCommitAt: null,
  lastCommitAt: null,
  partial: null,
  ...overrides,
});

/**
 * Built to mirror what `@wise-excavate/index`'s walk actually yields, which the server turns
 * into events by omitting a null note rather than passing `undefined` through.
 */
const progress = (
  fields: { readonly tier?: Tier; readonly done: number } & {
    readonly total?: number | null;
    readonly note?: string;
  },
): IndexProgressEvent => ({
  type: 'index.progress',
  tier: fields.tier ?? 'metadata',
  done: fields.done,
  total: fields.total ?? null,
  ...(fields.note === undefined ? {} : { note: fields.note }),
});

describe('index progress lines', () => {
  it('carries the tier, the count, and whatever the walk said about it', () => {
    const line = formatIndexProgress(progress({ done: 8_200, note: 'walking history' }));

    expect(line).toContain('metadata');
    expect(line).toContain('8,200 commits');
    expect(line).toContain('walking history');
  });

  it('states a denominator only once the walk knows one', () => {
    expect(formatIndexProgress(progress({ done: 8_200 }))).toBe(
      'metadata  8,200 commits',
    );
    expect(formatIndexProgress(progress({ done: 8_200, total: 12_481 }))).toBe(
      'metadata  8,200 of 12,481 commits',
    );
  });

  it('says "1 commit", not "1 commits"', () => {
    expect(formatIndexProgress(progress({ done: 1 }))).toContain('1 commit');
    expect(formatIndexProgress(progress({ done: 1 }))).not.toContain('1 commits');
  });

  /**
   * The M0 walk reports a deferred `analysis` tier exactly this way. Printing
   * "0 commits" against a tier that walked no commits would be a false statement about
   * the run, and dropping the note would make a knowingly incomplete index look whole.
   */
  it('renders a tier that only had something to say, with no invented count', () => {
    const line = formatIndexProgress(
      progress({
        tier: 'analysis',
        done: 0,
        note: 'the analysis tier is not implemented before M1',
      }),
    );

    expect(line).toBe('analysis  the analysis tier is not implemented before M1');
    expect(line).not.toContain('0');
  });

  it('has no line at all for an event carrying no fact', () => {
    expect(formatIndexProgress(progress({ done: 0 }))).toBeNull();
  });

  it('does not label a non-history tier\'s number "commits"', () => {
    expect(formatIndexProgress(progress({ tier: 'analysis', done: 12 }))).not.toContain(
      'commit',
    );
  });
});

describe('the progress printer', () => {
  const collect = (
    stride: number,
  ): { lines: string[]; observe: (event: ServerEvent) => void } => {
    const lines: string[] = [];
    const printer = createIndexProgressPrinter((line) => lines.push(line), { stride });
    return { lines, observe: (event) => printer.observe(event) };
  };

  it('speaks once immediately, so the first fact appears without waiting', () => {
    const { lines, observe } = collect(1_000);
    observe(progress({ done: 12 }));
    expect(lines).toHaveLength(1);
  });

  it('stays silent rather than reprinting a line that says nothing new', () => {
    const { lines, observe } = collect(1_000);
    observe(progress({ done: 12 }));
    observe(progress({ done: 12 }));
    observe(progress({ done: 900 }));
    expect(lines).toEqual(['metadata  12 commits']);
  });

  it('speaks again once enough commits have gone by to be worth a line', () => {
    const { lines, observe } = collect(1_000);
    observe(progress({ done: 10 }));
    observe(progress({ done: 1_010 }));
    observe(progress({ done: 2_100 }));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('2,100 commits');
  });

  it('announces a new tier even when no new commits arrived with it', () => {
    const { lines, observe } = collect(1_000);
    observe(progress({ tier: 'metadata', done: 500 }));
    observe(progress({ tier: 'analysis', done: 0, note: 'deferred to M1' }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('analysis');
  });

  /**
   * The walk's closing event repeats the count it last reported and adds a note. If the
   * stride swallowed it, a cancelled or deferred run would end silently — the exact
   * silent-degradation failure Part 7 §7.7 forbids.
   */
  it('never swallows a new note, however little the count moved', () => {
    const { lines, observe } = collect(1_000);
    observe(progress({ done: 1_600 }));
    observe(progress({ done: 1_600, note: 'cancelled after 1600 commits' }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('cancelled after 1600 commits');
  });

  it('ignores the event types it has no honest rendering for', () => {
    const { lines, observe } = collect(1_000);
    // `index.tier_complete` is published for every requested tier, including ones the
    // walk deferred, so rendering it as "complete" would state something untrue.
    observe({ type: 'index.tier_complete', tier: 'analysis' });
    observe({ type: 'job.started', job: { id: 'index-9f1c', kind: 'index' } });
    observe({ type: 'log', level: 'info', message: 'hello' });
    expect(lines).toEqual([]);
  });
});

describe('the closing summary', () => {
  it('states the span and the head the numbers describe', () => {
    const line = formatIndexSummary(
      summary({
        indexState: 'ready',
        commitCount: 12_481,
        personCount: 41,
        fileCount: 3_204,
        firstCommitAt: at('2011-08-19T12:00:00Z'),
        lastCommitAt: at('2024-06-02T12:00:00Z'),
      }),
    );

    expect(line).toContain('12,481 commits');
    expect(line).toContain('41 people');
    expect(line).toContain('3,204 files');
    expect(line).toContain('2011-08-19 → 2024-06-02');
    expect(line).toContain('head 4f9c2ab');
  });

  it('drops the span for a repository with no commits instead of inventing one', () => {
    const line = formatIndexSummary(summary({ indexState: 'ready' }));
    expect(line).toContain('0 commits');
    expect(line).not.toContain('→');
  });

  it('says "1 person", not "1 persons"', () => {
    const line = formatIndexSummary(summary({ commitCount: 1, personCount: 1 }));
    expect(line).toContain('1 commit ');
    expect(line).toContain('1 person ');
  });
});

describe('the partial-index badge', () => {
  it('gives the cause, what was lost, and what to do about it', () => {
    const badge = formatPartialBadge({
      reason: 'interrupted',
      skipped: '2,481 commits before 2014-01-01',
    });

    expect(badge).toContain('indexing was interrupted');
    expect(badge).toContain('2,481 commits before 2014-01-01');
    expect(badge).toContain('excavate index');
  });

  it('turns every reason into its own sentence rather than leaking the code', () => {
    const badges = (['too-large', 'interrupted', 'tier-failed'] as const).map((reason) =>
      formatPartialBadge({ reason, skipped: 'the 1.2 GB pack' }),
    );

    for (const badge of badges) {
      expect(badge).not.toMatch(/too-large|tier-failed/);
      expect(badge).toContain('incomplete index');
    }
    expect(new Set(badges).size).toBe(3);
  });

  /**
   * The advice has to match what a re-run would actually accomplish.
   *
   * `tier-failed` at M0 means "this release does not build that tier", and there is no
   * incremental walk before M1 — so `excavate index` a second time is a no-op that exits 0.
   * Telling someone to repeat a command that will change nothing is worse than saying
   * nothing: they conclude the tool is broken rather than incomplete.
   */
  it('only suggests re-running when a re-run would change something', () => {
    expect(
      formatPartialBadge({ reason: 'tier-failed', skipped: 'analysis tier' }),
    ).not.toContain('excavate index');

    for (const reason of ['too-large', 'interrupted'] as const) {
      expect(formatPartialBadge({ reason, skipped: 'some history' })).toContain(
        'excavate index',
      );
    }
  });
});
