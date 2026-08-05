/**
 * The fixture matrix — the 24 named cases of `FIXTURE_CASES`, as DSL scripts.
 *
 * Two rules govern everything in this file.
 *
 * **Each case must actually exhibit the phenomenon it names**, as observed by `git`
 * itself, not as asserted by our own parser. `rename-chain` really renames a→b→c;
 * `resurrection` really deletes a path and re-adds it at the same path in a *later*
 * commit; `revert-diff-inverse` really inverts a diff without the word "revert"
 * appearing anywhere in the message. `matrix.test.ts` verifies each one by shelling out
 * to git, because a fixture that quietly stopped exhibiting its phenomenon would turn
 * every test that depends on it into a test of nothing.
 *
 * **The scripts are data, not behaviour.** Each case is a `(RepoBuilder) => void`, so
 * this module imports no runtime value from `index.ts` and the module graph stays
 * acyclic. `fixture(name)` supplies the builder.
 */

import type { FixtureCase, RepoBuilder } from './index.js';

/* ── Content ───────────────────────────────────────────────────────────────── */

/**
 * File bodies are real-ish TypeScript at real-ish sizes (10–25 lines) because
 * similarity scoring is proportional: a rename plus an edit only lands in the
 * interesting 50–99% band if the file is big enough for a partial edit to be partial.
 * Two-line files rename at 100% or not at all.
 */
const PARSER_V1 = `export interface Token {
  readonly kind: 'word' | 'number';
  readonly text: string;
}

export function parse(input: string): Token[] {
  const tokens: Token[] = [];
  for (const raw of input.split(/\\s+/)) {
    tokens.push({ kind: /^\\d+$/.test(raw) ? 'number' : 'word', text: raw });
  }
  return tokens;
}
`;

const PARSER_V2 = `export interface Token {
  readonly kind: 'word' | 'number';
  readonly text: string;
}

export function parse(input: string): Token[] {
  if (input.trim() === '') return [];
  const tokens: Token[] = [];
  for (const raw of input.split(/\\s+/)) {
    if (raw === '') continue;
    tokens.push({ kind: /^\\d+$/.test(raw) ? 'number' : 'word', text: raw });
  }
  return tokens;
}
`;

const HTTP_CLIENT_V1 = `const DEFAULT_TIMEOUT_MS = 5_000;

export interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly timeoutMs?: number;
}

export async function request(url: string, options: RequestOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: options.method, signal: controller.signal });
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
`;

/** Same file, ~40% of the lines changed: enough to be a rename *with* an edit. */
const HTTP_CLIENT_V2 = `const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_LIMIT = 3;

export interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly timeoutMs?: number;
  readonly retries?: number;
}

export async function request(url: string, options: RequestOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: options.method, signal: controller.signal });
    if (!response.ok) throw new Error(\`request failed: \${response.status}\`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export const maxRetries = (options: RequestOptions): number => options.retries ?? RETRY_LIMIT;
`;

const TOKENIZER = `const WHITESPACE = /\\s+/;

export interface Lexeme {
  readonly offset: number;
  readonly text: string;
}

export function tokenize(source: string): Lexeme[] {
  const out: Lexeme[] = [];
  let offset = 0;
  for (const part of source.split(WHITESPACE)) {
    if (part !== '') out.push({ offset, text: part });
    offset += part.length + 1;
  }
  return out;
}
`;

/** ~90% identical to {@link TOKENIZER}: a delete+add pair only a heuristic can join. */
const LEXER = `const WHITESPACE = /\\s+/;

export interface Lexeme {
  readonly offset: number;
  readonly text: string;
}

export function lex(source: string): Lexeme[] {
  const out: Lexeme[] = [];
  let offset = 0;
  for (const part of source.split(WHITESPACE)) {
    if (part !== '') out.push({ offset, text: part });
    offset += part.length + 1;
  }
  return out;
}
`;

