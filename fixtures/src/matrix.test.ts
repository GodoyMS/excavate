import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FixtureCase, FixtureRepo } from './index.js';
import { FIXTURE_CASES, fixture } from './index.js';

/**
 * Every case is built once and shared, because building is the expensive part (one
 * `git` process per operation) and the assertions are all reads. The fixtures are
 * immutable once built, so sharing them cannot couple one test to another.
 */
const repos = new Map<FixtureCase, FixtureRepo>();

async function removeAll(): Promise<void> {
  await Promise.all([...repos.values()].map((built) => built.cleanup()));
  repos.clear();
}

beforeAll(async () => {
  // Built one at a time rather than through `Promise.all` so that a failure names the
  // case that failed, and wrapped in a `try` so the 24 temporary directories are removed
  // even then — relying on `afterAll` running after a failed `beforeAll` would make a
  // build error leak a repository per case for the life of the machine.
  try {
    for (const name of FIXTURE_CASES) {
      repos.set(name, await fixture(name));
    }
  } catch (cause) {
    await removeAll();
    throw cause;
  }
}, 300_000);

afterAll(removeAll);

function at(name: FixtureCase): FixtureRepo {
  const found = repos.get(name);
  if (found === undefined) throw new Error(`fixture ${name} was not built`);
  return found;
}

