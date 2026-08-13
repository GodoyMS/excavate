/**
 * The M1 perf budgets and the anti-embarrassment assertion, against a real repository.
 *
 * ROADMAP M1 asks for two things that a fixture cannot provide:
 *
 * - **Perf budget** — walk ≥ 25k commits/min, `ripgrep` full index < 8s, `rust-analyzer` < 45s,
 *   index within ADR-0003's per-commit budget. A 240-commit fixture cannot demonstrate any of
 *   the first three; it is a tripwire
 *   for algorithmic regressions (`tests/perf-budget.test.ts`), and calling it the budget would be
 *   claiming a measurement nobody took.
 * - **The anti-embarrassment test** — "on all three targets, assert no format-only, generated, or
 *   lockfile-only commit appears in the top-50 by significance". The fixture version proves the
 *   penalties fire on commits built to trip them. Only a real repository proves they fire on
 *   commits nobody designed for the test, which is the entire claim.
 *
 * Run against a checkout: `node scripts/perf-assert.mjs <repo> --budget-seconds=8`.
 *
 * **Why the wall-clock budget is a warning and the rest are failures.** CI runners vary by more
 * than 2× between cold and warm hosts, so a hard wall-clock gate would fail builds for reasons
 * unrelated to the commit under test, and a suite that cries wolf gets ignored — which costs more
 * than the check was worth. Throughput, index size, and noise ranking are all either
 * machine-independent or nearly so, so those are hard failures. Part 13 §13.9's tolerance
 * guidance, applied honestly: gate what the machine cannot move.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fromDate, repoId } from '@wise-excavate/core';
import { CliGitBackend, DEFAULT_WALK_SPEC } from '@wise-excavate/git';
import { createIndexPipeline } from '@wise-excavate/index';
import { runAnalysis } from '@wise-excavate/analysis';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';

/** ROADMAP M1: "Walk ≥ 25k commits/min." */
const MIN_COMMITS_PER_MINUTE = 25_000;

/**
 * ADR-0003, which supersedes ROADMAP M1's "Index ≤ 5% of `.git`".
 *
 * That budget was missed on both corpora by roughly 7×, and the ADR's finding was that it gets
 * *easier* as a repository grows — `ripgrep` holds ten years of history in 6.8 MB because delta
 * chains over a small, stable file set compress extraordinarily well, so a fixed fraction of
 * `.git` measures git's compression rather than our storage. Bytes per indexed commit measures
 * what we actually control.
 *
 * Amended at M2 from 3 KB to 5 KB: the original figure was measured on an index that held no
 * line-level geometry, and hunks are what let `excavate why` answer about a line rather than a
 * file. Two reductions were made before the number moved — non-source files carry no hunks, and
 * `hunks` has one index rather than two — and the 5 KB includes headroom for `links` and
 * `coupling`, which M2 has not populated yet. See the amendment in ADR-0003 for what would make
 * a *third* increase the wrong answer.
 *
 * Measured with hunks: 3.27 KB on `ripgrep`, 3.60 KB on `rust-analyzer`.
 */
const MAX_BYTES_PER_COMMIT = 5 * 1024;

/** ROADMAP M1: no noise commit in the top *fifty* by significance, not the top eight shown. */
const SIGNIFICANCE_DEPTH = 50;

/**
 * The flags that disqualify a commit from the significance ranking.
 *
 * `bulk-mechanical` is included alongside the three the ROADMAP names because at M1 it is what
 * stands in for `format-only`: whitespace-only detection needs the hunk bodies that arrive in M2,
 * so a codemod is currently caught by its scale and uniformity, or by a subject that names the
 * tool that made it. Leaving it out would let `style: rustfmt everything` pass a test written to
 * exclude exactly that commit.
 */
const NOISE_FLAGS = ['format-only', 'generated-only', 'lockfile-only', 'bulk-mechanical'];

const args = process.argv.slice(2);
const repoPath = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const budgetArg = args.find((a) => a.startsWith('--budget-seconds='));
const budgetSeconds = budgetArg === undefined ? null : Number(budgetArg.split('=')[1]);

const failures = [];
const warnings = [];

const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);

function directorySize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
  cwd: repoPath,
  encoding: 'utf8',
}).trim();

