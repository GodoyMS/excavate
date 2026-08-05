# Part 5 — Feature Brainstorm and Ruthless Evaluation

Three passes: **generate everything**, **kill the weak ideas with reasons**, **rank
the survivors on impact versus effort**.

Scoring scale used throughout:

- **Impact** 1–5 — how much this accelerates understanding for the primary personas.
- **Effort** 1–5 — engineering weeks-of-pain, including correctness edge cases.
- **Verdict** — `MVP` · `v0.2` · `v0.3` · `v1.0` · `LATER` · `CUT`

---

## 5.1 Pass 1 — Generate everything (94 candidates)

### A. Orientation & overview

| # | Feature |
|---|---|
| A1 | Repository Overview — what this project is, size, age, stack, activity |
| A2 | Auto-generated project description from README + code + commits |
| A3 | Cast of characters — who has worked here, when, on what |
| A4 | Language and framework composition over time |
| A5 | "First 5 files to read" recommendation |
| A6 | Repository health signals (evidence-backed, not a score) |
| A7 | Freshness map — what is actively maintained vs. dormant |
| A8 | Onboarding checklist generated from the codebase |
| A9 | Comparable-projects context ("this is a mid-size Rust CLI") |

### B. Narrative

| # | Feature |
|---|---|
| B1 | **The Story** — eras with cited narrative |
| B2 | Automatic era segmentation (change-point detection) |
| B3 | Era naming and summarization via LLM |
| B4 | Architecture sidecar that morphs while scrolling the Story |
| B5 | Per-era "what changed / who / what broke" summary cards |
| B6 | Release notes reconstruction from commits between tags |
| B7 | "Read the repo like a book" continuous scroll mode |
| B8 | Mined **Decisions** — an ADR log the project never wrote |
| B9 | Decision status tracking (active / superseded by / reverted) |
| B10 | Story export to Markdown |
| B11 | Audio narration of the Story |
| B12 | Story diffing between two dates |

### C. Time

| # | Feature |
|---|---|
| C1 | **Interactive Timeline** — scrubbable, global time cursor |
| C2 | Strata ribbon (subsystem activity bands over time) |
| C3 | Release and tag markers |
| C4 | Era boundary markers |
| C5 | Incident markers (revert clusters) |
| C6 | Time-lapse playback with per-file flash on change |
| C7 | Semantic zoom (year → month → week → day) |
| C8 | Two-point comparison mode (diff the repository between dates) |
| C9 | Contributor tenure ribbon |
| C10 | Commit-velocity overlay |
| C11 | Branch topology visualization |
| C12 | "Rewind to this state" — open a read-only worktree at a revision |

### D. Space

| # | Feature |
|---|---|
| D1 | **Repository Map** — stable treemap with Persistent Layout |
| D2 | Lens system (age, churn, ownership, complexity, size, risk) |
| D3 | Knowledge-risk lens (bus factor + owner inactivity) |
| D4 | Test-coverage lens (if coverage data present) |
| D5 | Directory drill-down with breadcrumbs |
| D6 | Search-highlight overlay on the Map |
| D7 | Voronoi treemap variant |
| D8 | City / building 3D metaphor |
| D9 | Minimap for large repos |
| D10 | Side-by-side lens comparison |

### E. The Why engine

| # | Feature |
|---|---|
| E1 | **Why panel** on line / range |
| E2 | Why on file |
| E3 | Why on symbol (function, class) |
| E4 | Why on dependency (why is this package here?) |
| E5 | Why on directory / module |
| E6 | Evidence chain visualization |
| E7 | Confidence rating with enumerated reasons |
| E8 | Revert / re-land pair detection |
| E9 | Fix-follows-feature (SZZ-lite) attribution |
| E10 | PR reference extraction from commit subjects (offline) |
| E11 | PR body + review threads via forge connector |
| E12 | Linked issue resolution |
| E13 | Escalation to agentic investigation (opt-in, priced) |
| E14 | "The debate" — quoted review comments |
| E15 | Why for a whole diff / PR under review |
| E16 | Counter-evidence surfacing ("this contradicts…") |

