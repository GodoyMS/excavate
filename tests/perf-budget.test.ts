/**
 * The perf budgets, asserted — ROADMAP M1's "Perf budgets asserted in CI".
 *
 * **What this test can and cannot do, stated up front.** The ROADMAP's budgets are written against
 * `ripgrep` (< 8s) and `rust-analyzer` (< 45s), and neither can be cloned in CI. So this asserts
 * the two budgets that survive translation to a synthetic repository — *throughput* and *bytes per
 * indexed commit* — and leaves the wall-clock-on-real-history numbers to the milestone check
 * recorded in ADR-0003. A test that quietly redefined "under 45 seconds on rust-analyzer" as
 * "under 45 seconds on a 300-commit fixture" would pass forever while meaning nothing.
 *
 * The bytes-per-commit budget is the one ADR-0003 introduced, replacing "≤ 5% of `.git`" after that
 * budget turned out to measure how well `git gc` had packed the other side of the fraction rather
 * than anything about this code.
 *
 * **The thresholds are deliberately loose.** A shared CI runner is not a benchmark machine, and a
 * perf test that fails on a noisy neighbour gets disabled within a month — at which point it
 * protects nothing. These are set to catch an order-of-magnitude regression, which is what
 * accidental O(n²) and a forgotten index actually look like. The measured headroom on real
 * hardware is recorded in ADR-0003 and is more than 2× on every budget.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoId } from '@wise-excavate/core';
import { DEFAULT_WALK_SPEC, CliGitBackend } from '@wise-excavate/git';
import type { FixtureRepo } from '@wise-excavate/git-fixtures';
import { repo } from '@wise-excavate/git-fixtures';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';
import { createIndexPipeline } from '@wise-excavate/index';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Enough commits for per-commit cost to converge, few enough that building the fixture with real
 * `git` stays under the hook timeout. The schema's fixed overhead — page headers, empty indexes,
 * the FTS5 structure — is a few tens of KB, so at 40 commits it would dominate the measurement and
 * the budget would be testing SQLite's minimum file size.
 */
const COMMITS = 240;

/** ADR-0003 as amended at M2. Measured with hunks: 3.27 KB on `ripgrep`, 3.60 on `rust-analyzer`. */
const MAX_BYTES_PER_COMMIT = 5 * 1024;

/**
 * A catastrophic-regression tripwire, **not** the ROADMAP's throughput budget.
 *
 * The budget is ≥ 25k commits/min and the corpora measure 65k–79k. This fixture cannot check that,
 * and the first version of this test pretending otherwise failed immediately at 4,126 — because it
 * runs while three sibling forks are building their own fixtures with real `git`, so what it
 * measures is how contended the machine is. That is the flaky-perf-test failure mode this file's
 * header warns about, and it took one run to walk into it.
 *
 * So the floor is set two orders of magnitude below the budget, where only a genuine algorithmic
 * regression can reach it: an accidental O(n²) over commits, a query moved inside the walk loop, a
 * dropped index. Real throughput is measured on the corpora at each milestone boundary and recorded
 * in ADR-0003, which is the only place it can be measured honestly.
 */
const MIN_COMMITS_PER_MINUTE = 600;

let fixture: FixtureRepo;
let indexDir: string;
let elapsedMs = 0;
let indexedCommits = 0;
let indexBytes = 0;

