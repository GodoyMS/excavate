/**
 * The anti-embarrassment test — ROADMAP M1's sharpest acceptance criterion.
 *
 * > "No format-only, generated, or lockfile-only commit appears in the top 50 by significance."
 *
 * Part 8 §8.5.1 states the failure it guards: without penalties, "the most significant commits
 * in this repo" reliably returns the Prettier migration, the licence-header sweep, and a lockfile
 * refresh. Those commits win every naive measure — most files touched, most lines changed — and
 * they are the exact commits nobody wants to read about. A tool that answers the question that
 * way is not slightly wrong; it is worthless, because the user learns nothing and stops trusting
 * every other number on the page.
 *
 * **The fixture is built to make this test hard to pass by accident.** Each noise commit is
 * shaped like a *different* real one, and one of them defeats the detector this repository
 * shipped first:
 *
 * - `prettier` sweep — 40 files, uniform small churn. The codemod shape, caught by uniformity.
 * - `rustfmt everything` — 40 files, churn from 2 to 200 lines. **Uniformity does not catch
 *   this**, and it is not hypothetical: this is ripgrep's `style: rustfmt everything`, which
 *   scored 8th-most-significant in the whole repository before `announcesMechanicalPass` existed.
 * - licence headers — 40 files, +1 line each. Trivially uniform, enormous by file count.
 * - lockfile refresh — `pnpm-lock.yaml` alone, 900 lines.
 * - generated output — `dist/` alone, 700 lines.
 * - a dependency bump that *also* changes source — must **not** be penalised. `lockfile-only`
 *   is all-or-nothing for this reason, and a test that only checked the noise direction would
 *   pass just as well with the flag over-firing.
 *
 * Against them, four authored commits that are small in every naive measure. The test asserts the
 * authored work outranks all of it — which is a statement about the *scoring*, not about
 * filtering, because {@link mostSignificant} deliberately does not exclude flagged commits.
 * Filtering there would let this test pass by proving the filter works rather than that the
 * ranking does.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromDate, parseOid, repoId } from '@wise-excavate/core';
import { DEFAULT_WALK_SPEC, CliGitBackend } from '@wise-excavate/git';
import type { FixtureRepo } from '@wise-excavate/git-fixtures';
import { repo } from '@wise-excavate/git-fixtures';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';
import type { Store } from '@wise-excavate/store';
import { createIndexPipeline } from '@wise-excavate/index';
import { runAnalysis } from '@wise-excavate/analysis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Above `BULK_FILE_THRESHOLD` (30), so every sweep below is genuinely bulk-shaped. */
const SWEEP_FILES = 40;

const sourceFile = (i: number): string => `src/mod${String(i).padStart(2, '0')}.ts`;

/** `n` plausible lines of source, so per-file churn is a number we control exactly. */
const lines = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') +
  '\n';

const NOISE_SUBJECTS = [
  'style: run prettier across the repo',
  'style: rustfmt everything',
  'chore: update licence headers',
  'chore: refresh pnpm-lock.yaml',
  'build: rebuild dist',
] as const;

const AUTHORED_SUBJECTS = [
  'fix: resolve the deadlock in the connection pool',
  'feat: add incremental indexing to the walker',
  'refactor: extract path interning from the walker',
  'fix: correct off-by-one in the rename matcher',
] as const;

let fixture: FixtureRepo;
let indexDir: string;
let store: Store;

