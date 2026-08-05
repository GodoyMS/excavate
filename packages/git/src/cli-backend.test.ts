/**
 * `CliGitBackend` against a real repository, built here with raw `git` commands.
 *
 * The synthetic tests in `git.test.ts` prove the parser handles the framing we believe
 * git produces; these prove that belief is *true*, which no amount of synthetic input
 * can. They deliberately do not use `@excavate/git-fixtures`: the fixture DSL is itself
 * built on this package, so depending on it here would make the two able to agree with
 * each other while both being wrong.
 *
 * Every identity and date is pinned through the environment, so the assertions are
 * exact rather than approximate — including the two commits authored at non-UTC
 * offsets, which is the only way to catch an offset silently normalised to the machine's
 * own timezone.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isExcavateError, parseOid } from '@excavate/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CliGitBackend,
  DEFAULT_WALK_SPEC,
  FIELD_SEPARATOR,
  RECORD_SEPARATOR,
  discoverRepository,
  type RawCommit,
  type WalkSpec,
} from './index.js';

const AUTHOR = { name: 'Ada Lovelace', email: 'ada@example.test' };
const COMMITTER = { name: 'Grace Hopper', email: 'grace@example.test' };

/** Distinct, increasing, and two of them deliberately not UTC. */
const DATES = {
  root: '2020-01-01T09:00:00+0530',
  rename: '2020-02-01T10:00:00-0800',
  binary: '2020-03-01T11:00:00+0000',
  side: '2020-04-01T12:00:00+0000',
  main: '2020-05-01T13:00:00+0000',
  merge: '2020-06-01T14:00:00+0000',
  mode: '2020-07-01T15:00:00+0000',
} as const;

/** Ten lines, so a one-line edit across a rename still clears the 50% threshold. */
const ORIGINAL = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const EDITED = ORIGINAL.replace('line 5', 'line five');

let repoRoot = '';
let backend: CliGitBackend;
let commits: RawCommit[] = [];

/** Every directory the suite creates, so `afterAll` can remove all of them. */
const temporaryDirs: string[] = [];

/**
 * A fresh temporary directory, registered for cleanup.
 *
 * `realpath` because macOS temp directories are symlinks and `rev-parse
 * --show-toplevel` reports the resolved path, which the discovery assertions compare
 * against exactly.
 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporaryDirs.push(dir);
  return dir;
}

/**
 * A stand-in `git` on disk.
 *
 * The failures that matter most here — a walk that dies half way through, a HEAD that
 * cannot be read, output this parser does not understand — are the ones a healthy
 * repository will not produce on demand. Each script is written outside every worktree,
 * so a stand-in binary can never end up in a fixture commit.
 *
 * POSIX only: it relies on a `#!/usr/bin/env node` shebang being executable.
 */
function fakeGit(name: string, body: readonly string[]): string {
  const file = join(tempDir('excavate-fake-git-'), name);
  writeFileSync(
    file,
    ['#!/usr/bin/env node', 'const args = process.argv.slice(2);', ...body, ''].join(
      '\n',
    ),
    { mode: 0o755 },
  );
  return file;
}

/** Raw `git` in a given directory, with every identity and date pinned. */
function gitIn(cwd: string, args: readonly string[], date?: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: COMMITTER.name,
      GIT_COMMITTER_EMAIL: COMMITTER.email,
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    },
  });
}

function git(args: readonly string[], date?: string): string {
  return gitIn(repoRoot, args, date);
}

function commit(message: string, date: string): void {
  git(['add', '-A']);
  // Signing and hooks belong to the developer running the suite, not to the fixture.
  git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message], date);
}

function oidOf(rev: string): string {
  return git(['rev-parse', rev]).trim();
}

async function walk(overrides: Partial<WalkSpec> = {}): Promise<RawCommit[]> {
  const collected: RawCommit[] = [];
  for await (const found of backend.walk({ ...DEFAULT_WALK_SPEC, ...overrides })) {
    collected.push(found);
  }
  return collected;
}

/** The error code an operation failed with, as a value a test can compare. */
async function codeOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return isExcavateError(error) ? error.code : `not an ExcavateError: ${String(error)}`;
  }
  return 'no error thrown';
}

