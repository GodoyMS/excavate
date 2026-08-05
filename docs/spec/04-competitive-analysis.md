# Part 4 — Competitive Analysis

The honest version. Several of these tools are excellent, and two of them could
build Excavate's core features if they decided to. The analysis is structured around
what each is *for*, because that — not feature lists — determines what they will and
will not do.

---

## 4.1 The landscape map

Two axes: **what the tool operates on** (current state vs. history), and **what it
produces** (facts vs. understanding).

```
                          UNDERSTANDING
                                ▲
                                │
                                │       ★ EXCAVATE
                                │
              Cursor ●          │        ● Claude Code
        Sourcegraph ●           │
                                │
  CURRENT ─────────────────────┼─────────────────────── HISTORY
   STATE                        │                        (time)
                                │
         GitHub Code Search ●   │   ● GitLens
              Graphite ●        │   ● git log / blame
                                │   ● CodeScene
                                │
                                ▼
                              FACTS
```

The upper-right quadrant — *understanding, derived from history* — is empty. That is
not an accident of the diagram; it is genuinely unoccupied, and the reason is that
it requires building an evidence graph, which is unglamorous infrastructure work
that neither the editor companies nor the code-search companies have a reason to do.

---

## 4.2 Tool-by-tool

### GitHub (web UI, blame, Insights, Copilot Workspace)

**What it is for:** hosting, review workflow, and collaboration.

**Strengths:** it *has* the data nobody else has — PR bodies, review threads, issue
links, reactions, timelines. Blame view is decent. Insights gives basic pulse
metrics. Universal familiarity.

**Where it leaves the gap open:**
- The data is siloed per-artifact. A PR page shows one PR. There is no synthesis
  across 12,000 of them, and no navigation from a *line of code* to the argument
  that produced it.
- Insights are activity statistics (commits per week, contributors) — Part 2's P2
  failure mode exactly: numbers without understanding.
- No time-travel, no spatial map, no architectural view, no lineage across renames
  in any usable form.
- The blame → PR → discussion path exists but requires ~5 manual navigations per
  question, which is why nobody does it.

**Will they build it?** Partially, eventually, for github.com-hosted repos only. But
GitHub's incentive is engagement inside the workflow, not a separate comprehension
surface, and their history features have moved slowly for a decade.

**Excavate's relationship to it:** complementary and parasitic in a good way — we
*consume* GitHub's PR data via a connector and make it navigable from the code side.
We also work on GitLab, Gerrit, and bare repos, which GitHub structurally cannot.

---

### GitLens (VS Code extension)

**What it is for:** surfacing Git metadata inside the editor, at the cursor.

**Strengths:** the best in-editor Git experience by a wide margin. Inline blame
annotations, commit graph, file history, line history, and a genuinely large
installed base. Some of the most thoughtful Git UX ever shipped.

**Where it leaves the gap open:**
- It is a **facts** tool. It shows you *who and when* with excellent ergonomics. It
  does not synthesize *why*, does not analyze the repository as a whole, does not
  model ownership decay or coupling, and does not narrate.
- Editor-bound: constrained to a sidebar and hover cards, so the visual bandwidth
  for a map or timeline simply is not there.
- Its unit of interest is the line/file/commit. Excavate's unit is the *repository*,
  and then the era, and then the decision.

**Will they build it?** They have added AI commit-summary features, so directionally
yes on narration. But architecture-scale analysis inside a VS Code sidebar has a
hard ceiling, and their strategic center is the editor.

**Where we overlap and where we don't:** GitLens is the best answer to "what
happened on this line" while you are typing. Excavate is the answer to "how does
this whole thing work and why." A developer plausibly uses both, daily, for
different questions. We should say so publicly rather than pretending otherwise —
positioning against GitLens is a losing fight and an unnecessary one.

---

### Sourcegraph

**What it is for:** code search and navigation across very large, multi-repo
codebases; increasingly agentic code modification.

**Strengths:** best-in-class search at scale. Precise cross-repo code intelligence.
Batch changes. Real enterprise deployment story. Code Insights can track patterns
over time.

**Where it leaves the gap open:**
- Optimized for **current state** retrieval. History is a supporting feature, not the
  subject.
