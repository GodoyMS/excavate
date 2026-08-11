/**
 * The fitness function for ADR-0001.
 *
 * An architecture decision that isn't enforced decays. This script is the enforcement
 * for the package graph and for the boundary rules of Part 7 §7.3 that can be checked
 * mechanically. `tsc -b` catches cycles; this catches everything else, and it catches
 * them with an error message that explains the rule rather than just failing.
 *
 * The table below IS the architecture. Adding an edge means editing this file, which
 * makes every new coupling a visible, reviewable decision instead of an npm install.
 *
 * Run: `pnpm check:deps`
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve } from 'node:path';

const BUILTIN_MODULES = new Set(builtinModules);

const CORE = '@wise-excavate/core';
const GIT = '@wise-excavate/git';
const STORE = '@wise-excavate/store';
const FIXTURES = '@wise-excavate/git-fixtures';

/** @type {Record<string, { dir: string, deps: string[], note?: string }>} */
const ARCHITECTURE = {
  [CORE]: {
    dir: 'packages/core',
    deps: [],
    note: 'Depended on by everything, so it depends on nothing.',
  },
  [GIT]: { dir: 'packages/git', deps: [CORE] },
  [STORE]: { dir: 'packages/store', deps: [CORE] },
  '@wise-excavate/ai': {
    dir: 'packages/ai',
    deps: [CORE],
    note: 'Rule B3 is structural: with no store and no evidence edge, it cannot retrieve.',
  },
  '@wise-excavate/ui': {
    dir: 'packages/ui',
    deps: [CORE],
    note: 'Browser target. Depends on the API contract, never on the server.',
  },
  '@wise-excavate/index': { dir: 'packages/index', deps: [CORE, GIT, STORE] },
  '@wise-excavate/analysis': {
    dir: 'packages/analysis',
    deps: [CORE, STORE],
    note: 'Reads from the store; never touches git.',
  },
  '@wise-excavate/evidence': {
    dir: 'packages/evidence',
    deps: [CORE, GIT, STORE],
    note: 'Reads analysis output via store rollups, so it needs no analysis edge.',
  },
  '@wise-excavate/server': {
    dir: 'packages/server',
    deps: [
      CORE,
      GIT,
      STORE,
      '@wise-excavate/index',
      '@wise-excavate/analysis',
      '@wise-excavate/evidence',
      '@wise-excavate/ai',
    ],
    note: 'The composition root — the only package that knows about all the others.',
  },
  'wise-excavate': {
    dir: 'cli',
    deps: [CORE, '@wise-excavate/server', '@wise-excavate/ui'],
    note: 'A presentation surface above the daemon, so it is what chooses the front end to serve.',
  },
  [FIXTURES]: {
    dir: 'fixtures',
    deps: [],
    note: 'Published standalone; a general-purpose fixture builder takes no domain model.',
  },
};

/**
 * Test-only packages: may be declared by any package, are required by none, and must
 * never appear as a *runtime* dependency.
 *
 * `@wise-excavate/git-fixtures` builds real repositories, so every package that parses or
 * queries Git history wants it in tests. Part 14 §14.2 anticipated this ("testkit is a
 * normal dependency … excluded from release builds by a feature flag"); in npm terms
 * the mechanism is `devDependencies`, and this rule is what keeps it there. It cannot
 * introduce a cycle because it depends on nothing.
 */
const TEST_ONLY = new Set([FIXTURES]);

/** Populated by rule 1: which test-only packages each package actually declared. */
/** @type {Map<string, string[]>} */
const testDeps = new Map();

/**
 * The bare builtin name behind a specifier, or `null` if it is not a Node builtin.
 *
 * **`node:fs` and `fs` are the same import.** An earlier version of this file compared
 * against the prefixed form only, so `import 'child_process'` walked straight through a
 * rule whose whole purpose was to stop it — and `@types/node` declares the bare form, so it
 * typechecked. A boundary rule that is trivially bypassed by deleting five characters is
 * worse than no rule, because ADR-0001 and the README both claim this one is mechanical.
 * Derived from `builtinModules` rather than a hand-written list so it cannot fall behind.
 */
function builtinOf(spec) {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  return BUILTIN_MODULES.has(bare) ? bare : null;
}

/** Everything that can reach the filesystem, a subprocess, or the network. */
const IO_BUILTINS = new Set([
  'child_process',
  'fs',
  'fs/promises',
  'net',
  'tls',
  'dgram',
  'http',
  'https',
  'http2',
  'dns',
  'worker_threads',
  'vm',
]);