/** Ground truth for churn, straight from a second, independent git invocation. */
function numstatTotals(rev: string): { insertions: number; deletions: number } {
  const output = git(['show', '--numstat', '--format=', rev]);
  let insertions = 0;
  let deletions = 0;
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const [added = '', removed = ''] = line.split('\t');
    if (added === '-' || removed === '-') continue; // binary: no counts exist
    insertions += Number(added);
    deletions += Number(removed);
  }
  return { insertions, deletions };
}

const subject = (found: RawCommit): string => found.message.split('\n')[0] ?? '';

afterAll(() => {
  // Otherwise every run of this file leaves half a dozen repositories in the developer's
  // temp directory forever, which is how a suite ends up owning gigabytes nobody knows
  // about. `force` because a git object store is full of read-only files.
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  repoRoot = tempDir('excavate-git-');
  backend = new CliGitBackend({ repoRoot });

  git(['init', '-q', '-b', 'main']);

  await writeFile(join(repoRoot, 'a.txt'), ORIGINAL);
  await mkdir(join(repoRoot, 'sub'), { recursive: true });
  await writeFile(join(repoRoot, 'sub', 'b.txt'), 'one\ntwo\n');
  commit('root: two files', DATES.root);

  git(['mv', 'a.txt', 'renamed.txt']);
  await writeFile(join(repoRoot, 'renamed.txt'), EDITED);
  commit('rename a.txt with an edit', DATES.rename);

  await writeFile(join(repoRoot, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
  commit('add a binary blob', DATES.binary);
  git(['tag', '-a', 'v1.0', '-m', 'the first release'], DATES.binary);

  git(['checkout', '-q', '-b', 'side']);
  await writeFile(join(repoRoot, 's.txt'), 'side\n');
  commit('side: add s.txt', DATES.side);

  git(['checkout', '-q', 'main']);
  await writeFile(join(repoRoot, 'm.txt'), 'main\n');
  commit('main: add m.txt', DATES.main);

  git(
    ['-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', 'side', '-m', 'merge side'],
    DATES.merge,
  );
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  // Repositories do tag non-commits; `git.git` tags a GPG key this way.
  git(['tag', 'a-blob', git(['rev-parse', 'HEAD:m.txt']).trim()]);

  await chmod(join(repoRoot, 'sub', 'b.txt'), 0o755);
  commit('make sub/b.txt executable', DATES.mode);

  commits = await walk();
});

describe('walking a real repository', () => {
  it('yields every commit across all refs, exactly once', () => {
    expect(commits.map(subject).sort()).toEqual(
      [
        'root: two files',
        'rename a.txt with an edit',
        'add a binary blob',
        'side: add s.txt',
        'main: add m.txt',
        'merge side',
        'make sub/b.txt executable',
      ].sort(),
    );
  });

  /**
   * The ordering contract is topological — every parent before its child — and **not** a
   * specific sequence.
   *
   * This test previously pinned the exact list, which froze one of git's *tie-breaks* as if
   * it were a guarantee: `side: add s.txt` and `main: add m.txt` are siblings with no
   * ancestry between them, so nothing in the contract decides which comes first, and adding
   * `--topo-order` swapped them. The topological property is what the index actually depends
   * on (dense ids are assigned in this order and parent edges are written as it goes), so it
   * is what gets asserted.
   */
  it('yields every parent before its child', () => {
    const position = new Map(commits.map((commit, i) => [commit.oid, i]));
    for (const commit of commits) {
      for (const parent of commit.parents) {
        expect(position.get(parent)).toBeLessThan(position.get(commit.oid)!);
      }
    }
  });

  it('starts at the root commit and ends at HEAD', () => {
    expect(commits[0]?.parents).toEqual([]);
    expect(commits.at(-1)?.oid).toBe(oidOf('HEAD'));
  });

  it('reports the oids and tree git itself reports', () => {
    expect(commits[0]?.oid).toBe(oidOf('main~5^{commit}'));
    expect(commits[0]?.tree).toBe(oidOf('main~5^{tree}'));
    expect(commits.at(-1)?.oid).toBe(oidOf('HEAD'));
  });

  it('gives a root commit no parents and a merge both, first parent first', () => {
    const merge = commits.find((found) => subject(found) === 'merge side');
    expect(commits[0]?.parents).toEqual([]);
    expect(merge?.parents).toEqual([oidOf('HEAD~1^1'), oidOf('HEAD~1^2')]);
  });

  it('keeps author and committer separate, since a merge or rebase makes them differ', () => {
    expect(commits[0]?.author).toEqual(AUTHOR);
    expect(commits[0]?.committer).toEqual(COMMITTER);
  });

  it('recovers the original UTC offset a commit was authored at', () => {
    // The whole reason the format captures %ai alongside %at (Part 8 §8.2.1). A parser
    // that reconstructed this from the epoch would report the machine's own offset.
    expect(commits[0]?.authoredAt.offsetMinutes).toBe(330);
    expect(commits[1]?.authoredAt.offsetMinutes).toBe(-480);
    expect(commits[2]?.authoredAt.offsetMinutes).toBe(0);
  });

  it('reports the instant git reports, independently of the offset', () => {
    expect(commits[0]?.authoredAt.epochSeconds).toBe(
      Number(git(['show', '-s', '--format=%at', commits[0]?.oid ?? 'HEAD']).trim()),
    );
  });

  it('matches git’s own numstat for every non-merge commit', () => {
    for (const found of commits) {
      if (found.parents.length > 1) continue; // `git show` prints no diff for a merge
      const totals = numstatTotals(found.oid);
      const insertions = found.changes.reduce((sum, c) => sum + c.insertions, 0);
      const deletions = found.changes.reduce((sum, c) => sum + c.deletions, 0);
      expect({ subject: subject(found), insertions, deletions }).toEqual({
        subject: subject(found),
        ...totals,
      });
    }
  });

  it('reports each added file separately with its own counts', () => {
    expect(commits[0]?.changes).toEqual([
      {
        kind: 'add',
        oldPath: null,
        newPath: 'a.txt',
        similarity: null,
        insertions: 10,
        deletions: 0,
        isBinary: false,
      },
      {
        kind: 'add',
        oldPath: null,
        newPath: 'sub/b.txt',
        similarity: null,
        insertions: 2,
        deletions: 0,
        isBinary: false,
      },
    ]);
  });

  it('reports an edited rename as a rename, with the similarity git measured', () => {
    const change = commits[1]?.changes[0];
    expect(change).toMatchObject({
      kind: 'rename',
      oldPath: 'a.txt',
      newPath: 'renamed.txt',
      insertions: 1,
      deletions: 1,
    });
    expect(change?.similarity).toBeGreaterThanOrEqual(DEFAULT_WALK_SPEC.findRenames);
    expect(change?.similarity).toBeLessThan(100);
  });

  it('marks a binary file binary instead of reporting fabricated line counts', () => {
    expect(commits[2]?.changes[0]).toMatchObject({
      newPath: 'logo.bin',
      isBinary: true,
      insertions: 0,
      deletions: 0,
    });
  });

  it('reports a permission change as a mode change with no churn', () => {
    expect(commits.at(-1)?.changes).toEqual([
      {
        kind: 'mode',
        oldPath: 'sub/b.txt',
        newPath: 'sub/b.txt',
        similarity: null,
        insertions: 0,
        deletions: 0,
        isBinary: false,
      },
    ]);
  });

  it('gives a merge the first-parent diff rather than nothing or everything', () => {
    // Under --first-parent a merge shows what it brought in from the side branch.
    const merge = commits.find((found) => found.parents.length > 1);
    expect(merge?.changes.map((change) => change.newPath)).toEqual(['s.txt']);
  });

  it('walks only what is new when given a tip to start after', async () => {
    // Everything unreachable from the old tip, which includes the side branch: a
    // fast-forward index must pick up commits that arrived on other refs too, not just
    // the ones on the line HEAD happens to be on.
    const incremental = await walk({ since: parseOid(oidOf('HEAD~2')) });
    expect(incremental.map(subject)).toEqual([
      'side: add s.txt',
      'merge side',
      'make sub/b.txt executable',
    ]);
  });

  it('hands the first commit over before the traversal has finished', async () => {
    // Laziness, not a memory measurement: the indexer must be able to start writing
    // while git is still walking, and abandoning the iterator must kill the child rather
    // than leak it. Throughput and peak memory are M1's budget and belong in M1's tests.
    const iterator = backend.walk(DEFAULT_WALK_SPEC)[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) throw new Error('the walk yielded no commits at all');
    expect(subject(first.value)).toBe('root: two files');
    await iterator.return?.(undefined);
  });

  it('walks a repository with no commits as empty rather than as a failure', async () => {
    // `git log` refuses an unborn HEAD outright, but "no commits yet" is a state the
    // product has a name for (Part 8 §8.6.1, `uninitialized`), not an error to report.
    const fresh = tempDir('excavate-fresh-');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh });
    const empty = new CliGitBackend({ repoRoot: fresh });

    const collected: RawCommit[] = [];
    for await (const found of empty.walk({
      ...DEFAULT_WALK_SPEC,
      includeAllRefs: false,
    })) {
      collected.push(found);
    }
    expect(collected).toEqual([]);
    expect(await empty.refs()).toEqual([]);
  });
});

