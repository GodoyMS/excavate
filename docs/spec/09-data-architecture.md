# Part 9 — Data Architecture

## 9.1 Storage topology

An index is a directory. Nothing is scattered, nothing lives in a global registry,
and deleting the directory is a complete uninstall.

```
~/.cache/excavate/<repo-id>/
├── meta.json              # schema + analyzer versions, repo path, ref snapshot
├── index.db               # SQLite — system of record (WAL mode)
├── index.db-wal
├── search/                # Tantivy full-text index
│   └── …
├── vectors/
│   ├── embeddings.bin     # raw f32 vectors, memory-mapped
│   └── hnsw.usearch       # ANN index (rebuildable from embeddings.bin)
├── layout/
│   └── treemap-head.bin   # cached Persistent Layout positions
├── forge/                 # cached PR/issue JSON, keyed by etag
├── ai/
│   └── responses.db       # SQLite — cached generations keyed by bundle hash
└── models/                # downloaded ONNX embedding model (shared via symlink)
```

**`<repo-id>` = `hash(root_commit_oid || canonical_path)`.** Root commit means a repo
moved on disk keeps its index; path means two worktrees of the same project do not
collide.

**Location policy.**

| Mode | Location | When |
|---|---|---|
| Default | XDG cache (`~/.cache/excavate/`, `~/Library/Caches/` on macOS) | Always, unless overridden. Never pollutes the repo. |
| Explicit | `--index-dir <path>` | CI, custom setups |
| In-repo | `.excavate/` | Opt-in via config, for teams who want to commit it |
| Pack | a single `.excavate-pack` file | Sharing (§9.9) |

---

## 9.2 Why this storage stack

The evaluation, because these are the decisions most likely to be second-guessed.

### 9.2.1 SQLite as the system of record

| Option | Verdict |
|---|---|
| **SQLite** | **Chosen.** Universal, embedded, transactional, zero-config, and — decisively — *inspectable*. `sqlite3 index.db` is a productive debugging and plugin-authoring surface (Part 2, D2). Recursive CTEs handle our graph queries at this scale. Ubiquitous tooling. |
| DuckDB | Genuinely better for the analytical rollups. Rejected for v1: +~30MB binary, a second engine to keep in sync, and precomputed rollups make its advantage mostly moot. Revisit if rollup computation becomes the bottleneck. |
| RocksDB / redb | Faster raw KV writes, but we would hand-build every index, every query, and every debugging tool. Wrong trade for a project whose novelty budget belongs elsewhere. |
| Postgres | Not embeddable. Immediately violates the one-command install. |
| Custom columnar format | The most fun and the least wise. |

**Write configuration.** Bulk load is the performance-critical path:

```sql
PRAGMA journal_mode = WAL;        -- concurrent readers during indexing
PRAGMA synchronous = NORMAL;      -- durable enough for a rebuildable cache
PRAGMA cache_size = -262144;      -- 256 MB page cache
PRAGMA mmap_size = 1073741824;    -- 1 GB memory-mapped read
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;         -- OFF during bulk load, verified after
```

Indexes on the large tables (`change`, `hunk`) are **created after** bulk insert, not
before. On a 100k-commit repository this is roughly a 3× difference in total index
time — inserting into a b-tree row by row is the single most common way to make a
bulk load slow.

### 9.2.2 Tantivy for full-text

SQLite FTS5 would work and would remove a dependency. Tantivy wins on the things that
matter here: code-aware tokenization (camelCase, snake_case, and symbol splitting),
faceting for the structural filters, phrase queries, and BM25 scoring that is
substantially better on identifier-heavy text. It is also fast enough that ⌘K's 50ms
budget is comfortable rather than tight.

Two separate Tantivy indexes: **commits** (subject, body, trailers, author) and
**code** (file content at `HEAD`, plus historical content for deleted files).

### 9.2.3 usearch for vectors

| Option | Verdict |
|---|---|
| **usearch** | **Chosen.** Small, fast HNSW, good Rust bindings, memory-mappable, supports quantization. |
| sqlite-vec | Attractive for keeping everything in one file, but brute-force search degrades past ~100k vectors and most real repos exceed that. |
| LanceDB | Excellent, but a much larger dependency for a feature we can serve with a 2MB library. |
| Flat brute force | Fine up to ~20k vectors; not enough. |