- Enterprise-oriented: heavy deployment, priced and packaged for organizations, not
  a thing an individual runs on a whim on a Tuesday.
- Code Insights answers "how many occurrences of X over time," which is a metric
  series, not a causal narrative.
- No spatial model of a codebase, no eras, no evidence chains.

**Excavate's relationship:** different job, different buyer, different install
gesture. We are single-repo, local, individual-first, history-native. The overlap is
semantic search, where they are far better at scale and we are better at *temporal*
search ("find the commit where we decided to…").

---

### Cursor / Windsurf / AI-native editors

**What they are for:** writing and modifying code with AI assistance.

**Strengths:** excellent codebase-aware completion and edit flows. Repo indexing for
context. Enormous momentum.

**Where they leave the gap open:**
- Their index is of **the current tree**. History is largely absent from the context
  they build.
- They optimize for *producing* code, not *comprehending* a system. The interaction
  model is a prompt and a diff.
- They inherit the four failure modes from Part 1 §1.2.3 — most importantly, no
  citation contract on rationale.

**Strategic note:** these are Excavate's best *distribution partners*, not
competitors. An editor agent that can call `excavate.why` before rewriting code
produces better patches. We should build for that explicitly (the MCP server), and
we should never try to become an editor.

---

### Claude Code / Codex / terminal coding agents

**What they are for:** autonomous and semi-autonomous multi-step code work.

**Strengths:** genuinely capable of reading a repo, running `git log`, and
synthesizing an answer to a history question — this is the closest functional
competitor to Excavate's *Why* feature specifically.

**Honest assessment of where they win:** for a single, well-posed question on a
small-to-medium repo, an agent with shell access will often produce a good answer.
It can run arbitrary git commands, which is more flexible than any fixed pipeline.

**Where they leave the gap open:**
- **Cost and latency per question.** Each investigation re-derives everything from
  scratch: minutes of tool calls and real token spend, every time, with no persistent
  index. Excavate answers from a pre-built graph in milliseconds.
- **No persistent artifact.** The understanding evaporates when the session ends.
  Nothing accumulates.
- **No overview.** They cannot give you a map, a timeline, or a spatial sense of a
  system. They are pointwise by nature.
- **No verified citations.** They cite what they happened to read; there is no
  validator, no confidence model, no guarantee of coverage.
- **Doesn't scale to "explain this whole repo."** Ask an agent to characterize
  31,000 commits and it samples, badly.

**The correct strategic posture:** do not compete — integrate. `excavate mcp` makes
these agents better and makes Excavate load-bearing infrastructure. The pitch to
this audience is *"stop paying to re-derive history on every question."*

---

### Graphite / Aviator / stacked-PR tooling

**What they are for:** the PR authoring and merging workflow.

**Overlap with Excavate:** essentially none. Different phase of the lifecycle
(producing changes vs. understanding accumulated changes). Included here only
because they come up in "Git tooling" conversations. Not a competitor.

---

### CodeScene

**The closest philosophical relative**, and the one most worth studying.

**What it is for:** behavioral code analysis — hotspots, change coupling, knowledge
distribution, technical-debt prioritization. Built on the research tradition of Adam
Tornhill's *Your Code as a Crime Scene*, which is also the intellectual lineage of
Excavate's hotspot and coupling analysis, and we should cite it explicitly in our
docs rather than quietly reimplementing it.

**Strengths:** the analysis is real and validated. Hotspot prioritization genuinely
works. Established with engineering-leadership buyers.

**Where it leaves the gap open:**
- **Manager-oriented, not developer-oriented.** It is a dashboard product for
  planning conversations. Excavate is an exploration instrument for the person
  actually reading the code.
- **Statistics without narrative.** It tells you *where* the pain is; it does not
  tell you *why* the code is that way. No evidence chains, no eras, no `?` on a
  line.
- **Cloud-first, commercial, per-seat.** Not something an individual runs locally on
  an OSS repo in 40 seconds.
- **Dangerously close to the anti-persona.** Several of its views drift toward
  developer measurement, which is precisely the framing Excavate refuses.

**Honest concession:** CodeScene's hotspot analysis is more mature than ours will be
at v1. Our differentiation is not "better hotspots" — it is that a hotspot in
Excavate is a *doorway* into the evidence, inside a tool a developer opens
voluntarily.

