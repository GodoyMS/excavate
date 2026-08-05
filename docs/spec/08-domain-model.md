# Part 8 — Domain Model

The domain model is where Excavate either becomes correct or becomes plausible. Most
of the hard problems in this project are identity problems: *is this the same file?
the same function? the same person? the same decision?*

---

## 8.1 Overview

```
                             ┌──────────┐
                             │  Person  │◀────── identities, mailmap
                             └────┬─────┘
                    authored /    │    \ reviewed
                                  │
   ┌──────┐  parents   ┌──────────▼─────────┐  contains   ┌────────────┐
   │ Ref  │───────────▶│      Commit        │────────────▶│   Change   │
   └──┬───┘            └─────┬───────┬──────┘             └──────┬─────┘
      │                      │       │                            │
      │ points to     era of │       │ referenced by       affects│
      │                      │       │                            │
   ┌──▼───┐            ┌─────▼──┐  ┌─▼────────────┐         ┌─────▼──────┐
   │ Tag  │            │  Era   │  │ PullRequest  │         │    File    │
   └──┬───┘            └────────┘  └──────┬───────┘         └─────┬──────┘
      │                                    │                       │
   ┌──▼──────┐                      ┌──────▼──────┐         ┌──────▼──────┐
   │ Release │                      │    Issue    │         │   Symbol    │
   └─────────┘                      └─────────────┘         └──────┬──────┘
                                                                    │
                       ┌────────────────────────────────────────────▼──────┐
                       │                 SymbolVersion                     │
                       └───────────────────────────────────────────────────┘

   Cross-cutting:  Evidence ─── Link ─── Decision ─── Hunk ─── Ownership
```

Entities fall into four layers:

| Layer | Entities | Source of truth |
|---|---|---|
| **Ground truth** | Commit, Change, Hunk, Ref, Tag, Blob | Git objects — immutable |
| **Resolved identity** | Person, File, Symbol, Release | Derived, algorithm-versioned |
| **Derived analysis** | Ownership, Coupling, Hotspot, Era, RevertPair | Recomputable from the above |
| **Interpretation** | Evidence, Link, Decision, Narrative | Cited; carries confidence |

Layer rule: **higher layers may never be inputs to lower layers.** No analysis reads
a narrative; no ground-truth record is amended by an interpretation. This keeps the
whole index deterministically rebuildable from `.git` plus cached forge data.

---

## 8.2 Ground truth

### 8.2.1 Commit

```rust
pub struct Commit {
    pub id: CommitId,              // u32 dense index; oid is the natural key
    pub oid: Oid,                  // 20/32-byte hash
    pub tree: Oid,
    pub parents: SmallVec<[CommitId; 2]>,
    pub author: PersonId,
    pub committer: PersonId,
    pub authored_at: Timestamp,    // UTC + original offset preserved
    pub committed_at: Timestamp,
    pub subject: String,
    pub body: Option<String>,
    pub trailers: Vec<(String, String)>,   // Co-authored-by, Change-Id, PR-URL…
    pub generation: u32,           // commit-graph generation number
    pub flags: CommitFlags,        // MERGE | ROOT | REVERT | RELAND | FORMAT_ONLY
                                   // | GENERATED_ONLY | BULK | EMPTY | SIGNED
    pub significance: f32,         // cached score, see §8.5.1
}
```

**Design notes.**

- **Dense `CommitId`** alongside the OID. A 31k-commit repo has ~5× that many change
  rows; 4-byte keys instead of 20-byte hashes is a large win in index size and join
  speed. OID→id lookup lives in one indexed table.
- **Generation numbers** are the enabling detail for the whole time dimension. With
  them, "is A an ancestor of B" is answered in near-constant time, which is what
  makes time-filtered views feasible. We reuse Git's `commit-graph` when present and
  compute our own otherwise.
- **Both timestamps are kept.** Author date is what a human means by "when"; commit
  date is what topology means. Rebased repos diverge wildly, and the UI lets the user
  choose. Original UTC offsets are preserved because "committed at 3am local" is
  occasionally meaningful evidence.
- **Trailers are parsed, not just stored.** `Co-authored-by` feeds the ownership
  model; `Change-Id`, `PR-URL`, `Reviewed-by`, and `Fixes:` feed the evidence engine.
