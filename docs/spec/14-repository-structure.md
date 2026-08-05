# Part 14 — Repository Structure

A Cargo workspace and a pnpm workspace in one repository, because the type-generation
step and the release pipeline both need to see Rust and TypeScript together.

---

## 14.1 The tree

```
excavate/
├── Cargo.toml                  # workspace root
├── Cargo.lock
├── rust-toolchain.toml
├── package.json                # pnpm workspace root
├── pnpm-workspace.yaml
├── justfile                    # task runner
├── deny.toml                   # cargo-deny policy
├── LICENSE                     # Apache-2.0
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
│
├── crates/
│   ├── excavate-cli/           # the `excavate` binary
│   ├── excavate-daemon/        # excavated — HTTP/WS server + orchestration
│   ├── excavate-core/          # shared types, IDs, errors, time
│   ├── excavate-proto/         # API types + specta TS generation
│   ├── excavate-git/           # GitBackend trait + gix/cli implementations
│   ├── excavate-index/         # walk pipeline, sinks, incremental
│   ├── excavate-store/         # SQLite schema, migrations, queries
│   ├── excavate-analysis/      # deterministic analyzers
│   ├── excavate-evidence/      # collectors, ranking, bundles
│   ├── excavate-lang/          # tree-sitter, symbols, imports, packs
│   ├── excavate-search/        # tantivy + usearch + fusion
│   ├── excavate-ai/            # providers, pipelines, prompts, budget, evals
│   ├── excavate-forge/         # GitHub/GitLab connectors
│   ├── excavate-layout/        # treemap/force/dag/alluvial (native + wasm)
│   ├── excavate-plugin/        # WASM host (v1.0)
│   ├── excavate-mcp/           # MCP server (v0.3)
│   └── excavate-testkit/       # fixture DSL, corpora, assertions
│
├── apps/
│   ├── web/                    # the React application
│   └── desktop/                # Tauri v2 shell
│
├── packages/
│   ├── api/                    # @excavate/api — generated client
│   ├── ui/                     # @excavate/ui — design system
│   ├── canvas/                 # @excavate/canvas — WebGL2 scene renderer
│   ├── viz/                    # @excavate/viz — Timeline, Map, graphs
│   └── plugin-sdk/             # @excavate/plugin-sdk (LATER)
│
├── packs/                      # declarative language packs
│   ├── rust.toml
│   ├── typescript.toml
│   ├── python.toml
│   ├── go.toml
│   └── queries/
│       ├── rust/{symbols,imports,comments}.scm
│       └── …
│
├── prompts/                    # versioned prompt templates
│   ├── why/{v1,v2,v3}.md
│   ├── era_narration/{v1,v2}.md
│   ├── commit_enrichment/v1.md
│   ├── decision_summary/v1.md
│   └── cluster_label/v1.md
│
├── evals/
│   ├── golden/                 # 200 labelled cases
│   ├── harness/
│   └── results/                # committed — quality history in git
│
├── fixtures/
│   ├── generated/              # produced by the DSL at test time
│   └── corpora.toml            # pinned reference repositories
│
├── migrations/                 # 0001_init.sql … NNNN_*.sql
│
├── docs/
│   ├── spec/                   # this specification
│   ├── adr/                    # architecture decision records
│   ├── schema.md               # GENERATED from migrations
│   ├── api.md                  # GENERATED from excavate-proto
│   ├── language-packs.md       # the contribution guide that matters most
│   ├── plugins.md
│   └── development.md
│
├── website/                    # excavate.dev — docs + hosted demo
│
└── .github/
    ├── workflows/
    │   ├── ci.yml              # test, lint, typecheck, generated-file drift
    │   ├── perf.yml            # budget assertions on tiered corpora
    │   ├── evals.yml           # AI eval harness
    │   ├── visual.yml          # visual regression
    │   └── release.yml         # cargo-dist + tauri + signing
    └── ISSUE_TEMPLATE/
```

---

## 14.2 Crates

Ordered by dependency depth. **The dependency graph is acyclic and enforced by
`cargo-deny`'s `bans` section plus a custom CI lint** — a crate may only depend on
crates listed above it.