---

### Others, briefly

| Tool | Why it is not the same product |
|---|---|
| **Gource / git-of-theseus** | Beautiful history visualizations, zero interactivity, zero explanation. Art, not instrument. Worth studying for the aesthetics of the Timeline. |
| **Hercules / git-quick-stats** | Repository statistics CLIs. Facts, no synthesis, no UI. |
| **CodeQL / Semgrep** | Static analysis of current state for correctness. Orthogonal. |
| **Backstage / Port** | Service catalogs — org-level metadata, not code comprehension. |
| **Swimm / Mintlify** | Documentation authoring. Excavate *derives* documentation instead of asking humans to write it. |
| **Sema / Pluralsight Flow** | Explicitly developer-productivity measurement. The anti-persona's tool. We are the opposite. |
| **git-standup, tig, lazygit** | Excellent Git clients. Facts, current-operation-focused. |

---

## 4.3 The differentiation, stated tightly

| Dimension | Everyone else | Excavate |
|---|---|---|
| Primary subject | Current state | **Accumulated history** |
| Primary output | Facts or code | **Understanding** |
| Rationale | Absent or unverified | **Cited, validated, confidence-rated** |
| Interaction | Search box or chat box | **Map + Timeline + `?`** |
| Unit of analysis | File / line / PR | **Repository → era → decision → line** |
| AI role | The interface | **A capability inside the interface** |
| Without an API key | Broken or crippled | **Fully useful** |
| Deployment | Cloud or editor extension | **Local single binary** |
| Buyer | Enterprise or platform team | **The individual developer** |
| Data leaves machine | Usually | **Never, unless explicitly enabled** |

## 4.4 The four things nobody else does

Distilled to the claims we would actually make on a landing page:

1. **A cited "why" for any line, in milliseconds, from a persistent index.**
   Agents can approximate it slowly and unverifiably; nothing else attempts it.
2. **A repository narrative segmented into eras.** No competitor produces a
   readable history-as-chapters artifact at all.
3. **Time-scrubbable spatial map with a Persistent Layout guarantee.** The
   engineering that makes time-travel legible rather than nauseating.
4. **Full value with zero API key, zero account, zero network.** Every AI-era
   competitor requires at least one of the three.

## 4.5 Where competitors would beat us

Written down so we do not fool ourselves:

- **Scale.** Sourcegraph handles thousands of repos. We handle one, well.
- **Search quality on current code.** Sourcegraph and GitHub have years of
  investment. Our search is good enough to navigate, not best-in-class.
- **In-editor ergonomics.** GitLens is inside the editor; we are a separate window.
  Mitigated only partially by the CLI and deep links.
- **PR data completeness.** GitHub *is* the data. Our connector is a copy, subject to
  rate limits and auth.
- **Trust and procurement.** CodeScene and Sourcegraph have enterprise credibility we
  will not have for years. We are not chasing that buyer.
- **Analysis maturity at v1.** CodeScene's behavioral analysis has a decade of
  refinement behind it.

## 4.6 Defensibility

Honest answer: **there is no technical moat.** GitHub could build this. The moat, to
the extent one exists, is:

1. **Compounding correctness.** Rename lineage, symbol lineage, SZZ attribution,
   identity merging, and evidence ranking are each individually unglamorous and
   collectively the difference between right answers and plausible ones. That is a
   year of grinding that a larger company will not prioritize for a non-revenue
   surface.
2. **Design coherence.** The Persistent Layout, the single global time cursor, the
   citation contract — these are architectural decisions that are cheap on day one
   and nearly impossible to retrofit. A competitor bolting history onto an existing
   product will not get them.
3. **The no-key posture.** A company with cloud infrastructure to amortize will not
   ship a tool that works entirely offline for free. This is a structural advantage
   of being open source.
4. **Becoming a dependency.** Once agents and editors call `excavate why`, the
   integration surface is the moat, not the app.

And the honest framing: for an open-source developer tool, **being first, being
excellent, and being loved is the strategy.** Defensibility is a venture question;
adoption is the actual goal.

---

*Next: [Part 5 — Feature Brainstorm](05-feature-brainstorm.md)*