const everyPackageExcept = (name) =>
  new Set(Object.keys(ARCHITECTURE).filter((n) => n !== name));

/**
 * Boundary rules that reduce to "who may import what". The rules that cannot be
 * mechanised (B4: the UI computes nothing analytical; B5: every feature has a no-AI
 * path) stay review gates, and are named in ADR-0001 so they are not forgotten.
 */
const IMPORT_RULES = [
  {
    id: 'B1',
    rule: 'Only @wise-excavate/git touches the repository.',
    // git-fixtures is exempt by design: it only ever creates fixtures in a temp dir.
    allowed: new Set([GIT, FIXTURES]),
    matches: (spec) => builtinOf(spec) === 'child_process',
  },
  {
    id: 'B2',
    rule: 'Only @wise-excavate/store writes SQL.',
    allowed: new Set([STORE]),
    matches: (spec) => /sqlite/i.test(spec) || builtinOf(spec) === 'sqlite',
  },
  {
    id: 'B3',
    rule:
      '@wise-excavate/ai never retrieves, so it gets no filesystem, subprocess, or network ' +
      'capability. Its input is an EvidenceBundle the caller hands it.',
    /* ADR-0001 claims `ai` "cannot retrieve" as a property of the graph rather than a rule
       under review. Dropping its edges to `store` and `evidence` is most of that, but a
       package that can `readFileSync` its way into `.git` retrieves just as effectively —
       so the capability, not only the edge, has to be denied for the claim to be true. */
    allowed: everyPackageExcept('@wise-excavate/ai'),
    matches: (spec) => {
      const builtin = builtinOf(spec);
      return builtin !== null && IO_BUILTINS.has(builtin);
    },
  },
  {
    id: 'browser',
    rule: '@wise-excavate/ui targets a browser and must import no Node builtin.',
    allowed: everyPackageExcept('@wise-excavate/ui'),
    matches: (spec) => builtinOf(spec) !== null,
  },
];

const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Every `.ts` file under `root`, or none if it does not exist. @returns {string[]} */
function walkTypeScript(root) {
  /** @type {string[]} */
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) found.push(path);
    }
  };
  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch {
    /* a directory that does not exist yet is not an error */
  }
  return found;
}

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  return walkTypeScript(join(dir, 'src'));
}

/** @param {string} file @returns {string[]} */
function importsOf(file) {
  const source = readFileSync(file, 'utf8');
  /** @type {string[]} */
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

/** @type {string[]} */
const problems = [];
const fail = (message) => problems.push(message);

const names = Object.keys(ARCHITECTURE);
const dirToName = new Map(names.map((name) => [resolve(ARCHITECTURE[name].dir), name]));

/* ── 1. Declared dependencies match the architecture exactly ────────────────── */

for (const name of names) {
  const { dir, deps } = ARCHITECTURE[name];
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

  if (manifest.name !== name) {
    fail(`${dir}/package.json declares name "${manifest.name}", expected "${name}"`);
  }

  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const declaredInternal = Object.keys(declared).filter((d) => d in ARCHITECTURE);
  const expected = new Set(deps);
  testDeps.set(name, []);

  for (const dep of declaredInternal) {
    if (declared[dep] !== 'workspace:*') {
      fail(
        `${name} depends on ${dep} as "${declared[dep]}" — internal deps must use "workspace:*".`,
      );
    }

    if (TEST_ONLY.has(dep)) {
      // Allowed anywhere, required nowhere — but only ever for testing.
      if (manifest.dependencies?.[dep] !== undefined) {
        fail(
          `${name} declares ${dep} as a runtime dependency. It is a testing library: ` +
            `move it to devDependencies so it is never shipped to users.`,
        );
      } else {
        testDeps.get(name).push(dep);
      }
      continue;
    }

    if (!expected.has(dep)) {
      fail(
        `${name} declares a dependency on ${dep}, which the architecture does not permit.\n` +
          `      If this edge is genuinely needed, add it to ARCHITECTURE in scripts/check-deps.mjs\n` +
          `      and say why in docs/adr/0001-package-graph.md.`,
      );
    }
  }
  for (const dep of deps) {
    if (!declaredInternal.includes(dep)) {
      fail(`${name} is missing its declared architectural dependency on ${dep}.`);
    }
  }
}

/* ── 2. Imports are a subset of declared dependencies (no phantom deps) ─────── */

for (const name of names) {
  const { dir, deps } = ARCHITECTURE[name];
  const allowed = new Set([...deps, ...(testDeps.get(name) ?? []), name]);
  for (const file of sourceFiles(dir)) {
    const isTest = file.endsWith('.test.ts');
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('@wise-excavate/') && spec !== 'excavate') continue;
      const target = names.find((n) => spec === n || spec.startsWith(`${n}/`));
      if (!target) {
        fail(
          `${relative('.', file)} imports "${spec}", which is not a workspace package.`,
        );
      } else if (!allowed.has(target)) {
        fail(
          `${relative('.', file)} imports ${target}, but ${name} does not declare that dependency.`,
        );
      } else if (TEST_ONLY.has(target) && !isTest) {
        fail(
          `${relative('.', file)} imports ${target} from non-test source. ` +
            `A testing library must not be reachable from shipped code.`,
        );
      }
    }
  }
}