| Crate | Depth | Responsibility | Depends on |
|---|:-:|---|---|
| `excavate-core` | 0 | ID newtypes, `Timestamp`, `Oid`, error types, `Result`, time utilities. No I/O, no deps beyond std + serde. | — |
| `excavate-proto` | 1 | Every type crossing the API boundary. `specta` derives. The `just gen-types` target emits `packages/api/src/generated.ts`. | core |
| `excavate-testkit` | 1 | The `repo!` fixture DSL, corpus management, custom assertions, deterministic clocks. | core |
| `excavate-git` | 1 | `GitBackend` trait; `GixBackend`; `CliBackend`; `HybridBackend`. Mailmap and blame-ignore parsing. | core |
| `excavate-store` | 1 | Schema, migrations, connection pool, typed queries, bulk-load helpers, rollup writers. | core |
| `excavate-lang` | 1 | Language pack loading, tree-sitter parser registry, symbol/import/comment extraction, complexity proxies. | core |
| `excavate-layout` | 1 | Treemap, force, DAG layering, alluvial geometry, timeline bucketing. `crate-type = ["cdylib", "rlib"]` for the WASM build. | core |
| `excavate-index` | 2 | The walk driver, `WalkSink` fan-out, rename resolution, identity merging, tier scheduling, incremental detection. | core, git, store, lang |
| `excavate-analysis` | 3 | Significance, ownership decay, coupling, hotspots, PELT eras, revert pairs, SZZ, noise classification. Each an `Analyzer`. | core, store, index |
| `excavate-search` | 3 | Tantivy index management, usearch lifecycle, RRF fusion, query parsing. | core, store, lang |
| `excavate-forge` | 3 | `ForgeConnector` trait; GitHub (v0.2); GitLab, Gerrit (LATER). Cache, rate limits, auth. | core, store |
| `excavate-evidence` | 4 | Collectors, ranking, budget fitting, bundle hashing, confidence computation. | core, store, git, analysis, forge |
| `excavate-ai` | 5 | `LanguageModel` / `EmbeddingModel` traits, provider impls, the seven pipelines, prompt assembly and caching, budget accounting, citation validation, the eval harness. | core, evidence, store |
| `excavate-plugin` | 5 | WASM component host, capability model, analyzer/lens/exporter interfaces. | core, store, analysis |
| `excavate-mcp` | 6 | MCP server exposing the typed query toolset. | core, proto, evidence, search, store |
| `excavate-daemon` | 6 | Axum routes, WebSocket hub, job scheduler, repo session lifecycle, progress bus, auth. | everything |
| `excavate-cli` | 7 | `clap` command tree, daemon supervision, terminal rendering for `why`/`doctor`/`cost`. | daemon, proto |

### Notable crate details

**`excavate-core` must stay tiny.** It is depended on by everything, so every
dependency it takes is a dependency everything takes. Rule: std, `serde`,
`thiserror`, `smallvec`, and nothing else without an RFC.

**`excavate-layout` compiles twice.** Native for the daemon's cached one-shot
layouts; `wasm32-unknown-unknown` for the browser worker's interactive layouts. The
WASM build is produced by `just build-wasm` and lands in `packages/viz/wasm/`.
Identical code means no drift between a cached layout and a recomputed one.

**`excavate-testkit` is a normal dependency, not a dev-dependency**, of crates that
need to expose fixture builders in their own public test helpers. It is excluded from
release builds by a feature flag.

**`excavate-daemon` is the only crate that knows about all the others.** This is
deliberate: it is the composition root, and keeping composition in exactly one place
is what keeps the rest of the graph clean.

---

## 14.3 Frontend packages

| Package | Contents | Depends on |
|---|---|---|
| `@excavate/api` | Generated types + a thin typed fetch/WS client + TanStack Query hooks. **`generated.ts` is checked in and CI-verified against a fresh generation.** | — |
| `@excavate/ui` | Design tokens as CSS variables, Radix-based primitives, domain components (`CommitRef`, `EvidenceCard`, `ConfidenceBadge`, …), the icon set. Storybook. | — |
| `@excavate/canvas` | The WebGL2 scene renderer: `Scene`, `Layer`, `Camera`, instanced primitives, ID-buffer picking, R-tree spatial index, Canvas2D fallback. Framework-agnostic. | — |
| `@excavate/viz` | React components wrapping canvas: `<RepositoryMap>`, `<Timeline>`, `<DependencyGraph>`, `<Alluvial>`, `<Sparkline>`, plus the layout worker and its WASM binding. | api, ui, canvas |
| `@excavate/plugin-sdk` | Types and helpers for UI plugin authors. *(LATER)* | api, ui |

**`apps/web`** structure:

```
apps/web/src/
├── main.tsx
├── router.tsx                  # URL is state (Part 12 §12.2.3)
├── views/
│   ├── overview/ story/ map/ timeline/ files/ search/ people/ decisions/
├── panels/
│   ├── inspector/ why/ context/
├── shell/
│   ├── AppShell.tsx CommandBar.tsx StatusBar.tsx TimelineBand.tsx
├── state/
│   ├── time.ts selection.ts lens.ts preferences.ts
├── hooks/
└── lib/
```

**`apps/desktop`** is intentionally ~600 lines: window creation, daemon spawn and
supervision, `excavate://` protocol registration, native menus, auto-update,
keychain bridging. Any logic that appears here is a bug — it belongs in the daemon or
the web app so that `serve` mode has it too.

---

## 14.4 Naming conventions

### Rust

- Crates: `excavate-<domain>`, kebab-case.
- Modules: `snake_case`, singular (`evidence`, not `evidences`).
- Types: `PascalCase`. ID newtypes always `<Entity>Id`.
- Traits: capability names (`GitBackend`, `Analyzer`, `EvidenceCollector`,
  `LanguageModel`) — never `IFoo` or `FooTrait`.
