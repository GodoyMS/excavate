# Part 13 — Technical Architecture

Every load-bearing technology choice, with the alternatives that were considered, the
reason for the decision, the cost we are accepting, and what it would take to
reverse. Decisions are summarized in [Appendix A](A-decision-register.md).

---

## 13.1 Core language: Rust

**Chosen:** Rust for the entire backend — CLI, daemon, Git engine, indexing,
analysis, AI orchestration, layout.

### Alternatives

| Option | Case for | Why not |
|---|---|---|
| **Go** | Fast compiles, easy concurrency, large contributor pool, trivial cross-compilation | `go-git` is slow and incomplete for our access patterns (we would shell out constantly); tree-sitter and ONNX bindings are second-class; GC pauses during a 100k-commit walk are avoidable |
| **TypeScript / Node** | Isomorphic with the UI, biggest contributor pool, fastest iteration | Cannot hit the performance budgets. A history walk over 1M commits in JS is minutes, not seconds. Native Git bindings are a build-tooling liability. Memory ceiling for the frontier + write batches is real. |
| **C++** | Maximum performance, mature libgit2 | Build complexity, memory safety in a tool parsing untrusted repo data, and a contributor experience that would halve our PR volume |
| **Zig** | Excellent performance, simple builds | Ecosystem too thin for git/search/ONNX; pre-1.0 churn |
| **Rust** | **Chosen** | See below |

### Reasoning

The decisive factor is the ecosystem alignment: gitoxide, tantivy, usearch,
tree-sitter bindings, `ort` (ONNX Runtime), rayon, and rusqlite are all mature,
first-class, and pure-Rust or thin-FFI. No other language has that specific
combination available without significant glue work.

Beyond that: memory control matters when the working set is a rename frontier plus
batched writes over a million-commit history; fearless parallelism matters because
the indexing pipeline is embarrassingly parallel in most stages; and a single static
binary with no runtime is what makes `curl | sh` installation and the one-command
promise honest.

### Costs accepted

- **Smaller contributor pool** than Go or TypeScript. Mitigated by keeping the
  highest-volume contribution path (language packs) declarative and Rust-free
  (Part 2, D6), and by publishing a TypeScript SDK for UI plugin authors.
- **Slower iteration** on backend changes. Mitigated by the daemon architecture: UI
  work does not require a Rust rebuild, and `cargo watch` plus a modest crate graph
  keeps incremental builds under 10s.
- **Compile times** for the full workspace. Mitigated with `sccache` in CI, thin LTO
  only in release, and `mold`/`lld` for local linking.

### Reversal cost

Total rewrite. This is a permanent decision.

---

## 13.2 Git access: gitoxide primary, `git` CLI fallback

**Chosen:** a `GitBackend` trait (Part 7 §7.2.1) with `GixBackend` as default and
`CliBackend` for operations where the CLI is more robust.

### Alternatives

| Option | Strengths | Weaknesses |
|---|---|---|
| **git2-rs (libgit2)** | Mature, complete, well documented | C FFI; blame is slow; no zlib-ng by default; parallelism awkward; partial/shallow clone support lags |
| **Shell out to `git`** | Maximum compatibility; 20 years of edge-case handling; rename detection is battle-tested | Process spawn overhead per call; output parsing is fragile across versions and locales; requires `git` installed |
| **gitoxide (`gix`)** | Fastest pack access, excellent parallel traversal, pure Rust, actively developed, ergonomic | Some APIs still evolving; blame and merge support less mature than libgit2 |
| **Custom implementation** | Full control | Reimplementing packfile deltas and the index format is a year we do not have |

### Reasoning

gitoxide is measurably fastest at the operation that dominates our cost — walking
history and diffing trees — and being pure Rust removes an entire class of build and
cross-compilation pain. But the `git` CLI has genuinely better behaviour on a handful
of operations (high-similarity rename detection across large trees, LFS pointers,
some blame corner cases), and pretending otherwise would produce subtly worse
results.

Hence the trait. `capabilities()` lets a `HybridBackend` route per-operation, and the
choice is observable in developer mode so a user reporting a lineage bug can tell us
which path produced it.

### Costs accepted

