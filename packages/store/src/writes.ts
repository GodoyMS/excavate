/**
 * Bulk writers.
 *
 * **Every statement is prepared once, at open, and reused for every row of every
 * batch.** Preparing per row is the classic mistake here and costs roughly an order of
 * magnitude: `prepare()` runs SQLite's parser, planner and code generator, while `run()`
 * resets an already-compiled program. On a 50k-commit repository with ~250k change rows
 * that is the difference between seconds and minutes, and it is the whole reason the
 * `Transaction` interface takes batches rather than single entities (LEAN-V1 §5.1).
 *
 * The methods here do no interpretation whatsoever: dense ids, rename resolution and
 * identity merging all happen in `@wise-excavate/index`, which owns those decisions. This
 * file's only job is to move already-decided rows into SQLite as fast as SQLite will
 * take them.
 */

import type {
  AnalyzerId,
  Change,
  Commit,
  FileEntity,
  Hunk,
  IndexState,
  PathId,
  Person,
  Ref,
  Tag,
  CommitId,
} from '@wise-excavate/core';
import { pathId } from '@wise-excavate/core';
import type BetterSqlite3 from 'better-sqlite3';

import type { HotspotWrite, KnowledgeWrite, OwnershipWrite } from './analysis.js';
import {
  bit,
  changeBind,
  commitBind,
  encodeHunkKind,
  fileBind,
  personBind,
} from './codec.js';
import type { Transaction } from './index.js';
import { INDEX_STATE_KEY, REPO_ID_KEY, SCHEMA_VERSION_KEY } from './meta.js';

/** `meta` keys this package writes itself, and the thing that writes each one. */
const RESERVED_META_KEYS: Readonly<Record<string, string>> = {
  [SCHEMA_VERSION_KEY]: 'migrate()',
  [REPO_ID_KEY]: 'openStore()',
  [INDEX_STATE_KEY]: 'Transaction.setIndexState',
};

