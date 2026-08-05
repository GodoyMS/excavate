# Part 7 — Product Architecture

## 7.1 The shape of the system

Excavate is a **local daemon with pluggable front ends**. That single decision
determines almost everything else in this document.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                            PRESENTATION                                   │
│                                                                           │
│   Tauri shell        excavate serve      excavate CLI      excavate mcp   │
│   (native window)    (browser UI)        (stdout)          (agent tools)  │
│         └──────────────────┴──────────────┴──────────────────┘            │
│                            same typed API                                 │
└─────────────────────────────────┬─────────────────────────────────────────┘
                                  │  HTTP + WebSocket, localhost, token-auth
                                  │  JSON control plane · binary bulk plane
┌─────────────────────────────────▼─────────────────────────────────────────┐
│                        excavated — the daemon                             │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  API layer:  routes · streaming · auth · type generation            │  │
│  ├─────────────────────────────────────────────────────────────────────┤  │
│  │  Orchestration:  job scheduler · progress bus · cancellation ·      │  │
│  │                  budget enforcement · repo session lifecycle        │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐   │
│  │  GIT     │→ │ INDEXING │→ │ ANALYSIS │→ │ EVIDENCE │→ │     AI     │   │
│  │  ENGINE  │  │ PIPELINE │  │  ENGINE  │  │  ENGINE  │  │  PIPELINES │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └────────────┘   │
│       │             │             │              │              │         │
│  ┌────▼─────┐  ┌────▼─────┐  ┌────▼──────┐  ┌────▼─────┐  ┌─────▼──────┐  │
│  │ LANGUAGE │  │  STORE   │  │  SEARCH   │  │  FORGE   │  │  PROVIDER  │  │
│  │ SERVICES │  │ (SQLite) │  │ (Tantivy  │  │CONNECTORS│  │  REGISTRY  │  │
│  │(tree-sit)│  │          │  │ + usearch)│  │          │  │            │  │
│  └──────────┘  └──────────┘  └───────────┘  └──────────┘  └────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  PLUGIN HOST (WASM component model) — analyzers, lenses, exporters  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

### Why a daemon and not a monolithic desktop app

The alternative — putting all logic behind Tauri IPC commands — is simpler on day
one and wrong on day thirty.

| Property | Daemon | Tauri-only |
|---|---|---|
| Browser UI (`serve`) | Free | Requires a second transport |
| Headless / CI use | Free | Impossible |
| CLI and MCP surfaces | Free | Reimplementation |
| Remote / codespace use | Free (SSH tunnel) | Impossible |
| Linux WebView fallback | Free | None |
| UI dev loop | Vite against a running daemon; no Rust rebuild | Full rebuild |
| Editor extensions later | Same API | New API |
| Cost | One HTTP layer, ~500 LOC | — |

The daemon costs one HTTP layer and buys four product surfaces and the entire Linux
risk mitigation. It is the highest-leverage architectural decision in the project.

---

## 7.2 Subsystems

Each subsystem below lists its **responsibility**, its **explicit non-goals**, its
**interface**, and its **crate**.

### 7.2.1 Git Engine — `excavate-git`

**Responsibility.** All reading of Git object data. Commit graph traversal, tree
diffing, rename detection, blame, ref and tag enumeration, `.mailmap` parsing,
`.git-blame-ignore-revs` parsing, packfile access.

**Non-goals.** Never writes to the repository. Never interprets meaning. Never
touches the database.

**Interface.**

```rust
pub trait GitBackend: Send + Sync {
    fn head(&self) -> Result<CommitOid>;
    fn refs(&self) -> Result<Vec<Ref>>;
    fn walk(&self, spec: &WalkSpec) -> Result<impl Iterator<Item = RawCommit>>;
    fn diff(&self, a: Option<CommitOid>, b: CommitOid, opts: &DiffOpts)
        -> Result<Vec<RawChange>>;
    fn blame(&self, path: &Path, at: CommitOid, range: LineRange, opts: &BlameOpts)
        -> Result<Vec<BlameHunk>>;
    fn read_blob(&self, oid: BlobOid) -> Result<Bytes>;
    fn tree_at(&self, commit: CommitOid) -> Result<TreeSnapshot>;
    fn capabilities(&self) -> BackendCapabilities;
}
```

