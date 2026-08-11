/**
 * Repository discovery — the first thing every entry point does, and therefore the
 * first place a user meets an error message.
 *
 * Three outcomes have to stay distinguishable, because the remedy differs completely:
 * there is no repository here (`NOT_A_REPOSITORY` — "run this inside a git
 * repository"), git cannot be run at all (`GIT_UNAVAILABLE` — "install git"), or git
 * ran and objected to something (`GIT_FAILED`, with its own words attached).
 */

import { existsSync } from 'node:fs';

import { ExcavateError } from '@wise-excavate/core';

import type { GitCommand } from './exec.js';
import { DEFAULT_GIT_BINARY, runGit, stderrOf } from './exec.js';

export interface DiscoveredRepository {
  readonly root: string;
  readonly gitDir: string;
}

/**
 * Resolve the repository root and confirm `git` is usable, or fail with a clear code.
 *
 * `gitBinary` mirrors `CliGitBackendOptions.gitBinary` so that a caller which resolves
 * git itself — a configured path, a bundled build — discovers with the same binary it
 * will later walk with. Omitted, it is resolved from `PATH`, which is what every caller
 * does today.
 */
export async function discoverRepository(
  cwd: string,
  gitBinary: string = DEFAULT_GIT_BINARY,
): Promise<DiscoveredRepository> {
  const command: GitCommand = {
    binary: gitBinary,
    cwd,
    args: ['rev-parse', '--show-toplevel', '--absolute-git-dir'],
  };

  let output: string;
  try {
    output = await runGit(command);
  } catch (error) {
    return await recover(command, error);
  }

  const lines = output.split('\n').filter((line) => line !== '');
  const [root, gitDir] = lines;
  if (root === undefined || gitDir === undefined) {
    throw new ExcavateError(
      'GIT_FAILED',
      `git rev-parse did not report a root and a git dir for ${JSON.stringify(cwd)}`,
      { details: { cwd, lineCount: lines.length } },
    );
  }
  return { root, gitDir };
}

/**
 * Turn a failed `rev-parse` into the right error — or, for a bare repository, into a
 * successful discovery. Every path but that one throws.
 */
async function recover(
  command: GitCommand,
  error: unknown,
): Promise<DiscoveredRepository> {
  const { cwd } = command;
  // Node reports a missing `cwd` as a spawn ENOENT, which is indistinguishable from a
  // missing git binary — so the directory is what tells the two apart. A path that
  // does not exist plainly contains no repository.
  if (error instanceof ExcavateError && error.code === 'GIT_UNAVAILABLE') {
    if (!existsSync(cwd)) {
      throw new ExcavateError(
        'NOT_A_REPOSITORY',
        `no such directory: ${JSON.stringify(cwd)}`,
        { cause: error, details: { cwd } },
      );
    }
    throw error;
  }

  const stderr = stderrOf(error);
  if (/not a git repository/i.test(stderr)) {
    throw new ExcavateError(
      'NOT_A_REPOSITORY',
      `no git repository at or above ${JSON.stringify(cwd)}`,
      { cause: error, details: { cwd } },
    );
  }

  // A bare repository — a mirror, or a `--bare` clone used as a read-only corpus — has
  // no worktree, so `--show-toplevel` refuses outright. The git dir is then the only
  // meaningful root, and everything the walk needs lives inside it. Blame and file
  // reads will still be limited, which is the caller's problem to surface, not a
  // reason to refuse to index.
  if (/must be run in a work tree/i.test(stderr)) {
    try {
      const gitDir = (
        await runGit({ ...command, args: ['rev-parse', '--absolute-git-dir'] })
      ).trim();
      if (gitDir !== '') return { root: gitDir, gitDir };
    } catch {
      /* fall through to the original error, which is the more informative one */
    }
  }

  throw error;
}