export function createTransactionApi(db: BetterSqlite3.Database): Transaction {
  const insertCommit = db.prepare<{
    id: number;
    oid: string;
    treeOid: string;
    authorId: number;
    committerId: number;
    authoredAt: number;
    authoredTz: number;
    committedAt: number;
    committedTz: number;
    subject: string;
    body: string | null;
    trailers: string;
    generation: number;
    flags: number;
    significance: number;
  }>(
    // A plain INSERT, never INSERT OR REPLACE: SQLite skips DELETE triggers for rows
    // displaced by REPLACE conflict resolution, which would leave the FTS index holding
    // the old subject and body forever. A duplicate oid means the walk assigned two
    // dense ids to one commit, which is a bug worth failing on rather than papering
    // over — and re-indexing is a rebuild, not an upsert (Part 9 §9.10).
    `INSERT INTO commits (
       id, oid, tree_oid, author_id, committer_id, authored_at, authored_tz,
       committed_at, committed_tz, subject, body, trailers, generation, flags,
       significance
     ) VALUES (
       @id, @oid, @treeOid, @authorId, @committerId, @authoredAt, @authoredTz,
       @committedAt, @committedTz, @subject, @body, @trailers, @generation, @flags,
       @significance
     )`,
  );

  const insertParent = db.prepare<[number, number, number]>(
    'INSERT INTO commit_parents (child_id, parent_id, ordinal) VALUES (?, ?, ?)',
  );

  const insertChange = db.prepare<{
    commitId: number;
    fileId: number;
    kind: number;
    oldPathId: number | null;
    newPathId: number | null;
    similarity: number | null;
    insertions: number;
    deletions: number;
    isBinary: number;
  }>(
    `INSERT INTO changes (
       commit_id, file_id, kind, old_path_id, new_path_id, similarity,
       insertions, deletions, is_binary
     ) VALUES (
       @commitId, @fileId, @kind, @oldPathId, @newPathId, @similarity,
       @insertions, @deletions, @isBinary
     )`,
  );

  /**
   * No `WITHOUT ROWID` on `hunks`, so this is a plain insert with no conflict clause.
   *
   * A file can have many hunks in one commit and there is no natural key to collide on — the
   * same `(commit, file, oldStart)` is genuinely possible for a rename that both moved and
   * edited. Deduplication would therefore be *wrong* here, not merely unnecessary: it would
   * silently drop real geometry. Re-running the hunk pass over a commit that already has rows
   * is prevented upstream by `analyzer_runs`, not by the schema.
   */
  const insertHunk = db.prepare<{
    commitId: number;
    fileId: number;
    oldStart: number | null;
    oldLen: number | null;
    newStart: number | null;
    newLen: number | null;
    kind: number;
  }>(
    `INSERT INTO hunks (commit_id, file_id, old_start, old_len, new_start, new_len, kind)
     VALUES (@commitId, @fileId, @oldStart, @oldLen, @newStart, @newLen, @kind)`,
  );

  // Upserted rather than inserted because a person's aggregate fields keep moving for
  // the whole walk: every commit can widen the activity window and raise the count.
  const upsertPerson = db.prepare<{
    id: number;
    canonicalName: string;
    canonicalEmail: string;
    firstSeen: number;
    firstSeenTz: number;
    lastSeen: number;
    lastSeenTz: number;
    commitCount: number;
    mergeSource: string;
    isBot: number;
  }>(
    `INSERT INTO people (
       id, canonical_name, canonical_email, first_seen, first_seen_tz,
       last_seen, last_seen_tz, commit_count, merge_source, is_bot
     ) VALUES (
       @id, @canonicalName, @canonicalEmail, @firstSeen, @firstSeenTz,
       @lastSeen, @lastSeenTz, @commitCount, @mergeSource, @isBot
     )
     ON CONFLICT(id) DO UPDATE SET
       canonical_name  = excluded.canonical_name,
       canonical_email = excluded.canonical_email,
       first_seen      = excluded.first_seen,
       first_seen_tz   = excluded.first_seen_tz,
       last_seen       = excluded.last_seen,
       last_seen_tz    = excluded.last_seen_tz,
       commit_count    = excluded.commit_count,
       merge_source    = excluded.merge_source,
       is_bot          = excluded.is_bot`,
  );

  // Reassignment on conflict is what makes merging two people a write rather than a
  // migration: the (name, email) pair moves to the surviving person and the primary key
  // keeps Part 8 §8.8 invariant 3 true throughout.
  const upsertIdentity = db.prepare<[number, string, string]>(
    `INSERT INTO person_identities (person_id, name, email) VALUES (?, ?, ?)
     ON CONFLICT(name, email) DO UPDATE SET person_id = excluded.person_id`,
  );

  // born_commit is deliberately absent from the UPDATE clause. A file's birth is
  // immutable ground truth; if the resolver ever wants to change it, it has decided
  // this is a different file, and a different file needs a different FileId.
  const upsertFile = db.prepare<{
    id: number;
    currentPath: number | null;
    bornCommit: number;
    diedCommit: number | null;
    language: string | null;
    flags: number;
  }>(
    `INSERT INTO files (id, current_path, born_commit, died_commit, language, flags)
     VALUES (@id, @currentPath, @bornCommit, @diedCommit, @language, @flags)
     ON CONFLICT(id) DO UPDATE SET
       current_path = excluded.current_path,
       died_commit  = excluded.died_commit,
       language     = excluded.language,
       flags        = excluded.flags`,
  );

  const deleteAliasesOf = db.prepare<[number]>(
    'DELETE FROM file_aliases WHERE file_id = ?',
  );
  const insertAlias = db.prepare<[number, number, number, number | null]>(
    `INSERT INTO file_aliases (file_id, path_id, from_commit, to_commit)
     VALUES (?, ?, ?, ?)`,
  );

  const selectPathId = db
    .prepare<[string], number>('SELECT id FROM paths WHERE path = ?')
    .pluck();
  const insertPath = db.prepare<[string]>('INSERT INTO paths (path) VALUES (?)');

  const deleteRefs = db.prepare<[]>('DELETE FROM refs');
  const insertRef = db.prepare<[string, string, number, number]>(
    'INSERT INTO refs (name, kind, target_id, is_head) VALUES (?, ?, ?, ?)',
  );

  const deleteTags = db.prepare<[]>('DELETE FROM tags');
  const insertTag = db.prepare<{
    id: number;
    name: string;
    targetId: number;
    taggerId: number | null;
    taggedAt: number | null;
    taggedTz: number | null;
    message: string | null;
  }>(
    `INSERT INTO tags (id, name, target_id, tagger_id, tagged_at, tagged_tz, message)
     VALUES (@id, @name, @targetId, @taggerId, @taggedAt, @taggedTz, @message)`,
  );

  const deleteAllKnowledge = db.prepare('DELETE FROM knowledge');
  const insertKnowledge = db.prepare(
    `INSERT INTO knowledge (file_id, person_id, accumulated, last_at, last_offset, commits)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deleteAllOwnership = db.prepare('DELETE FROM ownership');
  const insertOwnership = db.prepare(
    `INSERT INTO ownership
       (file_id, top_person, top_share, bus_factor, entropy, is_island, contributors)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteAllHotspots = db.prepare('DELETE FROM hotspots');
  const insertHotspot = db.prepare(
    `INSERT INTO hotspots
       (file_id, score, churn, complexity, recency, fix_density, change_count, total_churn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateSignificance = db.prepare(
    'UPDATE commits SET significance = ? WHERE id = ?',
  );
  const upsertAnalyzerRun = db.prepare(
    `INSERT INTO analyzer_runs (analyzer_id, version, through_oid) VALUES (?, ?, ?)
     ON CONFLICT(analyzer_id) DO UPDATE SET version = excluded.version,
                                            through_oid = excluded.through_oid`,
  );

  const upsertMeta = db.prepare<[string, string]>(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  /**
   * The `Transaction` handed to a callback is a long-lived object, so nothing stops a
   * caller from stashing it and writing through it later. That write would succeed —
   * SQLite would autocommit it — and the caller would believe it had transaction
   * semantics it does not have. Part 7 §7.7 promises that a failed index leaves the
   * previous one valid and usable, which is only true if every write really is inside a
   * transaction, so the cheap check earns its place. It costs one property read per
   * *batch*, not per row.
   *
   * A `TypeError` rather than an `ExcavateError`: this is API misuse by a caller in this
   * repository, not a condition the daemon should map to an error code and show a user.
   */
  function assertInTransaction(method: string): void {
    if (!db.inTransaction) {
      throw new TypeError(
        `Transaction.${method} was called outside store.transaction(); the write would ` +
          `have been autocommitted with no way to roll it back`,
      );
    }
  }

  return {
    insertCommits(rows: readonly Commit[]): void {
      assertInTransaction('insertCommits');
      for (const commit of rows) {
        insertCommit.run(commitBind(commit));
        // ordinal 0 is the first parent, which the default projection follows.
        for (const [ordinal, parent] of commit.parents.entries()) {
          insertParent.run(commit.id, parent, ordinal);
        }
      }
    },

    insertChanges(rows: readonly Change[]): void {
      assertInTransaction('insertChanges');
      for (const change of rows) insertChange.run(changeBind(change));
    },

    insertHunks(rows: readonly Hunk[]): void {
      assertInTransaction('insertHunks');
      for (const hunk of rows) {
        /* NULL, not 0, for the side that does not exist. A pure insertion has no position in
           the old file, and storing zero would make it look like line zero — which every
           overlap query would then treat as a real position. The schema allows NULL precisely
           so this distinction survives. */
        insertHunk.run({
          commitId: hunk.commit,
          fileId: hunk.file,
          oldStart: hunk.oldLen === 0 ? null : hunk.oldStart,
          oldLen: hunk.oldLen === 0 ? null : hunk.oldLen,
          newStart: hunk.newLen === 0 ? null : hunk.newStart,
          newLen: hunk.newLen === 0 ? null : hunk.newLen,
          kind: encodeHunkKind(hunk.kind),
        });
      }
    },

    upsertPeople(rows: readonly Person[]): void {
      assertInTransaction('upsertPeople');
      for (const person of rows) {
        upsertPerson.run(personBind(person));
        for (const identity of person.identities) {
          upsertIdentity.run(person.id, identity.name, identity.email);
        }
      }
    },

    upsertFiles(rows: readonly FileEntity[]): void {
      assertInTransaction('upsertFiles');
      for (const file of rows) {
        upsertFile.run(fileBind(file));
        // Aliases are rewritten wholesale rather than merged. The rename resolver owns
        // the complete alias chain for a file and hands over its current view of it;
        // merging row by row is how two overlapping windows appear and break Part 8
        // §8.8 invariant 2.
        deleteAliasesOf.run(file.id);
        for (const alias of file.aliases) {
          insertAlias.run(file.id, alias.path, alias.from, alias.to);
        }
      }
    },

    /**
     * Returns ids positionally aligned with `paths`, including for duplicates inside one
     * call — callers zip the result against their own array, so a deduplicated or
     * reordered result would silently attach changes to the wrong files.
     *
     * A SELECT-then-INSERT rather than `INSERT … ON CONFLICT DO UPDATE … RETURNING id`,
     * because interning is overwhelmingly read-hit: the walk sees the same few thousand
     * paths across hundreds of thousands of change rows, and the upsert form would
     * perform a pointless write on every one of those hits.
     */
    internPaths(paths: readonly string[]): readonly PathId[] {
      assertInTransaction('internPaths');
      const ids: PathId[] = [];
      for (const path of paths) {
        const existing = selectPathId.get(path);
        if (existing !== undefined) {
          ids.push(pathId(existing));
          continue;
        }
        // Inserted immediately, so a repeat later in this same array is a read hit and
        // gets the same id rather than a duplicate row.
        ids.push(pathId(Number(insertPath.run(path).lastInsertRowid)));
      }
      return ids;
    },

    /** Refs are a snapshot, not a history: the whole set is replaced (Part 9 §9.5). */
    replaceRefs(rows: readonly Ref[]): void {
      assertInTransaction('replaceRefs');
      deleteRefs.run();
      for (const ref of rows) {
        insertRef.run(ref.name, ref.kind, ref.target, bit(ref.isHead));
      }
    },

    /**
     * Also a snapshot. Note the consequence of `releases.tag_id … ON DELETE CASCADE`:
     * replacing the tag set drops the releases derived from it, which is correct — a
     * release whose tag no longer exists is not a release — but means release rows are
     * rewritten after tags, never before.
     */
    replaceTags(rows: readonly Tag[]): void {
      assertInTransaction('replaceTags');
      deleteTags.run();
      for (const tag of rows) {
        insertTag.run({
          id: tag.id,
          name: tag.name,
          targetId: tag.target,
          taggerId: tag.tagger,
          taggedAt: tag.taggedAt === null ? null : tag.taggedAt.epochSeconds,
          taggedTz: tag.taggedAt === null ? null : tag.taggedAt.offsetMinutes,
          message: tag.message,
        });
      }
    },

    /* ── Analysis rollups (schema v2) ─────────────────────────────────────── */

    replaceKnowledge(rows: readonly KnowledgeWrite[]): void {
      assertInTransaction('replaceKnowledge');
      /* Replace rather than merge, and wholesale rather than per row. An analyzer owns its
         entire output: a merge would leave rows for a (file, person) pair that the current
         run no longer produces — a contributor whose knowledge has decayed to nothing, or a
         file that a corrected rename resolution merged into another. Those stale rows would
         inflate every bus factor they appear in, silently. */
      deleteAllKnowledge.run();
      for (const row of rows) {
        insertKnowledge.run(
          row.file,
          row.person,
          row.accumulated,
          row.lastAt.epochSeconds,
          row.lastAt.offsetMinutes,
          row.commits,
        );
      }
    },

    replaceOwnership(rows: readonly OwnershipWrite[]): void {
      assertInTransaction('replaceOwnership');
      deleteAllOwnership.run();
      for (const row of rows) {
        insertOwnership.run(
          row.file,
          row.topPerson,
          row.topShare,
          row.busFactor,
          row.entropy,
          row.isIsland ? 1 : 0,
          row.contributors,
        );
      }
    },

    replaceHotspots(rows: readonly HotspotWrite[]): void {
      assertInTransaction('replaceHotspots');
      deleteAllHotspots.run();
      for (const row of rows) {
        insertHotspot.run(
          row.file,
          row.score,
          row.churn,
          row.complexity,
          row.recency,
          row.fixDensity,
          row.changeCount,
          row.totalChurn,
        );
      }
    },

    setSignificance(
      rows: readonly { readonly commit: CommitId; readonly score: number }[],
    ): void {
      assertInTransaction('setSignificance');
      for (const row of rows) updateSignificance.run(row.score, row.commit);
    },

    recordAnalyzerRun(analyzer: AnalyzerId, version: number, throughOid: string): void {
      assertInTransaction('recordAnalyzerRun');
      upsertAnalyzerRun.run(analyzer, version, throughOid);
    },

    setIndexState(state: IndexState): void {
      assertInTransaction('setIndexState');
      upsertMeta.run(INDEX_STATE_KEY, state);
    },

    /**
     * The general escape hatch of Part 9 §9.5 — `analyzer_versions`, the ref snapshot, and
     * whatever else the incremental-update decision needs, absorbed without a migration
     * each time.
     *
     * Which is why the three keys this package owns are refused. `schema_version` is the
     * entire migration ledger and `repo_id` is the only proof an index belongs to the
     * repository being asked about; a caller that writes either one by accident produces a
     * database that opens fine today and is unreadable, or answers questions about the
     * wrong repository, tomorrow. Neither failure points back at the write that caused it,
     * and both are silent. `index_state` is refused because `setIndexState` exists and
     * takes the typed union instead of an arbitrary string.
     */
    setMeta(key: string, value: string): void {
      assertInTransaction('setMeta');
      const owner = RESERVED_META_KEYS[key];
      if (owner !== undefined) {
        throw new TypeError(
          `Transaction.setMeta cannot write the reserved key ${JSON.stringify(key)}: ` +
            `it is owned by @wise-excavate/store and is written by ${owner}`,
        );
      }
      upsertMeta.run(key, value);
    },
  };
}
