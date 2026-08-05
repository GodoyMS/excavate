/**
 * Migration 0001 — schema v1.
 *
 * **Why a TypeScript module rather than `migrations/0001_init.sql`.** Part 14 §14.1
 * puts migrations in a top-level `migrations/` directory as `.sql` files, and Part 9
 * §9.10 describes them as "sequential, forward-only SQL files". Both were written
 * with a Rust build that can `include_str!` an asset. `tsc` copies no assets into
 * `dist/`, so a `.sql` file would resolve during `vitest` (which runs from source)
 * and then fail the moment the package is published or run from `dist/` — the worst
 * possible time to discover it. A TS module needs no asset pipeline, participates in
 * the project graph, and is impossible to forget to ship. The SQL stays a single
 * readable template literal so `docs/schema.md` can still be generated from it.
 *
 * **What is deliberately absent.** No `hunks` table and no derived rollups
 * (`ownership`, `coupling`, `hotspots`, `eras`, `revert_pairs`, `timeline_buckets`,
 * `first_parent_chain`) and no evidence-bundle cache. Those arrive with the code that
 * fills them: the rollups in `0002` alongside M1's analyzers, `hunks` and the bundle
 * cache in `0003` alongside M2. Creating them empty now would ship tables no query
 * reads, and would make `schema_version` claim the index contains things it does not.
 *
 * **Encoding policy.** Two representations, chosen per table rather than uniformly:
 *
 * - The bulk tables use compact integer codes — `changes.kind`, `commits.flags`,
 *   `files.flags`. `changes` is the fact table at ~5 rows per commit (Part 8 §8.2.3),
 *   so a 1-byte code instead of a 7-character string is worth the indirection. The
 *   codes live in `codec.ts` and are part of the on-disk format: values may be
 *   appended, never renumbered.
 * - The small tables keep the readable form — `people.merge_source`, `refs.kind`,
 *   and everything in `meta`. `sqlite3 index.db` being a productive debugging surface
 *   is a stated reason SQLite was chosen at all (Part 9 §9.2.1, Part 2 D2), and at a
 *   few hundred rows the space saved by a code is noise.
 *
 * **Deviations from the abbreviated DDL in Part 9 §9.4**, each because the TypeScript
 * domain model in `@excavate/core` is the contract this package must round-trip:
 *
 * - `oid` is `TEXT`, not `BLOB`. `Oid` is a branded *string*; storing a blob would
 *   mean a hex↔`Buffer` conversion on every row read and written, and would make
 *   every hand-written query in a debugging session start with `hex()`. The cost is
 *   ~20 bytes per commit — 2 MB on a 100k-commit repository, against a `commits`
 *   table already estimated at 25 MB.
 * - `files.language` is `TEXT`, not `language_id` into a `languages` table.
 *   `FileEntity.language` is a `string | null` and v1 has no language entity.
 * - `people.merge_source` rather than `identities.merge_source`: `Person.mergeSource`
 *   describes how the *person* was assembled, and `person_identities` is a pure
 *   `(name, email) → person` map whose primary key is what enforces Part 8 §8.8
 *   invariant 3 (an identity belongs to exactly one person).
 * - `commits.trailers` is a JSON array rather than a `commit_trailers` table. It
 *   preserves order for free, round-trips exactly, and stays queryable through
 *   `json_each()` when M3's evidence collectors want `Co-authored-by` and `Fixes:`.
 *   A table becomes worth its joins only once those queries are hot.
 * - Both UTC offsets are stored next to both instants (`authored_tz`,
 *   `committed_tz`), because Part 8 §8.2.1 requires the original offset be preserved:
 *   "committed at 3am local" is occasionally meaningful evidence, and it is
 *   unrecoverable once normalised to UTC.
 */

import type { Migration } from '../index.js';

