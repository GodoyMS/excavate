# Part 6 — The Final MVP

## 6.1 The MVP thesis

> **v0.1 must make a developer who has never seen this repository understand it
> better in 15 minutes than they would in a day of reading — and it must do that
> with no API key.**

Everything in the MVP either (a) produces that 15-minute outcome, or (b) is a
correctness prerequisite for something that does. Nothing else is in.

Two shipping constraints shape every choice below:

1. **The whole MVP must be demoable in a 90-second screen recording.** If a feature
   cannot appear in that recording, it is not MVP.
2. **The MVP must be fully functional offline with zero configuration.** AI enhances
   two surfaces (Story prose, Why prose). Everything else is deterministic.

---

## 6.2 The eight MVP features

### M1 — `excavate .` and progressive indexing

**What it is.** One command. It resolves the repository, computes a stable
repository ID, checks for an existing index, and either builds or incrementally
updates it. The UI opens *immediately* and streams progress. Progress is
informative, not a spinner:

```
▸ walking history…      12,481 commits · 34 contributors
▸ first commit          2019-05-02 by Dana R.
▸ tracking renames…     1,207 files (218 renamed at least once)
▸ computing ownership…  bus factor ≤1 on 9 files
▸ detecting eras…       6 eras found
✓ ready in 41s
```

**Tiered indexing** (detailed in [Part 9 §9.3](09-data-architecture.md)):

| Tier | Contents | Target |
|---|---|---|
| T0 | Commits, people, refs, tags, path changes | Seconds — UI usable |
| T1 | Hunks, renames, ownership, coupling, hotspots, eras | Tens of seconds |
| T2 | Embeddings, symbol index | Background, non-blocking |
| T3 | AI artifacts (Story prose, Why prose) | On demand |

**Why it exists.** The first 60 seconds decide whether anyone ever opens the app
again. Progressive indexing is what makes "one command" honest on a large repo, and
the informative progress is the first delight moment.

---

### M2 — Overview

**What it is.** The landing screen. One scroll, no configuration:

- What this project is (README-derived + language composition + entry points).
- Vital statistics: age, commits, contributors (active vs. total), size, activity
  trend.
- **Cast of characters** — who is active now, who was foundational, tenure ribbon.
- **Where the complexity lives** — top hotspots, each linking to evidence.
- **What needs attention** — knowledge islands, files with high fix density.
- **Recent activity** — last 30 days summarized.
- Jump-off points into Story, Map, Timeline.

**Why it exists.** Persona 3.1 (Priya) needs a 5-minute orientation before anything
else is meaningful. It is also the cheapest high-impact feature in the product
(impact 5, effort 2).

**AI involvement:** none required. A one-paragraph project characterization is
AI-enhanced when a provider is configured; without one, it falls back to a
structured template.

---

### M3 — The Story

**What it is.** The narrative view. Repository history segmented into 3–12 named
eras, presented as a vertical scroll with a pinned architecture sidecar.

Per era:

- A generated name and 2–4 sentence characterization, every sentence cited.
- Date range, commit count, dominant contributors, releases in window.
- **The commits that mattered** — top-N by deterministic significance score.
- **What broke** — reverts and incident clusters in the window.
- **What changed structurally** — directories born, died, renamed, or exploded.
- The architecture sidecar updates as that era scrolls into view.

**Deterministic backbone.** Era boundaries come from PELT change-point detection over
a multivariate weekly activity series (commit rate, author churn, tree entropy,
language mix drift, dependency-manifest events, revert rate), snapped to salient
events. Full algorithm in [Part 10 §10.4.2](10-ai-architecture.md). The LLM *names
and narrates* eras; it never decides where they are.