describe('a git that fails', () => {
  it('surfaces a bad revision range as GIT_FAILED and yields nothing', async () => {
    const collected: RawCommit[] = [];
    const code = await codeOf(async () => {
      for await (const found of backend.walk({
        ...DEFAULT_WALK_SPEC,
        since: parseOid('0'.repeat(40)),
      })) {
        collected.push(found);
      }
    });
    expect(code).toBe('GIT_FAILED');
    expect(collected).toEqual([]);
  });

  it('refuses to report a walk that died part way through as a complete one', async () => {
    // The failure that would otherwise be invisible: git writes some commits, then
    // dies. Every ownership number, era boundary, and Why answer downstream would be
    // computed over a partial history and reported with full confidence.
    const header = (oid: string, message: string): string =>
      RECORD_SEPARATOR +
      [
        oid,
        'a'.repeat(40),
        '',
        AUTHOR.name,
        AUTHOR.email,
        '1577836800',
        '2020-01-01 00:00:00 +0000',
        COMMITTER.name,
        COMMITTER.email,
        '1577836800',
        '2020-01-01 00:00:00 +0000',
        `${message}\n`,
      ].join(FIELD_SEPARATOR) +
      '\x00';

    const payload =
      header('1'.repeat(40), 'delivered') + header('2'.repeat(40), 'also delivered');
    const flakyGit = fakeGit('flaky-git.mjs', [
      `process.stdout.write(${JSON.stringify(payload)});`,
      "process.stderr.write('fatal: unable to read object deadbeef\\n');",
      'process.exit(128);',
    ]);

    const flaky = new CliGitBackend({ repoRoot, gitBinary: flakyGit });
    const collected: RawCommit[] = [];
    const code = await codeOf(async () => {
      for await (const found of flaky.walk(DEFAULT_WALK_SPEC)) collected.push(found);
    });

    expect(collected.map(subject)).toEqual(['delivered', 'also delivered']);
    expect(code).toBe('GIT_FAILED');
  });

  it('names a missing git binary as GIT_UNAVAILABLE, not as a repository problem', async () => {
    const missing = new CliGitBackend({
      repoRoot,
      gitBinary: join(repoRoot, 'no-such-git'),
    });
    expect(await codeOf(() => missing.head())).toBe('GIT_UNAVAILABLE');
  });

  it('fails a walk that could not start, rather than reporting an empty history', async () => {
    // A spawn failure produces exactly what a repository with no commits produces — an
    // empty stdout — so the walk's "an unborn HEAD is not an error" concession has to be
    // narrow enough not to absorb it.
    const missing = new CliGitBackend({
      repoRoot,
      gitBinary: join(repoRoot, 'no-such-git'),
    });
    const collected: RawCommit[] = [];
    const code = await codeOf(async () => {
      for await (const found of missing.walk(DEFAULT_WALK_SPEC)) collected.push(found);
    });
    expect(code).toBe('GIT_UNAVAILABLE');
    expect(collected).toEqual([]);
  });

  it('refuses to return a ref list whose HEAD it could not read', async () => {
    // An unborn HEAD is a state; an unreadable one is a failure. Swallowing both — the
    // obvious `catch {}` — makes "this repository has no commits" and "we could not find
    // out" the same answer, and the caller has no way to tell which it got.
    const branch = ['refs/heads/main', 'a'.repeat(40), 'commit', '', '', '*'].join(
      FIELD_SEPARATOR,
    );
    const brokenHead = fakeGit('broken-head.mjs', [
      `if (args[0] === 'for-each-ref') { process.stdout.write(${JSON.stringify(
        `${branch}\n`,
      )}); process.exit(0); }`,
      "process.stderr.write('fatal: unable to read object deadbeef\\n');",
      'process.exit(128);',
    ]);
    const broken = new CliGitBackend({ repoRoot, gitBinary: brokenHead });
    expect(await codeOf(() => broken.refs())).toBe('GIT_FAILED');
  });

  it('reports output that is not an object id as a git failure, not a type error', async () => {
    // An abbreviated or garbled oid means the binary is not the git we were written
    // against. Letting the branded-type constructor throw would surface it as an internal
    // TypeError, which tells the user nothing about which command produced it.
    const lyingGit = fakeGit('lying-git.mjs', [
      "process.stdout.write('deadbeef\\n');",
      'process.exit(0);',
    ]);
    const lying = new CliGitBackend({ repoRoot, gitBinary: lyingGit });
    expect(await codeOf(() => lying.head())).toBe('GIT_FAILED');
  });

  it('refuses to silently drop a tree record it cannot parse', async () => {
    // A skipped record is a file missing from "what exists at this commit" — a wrong
    // answer indistinguishable from a right one.
    const oddTree = fakeGit('odd-ls-tree.mjs', [
      "if (args[0] === 'ls-tree') { process.stdout.write('not a tree record at all\\0'); process.exit(0); }",
      'process.exit(0);',
    ]);
    const odd = new CliGitBackend({ repoRoot, gitBinary: oddTree });
    expect(await codeOf(() => odd.treeAt(parseOid('0'.repeat(40))))).toBe('GIT_FAILED');
  });

  it('carries git’s own words in the error, since the caller cannot re-run the command', async () => {
    const elsewhere = new CliGitBackend({ repoRoot: realpathSync(tmpdir()) });
    await expect(elsewhere.head()).rejects.toThrow(/not a git repository/i);
  });
});