### F. Code archaeology

| # | Feature |
|---|---|
| F1 | **File Evolution** — one file's whole life |
| F2 | Rename / move tracking with alias chains |
| F3 | Function / symbol evolution ("watch a function grow up") |
| F4 | Line-age heatmap in the code view |
| F5 | Code survival analysis (what fraction of 2019 code remains) |
| F6 | Pure-move / refactor detection |
| F7 | Copy detection across files |
| F8 | Signature-change history for APIs |
| F9 | Deleted-code archaeology (what was here before, and why did it go) |
| F10 | `.git-blame-ignore-revs` support |
| F11 | Blame with `-C -M` copy/move following |
| F12 | Whitespace/format-only commit detection and downweighting |

### G. Structure & architecture

| # | Feature |
|---|---|
| G1 | Module / import dependency graph |
| G2 | Architecture snapshot at any revision |
| G3 | Architecture Evolution alluvial diagram (code mass flowing between modules) |
| G4 | Dependency cycle detection |
| G5 | Layering violation detection |
| G6 | Change-coupling graph (implicit coupling from co-change) |
| G7 | Knowledge Graph (entities + relationships, focus+context) |
| G8 | External dependency timeline (when packages were added/removed/bumped) |
| G9 | Public API surface tracking |
| G10 | Generated / vendored code detection and exclusion |

### H. People

| # | Feature |
|---|---|
| H1 | Ownership model with recency decay |
| H2 | Bus factor per file / module |
| H3 | Knowledge islands (sole author, now inactive) |
| H4 | "Who should I ask" routing |
| H5 | Collaboration graph (who co-edits with whom) |
| H6 | Contributor tenure timeline |
| H7 | Identity merging (`.mailmap` + heuristics) |
| H8 | Expertise search ("who knows about auth?") |
| H9 | ~~Productivity leaderboard~~ |
| H10 | ~~Per-person velocity metrics~~ |

### I. Search & navigation

| # | Feature |
|---|---|
| I1 | **⌘K command bar** |
| I2 | Lexical search over code, commits, messages (BM25) |
| I3 | Semantic search via local embeddings |
| I4 | Hybrid search with reciprocal rank fusion |
| I5 | Temporal search ("when did we start using X?") |
| I6 | Natural-language filters ("files Sam touched in 2023") |
| I7 | Search within the current view |
| I8 | Recent / pinned entities |
| I9 | Deep-linkable URLs for every state |
| I10 | Jump-to-symbol |

### J. Risk & quality

| # | Feature |
|---|---|
| J1 | Hotspots (churn × complexity × recency × fix density) |
| J2 | Change coupling / hidden dependencies |
| J3 | Fix-density per file |
| J4 | Complexity trend over time |
| J5 | Files that always break together |
| J6 | ~~Overall code health score (0–100)~~ |
| J7 | Stale-code detection (untouched + unreferenced) |
| J8 | Refactoring opportunity suggestions |
| J9 | Risk assessment for a proposed change |

### K. Output & integration

| # | Feature |
|---|---|
| K1 | CLI `excavate why <path>:<line>` |
| K2 | MCP server exposing the index as typed tools |
| K3 | `excavate serve` — browser UI, no desktop shell |
| K4 | `.excavate-pack` portable index export |
| K5 | Living documentation generation (`excavate doc`) |
| K6 | GitHub Action: flag docs that drifted from reality |
| K7 | Markdown / PDF report export |
| K8 | Editor extensions (VS Code, JetBrains) |
| K9 | Shareable deep links |
| K10 | Screenshot / image export of visualizations |
| K11 | JSON API for scripting |
| K12 | Terminal UI (TUI) mode |

### L. Platform & extensibility

| # | Feature |
|---|---|
| L1 | Plugin system (WASM analyzers) |
| L2 | Declarative language packs (TOML + tree-sitter queries) |
| L3 | Custom lens plugins |
| L4 | Forge connectors (GitHub, GitLab, Bitbucket, Gerrit) |
| L5 | Issue-tracker connectors (Jira, Linear) |
| L6 | AI provider plugins |
| L7 | UI panel plugins |
| L8 | Multi-repository workspaces |
| L9 | Monorepo scoping (`--scope packages/web`) |
| L10 | Team sync / shared annotations |
| L11 | Human annotations layered on the evidence graph |
| L12 | Index sharing over a URL |

