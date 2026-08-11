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
     * Child processes, not worker threads — and this is a correctness setting, not a tuning one.
     *
     * Two of this project's deliberate choices combine badly with vitest's default `threads`
     * pool. `better-sqlite3` is **synchronous** by design (Part 13: the index is a local file and
     * an async driver would buy nothing but colour), and the fixture builder drives real `git`
     * through **synchronous** spawns. A worker thread doing either blocks its own event loop for
     * seconds, and vitest's reporter RPC lives on that same event loop — so the run dies with
     * `[vitest-worker]: Timeout calling "onTaskUpdate"` while **every test passes and the exit
     * code is 1**. A green suite and a red build is the worst failure shape there is: it looks
     * like flake, so the reflex is to re-run rather than to read.
     *
     * `maxWorkers: 3` was the first attempt and it only moved the threshold — adding one more
     * fixture-heavy suite brought the failure straight back, which is what showed the problem was
     * structural rather than a matter of degree. With `pool: 'forks'` each file gets its own
     * process and its own event loop, so no amount of synchronous work in one file can starve
     * another's RPC. The concurrency cap then goes back to being about CPU, and the fixture
     * builder's synchronous spawns stop being a latent build-breaker.
     */
    pool: 'forks',
    maxWorkers: 4,
    // The end-to-end test builds a 100-commit repository with real `git` and then indexes
    // it; the default 5s timeout is not enough on a cold cache or a slow macOS runner.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: workspaceAliases(),
  },
});