- Two implementations to keep behaviourally consistent, enforced by running the
  fixture suite against both backends in CI.
- gitoxide API churn on upgrades. Mitigated by pinning and by the trait absorbing
  changes at one boundary.

### Reversal cost

Low — swap the default implementation. This is exactly why the trait exists.

---

## 13.3 Storage: SQLite + Tantivy + usearch

Fully argued in [Part 9 §9.2](09-data-architecture.md). Summary of the decision and
its costs:

| Layer | Choice | Chief alternative rejected | Cost accepted |
|---|---|---|---|
| Records | SQLite (rusqlite, WAL) | DuckDB — better analytics, +30MB, second engine | Analytical queries need precomputed rollups |
| Full text | Tantivy | SQLite FTS5 — one less dependency, worse code tokenization | +~8MB binary, a second index to keep in sync |
| Vectors | usearch + raw f32 sidecar | sqlite-vec — single file, degrades past ~100k vectors | Third artifact; rebuildable, so low risk |

The unifying reasoning is Part 2's D1: **boring core, sharp edges.** The novelty
budget belongs in the evidence engine and the renderer, not in storage.

---

## 13.4 Frontend

### 13.4.1 Framework: React 19

| Option | Case | Why not |
|---|---|---|
| **Svelte 5** | Smaller bundles, better ergonomics, excellent reactivity | Smaller contributor pool for an OSS project that needs contributors |
| **SolidJS** | Fastest fine-grained reactivity | Ecosystem too small; hiring/contributing pool tiny |
| **Vue 3** | Good DX, decent ecosystem | Smaller in this domain; fewer dev-tool-shaped libraries |
| **Vanilla + Web Components** | No framework tax | We would rebuild routing, state, and lists badly |
| **React 19** | **Chosen** | Largest contributor pool; deepest ecosystem for the specific things we need (Radix, TanStack, CodeMirror integration, motion) |

The honest framing: React is not the technically optimal choice. It is the *strategic*
choice for an open-source project whose success depends on people being able to
contribute a panel without learning a new framework. Most of the app's performance
lives in canvas and WASM anyway, so React's overhead is confined to the chrome.

Discipline required: no state-management sprawl, no unnecessary re-render cascades,
and canvas views must never re-render from React at frame rate.

### 13.4.2 State

| Concern | Tool | Reason |
|---|---|---|
| Server state | **TanStack Query** | The daemon is a server; caching, invalidation, and retry are solved problems |
| UI state | **Zustand** | Tiny, no boilerplate, no provider hell |
| Navigation & shareable state | **URL** (TanStack Router) | Part 2, U4 — deep-linkability is a requirement, not a feature |
| Realtime | Custom WebSocket hook feeding Query invalidations | Events are advisory; Query owns truth |

Explicitly rejected: Redux (ceremony for no benefit here), and putting time/selection
in Zustand instead of the URL (would silently break deep-linking, which is
unrecoverable later).

### 13.4.3 Build and styling

- **Vite 7** — dev server, HMR, and library builds for the internal packages. No
  contest.
- **Tailwind v4 + CSS custom properties.** Tokens live as CSS variables (Part 12
  §12.3) so themes switch without a rebuild and canvas code can read the same values
  via `getComputedStyle`. Tailwind provides the utility layer; component styles that
  exceed ~4 utilities move to a co-located CSS module.
- **Radix UI primitives** for accessible behaviour, styled ourselves. Rejected
  shadcn-as-dependency in favour of vendoring the handful of components we actually
  need — a design-system-heavy app should own its components.

### 13.4.4 Code viewing: CodeMirror 6

| Option | Case | Why not |
|---|---|---|
| **Monaco** | Full VS Code editing power, familiar | ~5MB, heavy for read-only, awkward gutter/decoration APIs, web-worker requirements complicate the Tauri build |
| **Shiki + plain DOM** | Beautiful highlighting, tiny | No virtualization; a 10k-line file kills the DOM; no interaction model |
| **Custom** | Full control | Months of work for a solved problem |
| **CodeMirror 6** | **Chosen** | ~200KB, excellent gutter and decoration extensions, virtualized, accessible, tree-sitter-compatible highlighting |