- **Flags are computed during indexing** and are the mechanism by which noise gets
  excluded from significance ranking (Part 6 §6.3).

### 8.2.2 The history projection

The critical modeling decision most tools get wrong: **history is a DAG, not a line.**
Tools that assume linearity lie about merges; tools that expose raw topology
overwhelm.

Excavate makes the projection explicit and global:

```rust
pub enum HistoryProjection {
    FirstParent,     // mainline only — merges are single events. Default.
    Topological,     // full DAG in topo order
    AuthorDate,      // flattened by author timestamp
}
```

Every time-based query, every timeline bucket, every era boundary, and every "recent
changes" list carries the active projection. It is a user-visible setting with a
one-line explanation, and it is part of the URL state. Being explicit about this is
the kind of rigor that earns trust from people who actually understand Git.

### 8.2.3 Change and Hunk

```rust
pub struct Change {
    pub commit: CommitId,
    pub file: FileId,              // resolved identity, not a path
    pub kind: ChangeKind,          // Add | Modify | Delete | Rename | Copy | Mode
    pub old_path: Option<PathId>,
    pub new_path: Option<PathId>,
    pub similarity: Option<u8>,    // 0–100 for Rename/Copy
    pub insertions: u32,
    pub deletions: u32,
    pub is_binary: bool,
}

pub struct Hunk {
    pub commit: CommitId,
    pub file: FileId,
    pub old_start: u32, pub old_len: u32,
    pub new_start: u32, pub new_len: u32,
    pub kind: HunkKind,            // Content | WhitespaceOnly | Moved
}
```

`Change` is the fact table and the largest table in the index (~5 rows per commit).
`Hunk` is roughly 2–3× larger again, which is why hunks are a tier-1 (skippable)
artifact with a size policy: text files under a threshold, excluding generated and
vendored paths.

Hunks are what make **symbol-level attribution without re-parsing every revision**
possible (§8.3.3), so the storage cost buys a lot.

### 8.2.4 Ref, Tag, Release

```rust
pub struct Ref { pub name: String, pub kind: RefKind, pub target: CommitId, pub is_head: bool }
pub struct Tag { pub name: String, pub target: CommitId, pub tagger: Option<PersonId>,
                 pub tagged_at: Option<Timestamp>, pub message: Option<String> }
pub struct Release { pub tag: TagId, pub version: Option<SemVer>, pub released_at: Timestamp,
                     pub prev: Option<ReleaseId>, pub commit_range: (CommitId, CommitId) }
```

`Release` is inferred from tags that parse as versions. It gives the Timeline its
most useful markers and gives eras their snap points.

---

## 8.3 Resolved identity — where the real work is

### 8.3.1 Person

Identity merging is the difference between a useful ownership model and noise.

```rust
pub struct Person {
    pub id: PersonId,
    pub canonical_name: String,
    pub canonical_email: String,
    pub identities: Vec<Identity>,       // every (name,email) seen
    pub first_seen: Timestamp,
    pub last_seen: Timestamp,
    pub commit_count: u32,
    pub merge_source: MergeSource,       // Mailmap | ExactEmail | Normalized | Heuristic
}
```

**Resolution order** (earlier wins; each records its `MergeSource` so the UI can show
why two identities were merged, and the user can override):

1. **`.mailmap`** — the repository's own declaration. Always authoritative.
2. **Exact email match** (case-insensitive).
3. **Normalized email** — strip `+tag`, unify Gmail dots, map
   `NNNN+user@users.noreply.github.com` → `user@…`.
4. **Same normalized name + same email domain** — catches
   `dana@corp.com` / `d.rivera@corp.com` where the name matches.
5. **Heuristic**, gated behind a confidence threshold: high name similarity
   (Jaro-Winkler ≥ 0.92) plus a non-overlapping activity window. Merges from this
   rule are marked and reversible in the UI.

Never merged: identical names with unrelated emails and overlapping activity — that
is two people named Chen.

Bots (`*[bot]@users.noreply.github.com`, `dependabot`, `renovate`, CI accounts) are
detected and flagged `is_bot`, excluded from ownership and cast-of-characters, and
retained for commit provenance.

### 8.3.2 File — surviving renames

The hardest identity problem, and the one whose failure is most visible.

