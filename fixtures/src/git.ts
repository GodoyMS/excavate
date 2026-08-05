/**
 * The deterministic `git` invocation layer.
 *
 * Everything in this file exists for one reason: a commit OID is a hash of (tree,
 * parents, author name/email/date, committer name/email/date, message), so a fixture
 * is only reproducible if *every* one of those inputs is pinned — and so is every
 * piece of ambient configuration that could change the tree. A contributor with
 * `core.autocrlf=true`, `commit.gpgsign=true`, a `~/.gitattributes` that marks `*.ts`
 * as `text`, or a global `core.hooksPath` must get byte-identical results to CI.
 *
 * Two classes of leak have to be closed, and they need different mechanisms:
 * **config** (closed by {@link isolatedEnv} plus {@link REPO_CONFIG}) and **the
 * committer/author identity and clock** (closed by {@link identityEnv}). The second
 * is the one people forget: pinning only `GIT_AUTHOR_DATE` leaves the committer date
 * at "now", and the OID then changes on every run.
 */

import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { join } from 'node:path';

/** A fully-specified child environment. Never a partial overlay of `process.env`. */
export type GitEnv = Record<string, string>;

export interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitOptions {
  readonly cwd: string;
  readonly env: GitEnv;
  /**
   * Return a non-zero result instead of throwing. Used for the operations whose
   * failure is information — `git merge` reporting a conflict, chiefly.
   */
  readonly allowFailure?: boolean;
}

/**
 * Raised with the argv *and both output streams*, because a bare exit code is useless.
 *
 * Both streams, not just stderr: git splits its diagnostics across the two and the split
 * is not the one you would guess. `fatal: …` goes to stderr, but `git commit --quiet`
 * with nothing staged prints `nothing added to commit` to **stdout** and leaves stderr
 * empty — which is precisely the failure a fixture script hits when an `edit()` writes
 * the bytes that were already there. Reporting only stderr made that error read
 * "failed with status 1" and nothing else.
 */
