# Appendix A — Decision Register

Every load-bearing decision, with its alternative, its rationale in one line, and
what reversing it would cost. Sorted by reversal cost, descending — the top of this
table is where care is most warranted.

**Reversal cost scale:**

- **Permanent** — effectively a rewrite.
- **High** — months, touching most of the codebase.
- **Moderate** — weeks, contained to a subsystem.
- **Low** — days, behind an existing abstraction.
- **Trivial** — a config change.

---

## A.1 Architecture

| # | Decision | Alternative | Why | Reversal | Spec |
|---|---|---|---|---|---|
| A01 | Rust for the core | Go, TypeScript | Only ecosystem with gitoxide + tantivy + usearch + tree-sitter + ONNX all first-class; single static binary | **Permanent** | 13.1 |
| A02 | Localhost daemon, not Tauri IPC | Monolithic desktop app | Buys `serve`, CLI, MCP, headless, remote, and the Linux fallback for the cost of one HTTP layer | **High** | 7.1 |
| A03 | URL as navigation state | Client-side store | Deep links, back/forward, shareability, testability — free now, impossible later | **High** | 12.2.3 |
| A04 | React 19 for the UI | Svelte 5, Solid | Contributor pool over technical elegance; perf lives in canvas anyway | **High** | 13.4.1 |
| A05 | Apache-2.0 license | MIT, AGPL, open-core | Patent grant + corporate-approvable; open-core poisons contributor trust | **High** | SPEC |
| A06 | Single history walk with sink fan-out | Per-analysis walks | Re-reading history is the largest avoidable cost on large repos | Moderate | 7.2.2 |
| A07 | Tauri v2 shell over the same web app | Electron, native UI | 12MB vs 150MB matters for casual installs; `serve` de-risks Linux | Moderate | 13.5 |
| A08 | WASM plugins, not native dylibs | dlopen | Executing native plugin code against proprietary source is a supply-chain incident waiting to happen | Moderate | 7.6 |
| A09 | HTTP + WS + binary bulk plane | gRPC, GraphQL | Debuggable with `curl`; binary only where JSON is measurably a stall | Low | 7.4.1 |
| A10 | specta-generated TypeScript types | Hand-written mirrors | Drift is inevitable otherwise; CI enforces freshness | Low | 13.6 |

## A.2 Data

| # | Decision | Alternative | Why | Reversal | Spec |
|---|---|---|---|---|---|
| A11 | SQLite as system of record | DuckDB, RocksDB | Inspectable (`sqlite3 index.db`), universal, transactional; rollups cover the analytics gap | Moderate | 9.2.1 |
| A12 | Index in XDG cache, not the repo | `.excavate/` by default | Never pollute someone's working tree without being asked | Low | 9.1 |
| A13 | Dense integer IDs alongside OIDs | OIDs as primary keys | 4-byte vs 20-byte keys across millions of rows | Moderate | 8.2.1 |
| A14 | Generation numbers for ancestry | Recursive CTE traversal | Near-constant-time ancestry is what makes time-filtered views feasible | Moderate | 8.2.1 |
| A15 | Explicit `HistoryProjection` | Assume first-parent silently | The DAG is not a line; pretending otherwise is a lie users can detect | Moderate | 8.2.2 |
| A16 | Hunks stored, not recomputed | Recompute on demand | Enables symbol attribution without reparsing every revision | Moderate | 8.2.3 |
| A17 | Tantivy over SQLite FTS5 | FTS5 | Much better code tokenization and faceting; ⌘K's 50ms budget becomes comfortable | Low | 13.3 |
| A18 | usearch + raw f32 sidecar | sqlite-vec | Brute force degrades past ~100k vectors; raw file makes ANN rebuild free | Low | 13.3 |
| A19 | Lazy ownership decay | Recompute on every index | Makes incremental indexing cheap | Low | 8.5.2 |
| A20 | Rebuild over complex migration | Always migrate | The index is a derived cache; `.git` is truth. Complex data migrations for a cache are not worth writing | Trivial | 9.10 |

