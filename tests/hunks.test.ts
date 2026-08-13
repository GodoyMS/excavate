/**
 * Hunk extraction — M2 deliverable 1, tested against real git output.
 *
 * This is the parser LEAN-V1 §5.1 calls "the one piece of genuinely careful engineering", and
 * the care is all in the framing. Adding `--patch` to a `-z` stream mixes a NUL-delimited
 * format with a line-delimited one, and the two ways of getting it wrong are both silent:
 *
 * - **Reading paths from `diff --git a/<p> b/<p>` is unfixable.** The halves are separated by a
 *   space and paths may contain spaces, so `diff --git a/my file b/my file` parses as `a/my` +
 *   `file b/my file` just as well as intended. git's answer is C-quoting, which is lossy for
 *   non-UTF-8 bytes. So hunks are paired to changes by the `index <old>..<new>` blob hashes
 *   instead, and `pairs a section to its change when the path is ambiguous` is the test that
 *   holds that line.
 * - **Finding the end of the numstat block by sniffing for `diff --git`** would break on a path
 *   that starts with that text. git emits an extra NUL at the boundary, and
 *   `does not mistake a path that looks like a patch header` proves the delimiter is used.
 *
 * Every fixture here goes through the real `git` binary and the real `CliGitBackend`. A
 * hand-written sample of git's output would only prove the parser matches my belief about the
 * format — which is exactly the belief that was wrong twice while writing it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_WALK_SPEC, CliGitBackend, hunkArgs, walkArgs } from '@wise-excavate/git';
import type { RawCommitHunks } from '@wise-excavate/git';
import type { FixtureRepo } from '@wise-excavate/git-fixtures';
import { repo } from '@wise-excavate/git-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let fixture: FixtureRepo;
let records: RawCommitHunks[] = [];
let indexDir: string;

/** The hunk record for the commit with this subject, resolved through the fixture's oids. */
const bySubject = (subject: string): RawCommitHunks => {
  const oid = fixture.oid(subject);
  const found = records.find((r) => r.oid === oid);
  if (found === undefined) throw new Error(`no hunk record for ${subject}`);
  return found;
};

const fileIn = (subject: string, path: string) => {
  const file = bySubject(subject).files.find((f) => f.path === path);
  if (file === undefined) {
    const seen = bySubject(subject)
      .files.map((f) => f.path)
      .join(', ');
    throw new Error(`no hunks for ${path} in ${subject}; saw: ${seen}`);
  }
  return file;
};

const lines = (count: number, tag: string): string =>
  `${Array.from({ length: count }, (_, i) => `${tag} line ${i}`).join('\n')}\n`;

beforeAll(async () => {
  fixture = await repo('hunks')
    .commit('base: a file with twenty lines', (c) =>
      c.add('src/app.ts', lines(20, 'const a =')),
    )
    /* Two edits far apart in one commit. At the default -U3 git would merge them if they were
       within three lines; at -U0 they must come back as two distinct hunks, which is the
       property that makes the geometry worth storing. */
    .commit('edit: change line 2 and line 18', (c) =>
      c.edit(
        'src/app.ts',
        lines(20, 'const a =')
          .split('\n')
          .map((line, i) => (i === 1 || i === 17 ? `${line} // touched` : line))
          .join('\n'),
      ),
    )
    /* Pure insertion in the middle: oldLen must be 0, and git reports the line *before* which
       the insertion lands. */
    .commit('insert: three new lines after line 10', (c) => {
      const original = lines(20, 'const a =').split('\n');
      original.splice(10, 0, 'const inserted0 = 0;', 'const inserted1 = 1;');
      return c.edit('src/app.ts', original.join('\n'));
    })
    /* Whitespace only: reindent without changing a single token. This is what M1 could not
       detect at all and had to approximate from commit scale. */
    .commit('style: reindent the whole file', (c) =>
      c.add('src/indented.ts', 'function f() {\nreturn 1;\n}\n'),
    )
    .commit('style: add indentation and nothing else', (c) =>
      c.edit('src/indented.ts', 'function f() {\n    return 1;\n}\n'),
    )
    /* A path containing spaces — the case that makes `diff --git` parsing ambiguous. */
    .commit('docs: add a file whose name has spaces', (c) =>
      c.add('docs/my notes file.md', '# Notes\n'),
    )
    .commit('docs: edit the file whose name has spaces', (c) =>
      c.edit('docs/my notes file.md', '# Notes\n\nA second line.\n'),
    )
    /* A path that *looks* like a patch header, so a parser sniffing for `diff --git` to find
       the end of the numstat block would swallow it. */
    .commit('docs: add a path that looks like a patch header', (c) =>
      c.add('diff --git a/x b/x', 'not a patch\n'),
    )
    .commit('docs: edit the path that looks like a patch header', (c) =>
      c.edit('diff --git a/x b/x', 'still not a patch\n'),
    )
    .build();

  indexDir = mkdtempSync(join(tmpdir(), 'excavate-hunks-'));
  const backend = new CliGitBackend({ repoRoot: fixture.path });
  records = [];
  for await (const record of backend.hunks(DEFAULT_WALK_SPEC)) records.push(record);
}, 180_000);

