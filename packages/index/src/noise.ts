/**
 * Noise classification — what stops the report from being embarrassing.
 *
 * Part 8 §8.5.1 is blunt about why this exists: without the penalty flags these produce,
 * "the most significant commits in this repo" reliably returns the Prettier migration, the
 * licence-header sweep, and a lockfile refresh. Those commits are enormous by every naive
 * measure — files touched, lines changed — and they are exactly the commits nobody wants to
 * read about. **The penalties matter as much as the rewards.**
 *
 * M1 classifies from paths and line counts only. Anything needing the diff *body* —
 * whitespace-only detection and codemod-shaped hunks — needs the hunk table, which is M2;
 * `bulk-mechanical` is therefore approximated here by scale and uniformity, and the
 * approximation is named rather than hidden.
 */

import type { CommitFlag, FileFlag } from '@wise-excavate/core';
import type { RawCommit } from '@wise-excavate/git';

/* ── Path classification ───────────────────────────────────────────────────── */

/**
 * Vendored and generated trees, matched on path.
 *
 * Kept as an explicit list rather than something configurable because a wrong entry here
 * silently removes real code from the report — and the failure is invisible. Each pattern
 * below is a directory or filename convention that is *never* hand-edited source.
 */
const VENDORED_SEGMENTS: readonly string[] = [
  'node_modules',
  'vendor',
  'third_party',
  'thirdparty',
  'external',
  'Pods',
  'bower_components',
  '.yarn/releases',
  '.yarn/plugins',
];

const GENERATED_SEGMENTS: readonly string[] = [
  'dist',
  /* `generated`, not only `gen`: rust-analyzer's top two hotspots were
     `crates/syntax/src/ast/generated/nodes.rs` and `crates/ide-db/src/generated/lints.rs`, both
     of which are emitted by a codegen step in that repository's own build. A `generated/`
     directory is about as explicit as a codebase gets about what is inside it. */
  'generated',
  'build',
  'out',
  'target',
  'coverage',
  '__generated__',
  '__snapshots__',
  '.next',
  '.nuxt',
  'gen',
];

const GENERATED_FILE_PATTERNS: readonly RegExp[] = [
  /\.min\.(?:js|css)$/i,
  /\.(?:pb|generated|g)\.(?:go|ts|js|dart|py|cs)$/i,
  /_pb2?\.py$/i,
  /\.d\.ts\.map$/i,
  /\.(?:map)$/i,
  /* Source-mirrored HTML: `src/hir/lib.rs.html` is rustdoc's rendering of `lib.rs`, and the
     same shape covers pydoc, godoc, and jsdoc output. rust-analyzer once had it as its
     second-highest hotspot on a single enormous commit. Matching `<something>.<source-ext>.html`
     rather than `.html` outright is what keeps a hand-written `index.html` out of it — that is
     real source and someone maintains it. */
  /\.(?:rs|py|go|js|ts|rb|java|c|cc|cpp|h|hpp)\.html?$/i,
  /* `generated` as a whole token in the *filename*, which is how a project marks codegen output
     when it does not have a directory for it: `generated_lints.rs`, `lints.generated.ts`,
     `schema-generated.go`. Delimiters on both sides are required so `regenerate.py` — a script
     that *does* the generating and is hand-written — is not swept up with its own output. */
  /(?:^|[._-])generated(?:[._-]|$)/i,
];

/**
 * Lockfiles. Enormous, mechanical, and the single most common false top-hotspot.
 *
 * A lockfile *change* is real information — it is how you know a dependency moved — which
 * is why these are flagged rather than skipped. What must not happen is `pnpm-lock.yaml`
 * appearing as the most significant file in the repository because it has 40,000 lines of
 * churn.
 */
const LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'packages.lock.json',
  'flake.lock',
  'pubspec.lock',
  'mix.lock',
  'Podfile.lock',
  'gradle.lockfile',
]);

const TEST_SEGMENTS: readonly string[] = ['test', 'tests', '__tests__', 'spec', 'e2e'];
const TEST_FILE = /(?:[._-](?:test|spec)\.[a-z0-9]+$)|(?:^test_.*\.py$)|(?:_test\.go$)/i;