---

## 5.2 Pass 2 — Kill the weak ideas

Each cut with the reason, because unexplained cuts get relitigated.

### Cut on principle (violates Part 2)

| # | Feature | Reason |
|---|---|---|
| H9, H10 | Productivity leaderboards, per-person velocity | Violates P7. Permanent no. Turns every persona against the tool. |
| J6 | Code health score 0–100 | Violates P2. A number with no evidence invites arguing about the number. Replaced by evidence-linked risk signals (J1, J3, H3). |
| L10 | Team sync / shared annotations | Violates P5. Requires accounts, a server, and a sync engine — a different product. |
| A9 | Comparable-projects context | Requires a corpus we do not have and produces a judgment we cannot evidence. |

### Cut as gimmick (fails the one-question test)

| # | Feature | Reason |
|---|---|---|
| B11 | Audio narration | Cool demo, zero comprehension speed-up, large surface area. |
| D8 | 3D city metaphor | The canonical code-viz gimmick. Occlusion and navigation cost exceed information gain. Studied, rejected. |
| D7 | Voronoi treemap | Beautiful, but expensive to compute and — fatally — unstable across time, which breaks the Persistent Layout guarantee. Squarified treemap wins on the only axis that matters. |
| C11 | Branch topology visualization | Every attempt produces a tangle. The useful subset (merge structure) is already captured by the history-projection lens and era detection. |
| K12 | TUI mode | Charming, duplicates the whole UI layer, serves a niche the CLI already covers. |
| D10 | Side-by-side lens comparison | Two half-size maps are worse than one map you can toggle in 100ms. |

### Cut as premature (right idea, wrong time)

| # | Feature | Reason |
|---|---|---|
| L8 | Multi-repo workspaces | Multiplies the domain model's complexity before we have proven single-repo value. |
| J8 | Refactoring suggestions | Prescriptive advice we cannot evidence; drifts into an unrelated product category. |
| J9 | Change risk assessment | Requires a predictive model and validation data. Interesting research, not v1. |
| B12 | Story diffing between dates | Nice, but the Story must exist and be good first. |
| C12 | "Rewind to this state" worktree | Requires write operations on the repo — a safety and scope boundary we deliberately hold. |
| L11 | Human annotations | Introduces a mutable user-data layer with sync/merge questions. Good v2 idea. |
| F7 | Cross-file copy detection | Expensive, and the high-value subset (pure moves, F6) is much cheaper. |

### Cut as absorbed by another feature

| # | Feature | Absorbed into |
|---|---|---|
| A8 | Onboarding checklist | K5 living documentation |
| B6 | Release notes reconstruction | B5 era summary cards + tag markers |
| B7 | Continuous "book" mode | B1 — the Story *is* this |
| I7 | Search within view | I1 ⌘K, scoped |
| D9 | Minimap | D1 Map, at a zoom level |
| C10 | Velocity overlay | C2 strata ribbon |
| G9 | Public API tracking | F8 signature-change history |
| A2 | Auto project description | A1 Overview |
| E15 | Why for a diff under review | E1–E5 composed; a v1.0 packaging, not a new engine |

**Result: 94 candidates → 71 survivors.**

---

## 5.3 Pass 3 — Impact vs. effort

### The matrix