beforeAll(async () => {
  let builder = repo('perf-budget');

  /* Every path this fixture will ever touch, created once in the root commit. The builder rejects
     `edit()` on a path that does not exist — correctly, since a fixture that silently created files
     on edit could not express "modify" and "add" as different operations — so the working set has
     to be seeded. */
  const live = new Set<string>();
  builder = builder.commit('root: seed the working set', (c) => {
    for (let area = 0; area < 12; area += 1) {
      for (let f = 0; f < 40; f += 1) {
        const path = `src/area${area}/file${f}.ts`;
        live.add(path);
        c.add(path, `export const seed = ${area * 40 + f};\n`);
      }
    }
    c.at('2021-12-31T00:00:00+00:00');
  });

  /* Shaped like real history rather than 240 identical commits: a spread of file counts and churn,
     periodic renames, and messages of varying length. Uniform commits would compress and index far
     better than anything real, so the per-commit cost measured from them would flatter us. */
  for (let i = 0; i < COMMITS; i += 1) {
    /* Resolved *before* the callback, because `live` must reflect the state of the tree at this
       commit — computing paths inside the callback would let a path renamed two commits ago still
       be chosen, and the builder would reject it. */
    const edits: string[] = [];
    for (let f = 0; f < 1 + (i % 5); f += 1) {
      const path = `src/area${(i + f) % 12}/file${(i * 3 + f) % 40}.ts`;
      if (live.has(path) && !edits.includes(path)) edits.push(path);
    }
    const from = `src/area${i % 12}/file${i % 40}.ts`;
    const moving = i % 30 === 29 && live.has(from) && !edits.includes(from);
    const to = `src/moved/f${i}.ts`;
    if (moving) {
      live.delete(from);
      live.add(to);
    }

    builder = builder.commit(
      `commit ${i}: adjust the ${i % 7 === 0 ? 'walker' : 'store'}`,
      (c) => {
        for (const [f, path] of edits.entries()) {
          c.edit(path, () =>
            Array.from(
              { length: 20 + ((i * 7 + f) % 90) },
              (_, n) => `const v${n} = ${n + i};`,
            ).join('\n'),
          );
        }
        if (moving) c.rename(from, to);
        if (i % 11 === 0) {
          c.body(`Longer explanation for commit ${i}, of the kind a real body has.`);
        }
        // A fixed clock: index size must not depend on the day the suite runs.
        c.at(new Date(Date.UTC(2022, 0, 1 + i)).toISOString());
      },
    );
  }

  fixture = await builder.build();
  indexDir = mkdtempSync(join(tmpdir(), 'excavate-perf-'));

  const dbPath = join(indexDir, INDEX_FILE_NAME);
  const store = openStore({ path: dbPath, repoId: repoId('perf-budget-test') });
  try {
    const pipeline = createIndexPipeline({
      backend: new CliGitBackend({ repoRoot: fixture.path }),
      store,
      sinks: [],
      walkSpec: DEFAULT_WALK_SPEC,
    });

    /* Timed around the walk only. Fixture construction is `git` doing 240 commits' worth of work
       and would swamp the measurement — it is the test's setup cost, not the product's. */
    const started = performance.now();
    for await (const progress of pipeline.run({
      tiers: ['metadata'],
      signal: new AbortController().signal,
    })) {
      void progress;
    }
    elapsedMs = performance.now() - started;
    indexedCommits = store.commits.count();
  } finally {
    /* Closed before measuring: with WAL, pages the walk wrote are still in `-wal` until the
       checkpoint that `close()` performs, so a size read taken while the handle is open can
       understate the index by megabytes. */
    store.close();
  }
  indexBytes = statSync(dbPath).size;
}, 300_000);

afterAll(async () => {
  await fixture?.cleanup();
  if (indexDir !== undefined) rmSync(indexDir, { recursive: true, force: true });
});

describe('perf budgets', () => {
  it('indexed the whole fixture, so the measurements describe a full walk', () => {
    // Guards against the budgets passing because the walk stopped early. `+ 1` is the seed commit.
    expect(indexedCommits).toBe(COMMITS + 1);
  });

  it('stays within the per-commit index budget', () => {
    const perCommit = indexBytes / indexedCommits;
    expect(
      perCommit,
      `${(perCommit / 1024).toFixed(2)} KB/commit — budget ${MAX_BYTES_PER_COMMIT / 1024} KB ` +
        `(ADR-0003 as amended; measured 3.27 KB on ripgrep, 3.60 KB on rust-analyzer)`,
    ).toBeLessThan(MAX_BYTES_PER_COMMIT);
  });

  it('has not regressed algorithmically on walk throughput', () => {
    const perMinute = (indexedCommits / elapsedMs) * 60_000;
    expect(
      perMinute,
      `${perMinute.toFixed(0)} commits/min — tripwire floor ${MIN_COMMITS_PER_MINUTE}. ` +
        `This is not the 25k budget: see the constant's comment. Below this floor, suspect an ` +
        `algorithmic regression rather than a slow runner.`,
    ).toBeGreaterThan(MIN_COMMITS_PER_MINUTE);
  });
});
