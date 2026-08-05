# Part 15 — Execution Plan

Eleven milestones. Each is written to be executable by an engineer or an agent with
no context beyond this document.

**Rules that apply to every milestone:**

1. **Every milestone ends in something demoable.** No milestone is "infrastructure
   only" — each one adds a visible capability, even if small.
2. **Definition of done includes tests.** A milestone with passing acceptance criteria
   and no tests is not done.
3. **Performance budgets are checked at every milestone**, not at the end. A
   regression found six milestones later is a rewrite.
4. **Every milestone updates the docs it invalidates.**

**Sizing.** Estimates assume 1–2 focused engineers. They are relative, not calendar
commitments.

| # | Milestone | Size | Ships |
|---|---|---|---|
| M0 | Foundations & walking skeleton | 2w | — |
| M1 | Git engine & store | 4w | `excavate index` |
| M2 | Analysis layer | 3w | `excavate stats` |
| M3 | Shell, design system, Overview | 3w | first UI |
| M4 | Timeline & Map | 4w | **v0.1-alpha** |
| M5 | Evidence engine & Why | 4w | v0.1-beta |
| M6 | AI layer & The Story | 4w | **v0.1** |
| M7 | Search & File Evolution | 3w | v0.1.x |
| M8 | Forge, SZZ, semantic search, CLI, packs | 4w | **v0.2** |
| M9 | Symbols, MCP, Decisions, language packs | 4w | **v0.3** |
| M10 | Polish, perf, a11y, packaging, launch | 4w | **v1.0** |
| M11+ | Architecture Evolution, Knowledge Graph, plugins, living docs | — | v1.x |

---

## M0 — Foundations & the walking skeleton

### Objectives

Establish the workspace, CI, and — critically — an end-to-end thread through every
architectural layer before any layer is built properly. Part 2's D7: the walking
skeleton de-risks every interface simultaneously.

### Architecture changes

Creates the workspace, the crate graph, the daemon↔UI contract, and the type
generation pipeline.

### Deliverables

1. Cargo workspace + pnpm workspace per [Part 14](14-repository-structure.md), with
   every crate created as a stub containing at minimum its public trait definitions.
2. `justfile` with `dev`, `test`, `lint`, `gen`.
3. CI: build, test, clippy, rustfmt, eslint, tsc, generated-file drift check, on all
   three platforms.
4. `excavate-core` — IDs, `Timestamp`, `Oid`, error types.
5. `excavate-proto` — three types, specta wired, `just gen-types` emitting
   `packages/api/src/generated.ts`.
6. `excavate-testkit` — the `repo!` macro producing deterministic fixture
   repositories on disk. **This is the highest-value item in M0.**
7. `excavate-daemon` — Axum server, localhost binding, token auth, one endpoint
   (`GET /repo/summary`), WebSocket echo.
8. `apps/web` — Vite + React + TanStack Query, one page calling that endpoint.
9. `apps/desktop` — Tauri shell that spawns the daemon and loads the web app.
10. **The skeleton:** `excavate .` on a fixture repo → walks 100 commits with gitoxide
    → writes them to SQLite → serves them → the UI renders a list → clicking one shows
    its message.

### Testing

- Fixture DSL unit tests: every construct produces the expected Git objects.
- Daemon integration test: start, authenticate, query, shut down.
- CI green on macOS, Linux, Windows.
- Type-drift check fails on an intentionally stale `generated.ts`.

### Acceptance criteria

- [ ] `just dev` starts daemon + UI wired together, on a clean checkout, on all three OSes
- [ ] `just test` passes
- [ ] The skeleton flow works end to end on a fixture repo
- [ ] `repo! { commit "a" { add "x.rs" = "…" } }` produces a valid repository
- [ ] Editing a `#[derive(Type)]` struct and running `just gen-types` updates the TS

### Risks

| Risk | Mitigation |
|---|---|
| Tauri + Vite dev-server integration is fiddly | Solve it in M0 while the surface is trivial |
| specta output does not match hand-expectations | Validate with a type-level test in TS |
| Windows path handling surprises | Windows is in CI from day one, not added later |

### Future considerations

Every stub trait defined here is a contract later milestones fill in. Getting the
signatures approximately right now saves refactors; getting them exactly right is not
necessary.

