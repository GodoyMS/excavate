import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { BuildOptions, FixtureRepo } from './index.js';
import { DETERMINISTIC_EPOCH, repo } from './index.js';

/**
 * The oracle: real `git`, run against the fixture with the *developer's* environment.
 *
 * Deliberately not the isolated environment the builder uses. These tests are meant to
 * prove that the objects git sees are the objects we claim, and reading them through a
 * private environment would let a builder bug hide behind a matching reader bug.
 *
 * `spawnSync`, not `execFileSync`, because `execFileSync` returns stdout only — and
 * several of git's answers arrive on stderr or as an exit code. See {@link fsck}.
 */
function oracle(fixture: FixtureRepo, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: fixture.path,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `oracle: git ${args.join(' ')} exited ${String(result.status)}\n` +
        `${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout.trimEnd();
}

/**
 * `git fsck`, as a single string that includes the exit status and *both* streams.
 *
 * Written out rather than folded into {@link oracle} because fsck is the one command here
 * whose whole output matters and whose stream discipline is surprising: `broken link` and
 * `missing tree` go to **stdout**, while `error in commit …: badEmail` and `notice: …` go
 * to **stderr** — and some `--strict` findings are reported while still exiting 0. An
 * assertion that read only stdout, or only the exit code, would let a whole class of
 * corruption through. The expected value is the empty report, exactly.
 */
function fsck(fixture: FixtureRepo): string {
  const args = ['fsck', '--strict', '--no-progress', '--no-dangling'];
  const result = spawnSync('git', args, {
    cwd: fixture.path,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return `exit ${String(result.status)}\n${result.stdout}${result.stderr}`;
}

const built: FixtureRepo[] = [];

async function build(
  builder: ReturnType<typeof repo>,
  options?: BuildOptions,
): Promise<FixtureRepo> {
  const fixture = await builder.build(options);
  built.push(fixture);
  return fixture;
}

/**
 * Build something that is supposed to fail, without leaking a directory when it doesn't.
 *
 * `await expect(repo()…build()).rejects.toThrow(…)` leaks a temporary repository on the
 * one path that matters — the day the guard under test stops working, the build succeeds,
 * nothing registers the result for cleanup, and the assertion failure is accompanied by an
 * orphaned directory. This registers it and then throws a message that no `toThrow`
 * pattern will match, so the test still fails, and fails legibly.
 */
async function buildExpectingFailure(builder: ReturnType<typeof repo>): Promise<never> {
  const fixture = await builder.build();
  built.push(fixture);
  throw new Error(
    `expected build() to reject, but it produced a repository at ${fixture.path}`,
  );
}

afterEach(async () => {
  await Promise.all(built.splice(0).map((fixture) => fixture.cleanup()));
});

describe('the M0 acceptance criterion', () => {
  it('builds a valid repository from a single add', async () => {
    const fixture = await build(
      repo().commit('a', (c) => c.add('x.ts', 'export const x = 1;\n')),
    );

    expect(fsck(fixture)).toBe('exit 0\n');
    expect(oracle(fixture, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(oracle(fixture, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(oracle(fixture, ['show', '-s', '--format=%s', 'HEAD'])).toBe('a');
    expect(oracle(fixture, ['show', 'HEAD:x.ts'])).toBe('export const x = 1;');
    expect(fixture.oid('a')).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.oid('a')).toBe(oracle(fixture, ['rev-parse', 'HEAD']));
  });
});

describe('determinism', () => {
  it('produces identical OIDs when the same script is built into two directories', async () => {
    const script = () =>
      repo('twice')
        .commit('add the module', (c) => c.add('src/mod.ts', 'export const a = 1;\n'))
        .commit('rename it', (c) => c.rename('src/mod.ts', 'src/module.ts'))
        .commit('edit it', (c) =>
          c.edit('src/module.ts', (previous) => `${previous}export const b = 2;\n`),
        )
        .branch('side')
        .commit('add on the side', (c) => c.add('src/side.ts', 'export const s = 3;\n'))
        .checkout('main')
        .commit('add on the trunk', (c) => c.add('src/trunk.ts', 'export const t = 4;\n'))
        .merge('side', { noFastForward: true })
        .tag('v1', { annotated: true, message: 'tag' });

    const first = await build(script());
    const second = await build(script());

    expect(first.path).not.toBe(second.path);
    expect([...second.oids]).toStrictEqual([...first.oids]);
    expect(oracle(second, ['rev-parse', 'v1^{}'])).toBe(
      oracle(first, ['rev-parse', 'v1^{}']),
    );
    // The annotated tag *object* too, not just the commit it points at: the tagger date
    // is inside that object's hash and is the easiest thing to leave floating.
    expect(oracle(second, ['rev-parse', 'v1'])).toBe(oracle(first, ['rev-parse', 'v1']));
  });

  it('produces the same OIDs on every machine, not merely twice on this one', async () => {
    // A golden hash. If this fails on one platform and passes on another, the cause is
    // an environment leak — line endings, unicode normalisation, or an identity that is
    // not fully pinned — and the whole package's guarantee is void until it is found.
    const fixture = await build(
      repo('golden').commit('a', (c) => c.add('x.ts', 'export const x = 1;\n')),
    );
    expect(fixture.oid('a')).toBe('438a05062a2dd95380ec528449d527a3b2798718');
  });

  /**
   * A script whose OID is sensitive to the three settings the rogue config below turns
   * on: CRLF bytes in a blob (`core.autocrlf`), a path whose only non-ASCII character is
   * a composable accent (`core.precomposeunicode`), and the identity fields.
   *
   * The earlier version of this test built a pure-ASCII, LF-only fixture, which meant the
   * rogue `autocrlf` and `precomposeunicode` entries could not have changed the OID even
   * if isolation had failed completely — the test would have passed against a broken
   * implementation. This one cannot.
   */
  const crlfAndUnicode = () =>
    repo('crlf-unicode').commit('a', (c) =>
      c
        .add('src/i18n/café.ts', "export const greeting = 'ça va';\r\n")
        .add('scripts/build.bat', '@echo off\r\nexit /b 0\r\n'),
    );

  // Derived by hand from `git init` + `git add` + `git commit` under nothing but the six
  // pinned identity variables and the null-device config, then confirmed against the
  // builder — so it is a function of the pinned inputs, not a transcription of our own
  // output. See the sibling ASCII golden above.
  const CRLF_UNICODE_GOLDEN = '0eccea9c0e3ded1dac75f5349caef6b696804df7';

  it('hashes CRLF bytes and a composed path to a known OID', async () => {
    const fixture = await build(crlfAndUnicode());
    expect(fixture.oid('a')).toBe(CRLF_UNICODE_GOLDEN);
    // The blob keeps its CRLF bytes, which is the thing `core.autocrlf` would destroy.
    expect(oracle(fixture, ['show', 'HEAD:scripts/build.bat'])).toContain('\r\n');
    expect(oracle(fixture, ['ls-files'])).toBe(
      ['scripts/build.bat', 'src/i18n/café.ts'].join('\n'),
    );
  });

  it('ignores the developer’s global git configuration', async () => {
    const rogueHome = mkdtempSync(join(tmpdir(), 'excavate-rogue-'));
    const rogueConfig = join(rogueHome, 'gitconfig');
    writeFileSync(
      rogueConfig,
      [
        '[user]',
        '\tname = Rogue Developer',
        '\temail = rogue@example.com',
        '[core]',
        '\tautocrlf = true',
        '\tsafecrlf = false',
        '\tprecomposeunicode = false',
        '\tquotepath = true',
        '[commit]',
        '\tgpgsign = true',
        '[diff]',
        '\trenames = false',
        '',
      ].join('\n'),
      'utf8',
    );
    const previous = {
      config: process.env['GIT_CONFIG_GLOBAL'],
      name: process.env['GIT_AUTHOR_NAME'],
      email: process.env['GIT_AUTHOR_EMAIL'],
      date: process.env['GIT_COMMITTER_DATE'],
    };
    process.env['GIT_CONFIG_GLOBAL'] = rogueConfig;
    process.env['GIT_AUTHOR_NAME'] = 'Rogue Developer';
    process.env['GIT_AUTHOR_EMAIL'] = 'rogue@example.com';
    // The committer date is the variable a naive fixture builder forgets, so a rogue one
    // in the ambient environment is the sharpest test of the "fully-specified child
    // environment, never an overlay" rule.
    process.env['GIT_COMMITTER_DATE'] = '@1700000000 +0500';
    try {
      const ascii = await build(
        repo('under-rogue-config').commit('a', (c) =>
          c.add('x.ts', 'export const x = 1;\n'),
        ),
      );
      expect(ascii.oid('a')).toBe('438a05062a2dd95380ec528449d527a3b2798718');

      const sensitive = await build(crlfAndUnicode());
      expect(sensitive.oid('a')).toBe(CRLF_UNICODE_GOLDEN);
    } finally {
      restore('GIT_CONFIG_GLOBAL', previous.config);
      restore('GIT_AUTHOR_NAME', previous.name);
      restore('GIT_AUTHOR_EMAIL', previous.email);
      restore('GIT_COMMITTER_DATE', previous.date);
      rmSync(rogueHome, { recursive: true, force: true });
    }
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('the commit clock and identities', () => {
  it('pins author and committer dates together, so a rerun cannot move an OID', async () => {
    const fixture = await build(
      repo()
        .commit('first', (c) => c.add('a.txt', 'a\n'))
        .commit('second', (c) => c.add('b.txt', 'b\n')),
    );
    const [first, second] = oracle(fixture, [
      'log',
      '--reverse',
      '--format=%at|%ct|%ai|%ci',
    ]).split('\n');

    expect(first).toBe(
      `${DETERMINISTIC_EPOCH}|${DETERMINISTIC_EPOCH}|2020-01-01 00:00:00 +0000|2020-01-01 00:00:00 +0000`,
    );
    expect(second).toBe(
      `${DETERMINISTIC_EPOCH + 3600}|${DETERMINISTIC_EPOCH + 3600}|2020-01-01 01:00:00 +0000|2020-01-01 01:00:00 +0000`,
    );
  });

  it('records the author, the committer, and the offset a fixture asks for', async () => {
    const fixture = await build(
      repo().commit('handoff', (c) =>
        c
          .add('a.txt', 'a\n')
          .author('Ada Lovelace', 'ada@example.com')
          .committer('Grace Hopper')
          .at('2021-06-01T12:00:00+02:00'),
      ),
    );

    expect(oracle(fixture, ['show', '-s', '--format=%an|%ae|%cn|%ce|%ai', 'HEAD'])).toBe(
      'Ada Lovelace|ada@example.com|Grace Hopper|grace.hopper@fixture.invalid|2021-06-01 12:00:00 +0200',
    );
  });

  it('rejects a timestamp without an offset, since local time is not reproducible', () => {
    expect(() => repo().commit('x', (c) => c.at('2021-06-01T12:00:00'))).toThrow(
      /explicit offset/,
    );
  });

  it('keeps later commits on the generated clock after an explicit at()', async () => {
    const fixture = await build(
      repo()
        .commit('first', (c) => c.add('a.txt', 'a\n'))
        .commit('pinned', (c) => c.add('b.txt', 'b\n').at('2021-06-01T12:00:00Z'))
        .commit('third', (c) => c.add('c.txt', 'c\n')),
    );
    expect(oracle(fixture, ['log', '--reverse', '--format=%at'])).toBe(
      [DETERMINISTIC_EPOCH, 1_622_548_800, DETERMINISTIC_EPOCH + 7200].join('\n'),
    );
  });
});

describe('file operations', () => {
  it('writes new content with add and changes it with edit', async () => {
    const fixture = await build(
      repo()
        .commit('add', (c) => c.add('a.txt', 'one\n'))
        .commit('replace', (c) => c.edit('a.txt', 'two\n'))
        .commit('append', (c) => c.edit('a.txt', (previous) => `${previous}three\n`)),
    );
    expect(oracle(fixture, ['show', 'HEAD:a.txt'])).toBe('two\nthree');
    expect(oracle(fixture, ['show', `${fixture.oid('replace')}:a.txt`])).toBe('two');
  });

  it('refuses an add over an existing path and an edit of a missing one', async () => {
    await expect(
      buildExpectingFailure(
        repo().commit('a', (c) => c.add('x.txt', '1\n').add('x.txt', '2\n')),
      ),
    ).rejects.toThrow(/already exists/);
    await expect(
      buildExpectingFailure(repo().commit('a', (c) => c.edit('x.txt', '1\n'))),
    ).rejects.toThrow(/does not exist/);
  });

  it('reports a rename as a rename, not as a delete plus an add', async () => {
    const fixture = await build(
      repo()
        .commit('add', (c) => c.add('src/widget.ts', 'export const w = 1;\n'))
        .commit('move', (c) => c.rename('src/widget.ts', 'src/gadget.ts')),
    );
    expect(oracle(fixture, ['diff', '--name-status', '-M', 'HEAD~1', 'HEAD'])).toBe(
      'R100\tsrc/widget.ts\tsrc/gadget.ts',
    );
  });

  it('reports a copy as a copy when the source is modified alongside it', async () => {
    const fixture = await build(
      repo()
        .commit('add', (c) =>
          c.add('src/a.ts', 'export const a = 1;\nexport const b = 2;\n'),
        )
        .commit('copy', (c) =>
          c
            .copy('src/a.ts', 'src/b.ts')
            .edit('src/a.ts', (previous) => `${previous}export const c = 3;\n`),
        ),
    );
    // Plain `-C`, deliberately *without* `--find-copies-harder`: with that flag git
    // considers every file in the tree as a copy source, so the test would pass even if
    // `copy()` had not modified the original — which is the behaviour being asserted.
    const status = oracle(fixture, ['diff', '--name-status', '-C', 'HEAD~1', 'HEAD']);
    expect(status).toMatch(/^C\d*\tsrc\/a\.ts\tsrc\/b\.ts$/m);
    expect(status).toContain('M\tsrc/a.ts');
  });

  it('removes a path from the tree with delete', async () => {
    const fixture = await build(
      repo()
        .commit('add', (c) => c.add('a.txt', 'a\n').add('b.txt', 'b\n'))
        .commit('remove', (c) => c.delete('a.txt')),
    );
    expect(oracle(fixture, ['ls-tree', '--name-only', 'HEAD'])).toBe('b.txt');
    expect(oracle(fixture, ['diff', '--name-status', 'HEAD~1', 'HEAD'])).toBe('D\ta.txt');
  });

  it('records mode 100755 for an executable file', async () => {
    const fixture = await build(
      repo().commit('add', (c) =>
        c.add('run.sh', '#!/bin/sh\necho hi\n').chmod('run.sh', 0o755),
      ),
    );
    expect(oracle(fixture, ['ls-tree', 'HEAD', '--', 'run.sh'])).toMatch(/^100755 blob /);
  });

  it('commits nothing when a commit declares no operations', async () => {
    const fixture = await build(
      repo()
        .commit('real', (c) => c.add('a.txt', 'a\n'))
        .commit('empty'),
    );
    expect(oracle(fixture, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(oracle(fixture, ['show', '--stat', '--format=%s', 'HEAD'])).toBe('empty');
    expect(oracle(fixture, ['diff', '--name-only', 'HEAD~1', 'HEAD'])).toBe('');
  });
});

describe('reverts', () => {
  it('applies the inverse diff and names the commit it reverts', async () => {
    const fixture = await build(
      repo()
        .commit('add the flag', (c) =>
          c.add('src/flag.ts', 'export const flag = true;\n'),
        )
        .commit('add a doc', (c) => c.add('README.md', '# readme\n'))
        .commit('Revert "add the flag"', (c) => c.revert('add the flag')),
    );

    expect(oracle(fixture, ['show', '-s', '--format=%B', 'HEAD']).trim()).toBe(
      `Revert "add the flag"\n\nThis reverts commit ${fixture.oid('add the flag')}.`,
    );
    expect(oracle(fixture, ['diff', '--name-status', 'HEAD~1', 'HEAD'])).toBe(
      'D\tsrc/flag.ts',
    );
    // Same tree as before the reverted commit, minus the unrelated doc — the strongest
    // available statement that the patch really was inverted.
    expect(oracle(fixture, ['ls-tree', '--name-only', '-r', 'HEAD'])).toBe('README.md');
  });

  it('names the unknown subject when a revert target has not been built', async () => {
    await expect(
      buildExpectingFailure(repo().commit('a', (c) => c.revert('never built'))),
    ).rejects.toThrow(/no commit with subject "never built"/);
  });
});

describe('branches, merges, and tags', () => {
  it('creates a merge commit with two parents when a merge is forced', async () => {
    const fixture = await build(
      repo()
        .commit('base', (c) => c.add('a.txt', 'a\n'))
        .branch('feature')
        .commit('on the branch', (c) => c.add('b.txt', 'b\n'))
        .checkout('main')
        .commit('on the trunk', (c) => c.add('c.txt', 'c\n'))
        .merge('feature', { noFastForward: true }),
    );

    const parents = oracle(fixture, ['show', '-s', '--format=%P', 'HEAD']).split(' ');
    expect(parents).toHaveLength(2);
    expect(parents).toStrictEqual([
      fixture.oid('on the trunk'),
      fixture.oid('on the branch'),
    ]);
    expect(fixture.oid("Merge branch 'feature'")).toBe(
      oracle(fixture, ['rev-parse', 'HEAD']),
    );
  });

  it('fast-forwards without creating a commit when the trunk has not moved', async () => {
    const fixture = await build(
      repo()
        .commit('base', (c) => c.add('a.txt', 'a\n'))
        .branch('feature')
        .commit('on the branch', (c) => c.add('b.txt', 'b\n'))
        .checkout('main')
        .merge('feature'),
    );

    expect(oracle(fixture, ['show', '-s', '--format=%P', 'HEAD'])).toBe(
      fixture.oid('base'),
    );
    expect(oracle(fixture, ['rev-parse', 'HEAD'])).toBe(fixture.oid('on the branch'));
    expect(oracle(fixture, ['rev-list', '--count', 'HEAD'])).toBe('2');
  });

  it('resolves a conflicting merge instead of leaving the fixture half-built', async () => {
    const fixture = await build(
      repo()
        .commit('base', (c) => c.add('a.txt', 'one\n'))
        .branch('feature')
        .commit('branch edit', (c) => c.edit('a.txt', 'branch\n'))
        .checkout('main')
        .commit('trunk edit', (c) => c.edit('a.txt', 'trunk\n'))
        .merge('feature', { subject: 'Merge the conflict' }),
    );

    expect(
      oracle(fixture, ['show', '-s', '--format=%P', 'HEAD']).split(' '),
    ).toHaveLength(2);
    // "Ours" by rule, so no conflict markers survive into the tree.
    expect(oracle(fixture, ['show', 'HEAD:a.txt'])).toBe('trunk');
    expect(oracle(fixture, ['status', '--porcelain'])).toBe('');
  });

  it('writes a lightweight tag as a ref and an annotated tag as an object', async () => {
    const fixture = await build(
      repo()
        .commit('base', (c) => c.add('a.txt', 'a\n'))
        .tag('light')
        .tag('heavy', { annotated: true, message: 'release notes' }),
    );

    expect(oracle(fixture, ['cat-file', '-t', 'light'])).toBe('commit');
    expect(oracle(fixture, ['cat-file', '-t', 'heavy'])).toBe('tag');
    expect(oracle(fixture, ['cat-file', '-p', 'heavy'])).toContain('release notes');
    expect(oracle(fixture, ['rev-parse', 'heavy^{}'])).toBe(fixture.oid('base'));
    // Tagging must not consume a clock tick, or adding a tag would shift every commit
    // after it and invalidate any golden OID in a downstream test.
    expect(
      oracle(fixture, ['for-each-ref', '--format=%(taggerdate:unix)', 'refs/tags/heavy']),
    ).toBe(String(DETERMINISTIC_EPOCH));
  });

  it('stamps an annotated tag with the instant of the commit it points at, pinned or not', async () => {
    const fixture = await build(
      repo()
        .commit('base', (c) => c.add('a.txt', 'a\n'))
        .commit('pinned', (c) => c.edit('a.txt', 'b\n').at('2021-06-01T12:00:00Z'))
        .tag('v1', { annotated: true, message: 'release' }),
    );
    // Recomputing the instant from the commit counter instead of remembering it would
    // stamp this tag 2020-01-01 — a tag object older than the commit it points at.
    expect(
      oracle(fixture, ['for-each-ref', '--format=%(taggerdate:unix)', 'refs/tags/v1']),
    ).toBe('1622548800');
    expect(oracle(fixture, ['rev-parse', 'v1^{}'])).toBe(fixture.oid('pinned'));
  });
});

describe('failures that used to be quiet', () => {
  it('quotes git’s own diagnostic when it lands on stdout rather than stderr', async () => {
    // `git commit --quiet` with nothing staged prints `nothing added to commit` to
    // **stdout** and writes nothing to stderr, so an error built from stderr alone said
    // only "failed with status 1". This is the shape a fixture hits whenever an `edit()`
    // writes the bytes that were already there.
    await expect(
      buildExpectingFailure(
        repo()
          .commit('a', (c) => c.add('a.txt', 'same\n'))
          .commit('b', (c) => c.edit('a.txt', 'same\n')),
      ),
    ).rejects.toThrow(/nothing (added )?to commit/i);
  });

  it('reports why a merge failed when it failed for a reason other than a conflict', async () => {
    // No `feature` branch exists. Without the diagnostic this surfaced as "the merge
    // failed but reported no unmerged paths", which names the symptom and hides the cause.
    await expect(
      buildExpectingFailure(
        repo()
          .commit('base', (c) => c.add('a.txt', 'a\n'))
          .merge('feature'),
      ),
      // git's own words — `merge: feature - not something we can merge` — not our
      // paraphrase. An alternation that also accepted the branch name would have passed
      // against the old message too, which named only the symptom.
    ).rejects.toThrow(/merge: feature - not something we can merge/);
  });

  it('refuses a noFastForward merge that would create no merge commit', async () => {
    // `feature` is already reachable from HEAD, so git says "Already up to date" and
    // exits 0. The old code registered no subject and deferred the failure to whichever
    // test later called `oid("Merge branch 'feature'")`.
    await expect(
      buildExpectingFailure(
        repo()
          .commit('base', (c) => c.add('a.txt', 'a\n'))
          .branch('feature')
          .checkout('main')
          .merge('feature', { noFastForward: true }),
      ),
    ).rejects.toThrow(/created no merge commit/);
  });

  it('refuses a copy that would silently clobber the destination', async () => {
    // `copyFileSync` overwrites without complaint, so a fixture that meant to create a
    // file would have replaced one instead and the history would not match the script.
    await expect(
      buildExpectingFailure(
        repo()
          .commit('a', (c) => c.add('a.txt', 'a\n').add('b.txt', 'b\n'))
          .commit('b', (c) => c.copy('a.txt', 'b.txt')),
      ),
    ).rejects.toThrow(/destination already exists/);
    await expect(
      buildExpectingFailure(
        repo().commit('a', (c) => c.add('a.txt', 'a\n').copy('missing.txt', 'c.txt')),
      ),
    ).rejects.toThrow(/copy\("missing\.txt", "c\.txt"\) but the source does not exist/);
  });

  it('rejects a path that escapes the fixture directory', async () => {
    await expect(
      buildExpectingFailure(repo().commit('a', (c) => c.add('../outside.txt', 'nope\n'))),
    ).rejects.toThrow(/escapes the fixture repository/);
  });
});

describe('identity and blame metadata', () => {
  it('resolves an alias to the canonical identity through .mailmap', async () => {
    const fixture = await build(
      repo()
        .commit('by the alias', (c) =>
          c.add('a.txt', 'a\n').author('A. Lovelace', 'ada@personal.example'),
        )
        .mailmap([
          {
            canonical: { name: 'Ada Lovelace', email: 'ada@example.com' },
            alias: { name: 'A. Lovelace', email: 'ada@personal.example' },
          },
        ]),
    );

    expect(oracle(fixture, ['check-mailmap', 'A. Lovelace <ada@personal.example>'])).toBe(
      'Ada Lovelace <ada@example.com>',
    );
    expect(
      oracle(fixture, [
        'log',
        '--use-mailmap',
        '--format=%aN <%aE>',
        fixture.oid('by the alias'),
      ]),
    ).toBe('Ada Lovelace <ada@example.com>');
  });

  it('writes .git-blame-ignore-revs with resolved OIDs and makes blame honour it', async () => {
    const fixture = await build(
      repo()
        .commit('add the file', (c) => c.add('a.txt', 'one\ntwo\n'))
        .commit('reindent', (c) => c.edit('a.txt', '  one\n  two\n').author('Formatter'))
        .blameIgnore(['reindent']),
    );

    const ignoreFile = readFileSync(join(fixture.path, '.git-blame-ignore-revs'), 'utf8');
    expect(ignoreFile).toContain(fixture.oid('reindent'));
    expect(ignoreFile).toContain('# reindent');

    // `--root -l -s` prints attributions only; `--porcelain` also emits a
    // `previous <oid>` field that names the ignored commit even when no line is
    // credited to it.
    const blamed = oracle(fixture, [
      'blame',
      '--ignore-revs-file=.git-blame-ignore-revs',
      '--root',
      '-l',
      '-s',
      '--',
      'a.txt',
    ]);
    expect(blamed).toContain(fixture.oid('add the file'));
    expect(blamed).not.toContain(fixture.oid('reindent'));
  });
});

describe('the test-facing handles', () => {
  it('fails loudly when two commits share a subject', async () => {
    await expect(
      buildExpectingFailure(
        repo()
          .commit('same', (c) => c.add('a.txt', 'a\n'))
          .commit('same', (c) => c.add('b.txt', 'b\n')),
      ),
    ).rejects.toThrow(/duplicate commit subject "same"/);
  });

  it('lists the known subjects when asked for one that does not exist', async () => {
    const fixture = await build(
      repo()
        .commit('first', (c) => c.add('a.txt', 'a\n'))
        .commit('second', (c) => c.add('b.txt', 'b\n')),
    );
    expect(() => fixture.oid('third')).toThrow(/unknown fixture commit subject "third"/);
    expect(() => fixture.oid('third')).toThrow(/"first"[\s\S]*"second"/);
  });
});

describe('cleanup', () => {
  it('removes the directory, and tolerates being called again', async () => {
    const fixture = await repo()
      .commit('a', (c) => c.add('a.txt', 'a\n'))
      .build();
    expect(existsSync(fixture.path)).toBe(true);
    await fixture.cleanup();
    expect(existsSync(fixture.path)).toBe(false);
    await expect(fixture.cleanup()).resolves.toBeUndefined();
  });

  it('removes the directory when the build itself fails, and says which one', async () => {
    // A throwing build never returns a `FixtureRepo`, so there is no `cleanup()` for the
    // caller to call — the library has to do it or the directory leaks permanently.
    //
    // Asserted from the path named in the error rather than by diffing `readdirSync` of
    // the shared OS temp directory before and after: that diff is a race. Two agents (or
    // two `vitest` invocations, or another test file in another worker) building fixtures
    // concurrently would both appear in it, so the test could fail with someone else's
    // directory or pass while leaking its own.
    const error = await repo()
      .commit('a', (c) => c.edit('missing.txt', 'x\n'))
      .build()
      .then(
        (fixture) => {
          built.push(fixture);
          return new Error(`expected a rejection; got ${fixture.path}`);
        },
        (cause: unknown) => cause,
      );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/does not exist/);
    expect(message).toMatch(/rerun with build\(\{ keep: true \}\)/);
    const named = /the fixture directory (.+) was removed/.exec(message)?.[1];
    expect(named, `no directory named in:\n${message}`).toBeDefined();
    expect(existsSync(named as string)).toBe(false);
  });

  it('keeps the directory when the fixture asked to be kept', async () => {
    const fixture = await repo()
      .commit('a', (c) => c.add('a.txt', 'a\n'))
      .build({ keep: true });
    try {
      await fixture.cleanup();
      expect(existsSync(fixture.path)).toBe(true);
    } finally {
      rmSync(fixture.path, { recursive: true, force: true });
    }
  });

  it('builds into a caller-supplied path, creating it if needed', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'excavate-explicit-'));
    const target = join(parent, 'nested');
    try {
      const fixture = await build(
        repo().commit('a', (c) => c.add('a.txt', 'a\n')),
        { path: target },
      );

      expect(fixture.path).toBe(realpathSync(target));
      expect(existsSync(join(target, '.git'))).toBe(true);
      expect(oracle(fixture, ['show', 'HEAD:a.txt'])).toBe('a');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('the walking skeleton', () => {
  it('builds a 100-commit repository', async () => {
    const builder = repo('hundred');
    builder.commit('seed', (c) => c.add('src/log.ts', 'export const entries = [];\n'));
    for (let i = 1; i < 100; i += 1) {
      builder.commit(`entry ${i}`, (c) =>
        c.edit('src/log.ts', (previous) => `${previous}// entry ${i}\n`),
      );
    }
    const started = Date.now();
    const fixture = await build(builder);
    const elapsedMs = Date.now() - started;

    expect(oracle(fixture, ['rev-list', '--count', 'HEAD'])).toBe('100');
    expect(fixture.oids.size).toBe(100);
    expect(oracle(fixture, ['log', '--format=%at', '-1', '--reverse'])).toBe(
      String(DETERMINISTIC_EPOCH + 99 * 3600),
    );
    // Generous by design: this asserts "not pathological", not a perf budget. M0 has no
    // perf budget (ROADMAP §M0), and a shared CI runner is a noisy clock.
    expect(elapsedMs).toBeLessThan(120_000);
  }, 180_000);
});