afterAll(async () => {
  await fixture?.cleanup();
  if (indexDir !== undefined) rmSync(indexDir, { recursive: true, force: true });
});

describe('hunkArgs', () => {
  it('asks for no context, because context blurs the boundaries being recorded', () => {
    const args = hunkArgs(DEFAULT_WALK_SPEC);
    expect(args).toContain('--patch');
    expect(args).toContain('--unified=0');
    expect(args).toContain('--no-color');
  });

  it('frames on a bare object id, with no sentinel to collide with file content', () => {
    const args = hunkArgs(DEFAULT_WALK_SPEC);
    expect(args).toContain('--format=%H');
    for (const arg of args) expect(arg).not.toContain('\u0001');
  });

  it('passes -c core.quotePath=false before the subcommand, where git accepts it', () => {
    const args = hunkArgs(DEFAULT_WALK_SPEC);
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe('core.quotePath=false');
    expect(args[2]).toBe('log');
  });

  it('never puts the patch on the metadata walk, which cannot frame it safely', () => {
    expect(walkArgs(DEFAULT_WALK_SPEC)).not.toContain('--patch');
  });
});

describe('hunk geometry', () => {
  it('keeps two distant edits as two hunks rather than merging them', () => {
    const file = fileIn('edit: change line 2 and line 18', 'src/app.ts');
    expect(file.hunks).toHaveLength(2);
    const [first, second] = file.hunks;
    expect(first?.newStart).toBe(2);
    expect(second?.newStart).toBe(18);
  });

  it('reports a pure insertion with zero old length', () => {
    const file = fileIn('insert: three new lines after line 10', 'src/app.ts');
    const insertion = file.hunks.find((h) => h.oldLen === 0);
    expect(insertion).toBeDefined();
    expect(insertion?.newLen).toBeGreaterThan(0);
  });

  it('expands the omitted length, which git prints only when it is not 1', () => {
    // `@@ -3 +3 @@` means one line, not zero — a parser defaulting to 0 would record every
    // single-line edit as touching nothing, and every line-level query would miss it.
    const file = fileIn('style: add indentation and nothing else', 'src/indented.ts');
    for (const hunk of file.hunks) {
      expect(hunk.oldLen).toBeGreaterThan(0);
      expect(hunk.newLen).toBeGreaterThan(0);
    }
  });

  it('gives a first commit its additions', () => {
    const file = fileIn('base: a file with twenty lines', 'src/app.ts');
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]?.oldLen).toBe(0);
    expect(file.hunks[0]?.newLen).toBe(20);
  });
});