**Implementations.** `GixBackend` (gitoxide, default) and `CliBackend` (shells out to
`git`). The trait exists because gitoxide and the `git` CLI have genuinely different
strengths: gitoxide is much faster for pack traversal and parallel walks; the CLI has
20 years of hardening on rename detection heuristics, LFS, and blame corner cases. A
`HybridBackend` composes them per-operation based on `capabilities()`.

This is one of only six speculative-looking abstractions in the system, and it is
justified by concrete, known divergence rather than by principle (Part 2, D3).

### 7.2.2 Indexing Pipeline — `excavate-index`

**Responsibility.** Turn raw Git data into stored facts, once, efficiently.
Orchestrates the single streaming history walk, path interning, rename resolution,
identity merging, tier scheduling, batching, and incremental update detection
(including force-push / rebase invalidation).

**Non-goals.** No interpretation, no scoring, no AI.

**Key property.** **One pass over history.** Every consumer that needs the walk
registers a `WalkSink`; the pipeline fans the stream out to all of them. Re-reading
history is the single largest avoidable cost on a big repo, so the architecture
makes it structurally hard to do twice.

```rust
pub trait WalkSink: Send {
    fn on_commit(&mut self, c: &RawCommit, ctx: &WalkCtx) -> Result<()>;
    fn on_change(&mut self, c: &RawCommit, ch: &RawChange) -> Result<()>;
    fn finish(&mut self, tx: &mut Transaction) -> Result<()>;
}
```

### 7.2.3 Analysis Engine — `excavate-analysis`

**Responsibility.** Every derived, deterministic fact: significance scoring,
ownership decay, bus factor, knowledge islands, co-change coupling, hotspots, era
segmentation, revert/re-land detection, SZZ-lite, refactor and pure-move detection,
noise classification (generated / vendored / format-only).

**Non-goals.** No Git I/O (reads from the store), no AI, no presentation.

**Interface.** Analyzers are independently versioned and independently
invalidatable:

```rust
pub trait Analyzer {
    fn id(&self) -> AnalyzerId;
    fn version(&self) -> u32;          // bump ⇒ this analyzer's outputs recompute
    fn depends_on(&self) -> &[AnalyzerId];
    fn run(&self, ctx: &AnalysisCtx) -> Result<AnalysisOutput>;
}
```

The `version()` + `depends_on()` pair gives fine-grained cache invalidation: changing
the hotspot formula recomputes hotspots and its dependents, not the whole index.

### 7.2.4 Evidence Engine — `excavate-evidence`

**Responsibility.** The heart of the product. Given a **target** (line range, file,
symbol, directory, dependency, decision), assemble a ranked, budget-fitted
`EvidenceBundle`.

**Non-goals.** It does not generate prose and it does not call a model. It produces
the input that prose generation consumes — and, critically, it produces a *complete,
useful answer on its own* for the no-key path.

```rust
pub trait EvidenceCollector {
    fn id(&self) -> CollectorId;
    fn applies_to(&self, t: &Target) -> bool;
    fn collect(&self, t: &Target, ctx: &EvidenceCtx) -> Result<Vec<Evidence>>;
}

pub struct EvidenceBundle {
    pub target: Target,
    pub items: Vec<Evidence>,      // ranked, stable ids E1..En
    pub confidence: Confidence,    // with enumerated reasons
    pub gaps: Vec<Gap>,            // "no PR data" — drives honest messaging + upsell
    pub hash: BundleHash,          // caching + reproducibility key
}
```

Collectors in MVP: `BlameCollector`, `CommitContextCollector`, `RevertPairCollector`,
`PrReferenceCollector`, `TemporalNeighborCollector`, `CoChangeCollector`,
`AdjacentCommentCollector`, `TestSiblingCollector`. v0.2 adds `ForgeCollector` and
`SzzCollector`.

