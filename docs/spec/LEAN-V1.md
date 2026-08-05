# Lean v1 — Excavate for One Engineer

**Supersedes the scope and technology choices in [SPEC.md](../../SPEC.md) for a
solo build.** The product thesis, principles, domain model, and evidence design in
Parts 1–2, 8, and 10 §10.5–10.6 survive intact. What changes is everything about
*how much machinery* is required to express them.

**Target:** ~18 weeks of focused solo work to a v1 that is genuinely excellent, not
a v1 that is "good considering."

---

## 1. The verdict on the original spec

Honest assessment of what I wrote:

| | |
|---|---|
| **Right** | The product thesis. The citation contract. Persistent Layout. Zero-API-key posture. Rename correctness as the trust foundation. The daemon boundary. URL-as-state. The anti-surveillance line. |
| **Right but over-specified** | Domain model (correct, but ~40% of the entities aren't needed at v1). Evidence engine (correct design, twice as many collectors as needed). Eval harness (correct instinct, 6× too many cases). |
| **Wrong for one engineer** | The technology stack. It optimizes for a perf ceiling we won't reach and pays for it in five separate ecosystems. |
| **Wrong, full stop** | Two Git backends. WASM layout. A WebGL renderer before a Canvas2D one. Three storage engines. Seven AI pipelines. A desktop shell. |

The single most useful finding from this review is in §2.1: **the Rust decision was
justified entirely by five dependencies, and every one of them gets cut for other
reasons.** Once they're gone, the justification is gone with them. That's the kind of
thing you only see when you do the cut list first and revisit the foundation
afterward.

---

## 2. Three structural changes

These three account for roughly 60% of the total complexity reduction. Everything in
§3 is small by comparison.

### 2.1 The stack collapses to TypeScript

The original argument for Rust (Part 13 §13.1) was: *"the only ecosystem where
gitoxide, tantivy, usearch, tree-sitter, and ONNX are all first-class."*

Watch what happens to that argument under the lean cut list:

| Dependency | Fate in lean v1 | Reason |
|---|---|---|
| gitoxide | **Cut** — shell out to `git` | One backend, not three; `git`'s rename detection is better anyway |
| Tantivy | **Cut** — SQLite FTS5 | ⌘K over commits and paths doesn't need BM25 tuned for code |
| usearch | **Cut** — no vectors in v1 | Semantic search was already deferred to v0.2 |
| tree-sitter | **Cut** — no symbols in v1 | Symbol lineage was already v0.3 |
| ONNX | **Cut** — no embeddings in v1 | Follows from no vectors |

**Every justification for Rust is eliminated by cuts made for independent reasons.**
What remains is raw throughput — and with `git` (C) doing the walk and SQLite (C)
doing the writes, the runtime is a coordinator moving bytes between two C programs.

Measured reality on the realistic target (10k–50k commits): `git log --numstat -z`
streams in 3–12 seconds and `better-sqlite3` sustains >100k inserts/sec inside a
transaction. Node is not the bottleneck at that scale. At 1M commits it would be —
and that's the case where you profile and port *one module*, which the daemon
boundary makes a contained change.

**Decision: Node 22+ / TypeScript for the core.** One language, one toolchain, one
mental context, roughly 2× iteration speed for a full-stack engineer. Distributed via
npm (`npx excavate`), which also deletes code signing, notarization, and installers
from the project.

**If your Rust is genuinely stronger than your TypeScript, keep Rust** — but still
make every other cut in this document, and use the `git` CLI rather than gitoxide.
The stack choice is the one item here that's about you rather than about the product.

**Cost accepted:** the 1M-commit case is slow (minutes, not seconds). Handle it
honestly with the partial-index badge that Part 9 §9.3.4 already specifies.

### 2.2 No desktop shell

`excavate .` indexes, then opens `http://127.0.0.1:<port>/?token=…` in the default
browser. That's it.

This is how Jupyter, Storybook, Vite, Prisma Studio, and `git instaweb` work. Nobody
files issues about it.

What this deletes outright:

- Tauri, and the entire Rust dependency it drags in once the core is TypeScript
- Code signing and Apple notarization (a genuinely miserable multi-day task)
- Auto-update infrastructure
- Three installer formats × three platforms
- **Risk R6 in its entirety** — the WebKitGTK WebGL2 hazard, which was the highest
  platform risk in the whole spec, simply stops existing

What it costs: slightly less "app-like." Mitigate with a real favicon, a proper
document title, `?token=` handled invisibly, and a genuinely nice terminal handoff.
Revisit a shell at v2 if users ask — and they may not.

### 2.3 Canvas2D, not WebGL

The original budget was 50k cells at 60fps, which forced instanced rendering,
ID-buffer picking, shader management, WebGL context-loss handling, and a bespoke
scene-graph package.

The actual distribution of repositories: p50 is ~1,500 files, p90 is ~12,000. Canvas2D
draws 12k filled rects with a quadtree for picking at a comfortable 60fps in about
400 lines.

**Rule for anything larger:** above 15k files, aggregate to directory-level cells.
This isn't a degradation — a 40k-cell treemap is unreadable anyway, and directory
aggregation is the better visualization at that scale.

Critically: **Persistent Layout is orthogonal to the renderer.** The actual
differentiator survives at full strength. WebGL is a later optimization with a clean
seam, not a v1 requirement.

---

## 3. The cut list

### 3.1 Cut entirely from v1

| Cut | Was | Why it goes |
|---|---|---|
| Second Git backend + `HybridBackend` | Part 7 §7.2.1 | Three implementations to keep behaviourally identical. Ship the `git` CLI only; it has the best rename detection and requires a tool every user already has. |
| Tantivy | Part 13 §13.3 | FTS5 over commit subjects, bodies, and paths is enough for ⌘K. |
| usearch + embeddings + semantic search | Part 10 §10.3 | Already v0.2. Removes a 130MB model download, a background job, and a whole quality dimension to tune. |
| tree-sitter, symbols, language packs | Part 7 §7.2.5 | Already v0.3. Complexity proxy becomes LOC + mean indentation depth — language-agnostic, zero parsers, ~15 lines. |
| Architecture sidecar in the Story | Part 6 §6.2 M3 | The most expensive item in the Story view; needs an import graph, which needs parsers. **Replaced** — see §4.2. |
| Rust→WASM layout | Part 7 §7.2.10 | Squarified treemap is 80 lines of TS. No graph views in v1, so no force layout needed. |
| Binary transport plane | Part 7 §7.4.1 | 12k cells as JSON is ~1MB. Revisit when WebGL arrives. |
| specta type generation | Part 13 §13.6 | Vanishes with a TypeScript core — types are just a shared package. |
| Job scheduler with priorities and preemption | Part 13 §13.7 | An async queue with `AbortSignal`. |
| Three history projections | Part 8 §8.2.2 | First-parent only, stated plainly in the UI, switchable in config for the curious. The concept stays documented; the UI multiplier goes. |
| Targeted rebuild on force-push | Part 9 §9.5 | Detect rewrite → full rebuild with a progress bar. It's rare and the optimization isn't worth the invalidation logic. |
| Plugin host | Part 7 §7.2.11 | Was v1.0. Now post-v1. Keep the `Analyzer` and `Lens` shapes internally so it's possible later. |
| Visual regression harness | Part 13 §13.8.2 | A solo engineer looking at their own app catches visual regressions. Keep the tests that catch *invisible* breakage. |
| Storybook | Part 14 §14.3 | Component isolation matters for teams. You are not a team. |
| People view, Decisions view, Search view | Part 12 §12.2.1 | Ownership surfaces inline on files and in the Map lens. Decisions is post-v1. Search lives in ⌘K. |
| 5 AI pipelines | Part 10 §10.4 | Keep two — see §3.3. |
| Five reference corpora | Part 13 §13.8.3 | Two in CI (ripgrep, rust-analyzer). React and Linux run manually before releases. |

### 3.2 Deferred, in order

| Feature | Was | Now | Why this order |
|---|---|---|---|
| MCP server | v0.3 | **v1.1** | ~150 lines once the query layer exists. Highest leverage-per-line in the roadmap. |
| GitHub connector | v0.2 | **v1.1** | Biggest single jump in Why quality. First thing after launch. |
| `.excavate-pack` export | v0.2 | v1.2 | Growth loop, but needs a stable schema first. |
| Semantic search | v0.2 | v1.2 | Lexical carries v1 further than expected. |
| SZZ-lite | v0.2 | v1.3 | Risky (false attributions, R12) and expensive to validate. |
| Symbols + tree-sitter + language packs | v0.3 | v1.4 | A whole subsystem. |
| Architecture Evolution, Knowledge Graph, plugins, living docs | v1.x | v2 | Unchanged. |

### 3.3 Trimmed, not cut

| Item | From | To |
|---|---|---|
| **Evidence collectors** | 10 | **6** — Blame, CommitContext, PrReference, RevertPair, TemporalNeighbor, TestSibling. Drops CoChange, DocChange, AdjacentComment, DependencyChange. These are the four lowest-yield and easiest to add later. |
| **AI pipelines** | 7 | **2** — Era narration, Why synthesis. Drops bulk commit enrichment (significance works without it), cluster labelling (no architecture view), decision summaries, search synthesis, the agentic investigation loop. |
| **Providers** | 8 + descriptors | **3** — Anthropic, OpenAI-compatible (covers Ollama, LM Studio, OpenRouter, OpenAI, Groq in one adapter), Deterministic. Capability descriptors become four booleans. |
| **Eval cases** | 200 | **30**, weighted toward adversarial: hallucination, `must_not_claim`, prompt injection, "genuinely unrecoverable → must refuse." The *validator* is 90% of the protection and is cheap; the corpus grows over time. |
| **Era detection** | PELT, 10-dimension series | **Binary segmentation, 5 dimensions** (commit rate, distinct authors, top-level-dir entropy, LOC delta, extension-mix drift). At 3–12 segments the output is near-identical for a fifth of the code. Snap to releases unchanged. |
| **Lenses** | 6 | **5** — drops Complexity, which is the weakest and overlaps Hotspot. |
| **Indexing tiers** | 4 | **2** — Metadata (UI usable) and Analysis (everything else). |
| **Fixture matrix** | ~40 cases | **~22** — keeps every rename form, merges, mailmap, blame-ignore, resurrection, empty commits, binary, CRLF, unicode paths. Drops LFS, submodules, case-only renames, >255-byte paths. |
| **Design components** | ~30 | **~14** |

---

## 4. What must not be touched

Cutting these would produce a lean v1 that isn't world-class. They are the product.

1. **The citation contract and its validator** (Part 10 §10.6). The validator is
   ~150 lines and it is the entire difference between Excavate and a repo-chat
   wrapper. All four checks stay — especially numeric grounding, which catches the
   most damaging failure.
2. **Persistent Layout** (Part 11 §11.3.2). Cheap, and it is the reason time-scrubbing
   is legible.
3. **Rename tracking and identity merging** (Part 8 §8.3). Silent wrongness here
   destroys trust permanently. This is the one milestone that must not be compressed.
4. **Zero-API-key full function.** Every feature has a deterministic path, tested
   offline in CI.
5. **Deterministic confidence with enumerated reasons**, computed before generation.
6. **URL-as-state and the daemon boundary.** Both nearly free now, impossible to
   retrofit, and between them they preserve the CLI, MCP, `serve`, and shareable links.
7. **The fixture DSL.** ~300 lines, and it is the only way to test Git tooling
   deterministically.
8. **Keyboard completeness and accessibility.** Cheap when designed in; part of the
   quality bar. The Map keeps its accessible table twin — it's the only canvas view
   left, so this is one component, not a policy.
9. **The design quality bar** (Part 2 §2.5). This is what makes people share it.
10. **No telemetry. No productivity metrics.**

---

## 5. The lean architecture

```
excavate/                              # one pnpm workspace, TypeScript throughout
├── packages/
│   ├── core/          # domain types, IDs, errors, time            (shared)
│   ├── git/           # `git` CLI streaming walk, diff, blame, mailmap
│   ├── index/         # walk pipeline, rename resolution, identity merge, incremental
│   ├── store/         # better-sqlite3: schema, migrations, queries, FTS5
│   ├── analysis/      # significance, ownership, coupling, hotspots, reverts, eras
│   ├── evidence/      # 6 collectors, ranking, confidence, bundle hashing
│   ├── ai/            # 3 providers, 2 pipelines, prompts, validator, budget
│   ├── server/        # Hono: HTTP + SSE, token auth, job queue
│   └── ui/            # React app: views, canvas renderer, design tokens
├── cli/               # `excavate` — index, open, why, stats, doctor
├── fixtures/          # the repo!() DSL and its corpus
├── prompts/           # versioned templates
└── evals/             # 30 golden cases + harness
```

**Notable simplifications versus the original:**

- **17 Rust crates + 5 npm packages → 9 packages.** One dependency graph, one
  `tsconfig` project-references setup, one test runner (`vitest`).
- **SSE instead of WebSocket.** Progress and streamed tokens are strictly
  server→client. SSE is ~10 lines, reconnects natively, and needs no upgrade-handshake
  origin validation.
- **Storage is one file.** `index.db`, with FTS5 virtual tables inside it. No
  sidecars, no `search/`, no `vectors/`, no `layout/` (the treemap is fast enough to
  compute at open and hold in memory).
- **Security posture is unchanged**: 127.0.0.1 only, random port, random token
  required on every request, strict CORS, keys in the OS keychain via `keytar`.

### 5.1 The one piece of genuinely careful engineering

The streaming walk is where the whole product's correctness and speed live, and it's
worth writing deliberately:

```ts
// One pass. Everything downstream reads from the store.
const proc = spawn('git', [
  'log', '--all', '--first-parent', '--reverse',
  '--numstat', '-z', '--find-renames=50%', '--find-copies',
  '--format=%x01%H%x02%T%x02%P%x02%an%x02%ae%x02%at%x02%cn%x02%ce%x02%ct%x02%B',
]);

for await (const commit of parseLogStream(proc.stdout)) {
  people.resolve(commit);          // mailmap + 5-step identity merge
  renames.advance(commit);         // path → FileId frontier
  noise.classify(commit);          // generated / vendored / format-only / bulk
  batch.push(commit);              // flush every 10k rows, one transaction
}
```

Everything else — ownership, coupling, hotspots, eras, rollups — is a SQL query or a
pass over already-stored rows. Getting this loop right is most of L1.

---

## 6. What lean v1 actually ships

| Feature | Status vs original MVP |
|---|---|
| `excavate .` → progressive index → browser | Unchanged (no desktop shell) |
| **Overview** | Unchanged |
| **The Story** | Eras, cited narrative, key commits, reverts, contributors, releases — with a **directory-mass panel** instead of an architecture diagram |
| **Timeline** | Unchanged: strata ribbon, global time cursor, markers |
| **Map** | Canvas2D, Persistent Layout, 5 lenses, drill-down, table twin |
| **Why** | 6 collectors, evidence chain, confidence, gaps. Symbol targets deferred. |
| **File Evolution** | Unchanged |
| **⌘K** | Commands, entities, FTS5 over commits and paths. No semantic. |
| **`excavate why path:line`** | **Promoted into v1** — ~60 lines once the daemon exists, and disproportionately good for reach |

### 6.1 The replacement for the architecture sidecar

The Story's scroll-linked morphing diagram was the most expensive item in the MVP and
the only one that required parsers. Replaced with a **directory-mass treemap per era**
that morphs on scroll:

- Computed from path changes alone — no parsing, no import graph.
- Shows which directories were born, grew, shrank, and died in each era.
- For most repositories, directory structure *is* the architecture.

Roughly 5% of the effort and, honestly, 80% of the communicative value. It also
reuses the treemap code from the Map, so it's nearly free once L4 is done.

---

## 7. Roadmap — 7 milestones, ~18 weeks

Each ends in something demoable. Each carries its tests.

| # | Milestone | Weeks | Ships |
|---|---|---:|---|
| **L0** | Skeleton & fixtures | 1.5 | End-to-end thread: index 100 commits → serve → render → click |
| **L1** | Git engine & index | 3.0 | `excavate index` |
| **L2** | Analysis | 2.0 | `excavate stats` |
| **L3** | Shell, tokens, Overview | 2.0 | First real UI |
| **L4** | Map & Timeline | 2.5 | **v0.1-alpha** |
| **L5** | Evidence & Why (no AI) | 2.5 | `excavate why` |
| **L6** | AI & The Story | 2.5 | **v0.1-beta** |
| **L7** | File Evolution, polish, launch | 2.5 | **v1.0** |
| | | **18.5** | |

### The critical sequencing decisions

**L1 gets three full weeks and must not be compressed.** Rename tracking, identity
merging, and incremental update are the trust foundation. A lineage bug found during
L6 means every Why answer since L5 was potentially wrong, and diagnosing it backward
through four milestones is brutal. Write the fixture matrix *before* the
implementation.

**L5 ships before L6, deliberately.** The gate at the end of L5 is: *five external
testers can explain unfamiliar code using only the deterministic Why panel, with no
prose.* If they can't, the problem is evidence ranking, and it must be fixed there —
not papered over with an LLM in L6. This ordering is the single best protection
against building a repo-chat tool by accident.

**Milestone-level detail** for objectives, deliverables, testing, and acceptance
criteria carries over from [Part 15](15-execution-plan.md) — M0→L0, M1→L1, M2→L2,
M3→L3, M4→L4, M5→L5, M6→L6, and M7+M10 collapsed into L7. Delete the deliverables
covered by §3.

---

## 8. Revised risk posture

| Risk | Change | Why |
|---|---|---|
| **R6 — WebKitGTK WebGL2** | **Eliminated** | No desktop shell, no WebGL |
| **R8 — Perf on huge repos** | **Increased** | Node is slower than Rust on the walk. Mitigated by honest partial indexing and a stated 500k-commit comfortable ceiling. The XL case is an outlier, not the target. |
| **R1 — Lineage bugs** | Unchanged, still #1 | Full fixture matrix survives the cuts |
| **R2 — Hallucination** | Slightly increased | 30 eval cases instead of 200. The validator — which does most of the work — is unchanged. |
| **R3 — Scope creep** | **Reduced** | A smaller v1 is a smaller surface to creep from |
| **R5 — Arbitrary eras** | Unchanged | Binary segmentation performs the same at this granularity |
| **R7 — Poor commit hygiene** | **Increased** | No forge connector at v1, so weak-message repos degrade further. Honest LOW confidence handles it; v1.1 fixes it. |
| **R15 — No contributors** | **Reduced** | TypeScript is a far lower barrier than Rust, and language packs — the main contribution path — arrive in v1.4 anyway |

**New risk: "it's just a Node app."** Some of the audience will discount a TypeScript
dev tool on reflex. Mitigate by leading with measured numbers in the README ("41s to
index 12,481 commits") rather than with the stack. Nobody who finds the tool useful
will uninstall it over the runtime.

---

## 9. What you give up, stated plainly

Worth being honest about, both for your own expectations and for the launch post:

1. **Slower on very large repositories.** A 1M-commit repo takes minutes, not
   seconds. Handled with a visible partial-index badge, never silently.
2. **Weaker "why" on repos with poor commit hygiene**, until the GitHub connector
   lands in v1.1. Structural evidence — reverts, test siblings, temporal neighbours —
   still carries real signal.
3. **No semantic search.** Lexical + entity search covers navigation better than
   expected, but "find the code that handles retries" won't work as well as
   "find `retry`."
4. **No symbol-level history.** File-level only. This was v0.3 in the original plan
   anyway.
5. **The Story's architecture panel is directories, not modules.** Less impressive in
   a screenshot; nearly as informative in practice.
6. **A browser tab, not an app window.** Precedented and fine, but it is a real
   difference in feel.
7. **A thinner AI safety net** — 30 eval cases rather than 200. The validator is the
   load-bearing part and is unchanged; the corpus grows with every bug found.

None of these touch the five sentences that define "done" in
[Part 15 §15.3](15-execution-plan.md). Lean v1 still delivers all of them.

---

## 10. The one-line summary

Cut the stack from five ecosystems to one, delete the desktop shell and the GPU
renderer, ship two AI pipelines instead of seven — and keep every single thing that
makes the product *itself*: cited evidence, frozen layout, correct lineage, and a
tool that works completely with no API key.