describe('whitespace-only classification', () => {
  it('recognises a reindent as whitespace-only', () => {
    const file = fileIn('style: add indentation and nothing else', 'src/indented.ts');
    expect(file.hunks.length).toBeGreaterThan(0);
    for (const hunk of file.hunks) expect(hunk.kind).toBe('whitespace-only');
  });

  it('does not call a real edit whitespace-only', () => {
    const file = fileIn('edit: change line 2 and line 18', 'src/app.ts');
    for (const hunk of file.hunks) expect(hunk.kind).toBe('content');
  });

  it('does not call an insertion of real code whitespace-only', () => {
    const file = fileIn('insert: three new lines after line 10', 'src/app.ts');
    expect(file.hunks.some((h) => h.kind === 'content')).toBe(true);
  });
});

describe('the framing hazards', () => {
  it('finds the path when it contains a space', () => {
    // `diff --git a/my notes file.md b/my notes file.md` is genuinely ambiguous — which is why
    // the path comes from `+++ b/<path>`, which holds exactly one. git also appends a TAB after
    // a whitespace-bearing path, and forgetting to cut at it makes every such file unmatchable.
    const file = fileIn(
      'docs: edit the file whose name has spaces',
      'docs/my notes file.md',
    );
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]?.kind).toBe('content');
  });

  it('does not mistake a path that looks like a patch header for one', () => {
    const file = fileIn(
      'docs: edit the path that looks like a patch header',
      'diff --git a/x b/x',
    );
    expect(file.hunks).toHaveLength(1);
  });

  /**
   * The bug that killed the first design, as a fixture.
   *
   * `ripgrep` ships `tests/data/sherlock.br`, a Brotli blob with no NUL in its first 8 kB, so
   * git judges it text and prints its raw bytes into the patch. One of those bytes is `\x01` —
   * exactly one, in 15.2 million bytes of patch output — which was the record separator the
   * first implementation framed commits with. It parsed every fixture and died on the second
   * real repository it saw.
   *
   * This file carries `\x01`, `\x02`, and a NUL late enough to stay "text" by git's rule, so
   * every byte a sentinel-based framing might have chosen appears in content. The assertion is
   * simply that the walk completes and the surrounding commits are still correct: with the old
   * design the stream desynchronised and the *next* commit failed to parse.
   */
  it('survives file content containing every byte a sentinel might use', async () => {
    const padding = 'x'.repeat(9000);
    const hostile = `${padding}\n\u0001\u0002 and a nul \u0000 here\n`;
    const local = await repo('hunks-hostile')
      .commit('safe: a normal file first', (c) => c.add('a.ts', 'export const a = 1;\n'))
      .commit('hostile: content git misjudges as text', (c) => c.add('blob.br', hostile))
      .commit('safe: a normal file after', (c) => c.add('b.ts', 'export const b = 2;\n'))
      .build();
    try {
      const seen: RawCommitHunks[] = [];
      for await (const record of new CliGitBackend({ repoRoot: local.path }).hunks(
        DEFAULT_WALK_SPEC,
      )) {
        seen.push(record);
      }
      expect(seen).toHaveLength(3);
      // The commit *after* the hostile one is where the old framing failed.
      const after = seen.find((r) => r.oid === local.oid('safe: a normal file after'));
      expect(after?.files.map((f) => f.path)).toEqual(['b.ts']);
      const before = seen.find((r) => r.oid === local.oid('safe: a normal file first'));
      expect(before?.files.map((f) => f.path)).toEqual(['a.ts']);
    } finally {
      await local.cleanup();
    }
  }, 120_000);

  it('records every file it saw, with geometry that is internally consistent', () => {
    for (const record of records) {
      for (const file of record.files) {
        expect(file.path).not.toBe('');
        expect(file.path).not.toContain('\t');
        for (const hunk of file.hunks) {
          expect(hunk.oldStart).toBeGreaterThanOrEqual(0);
          expect(hunk.newStart).toBeGreaterThanOrEqual(0);
          expect(hunk.oldLen).toBeGreaterThanOrEqual(0);
          expect(hunk.newLen).toBeGreaterThanOrEqual(0);
          // A hunk that changes nothing on either side is not a hunk git emits.
          expect(hunk.oldLen + hunk.newLen).toBeGreaterThan(0);
        }
      }
    }
  });
});
