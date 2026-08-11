/**
 * Schema v2 — the derived-analysis rollups M1 produces.
 *
 * Part 8 §8.7 is explicit that these are **materialised during indexing, not aggregated per
 * request**: "this is the difference between a 16ms scrub and a 400ms one." Every table here
 * is recomputable from the ground-truth tables in `0001-init`, which is what keeps the
 * layering rule of §8.1 true — higher layers are never inputs to lower ones, so the whole
 * index stays deterministically rebuildable from `.git`.
 *
 * Still deferred, and deliberately: `hunks` and change `coupling` (M2, with the evidence
 * engine), `revert_pairs` (M2), `eras` (M5), and the bundle cache (M2). Creating empty
 * tables for them now would imply they are populated.
 */

import type { Migration } from '../index.js';

export const migration: Migration = {
  version: 2,
  name: '0002_analysis',
  up: `
-- ─── knowledge: the per-(file, person) accumulator ───────────────────────────
-- Part 8 §8.5.2 stores knowledge as *incremental state* — an accumulated value plus the
-- instant it was computed at — and applies decay lazily at read time. That is the whole
-- reason re-indexing is cheap: a new commit updates the rows it touches instead of forcing
-- a recomputation over all of history.
--
-- 'accumulated' is Σ √(lines_touched), summed at index time. The exponential decay and the
-- dilution factor are applied on read, against the query's own "now", so the same stored
-- row answers correctly at any later date without being rewritten.
CREATE TABLE knowledge (
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  accumulated REAL    NOT NULL,
  -- The most recent commit through which this person touched this file. Decay is measured
  -- from here, so it must be the *latest* contribution, not the first.
  last_at     INTEGER NOT NULL,
  last_offset INTEGER NOT NULL,
  -- Kept for the UI's "N commits" beside a name; not an input to the score.
  commits     INTEGER NOT NULL,
  PRIMARY KEY (file_id, person_id)
) WITHOUT ROWID;

CREATE INDEX knowledge_by_person ON knowledge (person_id, accumulated DESC);

-- ─── ownership: the per-file summary derived from knowledge ───────────────────
-- Denormalised on purpose. The Overview and 'excavate stats' both want "the top owner and
-- the bus factor for these fifty files" in one query, and recomputing a Shannon entropy
-- across every knowledge row per request is exactly the 400ms this table exists to avoid.
CREATE TABLE ownership (
  file_id      INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  top_person   INTEGER REFERENCES people(id),
  -- 0..1. The top owner's share of decayed knowledge in this file.
  top_share    REAL    NOT NULL,
  -- Fewest people whose combined knowledge reaches 50%.
  bus_factor   INTEGER NOT NULL,
  -- Shannon entropy of the distribution, in bits. 0 means one person holds everything.
  entropy      REAL    NOT NULL,
  -- Stored rather than derived at read time because the rule involves *both* the bus factor
  -- and the top owner's last activity anywhere in the repository, and a query that had to
  -- join back to people for every candidate file is the slow shape this table replaces.
  is_island    INTEGER NOT NULL CHECK (is_island IN (0, 1)),
  contributors INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX ownership_islands ON ownership (is_island, top_share DESC);

-- ─── hotspots ────────────────────────────────────────────────────────────────
-- churn × complexity × recency × (1 + fix_density), each factor normalised within the
-- repository (Part 8 §8.5.3). The factors are stored individually and not just the product,
-- because §8.5.3 requires a hotspot never be shown as a bare number: "always with its factor
-- breakdown and links to the commits". A score you cannot decompose is a score you cannot
-- argue with, and this table is what makes the breakdown a query rather than a recomputation.
CREATE TABLE hotspots (
  file_id      INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  score        REAL NOT NULL,
  churn        REAL NOT NULL,
  complexity   REAL NOT NULL,
  recency      REAL NOT NULL,
  fix_density  REAL NOT NULL,
  -- Raw inputs, kept so the UI can say "312 changes, 8,400 lines" alongside the factors.
  change_count INTEGER NOT NULL,
  total_churn  INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX hotspots_ranked ON hotspots (score DESC);

-- ─── analyzer bookkeeping ────────────────────────────────────────────────────
-- Part 7 §7.2.3 gives every analyzer a 'version()' and 'depends_on()' so that changing one
-- formula recomputes that analyzer and its dependents rather than the whole index. This
-- table is where the "what has already run, at which version" half of that lives; without
-- it, invalidation has nothing to compare against and every open would recompute everything.
CREATE TABLE analyzer_runs (
  analyzer_id TEXT    PRIMARY KEY,
  version     INTEGER NOT NULL,
  -- The commit the analyzer last ran against, so a fast-forward can decide whether its
  -- output is still current.
  through_oid TEXT    NOT NULL
) WITHOUT ROWID;
`,
};