beforeAll(async () => {
  let builder = repo('noise-ranking');

  /* Seed every file first, so the sweeps that follow are *edits* with the churn each one is
     supposed to have. Building the sweep out of additions would give every file 100%
     insertions and no deletions, which is not what a formatter's diff looks like. */
  builder = builder.commit('root: initial import', (c) => {
    for (let i = 0; i < SWEEP_FILES; i += 1) c.add(sourceFile(i), lines(200, 'a'));
    c.add('pnpm-lock.yaml', lines(900, 'lock'));
    c.add('dist/bundle.js', lines(700, 'gen'));
    c.at('2020-01-01T00:00:00+00:00');
  });

  /* ── The noise ─────────────────────────────────────────────────────────────── */

  // Uniform: every file changes by about the same small amount. The classic codemod shape.
  builder = builder.commit(NOISE_SUBJECTS[0], (c) => {
    for (let i = 0; i < SWEEP_FILES; i += 1) c.edit(sourceFile(i), lines(203, 'a'));
    c.at('2020-02-01T00:00:00+00:00');
  });

  /* **Wildly non-uniform**, which is what makes this case the important one: churn runs from 2
     lines to 200, so the coefficient of variation is far above `CODEMOD_UNIFORMITY` and the
     uniformity test cannot see it. Only the subject gives it away. */
  builder = builder.commit(NOISE_SUBJECTS[1], (c) => {
    for (let i = 0; i < SWEEP_FILES; i += 1) {
      c.edit(sourceFile(i), lines(203 + i * 5, 'a'));
    }
    c.at('2020-03-01T00:00:00+00:00');
  });

  // +1 line per file: the licence-header sweep. Huge by file count, zero information.
  builder = builder.commit(NOISE_SUBJECTS[2], (c) => {
    for (let i = 0; i < SWEEP_FILES; i += 1) {
      c.edit(sourceFile(i), (prev) => `// Copyright 2020\n${prev}`);
    }
    c.at('2020-04-01T00:00:00+00:00');
  });

  builder = builder.commit(NOISE_SUBJECTS[3], (c) => {
    c.edit('pnpm-lock.yaml', lines(900, 'lock2')).at('2020-05-01T00:00:00+00:00');
  });

  builder = builder.commit(NOISE_SUBJECTS[4], (c) => {
    c.edit('dist/bundle.js', lines(700, 'gen2')).at('2020-06-01T00:00:00+00:00');
  });

  /* ── The authored work ─────────────────────────────────────────────────────── */

  builder = builder
    .commit(AUTHORED_SUBJECTS[0], (c) => {
      c.edit(sourceFile(3), lines(206, 'a'))
        .body(
          'The pool held its mutex across the await, so a second checkout deadlocked.',
        )
        .at('2020-07-01T00:00:00+00:00');
    })
    .commit(AUTHORED_SUBJECTS[1], (c) => {
      c.add('src/incremental.ts', lines(40, 'inc'))
        .edit(sourceFile(4), lines(210, 'a'))
        .body('Resume from the last indexed tip instead of rewalking from the root.')
        .at('2020-08-01T00:00:00+00:00');
    })
    .commit(AUTHORED_SUBJECTS[2], (c) => {
      c.add('src/intern.ts', lines(30, 'intern'))
        .edit(sourceFile(5), lines(170, 'a'))
        .at('2020-09-01T00:00:00+00:00');
    })
    .commit(AUTHORED_SUBJECTS[3], (c) => {
      c.edit(sourceFile(6), lines(201, 'a'))
        .body('The similarity window excluded the last candidate path.')
        .at('2020-10-01T00:00:00+00:00');
    });

  /* The control: a lockfile change *with* source alongside it. This is a real dependency bump
     and it must keep its score — `lockfile-only` is all-or-nothing precisely so this survives. */
  builder = builder.commit('deps: bump the sqlite driver and adapt the store', (c) => {
    c.edit('pnpm-lock.yaml', lines(920, 'lock3'))
      .edit(sourceFile(7), lines(215, 'a'))
      .body(
        'The 12.x driver returns bigint for INTEGER columns, so the codec changed too.',
      )
      .at('2020-11-01T00:00:00+00:00');
  });

  fixture = await builder.build();
  indexDir = mkdtempSync(join(tmpdir(), 'excavate-noise-'));

  store = openStore({
    path: join(indexDir, INDEX_FILE_NAME),
    repoId: repoId('noise-ranking-test'),
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

  /* A fixed `now`, two months after the last commit. Injected rather than taken from the clock
     because knowledge decay and the recency factor both read it: a test that used the real clock
     would keep changing its own inputs and eventually fail on a Tuesday for no reason. */
  await runAnalysis({
    store,
    now: fromDate(new Date('2021-01-01T00:00:00Z')),
    signal: new AbortController().signal,
    throughOid: fixture.oid('deps: bump the sqlite driver and adapt the store'),
  });
}, 180_000);

afterAll(async () => {
  store?.close();
  await fixture?.cleanup();
  if (indexDir !== undefined) rmSync(indexDir, { recursive: true, force: true });
});

/** Score by the subject the fixture was built with, so no assertion mentions an OID. */
function scoreOf(subject: string): number {
  const oid = fixture.oid(subject);
  const commit = store.commits.byOid(parseOid(oid));
  if (commit === null) throw new Error(`${subject} was not indexed`);
  return commit.significance;
}

describe('significance ranking', () => {
  it('ranks every authored commit above every mechanical sweep', () => {
    const worstAuthored = Math.min(...AUTHORED_SUBJECTS.map(scoreOf));
    const bestNoise = Math.max(...NOISE_SUBJECTS.map(scoreOf));

    /* Stated as one comparison rather than a loop because the *gap* is the property worth
       holding: §8.5.1 requires the penalties to outweigh any plausible reward total, so the
       weakest authored commit must still beat the strongest sweep. A per-pair loop would pass
       on a ranking where the two populations merely overlapped a little. */
    expect(bestNoise).toBeLessThan(worstAuthored);
  });

  it('sorts every mechanical sweep to the bottom of the ranking', () => {
    /* The criterion says "top 50". This fixture has 11 commits, so the whole ranking is under
       test — a strictly stronger claim than the criterion, and one that cannot be satisfied by
       there simply being more than 50 commits for a sweep to hide behind.

       Asserted as "the sweeps are the last N" rather than "the sweeps are absent from the first
       N": the two differ when a sweep ties with authored work, and the tie is the case worth
       failing on. */
    const ranked = store.commits.mostSignificant(50).map((c) => c.subject);
    expect(ranked).toHaveLength(NOISE_SUBJECTS.length + AUTHORED_SUBJECTS.length + 2);

    const tail = new Set(ranked.slice(-NOISE_SUBJECTS.length));
    for (const subject of NOISE_SUBJECTS) {
      expect(tail, `${subject} must rank below every authored commit`).toContain(subject);
    }
  });

  it('does not penalise a dependency bump that also changes source', () => {
    const bump = 'deps: bump the sqlite driver and adapt the store';
    /* Above the lockfile refresh by a wide margin, and above the sweeps: the difference
       between the two lockfile commits is entirely that this one changed code as well. If
       `lockfile-only` ever became "touches a lockfile", this is the assertion that fails. */
    expect(scoreOf(bump)).toBeGreaterThan(scoreOf('chore: refresh pnpm-lock.yaml'));
    expect(scoreOf(bump)).toBeGreaterThan(Math.max(...NOISE_SUBJECTS.map(scoreOf)));
  });

  it('flags the non-uniform sweep that only its subject reveals', () => {
    /* Guards the mechanism, not just the outcome. Without this, deleting
       `announcesMechanicalPass` and lowering every reward would still pass the ranking tests
       above — and ripgrep's `rustfmt everything` would be back in the top eight. */
    const oid = fixture.oid('style: rustfmt everything');
    const commit = store.commits.byOid(parseOid(oid));
    expect(commit?.flags).toContain('bulk-mechanical');

    // The uniformity path still works on the commit it was written for.
    const prettier = store.commits.byOid(
      parseOid(fixture.oid('style: run prettier across the repo')),
    );
    expect(prettier?.flags).toContain('bulk-mechanical');
  });

  it('flags the lockfile and generated commits as -only', () => {
    expect(
      store.commits.byOid(parseOid(fixture.oid('chore: refresh pnpm-lock.yaml')))?.flags,
    ).toContain('lockfile-only');
    expect(
      store.commits.byOid(parseOid(fixture.oid('build: rebuild dist')))?.flags,
    ).toContain('generated-only');
  });
});
