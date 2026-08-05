# Part 1 — Product Vision

## 1.1 What is Excavate?

Excavate is a local-first desktop application that reconstructs and presents the
**history of intent** behind a Git repository.

Point it at any repo. It reads the full commit graph, the diffs, the branch
topology, the tags, the authorship, and — where available — the pull requests and
issues. From that raw material it builds an **evidence graph**: a queryable network
of facts and the causal links between them. On top of the evidence graph it renders
three things a developer can actually use:

1. **A narrative** — the repository's life told as chapters, with citations.
2. **A map** — a stable spatial representation of the codebase, scrubbable through
   time and recolorable by any analytic lens.
3. **An answer** — press `?` on anything and get the reconstructed rationale, with
   the evidence chain visible and a confidence rating you can argue with.

## 1.2 The problem, precisely

### 1.2.1 The gap between "what" and "why"

Git is a content-addressed store of *states*. It records, with perfect fidelity,
what the tree looked like at every point. It records essentially nothing about
intent. The intent was recorded — in a PR description, in a review thread, in a
Slack argument, in a design doc, in the head of someone who has since left — and
Git preserves at most a lossy 50-character summary of it in a commit subject.

So the tooling we have answers questions nobody is stuck on:

| Question | Tool that answers it | Time to answer |
|---|---|---|
| What changed in this file? | `git log -p` | seconds |
| Who last touched this line? | `git blame` | seconds |
| What does this function do? | Reading it; an LLM | minutes |
| **Why does this function do that?** | **Nothing** | **hours, or never** |
| **Why is the architecture shaped this way?** | **Nothing** | **days, or never** |
| **Who should I ask about this subsystem?** | **Tribal knowledge** | **days** |
| **Where is this codebase's pain concentrated?** | **Intuition** | **never** |

The bottom four rows are where engineering time actually goes, and they are
unserved.

### 1.2.2 What this costs, concretely

- **Onboarding.** A senior engineer joining a mature codebase spends 2–6 weeks
  reaching the point where they can change things without fear. Most of that time
  is not spent learning the language or the framework — it is spent learning which
  parts are load-bearing, which are vestigial, who owns what, and which
  weird-looking code is weird for a reason.
- **Chesterton's Fence, at scale.** Every unexplained line is a fence. Without the
  why, engineers make one of two bad choices: remove it (and cause an incident), or
  preserve it forever (and accrete complexity that nobody can ever remove). Both
  compound.
- **Repeated incidents.** The same class of bug recurs because the fix's rationale
  was never surfaced to the next person to touch that code.
- **Bus factor invisibility.** Teams do not know which parts of their system are
  understood by exactly one person until that person leaves.
- **Open-source contribution friction.** A drive-by contributor cannot possibly
  reconstruct project context. The result is PRs that violate unwritten
  architectural intent, and maintainers who spend their scarce time explaining
  history instead of reviewing code.

### 1.2.3 Why "just ask an LLM" is not the answer

The obvious 2026 reflex is: dump the repo into a million-token context window and
ask. This fails for four reasons, and understanding all four is what makes Excavate
a product rather than a wrapper.

1. **The context is the wrong shape.** The current tree is not the history. A model
   reading `HEAD` sees the *result* of ten thousand decisions and none of the
   decisions. The information required to answer "why" is in the *deltas*, the
   *reverts*, and the *discussion* — none of which fit, and none of which are
   retrievable by naive similarity search over source files.
2. **Retrieval by embedding is the wrong retrieval.** "Why does this retry loop
   have jitter?" does not semantically resemble the commit that introduced it. It
   resembles the *code*. The right retrieval is structural — blame this line, find
   that commit, find its PR, find the revert that preceded it — and that is a graph
   traversal, not a vector search.
3. **Hallucinated rationale is worse than no rationale.** A plausible, confident,
   wrong explanation of why code exists will get acted on. It is actively more
   dangerous than an honest "I don't know." Any system without a citation contract
   and a verification pass will produce exactly this failure, at scale, invisibly.
4. **A chat box requires you to already know the question.** The hardest part of
   understanding an unfamiliar codebase is not getting answers — it is knowing what
   to ask. A blinking cursor helps a person who already has the map. Excavate's job
   is to *give them the map*, and to surface the questions they didn't know existed
   ("this module has a bus factor of 1 and its only author left 8 months ago").

Excavate uses LLMs heavily. It just uses them at the right point in the pipeline:
**narrating over verified evidence**, never retrieving or inventing it.

## 1.3 The product thesis

> **Understanding a codebase is a navigation problem, not a search problem.**

You do not understand a city by querying it. You understand it by looking at a map,
walking through it, noticing which districts are old and which are new, and asking a
local why that one street bends.

Excavate is built on that analogy, taken seriously:

| City | Excavate |
|---|---|
| The map | The Repository Map — stable spatial layout, lens-colored |
| Districts and their ages | Directory clusters, colored by the age lens |
| The historical plaque | The Why panel — cited, dated, attributed |
| The city's founding story | The Story — eras, cited narrative |
| Where the potholes are | Hotspots — churn × complexity × fix density |
| Who to ask about the old quarter | Ownership and knowledge model |
| Watching the city grow (time-lapse) | Timeline scrubbing with Persistent Layout |
| The archaeological dig | Code Archaeology — line-level lineage through renames |