```rust
pub struct File {
    pub id: FileId,
    pub current_path: Option<PathId>,     // None if deleted at HEAD
    pub aliases: Vec<PathAlias>,          // ordered, non-overlapping
    pub born: CommitId,
    pub died: Option<CommitId>,
    pub language: Option<LanguageId>,
    pub flags: FileFlags,                 // GENERATED | VENDORED | TEST | BINARY | LFS
}

pub struct PathAlias { pub path: PathId, pub from: CommitId, pub to: Option<CommitId> }
```

**Resolution algorithm.** During the single history walk, maintaining a
`path → FileId` map at the current frontier:

1. `Add` at a path with no live `FileId` → allocate a new `FileId`.
2. `Rename(old → new)` reported by the backend → extend the existing `FileId` with a
   new alias. Similarity threshold: 50% (Git's default) with `-M`.
3. `Delete` + `Add` in the same commit with content similarity ≥ 90% and no explicit
   rename → treat as a rename. (This catches backends and workflows that lose
   rename detection.)
4. `Delete` then `Add` at the same path in a *later* commit → **resurrection**: same
   `FileId`, a new alias segment, a gap recorded. Users think of this as the same
   file; treating it as two destroys File Evolution.
5. Copies (`-C`) create a new `FileId` with a `copied_from` link — not an alias.
   Aliases must remain non-overlapping in time or every downstream query breaks.

**Merge commits** are the trap. A rename on one branch and an edit on another
produces conflicting frontier states. Resolution: process merges with respect to the
active `HistoryProjection`; under `FirstParent`, the first parent's frontier wins and
the second parent's renames are reconciled by path at the merge point. Every
reconciliation is recorded so File Evolution can show "this file's identity was
merged from two branches here."

**Invariants** (property-tested):

- Aliases of a `FileId` never overlap in commit-time.
- Every `Change` row's `(commit, path)` resolves to exactly one `FileId`.
- `born ≤` every alias `from`; `died` (if set) `≥` every alias `to`.

### 8.3.3 Symbol — lineage without reparsing everything

Parsing every version of every file is O(commits × files) tree-sitter invocations —
infeasible. The solution uses hunks as a filter.

```rust
pub struct Symbol {
    pub id: SymbolId,
    pub file: FileId,
    pub kind: SymbolKind,          // Function | Method | Class | Struct | Trait | Const…
    pub name: String,
    pub qualified_name: String,    // module::Type::method
    pub born: CommitId,
    pub died: Option<CommitId>,
    pub moved_from: Option<SymbolId>,
}

pub struct SymbolVersion {
    pub symbol: SymbolId,
    pub commit: CommitId,
    pub start_line: u32, pub end_line: u32,
    pub signature_hash: u64,       // params + return, normalized
    pub body_hash: u64,            // whitespace/comment-insensitive
}
```

**Algorithm.**

1. Parse a file **only at checkpoint revisions**: its birth, its death, every commit
   whose hunks the parser flags as structurally significant, and a periodic sample
   (every Nth revision) to bound drift.
2. Between checkpoints, attribute changes to symbols by **interval overlap**: a hunk
   at lines 40–52 intersects the symbol whose range covers those lines, with ranges
   shifted by the net line delta of preceding hunks in the same commit.
3. Symbol identity across revisions matches on `(kind, qualified_name)`, falling back
   to `(kind, name, signature_hash)` when a symbol is renamed within a file, falling
   back to `body_hash` when a symbol is moved between files (which yields
   `moved_from`).

Accuracy is ~95% on the fixture corpus and degrades gracefully: unattributable hunks
are recorded against the file only. The UI never presents symbol attribution as
certain when the checkpoint distance is large.

**Deferred to v0.3** — but the `Hunk` table that makes it cheap is built in MVP.

---

## 8.4 The evidence layer

### 8.4.1 Evidence — the citation primitive

Every claim in the product resolves to one of these.

```rust
pub struct Evidence {
    pub id: EvidenceId,            // stable within a bundle: "E1".."En"
    pub kind: EvidenceKind,
    pub locator: Locator,          // machine-resolvable pointer
    pub excerpt: String,           // human-readable, ≤ 400 chars
    pub occurred_at: Timestamp,
    pub relevance: f32,            // 0..1, from the ranker
    pub certainty: Certainty,      // Observed | Inferred | Reported
}

pub enum EvidenceKind {
    CommitMessage, DiffHunk, BlameAttribution, RevertPair, ReLand,
    PullRequestBody, ReviewComment, IssueLink, TrailerRef,
    CoChangePattern, TestAddition, DocChange, DependencyChange,
    AdjacentComment, FixFollowsFeature, RenameEvent, SignatureChange,
}

pub enum Certainty {
    Observed,   // directly in git — a revert commit exists
    Inferred,   // derived by an algorithm — SZZ says this commit induced that fix
    Reported,   // a human asserted it — a PR body claims a rationale
}
```

`Certainty` is doing real work. "A revert exists" and "our algorithm thinks this
commit caused that bug" and "a human wrote that this was for performance" are three
epistemically different things, and collapsing them is how tools become confidently
wrong. The UI renders each differently, and the confidence model weights them
differently.

### 8.4.2 Link — typed, confidence-weighted relationships

```rust
pub struct Link {
    pub from: EntityRef, pub to: EntityRef,
    pub kind: LinkKind,
    pub confidence: f32,
    pub evidence: Vec<EvidenceId>,
    pub source: LinkSource,        // Explicit | Pattern | Statistical | Model
}

pub enum LinkKind {
    Reverts, RevertedBy, RelandOf, Fixes, FixedBy, Introduces, IntroducedBy,
    Implements, References, Supersedes, CoChangesWith, DependsOn,
    MovedFrom, RenamedFrom, CopiedFrom, AuthoredBy, ReviewedBy, OwnedBy,
}
```

Links are the edges of the evidence graph, and `source` records *how* the edge was
established. A `Reverts` link with `source: Explicit` (the commit message literally
says `Revert "…"` and the diff inverts) is worth far more than one with
`source: Statistical`.

### 8.4.3 Decision — the mined ADR log

The entity that turns evidence into something browsable.

```rust
pub struct Decision {
    pub id: DecisionId,
    pub title: String,
    pub decided_at: Timestamp,
    pub summary: Option<String>,          // generated, cited
    pub status: DecisionStatus,           // Active | Superseded(DecisionId)
                                          // | Reverted | Partial
    pub scope: Vec<EntityRef>,            // what it affects
    pub evidence: Vec<EvidenceId>,
    pub participants: Vec<PersonId>,
    pub kind: DecisionKind,
}

pub enum DecisionKind {
    TechnologyAdoption,      // "adopted TypeScript"
    TechnologyRemoval,       // "dropped GraphQL"
    ArchitecturalChange,     // "extracted the billing service"
    ConventionChange,        // "switched to conventional commits"
    Reversal,                // "reverted the caching layer"
    DependencyChange,        // "replaced moment with date-fns"
    ExplicitAdr,             // an actual ADR file in the repo
}
```

**Detection candidates** (deterministic; the model only titles and summarizes):

- Dependency manifest add/remove of a significant package.
- A mass rename or mass file-type change (the TypeScript migration signature).
- A revert/re-land pair, or a revert with no re-land.
- A new top-level directory containing >N files within a short window.
- An ADR/RFC/design-doc file added under a recognized path.
- A commit whose message matches decision language *and* whose diff is
  architecturally significant (both conditions, to suppress noise).

`Decisions` is a browsable, filterable list — for many repositories it is the
architectural decision record the project never wrote. It is one of the strongest
"I need this" features in the whole product, and it costs almost nothing on top of
machinery MVP already builds.

---

## 8.5 Derived analysis

### 8.5.1 Significance

Used everywhere the product must choose which commits matter.

```
sig(c) = w₁·log(1+files)         + w₂·log(1+churn)
       + w₃·is_release           + w₄·is_revert_or_reland
       + w₅·touches_manifest     + w₆·touches_public_api
       + w₇·first_touch_of_new_toplevel_dir
       + w₈·message_quality      + w₉·path_rarity
       + w₁₀·merges_large_branch
       − p₁·format_only  − p₂·generated_only  − p₃·vendored_only
       − p₄·lockfile_only − p₅·bulk_mechanical
```

- `message_quality` = length-normalized signal: has a body, has trailers, is not in
  the top-N most repeated subjects in the repo, is not `wip|fix|update|.`.
- `path_rarity` = inverse document frequency over touched paths — a commit touching
  rarely-changed files is more interesting than one touching the churn hotspot.
- `bulk_mechanical` fires when the diff is whitespace-insensitively empty, or when
  >90% of hunks are structurally identical (a codemod).

The penalties are as important as the rewards. Without them, "the most significant
commits in this repo" reliably returns the Prettier migration, the license header
sweep, and a dependency lockfile refresh — which is exactly how these features fail
in every naive implementation.

Weights are configurable, versioned with the analyzer, and tuned against a
hand-labeled fixture set.

### 8.5.2 Ownership and knowledge

```
knowledge(person, file) = Σ_over_commits  √(lines_touched) · e^(−Δt/τ) · dilution
```

- `τ ≈ 365 days` — knowledge halves roughly annually.
- `√(lines_touched)` — sublinear, so a 2000-line codemod does not create an expert.
- `dilution` — when person B rewrites lines authored by A, A's knowledge of that file
  takes an extra decay step. You do not still understand code that someone else
  replaced.
- Co-authored-by trailers distribute credit.

Derived:

```
ownership(file)   = normalized knowledge distribution over people
bus_factor(file)  = min #people whose combined knowledge ≥ 50%
entropy(file)     = Shannon entropy of the ownership distribution
knowledge_island  = bus_factor == 1 AND top_owner.last_seen > 6 months ago
```

**Stored as incremental state.** Each `(file, person)` row stores an accumulated
value and the timestamp it was computed at; decay is applied lazily at read time.
This is what makes incremental re-indexing cheap — no full recomputation on every
new commit.

### 8.5.3 Coupling, hotspots, reverts, SZZ

**Change coupling.** For each commit, all pairs of co-changed files increment a
sparse counter, windowed (default: 12 months, exponentially weighted). Coupling
strength = `co_changes(a,b) / min(changes(a), changes(b))`, reported only above a
support threshold to suppress coincidence. Commits touching more than ~30 files are
excluded — they are codemods and would couple everything to everything.

**Hotspot.**
`hotspot(f) = churn_norm(f) × complexity_norm(f) × recency_weight(f) × (1 + fix_density(f))`
where each factor is normalized within the repository, and `fix_density` is the
fraction of that file's commits classified as fixes. Never shown as a bare number —
always with its factor breakdown and links to the commits.

**Revert / re-land detection**, in confidence order:

1. Explicit: subject matches `Revert "…"` and the diff is the inverse of the named
   commit → `Observed`.
2. Diff-inverse: a commit whose diff exactly inverts an earlier commit's diff →
   `Observed`.
3. Message-based: revert language plus a substantial overlap of touched files →
   `Inferred`.

Re-land: a later commit whose diff substantially matches the reverted content. The
revert → re-land pair is the single highest-value evidence type in the entire
product, because it is literally the repository recording "we tried this, it was
wrong, we fixed it and tried again."

**SZZ-lite** (v0.2). Identify fix commits (closes-issue trailers, revert pairs, fix
keywords + small diff). For each line a fix modifies, blame it to its introducing
commit, filtered by: the introducing commit must precede the fix; format-only and
whitespace changes are skipped; a decay penalty is applied for large time gaps. The
output is `FixFollowsFeature` evidence with `Certainty::Inferred` — and it is always
presented as an inference, never as fact.

### 8.5.4 Era

```rust
pub struct Era {
    pub id: EraId,
    pub start: Timestamp, pub end: Timestamp,
    pub start_commit: CommitId, pub end_commit: CommitId,
    pub name: Option<String>,              // generated
    pub summary: Option<String>,           // generated, cited
    pub boundary_reason: BoundaryReason,   // why the detector split here
    pub key_commits: Vec<CommitId>,
    pub key_people: Vec<PersonId>,
    pub releases: Vec<ReleaseId>,
    pub decisions: Vec<DecisionId>,
    pub metrics: EraMetrics,
}
```

`boundary_reason` is user-visible ("boundary snapped to v3.0.0 release; detected via
a 4σ shift in language mix"). Eras that cannot explain themselves are not
trustworthy. Algorithm in [Part 10 §10.4.2](10-ai-architecture.md).

---

## 8.6 Events and state transitions

### 8.6.1 Indexing state machine

```
     Uninitialized
          │ excavate .
          ▼
    ┌─ Discovering ──▶ Walking(T0) ──▶ Analyzing(T1) ──▶ Enriching(T2) ──▶ Ready
    │                      │                │                 │              │
    │                      └────────────────┴─────────────────┘              │
    │                                  (any tier can fail →)                 │
    │                                                                        │
    └──────────────── Failed ◀───────────────────────────────────────────────┘
                                                                             │
                          Stale ◀─── refs changed ───────────────────────────┘
                            │
                            ├─ fast-forward ──▶ IncrementalWalk ──▶ Ready
                            └─ rewritten ─────▶ TargetedRebuild ──▶ Ready
```

Each tier transition emits an event; the UI unlocks capability progressively (the
Map appears when T1 lands; semantic search appears when T2 lands). The user is never
blocked on a tier they are not currently using.

### 8.6.2 Decision status transitions

```
   detected ──▶ Active ──┬──▶ Superseded(by)   (a later decision replaces it)
                         ├──▶ Reverted         (a revert with no re-land)
                         └──▶ Partial          (applied to some scope only)
```

Recomputed on each index update; each transition carries the evidence that caused it.

### 8.6.3 AI job lifecycle

```
   Requested ──▶ Estimating ──▶ AwaitingApproval ──▶ Running ──▶ Validating ──▶ Cached
        │              │                │               │            │
        │              │                └── Declined    │            └──▶ Rejected
        │              └── OverBudget                   └── Failed         (uncited)
        └── CacheHit ──────────────────────────────────────────────────▶ Cached
```

`AwaitingApproval` is skipped when the estimate is under the auto-approve threshold
(default $0.05) or when a local provider is in use. `Rejected` on failed citation
validation falls back to structured evidence and logs an eval sample.

---

## 8.7 Indexes

The queries the UI actually issues, and the index each requires.

| Query | Index |
|---|---|
| Commits in a time window under projection P | `(projection, committed_at)` covering |
| Ancestry test | Generation numbers, in memory |
| All changes to a file | `change(file_id, commit_id)` |
| All changes by a person | `commit(author_id, committed_at)` |
| Files changed in a commit | `change(commit_id)` |
| Blame for a range | On-demand, LRU-cached by `(file, commit, range)` |
| Top hotspots | Precomputed rollup, sorted |
| Ownership of a file | `ownership(file_id)` with lazy decay |
| Co-change partners | `coupling(file_a)` sparse, top-K materialized |
| Timeline buckets | Precomputed per granularity (day/week/month) |
| Full-text | Tantivy sidecar |
| Vector | usearch sidecar |
| Symbol history | `symbol_version(symbol_id, commit_id)` |
| Evidence for a target | Assembled at query time; bundle cached by hash |

**Precomputed rollups.** Timeline buckets, hotspot rankings, ownership snapshots, and
language composition series are materialized during indexing rather than aggregated
per request. This is the difference between a 16ms scrub and a 400ms one.

---

## 8.8 Invariants

Property-tested against the fixture corpus (Part 13 §13.8). Violations are P0 bugs.

**Identity**
1. Every `(commit, path)` maps to exactly one `FileId`.
2. A `FileId`'s aliases never overlap in commit-time.
3. Every `Person` has ≥1 identity; identities belong to exactly one `Person`.
4. Merging two people is reversible without data loss.

**Temporal**
5. `parent.generation < child.generation` for every edge.
6. Era boundaries partition history: contiguous, non-overlapping, complete.
7. `Release.prev` forms a linear chain per release track.
8. No event references a commit outside its declared range.

**Evidence**
9. Every `EvidenceId` in generated prose exists in the bundle that produced it.
10. Every `Link` has ≥1 supporting `Evidence`.
11. `Certainty::Observed` evidence must be re-derivable from Git alone.
12. Bundle hashes are stable across runs given identical inputs.

**Determinism**
13. Indexing the same repository twice produces byte-identical derived tables (modulo
    timestamps in the metadata table).
14. Era boundaries are stable across re-index.
15. Significance ranking is stable across re-index.

Invariant 13 is the strongest single guard against subtle correctness bugs, and it is
worth the effort it takes to maintain.

---

*Next: [Part 9 — Data Architecture](09-data-architecture.md)*
