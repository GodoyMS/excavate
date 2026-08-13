/**
 * Snapshot tests of `excavate stats` output — ROADMAP M1's testing list.
 *
 * The rest of the M1 suite asserts that the *numbers* are right: bus factor, decay, significance
 * ranking, rename stitching. None of it would notice if the report rendered those correct numbers
 * as an unreadable wall, put the hotspot table above the islands, dropped the factor breakdown
 * that §8.5.3 requires never be omitted, or started printing a bare score with no context. The
 * report is the whole product at M1 — there is no UI until M3 — so its layout deserves the same
 * protection as its arithmetic.
 *
 * Two fixtures, chosen for what they make visible:
 *
 * - **populated** exercises every section at once, and includes the commits that must *not* rank:
 *   a lockfile refresh, a generated-output commit, and a formatting sweep. The snapshot is
 *   therefore also a readable record of the anti-embarrassment behaviour — if a codemod ever
 *   climbs into "most significant", it appears in the diff of this file rather than in someone's
 *   terminal.
 * - **sparse** is one commit touching one file. Every ranking is empty, and the snapshot pins the
 *   sentences the report says instead of a number. That path is easy to break and never exercised
 *   by a real repository, which is exactly why it needs a test.
 *
 * **Two things are normalised, and only two.** Commit oids and the temporary clone path vary per
 * run, so they are replaced with placeholders and asserted separately for shape. Everything else —
 * dates, names, counts, column widths, wording, section order — is compared byte for byte against
 * a fixed `NOW`, because all of it is a deliberate decision that a regression should have to
 * justify in review.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitId, fromDate, parseOid, repoId } from '@wise-excavate/core';
import type { RepoSummary, Timestamp } from '@wise-excavate/core';
import { DEFAULT_WALK_SPEC, CliGitBackend } from '@wise-excavate/git';
import type { FixtureRepo } from '@wise-excavate/git-fixtures';
import { repo } from '@wise-excavate/git-fixtures';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';
import type { Store } from '@wise-excavate/store';
import { createIndexPipeline } from '@wise-excavate/index';
import { HOTSPOT_MIN_CHANGES, runAnalysis } from '@wise-excavate/analysis';
import { buildStatsReport } from '@wise-excavate/server';
import { renderStats, statsAsJson, styleFor } from 'wise-excavate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Fixed, so "last seen 14mo ago" means the same thing in 2031 as it does today. */
const NOW: Timestamp = fromDate(new Date('2026-01-01T00:00:00Z'));

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
const GRACE = { name: 'Grace Hopper', email: 'grace@example.com' };
const BOT = {
  name: 'dependabot[bot]',
  email: 'dependabot[bot]@users.noreply.github.com',
};

const source = (tag: string, lines: number): string =>
  `${Array.from({ length: lines }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n')}\n`;

interface Indexed {
  readonly fixture: FixtureRepo;
  readonly store: Store;
  readonly indexDir: string;
}

const built: Indexed[] = [];

async function index(
  fixture: FixtureRepo,
  name: string,
  /** The tip the analysis covers. `analyzer_runs.through_oid` is NOT NULL by design: a run that
      did not record how far it got cannot be resumed or invalidated correctly. */
  headSubject: string,
): Promise<Indexed> {
  const indexDir = mkdtempSync(join(tmpdir(), `excavate-snap-${name}-`));
  const store = openStore({
    path: join(indexDir, INDEX_FILE_NAME),
    repoId: repoId(`snapshot-${name}`),
  });
  const pipeline = createIndexPipeline({
    backend: new CliGitBackend({ repoRoot: fixture.path }),
    store,
    sinks: [],
    walkSpec: DEFAULT_WALK_SPEC,
  });
  for await (const progress of pipeline.run({
    tiers: ['metadata'],
    signal: new AbortController().signal,
  })) {
    void progress;
  }
  await runAnalysis({
    store,
    now: NOW,
    signal: new AbortController().signal,
    throughOid: fixture.oid(headSubject),
  });
  const entry = { fixture, store, indexDir };
  built.push(entry);
  return entry;
}

