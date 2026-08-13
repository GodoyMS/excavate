/**
 * The content tier — hunks from the second git pass into SQLite, and back out as blame's
 * pre-filter.
 *
 * Two things are being proved, and only the second is interesting.
 *
 * The first is plumbing: hunks reach the table, attached to the `FileId` the *metadata* tier
 * chose. That matters because a path is not an identity — `renames.ts` exists precisely because
 * the same file wears different paths over its life — so the content tier reads back each
 * commit's stored `changes` rows instead of resolving paths itself. Two independent resolutions
 * would eventually disagree, and the disagreement would be silent.
 *
 * The second is the reason the table is worth its rows at all. `commitsTouching` is the query
 * Part 9's blame strategy is built on: consult only the commits whose hunks overlap the lines in
 * question, instead of blaming a whole file and throwing most of it away. `narrows a line
 * question to the commits that could answer it` is that claim, stated as arithmetic — the
 * fixture has a file with many commits where only some touched the line asked about, so a
 * pre-filter that returned everything would fail rather than merely be slow.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromDate, parseOid, repoId } from '@wise-excavate/core';
import type { CommitId, FileId } from '@wise-excavate/core';
import { DEFAULT_WALK_SPEC, CliGitBackend } from '@wise-excavate/git';
import type { FixtureRepo } from '@wise-excavate/git-fixtures';
import { repo } from '@wise-excavate/git-fixtures';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';
import type { Store } from '@wise-excavate/store';
import { createIndexPipeline } from '@wise-excavate/index';
import { runAnalysis } from '@wise-excavate/analysis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let fixture: FixtureRepo;
let store: Store;
let indexDir: string;

/** The file every assertion below is about. */
let app: FileId;

const commitFor = (subject: string): CommitId => {
  const commit = store.commits.byOid(parseOid(fixture.oid(subject)));
  if (commit === null) throw new Error(`not indexed: ${subject}`);
  return commit.id;
};

/** Twenty numbered lines, so a line number in an assertion means something specific. */
const numbered = (mutate: (lines: string[]) => void = () => {}): string => {
  const lines = Array.from({ length: 20 }, (_, i) => `const value${i} = ${i};`);
  mutate(lines);
  return `${lines.join('\n')}\n`;
};

beforeAll(async () => {
  fixture = await repo('content-tier')
    .commit('base: twenty lines', (c) => c.add('src/app.ts', numbered()))
    /* Three commits, each touching a *different* region. This is what makes the pre-filter
       assertion meaningful: asking about line 3 must not return the commit that edited line 17. */
    .commit('edit: line 3 only', (c) =>
      c.edit(
        'src/app.ts',
        numbered((l) => {
          l[2] = 'const value2 = 222;';
        }),
      ),
    )
    .commit('edit: line 17 only', (c) =>
      c.edit(
        'src/app.ts',
        numbered((l) => {
          l[2] = 'const value2 = 222;';
          l[16] = 'const value16 = 1616;';
        }),
      ),
    )
    /* A rename with an edit, so the hunks have to attach to the *same* FileId as before under a
       different path. A content tier resolving paths on its own would create a second file here. */
    .commit('move: rename to core.ts and edit line 5', (c) =>
      c.rename('src/app.ts', 'src/core.ts').edit(
        'src/core.ts',
        numbered((l) => {
          l[2] = 'const value2 = 222;';
          l[16] = 'const value16 = 1616;';
          l[4] = 'const value4 = 444;';
        }),
      ),
    )
    /* A whitespace-only commit, so the stored `kind` can be checked end to end. */
    .commit('style: indent line 9 and nothing else', (c) =>
      c.edit(
        'src/core.ts',
        numbered((l) => {
          l[2] = 'const value2 = 222;';
          l[16] = 'const value16 = 1616;';
          l[4] = 'const value4 = 444;';
          l[8] = '    const value8 = 8;';
        }),
      ),
    )
    .build();

  indexDir = mkdtempSync(join(tmpdir(), 'excavate-content-'));
  store = openStore({
    path: join(indexDir, INDEX_FILE_NAME),
    repoId: repoId('content-tier-test'),
  });
  const pipeline = createIndexPipeline({
    backend: new CliGitBackend({ repoRoot: fixture.path }),
    store,
    sinks: [],
    walkSpec: DEFAULT_WALK_SPEC,
  });
  for await (const progress of pipeline.run({
    tiers: ['metadata', 'content'],
    signal: new AbortController().signal,
  })) {
    void progress;
  }

  await runAnalysis({
    store,
    now: fromDate(new Date('2026-01-01T00:00:00Z')),
    signal: new AbortController().signal,
    throughOid: parseOid(fixture.oid('style: indent line 9 and nothing else')),
  });

  const head = store.commits.byOid(
    parseOid(fixture.oid('style: indent line 9 and nothing else')),
  );
  const changes = store.commits.changesIn(head?.id ?? (0 as CommitId));
  const file = changes[0]?.file;
  if (file === undefined) throw new Error('no changes indexed for the head commit');
  app = file;
}, 300_000);

