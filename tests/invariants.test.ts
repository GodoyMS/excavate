/**
 * Determinism and the three structural invariants — ROADMAP M1's remaining assertions.
 *
 * > **Determinism test:** index twice → byte-identical derived tables.
 * > Property tests: alias non-overlap; every `(commit, path)` resolves to exactly one `FileId`.
 *
 * These are the properties every other query silently assumes. Part 8 §8.8 lists them as
 * invariants rather than as behaviours because nothing downstream re-checks them: `excavate why`
 * resolving a line to two `FileId`s does not fail loudly, it produces a confidently wrong answer
 * with a citation attached. That is the failure mode this file exists to make impossible.
 *
 * **Why determinism is a correctness property and not a nicety.** Part 12's whole trust argument
 * rests on the user being able to re-run and get the same answer — an index that reorders under
 * `Map` iteration or a `Date.now()` read would make two people looking at the same repository
 * disagree about who owns a file, and neither could tell which of them was wrong. It is also the
 * property that makes incremental indexing safe to trust: if a full rebuild and an incremental
 * update can differ, every cached index is suspect.
 *
 * The fixture deliberately contains the constructs most likely to break each property: renames
 * (alias chains), a delete-then-add at the same path (resurrection, where alias intervals are
 * most likely to overlap), a rename onto an occupied path (where two files claim one path), and
 * two identities for one person.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoId } from '@wise-excavate/core';
import type { FileId } from '@wise-excavate/core';
import { DEFAULT_WALK_SPEC, CliGitBackend } from '@wise-excavate/git';
import type { FixtureRepo } from '@wise-excavate/git-fixtures';
import { repo } from '@wise-excavate/git-fixtures';
import { INDEX_FILE_NAME, openStore } from '@wise-excavate/store';
import type { Store } from '@wise-excavate/store';
import { createIndexPipeline } from '@wise-excavate/index';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Files big enough for git's rename detection to mean something.
 *
 * The first version of this fixture used one-line files, and `rename gamma to delta and edit it`
 * silently stopped being a rename: adding one line to a one-line file leaves 50% similarity, right
 * on `--find-renames=50%`, so git reported delete+add and the alias chain correctly refused to
 * stitch them. The test was measuring git's threshold arithmetic rather than this project's
 * stitching. Two dozen lines puts every case here far from the boundary, which is also where real
 * source files live.
 */
const body = (tag: string, lines: number): string =>
  `${Array.from({ length: lines }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n')}\n`;

let fixture: FixtureRepo;
const dirs: string[] = [];

/** Index the fixture into a fresh directory and hand back the open store. */
async function indexOnce(): Promise<{ store: Store }> {
  const dir = mkdtempSync(join(tmpdir(), 'excavate-inv-'));
  dirs.push(dir);
  const store = openStore({
    path: join(dir, INDEX_FILE_NAME),
    repoId: repoId('invariants-test'),
  });
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
  return { store };
}