We display code; we never edit it. CodeMirror 6's extension model is exactly right
for the age-heatmap gutter and the `?` line affordance.

### 13.4.5 Rendering and animation

- **Custom WebGL2 renderer** (`@excavate/canvas`) — argued in [Part 11
  §11.2](11-visualization-architecture.md).
- **D3 for math only** (`d3-scale`, `d3-hierarchy`, `d3-force`, `d3-array`). Never
  `d3-selection` — mixing D3's DOM mutation with React's reconciliation is a
  well-known source of subtle bugs, and we do not need it.
- **`motion`** (the Framer Motion successor) for DOM transitions and FLIP; a small
  custom spring implementation for canvas, because DOM animation libraries cannot
  drive typed-array interpolation efficiently.

---

## 13.5 Desktop shell: Tauri v2, with `serve` as a co-equal

**Chosen:** Tauri v2 as a thin native shell over the same web application that
`excavate serve` delivers to a browser.

### Alternatives

| Option | Bundle | Case | Why not |
|---|---|---|---|
| **Electron** | ~150MB | Identical Chromium everywhere; bulletproof; best tooling | Size and memory are hostile for a tool people install casually; we would ship a browser to render a treemap |
| **Tauri v2** | ~12MB | Tiny; Rust backend in-process; good native integration | WebView inconsistency, especially WebKitGTK on Linux |
| **GPUI / native Rust UI** | ~20MB | Beautiful, fastest possible | Tiny ecosystem; no CodeMirror equivalent; GPU driver variance on Linux; would halve contributor accessibility |
| **Web only** | 0 | Simplest | No native file access, no protocol handler, no "app" feel, worse first-run |
| **Flutter / .NET MAUI** | — | Cross-platform | Wrong ecosystem entirely for this stack |

### Reasoning

The heavy lifting is Rust, which Tauri hosts natively. Binary size and memory
footprint matter disproportionately for a developer tool that people try on a whim —
a 150MB download for "let me see what this does" has a real conversion cost.

### The Linux risk, and its mitigation

WebKitGTK is the genuine hazard: inconsistent WebGL2 behaviour, occasional
compositing bugs, and slower JS. Four mitigations, all of which we would want anyway:

1. **Conservative web-feature targeting.** WebGL2 not WebGPU; no bleeding-edge CSS;
   feature detection with graceful fallback to Canvas2D.
2. **`excavate serve` is a first-class product surface**, not a fallback. Linux users
   for whom the shell misbehaves get the full application in their own browser with
   one flag, and this is documented rather than hidden.
3. **CI smoke tests** run the real UI on all three platforms with Playwright, taking
   screenshots.
4. **A documented escape hatch** to swap the Linux WebView, and a stated willingness
   to ship an Electron build for Linux if the data says we must.

The `serve` mode is the strategic insight here: designing for it turns the largest
platform risk into a feature that also enables CI use, remote/codespace use, and
headless screenshots.

### Reversal cost

Moderate. The web app is transport-agnostic and the daemon is separate, so swapping
the shell touches ~600 lines plus packaging. This is precisely the payoff of the
daemon architecture.

---

## 13.6 API and type generation

**Transport:** HTTP/1.1 + WebSocket on localhost. Details and security posture in
[Part 7 §7.4](07-product-architecture.md).

| Alternative | Why not |
|---|---|
| Tauri IPC only | Kills `serve`, CLI, MCP, and headless use. The single worst available decision. |
| gRPC / gRPC-web | Heavier toolchain, worse browser story, no debugging with `curl` |
| GraphQL | Query flexibility we do not need; adds a resolver layer and N+1 hazards |
| tRPC | TypeScript-only; our server is Rust |

**Type generation:** `specta` derives on every type in `excavate-proto` emit
`packages/api/src/generated.ts`. CI fails if the checked-in file differs from a fresh
generation. Rejected: hand-written TypeScript mirrors (drift is inevitable), and
OpenAPI codegen (an extra format to maintain for a purely internal API).

**Binary bulk plane:** `postcard` for typed structs, Arrow IPC for columnar series.
Serializing 50k layout positions as JSON is ~40MB and a visible stall; as
`Float32Array` it is 800KB and a memcpy (Part 11 §11.9.2).