**Why this is its own subsystem.** It is the only component that both the
deterministic UI path and the AI path depend on. Making it a shared, testable,
cacheable unit is what keeps the no-key experience genuinely good rather than a
degraded stub.

### 7.2.5 Language Services — `excavate-lang`

**Responsibility.** tree-sitter parsing, symbol extraction, import/dependency
extraction, comment extraction, complexity proxies, language detection.

**Interface — the community contribution surface.** A language pack is declarative:

```toml
# packs/rust.toml
name = "rust"
extensions = ["rs"]
grammar = "tree-sitter-rust"

[queries]
symbols = "queries/rust/symbols.scm"
imports = "queries/rust/imports.scm"
comments = "queries/rust/comments.scm"

[heuristics]
generated_markers = ["@generated", "Code generated by"]
vendored_paths = ["vendor/", "target/"]
test_paths = ["tests/", "**/*_test.rs"]
```

No Rust required. Per Part 2 (D6), this is the single most important extensibility
decision in the project, because language packs are the contribution people
volunteer for.

### 7.2.6 Search — `excavate-search`

**Responsibility.** Lexical (Tantivy BM25), vector (usearch HNSW), and hybrid fusion;
plus structural filters (path, author, time, language) applied as pre-filters.

**Interface.**

```rust
pub struct SearchQuery {
    pub text: String,
    pub mode: SearchMode,          // Lexical | Semantic | Hybrid
    pub filters: Filters,          // path / author / time / lang / entity kind
    pub limit: usize,
}
```

Fusion is Reciprocal Rank Fusion over the two result lists. An optional local
cross-encoder rerank ships in v0.3.

### 7.2.7 AI Pipelines — `excavate-ai`

**Responsibility.** Provider abstraction, prompt templates and versioning, the seven
pipelines, response caching, budget accounting, cost estimation, citation validation,
the eval harness.

**Non-goals.** No retrieval (Evidence Engine does that), no scoring, no UI state.

Detailed entirely in [Part 10](10-ai-architecture.md).

### 7.2.8 Forge Connectors — `excavate-forge`

**Responsibility.** Fetch and cache PR/MR bodies, review threads, issues, and their
links, from GitHub / GitLab / Gerrit. Handle auth, rate limits, pagination,
incremental sync, and graceful absence.

```rust
pub trait ForgeConnector {
    fn detect(remote: &RemoteUrl) -> Option<Self> where Self: Sized;
    fn fetch_prs(&self, since: Option<Timestamp>) -> BoxStream<Result<PullRequest>>;
    fn fetch_issues(&self, ids: &[IssueRef]) -> BoxStream<Result<Issue>>;
    fn rate_limit(&self) -> RateLimitState;
}
```

**Design rule: always optional.** Every feature must produce a useful result with no
forge configured. The connector improves confidence; it never gates a code path.

### 7.2.9 Store — `excavate-store`

**Responsibility.** Schema, migrations, transactions, batched writes, typed queries,
the derived-rollup tables, and the sidecar index files.

**Non-goals.** No business logic. Queries live here, decisions do not.

### 7.2.10 Layout — `excavate-layout`

**Responsibility.** Squarified treemap, force-directed graph, Sugiyama DAG layering,
alluvial ribbon geometry, timeline bucketing.

**Special property.** Compiled twice: as a native crate for the daemon (one-shot
expensive layouts) and to **WASM** for the browser (interactive 60fps layouts in a
worker). Same code, same results, no drift.

### 7.2.11 Plugin Host — `excavate-plugin`

**Responsibility.** Load and sandbox WASM components implementing the analyzer, lens,
and exporter interfaces. Capability-scoped: a plugin declares what it reads and gets
nothing else.

Ships in v1.0; the interface boundaries are designed in MVP so they are not
retrofitted.

### 7.2.12 Presentation

- **`apps/web`** — the React application. Talks only to the API. Contains no Git
  knowledge.
- **`apps/desktop`** — Tauri v2 shell. Spawns/supervises the daemon, owns the native
  window, menus, deep-link protocol registration, and auto-update. ~600 lines,
  deliberately.