**Vectors are stored twice on purpose:** raw f32 in `embeddings.bin` (the source of
truth, memory-mapped) and in the HNSW index (a derived artifact). If the ANN index is
corrupted or the algorithm changes, it rebuilds in seconds from the raw file without
re-embedding anything. Re-embedding is the expensive operation; never make it a
recovery path.

---

## 9.3 The indexing pipeline

### 9.3.1 Tiers

```
T0  METADATA          seconds        UI becomes usable
    Commit graph, generation numbers, people + identity merge,
    refs/tags/releases, path interning, per-commit numstat.

T1  STRUCTURE         tens of seconds    full analytical UI
    Hunks, rename resolution, file identity, language detection,
    noise classification, ownership, coupling, hotspots,
    revert pairs, eras, significance, timeline rollups, layout cache.

T2  SEMANTIC          background      search + symbols
    Tree-sitter symbol extraction at checkpoints, import graph,
    embeddings, Tantivy indexes, usearch build.

T3  INTERPRETIVE      on demand       prose
    Era narratives, Why syntheses, decision summaries. Cached forever
    by bundle hash.
```

Each tier writes a completion marker. The UI subscribes to tier events and unlocks
capability progressively rather than blocking on a monolithic "indexing…" state.

### 9.3.2 The single walk

```
  git history (reverse topological, generation-ordered)
              │
       ┌──────▼───────┐
       │  Walk driver │  streaming, bounded channel, backpressure
       └──────┬───────┘
              │  RawCommit + RawChange[]
     ┌────────┼─────────┬──────────┬────────────┬──────────────┐
     ▼        ▼         ▼          ▼            ▼              ▼
  Commit   Person    Rename     Hunk        Coupling       Noise
   sink     sink    resolver    sink       accumulator   classifier
     │        │         │          │            │              │
     └────────┴─────────┴──────────┴────────────┴──────────────┘
                            │
                  batched writes (10k rows/tx)
                            ▼
                        SQLite
```

**Ordering constraint.** Rename resolution requires processing commits in a
consistent topological order, because it maintains a path→FileId frontier. Merges
are handled per the active projection (Part 8 §8.3.2). Sinks that do not depend on
order (noise classification, coupling accumulation) run on a rayon pool fed from the
same stream.

**Memory bound.** The walk is streaming: bounded channels, batched flushes, and a
frontier map that is O(files at HEAD) rather than O(history). Peak RSS is dominated
by the frontier and the write batch, not by history length — which is what makes a
1.3M-commit repository feasible on a laptop.

### 9.3.3 Throughput budget

Measured on an 8-core reference machine, warm OS page cache:

| Stage | Target | Dominant cost |
|---|---|---|
| Commit walk (T0) | ≥ 40k commits/min | Object decompression |
| Diff + numstat (T1) | ≥ 20k commits/min | Tree diffing |
| Hunk extraction (T1) | ≥ 12k commits/min | Diff hunk parsing |
| Analysis (T1) | ≥ 100k commits/min | Pure computation |
| Symbol extraction (T2) | ≥ 2k files/min | tree-sitter parsing |
| Embeddings (T2) | ≥ 500 chunks/s | ONNX inference |

Asserted in CI against tiered corpora, with a 10% regression tolerance.

### 9.3.4 Large-repository policy

Above configurable thresholds, Excavate degrades **visibly**:

| Threshold | Degradation |
|---|---|
| > 200k commits | Hunks stored only for commits in the last N years (default 5) + all commits touching top-1000 files by churn |
| > 50k files at HEAD | Symbol extraction limited to non-vendored, non-generated files |
| > 2 GB `.git` | Embeddings limited to files under a size cap; a sampled subset for the rest |
| Any degradation | A **"Partial index"** badge, with an expandable list of exactly what was skipped and a "index everything anyway" button |

Part 2's honesty principle applies at the data layer too: silent truncation reads as
full coverage and is therefore a lie. `log()`-style disclosure of what was dropped is
mandatory.

---

## 9.4 Schema

Abbreviated; full DDL is generated into `docs/schema.md` from migrations.