/** Extensions that are never text, so line counts for them are meaningless. */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'tiff',
  'avif',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'zst',
  '7z',
  'rar',
  'jar',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'webm',
  'wav',
  'flac',
  'ogg',
  'so',
  'dylib',
  'dll',
  'exe',
  'bin',
  'o',
  'a',
  'wasm',
  'class',
  'pyc',
  'db',
  'sqlite',
  'sqlite3',
  'lockb',
]);

const segments = (path: string): string[] => path.split('/');
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function extensionOf(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

export function isVendored(path: string): boolean {
  const parts = segments(path);
  return VENDORED_SEGMENTS.some((v) =>
    v.includes('/') ? path.includes(v) : parts.includes(v),
  );
}

export function isGenerated(path: string): boolean {
  const parts = segments(path);
  return (
    GENERATED_SEGMENTS.some((g) => parts.includes(g)) ||
    GENERATED_FILE_PATTERNS.some((re) => re.test(path))
  );
}

export function isTestPath(path: string): boolean {
  return segments(path).some((p) => TEST_SEGMENTS.includes(p)) || TEST_FILE.test(path);
}

export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(path));
}

/** Dependency manifests — a change to one is a decision, which is why significance rewards it. */
const MANIFESTS: ReadonlySet<string> = new Set([
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'go.mod',
  'Gemfile',
  'composer.json',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
]);

export function isManifest(path: string): boolean {
  return MANIFESTS.has(basename(path));
}

export function classifyPath(path: string): readonly FileFlag[] {
  const flags: FileFlag[] = [];
  // Order matters only for readability; the set is what is stored.
  if (isGenerated(path) || isLockfile(path)) flags.push('generated');
  if (isVendored(path)) flags.push('vendored');
  if (isTestPath(path)) flags.push('test');
  if (isBinaryPath(path)) flags.push('binary');
  return flags;
}

/* ── Commit classification ─────────────────────────────────────────────────── */

/**
 * Above this many changed files, a commit is mechanical rather than authored.
 *
 * Chosen to match the coupling analyser's own cutoff (`COUPLING_MAX_FILES_PER_COMMIT`),
 * because the two are the same judgement: past roughly thirty files in one commit, a human
 * did not consider each file individually.
 */
export const BULK_FILE_THRESHOLD = 30;

/**
 * A bulk commit whose per-file churn is this uniform is a codemod.
 *
 * A hand-written refactor touching forty files changes them by wildly differing amounts; a
 * `prettier --write` across the repository changes almost every file by a similar, small
 * amount. Uniformity is therefore the signal, and it is measurable from `--numstat` alone
 * without the diff body that M2's hunks would provide.
 */
export const CODEMOD_UNIFORMITY = 0.35;

/**
 * Commits that announce themselves as a mechanical pass.
 *
 * Uniformity alone is not enough, and ripgrep proved it: `style: rustfmt everything` touches 67
 * files, and because rustfmt reflows some files by two lines and others by two hundred its
 * coefficient of variation sits well above {@link CODEMOD_UNIFORMITY}. It scored into the top
 * eight most significant commits in the repository — precisely the outcome §8.5.1 exists to
 * prevent. Content-based detection needs hunks and is M2, but this commit is not hiding: it says
 * what it is in the subject line.
 *
 * Two tiers, because the risk of a false positive differs:
 *
 * - **Tool names** match anywhere in the subject. `rustfmt`, `gofmt`, `prettier`, `dos2unix` are
 *   not words that appear in a description of authored work.
 * - **Generic verbs** must lead the subject, after an optional conventional-commit prefix.
 *   "reformat the config loader" is a formatting commit; "fix crash when reformatting output" is
 *   a bug fix that happens to contain the word, and anchoring is what tells them apart.
 *
 * Deliberately excluded: `refactor`, `cleanup`, `tidy`, `simplify`, `rename`. Every one of them
 * describes work a person did by hand and thought about, and demoting those would cost the
 * report the commits it most wants to surface.
 */
const MECHANICAL_TOOL =
  /\b(?:rustfmt|gofmt|goimports|clang-format|dos2unix|unix2dos|autopep8|yapf|ktlint|swiftformat|prettier|black|isort|eslint --fix|codemod|jscodeshift|2to3)\b/i;

