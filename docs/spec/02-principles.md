# Part 2 — Product Principles

These exist to settle arguments. When two reasonable engineers disagree about a
feature, a layout, or a prompt, the resolution is here — not in whoever argues
longest.

---

## 2.1 The core philosophy

### P1 — The one-question test

> **Does this help a developer understand a codebase faster?**

Every feature, every panel, every setting must answer yes. Not "is it interesting."
Not "is it impressive." Not "would some users want it." Faster understanding, or
it does not ship.

Applications of the test that have already cut features:

- A commit-frequency-by-hour-of-day heatmap: *interesting, does not aid
  understanding.* Cut.
- A PR review turnaround dashboard: *a process metric, not a comprehension aid.*
  Cut.
- A "code health score" out of 100: *a number with no evidence behind it that
  invites arguing about the number instead of reading the evidence.* Cut. Replaced
  by evidence-backed risk signals that link to the commits that justify them.

### P2 — Understanding, not statistics

A number without an explanation is noise. Excavate may display a metric only when
the metric is **clickable through to its evidence**.

- Bad: "Complexity: 47."
- Good: "This file changes 4× more often than its neighbours, and 38% of those
  changes are bug fixes → [see the 19 fix commits]."

Every derived value in the UI carries a provenance path. If we cannot explain a
number in one sentence and link to its inputs, we do not show it.

### P3 — Evidence over assertion

Restating the contract from Part 1 because it governs the AI, the UI, and the
copy:

> **Every claim is traceable to a SHA, a line range, a PR, or an issue.**

Consequences that follow mechanically:

- Generated prose carries inline evidence markers, validated post-generation.
- The UI always offers "show the evidence" next to any interpretation.
- Confidence is displayed and its reasons are enumerated.
- "I don't know, here is what I found" is a **correct** output, and the UI treats it
  as a first-class result rather than an error state.

### P4 — Deterministic first, AI second

The pipeline order is fixed and non-negotiable:

```
git data → deterministic analysis → evidence assembly → [AI narration] → validation
```

AI is applied at exactly the points where a human would write prose, and nowhere
else. Specifically, AI **never**:

- decides which commits are significant (that is a scored, deterministic function);
- determines file ownership (a decay model);
- identifies era boundaries (change-point detection — the model only *names* them);
- retrieves evidence (structural traversal does that);
- computes any number the UI displays.

Why this matters beyond correctness: it is what makes the tool free, offline,
reproducible, and fast. Reversing this order would produce a product that is slower,
costlier, less trustworthy, and identical to every other repo-chat tool.

### P5 — Local-first, always

The repository never leaves the machine unless the user explicitly enables a cloud
model, and even then only the assembled evidence bundle — never the whole repo — is
transmitted. There is no account, no sync, no phone-home, and no telemetry code path
in the binary. `excavate .` on an air-gapped laptop is a fully supported
configuration and is covered by CI.

### P6 — Honest about limits

Where the data is thin, say so. A repository with `fix`, `wip`, and `asdf` commit
messages and no PR data will produce low-confidence answers, and Excavate will show
low-confidence answers rather than confident fiction. This costs us some demo
sparkle on bad repos and buys us the thing that actually matters: an engineer's
trust the second time they use it.

### P7 — Anti-surveillance, by construction

Excavate will never ship:

- individual productivity metrics of any kind;
- LOC, commit-count, or velocity leaderboards;
- comparative "who is more effective" views;
- exports designed for performance management.

It *will* ship expertise mapping, bus-factor analysis, and "who should I ask"
routing — framed around the code's risk, not a person's output. The distinction is
whether the subject of the sentence is a file or a human.

If a user asks for a leaderboard, the answer is no, in the issue tracker, publicly,
with this section linked.

---

## 2.2 UX philosophy

### U1 — The UI is the product; AI is a capability

The interface must be complete and coherent with the AI turned off. AI enriches
panels that already exist; it never *is* a panel. There is no chat tab. There is no
floating assistant bubble. The `?` key opens a structured, mostly-deterministic
evidence panel that happens to include a generated summary at the top.

### U2 — Answer questions the user didn't know to ask

Passive interfaces wait. Excavate volunteers:

- On the Overview: "3 files have a bus factor of 1 and their only author has been
  inactive for 8 months."
- On opening a file: "This file has been reverted twice. [see both]"
- On the Timeline: an era boundary marker at a mass-rename commit the user would
  never have found.