describe('reading the rest of the repository', () => {
  it('resolves HEAD to the same commit git does', async () => {
    expect(await backend.head()).toBe(oidOf('HEAD'));
  });

  it('enumerates branches, remotes, tags, and HEAD, with the tag peeled to its commit', async () => {
    const refs = await backend.refs();
    const byName = new Map(refs.map((ref) => [ref.name, ref]));

    expect(byName.get('refs/heads/main')).toEqual({
      name: 'refs/heads/main',
      kind: 'branch',
      target: oidOf('main'),
      isHead: true,
    });
    expect(byName.get('refs/heads/side')?.isHead).toBe(false);
    expect(byName.get('refs/remotes/origin/main')?.kind).toBe('remote');
    expect(byName.get('HEAD')?.kind).toBe('head');
    // An annotated tag's own object is not the commit a release points at.
    expect(byName.get('refs/tags/v1.0')).toEqual({
      name: 'refs/tags/v1.0',
      kind: 'tag',
      target: oidOf('v1.0^{commit}'),
      isHead: false,
    });
  });

  it('drops a ref that points at something other than a commit', () => {
    // A "release" whose target is a blob would break every consumer downstream.
    return expect(backend.refs()).resolves.not.toContainEqual(
      expect.objectContaining({ name: 'refs/tags/a-blob' }),
    );
  });

  it('lists every file at a commit, with its numeric mode and size', async () => {
    const entries = await backend.treeAt(parseOid(oidOf('HEAD')));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));

    expect([...byPath.keys()].sort()).toEqual([
      'logo.bin',
      'm.txt',
      'renamed.txt',
      's.txt',
      'sub/b.txt',
    ]);
    expect(byPath.get('sub/b.txt')?.mode).toBe(0o100755);
    expect(byPath.get('m.txt')?.mode).toBe(0o100644);
    expect(byPath.get('m.txt')?.sizeBytes).toBe(5);
    expect(byPath.get('logo.bin')?.oid).toBe(oidOf('HEAD:logo.bin'));
  });

  it('describes a submodule entry, which has a mode and an oid but no size', async () => {
    // The one entry shape `ls-tree --long` reports without a size, and therefore the one
    // that would have to be rejected if `parseTreeRecord` were stricter than git is.
    const withGitlink = tempDir('excavate-gitlink-');
    gitIn(withGitlink, ['init', '-q', '-b', 'main']);
    await writeFile(join(withGitlink, 'f.txt'), 'hi\n');
    gitIn(withGitlink, ['add', 'f.txt']);
    gitIn(withGitlink, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-q',
      '-m',
      'one',
    ]);
    const pointee = gitIn(withGitlink, ['rev-parse', 'HEAD']).trim();
    gitIn(withGitlink, [
      'update-index',
      '--add',
      `--cacheinfo`,
      `160000,${pointee},vendor/mod`,
    ]);
    gitIn(withGitlink, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-q',
      '-m',
      'add a submodule',
    ]);

    const entries = await new CliGitBackend({ repoRoot: withGitlink }).treeAt(
      parseOid(gitIn(withGitlink, ['rev-parse', 'HEAD']).trim()),
    );
    const gitlink = entries.find((entry) => entry.path === 'vendor/mod');
    expect(gitlink).toEqual({
      path: 'vendor/mod',
      oid: pointee,
      mode: 0o160000,
      sizeBytes: null,
    });
  });

  it('reports the real git version and derives capabilities from it', async () => {
    const capabilities = await backend.capabilities();
    // The shape assertion is what makes the containment one mean anything: `toContain('')`
    // is true of every string, so a parser that reported nothing would pass without it.
    expect(capabilities.gitVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(git(['--version'])).toContain(
      capabilities.gitVersion.split('.').slice(0, 2).join('.'),
    );
    // Every version this project supports (README: git 2.30+) has both.
    expect(capabilities.supportsBlameIgnoreRevs).toBe(true);
    expect(capabilities.supportsSha256).toBe(true);
  });
});