/** Real `git` as the oracle. Throws on a non-zero exit, with both streams quoted. */
function git(name: FixtureCase, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: at(name).path,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${name}: git ${args.join(' ')} exited ${String(result.status)}\n` +
        `${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout.trimEnd();
}

/**
 * `git fsck`, as the exit status plus *both* streams.
 *
 * The stream discipline is the whole reason this is separate: `broken link` and
 * `missing tree` go to stdout, `error in commit …` and `notice: …` go to stderr, and some
 * `--strict` findings are reported while git still exits 0. An assertion that read only
 * stdout — or only the exit code — would let a class of corruption through unnoticed.
 */
function fsck(name: FixtureCase): string {
  const args = ['fsck', '--strict', '--no-progress', '--no-dangling'];
  const result = spawnSync('git', args, {
    cwd: at(name).path,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return `exit ${String(result.status)}\n${result.stdout}${result.stderr}`;
}

function subjects(name: FixtureCase): string[] {
  return git(name, ['log', '--reverse', '--format=%s']).split('\n');
}

/** `git diff --name-status` for one commit against its first parent. */
function statusOf(name: FixtureCase, rev: string, extra: readonly string[] = []): string {
  return git(name, ['diff', '--name-status', '-M', ...extra, `${rev}~1`, rev]);
}

describe('the corpus as a whole', () => {
  it.each([...FIXTURE_CASES])('%s is a repository git considers intact', (name) => {
    expect(fsck(name)).toBe('exit 0\n');
    expect(Number(git(name, ['rev-list', '--count', 'HEAD']))).toBeGreaterThan(0);
    // Nothing left staged or unmerged: a half-resolved merge would make every later
    // milestone's test read a worktree that does not match any commit.
    expect(git(name, ['status', '--porcelain'])).toBe('');
    expect(git(name, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('gives every commit in every case a unique, resolvable subject', () => {
    for (const name of FIXTURE_CASES) {
      const built = at(name);
      const logged = git(name, ['log', '--all', '--format=%s']);
      const counted = new Set(logged.split('\n'));
      expect(counted.size, `${name} has a duplicate subject`).toBe(
        logged.split('\n').length,
      );
      for (const [subject, oid] of built.oids) {
        expect(git(name, ['rev-parse', oid])).toBe(built.oid(subject));
      }
    }
  });
});

describe('rename cases', () => {
  it('rename-simple is reported by git as a 100% rename', () => {
    expect(statusOf('rename-simple', 'HEAD')).toBe('R100\tsrc/widget.ts\tsrc/gadget.ts');
  });

  it('rename-with-edit lands in the partial-similarity band, not at 100%', () => {
    const status = statusOf('rename-with-edit', 'HEAD');
    const score = /^R(\d+)\t/.exec(status)?.[1];
    expect(status).toMatch(/^R\d+\tsrc\/http\/client\.ts\tsrc\/net\/client\.ts$/);
    expect(Number(score)).toBeGreaterThanOrEqual(50);
    expect(Number(score)).toBeLessThan(100);
  });

  it('rename-chain renames a to b to c, and git follows the whole chain', () => {
    expect(statusOf('rename-chain', 'HEAD~1')).toBe('R100\tsrc/a.ts\tsrc/b.ts');
    expect(statusOf('rename-chain', 'HEAD')).toBe('R100\tsrc/b.ts\tsrc/c.ts');
    // Across the range the endpoints connect, which is what a file-identity model has
    // to reproduce commit by commit.
    expect(git('rename-chain', ['diff', '--name-status', '-M', 'HEAD~2', 'HEAD'])).toBe(
      'R100\tsrc/a.ts\tsrc/c.ts',
    );
    expect(git('rename-chain', ['ls-tree', '--name-only', '-r', 'HEAD'])).toBe(
      'src/c.ts',
    );
  });

  it('rename-across-merge renames on one branch, edits on the other, and merges', () => {
    const parents = git('rename-across-merge', ['show', '-s', '--format=%P', 'HEAD']);
    expect(parents.split(' ')).toHaveLength(2);
    expect(git('rename-across-merge', ['ls-tree', '--name-only', '-r', 'HEAD'])).toBe(
      'src/lib/config.ts',
    );
    // The trunk's edit survived the branch's rename: both sides are present in the
    // merged file, which is the fact rename resolution has to preserve.
    expect(git('rename-across-merge', ['show', 'HEAD:src/lib/config.ts'])).toContain(
      "export const override = process.env['CONFIG'];",
    );
  });

  it('rename-back returns the file to its original path', () => {
    expect(statusOf('rename-back', 'HEAD~1')).toBe('R100\tsrc/util.ts\tsrc/helpers.ts');
    expect(statusOf('rename-back', 'HEAD')).toBe('R100\tsrc/helpers.ts\tsrc/util.ts');
    expect(git('rename-back', ['ls-tree', '--name-only', '-r', 'HEAD'])).toBe(
      'src/util.ts',
    );
  });

  it('rename-delete-add-similar splits the pair across commits, so git cannot join it', () => {
    const drop = at('rename-delete-add-similar').oid('drop the tokenizer');
    const add = at('rename-delete-add-similar').oid('add the lexer');

    // Per commit, git sees an unrelated delete and an unrelated add — which is exactly
    // why the M2 similarity heuristic exists.
    expect(statusOf('rename-delete-add-similar', drop)).toBe('D\tsrc/tokenizer.ts');
    expect(statusOf('rename-delete-add-similar', add)).toBe('A\tsrc/lexer.ts');
    // Across the two commits the content similarity is high enough that a heuristic
    // *should* pair them; this is the fixture's ground truth.
    const across = git('rename-delete-add-similar', [
      'diff',
      '--name-status',
      '--find-renames=50%',
      `${drop}~1`,
      add,
    ]);
    expect(across).toMatch(/^R\d+\tsrc\/tokenizer\.ts\tsrc\/lexer\.ts$/);
  });

  it('copy-detected is reported as a copy, with the source still present', () => {
    const status = statusOf('copy-detected', 'HEAD', ['-C']);
    expect(status).toMatch(/^C\d+\tsrc\/handlers\/users\.ts\tsrc\/handlers\/teams\.ts$/m);
    expect(status).toContain('M\tsrc/handlers/users.ts');
    expect(git('copy-detected', ['ls-tree', '--name-only', '-r', 'HEAD'])).toBe(
      ['src/handlers/teams.ts', 'src/handlers/users.ts'].join('\n'),
    );
  });

  it('resurrection re-adds the same path in a later commit, with different content', () => {
    const built = at('resurrection');
    const removed = built.oid('remove the legacy shim');
    const restored = built.oid('bring back the legacy shim');

    expect(statusOf('resurrection', removed)).toBe('D\tsrc/legacy.ts');
    expect(statusOf('resurrection', restored)).toBe('A\tsrc/legacy.ts');
    expect(
      Number(git('resurrection', ['rev-list', '--count', `${removed}..${restored}`])),
    ).toBeGreaterThan(0);
    // A different blob at the same path: one path, two file identities.
    expect(git('resurrection', ['rev-parse', `${restored}:src/legacy.ts`])).not.toBe(
      git('resurrection', ['rev-parse', `${removed}~1:src/legacy.ts`]),
    );
  });
});

describe('merge cases', () => {
  it('merge-fast-forward creates no merge commit at all', () => {
    expect(git('merge-fast-forward', ['rev-list', '--merges', '--count', 'HEAD'])).toBe(
      '0',
    );
    expect(
      git('merge-fast-forward', ['show', '-s', '--format=%P', 'HEAD']).split(' '),
    ).toHaveLength(1);
    expect(git('merge-fast-forward', ['rev-parse', 'HEAD'])).toBe(
      at('merge-fast-forward').oid('wire the feature in'),
    );
  });

  it('merge-true creates exactly one two-parent commit', () => {
    expect(git('merge-true', ['rev-list', '--merges', '--count', 'HEAD'])).toBe('1');
    const merge = at('merge-true').oid("Merge branch 'feature'");
    expect(
      git('merge-true', ['show', '-s', '--format=%P', merge]).split(' '),
    ).toStrictEqual([
      at('merge-true').oid('add the docs'),
      at('merge-true').oid('add the feature module'),
    ]);
    expect(git('merge-true', ['cat-file', '-t', 'v1.0.0'])).toBe('tag');
  });

  it('merge-conflicting-rename leaves both rename destinations live and no markers', () => {
    const merge = at('merge-conflicting-rename').oid('Merge the renames');
    expect(
      git('merge-conflicting-rename', ['show', '-s', '--format=%P', merge]).split(' '),
    ).toHaveLength(2);
    expect(
      git('merge-conflicting-rename', ['ls-tree', '--name-only', '-r', 'HEAD']),
    ).toBe(['src/application.ts', 'src/main-app.ts'].join('\n'));
    // Stronger than "no `<<<<<<<` in the text": both destinations must be the *same
    // blob* as the file the two branches renamed. Neither side edited the content, so any
    // other blob would mean the resolution rule spliced something together — and a
    // conflict marker cannot hide inside an OID comparison.
    const original = git('merge-conflicting-rename', [
      'rev-parse',
      `${at('merge-conflicting-rename').oid('add the app entrypoint')}:src/app.ts`,
    ]);
    for (const path of ['src/application.ts', 'src/main-app.ts']) {
      expect(git('merge-conflicting-rename', ['rev-parse', `HEAD:${path}`])).toBe(
        original,
      );
    }
  });
});

describe('revert cases', () => {
  it('revert-explicit carries git’s own "This reverts commit" line', () => {
    const built = at('revert-explicit');
    const message = git('revert-explicit', ['show', '-s', '--format=%B', 'HEAD']);
    expect(message).toMatch(/^Revert "add the feature flag"/);
    expect(message).toContain(
      `This reverts commit ${built.oid('add the feature flag')}.`,
    );
    expect(statusOf('revert-explicit', 'HEAD')).toBe('D\tsrc/flags.ts');
  });

  it('revert-diff-inverse inverts a diff without the word "revert" anywhere', () => {
    const message = git('revert-diff-inverse', ['show', '-s', '--format=%B', 'HEAD']);
    expect(message.toLowerCase()).not.toContain('revert');
    // The blob is byte-identical to two commits earlier: an exact inverse, invisible to
    // any message-based detector.
    expect(git('revert-diff-inverse', ['rev-parse', 'HEAD:src/retry.ts'])).toBe(
      git('revert-diff-inverse', ['rev-parse', 'HEAD~2:src/retry.ts']),
    );
    expect(git('revert-diff-inverse', ['rev-parse', 'HEAD^{tree}'])).toBe(
      git('revert-diff-inverse', ['rev-parse', 'HEAD~2^{tree}']),
    );
  });

  it('revert-message-only claims a revert its diff does not perform', () => {
    expect(git('revert-message-only', ['show', '-s', '--format=%s', 'HEAD'])).toBe(
      'Revert "add the cache"',
    );
    expect(
      git('revert-message-only', ['show', '-s', '--format=%B', 'HEAD']),
    ).not.toContain('This reverts commit');
    expect(statusOf('revert-message-only', 'HEAD')).toBe('M\tdocs/notes.md');
    // The file the message claims to have reverted is still there, untouched.
    expect(git('revert-message-only', ['rev-parse', 'HEAD:src/cache.ts'])).toBe(
      git('revert-message-only', ['rev-parse', 'HEAD~2:src/cache.ts']),
    );
  });

  it('revert-with-reland restores the original blob after reverting it', () => {
    const built = at('revert-with-reland');
    expect(subjects('revert-with-reland')).toStrictEqual([
      'add the rate limiter',
      'Revert "add the rate limiter"',
      'Reland "add the rate limiter"',
    ]);
    expect(git('revert-with-reland', ['rev-parse', 'HEAD:src/limit.ts'])).toBe(
      git('revert-with-reland', [
        'rev-parse',
        `${built.oid('add the rate limiter')}:src/limit.ts`,
      ]),
    );
    expect(
      statusOf('revert-with-reland', built.oid('Revert "add the rate limiter"')),
    ).toBe('D\tsrc/limit.ts');
  });
});

describe('identity cases', () => {
  it('mailmap-identities maps both aliases to one canonical identity', () => {
    expect(
      git('mailmap-identities', ['check-mailmap', 'A. Lovelace <ada@personal.example>']),
    ).toBe('Ada Lovelace <ada@example.com>');
    expect(git('mailmap-identities', ['check-mailmap', 'ada <ada@corp.example>'])).toBe(
      'Ada Lovelace <ada@example.com>',
    );
    // Three raw author identities collapse to one canonical plus the two other people.
    const raw = new Set(git('mailmap-identities', ['log', '--format=%ae']).split('\n'));
    const mapped = new Set(
      git('mailmap-identities', ['log', '--use-mailmap', '--format=%aE']).split('\n'),
    );
    expect(raw.size).toBe(5);
    expect(mapped.size).toBe(3);
  });

  it('coauthored-by writes trailers git itself can parse back out', () => {
    const trailers = git('coauthored-by', [
      'log',
      '--format=%(trailers:key=Co-authored-by,valueonly,separator=%x2C)',
    ]).split('\n');
    expect(trailers[0]).toBe(
      'Grace Hopper <grace@example.com>,Katherine Johnson <katherine@example.com>',
    );
    expect(trailers[1]).toBe('Grace Hopper <grace@example.com>');
  });

  it('bot-authors uses the address shapes real forge bots commit under', () => {
    const authors = git('bot-authors', ['log', '--format=%an <%ae>']);
    expect(authors).toContain(
      'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
    );
    expect(authors).toContain(
      'renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>',
    );
    expect(authors).toContain(
      'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>',
    );
    expect(authors).toContain('Ada Lovelace <ada@example.com>');
  });

  it('blame-ignore-revs hides the reformat from blame but keeps it in the history', () => {
    const built = at('blame-ignore-revs');
    const reindent = built.oid('reindent everything with four spaces');
    expect(git('blame-ignore-revs', ['show', 'HEAD:.git-blame-ignore-revs'])).toContain(
      reindent,
    );

    // `--root -l -s`: full OIDs, one per line, and *only* the attributions.
    // `--porcelain` also prints a `previous <oid>` field, which mentions the reformat
    // commit even when no line is credited to it; `--root` drops the `^` boundary
    // marker, which truncates the OID by a character to keep the column width.
    const honoured = git('blame-ignore-revs', [
      'blame',
      '--ignore-revs-file=.git-blame-ignore-revs',
      '--root',
      '-l',
      '-s',
      '--',
      'src/report.ts',
    ]);
    expect(honoured).not.toContain(reindent);
    expect(honoured).toContain(built.oid('add the report builder'));
    expect(honoured).toContain(built.oid('fix the totals calculation'));

    // And the wrongness the file exists to prevent: without it, the reformat owns lines
    // it never meaningfully touched. If this ever stops being true, the fixture has
    // stopped demonstrating anything.
    const naive = git('blame-ignore-revs', [
      'blame',
      '--root',
      '-l',
      '-s',
      '--',
      'src/report.ts',
    ]);
    expect(naive).toContain(reindent);
  });
});

describe('content edge cases', () => {
  it('simple-linear is a plain four-commit history with a release tag', () => {
    expect(subjects('simple-linear')).toStrictEqual([
      'add the parser',
      'add a parser test',
      'handle empty input',
      'document the parser',
    ]);
    expect(new Set(git('simple-linear', ['log', '--format=%an']).split('\n')).size).toBe(
      2,
    );
    expect(git('simple-linear', ['cat-file', '-t', 'v0.1.0'])).toBe('tag');
    expect(git('simple-linear', ['rev-parse', 'v0.1.0^{}'])).toBe(
      at('simple-linear').oid('handle empty input'),
    );
  });

  it('empty-commit contains a commit that changes nothing', () => {
    expect(subjects('empty-commit')).toStrictEqual([
      'add the changelog',
      'trigger a rebuild',
      'note the release',
    ]);
    const empty = at('empty-commit').oid('trigger a rebuild');
    expect(git('empty-commit', ['diff', '--name-only', `${empty}~1`, empty])).toBe('');
    expect(git('empty-commit', ['rev-parse', `${empty}^{tree}`])).toBe(
      git('empty-commit', ['rev-parse', `${empty}~1^{tree}`]),
    );
  });

  it('binary-file is a blob git refuses to diff as text', () => {
    expect(git('binary-file', ['diff', '--numstat', 'HEAD~1', 'HEAD'])).toBe(
      '-\t-\tassets/logo.png',
    );
    expect(git('binary-file', ['show', '--stat', '--format=', 'HEAD'])).toContain('Bin');
  });

  it('crlf-line-endings stores CRLF bytes verbatim and then normalises them', () => {
    const built = at('crlf-line-endings');
    const original = git('crlf-line-endings', [
      'show',
      `${built.oid('add a windows-authored build script')}:scripts/build.bat`,
    ]);
    expect(original).toContain('\r\n');
    expect(git('crlf-line-endings', ['show', 'HEAD:scripts/build.bat'])).not.toContain(
      '\r',
    );
    // A whitespace-only change that touches every line: the classic churn false
    // positive, and the reason noise classification exists.
    expect(git('crlf-line-endings', ['diff', '--numstat', 'HEAD~1', 'HEAD'])).toBe(
      '4\t4\tscripts/build.bat',
    );
    expect(
      git('crlf-line-endings', ['ls-tree', 'HEAD', '--', 'scripts/build.sh']),
    ).toMatch(/^100755 blob /);
  });

  it('unicode-paths records composed (NFC) path bytes on every platform', () => {
    const paths = git('unicode-paths', ['ls-files']).split('\n');
    expect(paths).toStrictEqual([
      'docs/🚀-launch.md',
      'src/i18n/café.ts',
      'src/i18n/日本語.ts',
    ]);
    for (const path of paths) {
      expect(path.normalize('NFC')).toBe(path);
    }
    // The decomposed spelling must be absent, or the tree OID differs by platform.
    expect(paths).not.toContain('src/i18n/café.ts'.normalize('NFD'));
    expect(git('unicode-paths', ['show', 'HEAD:src/i18n/日本語.ts'])).toContain(
      'こんにちは',
    );
  });
});

describe('determinism across the whole matrix', () => {
  it('rebuilds a case into a second directory with identical OIDs', async () => {
    // One case rather than all 24, because the guarantee is a property of the builder,
    // not of any individual script — and this test costs a full rebuild.
    const again = await fixture('rename-across-merge');
    try {
      expect([...again.oids]).toStrictEqual([...at('rename-across-merge').oids]);
      expect(again.path).not.toBe(at('rename-across-merge').path);
    } finally {
      await again.cleanup();
    }
  });
});