## A.3 Domain

| # | Decision | Alternative | Why | Reversal | Spec |
|---|---|---|---|---|---|
| A21 | File identity survives renames and resurrection | Path-keyed history | Without it, File Evolution lies and blame chains truncate — instantly disqualifying | **Permanent** in effect | 8.3.2 |
| A22 | Five-step identity merge with recorded source | Email-only matching | "Dana R." appearing five times makes ownership meaningless | Moderate | 8.3.1 |
| A23 | Symbol lineage via checkpoints + hunk intervals | Parse every revision | O(commits × files) parses is infeasible; 95% accuracy at 2% of the cost | Moderate | 8.3.3 |
| A24 | Three-level `Certainty` on evidence | Uniform confidence | "A revert exists" and "our algorithm inferred this" are epistemically different | Low | 8.4.1 |
| A25 | Deterministic significance with penalties | LLM ranking | Reproducible, free, fast; penalties are what stop "top commits" being the Prettier migration | Low | 8.5.1 |
| A26 | `Decision` as a first-class entity | Only commits and eras | Turns evidence into a browsable, mined ADR log — very high value for near-zero marginal cost | Low | 8.4.3 |
| A27 | Recency-decayed knowledge with dilution | Raw commit counts | You do not still understand code someone else replaced | Low | 8.5.2 |

## A.4 AI

| # | Decision | Alternative | Why | Reversal | Spec |
|---|---|---|---|---|---|
| A28 | AI narrates, never retrieves | RAG over the repo | Eliminates the entire class of "searched for the wrong thing and confidently summarized it" | **High** | 10.1 |
| A29 | Mandatory citation contract + validator | Trust the prompt | A prompt instruction is a hope; a validator is a guarantee | **High** | 10.6 |
| A30 | Every feature has a no-AI path | AI-required | Makes the tool free, offline, private, and instantly demoable | **High** | 2.3 |
| A31 | Deterministic confidence, computed pre-generation | Model self-reports | Fluent prose must not be able to inflate confidence | Moderate | 10.5 |
| A32 | Local ONNX embeddings by default | API embeddings | Zero key, zero cost, zero data egress — the whole no-key posture depends on it | Low | 10.3 |
| A33 | Per-pipeline model selection | One global model | Haiku for classification, Opus for narration; ~10× cost difference for no quality loss | Trivial | 10.2.5 |
| A34 | Cache key excludes wall-clock time | Time-based TTL | Historical era narratives stay valid forever; re-running on an active repo is nearly free | Low | 9.7 |
| A35 | Capability descriptors, not feature flags | Lowest common denominator | Lets strong providers be used fully and weak ones degrade explicitly | Low | 10.2.2 |
| A36 | Pre-flight cost estimate + visible meter | Silent spending | Converts the biggest AI-tool anxiety into a trust signal for one day of work | Low | 10.7 |
| A37 | Stateless generation, no chat memory | Conversational thread | Reproducibility, no injection accumulation, no "why did it say that" support burden | Low | 10.9 |
| A38 | Eval harness before prompt tuning | Tune by feel | Without measurement, prompt changes are superstition | Low | 10.10 |
| A39 | Default `claude-opus-5` for user-facing prose | Cheaper default | The output a user acts on is worth the strongest model; fully overridable | Trivial | 10.2.5 |

## A.5 Visualization