beforeAll(async () => {
  fixture = await repo('invariants')
    .commit('root', (c) =>
      c
        .add('src/alpha.ts', body('alpha', 24))
        .add('src/beta.ts', body('beta', 18))
        .add('README.md', '# project\n')
        .author('Ada Lovelace', 'ada@example.com')
        .at('2020-01-01T00:00:00+00:00'),
    )
    // A plain rename: one file, two aliases, and they must not overlap in time.
    .commit('rename alpha to gamma', (c) =>
      c.rename('src/alpha.ts', 'src/gamma.ts').at('2020-02-01T00:00:00+00:00'),
    )
    // Rename with an edit, which is where similarity detection has to hold the lineage.
    .commit('rename gamma to delta and edit it', (c) =>
      c
        .rename('src/gamma.ts', 'src/delta.ts')
        .edit('src/delta.ts', `${body('alpha', 24)}export const extra = 3;\n`)
        .at('2020-03-01T00:00:00+00:00'),
    )
    /* Resurrection: the path dies and comes back. The riskiest case for alias non-overlap,
       because a naive implementation reopens the interval without closing the first. */
    .commit('delete beta', (c) => c.delete('src/beta.ts').at('2020-04-01T00:00:00+00:00'))
    .commit('bring beta back', (c) =>
      c.add('src/beta.ts', body('beta', 18)).at('2020-05-01T00:00:00+00:00'),
    )
    /* A rename *onto* an occupied path. Two files want `src/delta.ts` at once, and the
       displaced one has to be closed out or invariant 1 breaks. */
    .commit('overwrite delta with a rename', (c) =>
      c.add('src/temp.ts', body('temp', 21)).at('2020-06-01T00:00:00+00:00'),
    )
    /* `git mv` refuses an occupied destination, so the displacement is expressed the way it
       actually reaches the index: delete the occupant and move the other file in, both in one
       commit. Git's rename detection reports exactly the shape a real overwrite produces. */
    .commit('move temp onto delta', (c) =>
      c
        .delete('src/delta.ts')
        .rename('src/temp.ts', 'src/delta.ts')
        .at('2020-07-01T00:00:00+00:00'),
    )
    // A second identity for Ada, so person merging participates in the determinism check.
    .commit('a commit from Ada under another address', (c) =>
      c
        .edit('README.md', '# project\n\nNow with prose.\n')
        .author('Ada Lovelace', 'ada@users.noreply.github.com')
        .at('2020-08-01T00:00:00+00:00'),
    )
    .build();
}, 180_000);