---

## 13.7 Concurrency and job model

### Runtime

**Tokio** for async I/O (HTTP, WebSocket, provider calls, forge fetches). **Rayon**
for CPU-bound parallelism (analysis, parsing, embedding). They are used for different
things and never mixed: blocking work goes through `spawn_blocking` or onto the rayon
pool, never on the async runtime's threads.

### Job scheduler

```rust
pub struct Job {
    pub id: JobId,
    pub kind: JobKind,               // Index | Analyze | Embed | Generate | Fetch
    pub priority: Priority,          // Interactive > Background > Idle
    pub cancel: CancellationToken,
    pub progress: watch::Sender<Progress>,
}
```

Rules:

- **Interactive work preempts background work.** A user pressing `?` while embeddings
  are running gets their answer immediately; embedding threads yield.
- **Every job is cancellable at batch boundaries**, with clean transaction rollback.
- **Progress is a `watch` channel**, so slow consumers see the latest value rather
  than a backlog.
- **Idle-priority jobs** (embedding, enrichment, forge sync) pause when the user is
  actively interacting and resume after a quiet period.

### Thread budget

`min(available_parallelism, 8)` for the rayon pool by default, configurable.
Deliberately not "all cores": an indexer that makes the user's machine unusable is a
bug, and developers run this alongside a build.

---

## 13.8 Testing strategy

### 13.8.1 The fixture DSL — the foundation

Testing Git tooling against real repositories is slow, non-deterministic, and
impossible to make cover edge cases. We generate repositories instead:

```rust
repo! {
    at "2019-01-01";
    commit "initial" { add "src/main.rs" = "fn main() {}" }
    commit "add lib"  { add "src/lib.rs"  = "pub fn go() {}" }
    branch "feature" {
        at "2019-02-01";
        commit "rename" { rename "src/lib.rs" -> "src/core.rs" }
    }
    at "2019-02-05";
    commit "edit on main" { edit "src/lib.rs" += "// note" }
    merge "feature" conflict_resolution: theirs;
    commit "revert it" { revert "rename" }
}
```

Deterministic timestamps, deterministic authors, deterministic OIDs. Every fixture is
a regression test that runs in milliseconds.

**Required fixture coverage:**

| Category | Cases |
|---|---|
| Renames | simple, with-edit, chains, across merges, rename-back, delete+add-as-rename |
| Merges | two-parent, octopus, criss-cross, merge with rename conflict, empty merge |
| Identity | `.mailmap`, name variants, email variants, bots, co-authored-by |
| Blame | `.git-blame-ignore-revs`, copies (`-C`), moves (`-M`), whitespace-only |
| Pathological | orphan branches, submodules, empty commits, binary files, LFS pointers, symlinks, CRLF, unicode and emoji paths, paths > 255 bytes, case-only renames on case-insensitive filesystems |
| Scale | generated 100k-commit repo for perf assertions |
| History rewriting | force-push, rebase, amend, filter-branch |

### 13.8.2 Test layers

| Layer | Tool | Scope |
|---|---|---|
| Unit | `cargo test` | Pure functions: scoring, decay, PELT, ranking |
| Property | `proptest` | Domain invariants (Part 8 §8.8) — especially alias non-overlap and generation ordering |
| Snapshot | `insta` | Index output for each fixture; evidence bundle shape; API responses |
| Integration | custom harness | Full index → query → assert, against both Git backends |
| API contract | generated tests | Every endpoint against the generated TS types |
| Component | Vitest + Testing Library | React components |
| Visual regression | Playwright + `pixelmatch` | Every view × theme, deterministic seeds |
| E2E | Playwright | The Part 6 §6.5 demo script, run as a test |
| Accessibility | `axe-core` in Playwright | Every route, both themes |
| Performance | criterion + custom | Budgets from §13.9, asserted with 10% tolerance |
| AI evaluation | custom harness | Part 10 §10.10 |

### 13.8.3 The reference corpora

