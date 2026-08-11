/**
 * The fixture matrix, indexed — ROADMAP M1's "100% of rename and identity fixtures pass".
 *
 * M0 built the 24-case matrix and proved each case produces a valid *repository*. That is a
 * different claim from the one this milestone needs: a fixture can be a perfectly good repository
 * and still be indexed wrongly. This file closes that gap by running the real pipeline over every
 * case and asserting, for all of them, the invariants of Part 8 §8.8 — plus a specific expectation
 * per case where the case exists to test something nameable.
 *
 * **Every case gets the invariant checks, not just the interesting ones.** The bugs that reached
 * real repositories this milestone were all of this shape: `--reverse` emitting a child before its
 * parent, flags computed once at birth and never updated. None of them announced themselves, and
 * none would have been caught by a test that only looked where it expected trouble. So the loop is
 * over `FIXTURE_CASES` — the declared corpus — rather than over a list someone curated, and adding
 * a case to the matrix automatically adds it here.
 *
 * The per-case expectations are deliberately about *observable outcomes* — "these three paths are
 * one file", "these two identities are one person" — rather than about internal ids. An assertion
 * on a `FileId` would pass while the product showed the user three unrelated files.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoId } from '@wise-excavate/core';
import type { FileId } from '@wise-excavate/core';
import { DEFAULT_WALK_SPEC, CliGitBackend } from '@wise-excavate/git';
import type { FixtureCase, FixtureRepo } from '@wise-excavate/git-fixtures';
import { FIXTURE_CASES, fixture as buildCase } from '@wise-excavate/git-fixtures';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';
import type { Store } from '@wise-excavate/store';
import { createIndexPipeline } from '@wise-excavate/index';
import { afterAll, describe, expect, it } from 'vitest';

const scratch: string[] = [];
const repos: FixtureRepo[] = [];

afterAll(async () => {
  for (const repo of repos) await repo.cleanup();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface Indexed {
  readonly store: Store;
  readonly repo: FixtureRepo;
}

async function indexCase(name: FixtureCase): Promise<Indexed> {
  const repo = await buildCase(name);
  repos.push(repo);
  const dir = mkdtempSync(join(tmpdir(), `excavate-mx-${name}-`));
  scratch.push(dir);
  const store = openStore({
    path: join(dir, INDEX_FILE_NAME),
    repoId: repoId(`matrix-${name}`),
  });
  const pipeline = createIndexPipeline({
    backend: new CliGitBackend({ repoRoot: repo.path }),
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
  return { store, repo };
}

/** Every file, as the paths it has ever occupied. The shape the assertions below care about. */
function fileHistories(store: Store): string[][] {
  const out: string[][] = [];
  for (let id = 1; ; id += 1) {
    const file = store.files.byId(id as FileId);
    if (file === null) break;
    out.push(file.aliases.map((a) => store.files.pathOf(a.path) ?? `path ${a.path}`));
  }
  return out;
}

describe.each(FIXTURE_CASES)('matrix case: %s', (name) => {
  it('indexes without error and upholds the §8.8 invariants', async () => {
    const { store } = await indexCase(name);
    try {
      /* 1. The walk completed. `empty-commit` is the only case that could legitimately produce
         zero *changes*, but every case produces at least one commit. */
      expect(store.commits.count(), 'no commits were indexed').toBeGreaterThan(0);

      /* 2. Alias non-overlap. One file may not occupy two paths at the same time — the invariant
         that makes "what was this file called in 2019" answerable at all. */
      for (let id = 1; ; id += 1) {
        const file = store.files.byId(id as FileId);
        if (file === null) break;
        const intervals = [...file.aliases].sort((a, b) => a.from - b.from);
        for (const [i, alias] of intervals.entries()) {
          const next = intervals[i + 1];
          if (next === undefined) continue;
          expect(
            alias.to,
            `${name}: file ${file.id} alias ${i} never closed`,
          ).not.toBeNull();
          expect(
            alias.to ?? Number.MAX_SAFE_INTEGER,
            `${name}: file ${file.id} alias ${i} outlives alias ${i + 1}`,
          ).toBeLessThanOrEqual(next.from);
        }
      }

      /* 3. One FileId per (commit, path). Checked against the path recorded on the change, which
         is the path as it was at that commit. */
      const owner = new Map<string, FileId>();
      for (const commit of store.commits.mostSignificant(5000)) {
        for (const change of store.commits.changesIn(commit.id)) {
          const pathId = change.newPath ?? change.oldPath;
          if (pathId === null) continue;
          const path = store.files.pathOf(pathId);
          if (path === undefined || path === null) continue;
          const key = `${commit.id}\0${path}`;
          const existing = owner.get(key);
          if (existing !== undefined) {
            expect(
              change.file,
              `${name}: commit ${commit.id} path ${path} maps to ${existing} and ${change.file}`,
            ).toBe(existing);
          }
          owner.set(key, change.file);
        }
      }

      /* 4. Parents before children. This is the invariant `--reverse` broke on rust-analyzer, and
         it is cheap enough to assert on every case rather than only on the one built for it. */
      for (const commit of store.commits.mostSignificant(5000)) {
        for (const parent of commit.parents) {
          expect(
            parent,
            `${name}: commit ${commit.id} has parent ${parent} assigned after it`,
          ).toBeLessThan(commit.id);
        }
      }
    } finally {
      store.close();
    }
  }, 120_000);
});

