/**
 * Knowledge islands, on a history whose departures are known — ROADMAP M1 acceptance criterion:
 *
 * > Knowledge islands are correct on fixtures with known contributor departures.
 *
 * An island is the headline of `excavate stats` because it is the one output that tells a user
 * something actionable they almost certainly did not know: *the only person who understands this
 * file stopped working here*. That makes both directions of error expensive in different ways. A
 * false island sends someone to investigate a file that is fine, and after two or three of those
 * nobody reads the section again. A missed island is the incident the product existed to prevent.
 *
 * So the fixture is built as a **discrimination test**, not a detection test. It contains four
 * files whose ownership differs in exactly one respect each, and the assertions are as much about
 * which files are *absent* from the list as which are present:
 *
 * | file             | owner            | bus factor | owner active? | island? |
 * | ---------------- | ---------------- | ---------: | ------------- | ------- |
 * | `abandoned.ts`   | Ada, alone       |          1 | left 3y ago   | **yes** |
 * | `active-solo.ts` | Grace, alone     |          1 | last month    | no      |
 * | `shared.ts`      | 3 people, all recent |     ≥2 | all, yes      | no      |
 * | `handed-over.ts` | Ada, then Grace  |          1 | Grace, yes    | no      |
 *
 * `active-solo.ts` is the one that matters most. Part 8 §8.5.2 requires *both* halves of the
 * definition — bus factor 1 **and** an inactive owner — because most files in most repositories
 * have exactly one owner who is still around. A detector that reported bus-factor-1 alone would
 * bury every real island under hundreds of ordinary files, which is the same as having no
 * detector. `handed-over.ts` is the decay term doing its job: Ada wrote it, Grace rewrote it, and
 * Ada's knowledge of code that no longer exists has correctly faded.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromDate, repoId } from '@wise-excavate/core';
import type { Timestamp } from '@wise-excavate/core';
import { DEFAULT_WALK_SPEC, CliGitBackend } from '@wise-excavate/git';
import type { FixtureRepo } from '@wise-excavate/git-fixtures';
import { repo } from '@wise-excavate/git-fixtures';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';
import type { Store } from '@wise-excavate/store';
import { createIndexPipeline } from '@wise-excavate/index';
import { runAnalysis } from '@wise-excavate/analysis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Substantial files, so `√(lines)` differences between contributors are meaningful. */
const source = (tag: string, lines: number): string =>
  `${Array.from({ length: lines }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n')}\n`;

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
const GRACE = { name: 'Grace Hopper', email: 'grace@example.com' };
const KATHERINE = { name: 'Katherine Johnson', email: 'katherine@example.com' };
const MARGARET = { name: 'Margaret Hamilton', email: 'margaret@example.com' };

/**
 * "Now" for the analysis, fixed rather than read from the clock.
 *
 * Every date below is relative to it, so the fixture's departures stay the same distance in the
 * past however long this test lives. A `new Date()` here would make the suite's behaviour drift
 * year by year and eventually flip an assertion for reasons unrelated to the code.
 */
const NOW = fromDate(new Date('2026-01-01T00:00:00Z'));

let fixture: FixtureRepo;
let indexDir: string;
let store: Store;

beforeAll(async () => {
  fixture = await repo('islands')
    /* Ada builds everything, then leaves. Three years before NOW, comfortably past the
       183-day inactivity threshold — not near it, because a fixture that sits on a boundary
       tests the boundary rather than the behaviour. */
    .commit('ada: add the abandoned module', (c) =>
      c
        .add('src/abandoned.ts', source('ab', 60))
        .add('src/shared.ts', source('sh', 40))
        .add('src/handed-over.ts', source('ho', 50))
        .author(ADA.name, ADA.email)
        .at('2022-06-01T00:00:00+00:00'),
    )
    .commit('ada: extend the abandoned module', (c) =>
      c
        .edit('src/abandoned.ts', source('ab', 90))
        .author(ADA.name, ADA.email)
        .at('2022-09-01T00:00:00+00:00'),
    )
    /**
     * `shared.ts` needs **three** current contributors, and arriving at that took two corrections
     * worth recording — both were the fixture being wrong about the model, not the model being
     * wrong.
     *
     * First: Ada in 2022 plus Katherine in 2025 gave a bus factor of 1, correctly, because three
     * years of decay had reduced Ada's share to nothing. "Two people touched it at some point" is
     * not shared ownership.
     *
     * Then: two *recent* contributors also gave 1 — and that one is structural rather than
     * incidental. Bus factor is "the fewest people whose combined knowledge reaches half", so with
     * two contributors the larger share is always ≥ 50% and one person always suffices. **A bus
     * factor above 1 is arithmetically impossible with fewer than three contributors**, whatever
     * the split. Worth knowing before reading any repository's numbers: a two-author file is a
     * bus-factor-1 file by definition, and the model is saying something true about it.
     */
    .commit('katherine: rework the shared module', (c) =>
      c
        .edit('src/shared.ts', source('sh2', 80))
        .author(KATHERINE.name, KATHERINE.email)
        .at('2025-11-01T00:00:00+00:00'),
    )
    .commit('grace: work on the shared module too', (c) =>
      c
        .edit('src/shared.ts', source('sh3', 110))
        .author(GRACE.name, GRACE.email)
        .at('2025-11-20T00:00:00+00:00'),
    )
    .commit('margaret: work on the shared module as well', (c) =>
      c
        .edit('src/shared.ts', source('sh4', 130))
        .author(MARGARET.name, MARGARET.email)
        .at('2025-12-05T00:00:00+00:00'),
    )
    /* Grace takes `handed-over.ts` off Ada and rewrites it wholesale. Ada's knowledge of lines
       that no longer exist should decay away, leaving Grace the sole owner — and Grace is here,
       so it is not an island. */
    .commit('grace: rewrite the handed-over module', (c) =>
      c
        .edit('src/handed-over.ts', source('ho2', 120))
        .author(GRACE.name, GRACE.email)
        .at('2025-10-01T00:00:00+00:00'),
    )
    .commit('grace: keep working on the handed-over module', (c) =>
      c
        .edit('src/handed-over.ts', source('ho3', 140))
        .author(GRACE.name, GRACE.email)
        .at('2025-12-01T00:00:00+00:00'),
    )
    /* Grace's own solo file, recent. Bus factor 1 and *not* an island — the case that keeps the
       section readable. */
    .commit('grace: add a module only she touches', (c) =>
      c
        .add('src/active-solo.ts', source('as', 70))
        .author(GRACE.name, GRACE.email)
        .at('2025-12-10T00:00:00+00:00'),
    )
    .build();

  indexDir = mkdtempSync(join(tmpdir(), 'excavate-islands-'));
  store = openStore({
    path: join(indexDir, INDEX_FILE_NAME),
    repoId: repoId('islands-test'),
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
    throughOid: fixture.oid('grace: add a module only she touches'),
  });
}, 180_000);