Volunteered insight must obey P2 and P3 — always evidence-linked, never a bare
alarm.

### U3 — Time is global state

There is exactly one time cursor in the application, owned by URL state. Scrubbing
the Timeline updates the Map, the file list, the ownership panel, and the
architecture diagram simultaneously. Views never carry private, desynchronized time
selections. This single decision is what makes the app feel like one instrument
rather than a folder of dashboards.

### U4 — Everything is deep-linkable

Every view state — including time cursor, active lens, selected entity, and open
panel — is encoded in the URL. `excavate://repo/abc123?view=map&lens=knowledge-risk&t=2021-06-14&focus=src/api`
must reconstruct the exact screen. This makes state sharable in Slack, bookmarkable,
and testable, and it costs nothing if designed in from the start (and is nearly
impossible to retrofit).

### U5 — Motion explains; it never decorates

Every animation must encode a fact:

- Shared-element transitions when the same entity persists across views (the file
  rectangle in the Map becomes the file header in the File view).
- Cells fading in on the Map as files are born; fading out as they are deleted.
- The evidence chain drawing top-to-bottom in causal order.

Banned: loading shimmer on content that is already available, decorative parallax,
easing on anything the user is directly dragging (direct manipulation is 1:1 or it
feels broken), and any animation over 300ms on a frequently-repeated interaction.
`prefers-reduced-motion` is honoured, and the reduced path must be *good* — instant
state changes with a brief highlight, not a broken layout.

### U6 — Chrome is achromatic; color means data

The application shell is near-monochrome. Saturated color is reserved entirely for
data encoding, because the Map's lenses need the whole color budget. A UI that
spends its color on buttons cannot then use color to mean "this code is old."

This single rule is responsible for most of why the app will look expensive.

### U7 — Keyboard-complete

Every action reachable by mouse is reachable by keyboard. `⌘K` is the universal
entry point. The keymap is Linear-flavoured (`g` prefix for goto, `?` for why,
`[`/`]` for time stepping). Power users should never need the pointer, and the
existence of a complete keymap is what makes the app feel fast even when it isn't.

### U8 — Progressive disclosure of complexity

The Overview is readable by someone who has never seen the tool. The Map's lens
selector is one click away. The evidence chain's raw diff hunks are one more click.
The SQL console over the index is behind a developer-mode flag. Depth exists at
every layer; none of it is in the way.

### U9 — Every visualization has an accessible twin

Any canvas-rendered view provides a toggle to an equivalent semantic representation
(a sortable, keyboard-navigable table). This is an accessibility requirement, but it
is also a usability and integration win: the table view is copy-pasteable,
screen-reader navigable, and mirrors exactly what the CLI would print.

---

## 2.3 AI philosophy

### A1 — Narrate, never retrieve

The model receives a bundle that deterministic code assembled and ranked. It does
not choose what to look at. This eliminates the entire class of "the model searched
for the wrong thing and confidently summarized irrelevant results."

The one exception is the **investigation escalation** path (Part 10 §10.7), where a
user explicitly opts into an agentic loop over a small typed toolset. Even there,
the tools are structural queries against the index — never free-form shell.

### A2 — Cite or refuse