- **`excavate-cli`** — argument parsing, daemon lifecycle, and the terminal
  subcommands (`index`, `why`, `serve`, `export`, `mcp`, `doc`).

---

## 7.3 Boundaries and the rules that protect them

Five rules, enforced in review and (where possible) by a dependency lint in CI.

| # | Rule | Prevents |
|---|---|---|
| B1 | **Only `excavate-git` touches the repository.** | Scattered, unbounded Git I/O; untestable code |
| B2 | **Only `excavate-store` writes SQL.** | Schema knowledge leaking into every crate |
| B3 | **AI never retrieves.** All model input comes from an `EvidenceBundle`. | Hallucinated grounding; unreproducible answers |
| B4 | **The UI computes nothing analytical.** It renders API responses. | Divergence between CLI, MCP, and GUI answers |
| B5 | **Every feature has a no-AI path.** | Silent dependence on a paid provider |

B3 and B5 are the two that make Excavate what it is. If either erodes, the product
becomes a repo-chat tool with extra steps.

---

## 7.4 Communication

### 7.4.1 Transport

- **Control plane:** JSON over HTTP/1.1 on `127.0.0.1:<random port>`, with a
  per-session bearer token generated at daemon start and handed to the UI out of
  band (Tauri: injected; `serve`: printed in the launch URL).
- **Streaming plane:** WebSocket for progress events, job status, streamed AI
  tokens, and index invalidation notices.
- **Bulk plane:** binary framing (`postcard` for typed structs, Arrow IPC for
  columnar series) for layout position arrays, timeline buckets, and embedding
  vectors. JSON for a 200k-element float array is a measurable UI stall; binary is
  not.

### 7.4.2 Security posture

Non-negotiable, because a localhost daemon holding a full index of proprietary code
is an attractive target:

- Bind `127.0.0.1` only. Never `0.0.0.0`, not even behind a flag — remote use goes
  through SSH tunnelling.
- Random port, random 256-bit session token, required on every request including
  WebSocket upgrade.
- Strict CORS allowlist; `Origin` validated on upgrade to block DNS-rebinding.
- No `eval`, strict CSP in the web app.
- Provider API keys stored in the OS keychain (Keychain / Credential Manager /
  Secret Service), never in the index, never in config files, never logged.
- Plugin WASM has no ambient filesystem or network capability.

### 7.4.3 Type safety across the boundary

Rust types are the single source of truth. `specta` derives are attached to every API
type in `excavate-proto`; a build step emits `packages/api/src/generated.ts`. CI
fails if the generated file is stale. There is no hand-written TypeScript mirror of a
Rust type anywhere in the repo.

### 7.4.4 Event model

The WebSocket carries a small, versioned event union:

```ts
type ServerEvent =
  | { type: "index.progress"; tier: Tier; done: number; total: number; note?: string }
  | { type: "index.tier_complete"; tier: Tier }
  | { type: "index.invalidated"; reason: "refs_changed" | "history_rewritten" }
  | { type: "job.started" | "job.progress" | "job.done" | "job.failed"; job: JobRef; ... }
  | { type: "ai.token"; job: JobRef; text: string }
  | { type: "ai.budget"; spentUsd: number; remainingUsd: number | null }
  | { type: "log"; level: LogLevel; message: string };
```

The UI treats every event as advisory: it may miss events (reconnect) and must
reconcile by re-querying. Progress is never the source of truth for state.

---

## 7.5 Repository session lifecycle

A **repo session** is the daemon's unit of work.