const indexDir = mkdtempSync(join(tmpdir(), 'excavate-perf-'));
const store = openStore({
  path: join(indexDir, INDEX_FILE_NAME),
  repoId: repoId(`perf-${repoPath}`),
});

const started = process.hrtime.bigint();
const pipeline = createIndexPipeline({
  backend: new CliGitBackend({ repoRoot: repoPath }),
  store,
  sinks: [],
  walkSpec: DEFAULT_WALK_SPEC,
});
for await (const progress of pipeline.run({
  /* Both ground-truth tiers, because that is what a user's index contains: `openSession`
     asks for every implemented tier, so measuring only `metadata` would report a number
     nobody experiences. */
  tiers: ['metadata', 'content'],
  signal: new AbortController().signal,
})) {
  void progress;
}
const walkMs = Number(process.hrtime.bigint() - started) / 1e6;

const commits = store.commits.count();
const headOid = store.commits.byId(commits - 1)?.oid;
await runAnalysis({
  store,
  now: fromDate(new Date()),
  signal: new AbortController().signal,
  throughOid: headOid,
});
const totalMs = Number(process.hrtime.bigint() - started) / 1e6;

/* ── Throughput ──────────────────────────────────────────────────────────── */

const perMinute = (commits / walkMs) * 60_000;
if (perMinute < MIN_COMMITS_PER_MINUTE) {
  fail(
    `walk throughput ${Math.round(perMinute).toLocaleString()} commits/min is below the ` +
      `${MIN_COMMITS_PER_MINUTE.toLocaleString()} budget (${commits.toLocaleString()} commits in ${walkMs.toFixed(0)}ms)`,
  );
}

/* ── Index size ──────────────────────────────────────────────────────────── */

const indexBytes = directorySize(indexDir);
const gitBytes = directorySize(gitDir);
const perCommit = indexBytes / commits;
if (perCommit > MAX_BYTES_PER_COMMIT) {
  fail(
    `index is ${(perCommit / 1024).toFixed(2)} KB/commit, over the ` +
      `${MAX_BYTES_PER_COMMIT / 1024} KB budget from ADR-0003 ` +
      `(${(indexBytes / 1e6).toFixed(1)}MB across ${commits.toLocaleString()} commits)`,
  );
}

/* ── Wall clock ──────────────────────────────────────────────────────────── */

if (budgetSeconds !== null && totalMs / 1000 > budgetSeconds) {
  warn(
    `full index took ${(totalMs / 1000).toFixed(1)}s against a ${budgetSeconds}s budget — ` +
      `not a failure, because runner speed varies by more than the margin, but investigate ` +
      `if it persists across runs`,
  );
}

/* ── The anti-embarrassment assertion ────────────────────────────────────── */

const top = store.commits.mostSignificant(SIGNIFICANCE_DEPTH);
const offenders = top
  .map((commit, rank) => ({ commit, rank }))
  .filter(({ commit }) => commit.flags.some((flag) => NOISE_FLAGS.includes(flag)));

if (offenders.length > 0) {
  const lines = offenders
    .map(
      ({ commit, rank }) =>
        `      #${rank + 1} ${commit.oid.slice(0, 7)} [${commit.flags.join(',')}] ${commit.subject}`,
    )
    .join('\n');
  fail(
    `${offenders.length} noise commit(s) reached the top ${SIGNIFICANCE_DEPTH} by significance:\n${lines}`,
  );
}

/* ── Report ──────────────────────────────────────────────────────────────── */

process.stdout.write(
  `\n  ${repoPath}\n` +
    `  ${commits.toLocaleString()} commits · walk ${walkMs.toFixed(0)}ms ` +
    `(${Math.round(perMinute).toLocaleString()}/min) · full ${(totalMs / 1000).toFixed(1)}s\n` +
    `  index ${(indexBytes / 1e6).toFixed(1)}MB = ${(perCommit / 1024).toFixed(2)} KB/commit ` +
    `(.git is ${(gitBytes / 1e6).toFixed(1)}MB)\n` +
    `  top ${SIGNIFICANCE_DEPTH} by significance: ${offenders.length} noise commits\n\n`,
);

store.close();
rmSync(indexDir, { recursive: true, force: true });

for (const message of warnings) process.stdout.write(`  warning: ${message}\n`);
for (const message of failures) process.stderr.write(`  FAIL: ${message}\n`);
process.exit(failures.length === 0 ? 0 : 1);