afterAll(async () => {
  store?.close();
  await fixture?.cleanup();
  if (indexDir !== undefined) rmSync(indexDir, { recursive: true, force: true });
});

/** The island list as paths, which is how the report names them and how a user reads them. */
function islandPaths(limit = 20): string[] {
  return store.rollups.knowledgeIslands(limit).map((island) => {
    const file = store.files.byId(island.file);
    if (file?.currentPath == null) return `file ${island.file}`;
    return store.files.pathOf(file.currentPath) ?? `file ${island.file}`;
  });
}

describe('knowledge islands', () => {
  it('reports the file whose only owner left', () => {
    expect(islandPaths()).toContain('src/abandoned.ts');
  });

  it('does not report a solo file whose owner is still active', () => {
    /* The discrimination that makes the section worth reading. `active-solo.ts` has a bus factor
       of exactly 1 — identical to `abandoned.ts` on that axis — and differs only in whether its
       owner is still around. */
    expect(islandPaths()).not.toContain('src/active-solo.ts');
  });

  it('does not report a file with three current owners', () => {
    expect(islandPaths()).not.toContain('src/shared.ts');
  });

  it('does not report a file whose knowledge was handed over', () => {
    /* Ada wrote it and left; Grace rewrote it and is here. Reporting this would mean the decay
       term is not working, and every file a departed engineer ever touched would be an island. */
    expect(islandPaths()).not.toContain('src/handed-over.ts');
  });

  it('gives the abandoned file a bus factor of one and an inactive owner', () => {
    const island = store.rollups
      .knowledgeIslands(20)
      .find((candidate) => pathOf(candidate.file) === 'src/abandoned.ts');
    expect(island, 'abandoned.ts is not in the island list').not.toBeUndefined();
    expect(island?.busFactor).toBe(1);
    // Zero bits of entropy: one person holds everything, which is what makes it an island.
    expect(island?.entropy).toBeCloseTo(0, 5);

    const owner = island?.topPerson == null ? null : store.people.byId(island.topPerson);
    expect(owner?.canonicalName).toBe(ADA.name);
    expect(inactiveDays(owner?.lastSeen ?? NOW)).toBeGreaterThan(183);
  });

  it('rates the shared file as genuinely shared', () => {
    /* Asserted on the ownership row rather than on the island list, so a bug that dropped the
       file from the list for the wrong reason — never analysed, say — cannot pass as a correct
       exclusion. Two owners and non-zero entropy is the positive statement. */
    const shared = store.rollups
      .hotspots(50)
      .find((spot) => pathOf(spot.file) === 'src/shared.ts');
    expect(shared, 'shared.ts was never analysed').not.toBeUndefined();

    const ownership = store.rollups.ownership(shared!.file);
    expect(ownership?.busFactor ?? 0).toBeGreaterThan(1);
    expect(ownership?.entropy ?? 0).toBeGreaterThan(0);
  });
});

function pathOf(file: Parameters<typeof store.files.byId>[0]): string {
  const entity = store.files.byId(file);
  if (entity?.currentPath == null) return `file ${file}`;
  return store.files.pathOf(entity.currentPath) ?? `file ${file}`;
}

function inactiveDays(at: Timestamp): number {
  return (NOW.epochSeconds - at.epochSeconds) / 86_400;
}