/* ── 3. Boundary rules ─────────────────────────────────────────────────────── */

for (const name of names) {
  for (const file of sourceFiles(ARCHITECTURE[name].dir)) {
    for (const spec of importsOf(file)) {
      for (const { id, rule, allowed, matches } of IMPORT_RULES) {
        if (matches(spec) && !allowed.has(name)) {
          fail(`${relative('.', file)} imports "${spec}", violating ${id}: ${rule}`);
        }
      }
    }
  }
}

/**
 * The root `tests/` tree, which belongs to no package and was therefore scanned by nothing.
 *
 * An end-to-end test legitimately imports across every boundary — that is what makes it
 * end-to-end — so the graph rules do not apply to it. **B2 still does.** A test that reached
 * for `better-sqlite3` directly would be writing SQL outside the store, and it would do so
 * while sitting in the one directory that had no lint at all, which is exactly where such a
 * shortcut would survive. It must go through `@wise-excavate/store` like everything else.
 */
for (const file of walkTypeScript('tests')) {
  for (const spec of importsOf(file)) {
    if (IMPORT_RULES[1].matches(spec)) {
      fail(
        `${relative('.', file)} imports "${spec}", violating B2: ${IMPORT_RULES[1].rule} ` +
          `An end-to-end test may cross package boundaries, but not this one.`,
      );
    }
  }
}

/* ── 4. tsconfig references stay in sync with the dependency graph ──────────── */

for (const name of names) {
  const { dir, deps } = ARCHITECTURE[name];
  // Per-package tsconfigs are kept comment-free so they are plain JSON. Prose that
  // explains a compiler option belongs in the package's own doc comment, where a
  // reader will actually meet it.
  const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  const referenced = new Set(
    (tsconfig.references ?? []).map((ref) => dirToName.get(resolve(dir, ref.path))),
  );
  for (const dep of deps) {
    if (!referenced.has(dep)) {
      fail(
        `${dir}/tsconfig.json is missing a project reference to ${dep}. ` +
          `Without it, tsc -b builds in the wrong order.`,
      );
    }
  }
  for (const ref of referenced) {
    if (ref === undefined)
      fail(`${dir}/tsconfig.json has a reference to an unknown project.`);
    else if (!deps.includes(ref)) {
      fail(`${dir}/tsconfig.json references ${ref}, which is not a declared dependency.`);
    }
  }
}

/* ── 5. Acyclicity, and the depth each package sits at ─────────────────────── */

/** @type {Map<string, number>} */
const depths = new Map();
/** @param {string} name @param {string[]} stack @returns {number} */
function depthOf(name, stack = []) {
  if (stack.includes(name)) {
    fail(`Dependency cycle: ${[...stack, name].join(' → ')}`);
    return 0;
  }
  const cached = depths.get(name);
  if (cached !== undefined) return cached;
  const deps = ARCHITECTURE[name].deps;
  const depth =
    deps.length === 0
      ? 0
      : 1 + Math.max(...deps.map((d) => depthOf(d, [...stack, name])));
  depths.set(name, depth);
  return depth;
}
for (const name of names) depthOf(name);

/* ── Report ────────────────────────────────────────────────────────────────── */

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} architecture violation(s):\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('');
  process.exit(1);
}

const ordered = [...names].sort(
  (a, b) => depths.get(a) - depths.get(b) || a.localeCompare(b),
);
console.log('\n✓ Package graph is acyclic and matches the architecture.\n');
for (const name of ordered) {
  const deps = ARCHITECTURE[name].deps;
  const shown =
    deps.length === 0
      ? '—'
      : deps.map((d) => d.replace('@wise-excavate/', '')).join(', ');
  console.log(`  depth ${depths.get(name)}  ${name.padEnd(24)} ← ${shown}`);
}
console.log(
  `\n  ${names.length} packages · boundary rules B1, B2 enforced · B4, B5 are review gates\n`,
);
