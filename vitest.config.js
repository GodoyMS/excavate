import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Resolve `@excavate/*` imports to package *source* rather than `dist/`, so
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
    // The end-to-end test builds a 100-commit repository with real `git` and then indexes
    // it; the default 5s timeout is not enough on a cold cache or a slow macOS runner.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: workspaceAliases(),
  },
});