---

## M1 — Git engine & store

### Objectives

Index a real repository, correctly, fast. This milestone contains the hardest
correctness work in the project: rename tracking and identity merging.

### Architecture changes

`excavate-git`, `excavate-index`, `excavate-store` become real. The single-walk
pipeline with `WalkSink` fan-out is established.

### Deliverables

1. **`GitBackend`** — `GixBackend` complete; `CliBackend` for rename detection and
   blame; `HybridBackend` routing by capability.
2. **Commit graph** — dense IDs, parent edges, generation numbers (reusing Git's
   `commit-graph` when present), memory-mapped ancestry queries.
3. **Identity merging** — the five-step resolution from [Part 8
   §8.3.1](08-domain-model.md), including `.mailmap` and bot detection.
4. **Rename resolution** — file identity with alias chains, resurrection handling,
   merge reconciliation, per [Part 8 §8.3.2](08-domain-model.md).
5. **Schema + migrations** — the full [Part 9 §9.4](09-data-architecture.md) DDL,
   bulk-load configuration, indexes created post-load.
6. **The walk pipeline** — streaming, bounded channels, batched transactions,
   cancellation, tier T0/T1 markers.
7. **Incremental update** — fast-forward and history-rewrite paths.
8. **Blame** — with `-C -M` and `.git-blame-ignore-revs`, LRU-cached.
9. **`excavate index [path]`** — CLI with real progress output.
10. **Noise classification** — generated, vendored, format-only, bulk, lockfile-only.

### Testing

- **The full fixture matrix** from [Part 13 §13.8.1](13-technical-architecture.md).
  Every rename, merge, and identity case.
- **Property tests** for the Part 8 §8.8 invariants — especially alias non-overlap and
  `parent.generation < child.generation`.
- **Snapshot tests** of index output per fixture (`insta`).
- **Both backends** run the entire suite; results must match.
- **Determinism:** index twice, assert byte-identical derived tables (Invariant 13).
- **Perf:** T0 ≥ 40k commits/min, T1 ≥ 12k commits/min on the M corpus.

### Acceptance criteria

- [ ] `excavate index` completes on ripgrep, rust-analyzer, and react
- [ ] 100% of rename fixtures pass on both backends
- [ ] `.mailmap` fixtures resolve correctly; bots are flagged
- [ ] Blame skips ignored revisions
- [ ] Re-index of an unchanged repo is a no-op in < 1.5s
- [ ] 500 new commits index in < 3s
- [ ] Force-push is detected and produces a correct targeted rebuild
- [ ] Index size ≤ 5% of `.git` (core tables)
- [ ] Determinism test passes

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Rename tracking has subtle bugs** | **Critical** — silently wrong lineage destroys trust | The fixture matrix is written *before* the implementation; property tests on invariants; both backends cross-checked |
| Merge frontier reconciliation is wrong | High | Explicit projection semantics; dedicated criss-cross and octopus fixtures |
| Perf misses budget on XL | Medium | Profile early on linux corpus; the single-walk design is the main lever |
| gitoxide API gaps | Medium | The CLI fallback exists precisely for this |

### Future considerations

Everything downstream assumes file identity is correct. If M1 ships with lineage
bugs, they will surface as inexplicable wrongness in M5's Why answers and be far
harder to diagnose. **Do not compress this milestone.**

---

## M2 — Analysis layer

### Objectives

Every deterministic insight in the product. No UI, no AI — pure computation over the
index, exposed via a CLI so it can be validated before it has a face.

### Architecture changes

`excavate-analysis` with the `Analyzer` trait, version-based invalidation, and the
rollup writers.

### Deliverables

1. **Significance scoring** ([Part 8 §8.5.1](08-domain-model.md)) with penalties.
2. **Ownership & knowledge** — decay model, lazy read-time decay, bus factor,
   entropy, knowledge islands.
3. **Change coupling** — windowed sparse co-change with support thresholds and
   large-commit exclusion.
4. **Hotspots** — composite with factor breakdown retained for display.
5. **Revert / re-land detection** — all three confidence tiers.
6. **Era segmentation** — the weekly multivariate series, robust z-scoring, PELT,
   boundary snapping, short-era merging, `boundary_reason` recording.
