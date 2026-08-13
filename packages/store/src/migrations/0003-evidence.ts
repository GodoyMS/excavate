/**
 * Schema v3 — what the evidence engine reads.
 *
 * M2's thesis is that a useful "why does this line exist" answer can be assembled from git
 * alone, with no model and no network. Everything that makes that possible is here: the hunk
 * geometry that tells you which commits touched a *line* rather than a file, the typed links
 * that record a revert pair or a pull-request reference along with how confidently it was
 * derived, and the co-change counts that answer "what else moves when this moves".
 *
 * Three commitments carried over from `0002-analysis`, because they are what make the index
 * trustworthy rather than merely fast:
 *
 * - **Everything here is derived.** Drop all three tables and a re-index reproduces them from
 *   `.git` exactly. The layering rule of Part 8 §8.1 holds: nothing in a lower layer reads a
 *   higher one.
 * - **Materialised at index time, not per request.** Part 8 §8.7 puts the cost of this at "the
 *   difference between a 16ms scrub and a 400ms one", and M2's budget is a 250ms cold bundle —
 *   which is not reachable if assembling one means aggregating over history.
 * - **Provenance travels with the claim.** `links` carries `confidence` and `source` on every
 *   row, so a revert pair found by inverting a diff is distinguishable from one found by
 *   reading "Revert" in a subject line. Part 7's citation contract is not satisfiable by a
 *   table that has forgotten how it learned something.
 *
 * Still deferred: `eras` and `timeline_buckets` (M5), the bundle cache (M2, once bundle
 * assembly exists to cache), and embeddings (M7). Creating them now would imply they are
 * populated, which is the one thing this schema must never do.
 */

import type { Migration } from '../index.js';

export const migration: Migration = {
  version: 3,
  name: '0003_evidence',
  up: `
-- ─── hunks: the line geometry of every change ────────────────────────────────
-- One row per contiguous changed region per (commit, file). This is the table that turns
-- "who last touched this file" into "which commits touched *line 142*", and it is what makes
-- blame affordable: Part 9 §9's blame strategy uses it as a **pre-filter**, so a query about
-- one line consults only the commits whose hunks actually overlap it instead of blaming the
-- whole file and discarding the rest.
--
-- Deliberately *not* storing the diff text. Part 9's size estimate budgets 36 MB for 1.5M
-- hunks, which is 24 bytes a row — geometry only. The text is reconstructible from git on
-- demand, and storing it would multiply the index by the size of the repository's entire
-- history, breaking ADR-0003's per-commit budget by orders of magnitude.
--
-- 'old_*' is NULL for an addition and 'new_*' is NULL for a deletion, which is the honest
-- encoding: a pure insertion has no position in the old file. Zero would be a lie that reads
-- as line zero.
CREATE TABLE hunks (
  commit_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  file_id   INTEGER NOT NULL REFERENCES files(id)   ON DELETE CASCADE,
  old_start INTEGER,
  old_len   INTEGER,
  new_start INTEGER,
  new_len   INTEGER,
  -- HunkKind: 0=content 1=whitespace-only 2=moved. 'whitespace-only' is what finally lets
  -- 'format-only' be set on a commit — M1 could only approximate it from scale and uniformity
  -- because it had no view of the diff body.
  kind      INTEGER NOT NULL
);

-- (file_id, commit_id) leading, not (commit_id, file_id): every M2 read path starts from a
-- file and a line and asks which commits are relevant. The reverse order would make the
-- pre-filter a scan, which is the whole cost this index exists to remove.
CREATE INDEX hunks_by_file ON hunks (file_id, commit_id);

-- One index, not two. A second index on (file_id, new_start, new_len) would let the overlap
-- test be answered without visiting the table, and it costs more than it saves: measured on
-- 'rust-analyzer' it added roughly 0.2 KB per indexed commit against ADR-0003's 3 KB budget,
-- to accelerate a query that already only ever scans a single file's hunks. The index above
-- puts those rows adjacent, which is the part that matters.

-- ─── links: typed relations with their provenance ────────────────────────────
-- Part 9's generic link table, and the generality is earned rather than speculative: M2 alone
-- puts three genuinely different relations through it — revert pairs, re-land pairs, and
-- pull-request references — and M5's eras and M8's agent surfaces add more. Six dedicated
-- two-column tables would need six queries to answer "everything known about this commit".
--
-- 'confidence' and 'source' are the reason this is not just an edge list. Part 8 §8.5.3 gives
-- revert detection three confidence tiers, and an answer that cannot say *how* it knows is
-- exactly the uncited assertion the product treats as a bug.
CREATE TABLE links (
  from_kind  INTEGER NOT NULL,
  from_id    INTEGER NOT NULL,
  to_kind    INTEGER NOT NULL,
  to_id      INTEGER NOT NULL,
  link_kind  INTEGER NOT NULL,
  -- 0..1. Deterministic, never a model's opinion: for a revert pair it is the tier that
  -- matched — an explicit 'This reverts commit <sha>' trailer outranks an inverted diff,
  -- which outranks a subject line that merely starts with 'Revert'.
  confidence REAL    NOT NULL,
  -- How it was derived, so the UI can name it. See LINK_SOURCES in core.
  source     INTEGER NOT NULL,
  -- For a PR reference, the number; for a revert pair, NULL. Kept here rather than in a
  -- second table because '#1234' is the citation a reader actually wants to see.
  detail     TEXT,
  -- No two identical claims from the same source. A squash-merge subject that names the same
  -- PR twice must not produce two pieces of evidence that then both rank.
  PRIMARY KEY (from_kind, from_id, to_kind, to_id, link_kind, source)
) WITHOUT ROWID;

CREATE INDEX links_from ON links (from_kind, from_id, link_kind);
CREATE INDEX links_to   ON links (to_kind, to_id, link_kind);

-- ─── coupling: what changes together ─────────────────────────────────────────
-- Part 8 §8.5.4. 'file_a < file_b' is enforced rather than conventional, because a pair
-- stored in both orders would double every co-change count and halve every strength, and the
-- bug would look like a plausible number rather than an error.
--
-- Bounded by the same cutoff the noise classifier uses: past roughly thirty files in one
-- commit a human did not consider each file individually, so counting all 435 pairs of a
-- 30-file commit as evidence of coupling would drown the real signal in codemod noise.
CREATE TABLE coupling (
  file_a     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  file_b     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  co_changes INTEGER NOT NULL,
  -- Jaccard: co_changes / (changes(a) + changes(b) - co_changes). Normalised so a pair that
  -- always moves together outranks a pair that merely both change often.
  strength   REAL    NOT NULL,
  PRIMARY KEY (file_a, file_b),
  CHECK (file_a < file_b)
) WITHOUT ROWID;

CREATE INDEX coupling_by_strength ON coupling (file_a, strength DESC);
CREATE INDEX coupling_reverse     ON coupling (file_b, strength DESC);
`,
};