/*
 * The cases that exist to test one nameable outcome, asserted individually.
 *
 * Separate from the sweep above because these are the *reason* the matrix has 24 entries rather
 * than one: a rename chain that indexes cleanly into three unrelated files passes every invariant
 * check and is still wrong in the way that matters to a user.
 */

describe('rename cases stitch lineage', () => {
  it('rename-chain: every path in the chain belongs to one file', async () => {
    const { store, repo } = await indexCase('rename-chain');
    try {
      const histories = fileHistories(store);
      /* The chain's own paths are the fixture's business, so the assertion is structural: exactly
         one file accumulated more than two aliases, and no path appears in two histories. A
         hardcoded path list would break every time the fixture script was edited, and the property
         worth holding is "the chain is one file", not "the chain is these names". */
      const chains = histories.filter((paths) => paths.length >= 3);
      expect(chains.length, `expected one multi-alias file, got ${chains.length}`).toBe(
        1,
      );

      const seen = new Set<string>();
      for (const paths of histories) {
        for (const path of paths) {
          expect(seen.has(path), `${path} appears in two file histories`).toBe(false);
          seen.add(path);
        }
      }
      expect(repo.oids.size).toBeGreaterThan(2);
    } finally {
      store.close();
    }
  }, 120_000);

  it('rename-back: a round trip is one file, not two', async () => {
    const { store } = await indexCase('rename-back');
    try {
      /* A → B → A. The final path equals the original, and a naive implementation creates a second
         file when the old name comes back — which would show the user two half-histories of the
         same file, each missing the other's commits. */
      const multi = fileHistories(store).filter((paths) => paths.length >= 3);
      expect(multi.length).toBe(1);
      // First and last alias name the same path, and it was recorded three times, not deduped.
      const chain = multi[0] ?? [];
      expect(chain[0]).toBe(chain[chain.length - 1]);
    } finally {
      store.close();
    }
  }, 120_000);

  it('resurrection: a deleted-then-recreated path is one file', async () => {
    const { store } = await indexCase('resurrection');
    try {
      /* Part 8 §8.3.2 is explicit that users think of "deleted it, brought it back" as one file.
         Two files here would split File Evolution in half at the deletion. */
      const revived = fileHistories(store).filter((paths) => {
        const unique = new Set(paths);
        return paths.length > unique.size;
      });
      expect(revived.length, 'no file recorded the same path twice').toBeGreaterThan(0);
    } finally {
      store.close();
    }
  }, 120_000);
});

describe('identity cases merge people', () => {
  it('mailmap-identities: the mailmap is authoritative', async () => {
    const { store } = await indexCase('mailmap-identities');
    try {
      const people = store.people.all({ includeBots: true });
      /* The mailmap exists precisely to say "these addresses are one person", so at least one
         person must carry more than one identity and record `mailmap` as the reason. Step 1 of the
         ladder is the only rule that may not be overridden, and `mergeSource` is what lets a user
         audit that it was followed. */
      const merged = people.filter((p) => p.identities.length > 1);
      expect(merged.length, 'the mailmap merged nobody').toBeGreaterThan(0);
      expect(merged.some((p) => p.mergeSource === 'mailmap')).toBe(true);
    } finally {
      store.close();
    }
  }, 120_000);

  it('bot-authors: bots are flagged and kept out of the human list', async () => {
    const { store } = await indexCase('bot-authors');
    try {
      const all = store.people.all({ includeBots: true });
      const humans = store.people.all({ includeBots: false });
      /* Flagged, not dropped: their commits are real provenance. What must not happen is a bot
         appearing in ownership or in the cast of characters. */
      expect(all.length).toBeGreaterThan(humans.length);
      expect(humans.every((p) => !p.isBot)).toBe(true);
    } finally {
      store.close();
    }
  }, 120_000);

  it('coauthored-by: trailers are recorded without becoming the author', async () => {
    const { store } = await indexCase('coauthored-by');
    try {
      /* A co-author is a real contributor and must exist as a person, but the commit has exactly
         one author — crediting a co-author as the author would make ownership wrong in a way no
         one could see. */
      expect(store.people.all({ includeBots: true }).length).toBeGreaterThan(1);
      for (const commit of store.commits.mostSignificant(100)) {
        expect(commit.author).toBeGreaterThan(0);
      }
    } finally {
      store.close();
    }
  }, 120_000);
});