export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(args: readonly string[], status: number, stdout: string, stderr: string) {
    const detail = [stderr.trim(), stdout.trim()]
      .filter((part) => part !== '')
      .join('\n');
    super(
      `git ${args.join(' ')} failed with status ${status}` +
        (detail === '' ? ' and printed nothing to either stream' : `\n${detail}`),
    );
    this.name = 'GitCommandError';
    this.args = args;
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Run `git`, synchronously.
 *
 * Synchronous on purpose: fixture construction is strictly sequential (commit *n+1*
 * needs commit *n*'s tree), so async would buy no concurrency, and a synchronous call
 * keeps stack traces attached to the DSL call that caused the failure.
 *
 * `spawnSync` rather than `execFileSync` for two reasons. It returns stderr *on success*
 * as well as on failure, so {@link GitResult} can be honest; and it reports a spawn
 * failure as `result.error` instead of an exception whose `status` is `null` — which
 * `execFileSync` made indistinguishable from "git exited 1", so a machine with no `git`
 * installed used to report "failed with status 1" rather than "git is not on PATH".
 *
 * Argument arrays rather than a shell string, because fixture content and paths
 * deliberately contain quotes, newlines, spaces, and unicode.
 */
export function git(args: readonly string[], options: GitOptions): GitResult {
  const result = spawnSync('git', [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error !== undefined) {
    // ENOENT (no git on PATH) and ENOBUFS (output over `maxBuffer`) both land here, and
    // both are configuration problems rather than fixture-script problems. Never
    // reported as an exit status, because they are not one.
    throw new Error(
      `could not run 'git ${args.join(' ')}' in ${options.cwd}: ${result.error.message}`,
      { cause: result.error },
    );
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status === null) {
    throw new Error(
      `git ${args.join(' ')} was killed by signal ${String(result.signal)}` +
        (stderr.trim() === '' ? '' : `\n${stderr.trim()}`),
    );
  }

  const outcome = { status: result.status, stdout, stderr };
  if (result.status === 0 || options.allowFailure === true) return outcome;
  throw new GitCommandError(args, result.status, stdout, stderr);
}

/** `git`, trimmed — for the many one-line queries (`rev-parse`, `ls-files`). */
export function gitLine(args: readonly string[], options: GitOptions): string {
  return git(args, options).stdout.trim();
}

/**
 * Git's own date format for the environment variables: an absolute instant plus the
 * UTC offset to record alongside it. `+0000` throughout unless a fixture asks for a
 * specific offset via `at()`, so that no test outcome depends on the machine's `TZ`.
 */
export function gitDate(epochSeconds: number, offset = '+0000'): string {
  return `@${String(epochSeconds)} ${offset}`;
}

/**
 * The environment that isolates a fixture from the developer running it.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` pointed at the null device is stronger
 * than unsetting `HOME`: git then *reads* an empty file rather than searching, so
 * neither `~/.gitconfig` nor `$XDG_CONFIG_HOME/git/config` is consulted at all.
 * `GIT_CONFIG_NOSYSTEM` is redundant with the above on modern git and kept because it
 * covers older versions that ignore `GIT_CONFIG_SYSTEM`.
 *
 * `GIT_ATTR_NOSYSTEM` is the non-obvious one: a system `gitattributes` marking a
 * pattern as `text` would apply end-of-line conversion during `git add`, which changes
 * the *blob*, which changes the tree, which changes the OID. Config isolation alone
 * does not close that path.
 *
 * `GIT_CEILING_DIRECTORIES` is a blast radius limiter rather than a determinism
 * measure: if `git init` ever failed, subsequent commands would otherwise walk up and
 * operate on whatever repository encloses the temp directory.
 */
export function isolatedEnv(homePath: string, ceiling: string): GitEnv {
  const env: GitEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: homePath,
    XDG_CONFIG_HOME: join(homePath, '.config'),
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    TZ: 'UTC',
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: ceiling,
    // Nothing interactive may ever open: an editor prompt in CI is a hung job, and a
    // credential prompt means something is reaching the network, which it must not.
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };

  // A fully-specified environment is the right default, but on Windows a process that
  // inherits no `SystemRoot` cannot load the DLLs it needs and `git.exe` fails before it
  // parses its arguments — so an empty environment there is not isolation, it is a
  // broken spawn. Passed through only when present, so this is inert on POSIX and
  // untestable-but-harmless rather than untestable-and-load-bearing. Windows remains
  // unverified overall (see README); none of these three can affect an OID.
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'ComSpec', 'PATHEXT']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The four variables that pin a commit's identity fields. All four, every time. */
export function identityEnv(
  author: { readonly name: string; readonly email: string },
  committer: { readonly name: string; readonly email: string },
  date: string,
): GitEnv {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_COMMITTER_DATE: date,
  };
}

/**
 * Repository-local config, applied immediately after `init`.
 *
 * Local config wins over global, so this is a second, independent line of defence
 * behind {@link isolatedEnv} — if the environment approach were ever bypassed (a
 * developer running `git` in a kept fixture by hand, say), the repository still
 * behaves the same way.
 *
 * `core.precomposeunicode=true` is the subtle one, and it is a real cross-platform
 * hazard rather than a hypothetical. macOS filesystems have historically normalised
 * filenames to NFD ("é" as `e` + U+0301), while Linux stores the bytes given to it.
 * Without this setting the `unicode-paths` fixture records NFD path bytes on macOS and
 * NFC on Linux, producing a *different tree OID for the same DSL script* — which would
 * silently destroy the determinism guarantee on exactly the fixture written to test
 * unicode handling. With it, git precomposes to NFC when reading the worktree, so both
 * platforms agree. The setting is inert on Linux, so it is applied unconditionally
 * rather than behind a `process.platform` check that would then be untested there.
 *
 * `core.fileMode=true` is pinned for the same class of reason: on a filesystem that
 * does not report the execute bit, `chmod()` fixtures would produce `100644` instead
 * of `100755`. Fixtures set the mode through `update-index` too, so the tree is right
 * either way, but a divergence here would show up as a confusing diff, not an error.
 */
export const REPO_CONFIG: readonly (readonly [string, string])[] = [
  ['user.name', 'Fixture Author'],
  ['user.email', 'author@fixture.invalid'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['core.autocrlf', 'false'],
  ['core.safecrlf', 'false'],
  ['core.precomposeunicode', 'true'],
  ['core.fileMode', 'true'],
  ['core.quotepath', 'false'],
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  // Reflog entries embed wall-clock time, so leaving them enabled would make `.git`
  // non-reproducible byte-for-byte even though every OID matched. Nothing in the DSL
  // reads a reflog, so the cheapest fix is to not write one.
  ['core.logAllRefUpdates', 'false'],
  ['gc.auto', '0'],
  ['gc.autoDetach', 'false'],
  ['maintenance.auto', 'false'],
  ['advice.detachedHead', 'false'],
  ['init.defaultBranch', 'main'],
  ['merge.conflictStyle', 'merge'],
  ['diff.renames', 'true'],
  ['log.showSignature', 'false'],
];
