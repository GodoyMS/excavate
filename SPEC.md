# Excavate — Software Specification

> **Git tells you what changed. Excavate tells you why.**

**Status:** Draft 1.0 · **Date:** 2026-08-04 · **Working name:** Excavate

> ⚠️ **Building this solo? Start with these two, in order.**
>
> 1. **[LEAN-V1.md](docs/spec/LEAN-V1.md)** — the scope and stack for a one-engineer
>    build. Keeps the whole product thesis; cuts the machinery roughly in half.
> 2. **[ROADMAP.md](docs/spec/ROADMAP.md)** — the operative execution plan. Nine
>    milestones, each ending in a public release. First artifact week 2, first useful
>    product week 5, v1.0 at week 17.
>
> This document (Parts 1–15) is scoped for a team of 3–4 and remains the reference for
> product reasoning, domain model, and design detail. Where they conflict:
> **ROADMAP > LEAN-V1 > SPEC.**

---

## The one-sentence pitch

Excavate turns any Git repository into **a story you can read, a map you can explore, and a question you can ask** — with receipts on every claim.

## The 60-second demo (the thing that earns the stars)

```
$ excavate .
  ▸ reading 12,481 commits… 34 contributors… first commit 2019-05-02 by Dana R.
  ▸ 6 eras detected · 214 hotspots · 3 knowledge islands
  ▸ ready in 41s — opening Excavate
```

A desktop window opens on **The Story**: a scrollable, cited narrative of how this
codebase came to be, with an architecture diagram pinned alongside that morphs as
you scroll through time. You scroll to *"The TypeScript Migration (2021 Q2 – 2022
Q1)"* and see which 40 of 12,481 commits actually mattered, who drove it, what
broke, and what got reverted.

Then you open any file, put the cursor on any line, and press `?`:

```
WHY does this line exist?
──────────────────────────────────────────────
Retry-with-jitter was added after a webhook storm took down the
delivery worker. [E1][E2]

  ● 2021-08-14  a1b2c3d  "fix: add jitter to webhook retry (#412)"
                └ PR #412 · 9 review comments · closes issue #398
  ● 2021-08-14  reverted  9f8e7d6  "revert: retry loop hammered upstream"
  ● 2021-08-16  re-landed 4c5d6e7  with the jitter this line implements

  Confidence: HIGH — PR body, linked issue, and a revert/re-land pair
```

That is the product. Everything else in this document serves those two moments.

---

## How to read this specification

The document is split into 15 numbered parts plus appendices. Parts 1–6 define
**what we are building and why**. Parts 7–14 define **how it is built**. Part 15
is the implementation roadmap, written so another engineer — or another AI agent —
can execute it milestone by milestone without ambiguity.

| # | Part | What it answers |
|---|------|-----------------|
| 1 | [Product Vision](docs/spec/01-vision.md) | What is Excavate? Why should anyone care? What makes it new? |
| 2 | [Product Principles](docs/spec/02-principles.md) | The philosophy that settles arguments later |
| 3 | [User Personas](docs/spec/03-personas.md) | Who uses it, in what workflow, against what pain |
| 4 | [Competitive Analysis](docs/spec/04-competitive-analysis.md) | GitHub, GitLens, Sourcegraph, Cursor, Claude Code, Graphite, and the rest |
| 5 | [Feature Brainstorm](docs/spec/05-feature-brainstorm.md) | 94 candidate features, ruthlessly scored and cut |
| 6 | [Final MVP](docs/spec/06-mvp.md) | The eight things v0.1 ships, and why everything else waits |
| 7 | [Product Architecture](docs/spec/07-product-architecture.md) | Subsystems, boundaries, contracts, extension points |
| 8 | [Domain Model](docs/spec/08-domain-model.md) | Entities, relationships, identity, events, invariants |
| 9 | [Data Architecture](docs/spec/09-data-architecture.md) | Indexing, storage, incremental update, query, cache |
| 10 | [AI Architecture](docs/spec/10-ai-architecture.md) | Provider abstraction, seven pipelines, evidence, cost, evals |
| 11 | [Visualization Architecture](docs/spec/11-visualization-architecture.md) | Timeline, Map, graphs — rendering, layout, interaction, perf |
| 12 | [UI/UX Design System](docs/spec/12-design-system.md) | Navigation, layout, tokens, motion, keyboard, accessibility |
| 13 | [Technical Architecture](docs/spec/13-technical-architecture.md) | Every technology choice with alternatives and trade-offs |
| 14 | [Repository Structure](docs/spec/14-repository-structure.md) | The monorepo, crate by crate, package by package |
| 15 | [Execution Plan](docs/spec/15-execution-plan.md) | 11 milestones with deliverables, tests, acceptance criteria, risks |

**Appendices**

| # | Appendix | Contents |
|---|----------|----------|
| A | [Decision Register](docs/spec/A-decision-register.md) | Every load-bearing decision, its alternatives, and its reversal cost |
| B | [Risk Register](docs/spec/B-risk-register.md) | What kills this project, and the mitigation for each |
| C | [Glossary](docs/spec/C-glossary.md) | Era, Evidence, Lens, Significance, Knowledge Island, and friends |

---

## Executive summary

### The problem

Every developer has lived this: you inherit a codebase, you find a function that
looks wrong, and you have no idea whether it is wrong or whether it is load-bearing
for a reason nobody wrote down. `git blame` gives you a name and a date. The commit
message says `fix stuff`. The author left in 2022. So you either change it and break
production, or you leave it alone and the mystery compounds.

