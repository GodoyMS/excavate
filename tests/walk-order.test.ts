/**
 * Regression: the walk must emit parents before children, whatever the commit dates say.
 *
 * `git log --reverse` reverses git's *default* order, which is by commit date — and commit
 * date is not topological. A rebase, a cherry-pick, or clock skew on one machine produces a
 * commit whose parent carries a later date, and `--reverse` then emits that commit before
 * its own parent.
 *
 * `@excavate/index` assigns dense `CommitId`s in walk order and writes parent edges as it
 * goes, so one inverted pair makes `commit_parents.parent_id` reference a row that does not
 * exist yet, and the whole index fails with `FOREIGN KEY constraint failed`.
 *
 * **How this was found, and why the test is shaped like this.** Every fixture passed. So did
 * `ripgrep` — 2,255 commits, zero inversions. `rust-analyzer` failed: exactly one inversion
 * in 12,832 first-parent commits. One in twelve thousand is the density that survives a
 * whole test suite and dies on a real repository, which is precisely what ROADMAP §3's
 * "works on all three reference targets" exists to catch.
 *
 * The fix is `--topo-order` in `walkArgs`. This test reproduces the *condition* rather than
 * the repository: two ref tips where a commit is dated months before its own parent. All
 * four assertions below were confirmed to fail with the fix reverted — the last one with the
 * original `FOREIGN KEY constraint failed` — so none of them is decorative.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseOid, repoId } from '@excavate/core';
import { DEFAULT_WALK_SPEC, CliGitBackend, walkArgs } from '@excavate/git';
import type { FixtureRepo } from '@excavate/git-fixtures';
import { repo } from '@excavate/git-fixtures';
import { INDEX_FILE_NAME, openStore } from '@excavate/store';
import { createIndexPipeline } from '@excavate/index';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let fixture: FixtureRepo;
let indexDir: string;

beforeAll(async () => {
  /**
   * **Two ref tips are required, and the first attempt at this fixture was wrong.**
   *
   * A linear chain cannot reproduce the bug: git discovers a child before its parent
   * exists in the queue, so reversing the output happens to be topological by accident. The
   * inversion needs the parent to be an independent ref tip, so it is already queued when
   * its own child is popped — then a date-ordered queue pops the *later-dated parent first*,
   * and `--reverse` puts the child ahead of it.
   *
   * Verified against real git before being written down: without `--topo-order` this shape
   * emits `child dated earlier` at index 1 and `parent dated later` at index 2.
   */
  fixture = await repo('clock-skew')
    .commit('root', (c) =>
      c.add('a.ts', 'export const a = 1;\n').at('2020-01-01T00:00:00+00:00'),
    )
    // Stays as `main`'s tip, carrying a date months ahead of its own child.
    .commit('parent dated later', (c) =>
      c.add('b.ts', 'export const b = 2;\n').at('2020-06-01T00:00:00+00:00'),
    )
    // A second ref tip whose commit is a *child* of main's tip but dated before it. An
    // ordinary rebased or cherry-picked history, not a corrupt one.
    .branch('feature')
    .commit('child dated earlier', (c) =>
      c.add('c.ts', 'export const c = 3;\n').at('2020-01-15T00:00:00+00:00'),
    )
    .build();
  indexDir = mkdtempSync(join(tmpdir(), 'excavate-order-'));
}, 60_000);

afterAll(async () => {
  await fixture?.cleanup();
  if (indexDir !== undefined) rmSync(indexDir, { recursive: true, force: true });
});

describe('walkArgs', () => {
  it('always asks git for a topological order', () => {
    // Emission order is an index concern — referential integrity needs parents first —
    // while presentation order is a query concern. So this holds for every projection.
    for (const projection of ['first-parent', 'topological', 'author-date'] as const) {
      expect(walkArgs({ ...DEFAULT_WALK_SPEC, projection })).toContain('--topo-order');
    }
  });

  it('never relies on --reverse alone for ordering', () => {
    const args = walkArgs(DEFAULT_WALK_SPEC);
    expect(args).toContain('--reverse');
    expect(args.indexOf('--topo-order')).toBeGreaterThanOrEqual(0);
  });
});

describe('the fixture really does invert commit date against topology', () => {
  it('emits every parent before its child, despite the later timestamp', async () => {
    const backend = new CliGitBackend({ repoRoot: fixture.path });
    const walked = [];
    for await (const commit of backend.walk(DEFAULT_WALK_SPEC)) walked.push(commit);

    expect(walked).toHaveLength(3);
    const position = new Map(walked.map((commit, i) => [commit.oid, i]));

    // The assertion that matters, stated over the whole graph rather than one pair: no
    // commit may appear before any parent the walk also emitted.
    for (const commit of walked) {
      for (const parent of commit.parents) {
        if (position.has(parent)) {
          expect(position.get(parent)!).toBeLessThan(position.get(commit.oid)!);
        }
      }
    }

    // And the fixture really does invert date against topology, or the loop above is vacuous.
    const parent = walked[position.get(parseOid(fixture.oid('parent dated later')))!]!;
    const child = walked[position.get(parseOid(fixture.oid('child dated earlier')))!]!;
    expect(child.parents).toContain(parent.oid);
    expect(parent.committedAt.epochSeconds).toBeGreaterThan(
      child.committedAt.epochSeconds,
    );
  });
});

describe('indexing a clock-skewed history', () => {
  it('completes instead of failing on a parent foreign key', async () => {
    const store = openStore({
      path: join(indexDir, INDEX_FILE_NAME),
      repoId: repoId('clock-skew-test'),
    });
    try {
      const pipeline = createIndexPipeline({
        backend: new CliGitBackend({ repoRoot: fixture.path }),
        store,
        sinks: [],
        walkSpec: DEFAULT_WALK_SPEC,
      });
      for await (const progress of pipeline.run({
        tiers: ['metadata'],
        signal: new AbortController().signal,
      })) {
        void progress;
      }

      expect(store.commits.count()).toBe(3);
      const parent = store.commits.byOid(parseOid(fixture.oid('parent dated later')));
      const child = store.commits.byOid(parseOid(fixture.oid('child dated earlier')));
      expect(parent).not.toBeNull();
      expect(child).not.toBeNull();
      // The dense ids must respect topology, because `generation` is derived from them.
      expect(child!.id).toBeGreaterThan(parent!.id);
      expect(child!.parents).toContain(parent!.id);
    } finally {
      store.close();
    }
  });
});