export const migration: Migration = {
  version: 1,
  name: '0001_init',
  up: `
-- ─── metadata ────────────────────────────────────────────────────────────────
-- schema_version is the whole migration ledger: migrations are sequential and
-- forward-only (Part 9 §9.10), so "which ones have run" is answered by one integer
-- and a separate audit table would only be able to disagree with it.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- ─── resolved identity: people (Part 8 §8.3.1) ───────────────────────────────
CREATE TABLE people (
  id              INTEGER PRIMARY KEY,
  canonical_name  TEXT    NOT NULL,
  canonical_email TEXT    NOT NULL,
  first_seen      INTEGER NOT NULL,
  first_seen_tz   INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  last_seen_tz    INTEGER NOT NULL,
  commit_count    INTEGER NOT NULL DEFAULT 0,
  merge_source    TEXT    NOT NULL,
  is_bot          INTEGER NOT NULL DEFAULT 0
);

-- The primary key IS Part 8 §8.8 invariant 3: an identity belongs to exactly one
-- person. Merging two people rewrites person_id here and cannot orphan a pair.
CREATE TABLE person_identities (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name      TEXT    NOT NULL,
  email     TEXT    NOT NULL,
  PRIMARY KEY (name, email)
) WITHOUT ROWID;
CREATE INDEX idx_person_identities_person ON person_identities(person_id);

-- ─── ground truth: commits (Part 8 §8.2.1) ───────────────────────────────────
CREATE TABLE commits (
  id           INTEGER PRIMARY KEY,
  oid          TEXT    NOT NULL,
  tree_oid     TEXT    NOT NULL,
  author_id    INTEGER NOT NULL REFERENCES people(id),
  committer_id INTEGER NOT NULL REFERENCES people(id),
  authored_at  INTEGER NOT NULL,
  authored_tz  INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  committed_tz INTEGER NOT NULL,
  subject      TEXT    NOT NULL,
  body         TEXT,
  trailers     TEXT    NOT NULL DEFAULT '[]',
  generation   INTEGER NOT NULL,
  flags        INTEGER NOT NULL DEFAULT 0,
  significance REAL    NOT NULL DEFAULT 0
);

-- The dense id is the join key everywhere; the oid is the natural key and the only
-- thing a human or a URL ever quotes. Both need to be fast, hence the unique index
-- rather than an inline UNIQUE, which reads as an afterthought.
CREATE UNIQUE INDEX idx_commits_oid ON commits(oid);

-- Covering index for the time-window query of Part 8 §8.7 and for the keyset cursor
-- of CommitQueries.list, which pages by (committed_at DESC, id DESC). Both the range
-- scan and the tie-break are satisfied from the index alone, with no table lookup
-- until a row is actually returned.
CREATE INDEX idx_commits_time ON commits(committed_at DESC, id DESC);

-- "All changes by a person", Part 8 §8.7. The trailing committed_at is what makes
-- "this person's work in 2023" a range scan instead of a filter over their whole
-- history.
CREATE INDEX idx_commits_author ON commits(author_id, committed_at);

-- CommitQueries.mostSignificant (M1). Part 9 §9.4 specifies it in v1, and it is
-- pointless to migrate the largest table twice for one index.
CREATE INDEX idx_commits_significance ON commits(significance DESC);

-- ordinal 0 is the first parent, which is the whole basis of the default
-- first-parent projection (Part 8 §8.2.2). parent_id carries a foreign key on
-- purpose: a parent must have been walked and assigned a dense id before its child,
-- and a violation here means the walk emitted an edge to a commit it never visited.
CREATE TABLE commit_parents (
  child_id  INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  parent_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  PRIMARY KEY (child_id, ordinal)
) WITHOUT ROWID;
CREATE INDEX idx_commit_parents_parent ON commit_parents(parent_id);

-- ─── resolved identity: paths and files (Part 8 §8.3.2) ──────────────────────
-- Paths are interned because the same string recurs in millions of change rows and
-- in every alias; the unique index is also the interning lookup.
CREATE TABLE paths (
  id   INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE
);

CREATE TABLE files (
  id           INTEGER PRIMARY KEY,
  current_path INTEGER REFERENCES paths(id),
  born_commit  INTEGER NOT NULL REFERENCES commits(id),
  died_commit  INTEGER REFERENCES commits(id),
  language     TEXT,
  flags        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_files_current_path ON files(current_path);

-- One row per (file, rename event). Part 8 §8.8 invariant 2 requires the alias
-- windows of a file never to overlap in commit-time; the primary key stops two
-- aliases from starting at the same commit, which is the overlap the resolver is
-- most likely to produce by accident.
CREATE TABLE file_aliases (
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  path_id     INTEGER NOT NULL REFERENCES paths(id),
  from_commit INTEGER NOT NULL REFERENCES commits(id),
  to_commit   INTEGER REFERENCES commits(id),
  PRIMARY KEY (file_id, from_commit)
) WITHOUT ROWID;
-- Resolving a historical path to a file: FileQueries.byPath (M1).
CREATE INDEX idx_file_aliases_path ON file_aliases(path_id, from_commit);

-- ─── ground truth: the fact table (Part 8 §8.2.3) ────────────────────────────
-- WITHOUT ROWID because the primary key is the whole row's identity and a rowid
-- would be a second copy of it on the largest table in the index.
--
-- Note there is no separate index on changes(commit_id): the primary key's leading
-- column already serves "files changed in this commit" (Part 8 §8.7), and adding one
-- would duplicate the b-tree on the table we can least afford to duplicate.
CREATE TABLE changes (
  commit_id   INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind        INTEGER NOT NULL,
  old_path_id INTEGER REFERENCES paths(id),
  new_path_id INTEGER REFERENCES paths(id),
  similarity  INTEGER,
  insertions  INTEGER NOT NULL,
  deletions   INTEGER NOT NULL,
  is_binary   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (commit_id, file_id)
) WITHOUT ROWID;

-- "All changes to a file", Part 8 §8.7 — and because file_id is resolved identity
-- rather than a path, rename traversal is free at query time (Part 9 §9.6). This is
-- the index the whole identity effort in Part 8 §8.3.2 pays off through.
CREATE INDEX idx_changes_file ON changes(file_id, commit_id);

-- ─── ground truth: refs, tags, releases (Part 8 §8.2.4) ──────────────────────
-- Also the ref snapshot incremental update compares against (Part 9 §9.5); the OID
-- it needs comes from a join to commits rather than a second stored copy.
CREATE TABLE refs (
  name      TEXT    PRIMARY KEY,
  kind      TEXT    NOT NULL,
  target_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  is_head   INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX idx_refs_target ON refs(target_id);

CREATE TABLE tags (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL UNIQUE,
  target_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  tagger_id INTEGER REFERENCES people(id),
  tagged_at INTEGER,
  tagged_tz INTEGER,
  message   TEXT
);
CREATE INDEX idx_tags_target ON tags(target_id);

-- A release is inferred from a tag that parses as a version, so it cannot outlive its
-- tag — hence the cascade. prev_id is the linear chain of Part 8 §8.8 invariant 7.
CREATE TABLE releases (
  id          INTEGER PRIMARY KEY,
  tag_id      INTEGER NOT NULL UNIQUE REFERENCES tags(id) ON DELETE CASCADE,
  version     TEXT,
  released_at INTEGER NOT NULL,
  released_tz INTEGER NOT NULL,
  prev_id     INTEGER REFERENCES releases(id),
  from_commit INTEGER NOT NULL REFERENCES commits(id),
  to_commit   INTEGER NOT NULL REFERENCES commits(id)
);
CREATE INDEX idx_releases_time ON releases(released_at);

-- ─── full text (LEAN-V1 §5: FTS5 inside index.db, no Tantivy sidecar) ────────
-- External-content table: the terms are indexed here, the text stays in commits, and
-- nothing is stored twice. The alternative (a plain FTS5 table) would duplicate every
-- subject and body — the single largest text in the index — to save three triggers.
--
-- content_rowid = 'id' works because commits.id is INTEGER PRIMARY KEY and therefore
-- is the rowid; the FTS rowid and the CommitId are the same number, so search results
-- join back with no lookup table.
--
-- Part 9 §9.2.2 preferred Tantivy for camelCase-aware tokenization. That is a code
-- search argument; this index covers commit prose, where unicode61 is the right
-- tokenizer anyway. Trailers and author name are searchable through the commit list
-- filters and are deliberately not in the FTS columns yet.
CREATE VIRTUAL TABLE commits_fts USING fts5(
  subject,
  body,
  content = 'commits',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Triggers rather than a post-walk 'rebuild' command, because a search index that is
-- only correct when someone remembers to rebuild it is not correct. If the walk's
-- write throughput ever needs it, INSERT INTO commits_fts(commits_fts)
-- VALUES('rebuild') repopulates the whole index from the content table in one pass.
--
-- The delete triggers are why insertCommits never uses INSERT OR REPLACE: SQLite
-- skips DELETE triggers for rows removed by REPLACE conflict resolution unless
-- recursive_triggers is on, which would silently desynchronise the FTS index.
CREATE TRIGGER commits_fts_after_insert AFTER INSERT ON commits BEGIN
  INSERT INTO commits_fts(rowid, subject, body)
  VALUES (new.id, new.subject, new.body);
END;

CREATE TRIGGER commits_fts_after_delete AFTER DELETE ON commits BEGIN
  INSERT INTO commits_fts(commits_fts, rowid, subject, body)
  VALUES ('delete', old.id, old.subject, old.body);
END;

CREATE TRIGGER commits_fts_after_update AFTER UPDATE ON commits BEGIN
  INSERT INTO commits_fts(commits_fts, rowid, subject, body)
  VALUES ('delete', old.id, old.subject, old.body);
  INSERT INTO commits_fts(rowid, subject, body)
  VALUES (new.id, new.subject, new.body);
END;
`,
};