describe('the environment git is run in', () => {
  it('ignores an ambient GIT_DIR, which would otherwise answer about another repository', async () => {
    // git exports GIT_DIR (and GIT_INDEX_FILE) to every hook, `rebase --exec`, and
    // `bisect run`, so anything launched from inside one inherits them — and GIT_DIR
    // outranks the working directory. Inheriting it means confidently reporting on a
    // repository the user never asked about, with nothing anywhere to indicate it.
    const expected = oidOf('HEAD');
    const other = tempDir('excavate-other-');
    gitIn(other, ['init', '-q', '-b', 'main']);
    gitIn(other, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '--no-verify',
      '-q',
      '-m',
      'a different repository',
    ]);

    const previous = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = join(other, '.git');
    try {
      expect(await backend.head()).toBe(expected);
      const walked = await walk();
      expect(walked.map(subject)).not.toContain('a different repository');
      expect(walked.at(-1)?.oid).toBe(expected);
      expect(await discoverRepository(repoRoot)).toEqual({
        root: repoRoot,
        gitDir: join(repoRoot, '.git'),
      });
    } finally {
      if (previous === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previous;
    }
  });
});

describe('discovering a repository', () => {
  it('reports the root and the git dir from anywhere inside the worktree', async () => {
    const fromRoot = await discoverRepository(repoRoot);
    expect(fromRoot).toEqual({ root: repoRoot, gitDir: join(repoRoot, '.git') });
    expect(await discoverRepository(join(repoRoot, 'sub'))).toEqual(fromRoot);
  });

  it('treats a bare repository’s git dir as its root, since it has no worktree', async () => {
    // A mirror is a legitimate corpus to index; `--show-toplevel` refuses outright in
    // one, and refusing to index it over that would be a worse answer than this.
    const bare = tempDir('excavate-bare-');
    execFileSync('git', ['init', '-q', '--bare'], { cwd: bare });
    expect(await discoverRepository(bare)).toEqual({ root: bare, gitDir: bare });
  });

  it('says NOT_A_REPOSITORY for a directory that is not in one', async () => {
    const empty = tempDir('excavate-empty-');
    expect(await codeOf(() => discoverRepository(empty))).toBe('NOT_A_REPOSITORY');
  });

  it('says NOT_A_REPOSITORY for a directory that does not exist at all', async () => {
    // Node reports a missing cwd as a spawn ENOENT, which is exactly what a missing
    // git binary looks like. Confusing the two sends the user to install git.
    const missing = join(realpathSync(tmpdir()), 'excavate-definitely-absent-dir');
    expect(await codeOf(() => discoverRepository(missing))).toBe('NOT_A_REPOSITORY');
  });

  it('says GIT_UNAVAILABLE when the directory exists but git cannot be run', async () => {
    // The other half of the same discrimination: same spawn ENOENT, opposite remedy —
    // "install git" rather than "run this inside a repository".
    expect(
      await codeOf(() => discoverRepository(repoRoot, join(repoRoot, 'no-such-git'))),
    ).toBe('GIT_UNAVAILABLE');
  });
});