```sql
-- ─── ground truth ────────────────────────────────────────────────────────
CREATE TABLE commits (
  id            INTEGER PRIMARY KEY,     -- dense
  oid           BLOB NOT NULL UNIQUE,
  tree_oid      BLOB NOT NULL,
  author_id     INTEGER NOT NULL REFERENCES people(id),
  committer_id  INTEGER NOT NULL REFERENCES people(id),
  authored_at   INTEGER NOT NULL,        -- unix seconds, UTC
  authored_tz   INTEGER NOT NULL,        -- offset minutes
  committed_at  INTEGER NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT,
  generation    INTEGER NOT NULL,
  flags         INTEGER NOT NULL,
  significance  REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_commits_time   ON commits(committed_at);
CREATE INDEX idx_commits_author ON commits(author_id, committed_at);
CREATE INDEX idx_commits_sig    ON commits(significance DESC);

CREATE TABLE commit_parents (
  child_id  INTEGER NOT NULL REFERENCES commits(id),
  parent_id INTEGER NOT NULL REFERENCES commits(id),
  ordinal   INTEGER NOT NULL,            -- 0 = first parent
  PRIMARY KEY (child_id, ordinal)
);
CREATE INDEX idx_parents_rev ON commit_parents(parent_id);

CREATE TABLE paths (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);

CREATE TABLE files (
  id           INTEGER PRIMARY KEY,
  current_path INTEGER REFERENCES paths(id),
  born_commit  INTEGER NOT NULL REFERENCES commits(id),
  died_commit  INTEGER REFERENCES commits(id),
  language_id  INTEGER REFERENCES languages(id),
  flags        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE file_aliases (
  file_id     INTEGER NOT NULL REFERENCES files(id),
  path_id     INTEGER NOT NULL REFERENCES paths(id),
  from_commit INTEGER NOT NULL REFERENCES commits(id),
  to_commit   INTEGER REFERENCES commits(id),
  PRIMARY KEY (file_id, from_commit)
);
CREATE INDEX idx_alias_path ON file_aliases(path_id, from_commit);

CREATE TABLE changes (                    -- the fact table
  commit_id   INTEGER NOT NULL REFERENCES commits(id),
  file_id     INTEGER NOT NULL REFERENCES files(id),
  kind        INTEGER NOT NULL,
  old_path_id INTEGER REFERENCES paths(id),
  new_path_id INTEGER REFERENCES paths(id),
  similarity  INTEGER,
  insertions  INTEGER NOT NULL,
  deletions   INTEGER NOT NULL,
  PRIMARY KEY (commit_id, file_id)
) WITHOUT ROWID;
CREATE INDEX idx_changes_file ON changes(file_id, commit_id);

CREATE TABLE hunks (
  commit_id INTEGER NOT NULL, file_id INTEGER NOT NULL,
  old_start INTEGER, old_len INTEGER, new_start INTEGER, new_len INTEGER,
  kind      INTEGER NOT NULL
);
CREATE INDEX idx_hunks ON hunks(file_id, commit_id);

-- ─── identity ────────────────────────────────────────────────────────────
CREATE TABLE people (
  id INTEGER PRIMARY KEY, canonical_name TEXT NOT NULL,
  canonical_email TEXT NOT NULL, first_seen INTEGER, last_seen INTEGER,
  commit_count INTEGER NOT NULL DEFAULT 0, is_bot INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE identities (
  person_id INTEGER NOT NULL REFERENCES people(id),
  name TEXT NOT NULL, email TEXT NOT NULL, merge_source INTEGER NOT NULL,
  PRIMARY KEY (name, email)
);

-- ─── derived analysis ────────────────────────────────────────────────────
CREATE TABLE ownership (
  file_id INTEGER NOT NULL, person_id INTEGER NOT NULL,
  knowledge REAL NOT NULL,          -- accumulated, undecayed
  as_of     INTEGER NOT NULL,       -- decay applied lazily from here
  PRIMARY KEY (file_id, person_id)
) WITHOUT ROWID;

CREATE TABLE coupling (
  file_a INTEGER NOT NULL, file_b INTEGER NOT NULL,  -- a < b
  co_changes INTEGER NOT NULL, strength REAL NOT NULL,
  PRIMARY KEY (file_a, file_b)
) WITHOUT ROWID;

CREATE TABLE hotspots (
  file_id INTEGER PRIMARY KEY, score REAL NOT NULL,
  churn REAL, complexity REAL, recency REAL, fix_density REAL
);

CREATE TABLE eras (
  id INTEGER PRIMARY KEY, start_at INTEGER, end_at INTEGER,
  start_commit INTEGER, end_commit INTEGER,
  boundary_reason TEXT, name TEXT, summary TEXT, metrics_json TEXT
);

CREATE TABLE links (
  from_kind INTEGER, from_id INTEGER, to_kind INTEGER, to_id INTEGER,
  link_kind INTEGER NOT NULL, confidence REAL NOT NULL, source INTEGER NOT NULL
);
CREATE INDEX idx_links_from ON links(from_kind, from_id, link_kind);
CREATE INDEX idx_links_to   ON links(to_kind, to_id, link_kind);

-- ─── rollups (materialized for interaction latency) ──────────────────────
CREATE TABLE timeline_buckets (
  granularity INTEGER NOT NULL,     -- 0=day 1=week 2=month
  bucket      INTEGER NOT NULL,
  subsystem   INTEGER NOT NULL,
  commits INTEGER, insertions INTEGER, deletions INTEGER,
  authors INTEGER, reverts INTEGER,
  PRIMARY KEY (granularity, bucket, subsystem)
) WITHOUT ROWID;

-- ─── metadata ────────────────────────────────────────────────────────────
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE analyzer_versions (analyzer_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE indexed_refs (ref_name TEXT PRIMARY KEY, oid BLOB NOT NULL);
```