The knowledge exists — it is scattered across commit bodies, PR debates, revert
pairs, linked issues, co-change patterns, and the shape of the diff itself. It is
just not *assembled*. Assembling it by hand takes hours per question, so nobody
does it, and codebases become archaeology sites nobody has time to dig.

### The insight

**"Why" is a reconstruction problem, not a lookup problem.** No single source has
the answer; the answer is a chain of evidence across sources. That chain can be
built deterministically — blame → introducing commit → PR reference → review thread
→ revert/re-land pair → the fix that followed → the test that was added alongside.
An LLM is then narrating over *verified* evidence rather than guessing.

This yields Excavate's non-negotiable contract:

> **Every claim Excavate makes is traceable to a commit SHA, a line range, a PR
> number, or an issue. Uncited assertions are a bug, not a style preference.**

That contract is the whole differentiator versus "AI chat over a repo." It is what
makes a senior engineer trust the tool enough to recommend it.

### The product

Three verbs, one connective tissue.

- **Read** — *The Story.* History auto-segmented into named eras with cited
  narrative and an architecture diagram that evolves as you scroll.
- **Look** — *The Timeline and The Map.* Time is global app state; scrubbing it
  changes every view. The Map is a stable spatial layout of the codebase, recolored
  by swappable **lenses** (age, churn, ownership, complexity, knowledge risk).
- **Ask** — *Why?* Press `?` on any line, file, symbol, or dependency and get a
  cited causal chain with an honest confidence rating.
- **⌘K** — the Raycast-grade command bar that reaches all of it.

### What makes it defensible

1. **It works with no API key.** Everything deterministic — eras, hotspots,
   ownership, coupling, bug-introducing-change detection, blame chains, semantic
   search via local embeddings — runs offline for free. AI writes the prose; it
   does not gate the value. First run never asks for a credit card.
2. **The evidence graph is the moat.** Anyone can pipe `git log` into a model.
   Building rename-safe file lineage, symbol lineage, SZZ bug attribution, PR
   inference from squash-merge subjects, and a ranked evidence bundle is months of
   careful work that shows up as *the answers are actually right*.
3. **The visualizations are engineered, not decorative.** A Persistent Layout
   guarantee (positions computed once at HEAD, held fixed while time scrubs) is what
   makes time-travel legible instead of a hairball seizure. Nobody else does this.
4. **It becomes infrastructure.** `excavate why src/a.ts:42` prints to stdout;
   `excavate mcp` exposes the index as typed tools to coding agents. Excavate turns
   into the memory layer other AI tools query — which is a far larger surface than
   a desktop app alone.

### The stack, in one breath

Rust core (gitoxide with a `git` CLI fallback adapter) → SQLite as the inspectable
system of record, with Tantivy and usearch sidecars → a localhost daemon speaking
HTTP + WebSocket with types generated into TypeScript → a React 19 + Vite UI with a
custom WebGL2 scene renderer and Rust→WASM layout workers → Tauri v2 as a thin
native shell, with `excavate serve` as a first-class equal (and the Linux escape
hatch). Claude Opus 5 is the default cloud model; local ONNX embeddings are the
default for search. Full reasoning in [Part 13](docs/spec/13-technical-architecture.md).

### The MVP, in one breath

`excavate .` → progressive index → Overview, Story, Timeline, Map, File Evolution,
Why, and ⌘K. Eight features. Everything else — knowledge graph, plugins, forge
connectors, living docs, MCP — is scheduled, specified, and explicitly deferred in
[Part 6](docs/spec/06-mvp.md).

### The honest risks

Garbage commit messages degrade the "why" (mitigated by confidence scoring and
deterministic signals). Rename/lineage bugs would destroy trust instantly (mitigated
by a fixture DSL and property tests as a first-class milestone). Hairball graphs are
the default failure of code visualization (mitigated by focus+context and hard node
caps). Scope creep is the largest risk of all (mitigated by the one-question test in
[Part 2](docs/spec/02-principles.md)). Full register in
[Appendix B](docs/spec/B-risk-register.md).

---

## Non-goals, stated up front

Excavate is **not**:

- a chat interface with a repo attached;
- a code review tool, a CI system, or a PR workflow product;
- a developer productivity measurement or performance-management tool — this is a
  hard ethical line, see [Part 2](docs/spec/02-principles.md);
- a hosted SaaS with a required account;
- an enterprise compliance dashboard;
- a code editor.

---

## License, governance, and the OSS posture

- **License:** Apache-2.0 for the entire monorepo. It carries an explicit patent
  grant, which matters for a tool corporations will run against proprietary code,
  and it is the license large companies approve without a legal review cycle.
  Rejected: MIT (no patent grant), AGPL (blocks the corporate adoption that drives
  word-of-mouth), and any open-core split (poisons contributor trust before there
  is a community to poison).
- **Governance:** maintainer team with an in-repo RFC process for anything that
  changes a public contract. Excavate's own repository is the canonical demo — we
  dogfood the tool on the tool.
- **Telemetry:** off. Not off-by-default-with-a-prompt — off, with no collection
  code path in the binary. Crash reports are written locally and shown to the user
  to file manually.
- **The contribution on-ramp we optimize for:** language packs. Adding support for
  a new language must be a declarative TOML + tree-sitter query file with no Rust
  required, because that is the contribution people actually want to make.

---

*Read [Part 1: Product Vision](docs/spec/01-vision.md) next.*