```
IMPACT
  5 │  E1 Why(line)        B1 Story        D1 Map
    │  A1 Overview         C1 Timeline     E6 Evidence chain
    │  I1 ⌘K               E7 Confidence   B2 Era detection
    │                                      F2 Rename tracking
    │                      H1 Ownership    F1 File Evolution
  4 │  E10 PR refs         D2 Lenses       E8 Revert pairs
    │  I2 Lexical search   J1 Hotspots     I3 Semantic search
    │  I9 Deep links       H3 Knowledge islands  K1 CLI why
    │  F10 blame-ignore    E9 SZZ-lite     E11 PR bodies
    │                      H2 Bus factor   B4 Arch sidecar
  3 │  C3 Release markers  G6 Coupling     F3 Symbol evolution
    │  A3 Cast             C2 Strata       G1 Dep graph
    │  H7 Identity merge   K2 MCP          G3 Arch evolution
    │  F12 Format detect   K4 .excavate-pack  B8 Decisions
    │  G10 Vendored detect L2 Language packs  C6 Time-lapse
  2 │  A4 Lang composition K3 serve        G7 Knowledge graph
    │  I8 Recents          K7 Export       L1 WASM plugins
    │  C9 Tenure ribbon    H5 Collab graph K5 Living docs
    │  A5 First 5 files    K10 Screenshot  K8 Editor exts
  1 │  A7 Freshness        D4 Coverage lens  L5 Issue connectors
    │                      C8 Two-point diff  L7 UI plugins
    └──────────────────────────────────────────────────────────
        1        2        3        4        5           EFFORT
```

### Quadrant readings

**Do first (high impact, low-to-moderate effort) — this is essentially the MVP:**
A1 Overview · E1 Why(line) · E6 Evidence chain · E7 Confidence · E10 PR refs ·
I1 ⌘K · I2 Lexical search · I9 Deep links · F10 blame-ignore · C3 Release markers

**Do second (high impact, high effort) — the differentiators worth the pain:**
B1 Story · B2 Era detection · C1 Timeline · D1 Map · D2 Lenses · F2 Rename tracking ·
F1 File Evolution · H1 Ownership · E8 Reverts · J1 Hotspots · I3 Semantic search

**Schedule deliberately (moderate impact, high effort):**
G3 Architecture Evolution · G7 Knowledge Graph · F3 Symbol Evolution · L1 Plugins ·
K5 Living docs · K8 Editor extensions

**Cheap wins to sprinkle in:** A3 Cast · A4 Language composition · I8 Recents ·
K10 Screenshot export · G10 Vendored detection · F12 Format-commit detection

**Strategically weighted above their raw score:** K1 CLI `why`, K2 MCP, K4
`.excavate-pack`. Individually modest impact scores; collectively they are the
distribution strategy from Part 1 §1.4.5. Effort is low *because* the daemon
architecture already exposes everything they need.

---

## 5.4 The ranked build order

