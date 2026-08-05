/**
 * The one place in the codebase that spawns a process (boundary rule B1).
 *
 * Two shapes, because the walk and everything else have opposite requirements: the
 * walk must stream megabytes and can never be buffered, while `rev-parse`,
 * `for-each-ref`, and `ls-tree` produce kilobytes and are far simpler to consume as a
 * string. Both funnel their failures through the same mapping, so a missing `git`
 * binary is always `GIT_UNAVAILABLE` and a non-zero exit is always `GIT_FAILED` with
 * git's own stderr attached — an opaque failure here is undebuggable, since the caller
 * has no way to re-run the command.
 */

import { spawn } from 'node:child_process';

import { ExcavateError } from '@excavate/core';

export const DEFAULT_GIT_BINARY = 'git';

export interface GitCommand {
  readonly binary: string;
  readonly cwd: string;
  readonly args: readonly string[];
}

/**
 * Git's stderr is the only diagnostic a failed command leaves behind, but it is
 * unbounded (`fatal:` lines, hints, and a pathspec echo). Truncating keeps an
 * `ExcavateError` small enough to cross the daemon boundary in a JSON payload.
 */
const MAX_STDERR_CHARS = 4_000;

/**
 * Environment variables that tell git *which repository to operate on*, all of which
 * outrank the process's working directory.
 *
 * Every command here is aimed by `cwd` alone, so inheriting any of these would mean
 * silently answering questions about a different repository than the one the user
 * asked about — the worst class of bug this package can have, and an easy one to hit:
 * git sets `GIT_DIR` (and often `GIT_INDEX_FILE`) for every hook, `git rebase --exec`,
 * and `git bisect run`, so anything launched from inside one inherits them.
 *
 * `GIT_CEILING_DIRECTORIES` is deliberately *not* here. No hook sets it; it is a user's
 * own preference about how far discovery may walk up, and honouring it keeps our answer
 * to "which repository is this" identical to their `git`'s. At worst it makes us find no
 * repository, which is a visible outcome rather than a wrong one.
 */
const REPOSITORY_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const;

/**
 * Environment applied to every invocation.
 *
 * `GIT_PAGER=cat` because a user with `core.pager=less` configured would otherwise
 * hang the daemon the first time git decided the output was long; `LC_ALL=C` because
 * `discoverRepository` classifies failures by matching git's own stderr, which is
 * translated when the user's locale is not English; `GIT_TERMINAL_PROMPT=0` so nothing
 * we run can ever block waiting for credentials.
 *
 * Deliberately *not* included: `GIT_CONFIG_NOSYSTEM`. Excavate reports on the
 * repository as its owner sees it, and silently discarding their `diff.*` and
 * `mailmap.*` configuration would make our numbers disagree with their `git` for
 * reasons no error message could explain.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  for (const name of REPOSITORY_LOCATION_VARS) delete env[name];
  return env;
}

function describe(command: GitCommand): string {
  return `git ${command.args.join(' ')}`;
}

function unavailable(command: GitCommand, cause: Error): ExcavateError {
  return new ExcavateError(
    'GIT_UNAVAILABLE',
    `could not execute ${JSON.stringify(command.binary)}: ${cause.message}`,
    { cause, details: { binary: command.binary, cwd: command.cwd } },
  );
}

function failed(
  command: GitCommand,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): ExcavateError {
  const how = signal !== null ? `killed by ${signal}` : `exited with code ${exitCode}`;
  const trimmed = stderr.trim().slice(0, MAX_STDERR_CHARS);
  return new ExcavateError(
    'GIT_FAILED',
    `${describe(command)} ${how}${trimmed === '' ? '' : `: ${trimmed}`}`,
    { details: { args: [...command.args], exitCode, signal, stderr: trimmed } },
  );
}

/** A spawned `git` whose stdout is consumed incrementally. */
export interface GitStream {
  readonly stdout: AsyncIterable<Uint8Array>;
  /**
   * Resolves when git exited 0, rejects with `GIT_FAILED` otherwise.
   *
   * Awaiting this *after* draining stdout is what stops a truncated walk from being
   * reported as a complete one — the single most damaging failure mode in the
   * package, since every downstream answer would silently be computed over a partial
   * history.
   */
  completion(): Promise<void>;
  /** Abandon the process. Safe to call after it has already exited. */
  kill(): void;
}

export function spawnGit(command: GitCommand): GitStream {
  const child = spawn(command.binary, [...command.args], {
    cwd: command.cwd,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks: string[] = [];
  let stderrLength = 0;
  // Attached immediately and unconditionally: an unread stderr pipe fills its 64KB
  // buffer and then blocks git mid-walk, which presents as a hang rather than an error.
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderrLength >= MAX_STDERR_CHARS) return;
    stderrChunks.push(chunk);
    stderrLength += chunk.length;
  });

  let settled = false;
  const completion = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      settled = true;
      reject(unavailable(command, error));
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (exitCode === 0) resolve();
      else reject(failed(command, exitCode, signal, stderrChunks.join('')));
    });
  });
  // A consumer that stops iterating early kills the child, which rejects `completion`
  // with a signal. Nothing awaits it in that case, so this keeps an abandoned walk
  // from surfacing as an unhandled rejection. Consumers still see the rejection.
  completion.catch(() => {});

  const stdout = child.stdout;
  if (stdout === null) {
    child.kill();
    throw new ExcavateError('GIT_FAILED', `${describe(command)} produced no stdout pipe`);
  }

  return {
    stdout,
    completion: () => completion,
    kill: () => {
      if (!settled) child.kill();
    },
  };
}

/** Run a small, bounded command and return its stdout as UTF-8. */
export async function runGit(command: GitCommand): Promise<string> {
  const stream = spawnGit(command);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream.stdout) chunks.push(chunk);
  await stream.completion();
  return Buffer.concat(chunks).toString('utf8');
}

/** git's stderr, when the error carries it. Used to classify a failure by cause. */
export function stderrOf(error: unknown): string {
  if (!(error instanceof ExcavateError)) return '';
  const { stderr } = error.details;
  return typeof stderr === 'string' ? stderr : '';
}