const USERS_HANDLER = `import { request } from '../net/client.js';

export interface User {
  readonly id: string;
  readonly name: string;
}

export async function listUsers(base: string): Promise<User[]> {
  const body = await request(\`\${base}/users\`, { method: 'GET' });
  return JSON.parse(body) as User[];
}

export async function getUser(base: string, id: string): Promise<User> {
  const body = await request(\`\${base}/users/\${id}\`, { method: 'GET' });
  return JSON.parse(body) as User;
}
`;

const RETRY_V1 = `export const RETRY_BUDGET = 3;

export async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_BUDGET; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

const RETRY_V2 = RETRY_V1.replace('RETRY_BUDGET = 3', 'RETRY_BUDGET = 25');

const REPORT_TWO_SPACE = `export interface Row {
  readonly label: string;
  readonly amount: number;
}

export function total(rows: Row[]): number {
  return rows.reduce((sum, row) => sum + row.amount, 0);
}

export function render(rows: Row[]): string {
  return rows.map((row) => \`\${row.label}: \${row.amount}\`).join('\\n');
}
`;

/** The same file reindented to four spaces: every line changes, no behaviour does. */
const REPORT_FOUR_SPACE = REPORT_TWO_SPACE.split('\n')
  .map((line) => (line.startsWith('  ') ? `  ${line}` : line))
  .join('\n');

const LOCKFILE = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.20
        version: 4.17.20
`;

/**
 * A deterministic binary-looking blob.
 *
 * Every byte is kept below 0x80 on purpose: the DSL takes strings and writes them as
 * UTF-8, so a code point ≥ 0x80 would occupy two bytes and the blob's length would stop
 * matching its character count — surprising in a fixture whose whole job is to be a
 * known quantity. Below 0x80, UTF-8 is byte-exact.
 *
 * The leading NUL is what makes git classify the blob as binary, which is the point of
 * the case. It is written as a `\u0000` escape rather than as a raw byte deliberately:
 * a literal NUL in a source file makes `grep`, `file`, and several editors treat this
 * module as binary data and silently skip it. The generator emits further NULs of its
 * own whenever `state % 0x80` lands on zero, but nothing may depend on that, so the
 * first byte after the magic is unconditional.
 */
function pseudoBinary(seed: number, length: number): string {
  let state = seed;
  let out = 'GIFB\u0000';
  for (let i = out.length; i < length; i += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    out += String.fromCharCode(state % 0x80);
  }
  return out;
}

/**
 * Unicode paths in composed (NFC) form.
 *
 * `café` here is `c`, `a`, `f`, U+00E9 — one code point — not `e` + U+0301. The path
 * bytes come from this literal via argv, so the index records NFC on every platform;
 * `core.precomposeunicode=true` (see `git.ts`) closes the other direction, where macOS
 * hands back NFD from the filesystem.
 */
const UNICODE_PATHS = {
  accented: 'src/i18n/café.ts',
  japanese: 'src/i18n/日本語.ts',
  emoji: 'docs/🚀-launch.md',
} as const;

const CRLF_SCRIPT = ['@echo off', 'set BUILD=release', 'call npm run build', 'exit /b 0']
  .join('\r\n')
  .concat('\r\n');
const LF_SCRIPT = CRLF_SCRIPT.replaceAll('\r\n', '\n');

const ADA = 'Ada Lovelace';
const GRACE = 'Grace Hopper';

/* ── The cases ─────────────────────────────────────────────────────────────── */

export const CASE_SCRIPTS: Readonly<Record<FixtureCase, (b: RepoBuilder) => void>> = {
  /** Four commits, two authors, one release tag. The baseline everything else varies. */
  'simple-linear': (b) => {
    b.commit('add the parser', (c) => c.add('src/parser.ts', PARSER_V1).author(ADA))
      .commit('add a parser test', (c) =>
        c
          .add(
            'test/parser.test.ts',
            `import { parse } from '../src/parser.js';\n\nconsole.assert(parse('a 1').length === 2);\n`,
          )
          .author(ADA),
      )
      .commit('handle empty input', (c) =>
        c
          .edit('src/parser.ts', PARSER_V2)
          .author(GRACE)
          .body('Empty input returned a single empty token.'),
      )
      .tag('v0.1.0', { annotated: true, message: 'first release' })
      .commit('document the parser', (c) =>
        c.add('README.md', '# parser\n\nTurns a string into tokens.\n').author(GRACE),
      );
  },

  /** A pure `git mv`: git must report R100 with no content change at all. */
  'rename-simple': (b) => {
    b.commit('add the widget', (c) => c.add('src/widget.ts', PARSER_V1)).commit(
      'rename widget to gadget',
      (c) => c.rename('src/widget.ts', 'src/gadget.ts'),
    );
  },

  /** Rename plus a substantial edit, so the similarity index lands in the 50–99 band. */
  'rename-with-edit': (b) => {
    b.commit('add the http client', (c) =>
      c.add('src/http/client.ts', HTTP_CLIENT_V1),
    ).commit('move the client under net/ and add retries', (c) =>
      c
        .rename('src/http/client.ts', 'src/net/client.ts')
        .edit('src/net/client.ts', HTTP_CLIENT_V2),
    );
  },

  /** a → b → c across separate commits: the case that breaks naive path keying. */
  'rename-chain': (b) => {
    b.commit('add a.ts', (c) => c.add('src/a.ts', PARSER_V1))
      .commit('rename a.ts to b.ts', (c) => c.rename('src/a.ts', 'src/b.ts'))
      .commit('rename b.ts to c.ts', (c) => c.rename('src/b.ts', 'src/c.ts'));
  },

  /**
   * Renamed on the branch, edited on the trunk, then merged — so the merge commit is
   * where the two facts have to be reconciled, which is the hard part of rename
   * resolution (Part 8 §8.3).
   */
  'rename-across-merge': (b) => {
    b.commit('add the config loader', (c) => c.add('src/config.ts', HTTP_CLIENT_V1))
      .branch('refactor')
      .commit('move the config loader into lib/', (c) =>
        c.rename('src/config.ts', 'src/lib/config.ts'),
      )
      .checkout('main')
      .commit('support an env override', (c) =>
        c.edit(
          'src/config.ts',
          (previous) => `${previous}\nexport const override = process.env['CONFIG'];\n`,
        ),
      )
      .merge('refactor', { noFastForward: true });
  },

  /** a → b → a. The path is live at the start and the end, dead in the middle. */
  'rename-back': (b) => {
    b.commit('add the util module', (c) => c.add('src/util.ts', TOKENIZER))
      .commit('rename util to helpers', (c) => c.rename('src/util.ts', 'src/helpers.ts'))
      .commit('rename helpers back to util', (c) =>
        c.rename('src/helpers.ts', 'src/util.ts'),
      );
  },

  /**
   * A delete and a near-identical add in *different* commits.
   *
   * Deliberately not the same commit: git pairs those itself with `--find-renames`, so
   * they would test nothing. Split across commits, only the delete+add similarity
   * heuristic (M2) can join them — which is exactly what this fixture is for.
   */
  'rename-delete-add-similar': (b) => {
    b.commit('add the tokenizer', (c) => c.add('src/tokenizer.ts', TOKENIZER))
      .commit('add a package manifest', (c) =>
        c.add('package.json', '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n'),
      )
      .commit('drop the tokenizer', (c) => c.delete('src/tokenizer.ts'))
      .commit('add the lexer', (c) => c.add('src/lexer.ts', LEXER));
  },

  /**
   * A copy whose source is modified in the same commit, which is what `git diff -C`
   * needs to report `C` without `--find-copies-harder`.
   */
  'copy-detected': (b) => {
    b.commit('add the users handler', (c) =>
      c.add('src/handlers/users.ts', USERS_HANDLER),
    ).commit('copy the users handler to teams', (c) =>
      c
        .copy('src/handlers/users.ts', 'src/handlers/teams.ts')
        .edit(
          'src/handlers/users.ts',
          (previous) => `${previous}\nexport const usersVersion = 2;\n`,
        ),
    );
  },

  /**
   * The same path deleted and then re-added later with different content — two
   * distinct file identities at one path, which is the failure mode that makes
   * ownership and blame silently wrong if it is missed.
   */
  resurrection: (b) => {
    b.commit('add the legacy shim', (c) => c.add('src/legacy.ts', TOKENIZER))
      .commit('add the modern api', (c) => c.add('src/modern.ts', PARSER_V1))
      .commit('remove the legacy shim', (c) => c.delete('src/legacy.ts'))
      .commit('extend the modern api', (c) => c.edit('src/modern.ts', PARSER_V2))
      .commit('bring back the legacy shim', (c) =>
        c.add(
          'src/legacy.ts',
          `// Reintroduced for the 0.x compatibility window; unrelated to the original.\nexport const legacy = true;\n`,
        ),
      );
  },

  /** No merge commit exists afterwards: HEAD simply moves, with one parent. */
  'merge-fast-forward': (b) => {
    b.commit('add the entrypoint', (c) => c.add('src/main.ts', PARSER_V1))
      .branch('feature')
      .commit('add the feature module', (c) => c.add('src/feature.ts', TOKENIZER))
      .commit('wire the feature in', (c) =>
        c.edit('src/main.ts', (previous) => `import './feature.js';\n${previous}`),
      )
      .checkout('main')
      .merge('feature');
  },

  /** Divergent both sides plus `--no-ff`: a real two-parent merge commit. */
  'merge-true': (b) => {
    b.commit('add the entrypoint', (c) => c.add('src/main.ts', PARSER_V1))
      .branch('feature')
      .commit('add the feature module', (c) => c.add('src/feature.ts', TOKENIZER))
      .checkout('main')
      .commit('add the docs', (c) => c.add('docs/readme.md', '# docs\n'))
      .merge('feature', { noFastForward: true })
      .commit('release prep', (c) => c.edit('docs/readme.md', '# docs\n\nSee src/.\n'))
      .tag('v1.0.0', { annotated: true, message: 'one point oh' });
  },

  /**
   * rename/rename(1to2): one path renamed to two different destinations on two
   * branches. Resolved by the builder's fixed rule (ours where present, otherwise
   * theirs), which leaves *both* destinations live — a history shape that any
   * "one path in, one path out" rename model gets wrong.
   */
  'merge-conflicting-rename': (b) => {
    b.commit('add the app entrypoint', (c) => c.add('src/app.ts', HTTP_CLIENT_V1))
      .branch('long-names')
      .commit('rename app to application', (c) =>
        c.rename('src/app.ts', 'src/application.ts'),
      )
      .checkout('main')
      .commit('rename app to main-app', (c) => c.rename('src/app.ts', 'src/main-app.ts'))
      .merge('long-names', { noFastForward: true, subject: 'Merge the renames' });
  },

  /** Tier 1: git's own wording, including `This reverts commit <oid>.` */
  'revert-explicit': (b) => {
    b.commit('add the feature flag', (c) =>
      c.add('src/flags.ts', 'export const experimentalParser = true;\n'),
    )
      .commit('add the changelog', (c) => c.add('CHANGELOG.md', '# changelog\n'))
      .commit('Revert "add the feature flag"', (c) => c.revert('add the feature flag'));
  },

  /**
   * Tier 2: the diff is an exact inverse and the message never says so.
   *
   * Built with `edit()` back to the previous bytes rather than with `revert()`, because
   * `revert()` appends git's `This reverts commit …` notice, which would make this
   * case detectable by message alone and therefore not this case.
   */
  'revert-diff-inverse': (b) => {
    b.commit('add retry logic', (c) => c.add('src/retry.ts', RETRY_V1))
      .commit('raise the retry budget to 25', (c) => c.edit('src/retry.ts', RETRY_V2))
      .commit('settle on the original budget', (c) =>
        c
          .edit('src/retry.ts', RETRY_V1)
          .body('Twenty-five attempts hammered the upstream service.'),
      );
  },

  /** Tier 3: the message claims a revert; the diff is unrelated to the named commit. */
  'revert-message-only': (b) => {
    b.commit('add the cache', (c) => c.add('src/cache.ts', TOKENIZER))
      .commit('add the operations notes', (c) => c.add('docs/notes.md', '# notes\n'))
      .commit('Revert "add the cache"', (c) =>
        c
          .edit(
            'docs/notes.md',
            '# notes\n\nThe cache is disabled in production for now.\n',
          )
          .body(
            'Backing the cache out operationally; the code removal follows separately.',
          ),
      );
  },

  /** Revert, then re-land the identical content — the pair a naive detector loses. */
  'revert-with-reland': (b) => {
    b.commit('add the rate limiter', (c) => c.add('src/limit.ts', RETRY_V1).author(ADA))
      .commit('Revert "add the rate limiter"', (c) =>
        c.revert('add the rate limiter').author(GRACE),
      )
      .commit('Reland "add the rate limiter"', (c) =>
        c
          .add('src/limit.ts', RETRY_V1)
          .author(ADA)
          .body('Reverted while the upstream bug was open; that is now fixed.'),
      );
  },

  /**
   * Three spellings of one person plus a second person, and a `.mailmap` that maps the
   * two aliases home. `git check-mailmap` is the oracle in the test.
   */
  'mailmap-identities': (b) => {
    b.commit('start the service', (c) =>
      c.add('src/server.ts', HTTP_CLIENT_V1).author(ADA, 'ada@example.com'),
    )
      .commit('add health checks', (c) =>
        c
          .add('src/health.ts', 'export const healthy = () => true;\n')
          .author('A. Lovelace', 'ada@personal.example'),
      )
      .commit('log every request', (c) =>
        c
          .edit(
            'src/server.ts',
            (previous) => `${previous}\nexport const logRequests = true;\n`,
          )
          .author('ada', 'ada@corp.example'),
      )
      .commit('tidy the imports', (c) =>
        c
          .add('src/index.ts', "export * from './server.js';\n")
          .author(GRACE, 'grace@example.com'),
      )
      .mailmap([
        {
          canonical: { name: ADA, email: 'ada@example.com' },
          alias: { name: 'A. Lovelace', email: 'ada@personal.example' },
        },
        {
          canonical: { name: ADA, email: 'ada@example.com' },
          alias: { name: 'ada', email: 'ada@corp.example' },
        },
      ]);
  },

  /** `Co-authored-by` trailers, single and multiple, as GitHub's UI writes them. */
  'coauthored-by': (b) => {
    b.commit('add the scheduler', (c) =>
      c
        .add('src/scheduler.ts', TOKENIZER)
        .author(ADA, 'ada@example.com')
        .trailer('Co-authored-by', `${GRACE} <grace@example.com>`),
    ).commit('add the scheduler tests', (c) =>
      c
        .add('test/scheduler.test.ts', "import '../src/scheduler.js';\n")
        .author(ADA, 'ada@example.com')
        .trailer('Co-authored-by', `${GRACE} <grace@example.com>`)
        .trailer('Co-authored-by', 'Katherine Johnson <katherine@example.com>'),
    );
  },

  /** The three bots that dominate real histories, with their real address shapes. */
  'bot-authors': (b) => {
    b.commit('add the lockfile', (c) =>
      c.add('pnpm-lock.yaml', LOCKFILE).author(ADA, 'ada@example.com'),
    )
      .commit('Bump lodash from 4.17.20 to 4.17.21', (c) =>
        c
          .edit('pnpm-lock.yaml', LOCKFILE.replaceAll('4.17.20', '4.17.21'))
          .author('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'),
      )
      .commit('chore(deps): update dependency vitest to v3', (c) =>
        c
          .edit(
            'pnpm-lock.yaml',
            (previous) =>
              `${previous}      vitest:\n        specifier: ^3.0.0\n        version: 3.0.0\n`,
          )
          .author('renovate[bot]', '29139614+renovate[bot]@users.noreply.github.com'),
      )
      .commit('Update generated docs', (c) =>
        c
          .add('docs/api.generated.md', '<!-- generated, do not edit -->\n')
          .author(
            'github-actions[bot]',
            '41898282+github-actions[bot]@users.noreply.github.com',
          ),
      );
  },

  /**
   * A whole-file reindent, listed in `.git-blame-ignore-revs`, with a real fix on top —
   * so blame is wrong in an obvious way unless the ignore file is honoured.
   */
  'blame-ignore-revs': (b) => {
    b.commit('add the report builder', (c) =>
      c.add('src/report.ts', REPORT_TWO_SPACE).author(ADA),
    )
      .commit('reindent everything with four spaces', (c) =>
        c
          .edit('src/report.ts', REPORT_FOUR_SPACE)
          .author(GRACE)
          .body('Mechanical: prettier with a wider indent. No behaviour change.'),
      )
      .commit('fix the totals calculation', (c) =>
        c
          .edit('src/report.ts', (previous) =>
            previous.replace('sum + row.amount', 'sum + Math.max(row.amount, 0)'),
          )
          .author(ADA),
      )
      .blameIgnore(['reindent everything with four spaces']);
  },

  /** An empty commit between two real ones: `--allow-empty`, zero files changed. */
  'empty-commit': (b) => {
    b.commit('add the changelog', (c) => c.add('CHANGELOG.md', '# changelog\n'))
      .commit('trigger a rebuild')
      .commit('note the release', (c) =>
        c.edit('CHANGELOG.md', '# changelog\n\n## 0.1.0\n\nFirst release.\n'),
      );
  },

  /** A NUL-bearing blob, added then changed: `--numstat` must report `-\t-`. */
  'binary-file': (b) => {
    b.commit('add the logo', (c) => c.add('assets/logo.png', pseudoBinary(7, 512)))
      .commit('add the readme', (c) =>
        c.add('README.md', '# fixture\n\n![logo](assets/logo.png)\n'),
      )
      .commit('redraw the logo', (c) => c.edit('assets/logo.png', pseudoBinary(11, 640)));
  },

  /**
   * CRLF bytes committed verbatim (`core.autocrlf=false`), then normalised to LF in a
   * commit that touches every line and changes no behaviour — the classic
   * false-positive for churn and significance scoring.
   */
  'crlf-line-endings': (b) => {
    b.commit('add a windows-authored build script', (c) =>
      c.add('scripts/build.bat', CRLF_SCRIPT),
    )
      .commit('add a unix build script', (c) =>
        c
          .add('scripts/build.sh', '#!/bin/sh\nset -eu\nnpm run build\n')
          // The one `chmod()` in the matrix: mode 100755 in a tree is a distinct entry
          // from 100644, and a shell script is where it naturally belongs.
          .chmod('scripts/build.sh', 0o755),
      )
      .commit('normalise line endings to LF', (c) =>
        c.edit('scripts/build.bat', LF_SCRIPT),
      );
  },

  /** Accented, CJK, and emoji paths, in NFC. The cross-platform tree-OID canary. */
  'unicode-paths': (b) => {
    b.commit('add localised copy', (c) =>
      c
        .add(UNICODE_PATHS.accented, "export const greeting = 'Bonjour';\n")
        .add(UNICODE_PATHS.japanese, "export const greeting = 'こんにちは';\n"),
    )
      .commit('document the launch', (c) =>
        c.add(UNICODE_PATHS.emoji, '# 🚀 Launch\n\nShipping on Tuesday.\n'),
      )
      .commit('correct the accent', (c) =>
        c.edit(UNICODE_PATHS.accented, "export const greeting = 'Bonjour, ça va';\n"),
      );
  },
};