```
        excavate .
             │
     ┌───────▼────────┐
     │  Resolve repo  │  canonical path + root-commit-hash → stable RepoId
     └───────┬────────┘
             │
     ┌───────▼─────────────────┐
     │  Locate / create index  │  XDG cache, or --index-dir, or .excavate/
     └───────┬─────────────────┘
             │
     ┌───────▼──────────────┐        ┌──────────────────────┐
     │  Schema migration?   │──yes──▶│ Migrate or rebuild   │
     └───────┬──────────────┘        └──────────────────────┘
             │ no
     ┌───────▼──────────────┐
     │  Compare stored refs │
     │  with current refs   │
     └───┬──────────┬───────┘
   same  │          │ diverged
 ┌───────▼──┐  ┌────▼─────────────────────────────┐
 │ Serve    │  │ Incremental walk of new commits  │
 │ instantly│  │ (or targeted rebuild if history  │
 └──────────┘  │  was rewritten)                  │
               └──────────────────────────────────┘
```

`RepoId` is `hash(root_commit_oid + canonical_path)`. Using the root commit means a
repo moved on disk reuses its index; including the path means two worktrees of the
same project do not collide.

---

## 7.6 Extensibility surfaces

Six extension points, in expected-contribution-volume order:

| Surface | Mechanism | Ships |
|---|---|---|
| **Language packs** | Declarative TOML + tree-sitter `.scm` queries | v0.3 |
| **Lenses** | A scoring fn `(FileId, TimeWindow) -> f32` + a color scale | v1.0 (internal from MVP) |
| **Analyzers** | WASM component implementing `Analyzer` | v1.0 |
| **Forge connectors** | Rust trait impl (in-tree) | v0.2 GitHub, LATER others |
| **AI providers** | Rust trait impl (in-tree) or an OpenAI-compatible base URL | MVP |
| **UI panels** | Sandboxed iframe + typed `postMessage` | LATER |

**Deliberate choice: WASM over dynamic libraries.** A plugin registry that executes
native code against a local index of proprietary source is a supply-chain incident
waiting to happen. WASM components with declared capabilities are slower and worth
it. It also makes plugins cross-platform and cross-language for free.

---

## 7.7 Failure and degradation model

The architecture assumes partial failure everywhere and defines the degraded state
for each case. No failure produces a broken UI.

| Failure | Behaviour |
|---|---|
| Repo too large for full hunk indexing | Index metadata fully, hunks for a recency/size-bounded subset. Show a **"Partial index"** badge with exactly what was skipped. Never silent. |
| A language pack is missing | Files are still tracked, sized, blamed, and searched lexically. Symbols and imports are absent for those files. |
| Provider unreachable / no key | Structured evidence replaces prose everywhere. A single unobtrusive banner explains. |
| Provider returns an uncitable answer | Discard prose, show the evidence, log an eval failure. |
| Budget exceeded mid-run | Job halts cleanly, partial artifacts are kept and marked incomplete, user is told what remains. |
| Forge rate-limited | Serve from cache, show staleness, schedule a retry with backoff. |
| Index corrupted | Detect via integrity check on open, offer a one-click rebuild. |
| Daemon dies | Tauri shell restarts it and the UI reconnects; in-flight jobs are marked interrupted and are resumable. |
| History rewritten (force push) | Detect via unreachable stored tip, invalidate affected ranges, re-walk only those. |
| Disk full during index | Transaction rolls back, prior index remains valid and usable. |

---

## 7.8 Where the complexity actually is

An honest map of engineering difficulty, so effort lands in the right places:

| Component | Difficulty | Why |
|---|---|---|
| Rename & symbol lineage | ★★★★★ | Correctness is subtle, failure is silent, and everything depends on it |
| Evidence ranking | ★★★★★ | Judgment encoded as a scoring function; needs eval-driven tuning |
| Persistent-layout renderer | ★★★★☆ | 60fps at 100k elements with picking, LOD, and stable animation |
| Era segmentation | ★★★★☆ | Statistical tuning that must feel right, not just be correct |
| Incremental indexing | ★★★★☆ | Rebase and force-push invalidation is where naive designs break |
| Citation validation | ★★★☆☆ | Straightforward parsing, subtle policy around partial grounding |
| Store & schema | ★★☆☆☆ | Deliberately boring (Part 2, D1) |
| API & transport | ★★☆☆☆ | Deliberately boring |
| Tauri shell | ★☆☆☆☆ | Deliberately tiny |

---

*Next: [Part 8 — Domain Model](08-domain-model.md)*
