import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Resolve `@wise-excavate/*` imports to package *source* rather than `dist/`, so
 * `vitest --watch` reacts to edits anywhere in the graph without a rebuild.
 *
 * Derived from the workspace layout rather than hand-listed, so adding a package
 * never requires touching this file. `tsc -b` independently verifies that the
 * built `dist/` entrypoints typecheck, so both resolution paths stay honest.
 *
 * @returns {Record<string, string>}
 */
function workspaceAliases() {
  const dirs = [
    ...readdirSync('packages').map((d) => join('packages', d)),
    'cli',
    'fixtures',
  ];
  /** @type {Record<string, string>} */
  const aliases = {};
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    aliases[manifest.name] = new URL(`./${dir}/src/index.ts`, import.meta.url).pathname;
  }
  return aliases;
}

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      '{cli,fixtures}/src/**/*.test.ts',
      // The walking skeleton crosses every package, so it belongs to none of them. A
      // package-owned E2E would need a dependency edge the architecture forbids.
      'tests/**/*.test.ts',
    ],
    reporters: ['default'],

    /**
     * Bounded well below the core count on purpose.
     *
     * The fixture suites drive real `git` through **synchronous** spawns, so a worker
     * running one of them blocks its own event loop for seconds at a time and cannot
     * service vitest's reporter RPC. Left unbounded, vitest starts one worker per core,
     * every one of them is CPU-bound on a `git` child process, and the run dies with
     * `[vitest-worker]: Timeout calling "onTaskUpdate"` — **all tests passing, exit code
     * 1**. That is the worst possible failure shape: a green suite and a red build.
     *
     * Three is not a guess: unbounded and `--maxWorkers=6` both reproduced it on a
     * 10-core machine under load, `--maxWorkers=3` did not, and the whole suite still
     * finishes in about a minute because the slow files are I/O-bound on `git` rather
     * than on us.
     *
     * The real fix is for the fixture builder to spawn asynchronously; until then this
     * keeps the exit code honest. CI never hit it (its runners are less contended), which
     * is exactly why it would have been a miserable intermittent failure to diagnose
     * later.
     */
    maxWorkers: 3,
    // The end-to-end test builds a 100-commit repository with real `git` and then indexes
    // it; the default 5s timeout is not enough on a cold cache or a slow macOS runner.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: workspaceAliases(),
  },
});