- Errors: one `Error` enum per crate with `thiserror`; `excavate-core::Error` at the
  boundary.
- Feature flags: `kebab-case` (`local-embeddings`, `forge-github`).
- Async functions do not carry an `async_` prefix.

### TypeScript

- Files: `PascalCase.tsx` for components, `camelCase.ts` for everything else.
- Components: `PascalCase`. Hooks: `useThing`.
- Generated types are re-exported from `@excavate/api`; **never redefine a Rust type
  by hand** (Part 13 §13.6).
- CSS custom properties: `--<category>-<name>` (`--fg-secondary`, `--seq-3`).

### Domain vocabulary

Consistent everywhere — code, UI, docs, and CLI. This list is normative:

| Term | Means | Never called |
|---|---|---|
| **Era** | A detected period of repository history | phase, chapter, period |
| **Lens** | A coloring/scoring function over the Map | view mode, filter, overlay |
| **Evidence** | A citable fact with a locator | source, reference, citation |
| **Bundle** | A ranked collection of evidence for a target | context, payload |
| **Target** | The thing a Why question is about | subject, entity |
| **Significance** | The commit importance score | weight, rank, priority |
| **Knowledge** | Recency-decayed familiarity of a person with a file | expertise score, ownership points |
| **Knowledge island** | Bus-factor-1 file whose owner is inactive | orphan, abandoned code |
| **Projection** | The chosen linearization of the DAG | view, mode |
| **Pack** | A portable exported index | bundle, archive, snapshot |

The last column matters as much as the second. Vocabulary drift between the CLI, the
UI, and the docs is how a product starts feeling incoherent.

### Files and paths

- Migrations: `NNNN_snake_case_description.sql`, zero-padded to 4.
- Prompts: `prompts/<pipeline>/v<N>.md`.
- Language packs: `packs/<language>.toml` with queries in
  `packs/queries/<language>/`.
- ADRs: `docs/adr/NNNN-kebab-title.md`.

---

## 14.5 Generated artifacts

Checked in, and CI fails if regeneration produces a diff. Checking them in makes
review meaningful and lets consumers read them on GitHub; verifying them prevents
drift.

| Artifact | Generated from | Command |
|---|---|---|
| `packages/api/src/generated.ts` | `excavate-proto` via specta | `just gen-types` |
| `docs/schema.md` | `migrations/*.sql` | `just gen-schema` |
| `docs/api.md` | route macros + proto | `just gen-api-docs` |
| `packages/viz/wasm/` | `excavate-layout` | `just build-wasm` |
| `evals/results/*.json` | eval harness | `just eval` |

---

## 14.6 The task surface

```
just dev           # daemon (watch) + vite, wired together
just dev-desktop   # + Tauri shell
just test          # rust + js + fixtures
just test-fast     # unit + property only
just fixtures      # regenerate fixture repos
just perf          # perf budgets against tiered corpora
just eval          # AI eval harness (fast subset)
just eval-full     # full 200-case set
just visual        # visual regression
just lint          # clippy + eslint + prettier + rustfmt
just gen           # all generated artifacts
just release       # version bump, changelog, tag
just demo          # index the bundled demo repo and open it
```

`just dev` must be the only command a new contributor needs. If it is not, that is a
bug in the repository, not in the contributor.

---

## 14.7 Contribution paths

Documented in `CONTRIBUTING.md`, ordered by expected volume, with the friction
deliberately front-loaded onto the rarest path.

| Path | Difficulty | What it takes |
|---|---|---|
| **Language pack** | ⭐ | A TOML file and three tree-sitter queries. No Rust. `just test-pack <lang>` validates it. `docs/language-packs.md` is the flagship contribution guide. |
| **UI component / polish** | ⭐⭐ | `just dev`, edit React, Storybook for isolation |
| **New lens** | ⭐⭐ | One scoring function + a color scale + a legend |
| **Evidence collector** | ⭐⭐⭐ | Implement `EvidenceCollector`, add eval cases |
| **Analyzer** | ⭐⭐⭐ | Implement `Analyzer`, add fixtures and property tests |
| **Forge connector** | ⭐⭐⭐ | Implement `ForgeConnector` + a cassette-based test suite |
| **AI provider** | ⭐⭐⭐ | Implement `LanguageModel`, declare capabilities honestly, pass the eval harness |
| **Core (index, git, evidence ranking)** | ⭐⭐⭐⭐⭐ | RFC in `docs/adr/`, discussion, then implementation |

**A language pack PR should be mergeable in under an hour of maintainer time.** That
target shapes the design of the pack format, the validation tooling, and the review
checklist — and it is what determines whether Excavate supports 8 languages or 60.

---

*Next: [Part 15 — Execution Plan](15-execution-plan.md)*