afterAll(async () => {
  await fixture?.cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('determinism', () => {
  it('produces identical derived state when the same history is indexed twice', async () => {
    const first = await indexOnce();
    const second = await indexOnce();
    try {
      /* Compared as *content* rather than as bytes of the file. Two SQLite files built by
         identical inserts are not guaranteed to be byte-identical — free-page layout and the
         WAL checkpoint boundary are allowed to differ — so hashing `index.db` would produce a
         test that fails for reasons no user could ever observe. What must match is every value
         a query can return, which is what the ROADMAP means by "derived tables". */
      const dump = (store: Store): string =>
        JSON.stringify({
          commits: store.commits
            .mostSignificant(1000)
            .map((c) => [
              c.oid,
              c.id,
              c.author,
              c.significance,
              [...c.flags].sort(),
              c.parents,
            ]),
          files: filesOf(store),
          people: store.people
            .all({ includeBots: true })
            .map((p) => [
              p.id,
              p.canonicalName,
              p.canonicalEmail,
              p.commitCount,
              p.mergeSource,
            ]),
        });

      expect(dump(second.store)).toBe(dump(first.store));
    } finally {
      first.store.close();
      second.store.close();
    }
  });

  it('assigns the same dense ids in the same order on both runs', async () => {
    /* Separate from the dump above because dense ids are the one thing a re-index *could*
       plausibly get away with changing — nothing user-visible names a `CommitId`. But they are
       foreign keys in every derived table and the basis of `generation`, so an index whose ids
       shifted would make a stale cached rollup silently point at the wrong commits. */
    const first = await indexOnce();
    const second = await indexOnce();
    try {
      const order = (store: Store): string[] =>
        // Copied before sorting: the query returns a readonly view, and sorting it in place would
        // be mutating the store's result rather than this test's own list.
        [...store.commits.mostSignificant(1000)]
          .sort((a, b) => a.id - b.id)
          .map((c) => `${c.id}:${c.oid}`);
      expect(order(second.store)).toEqual(order(first.store));
    } finally {
      first.store.close();
      second.store.close();
    }
  });
});

/** Every file with its alias intervals, ordered so the comparison is stable. */
function filesOf(store: Store): unknown[] {
  const out: unknown[] = [];
  for (let id = 1; ; id += 1) {
    const file = store.files.byId(id as FileId);
    if (file === null) break;
    out.push([
      file.id,
      file.born,
      file.died,
      file.language,
      [...file.flags].sort(),
      file.aliases.map((a) => [
        store.files.pathOf(a.path) ?? String(a.path),
        a.from,
        a.to,
      ]),
    ]);
  }
  return out;
}

describe('structural invariants', () => {
  it('never lets one file hold two live aliases at the same time', async () => {
    const { store } = await indexOnce();
    try {
      let checked = 0;
      for (let id = 1; ; id += 1) {
        const file = store.files.byId(id as FileId);
        if (file === null) break;

        /* Invariant 2 of §8.8. Sorted by start, then each interval must end before the next
           begins. `to === null` means "still live", which only the last interval may be —
           an open interval in the middle would mean the file occupied two paths at once. */
        const intervals = [...file.aliases].sort((a, b) => a.from - b.from);
        for (const [i, alias] of intervals.entries()) {
          const next = intervals[i + 1];
          if (next === undefined) continue;
          expect(
            alias.to,
            `file ${file.id} alias ${i} is still open but another follows it`,
          ).not.toBeNull();
          expect(
            alias.to ?? Number.MAX_SAFE_INTEGER,
            `file ${file.id}: alias ${i} outlives the start of alias ${i + 1}`,
          ).toBeLessThanOrEqual(next.from);
        }
        checked += 1;
      }
      // Guards the loop itself: zero files would satisfy every assertion above.
      expect(checked).toBeGreaterThan(3);
    } finally {
      store.close();
    }
  });

  it('resolves every (commit, path) pair to exactly one FileId', async () => {
    const { store } = await indexOnce();
    try {
      /* Invariant 1 of §8.8, checked by inverting the index: walk every change row, key it by
         the commit and path it names, and assert no key ever maps to two files. Building the map
         from the stored rows rather than from `byPath` is deliberate — it tests what indexing
         *wrote*, not what one query chooses to return, and a query that resolved ambiguity by
         picking the lowest id would hide the very inconsistency this is looking for. */
      const owner = new Map<string, FileId>();
      let pairs = 0;
      for (const commit of store.commits.mostSignificant(1000)) {
        for (const change of store.commits.changesIn(commit.id)) {
          /* Keyed on the path *at this commit* rather than the file's current path. The invariant
             is about what a path meant when the commit was made, which is the question
             `excavate why src/db.ts:142` asks of a five-year-old commit. Keying on the current path
             would also skip every file that has since died — and a dead file is exactly where a
             stale alias would hide. */
          const pathId = change.newPath ?? change.oldPath;
          if (pathId === null) continue;
          const path = store.files.pathOf(pathId);
          if (path === undefined || path === null) continue;
          const key = `${commit.id}\0${path}`;
          const existing = owner.get(key);
          if (existing !== undefined) {
            expect(
              change.file,
              `commit ${commit.id} path ${path} resolves to files ${existing} and ${change.file}`,
            ).toBe(existing);
          }
          owner.set(key, change.file);
          pairs += 1;
        }
      }
      // Guards the loop itself: zero pairs would satisfy every assertion above.
      expect(pairs).toBeGreaterThan(8);
    } finally {
      store.close();
    }
  });

  it('stitches the rename chain into one file rather than three', async () => {
    const { store } = await indexOnce();
    try {
      /* alpha → gamma → delta is one file with three aliases. Asserted by name because this is
         the property a user experiences: File Evolution showing three unrelated files instead of
         one history is the visible symptom of a broken alias chain. */
      let found: { id: FileId; paths: string[] } | null = null;
      for (let id = 1; ; id += 1) {
        const file = store.files.byId(id as FileId);
        if (file === null) break;
        const paths = file.aliases.map((a) => store.files.pathOf(a.path) ?? '');
        if (paths.includes('src/alpha.ts')) found = { id: file.id, paths };
      }
      expect(found).not.toBeNull();
      expect(found?.paths).toContain('src/gamma.ts');
      expect(found?.paths).toContain('src/delta.ts');
    } finally {
      store.close();
    }
  });

  it('merges Ada’s two addresses into one person', async () => {
    const { store } = await indexOnce();
    try {
      const adas = store.people
        .all({ includeBots: false })
        .filter((p) => p.canonicalName === 'Ada Lovelace');
      expect(adas).toHaveLength(1);
      // Both commits attributed to her, and the rule that merged them is recorded for audit.
      expect(adas[0]?.commitCount).toBeGreaterThanOrEqual(2);
      expect(adas[0]?.mergeSource).not.toBeUndefined();
    } finally {
      store.close();
    }
  });
});