**No-key fallback.** Eras still appear, with template-generated names ("2021 Q2 –
2022 Q1 · 3,104 commits · dominated by the `web/` rewrite") and evidence cards. The
prose is what is missing, not the structure.

**Why it exists.** This is the demo. It is also the only artifact in the market that
answers "how did this codebase get this way" as a readable document.

---

### M4 — Timeline

**What it is.** A horizontally scrollable strata ribbon at the bottom of the app,
persistent across views.

- **X** = time, with semantic zoom (year → quarter → month → week → day).
- **Y** = auto-clustered subsystems (top-level directories, merged by co-change).
- **Band thickness** = activity volume; **color** = the active lens.
- **Overlays:** release tags, era boundaries (rendered as geological strata lines),
  revert clusters as incident markers.
- **Interaction:** drag to scrub the global time cursor; `[` and `]` step; click a
  marker to jump; drag a range to filter every other view.

**Architectural significance.** The Timeline owns the global time cursor (Part 2,
U3). It is not a view; it is a control surface for the entire application.

**Why it exists.** Time is the axis the entire product is organized around, and it
needs a persistent, always-visible representation or the concept stays abstract.

---

### M5 — Repository Map with lenses

**What it is.** A stable squarified treemap of the repository. Cells are files;
nesting is directory structure; area is lines of code.

**The Persistent Layout guarantee.** Layout is computed once at `HEAD` (or at a
pinned reference revision) and cached. Scrubbing time does not re-flow the layout —
files fade in when born and fade out when deleted, in their fixed positions. This is
the single decision that makes the Map legible over time.

**MVP lenses:**

| Lens | Encodes | Answers |
|---|---|---|
| Age | Time since last meaningful change | What is fossilized vs. alive? |
| Churn | Change frequency in the visible window | Where is the action? |
| Ownership | Dominant owner (categorical, ≤8 colorblind-safe hues + "contested") | Whose territory is this? |
| Complexity | Size × nesting proxy | Where is the mass? |
| Hotspot | churn × complexity × fix density | Where is the pain? |
| Knowledge risk | Bus factor × owner inactivity | What will hurt when someone leaves? |

Switching a lens is a color re-map only — under 100ms, no relayout, animated as a
cross-fade.

**Interaction:** hover for a rich tooltip; click to select (drives every other
panel); double-click to drill into a directory; `⌘F` overlays search results.

**Accessible twin:** a toggle to a sortable table with the same columns (U9).

**Why it exists.** Spatial memory is how humans hold large systems. Nothing else in
the product gives you the whole codebase in one glance.

---

### M6 — Why

**What it is.** The signature interaction, available everywhere via `?` or ⌥-click.

Targets in MVP: **line/range**, **file**, and **directory**. (Symbol and dependency
targets land in v0.3.)

The panel:

1. **The answer** — 2–4 sentences, every sentence carrying an evidence marker. If no
   provider is configured, this section shows the top-ranked evidence items directly
   instead of prose.
2. **The chain** — a vertical causal timeline: introduced → modified → reverted →
   re-landed → fixed, each entry linking to the commit and diff.
3. **The debate** — quoted review comments, when a forge connector is configured
   (v0.2). In MVP: the full commit body and any detected PR reference.
4. **Confidence** — HIGH / MEDIUM / LOW with enumerated reasons ("PR body available",
   "revert pair found", "commit message is uninformative").
5. **Investigate further** — an opt-in escalation with a cost estimate (v0.2).

**Deterministic evidence assembly** (Part 10 §10.5) supplies the bundle: blame with
`-C -M` and `.git-blame-ignore-revs`, the introducing commits, sibling changes in the
same commit, adjacent comment text, temporal neighbours on the same lines, revert
pairs, co-change partners, and any PR/issue reference mined from commit subjects and
trailers.

**Why it exists.** This is the product. Everything else is scaffolding around it.

---

### M7 — File Evolution

**What it is.** The drill-down for a single file's entire life, on one screen.

- **Life ribbon** — created, renamed (with previous names), major rewrites, reverts,
  deleted-and-resurrected, current state.
- **Churn sparkline** with releases and incidents marked.
- **Authorship over time** — a stacked band showing who owned it when.
- **The commits that mattered** — ranked by significance, not chronology.
- **Line-age heatmap** in the embedded read-only code view, with `?` on any line.
- **Co-change partners** — "this file changes with these three, 71% of the time."

**Why it exists.** It is the highest-frequency drill-down: the user clicks a Map
cell, a search result, or a hotspot, and lands here. It also makes rename tracking
visible, which is where the correctness investment becomes user-facing value.

---

### M8 — ⌘K command bar

**What it is.** One input, four result classes, ranked and interleaved:

- **Commands** — "Open Story", "Switch lens to knowledge risk", "Set time to 2021-06".
- **Entities** — files, directories, people, releases, eras.
- **Content** — commit messages and code, via BM25 (Tantivy).
- **Temporal** — recognized date expressions ("June 2021", "before v2.0").

Recents and pins at rest. Results under 50ms. Every result is a navigation with a
deep link.

**Why it exists.** It is how power users move, it is how features get discovered
without menu clutter, and it makes the whole app feel fast.

---

## 6.3 The correctness prerequisites (invisible, non-negotiable)

These ship in MVP without being features. Each is a silent trust dependency.

| Prerequisite | Why it cannot wait |
|---|---|
| **Rename/move tracking** with alias chains | Without it, File Evolution lies and blame chains truncate at the rename. Instantly disqualifying. |
| **Identity merging** (`.mailmap` + email normalization + name similarity) | Otherwise "Dana R." appears five times and ownership is nonsense. |
| **`.git-blame-ignore-revs` support** | Without it, every line in a Prettier-formatted repo blames to the formatting commit. |
| **Format-only and bulk-commit detection** | Otherwise "most significant commits" = the license-header sweep. |
| **Generated / vendored path detection** | Otherwise `dist/` and `vendor/` dominate every metric. |
| **Merge-commit and history-projection handling** | The DAG is not a line. The user picks a projection (first-parent / topological); every view respects it. |
| **Commit-graph with generation numbers** | Ancestry queries must be fast or time-filtered views are unusable. |
| **Incremental re-index** | Reopening a repo must take a second, not a minute. |

---

## 6.4 What is explicitly excluded from MVP, and why

| Excluded | Rationale | Lands in |
|---|---|---|
| **Semantic search** | Lexical + entity search covers navigation. Embeddings add a model download, a background job, and a whole quality dimension to tune. | v0.2 |
| **Forge connector (PR bodies, reviews)** | Requires auth, rate-limit handling, caching, and a token UX. The offline PR-reference mining gets ~70% of the value for ~10% of the work. | v0.2 |
| **SZZ-lite bug attribution** | Genuinely powerful, genuinely easy to get subtly wrong. Shipping a wrong attribution is worse than shipping none. Needs a validation pass. | v0.2 |
| **Symbol / function evolution** | Depends on mature symbol lineage across renames and refactors. Half-working is misleading. | v0.3 |
| **Knowledge Graph** | Needs a real anti-hairball design cycle. Shipping a tangle would undercut the visual credibility the Map earns. | v1.0 |
| **Architecture Evolution alluvial** | Highest-ceiling visualization in the product; also the most expensive. Deserves its own milestone, not a rushed corner of v0.1. | v1.0 |
| **Plugin system** | Public extension APIs are permanent. Freezing one before the internals settle guarantees breaking changes. Boundaries are *designed* in MVP; the host ships later. | v1.0 |
| **Living documentation + GitHub Action** | A new surface (CI) with its own testing story. | v1.0 |
| **MCP server** | Two days of work — but only once the query API is stable, or we ship a tool contract we must then break. | v0.3 |
| **Editor extensions** | Same reason, one step further out. | LATER |
| **Multi-repo, annotations, team features** | Part 5 §5.2. | LATER / never |

---

## 6.5 The MVP demo script (90 seconds)

Written now because it is a design constraint, not marketing.

| Time | Action | Point being made |
|---|---|---|
| 0:00 | `excavate .` in a terminal on a well-known OSS repo | One command, no setup |
| 0:05 | Progress streams real facts; window opens at ~T0 | Fast, and interesting while it works |
| 0:12 | Overview: age, cast, hotspots, "3 knowledge islands" | Immediate non-obvious insight |
| 0:25 | Click **Story**; scroll two eras; architecture sidecar morphs | The wow |
| 0:45 | Click **Map**; toggle age → churn → knowledge risk | Spatial comprehension, one keystroke apart |
| 0:58 | Drag the **Timeline** back two years; Map animates in place | Persistent Layout — time travel that reads |
| 1:08 | Click a red cell → File Evolution; note two reverts | Drill-down with history |
| 1:15 | Cursor on a line → press `?` | The signature interaction |
| 1:20 | Why panel: answer, chain, PR #412, revert/re-land, HIGH confidence | Cited. Verifiable. Trustworthy. |
| 1:30 | Cut to terminal: `excavate why src/x.ts:42` prints the same answer | It is infrastructure, not just an app |

If any of these ten beats does not work flawlessly, v0.1 is not ready.

---

## 6.6 MVP acceptance criteria

Objective and testable. All must pass.

**Functional**

1. `excavate .` works on: a fresh clone, a repo with uncommitted changes, a shallow
   clone, a repo with submodules, a repo with a `.mailmap`, a repo with
   `.git-blame-ignore-revs`, a repo with 1 commit, and a repo with 500k+ commits.
2. Every one of M2–M8 is reachable by keyboard alone.
3. Every view state round-trips through a URL.
4. With no network and no API key: all of M1–M8 function; only generated prose is
   absent, replaced by structured fallbacks.
5. Every displayed metric has a click-through to its supporting evidence.
6. Every Why answer with prose passes citation validation (100% of sentences carry a
   resolvable evidence ID) or is downgraded to the structured fallback.

**Performance** (on the reference corpus, Part 13 §13.9)

7. Time to first meaningful UI: < 2s on a 10k-commit repo.
8. T1 index completion: < 60s on a 50k-commit repo (8-core reference machine).
9. Re-open of an already-indexed repo: < 1.5s to interactive.
10. Map pan/zoom: 60fps with 20k visible cells.
11. ⌘K first results: < 50ms.
12. Steady-state RSS: < 500MB on a 100k-commit repo.
13. Index size on disk: < 5% of `.git`.

**Correctness**

14. Rename tracking: 100% pass on the fixture corpus, including rename-with-edit,
    rename chains, and rename-across-merge.
15. Identity merging: correct on the `.mailmap` fixtures and on the name-variant
    fixtures.
16. Blame chains skip `.git-blame-ignore-revs` entries.
17. Era boundaries are stable — reindexing the same repo produces identical
    boundaries.
18. Significance ranking excludes format-only, generated, and vendored commits from
    the top-50 on all fixture repos.

**Quality**

19. Zero unstyled empty states; zero raw error strings surfaced to the user.
20. `axe` passes with no critical violations; every canvas view has a working
    accessible twin.
21. Cold install to first insight, for a person who has never used it: under 3
    minutes, verified with 5 external testers.

---

## 6.7 Why this is the right MVP

**It is coherent, not a feature list.** Overview orients → Story explains → Timeline
and Map let you explore → File Evolution drills in → Why answers → ⌘K connects it
all. Remove any one and the loop breaks. That coherence is what will make it feel
like a product rather than a demo.

**It front-loads the hard, invisible work.** Rename tracking, identity merging, and
significance scoring are the least fun and most load-bearing pieces. Doing them in
v0.1 means every later feature inherits correctness instead of inheriting debt.

**It proves the thesis with the cheapest possible surface.** If the Story and the
Why panel do not make people say "I need this," no amount of knowledge graphs will
save it. Better to learn that at 8 features than at 30.

**It ships something people can love before it ships something people can extend.**
Plugins, connectors, and integrations all multiply a core that has to be worth
multiplying first.

---

*Next: [Part 7 — Product Architecture](07-product-architecture.md)*