| # | Decision | Alternative | Why | Reversal | Spec |
|---|---|---|---|---|---|
| A40 | Persistent Layout (positions frozen across time) | Relayout per timestep | The single decision that makes time-scrubbing legible instead of a boil | **High** | 11.3.2 |
| A41 | Squarified treemap ordered by stable key | Ordered by size | Slightly worse aspect ratios, positions that mean something | Moderate | 11.3.1 |
| A42 | Custom WebGL2 renderer | sigma.js, deck.gl, D3 | Needs instancing + stable identity + shared-element transitions; libraries fight us | Moderate | 11.2.2 |
| A43 | WebGL2, not WebGPU, as primary | WebGPU | WebKitGTK availability in 2026 is unreliable; WebGPU is a progressive enhancement | Low | 11.2.1 |
| A44 | Layout in Rust→WASM | JS implementations | One implementation, no drift between cached and interactive layouts | Moderate | 11.2.3 |
| A45 | Hard 300-node budget on graph views | Render everything | Hairballs are a bug class, not an aesthetic | Low | 11.5.1 |
| A46 | Text as DOM overlay, never in WebGL | SDF font atlas | Crisp, selectable, translatable, accessible — and avoids a whole subproject | Low | 11.2.2 |
| A47 | Accessible table twin for every canvas view | Canvas only | Accessibility requirement that also delivers copy-paste and CLI parity | Low | 11.1 |
| A48 | Chrome achromatic; color reserved for data | Colored UI chrome | The Map's lenses need the entire color budget | Moderate | 12.3.1 |

## A.6 Product & process

| # | Decision | Alternative | Why | Reversal | Spec |
|---|---|---|---|---|---|
| A49 | No productivity metrics, ever | Ship them; users ask | Would turn every persona against the tool; ethical and strategic | **Permanent** | 2.1 P7 |
| A50 | No chat interface | Add a chat tab | The UI is the product; a chat box requires you to already know the question | **High** | 2.2 U1 |
| A51 | No single health score | Score out of 100 | A number with no evidence invites arguing about the number | Low | 2.1 P2 |
| A52 | Zero telemetry, no code path | Anonymous opt-in stats | Trust, for a tool reading proprietary code | Low | SPEC |
| A53 | Read-only on the working tree | Allow checkouts/edits | Safety property and scope guard | Low | 2.6 |
| A54 | Fixture DSL over real-repo tests | Test against checked-in repos | Deterministic, millisecond-fast, and the only way to cover pathological cases | Moderate | 13.8.1 |
| A55 | Perf budgets asserted in CI | Measure at the end | Perf that is not measured is perf that is already gone | Low | 13.9 |
| A56 | Declarative language packs, no Rust | Rust trait per language | The highest-volume contribution path must be the easiest | Moderate | 7.2.5 |
| A57 | Excavate's own repo is the demo | A synthetic demo repo | Dogfooding; and the tool's history is genuinely interesting | Trivial | SPEC |
| A58 | Single time cursor as global state | Per-view time | Makes the app one instrument instead of a folder of dashboards | **High** | 2.2 U3 |

---

## A.7 Decisions deliberately deferred

Recorded so the deferral is a decision rather than an omission.

| Question | Deferred until | Why |
|---|---|---|
| DuckDB for analytics | Rollup computation becomes a measured bottleneck | Precomputed rollups may make it unnecessary |
| Cross-encoder rerank for search | v0.3, after measuring hybrid quality | RRF may be sufficient |
| Multi-repository model | Real user demand | Multiplies domain complexity before single-repo value is proven |
| Human annotations | v2 | Introduces mutable user data, sync, and merge semantics |
| Hosted service | Possibly never | Read-only pack hosting yes; hosted indexing of private code, no |
| Editor extensions | After the API is versioned and stable | Shipping an extension against an unstable API means breaking it |
| Windows-first visual QA | v1.0 | Supported and CI-tested throughout; polish pass is sequenced last |

---

## A.8 How to change a decision

1. Open an ADR in `docs/adr/` stating the decision being revisited, what changed, and
   the migration path.
2. If the reversal cost is **High** or **Permanent**, it requires maintainer
   consensus and a written migration plan before implementation begins.
3. Update this register with the new decision, and keep the old row with a
   `superseded by ADR-NNNN` note. History is not deleted — that would be ironic.