## 1.4 What makes Excavate unique

Five claims, each of which is a design commitment enforced elsewhere in this spec.

### 1.4.1 Citations are load-bearing, not decorative

Every generated sentence carries an evidence marker. A post-generation validator
parses those markers, verifies each referenced evidence ID exists in the bundle that
was supplied, computes an uncited-sentence ratio, and downgrades or refuses the
answer if the ratio exceeds a threshold. This is specified in
[Part 10 §10.6](10-ai-architecture.md). The user-visible result is that clicking any
claim jumps to the commit, the diff hunk, or the PR comment that supports it.

Corollary: **Excavate is allowed to say "I don't know."** The confidence rating is
honest, its inputs are shown ("no PR data available; inferred from commit message
and co-change"), and low confidence is displayed prominently rather than buried.

### 1.4.2 It is fully useful with zero AI

This is the strategic core. On first run with no API key configured:

- Eras are detected (change-point detection over a multivariate activity series).
- Hotspots, ownership, coupling, bus factor, knowledge islands are computed.
- Bug-introducing changes are attributed (SZZ-lite).
- Blame chains, revert/re-land pairs, and PR references are extracted.
- Semantic search works, via a bundled local ONNX embedding model.
- The Why panel shows the full evidence chain — just without the prose summary.

Only the *narration* requires a model, and a local model via Ollama satisfies it.
This means the tool is genuinely free, genuinely private, and genuinely offline —
and it means the demo works instantly for someone who just cloned the repo.

### 1.4.3 The visualizations are engineered for legibility

Two commitments that most code-visualization projects skip:

- **Persistent Layout.** Spatial positions in the Map are computed once at `HEAD`
  and held fixed while the user scrubs time. Files animate in and out of existing
  slots; they do not re-flow. Without this, time-travel is an unreadable churn of
  moving rectangles. With it, you can watch a subsystem grow and *see* it.
- **Focus + context, with a hard cap.** No view ever attempts to render "the whole
  graph." Graph views start from a focus node, render 1–2 hops, aggregate beyond a
  300-node budget into cluster nodes, and expose "why is this edge here?" on hover.
  Hairballs are treated as a bug class, not an aesthetic.

### 1.4.4 It refuses to be a surveillance tool

Excavate computes per-person data because "who should I ask?" is one of the highest
value questions in the product. It deliberately does not compute, display, rank, or
export anything resembling individual productivity:

- No lines-of-code leaderboards. No commit-count rankings. No velocity per person.
- Contributor views are framed as **expertise maps and cast-of-characters**, never
  as scoreboards.
- The "knowledge risk" analysis is about *the code's* fragility, not a person's
  output.

This is stated in the README, enforced in code review, and is a stated reason to
reject feature requests. It is both an ethical position and a competitive one: it is
why an engineer will feel safe recommending Excavate to their team.

### 1.4.5 It is designed to become infrastructure

The desktop app is the front door, not the building. Because the core is a daemon
with a typed API, three additional surfaces come nearly free and are on the roadmap:

- `excavate why src/webhook.ts:42` — prints a cited answer to stdout. Usable inside
  any script, any editor, and inside other AI coding agents.
- `excavate mcp` — exposes the index as a typed MCP toolset (`blame`,
  `symbol_history`, `who_owns`, `find_prs`, `search_commits`). This makes Excavate
  the **repository-memory layer** that coding agents query before they edit.
- `excavate export` — emits a portable `.excavate-pack` index artifact. A maintainer
  can publish one; a newcomer loads it and gets instant understanding with zero
  indexing time and zero API key.

## 1.5 Why now

- **Tree-sitter is universal.** Robust, incremental, error-tolerant parsing for 100+
  languages is a solved, embeddable dependency. Symbol-level history was
  impractical five years ago.
- **Rust's Git and search ecosystem matured.** gitoxide, tantivy, and usearch make
  a single-binary, high-performance local index realistic without C dependencies.
- **Local embedding models are good and small.** A ~130MB ONNX model gives usable
  semantic search on-device, which is what makes the no-API-key experience credible.
- **LLMs became good enough to narrate, and cheap enough to narrate a lot.** With
  prompt caching at ~0.1× read cost and batch processing at 50%, hierarchical
  summarization of a large repository moved from "thousands of dollars" to "under a
  dollar."
- **AI coding agents created demand for repository memory.** Agents edit code
  without history context and reintroduce old bugs. A queryable evidence graph is
  exactly the missing substrate — and nobody has built one.
- **Codebases got older.** The median professional codebase in 2026 has more history
  than the median engineer has tenure. Archaeology is now the default mode of work.

## 1.6 What success looks like

| Horizon | Signal |
|---|---|
| Launch week | The Story GIF gets shared; 5k+ stars; front page of Hacker News with the top comment being *"I ran this on our monorepo and immediately found three knowledge islands"* |
| Month 3 | People run `excavate` on unfamiliar OSS before contributing; maintainers publish `.excavate-pack` artifacts in releases |
| Month 6 | `excavate why` appears inside other people's agent configs and editor plugins |
| Year 1 | "Excavate it" is a verb on engineering teams; language packs are contributed faster than we could write them |

The counter-metric we watch: **feature count**. If Excavate ships more than ~15
user-visible features in year one, we have lost the plot.

---

*Next: [Part 2 — Product Principles](02-principles.md)*