afterAll(async () => {
  store?.close();
  await fixture?.cleanup();
  if (indexDir !== undefined) rmSync(indexDir, { recursive: true, force: true });
});

describe('the content tier', () => {
  it('stores hunks for every commit that changed lines', () => {
    for (const subject of [
      'base: twenty lines',
      'edit: line 3 only',
      'edit: line 17 only',
      'style: indent line 9 and nothing else',
    ]) {
      const hunks = store.commits.hunksIn(commitFor(subject), app);
      expect(hunks.length, `hunks for ${subject}`).toBeGreaterThan(0);
    }
  });

  it('attaches a renamed file`s hunks to the identity the walk already assigned', () => {
    // The whole point of the alias chain: one FileId across both paths. A content tier that
    // resolved `src/core.ts` independently would have produced a second file, and this
    // assertion — the same `app` id used for a pre-rename commit and a post-rename one — is
    // what catches that.
    const before = store.commits.hunksIn(commitFor('edit: line 3 only'), app);
    const after = store.commits.hunksIn(
      commitFor('move: rename to core.ts and edit line 5'),
      app,
    );
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
  });

  it('records the whitespace-only kind, which M1 could not detect at all', () => {
    const hunks = store.commits.hunksIn(
      commitFor('style: indent line 9 and nothing else'),
      app,
    );
    expect(hunks.length).toBeGreaterThan(0);
    for (const hunk of hunks) expect(hunk.kind).toBe('whitespace-only');
  });

  it('does not label a real edit whitespace-only', () => {
    const hunks = store.commits.hunksIn(commitFor('edit: line 3 only'), app);
    for (const hunk of hunks) expect(hunk.kind).toBe('content');
  });
});

describe('commitsTouching, the pre-filter blame is built on', () => {
  it('narrows a line question to the commits that could answer it', () => {
    // Line 3 (1-indexed) was changed by `edit: line 3 only` and by the base commit that created
    // it. It was *not* changed by the commit that edited line 17 — and a pre-filter that
    // returned that commit anyway would make blame do work it never needed to do.
    const touching = store.commits.commitsTouching(app, 3, 4);
    expect(touching).toContain(commitFor('edit: line 3 only'));
    expect(touching).not.toContain(commitFor('edit: line 17 only'));
  });

  it('returns the newest commit first, so "who last changed this" reads one row', () => {
    const touching = store.commits.commitsTouching(app, 1, 21);
    const descending = [...touching].sort((a, b) => b - a);
    expect(touching).toEqual(descending);
  });

  it('finds nothing for a line beyond the file, rather than guessing', () => {
    expect(store.commits.commitsTouching(app, 5000, 5001)).toEqual([]);
  });

  /**
   * An empty range throws rather than returning `[]`.
   *
   * "No commits touched these lines" and "you asked about no lines" are different answers, and
   * conflating them would let a caller with an off-by-one bug read a confident, wrong "nobody
   * has ever touched this line" — the one thing this query must never invent.
   */
  it('refuses an empty or inverted range instead of answering it', () => {
    expect(() => store.commits.commitsTouching(app, 5, 5)).toThrow(/empty/);
    expect(() => store.commits.commitsTouching(app, 9, 4)).toThrow(/empty/);
  });

  it('is cheaper than blaming the file, which is the only reason it exists', () => {
    // The file has five commits; a single line should implicate a strict minority of them.
    const all = store.commits.commitsTouching(app, 1, 21);
    const one = store.commits.commitsTouching(app, 17, 18);
    expect(one.length).toBeLessThan(all.length);
    expect(one.length).toBeGreaterThan(0);
  });
});