| Rank | Feature | I | E | Verdict | Rationale |
|---:|---|:-:|:-:|---|---|
| 1 | E1 Why (line/range) | 5 | 3 | **MVP** | The signature interaction. The product's reason to exist. |
| 2 | B1 The Story | 5 | 4 | **MVP** | The demo. The thing that gets shared. |
| 3 | D1 Repository Map | 5 | 4 | **MVP** | Spatial orientation; carries every lens. |
| 4 | C1 Timeline | 5 | 4 | **MVP** | Global time cursor — architectural, not just a view. |
| 5 | A1 Overview | 5 | 2 | **MVP** | First screen. Cheap. Sets the tone. |
| 6 | E6/E7 Evidence + confidence | 5 | 3 | **MVP** | The trust contract. Non-optional. |
| 7 | I1 ⌘K | 5 | 2 | **MVP** | Speed and discoverability in one component. |
| 8 | F2 Rename tracking | 5 | 4 | **MVP** | Silent correctness prerequisite for everything else. |
| 9 | B2 Era detection | 5 | 4 | **MVP** | Deterministic backbone of the Story. |
| 10 | H1 Ownership model | 4 | 3 | **MVP** | Answers "who do I ask"; feeds two lenses. |
| 11 | D2 Lens system | 4 | 3 | **MVP** | Turns one view into six. |
| 12 | F1 File Evolution | 4 | 3 | **MVP** | Highest-frequency drill-down. |
| 13 | I2 Lexical search | 4 | 2 | **MVP** | ⌘K needs something to search. |
| 14 | E10 PR refs (offline) | 4 | 2 | **MVP** | Free PR linkage from squash-merge subjects. |
| 15 | E8 Revert/re-land | 4 | 2 | **MVP** | Strongest "why" signal in any repo. |
| 16 | I9 Deep links | 4 | 1 | **MVP** | Free if built in; impossible later. |
| 17 | F10 blame-ignore-revs | 4 | 1 | **MVP** | Without it, blame is wrong on formatted repos. |
| 18 | J1 Hotspots | 4 | 3 | **MVP** | The "where is the pain" answer. |
| 19 | H3 Knowledge islands | 4 | 2 | **MVP** | The single most-quoted insight in demos. |
| 20 | I3 Semantic search | 4 | 4 | v0.2 | Local embeddings; lexical carries MVP. |
| 21 | E9 SZZ-lite | 4 | 4 | v0.2 | Powerful, needs careful validation. |
| 22 | E11/E12/E14 Forge connector | 4 | 4 | v0.2 | Biggest single quality jump for Why. |
| 23 | K1 CLI `why` | 3 | 1 | v0.2 | Trivial on top of the daemon; big reach. |
| 24 | K4 `.excavate-pack` | 3 | 2 | v0.2 | Growth loop for OSS maintainers. |
| 25 | B4 Architecture sidecar | 4 | 4 | v0.2 | Makes the Story feel magic. |
| 26 | G6 Change coupling | 3 | 2 | v0.2 | Cheap, surprising, useful. |
| 27 | F3 Symbol evolution | 3 | 5 | v0.3 | Needs mature symbol lineage. |
| 28 | K2 MCP server | 3 | 2 | v0.3 | Strategic. Cheap. Compounding. |
| 29 | B8 Decisions | 3 | 4 | v0.3 | A mined ADR log; needs Why + eras solid. |
| 30 | L2 Language packs | 3 | 3 | v0.3 | Unlocks community contribution. |
| 31 | G1 Dependency graph | 3 | 3 | v0.3 | Prerequisite for architecture views. |
| 32 | G3 Architecture Evolution | 3 | 5 | v1.0 | Iconic if it lands; expensive. |
| 33 | C6 Time-lapse playback | 3 | 3 | v1.0 | Delight; earns the GIF. |
| 34 | G7 Knowledge Graph | 2 | 5 | v1.0 | Needs a real anti-hairball design pass. |
| 35 | K5/K6 Living docs + Action | 2 | 4 | v1.0 | New surface (CI); real distribution. |
| 36 | L1 WASM plugins | 2 | 5 | v1.0 | Design boundary now, implement later. |
| 37 | K8 Editor extensions | 2 | 4 | LATER | Only after the API is stable. |
| 38 | L4 GitLab/Gerrit connectors | 2 | 3 | LATER | Demand-driven. |
| 39 | L5 Jira/Linear connectors | 2 | 3 | LATER | Demand-driven. |
| 40 | L8 Multi-repo | 2 | 5 | LATER | Only with a clear pull. |

Remaining survivors (cheap wins A3, A4, A5, A7, C3, C9, F12, G10, H7, I8, K3, K7,
K10, D5, D6, E2–E5) are folded into the milestones that naturally contain them
rather than being scheduled independently.

---

## 5.5 The features we will be asked for and will decline

Pre-writing the answers saves future maintainer hours:

| Request | Answer |
|---|---|
| "Add per-developer stats" | No — Part 2, P7. Permanent. |
| "Add a chat tab" | No — Part 2, U1. `?` and ⌘K cover the need with better ergonomics. |
| "Add a code health score" | No — Part 2, P2. Use hotspots and knowledge risk, which link to evidence. |
| "Support multiple repos at once" | Not yet — Part 5 §5.2. Revisit with real demand. |
| "Let me edit code in Excavate" | No — out of scope, and read-only is a safety property. |
| "Add a cloud/hosted version" | Only as a read-only demo of pre-built packs. No hosted indexing of private code. |
| "Add JIRA burndown / sprint views" | No — process metrics, not comprehension. |
| "Make it a VS Code extension instead" | No — the visual bandwidth for the Map and Timeline does not exist in a sidebar. An extension that deep-links *into* Excavate is welcome. |

---

*Next: [Part 6 — Final MVP](06-mvp.md)*