/**
 * A session is not needed to render a report — `buildStatsReport` takes only a store and a
 * summary — so the summary is assembled here from the store's own counts. Hand-writing the counts
 * would let a real regression in `commits.count()` pass unnoticed behind a literal.
 */
function summaryFor(entry: Indexed, root: string): RepoSummary {
  const { store } = entry;
  const commits = store.commits.count();
  const first = store.commits.byId(commitId(0));
  const last = commits === 0 ? null : store.commits.byId(commitId(commits - 1));
  return {
    repoId: repoId('snapshot'),
    root,
    headOid: last?.oid ?? parseOid('0'.repeat(40)),
    indexState: 'ready',
    commitCount: commits,
    personCount: store.people.all({ includeBots: true }).length,
    fileCount: store.files.count(),
    firstCommitAt: first?.authoredAt ?? null,
    lastCommitAt: last?.authoredAt ?? null,
    partial: null,
  };
}

/** The stand-in root, so the snapshot does not contain a `mkdtemp` path. */
const ROOT = '/repo';

function render(entry: Indexed): string {
  const report = buildStatsReport(
    { store: entry.store, summary: () => summaryFor(entry, ROOT) },
    NOW,
  );
  const plain = styleFor(false, {});
  return renderStats(report, plain);
}

/** Replace the one genuinely variable token. Asserted for shape in its own test below. */
const withoutOids = (text: string): string => text.replace(/\b[0-9a-f]{7}\b/g, '<oid>');

let populated: Indexed;
let sparse: Indexed;

beforeAll(async () => {
  populated = await index(
    await repo('snapshot-populated')
      /* Ada builds the codebase, then leaves — the setup for an island. Files are sized
         differently so churn and complexity have something to rank. */
      .commit('feat: add the walker, which is the core of the tool', (c) =>
        c
          .add('src/walk.ts', source('w', 90))
          .add('src/util.ts', source('u', 20))
          .author(ADA.name, ADA.email)
          .at('2023-02-01T00:00:00+00:00'),
      )
      .commit('feat: add the parser Ada alone ever touches', (c) =>
        c
          .add('src/parse.ts', source('p', 70))
          .author(ADA.name, ADA.email)
          .at('2023-03-01T00:00:00+00:00'),
      )
      /* Grace arrives, stays, and works the walker repeatedly — so it should rank as a hotspot
         while never becoming an island. */
      .commit('fix: correct the walker on empty input', (c) =>
        c
          .edit('src/walk.ts', source('w2', 120))
          .author(GRACE.name, GRACE.email)
          .at('2025-09-01T00:00:00+00:00'),
      )
      .commit('fix: another walker crash, this time on deep nesting', (c) =>
        c
          .edit('src/walk.ts', source('w3', 150))
          .author(GRACE.name, GRACE.email)
          .at('2025-11-15T00:00:00+00:00'),
      )
      /* The three commits that must not rank. Each is enormous by every naive measure. */
      .commit('chore: update the lockfile', (c) =>
        c
          .add('pnpm-lock.yaml', source('lock', 900))
          .author(BOT.name, BOT.email)
          .at('2025-12-01T00:00:00+00:00'),
      )
      .commit('chore: regenerate the client', (c) =>
        c
          .add('dist/client.js', source('gen', 800))
          .author(GRACE.name, GRACE.email)
          .at('2025-12-05T00:00:00+00:00'),
      )
      .commit('style: rustfmt everything', (c) => {
        /* 34 files, deliberately *non*-uniform churn — this is the shape that defeated the
           uniformity test on ripgrep and had to be caught by the subject line instead. */
        for (let i = 0; i < 34; i += 1) {
          c.add(`src/fmt/mod${i}.ts`, source(`f${i}`, 3 + i * 7));
        }
        return c.author(GRACE.name, GRACE.email).at('2025-12-10T00:00:00+00:00');
      })
      .build(),
    'populated',
    'style: rustfmt everything',
  );

  sparse = await index(
    await repo('snapshot-sparse')
      .commit('initial commit', (c) =>
        c
          .add('README.md', '# A repository with one commit\n')
          .author(ADA.name, ADA.email)
          .at('2025-12-20T00:00:00+00:00'),
      )
      .build(),
    'sparse',
    'initial commit',
  );
}, 300_000);