describe('format-only, the flag M1 could not set', () => {
  /**
   * The M1 P2, retired.
   *
   * Without the diff body `format-only` was undecidable, so a codemod had to be caught by scale
   * plus uniformity or by a subject naming its tool — heuristics standing in for a measurement.
   * `HunkKind.WhitespaceOnly` is the measurement.
   */
  it('flags a commit whose every hunk is whitespace-only', () => {
    const commit = store.commits.byId(commitFor('style: indent line 9 and nothing else'));
    expect(commit?.flags).toContain('format-only');
  });

  it('does not flag a commit that changed real code', () => {
    for (const subject of [
      'base: twenty lines',
      'edit: line 3 only',
      'edit: line 17 only',
    ]) {
      const commit = store.commits.byId(commitFor(subject));
      expect(commit?.flags, subject).not.toContain('format-only');
    }
  });

  it('preserves the flags the walk already assigned', () => {
    // `flags = flags | ?` rather than a replacement. The root commit keeps `root`, and losing it
    // would break every query that asks where history begins.
    const root = store.commits.byId(commitFor('base: twenty lines'));
    expect(root?.flags).toContain('root');
  });

  /**
   * The all-or-nothing rule, which is the one that stops this being harmful.
   *
   * A commit that reformats one file *and* changes logic in another is a real change. Flagging it
   * `format-only` would apply a penalty large enough to sink it out of the significance ranking
   * entirely — so the failure mode of getting this wrong is hiding real work, not showing noise.
   */
  it('does not flag a commit that mixes formatting with a real change', async () => {
    const local = await repo('format-mixed')
      .commit('base', (c) =>
        c.add('a.ts', 'function f() {\nreturn 1;\n}\n').add('b.ts', 'const b = 1;\n'),
      )
      .commit('mixed: reindent a.ts and change b.ts', (c) =>
        c
          .edit('a.ts', 'function f() {\n    return 1;\n}\n')
          .edit('b.ts', 'const b = 2;\n'),
      )
      .build();
    const dir = mkdtempSync(join(tmpdir(), 'excavate-mixed-'));
    const mixedStore = openStore({
      path: join(dir, INDEX_FILE_NAME),
      repoId: repoId('format-mixed'),
    });
    try {
      const pipeline = createIndexPipeline({
        backend: new CliGitBackend({ repoRoot: local.path }),
        store: mixedStore,
        sinks: [],
        walkSpec: DEFAULT_WALK_SPEC,
      });
      for await (const progress of pipeline.run({
        tiers: ['metadata', 'content'],
        signal: new AbortController().signal,
      })) {
        void progress;
      }
      await runAnalysis({
        store: mixedStore,
        now: fromDate(new Date('2026-01-01T00:00:00Z')),
        signal: new AbortController().signal,
        throughOid: local.oid('mixed: reindent a.ts and change b.ts'),
      });

      const mixed = mixedStore.commits.byOid(
        parseOid(local.oid('mixed: reindent a.ts and change b.ts')),
      );
      expect(mixed?.flags).not.toContain('format-only');
      // And the whitespace-only hunk is still *recorded* — the file-level fact survives even
      // though the commit-level flag correctly does not fire.
      const hunks = mixedStore.commits
        .changesIn(mixed?.id ?? (0 as CommitId))
        .flatMap((change) =>
          mixedStore.commits.hunksIn(mixed?.id ?? (0 as CommitId), change.file),
        );
      expect(hunks.some((h) => h.kind === 'whitespace-only')).toBe(true);
      expect(hunks.some((h) => h.kind === 'content')).toBe(true);
    } finally {
      mixedStore.close();
      await local.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