**Size estimate**, 100k commits / 10k files / 500k changes / 1.5M hunks:

| Table | Rows | Approx |
|---|---:|---:|
| commits | 100k | 25 MB |
| changes | 500k | 20 MB |
| hunks | 1.5M | 36 MB |
| coupling | ~200k | 6 MB |
| others + indexes | — | ~40 MB |
| **SQLite total** | | **~130 MB** |
| Tantivy | | ~60 MB |
| Vectors (30k × 384 f32) | | ~46 MB |
| **Total** | | **~240 MB** |

Against a typical `.git` of 800MB–3GB for such a repo, that comfortably meets the
"< 5% of `.git`" budget with vectors excluded, and ~10–25% with them. The budget is
therefore stated separately for the core index and for optional artifacts.

---

## 9.5 Incremental update

The path that makes reopening a repo feel instant.

```
On open:
  1. Read indexed_refs. Compare to current refs.
  2. Classify:
       identical              → serve immediately
       fast-forward only      → incremental walk
       tip unreachable        → history was rewritten
       schema/analyzer bumped → targeted or full rebuild
```

**Fast-forward.** `git rev-list <old-tips>..<new-tips> --all` gives exactly the new
commits. The rename frontier is reconstructed from `file_aliases` at the old tip
(cheap: one indexed query), the walk proceeds, and affected rollups are updated
incrementally.

**History rewritten** (rebase, force push, amended commits). Detected when a stored
tip is no longer reachable. Rather than a full rebuild:

1. Find the merge-base of the old and new tips.
2. Delete all derived rows for commits after the merge-base on the abandoned side.
3. Walk forward from the merge-base on the new side.
4. Recompute rollups for the affected time window only.

**Version bumps.** `analyzer_versions` gives per-analyzer granularity. Changing the
hotspot formula recomputes hotspots and its dependents; it does not touch the commit
walk. A `schema_version` bump runs migrations; an incompatible one triggers a full
rebuild with an explicit prompt.

**Lazy decay.** Ownership is stored undecayed with an `as_of` timestamp; decay is a
read-time multiplication. This means adding 50 commits does not require rewriting the
ownership table.

**Live watching (v0.2).** An optional filesystem watcher on `.git/refs` and
`.git/HEAD` triggers a background incremental update and emits `index.invalidated`.
Debounced, cancellable, and off by default in CI.

---

## 9.6 Query patterns

### Time-filtered queries

The most common pattern, and the one that must not be slow:

```sql
-- commits in a window, first-parent projection
SELECT c.* FROM commits c
JOIN first_parent_chain fp ON fp.commit_id = c.id
WHERE c.committed_at BETWEEN ?start AND ?end
ORDER BY c.committed_at DESC LIMIT ?n;
```

`first_parent_chain` is materialized at index time — walking parent edges at query
time is the naive version and is 10–100× slower.

### Ancestry

Not SQL. Generation numbers live in a memory-mapped array; `is_ancestor(a, b)` is a
bounded walk with generation-based pruning, sub-microsecond in practice.

### File history through renames

```sql
WITH alias AS (SELECT path_id, from_commit, to_commit
               FROM file_aliases WHERE file_id = ?f)
SELECT c.*, ch.* FROM changes ch
JOIN commits c ON c.id = ch.commit_id
WHERE ch.file_id = ?f
ORDER BY c.committed_at DESC;
```