afterAll(async () => {
  for (const entry of built) {
    entry.store.close();
    await entry.fixture.cleanup();
    rmSync(entry.indexDir, { recursive: true, force: true });
  }
});

describe('excavate stats output', () => {
  it('renders a populated repository the same way every time', () => {
    expect(withoutOids(render(populated))).toMatchSnapshot();
  });

  it('says what is missing rather than printing empty tables', () => {
    expect(withoutOids(render(sparse))).toMatchSnapshot();
  });

  /**
   * The oids are normalised out of the snapshots above, so their shape is pinned here instead.
   * Seven characters is git's own abbreviation length and what makes the commit column line up;
   * a change to full 40-character oids would pass both snapshots after a regeneration and quietly
   * make the table twice as wide.
   */
  it('abbreviates commit oids to seven characters', () => {
    const text = render(populated);
    const oids = text.match(/\b[0-9a-f]{7}\b/g) ?? [];
    expect(oids.length).toBeGreaterThan(0);
    for (const oid of oids) expect(oid).toMatch(/^[0-9a-f]{7}$/);
  });

  /**
   * §8.5.3: a hotspot score is "always shown with its factor breakdown". A snapshot alone would
   * not enforce that — regenerating it would happily bless a table with the factors removed — so
   * the requirement is asserted directly against the header.
   */
  it('never shows a hotspot score without its four factors', () => {
    const text = render(populated);
    expect(text).toContain('churn');
    expect(text).toContain('cmplx');
    expect(text).toContain('recent');
    expect(text).toContain('fixes');
  });

  /**
   * The gate that {@link HOTSPOT_MIN_CHANGES} enforces, asserted rather than merely snapshotted.
   *
   * `src/fmt/mod*.ts` are the 34 files the formatting sweep created in one commit and nobody ever
   * touched again. Before the gate, nine of them held the top ten hotspot slots and pushed out
   * `src/walk.ts` — the one file three people had actually been fixing. A snapshot alone would not
   * defend this: regenerating it would happily record the bad ranking as the new expectation.
   */
  it('never ranks a file that was only ever added once', () => {
    const report = buildStatsReport(
      { store: populated.store, summary: () => summaryFor(populated, ROOT) },
      NOW,
    );
    expect(report.hotspots.length).toBeGreaterThan(0);
    for (const spot of report.hotspots) {
      expect(spot.path).not.toMatch(/^src\/fmt\//);
      expect(spot.changeCount).toBeGreaterThanOrEqual(HOTSPOT_MIN_CHANGES);
    }
    expect(report.hotspots.map((s) => s.path)).toContain('src/walk.ts');
  });

  /**
   * The `--json` surface is the same document, so it must not drift from the table. Asserted on
   * the section keys rather than the whole payload, which the DTO type already constrains.
   */
  it('emits the same report as JSON', () => {
    const report = buildStatsReport(
      { store: populated.store, summary: () => summaryFor(populated, ROOT) },
      NOW,
    );
    const parsed: unknown = JSON.parse(statsAsJson(report));
    expect(Object.keys(parsed as object).sort()).toEqual([
      'generatedFor',
      'hotspots',
      'knowledgeIslands',
      'otherCommits',
      'otherPeople',
      'people',
      'significantCommits',
      'summary',
    ]);
  });
});