7. **Rollups** — timeline buckets at three granularities, hotspot rankings, ownership
   snapshots, language composition series.
8. **Analyzer versioning** — per-analyzer invalidation with dependency propagation.
9. **`excavate stats`** — a terminal report: top hotspots, knowledge islands, eras,
   coupling pairs.

### Testing

- Unit tests for every formula with hand-computed expected values.
- Era stability: same repo → identical boundaries across runs and across incremental
  updates (Invariant 14).
- Significance: on each fixture and each reference corpus, assert that the top-50
  contains no format-only, generated, or lockfile-only commit. **This is the test
  that prevents the most common embarrassing failure.**
- Ownership: fixtures with known contribution patterns produce known bus factors.
- Coupling: a fixture where files A and B always change together yields strength 1.0;
  a 50-file codemod does not create coupling.
- Analyzer invalidation: bumping one version recomputes exactly its subtree.

### Acceptance criteria

- [ ] `excavate stats` on rust-analyzer produces hotspots a maintainer would recognize
      (validated by manual review against the repo's known pain points)
- [ ] Era boundaries on react land on recognizable historical transitions
- [ ] Every era has a human-readable `boundary_reason`
- [ ] Knowledge islands are correct on fixtures with known contributor departures
- [ ] No format-only or generated commit appears in any top-50 significance list
- [ ] Full analysis on the M corpus completes in < 20s
- [ ] Bumping the hotspot analyzer version recomputes hotspots only

### Risks

| Risk | Mitigation |
|---|---|
| **Era detection produces boundaries that feel arbitrary** | Tune against 10 repos whose history is publicly known; require `boundary_reason` to be defensible; if it cannot be tuned to feel right, fall back to release-based segmentation |
| Ownership decay constant is wrong | Make τ configurable; validate against repos with known team changes |
| Coupling is dominated by noise | Support thresholds + large-commit exclusion; validate that coupling on a monorepo does not link unrelated packages |
| Hotspots disagree with maintainer intuition | Treat disagreement as a bug and investigate; a maintainer's intuition is the ground truth here |

### Future considerations

These formulas will be tuned for the life of the project. Making them versioned,
configurable, and independently invalidatable now is what makes that tuning cheap
later.

---

## M3 — Shell, design system, Overview

### Objectives

The application frame and the first real screen. Establishes every UI pattern the
rest of the project follows.

### Architecture changes

`@excavate/ui`, `apps/web` structure, URL-as-state routing, the WebSocket event
pipeline into TanStack Query invalidation.

### Deliverables

1. **Design tokens** ([Part 12 §12.3](12-design-system.md)) as CSS variables, both
   themes, APCA-verified.
2. **`@excavate/ui`** — primitives on Radix + the domain components (`CommitRef`,
   `PersonChip`, `FilePath`, `ConfidenceBadge`, `MetricWithEvidence`). Storybook.
3. **App shell** — three-column layout, collapsible panels, status bar, timeline band
   placeholder.
4. **Routing** — URL as state, deep-link round-trip, back/forward.
5. **⌘K command bar** — commands and entity navigation (search lands in M7).
6. **Keyboard model** — the full [Part 12 §12.7](12-design-system.md) map, plus the
   `⇧?` overlay.
7. **Overview view** — complete, with real data from M1/M2.
8. **Indexing progress UI** — the streaming-facts screen from [Part 6 §6.2](06-mvp.md).
9. **Global state** — time cursor, selection, lens (consumed by later views).
10. **States** — loading, empty, error, partial, per [Part 12 §12.9](12-design-system.md).

### Testing

- Component tests for every `@excavate/ui` export.
- `axe-core` on every route, both themes: zero critical violations.
- Keyboard-only navigation test: reach every action without a pointer.
- Deep-link round-trip test: serialize state → navigate → assert identical state.
- Visual regression baselines established.

### Acceptance criteria

- [ ] Overview renders real data for any indexed repo
- [ ] Every action is keyboard-reachable; `⇧?` lists all bindings
- [ ] Deep links round-trip
- [ ] Both themes pass APCA thresholds
- [ ] Indexing progress shows changing facts, never a bare spinner
- [ ] ⌘K opens in < 50ms and navigates correctly
- [ ] Zero unstyled empty or error states

### Risks

| Risk | Mitigation |
|---|---|
| Design system grows unbounded | Fixed component inventory ([Part 12 §12.4](12-design-system.md)); additions require justification |
| URL state gets bypassed for convenience | Lint rule + review checklist; retrofitting is impossible |
| Overview becomes a dashboard of unexplained numbers | `MetricWithEvidence` makes the evidence link structural |

---

## M4 — Timeline & Map → **v0.1-alpha**

### Objectives

The two signature visualizations. The first release anyone outside the team sees.

### Architecture changes

`@excavate/canvas`, `@excavate/viz`, `excavate-layout` compiled to WASM, the binary
bulk transport plane.

### Deliverables

1. **`@excavate/canvas`** — WebGL2 scene renderer: instanced quads, ID-buffer picking,
   R-tree, LOD, DOM label overlay, Canvas2D fallback, camera with animation.
2. **`excavate-layout`** — squarified treemap with the stable-ordering rule; native +
   WASM builds; layout caching to `layout/treemap-head.bin`.
3. **Binary transport** — postcard/Arrow for position arrays and timeline buckets.
4. **Repository Map** — Persistent Layout, all six MVP lenses, drill-down, hover,
   selection, `⌘F` overlay, peek gesture, accessible table twin.
5. **Timeline** — strata ribbon, semantic zoom, release/era/incident markers, global
   time cursor, window selection, keyboard time controls.
6. **Global time propagation** — scrubbing updates the Map and every panel.
7. **Visual regression harness** — deterministic seeds, headless render, perceptual
   diff.

### Testing

- Layout determinism: identical input → identical output, across platforms.
- Persistent Layout: scrubbing changes no cell position (asserted numerically).
- Picking accuracy at multiple zoom levels.
- Perf: 50k cells at 60fps pan/zoom; lens switch < 100ms; timeline scrub 60fps.
- Accessible twin contains identical data.
- Visual regression across both themes and all six lenses.

### Acceptance criteria

- [ ] Map renders 50k cells at 60fps
- [ ] Lens switching is < 100ms and does not relayout
- [ ] Time scrubbing animates the Map without moving any cell
- [ ] Timeline shows recognizable eras and releases on the reference corpora
- [ ] Every canvas view has a working `T` toggle to its table twin
- [ ] Reduced-motion mode is complete and good
- [ ] **v0.1-alpha is tagged and installable**

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **WebGL2 problems on Linux WebKitGTK** | **High** | Test on Linux from the first day of M4, not the last; Canvas2D fallback proven; `serve` mode documented |
| Persistent Layout gaps look broken on present-day view | Medium | The "Compact" toggle; tune gap rendering so empty slots read as background |
| Treemap illegible on very deep hierarchies | Medium | Depth cap with drill-down; validate on a deep monorepo |
| WASM layout is slower than expected | Low | Native fallback via the daemon for the initial layout |

### Future considerations

The renderer built here carries the graph views in M11+. Keeping it
domain-agnostic (`Scene`/`Layer`/`Primitive`, no treemap-specific code) is what makes
those cheap later.

---

## M5 — Evidence engine & Why → v0.1-beta

### Objectives

The signature interaction, working entirely without AI. Proving the deterministic
path is genuinely useful is the precondition for M6 being an enhancement rather than
a dependency.

### Architecture changes

`excavate-evidence` with collectors, ranking, budget fitting, bundle hashing, and
deterministic confidence.

### Deliverables

1. **`EvidenceCollector`** trait and the MVP collectors: Blame, CommitContext,
   PrReference, RevertPair, TemporalNeighbor, TestSibling, DocChange,
   AdjacentComment, CoChange, DependencyChange.
2. **Ranking** — the four-factor score, deduplication, per-kind floors, budget
   fitting, stable `E#` assignment.
3. **Confidence** — deterministic computation with enumerated reasons.
4. **Bundle hashing** — stable across runs, the caching and reproducibility key.
5. **PR reference mining** — `(#N)`, `Merge pull request #N`, `PR-URL:`, `Change-Id`.
6. **Why panel UI** ([Part 12 §12.5](12-design-system.md)) — evidence chain,
   confidence badge, gaps, no-prose layout.
7. **`?` binding** on line, file, and directory targets.
8. **Evidence detail view** — click any evidence item to see the full commit, diff
   hunk, or PR reference.

### Testing

- Collector unit tests per collector, on fixtures with known histories.
- Ranking tests: for a target with a known best explanation, the correct evidence
  ranks first.
- Bundle hash stability across runs and across incremental index updates.
- Confidence calibration on 30 hand-labelled cases from the reference corpora.
- Perf: bundle assembly < 200ms on the L corpus.

### Acceptance criteria

- [ ] `?` on any line produces a useful chain in < 200ms
- [ ] Revert/re-land pairs appear and are correctly ordered
- [ ] PR references are extracted from squash-merge subjects on react
- [ ] Confidence is HIGH only when a substantive body or PR reference exists
- [ ] Gaps are listed explicitly ("no PR body cached")
- [ ] **The panel is genuinely useful with no prose** — validated with 5 external
      testers who are asked to explain unfamiliar code using only this panel

That last criterion is the real gate for this milestone.

### Risks

| Risk | Mitigation |
|---|---|
| **Ranking surfaces irrelevant evidence** | Hand-label 50 cases; tune against them; the eval harness in M6 formalizes it |
| Blame is too slow interactively | Hunk-table pre-filter + LRU cache; precompute for the currently-open file in the background |
| Confidence is miscalibrated | Deterministic and testable; validated on labelled cases |
| The deterministic panel is not compelling | If external testers do not find it useful, the problem is ranking, not the missing prose — fix it here, not in M6 |

---

## M6 — AI layer & The Story → **v0.1**

### Objectives

Prose. The Story view. The full MVP.

### Architecture changes

`excavate-ai` — providers, pipelines, prompt assembly, caching, budget, validation,
evals.

### Deliverables

1. **`LanguageModel` / `EmbeddingModel` traits** with capability descriptors.
2. **Providers** — Anthropic, OpenAI-compatible (covers Ollama/LM Studio/OpenRouter),
   and the `Deterministic` renderer.
3. **Prompt architecture** — versioned templates, static/volatile split, prompt-cache
   breakpoints, cache-effectiveness assertion in CI.
4. **Pipelines** — P2 era narration, P3 Why synthesis, P4 cluster labelling.
5. **Citation validation** ([Part 10 §10.6](10-ai-architecture.md)) — all four checks,
   three verdicts.
6. **Budget system** — pre-flight estimation via `count_tokens`, runtime metering from
   real usage fields, hard limits, the status-bar cost meter.
7. **Response cache** keyed by `(template_version, model, effort, bundle_hash)`.
8. **The Story view** — era scroll, cited prose, evidence cards, key commits, reverts,
   contributors, releases.
9. **Architecture sidecar** — deterministic clustering + scroll-linked morph.
10. **Eval harness** — 200 golden cases, all metrics, CI integration.
11. **Settings UI** — provider configuration, keychain storage, model selection,
    budget configuration.

### Testing

- Provider conformance suite: every provider passes the same behavioural tests.
- Citation validation: adversarial fixtures with hallucinated IDs, ungrounded
  numerics, and uncited sentences are all rejected.
- Cache: identical bundle → cache hit, zero tokens spent.
- Prompt caching: assert `cache_read_input_tokens > 0` on the second of a pair.
- Cost estimation accuracy: within 15% of actual on 20 real runs.
- **No-key path: the entire test suite runs with no provider configured and passes.**
- Eval harness: baseline established and committed.

### Acceptance criteria

- [ ] The Story generates for react in < 2 minutes and costs < $1.50
- [ ] Every generated sentence carries a resolvable citation
- [ ] Citation precision ≥ 0.95, hallucination rate ≤ 0.02 on the golden set
- [ ] Confidence calibration: HIGH ≥ 0.95 correct
- [ ] Cost estimate shown before every paid run; within 15% of actual
- [ ] Local model (Ollama) produces acceptable Story output
- [ ] **With no provider configured, every view still works** — verified by the
      full E2E suite running offline
- [ ] Prompt-injection fixtures in commit messages do not alter behaviour
- [ ] **v0.1 is tagged and released**

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Generated prose is bland or wrong** | High | The eval harness is built *before* tuning; iterate on prompts against measured metrics, not vibes |
| Cost is higher than estimated | Medium | Conservative estimates; hard budget; caching |
| Local models fail the citation contract | Medium | Constrained prompt variants; if a local model cannot cite reliably, it falls back to the deterministic renderer and says so |
| Era narration hallucinates plausible history | High | Validation rejects it; `must_not_claim` eval cases target exactly this |
| Provider API changes | Low | Capability descriptors + a conformance suite catch it immediately |

### Future considerations

The eval harness built here governs every future prompt change for the life of the
project. Investing in its case coverage now compounds.

---

## M7 — Search & File Evolution

### Objectives

Complete the MVP feature set. Navigation and drill-down.

### Deliverables

1. **Tantivy indexes** — commits and code, with code-aware tokenization and facets.
2. **⌘K search integration** — lexical results interleaved with commands and
   entities, grouped, < 50ms.
3. **Search view** — full results with filters (path, author, time, language, kind).
4. **Temporal query parsing** — "June 2021", "before v2.0", "last quarter".
5. **File Evolution view** — life ribbon, churn sparkline, ownership bands, key
   commits, co-change partners.
6. **CodeMirror integration** — read-only view with the age-heatmap gutter and per-line
   `?`.
7. **Files view** — tree navigation wired to Map selection.

### Testing

- Search relevance on a labelled query set (30 queries with known best results).
- Perf: first results < 50ms on the L corpus.
- File Evolution correctness on renamed and resurrected fixture files.
- Line-heatmap correctness against blame ground truth.

### Acceptance criteria

- [ ] ⌘K returns useful results in < 50ms
- [ ] Temporal expressions parse and filter correctly
- [ ] File Evolution shows the complete life of a file that has been renamed twice
- [ ] Age heatmap matches blame
- [ ] `?` works from within the code view

### Risks

| Risk | Mitigation |
|---|---|
| Search relevance is poor on identifier-heavy text | Custom code tokenizer; validated on the labelled query set |
| CodeMirror is slow on very large files | Virtualization is built in; cap the heatmap computation to the visible window plus margin |

---

## M8 — Forge, SZZ, semantic search, CLI, packs → **v0.2**

### Objectives

The features that most improve answer quality, plus the first distribution surfaces.

### Deliverables

1. **GitHub connector** — PR bodies, review threads with line-position mapping,
   linked issues, incremental sync, rate-limit handling, token via keychain, ETag
   caching.
2. **Forge evidence collector** — PR and review evidence in bundles; the confidence
   model updated to weight it.
3. **"The Debate"** section in the Why panel.
4. **SZZ-lite** — fix-commit identification, blame-based induction, `Inferred`
   certainty, validation against repos with known bug-introducing commits.
5. **Local embeddings** — ONNX model download and caching, five chunk kinds,
   background embedding job, usearch index.
6. **Hybrid search** — RRF fusion with lexical.
7. **`excavate why <path>:<line>`** — terminal output with the full chain, `--json`
   for scripting.
8. **`excavate export` / `excavate open <pack>`** — portable index packs with the
   manifest, redaction options, and pre-write disclosure.
9. **Investigation escalation** (P7) — bounded agentic loop with the typed toolset,
   priced and opt-in.

### Testing

- Forge connector: cassette-based tests; rate-limit and pagination paths exercised.
- SZZ: validated against a labelled set of known bug-introducing commits.
- Embedding: quality measured on a labelled semantic-query set.
- Packs: export → import → assert identical query results.
- CLI: golden-output tests.

### Acceptance criteria

- [ ] With GitHub connected, Why confidence rises measurably on the eval set
- [ ] Review comments appear mapped to the correct lines
- [ ] SZZ precision ≥ 0.7 on the labelled set (and is always labelled `Inferred`)
- [ ] Semantic search finds conceptually related code that lexical search misses
- [ ] `excavate why` output is useful in a terminal, and `--json` is stable
- [ ] A pack exported on one machine opens correctly on another
- [ ] Everything still works with no forge configured
- [ ] **v0.2 is released**

### Risks

| Risk | Mitigation |
|---|---|
| GitHub rate limits make sync impractical on large repos | Incremental sync, ETags, prioritize PRs referenced by recent commits, clear progress and staleness UI |
| SZZ produces false attributions | Presented as `Inferred`, never as fact; precision threshold gate; tunable filters |
| Embedding model download is a bad first-run experience | Download in background, on demand, with progress; search degrades to lexical meanwhile |
| Packs leak sensitive information | Explicit pre-write disclosure of contents; `--redact-emails`; documented prominently |

---

## M9 — Symbols, MCP, Decisions, language packs → **v0.3**

### Objectives

Depth (symbol-level history), reach (MCP), and community (language packs).

### Deliverables

1. **Symbol extraction & lineage** — checkpoint parsing, hunk-interval attribution,
   cross-file move detection ([Part 8 §8.3.3](08-domain-model.md)).
2. **Symbol Evolution view** — small-multiples of a function across significant
   revisions, with semantic diff and per-step "what changed."
3. **`?` on symbols** — a new evidence target.
4. **Decisions** — detection candidates, mining, `DecisionKind`, status transitions,
   the Decisions browse view, generated titles and summaries.
5. **`excavate mcp`** — the typed toolset over stdio and HTTP transports, documented
   for agent integration.
6. **Declarative language packs** — the TOML + query format, loader, validation
   tooling (`just test-pack`), and packs for Rust, TypeScript, Python, Go, Java, C#,
   Ruby, C/C++.
7. **`docs/language-packs.md`** — the flagship contribution guide.
8. **Dependency graph view** — Sugiyama layered DAG with cycle detection.

### Testing

- Symbol lineage accuracy ≥ 95% on fixtures with known refactoring histories.
- Decision detection precision on hand-labelled repositories.
- MCP conformance: each tool returns valid, schema-conformant results.
- Language pack validation: each pack extracts the expected symbols from a sample
  file.

### Acceptance criteria

- [ ] Symbol Evolution works for a function that was renamed and moved between files
- [ ] Decisions on react surface recognizable historical decisions
- [ ] An agent configured with `excavate mcp` can answer a history question it
      otherwise could not
- [ ] A new language pack can be added and validated without writing Rust
- [ ] Adding a pack takes a contributor under an hour end to end
- [ ] **v0.3 is released**

### Risks

| Risk | Mitigation |
|---|---|
| Symbol lineage accuracy is too low to be trustworthy | Ship it with visible uncertainty when checkpoint distance is large; withhold the view if accuracy cannot clear 90% |
| Decision detection is noisy | High precision threshold; better to miss decisions than to invent them |
| MCP tool schemas need breaking changes | Version the toolset from day one |

---

## M10 — Polish, performance, accessibility, packaging → **v1.0**

### Objectives

Make it excellent. This milestone is entirely about the difference between "works"
and "the quality bar in Part 2 §2.5."

### Deliverables

1. **Performance pass** — profile every budget; fix every regression; optimize the
   worst three paths.
2. **Accessibility audit** — full manual keyboard pass, screen-reader pass on all
   views, every accessible twin verified, `axe` clean.
3. **Copy pass** — every string reviewed against [Part 12
   §12.11](12-design-system.md); every empty and error state written by a human.
4. **Visual polish** — motion timing, spacing rhythm, icon consistency, focus states,
   dark and light parity.
5. **Onboarding** — first-run flow, `excavate --demo` with a bundled pre-indexed pack,
   in-app tour that can be skipped and re-run.
6. **Documentation** — full user docs, `docs/development.md`, contribution guides,
   troubleshooting, `excavate doctor`.
7. **Website** — excavate.dev with the hosted browser demo (a pre-built pack served
   read-only) and the demo GIF.
8. **Packaging** — signed and notarized macOS, signed Windows, AppImage/deb, Homebrew,
   winget, install script, `npx excavate`, `cargo install`.
9. **Auto-update** for the desktop app.
10. **Error reporting** — local crash reports with a copy button; no transmission.
11. **`excavate doctor`** — comprehensive diagnostics.
12. **Launch materials** — README with the GIF, a technical blog post about the
    Persistent Layout and the citation contract (the two most interesting engineering
    stories), and the Show HN post.

### Testing

- Every performance budget asserted and passing.
- Full accessibility audit, including with an actual screen reader.
- Install tested from every channel on every platform, from a clean machine.
- The Part 6 §6.5 demo script runs as an automated E2E test.
- 10 external testers complete a "understand this unfamiliar repo" task; time and
  friction recorded.

### Acceptance criteria

- [ ] All [Part 13 §13.9](13-technical-architecture.md) budgets met
- [ ] Zero critical accessibility violations; screen-reader pass complete
- [ ] Install → first insight in < 3 minutes for a new user, measured across 10 testers
- [ ] `excavate --demo` works with no repository and no configuration
- [ ] The hosted demo works in a browser with no install
- [ ] Every Part 6 §6.6 acceptance criterion passes
- [ ] **v1.0 is released**

### Risks

| Risk | Mitigation |
|---|---|
| Polish expands without bound | Fixed milestone scope; a "v1.1" list is maintained and things move to it freely |
| Platform-specific bugs surface late | All platforms in CI from M0; manual platform QA scheduled at the start of M10, not the end |
| Launch lands flat | The demo GIF and the technical blog post are built and tested with real readers before launch day |

---

## M11+ — Beyond v1.0

Sequenced but not scheduled; ordering will respond to what users actually ask for.

| Milestone | Contents | Rationale |
|---|---|---|
| **v1.1 Architecture Evolution** | The alluvial view + era-diff narratives | Highest-ceiling visualization; the strongest remaining "wow" |
| **v1.2 Living documentation** | `excavate doc`, drift-detection GitHub Action | New surface (CI), real distribution, natural for maintainers |
| **v1.3 Knowledge Graph** | Focus+context exploration of the evidence graph | Needs the anti-hairball design cycle it deserves |
| **v1.4 Plugin system** | WASM host, analyzer/lens/exporter interfaces, registry | Only once internals have stabilized |
| **v1.5 Time-lapse & sharing** | Playback, animated export, screenshot export | Delight and virality |
| **v1.6 More forges** | GitLab, Gerrit, Bitbucket; Jira/Linear issues | Demand-driven |
| **v2.0 Editor integrations** | VS Code and JetBrains extensions that deep-link into Excavate | Only after the API is stable and versioned |

Perennially deferred, revisited only on strong evidence of demand: multi-repository
workspaces, human annotations, team features.

---

## 15.1 Cross-cutting practices

Applied in every milestone, not scheduled as work.

| Practice | Cadence |
|---|---|
| Perf budgets asserted | Every PR |
| Eval harness (fast subset) | Every PR touching prompts, evidence, or pipelines |
| Eval harness (full) | Nightly |
| Visual regression | Every PR touching UI |
| Accessibility (`axe`) | Every PR |
| Dogfooding — run Excavate on Excavate | Weekly, findings become issues |
| Fixture additions | Whenever a bug is found (fixture first, then fix) |
| ADR written | Before any decision that changes a public contract |
| Docs updated | In the same PR as the change |
| Dependency audit | Weekly, automated |

---

## 15.2 The three decisions that must not be deferred

If these are compromised for schedule, the project fails in ways that are not
recoverable later.

1. **Rename and identity correctness (M1).** Every feature inherits it. A lineage bug
   discovered in M8 means every Why answer since M5 was potentially wrong, and users
   who noticed have already stopped trusting the tool.
2. **URL-as-state and the daemon architecture (M0/M3).** Both are nearly free to build
   in and effectively impossible to retrofit. Skipping either forecloses `serve`, the
   CLI, MCP, editor integrations, and shareable links — which is to say, most of the
   distribution strategy.
3. **The citation contract and the no-key path (M5/M6).** These are the product's
   differentiation. The moment either becomes optional, Excavate is a repo-chat tool
   with a nicer UI, and the entire argument in [Part 4](04-competitive-analysis.md)
   evaporates.

---

## 15.3 What "done" means

v1.0 ships when a developer can:

1. Run one command on a repository they have never seen.
2. Understand, within 15 minutes, what it is, how it evolved, where its complexity
   lives, and who to ask.
3. Select any line and learn why it exists, with evidence they can verify.
4. Do all of that offline, with no account, no API key, and no data leaving the
   machine.
5. Share what they found with a link.

Everything in this specification exists to make those five sentences true.

---

*Appendices: [A — Decision Register](A-decision-register.md) ·
[B — Risk Register](B-risk-register.md) ·
[C — Glossary](C-glossary.md)*