const MECHANICAL_VERB =
  /^(?:(?:style|chore|format|fmt|ci|build|refactor)(?:\([^)]*\))?!?:\s*)?(?:re-?format|re-?indent|reflow|apply\s+(?:formatting|the\s+formatter|code\s+style)|run\s+(?:the\s+)?(?:formatter|linter|fmt)|normali[sz]e\s+(?:whitespace|line\s+endings|indentation|eol)|strip\s+trailing\s+whitespace|fix\s+(?:up\s+)?(?:whitespace|indentation|line\s+endings|eol)|whitespace|convert\s+(?:tabs|crlf|line\s+endings)|bump\s+copyright|update\s+licen[cs]e\s+headers?)\b/i;

export function announcesMechanicalPass(subject: string): boolean {
  const trimmed = subject.trim();
  return MECHANICAL_TOOL.test(trimmed) || MECHANICAL_VERB.test(trimmed);
}

export interface CommitClassification {
  readonly flags: readonly CommitFlag[];
  /** Files that are not generated, vendored, or lockfiles — what significance actually scores. */
  readonly meaningfulFiles: number;
}

export function classifyCommit(
  commit: RawCommit,
  isMerge: boolean,
): CommitClassification {
  const flags = new Set<CommitFlag>();
  if (isMerge) flags.add('merge');
  if (commit.parents.length === 0) flags.add('root');

  const subject = firstLine(commit.message);
  if (/^revert[:\s"]/i.test(subject) || /^revert\s+"/i.test(subject)) flags.add('revert');
  if (/^re-?land\b/i.test(subject) || /^reapply\b/i.test(subject)) flags.add('reland');

  const changes = commit.changes;
  if (changes.length === 0) {
    flags.add('empty');
    return { flags: [...flags], meaningfulFiles: 0 };
  }

  let generated = 0;
  let vendored = 0;
  let lockfiles = 0;
  let meaningful = 0;
  const churnPerFile: number[] = [];

  for (const change of changes) {
    const path = change.newPath ?? change.oldPath ?? '';
    const isGen = isGenerated(path);
    const isLock = isLockfile(path);
    const isVend = isVendored(path);
    if (isLock) lockfiles += 1;
    if (isGen || isLock) generated += 1;
    if (isVend) vendored += 1;
    if (!isGen && !isLock && !isVend) meaningful += 1;
    if (!change.isBinary) churnPerFile.push(change.insertions + change.deletions);
  }

  /* "-only" flags are all-or-nothing on purpose. A commit that touches the lockfile *and*
     real source is a dependency bump with a code change — interesting, and it must not be
     penalised. Only a commit that is *entirely* mechanical gets the penalty. */
  if (lockfiles === changes.length) flags.add('lockfile-only');
  if (generated === changes.length) flags.add('generated-only');
  if (vendored === changes.length) flags.add('vendored-only');

  /* Only `bulk-mechanical` exists as a flag, not a bare "bulk". Scale alone is not noise:
     a genuine large refactor touches many files and is one of the most interesting commits
     in a repository. What earns the penalty is scale *plus* evidence of mechanism — either
     uniform per-file churn (the codemod shape) or a subject that names the tool that did it.
     The scale gate applies to both, so reformatting one file is never penalised: it would not
     have ranked anyway, and the flag would be claiming more than the evidence supports. */
  if (
    changes.length >= BULK_FILE_THRESHOLD &&
    (isUniform(churnPerFile) || announcesMechanicalPass(subject))
  ) {
    flags.add('bulk-mechanical');
  }

  /* `format-only` cannot be decided honestly without the diff body: a whitespace-only
     change and a one-character logic fix are indistinguishable in `--numstat`. M2's hunk
     table adds `HunkKind.WhitespaceOnly` and that is where this flag gets set. Guessing it
     from line counts would mislabel real fixes as formatting, which is the more damaging
     direction of error. */

  return { flags: [...flags], meaningfulFiles: meaningful };
}

/**
 * Coefficient of variation below the threshold means "every file changed by about the same
 * amount", which is the shape of a codemod and not of authored work.
 */
function isUniform(churn: readonly number[]): boolean {
  if (churn.length < BULK_FILE_THRESHOLD) return false;
  const mean = churn.reduce((a, b) => a + b, 0) / churn.length;
  if (mean === 0) return true;
  const variance =
    churn.reduce((sum, c) => sum + (c - mean) * (c - mean), 0) / churn.length;
  return Math.sqrt(variance) / mean < CODEMOD_UNIFORMITY;
}

export function firstLine(message: string): string {
  const end = message.indexOf('\n');
  return (end < 0 ? message : message.slice(0, end)).trim();
}