The prompt requires an evidence marker per sentence. The validator enforces it. An
answer that cannot be grounded is returned as "insufficient evidence" with a list of
what is missing ("no PR body available for #412 — connect GitHub to improve this
answer"), which is both honest and a natural upsell to the forge connector.

### A3 — Cost is visible and pre-authorized

Before any paid operation, Excavate shows an estimate:

> Generating the Story for this repository will process ~180k input tokens and
> produce ~24k output tokens across 9 requests. Estimated cost: **$0.94**. [Proceed]
> [Use local model] [Cancel]

A running cost meter is visible in the status bar during generation, and a
configurable hard budget aborts the run. Nobody else does this well, and it converts
the single biggest source of AI-tool anxiety into a trust signal.

### A4 — Reproducibility is a feature

Every generated artifact stores a run manifest: model ID, prompt template version,
effort setting, and the hash of the evidence bundle. This makes narratives
auditable, regenerable, cacheable, and diffable when a prompt changes. It is also
what allows the cache to be correct: identical evidence + identical template +
identical model = reuse, no matter how long ago.

### A5 — The cheapest correct model wins

Model selection is per-pipeline, not global. Bulk commit classification runs on a
small fast model through the Batch API; era narration and Why synthesis run on the
strongest available model because those are the outputs the user reads. Defaults are
specified in Part 10 §10.3; users can override any of them.

### A6 — Local models are a supported tier, not a checkbox

Ollama and llama.cpp are first-class providers. The prompt templates have a
constrained variant for smaller context windows and weaker instruction-following, and
the eval harness runs against a local model in CI. If the local tier degrades
silently, we have broken P5.

---

## 2.4 Developer & engineering philosophy

### D1 — Boring core, sharp edges

The data layer is deliberately conservative: SQLite, a documented schema, plain
files. The novelty budget is spent on the renderer, the evidence engine, and the
lineage algorithms — the parts that are actually hard and actually differentiate.
Novel storage engines would consume that budget for no user-visible gain.

### D2 — The index is inspectable

`sqlite3 ~/.cache/excavate/<id>/index.db` must be a productive thing to do. Tables
are named for humans, foreign keys are real, and a `docs/schema.md` is generated
from migrations. This is a DX gift to plugin authors and a debugging gift to us.

### D3 — Modularity at the seams that will actually move

Trait boundaries are placed where we have concrete evidence of future churn:
`GitBackend` (gitoxide vs. the `git` CLI), `LanguageProvider` (per-language symbol
extraction), `ForgeConnector` (GitHub, GitLab, Gerrit), `LanguageModel` (AI
providers), `Lens` (Map coloring), `Analyzer` (fact producers). We do not abstract
anything else on speculation.

### D4 — Performance budgets are tests, not aspirations

Stated in Part 13 §13.9 and asserted in CI against tiered corpora. A PR that
regresses index throughput by >10% or interaction latency past 16ms fails. Perf
that is not measured is perf that is already gone.

### D5 — Correctness on weird repos is table stakes

Octopus merges, orphan branches, submodules, `.mailmap`, CRLF, unicode paths,
shallow clones, empty commits, binary files, symlinks, `.git-blame-ignore-revs`,
force-pushed rewritten history. Each has a fixture in the test corpus. Git is a
40-year accumulation of edge cases and any tool that pretends otherwise is a demo.

### D6 — Make the common contribution trivial

Ranked by expected contribution volume:

1. Language packs → **declarative TOML + tree-sitter queries, zero Rust.**
2. Lenses → a small scoring function, registerable from a plugin.
3. Analyzers → a WASM component with a typed interface.
4. Core changes → full Rust, RFC required.

If tier 1 requires touching Rust, we get 5 language packs instead of 50.

### D7 — Ship a walking skeleton in week one

Before building any subsystem properly, an end-to-end thread must exist: index 100
commits → serve them over the API → render a timeline → click a commit. It
de-risks every interface at once and gives every later milestone a place to land.

---

## 2.5 The quality bar

We are explicitly benchmarking against Linear, Raycast, Arc, Vercel, Figma, and
Notion. Concretely, that means:

| Dimension | The bar |
|---|---|
| First paint | Under 2s on a 10k-commit repo — no blank screens, no spinners without content |
| Interaction latency | Under 16ms; ⌘K results under 50ms |
| Frame rate | 60fps sustained while panning/zooming 100k rendered elements |
| Empty states | Every one is designed, useful, and tells you what to do next |
| Error states | Every one names the cause and offers an action |
| Typography | Tabular numerals in all data; a real type scale; no default system stack |
| Keyboard | Complete; discoverable via `?`-shortcuts overlay |
| Copy | Written by a person. No "Oops! Something went wrong." |
| Install | One command, one binary, no runtime prerequisites |
| First run | Delightful, informative progress; zero configuration required |

---

## 2.6 What we deliberately give up

Stating trade-offs explicitly so they are not relitigated:

- **Multi-repository views.** Real value for monorepo-adjacent orgs; enormous
  complexity for the domain model. Deferred past v1.
- **Real-time collaboration.** Adds a server, accounts, and a sync engine to a
  local-first tool. Explicitly not our product.
- **In-app editing.** Excavate is read-only on the working tree. This is a safety
  property and a scope guard.
- **Full history for pathological repos on first run.** For repos above a size
  threshold we index metadata fully and hunks partially, and we say so with a
  visible "partial index" badge. Silent truncation is banned; honest partial
  coverage is fine.
- **Windows-first polish.** Supported and CI-tested, but macOS and Linux get the
  first pass on visual QA. Stated so nobody is surprised.

---

*Next: [Part 3 — User Personas](03-personas.md)*