| Tier | Repository | Approx commits | Used for |
|---|---|---|---|
| XS | Excavate itself | ~1k | Dogfooding, fast CI |
| S | `BurntSushi/ripgrep` | ~2k | Every PR |
| M | `rust-lang/rust-analyzer` | ~20k | Every PR (perf budgets) |
| L | `facebook/react` | ~19k, deep history | Nightly |
| XL | `torvalds/linux` | ~1.3M | Weekly, scale assertions |

Corpora are pinned to specific commits and cached in CI, so results are comparable
over time.

---

## 13.9 Performance budgets

Asserted in CI. Regression beyond tolerance fails the build.

### Indexing (8-core reference machine, warm cache)

| Metric | Budget |
|---|---|
| T0 (metadata) throughput | ≥ 40k commits/min |
| T1 (structure) throughput | ≥ 12k commits/min |
| T2 symbol extraction | ≥ 2k files/min |
| T2 embedding | ≥ 500 chunks/s |
| Peak RSS during index, 100k commits | ≤ 1.5 GB |
| Peak RSS during index, 1M commits | ≤ 3 GB |
| Incremental (500 new commits) | ≤ 3s |
| Index size vs `.git` (core, no vectors) | ≤ 5% |

### Runtime

| Metric | Budget |
|---|---|
| Time to first meaningful UI (10k commits) | < 2s |
| Reopen indexed repo → interactive | < 1.5s |
| ⌘K first results | < 50ms |
| Why panel (deterministic path) | < 200ms |
| Why panel (with generation, streaming first token) | < 1.5s |
| Map initial render, 50k cells | < 400ms |
| Map pan/zoom | 60fps |
| Lens switch | < 100ms |
| Timeline scrub | 60fps |
| Steady-state RSS (100k-commit repo) | < 500 MB |
| Idle CPU | < 1% |

### Distribution

| Metric | Budget |
|---|---|
| Binary size (CLI + daemon) | < 30 MB |
| Desktop installer | < 20 MB |
| Cold install → first insight | < 3 min |

---

## 13.10 Build, packaging, distribution

### Toolchain

- Rust stable, MSRV pinned and tested; `rust-toolchain.toml` committed.
- pnpm workspaces for JS; Node LTS.
- `just` as the task runner (`just dev`, `just test`, `just fixtures`, `just release`).
  Chosen over Make for cross-platform sanity and over npm scripts because half the
  repo is Rust.

### CI matrix

| Platform | Targets |
|---|---|
| macOS | `aarch64-apple-darwin`, `x86_64-apple-darwin` |
| Linux | `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, plus a musl static build |
| Windows | `x86_64-pc-windows-msvc` |

`cargo-dist` produces installers and shell installers; Tauri produces `.dmg`,
`.msi`/`.exe`, `.AppImage`, and `.deb`.

### Distribution channels

`curl -fsSL https://excavate.dev/install.sh | sh` · Homebrew tap · `cargo install
excavate` · `winget` · GitHub Releases · `npx excavate` wrapper (fetches the binary —
meets JS developers where they are, which is a meaningful share of the audience).

### Supply chain

- `cargo-deny` (licenses, advisories, duplicate versions) and `cargo-audit` in CI.
- `pnpm audit` with a pinned lockfile.
- SLSA provenance attestation on release artifacts.
- Signed and notarized macOS builds; signed Windows builds.
- Reproducible-build verification for the release binaries.

For a tool that reads proprietary source code, supply-chain rigor is not optional
hygiene — it is a precondition for anyone running it at work.

---

## 13.11 Configuration

Layered, with later layers overriding earlier:

```
1. Built-in defaults
2. ~/.config/excavate/config.toml         (user)
3. <repo>/.excavate/config.toml           (project, committable)
4. Environment variables (EXCAVATE_*)
5. CLI flags
```

```toml
[index]
scope = ["packages/web", "packages/core"]   # monorepo scoping
exclude = ["**/generated/**", "vendor/**"]
projection = "first-parent"
hunk_limit_years = 5

[ai]
provider = "anthropic"
model = "claude-opus-5"
effort = "high"
budget_usd_per_session = 5.00
auto_approve_under_usd = 0.05

[ai.embeddings]
provider = "local"
model = "bge-small-en-v1.5"