Because `changes.file_id` is resolved identity rather than a path, rename traversal
is free at query time. All the cost was paid once, during indexing. This is the
central pay-off of the identity work in Part 8.

### Blame

Never precomputed for all files (O(files × lines × history) — infeasible). Computed
on demand and LRU-cached by `(file_id, commit_id, line_range)`, with the cache keyed
so that a scroll through a file reuses most of its work. The `hunks` table provides a
cheap pre-filter: only commits with a hunk overlapping the requested range can
possibly contribute.

---

## 9.7 Caching

Five layers, each with an explicit invalidation key. Cache bugs are the most common
source of "why is it showing me stale data," so each key is written down.

| Layer | Contents | Key | Invalidated by |
|---|---|---|---|
| **L1 in-process** | Hot query results, blame, layout | LRU by query hash | Index update event |
| **L2 rollups** | Timeline buckets, hotspots, ownership | Table rows | Analyzer version bump; affected commit range |
| **L3 derived files** | Layout positions, HNSW index | File on disk | Content hash of inputs |
| **L4 AI responses** | Generated prose | `hash(template_version, model_id, effort, bundle_hash)` | Template edit or bundle change only — *never* by time |
| **L5 forge** | PR/issue JSON | ETag / `updated_at` | HTTP conditional request |

**L4 is the important one.** Because the key includes the evidence bundle hash and
excludes wall-clock time, an era narrative generated six months ago is still valid
today if the underlying evidence has not changed. New commits change the bundle for
the *current* era and leave historical eras untouched. That is what makes running
Excavate repeatedly on an active repository nearly free.

---

## 9.8 Concurrency

- **Writers:** exactly one. The indexer holds an exclusive write lock; a lockfile
  with the daemon PID prevents two processes indexing the same repo.
- **Readers:** many, concurrent with the writer, via WAL.
- **Parallelism inside indexing:** rayon for order-independent stages (noise
  classification, coupling accumulation, symbol extraction, embedding). The
  order-dependent stage (rename resolution) is single-threaded by necessity.
- **Cancellation:** every stage checks a cancellation token at batch boundaries;
  cancelling closes the transaction cleanly and leaves the prior index intact.
- **Two Excavate windows on one repo:** the second detects the lock and attaches to
  the running daemon rather than starting its own.

---

## 9.9 Portable index packs

`excavate export --out repo.excavate-pack` produces a single compressed file
containing the SQLite database, the search index, optional vectors, and cached AI
artifacts, plus a manifest:

```json
{
  "format_version": 1,
  "repo": { "root_commit": "…", "name": "…", "head": "…" },
  "generated": { "at": "2026-08-04T…Z", "excavate_version": "0.2.1",
                 "schema_version": 7, "analyzer_versions": {…} },
  "contents": ["index", "search", "vectors", "ai"],
  "ai_manifest": { "model": "claude-opus-5", "templates": {…} }
}
```

`excavate open repo.excavate-pack` loads it read-only. Three uses, each with real
value:

1. **OSS maintainers publish one per release.** A contributor gets the full
   experience — Story, Map, Why — with no indexing wait and no API key. This is the
   growth loop from Part 1.
2. **CI builds it once**, and the whole team downloads instead of each person paying
   the indexing cost and the AI cost.
3. **Support and bug reports.** "Send me your pack" makes issues reproducible.

**Privacy note, prominently placed in the CLI output:** a pack contains commit
messages, author names and emails, and file paths. It does not contain source code
blobs. `--redact-emails` and `--exclude ai` are provided, and the export command
prints exactly what is being included before writing.

---

## 9.10 Migrations

- Sequential, forward-only SQL files: `migrations/0007_add_decisions.sql`.
- `schema_version` in `meta`; the daemon refuses to open a newer schema than it
  understands (with a clear "upgrade Excavate" message rather than a corruption
  error).
- **Analyzer versions are independent of schema version.** Recomputing hotspots does
  not require a schema migration, and a schema migration does not force
  recomputation of unrelated analysis.
- **Rebuild is always an acceptable fallback**, because the index is a derived cache
  and `.git` is the source of truth. This is a large simplification we should lean
  on: complicated data migrations are not worth writing for a cache. The rule is
  "migrate when it is cheap, rebuild when it is not," and the user is told which is
  happening and how long it will take.

---

*Next: [Part 10 — AI Architecture](10-ai-architecture.md)*