[ui]
theme = "dark"
density = "comfortable"
default_lens = "hotspot"
```

**Secrets are never in config files.** API keys live in the OS keychain, set via
`excavate auth set anthropic` or the settings UI. `EXCAVATE_ANTHROPIC_API_KEY` is
honoured for CI, with a warning that it will appear in process listings.

---

## 13.12 Observability

- **Structured logging** via `tracing`, JSON to a rotating file in the state
  directory, human-readable to stderr. `RUST_LOG`-compatible filtering.
- **Spans on every pipeline stage** with timings, so `excavate doctor --profile`
  produces a per-stage breakdown of where indexing time went.
- **No telemetry.** No network calls except to configured providers and forges. This
  is verified by a CI test that runs a full index and Why query against a fixture with
  network access denied, and asserts zero outbound connections.
- **`excavate doctor`** — diagnoses environment, Git version, backend selection, index
  integrity, model reachability, and disk space, printing a report suitable for
  pasting into an issue.
- **Crash handling** — panics are caught, written to a local report with the stack and
  a redacted environment summary, and the UI offers a "copy report" button. Nothing is
  transmitted.

---

## 13.13 Security model

**Threat model.** Excavate reads untrusted repository content (commit messages, code,
PR text) and holds a complete index of potentially proprietary source. The relevant
threats:

| Threat | Mitigation |
|---|---|
| **Prompt injection via repo content** | Evidence is delimited and labelled as data in every prompt; the system prompt states evidence is never instruction; injection cases are permanent eval-set members (Part 10 §10.10.4) |
| **Local API exposure** | 127.0.0.1 only, random port, 256-bit session token, Origin validation on WebSocket upgrade (anti-DNS-rebinding), strict CORS |
| **Secret leakage into the index** | Commit *content* is not stored — only metadata, hunk coordinates, and embeddings. Blob content is read on demand from `.git`. Packs warn about what they include and offer `--redact-emails` |
| **Secret leakage to providers** | Only assembled evidence bundles are transmitted, never whole files or whole repos; the exact payload is inspectable in developer mode before sending |
| **Malicious plugin** | WASM sandbox with declared capabilities; no ambient filesystem or network |
| **Malicious repository** | Path traversal guarded on every path operation; zip/pack bombs bounded; parser fuzzing with `cargo-fuzz`; resource limits on tree-sitter |
| **Supply chain** | §13.10 |
| **Credential storage** | OS keychain only; never in the index, config files, or logs |

The single most important line: **network access is opt-in and enumerable.** A user
can run Excavate with no network at all and get the full deterministic product, and
this is tested.

---

## 13.14 The decision summary

| Area | Choice | Chief alternative | Reversal cost |
|---|---|---|---|
| Core language | Rust | Go | Total rewrite |
| Git access | gitoxide + CLI fallback behind a trait | libgit2 | Low |
| Records store | SQLite | DuckDB | Medium |
| Full text | Tantivy | SQLite FTS5 | Low |
| Vectors | usearch + raw sidecar | sqlite-vec | Low |
| Embeddings | Local ONNX, bge-small | API embeddings | Low |
| Architecture | Localhost daemon | Tauri IPC monolith | High (do it right first) |
| Transport | HTTP + WS + binary bulk | gRPC | Low |
| Types | specta-generated TS | Hand-written | Low |
| UI framework | React 19 | Svelte 5 | High |
| Server state | TanStack Query | SWR / custom | Low |
| Nav state | URL | Zustand | High (unrecoverable later) |
| Styling | Tailwind v4 + CSS vars | CSS-in-JS | Medium |
| Code view | CodeMirror 6 | Monaco | Low |
| Renderer | Custom WebGL2 | sigma.js / deck.gl | Medium |
| Layout compute | Rust → native + WASM | JS implementations | Medium |
| Desktop shell | Tauri v2 (+ `serve`) | Electron | Moderate |
| Default LLM | `claude-opus-5` | Any; fully abstracted | Trivial |
| Plugins | WASM component model | Native dylibs | N/A (not yet shipped) |
| License | Apache-2.0 | MIT / AGPL | Effectively permanent |

---

*Next: [Part 14 — Repository Structure](14-repository-structure.md)*
