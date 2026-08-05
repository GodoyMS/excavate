# Execution Roadmap — Ship-Early Plan

**Supersedes [LEAN-V1.md](LEAN-V1.md) §7 and [Part 15](15-execution-plan.md).**
Same scope, resequenced so that **every milestone ends in a public release**.

Nine milestones. First public artifact at week 2. First genuinely useful product at
week 5. v1.0 launch at week 17.

---

## 1. The sequencing principle

The original plan (foundations → analysis → UI → evidence → AI) is the correct
*architectural* order and a terrible *momentum* order: nothing is publicly
interesting until week 13. Four months of silence is how solo projects die.

Three changes fix it without compromising the architecture:

**1. The CLI is the early product.** `excavate stats` and `excavate why` need no UI
and land months before one is possible. A terminal screenshot of knowledge islands on
a famous repository is a genuinely strong artifact — dev-tool audiences respond to
terminal output. The CLI was v0.2/v0.3 in the original plan; it moves to the front.

**2. Defer everything the current milestone doesn't need.** The biggest resequencing
win: `excavate stats` needs no hunks, no eras, no coupling, no revert detection. Those
move to M2 where `why` actually requires them. That's ~2 weeks pulled out of the
critical path to first ship.

**3. v1.0 ships without AI.** Era detection is deterministic; only the *prose* needs a
model. v1.0 launches with template-named eras and the full evidence engine, and AI
narration follows as v1.1 two weeks later.

> **Why v1.0 has no AI — the arguable call.** It directly demonstrates the product's
> central claim ("works with no API key") rather than asserting it. It removes the AI
> quality gate from the launch critical path. It sidesteps risk R4 ("yet another AI
> repo tool") at exactly the moment perception is set. And it converts one launch into
> two news cycles, where the second — *"how we made LLM-generated history explanations
> verifiable"* — is a better engineering story than the first.
>
> **The counter-case:** the Story is less magical with template names, and some of the
> audience treats AI as table stakes. If you disagree, swap M6 and M7 — the dependency
> graph permits it. What you must not do is let AI slip *indefinitely* past launch;
> M7's acceptance criteria are binding either way.

---

## 2. Milestone map

| # | Milestone | Wks | Cum | Version | Public artifact |
|---|---|--:|--:|---|---|
| **M0** | Foundations & fixture DSL | 2.0 | 2 | — | `git-fixtures` package + testing post |
| **M1** | Index engine & `excavate stats` | 3.0 | 5 | **v0.1** | npm release · knowledge-islands screenshot |
| **M2** | Evidence engine & `excavate why` | 3.0 | 8 | **v0.2** | The signature feature, in a terminal GIF |
| **M3** | Web shell & Overview | 2.0 | 10 | **v0.3** | First visual release |
| **M4** | Map & Timeline | 2.5 | 12.5 | **v0.4** | **Persistent Layout time-scrub GIF** |
| **M5** | Story, Why panel, Files, ⌘K | 3.0 | 15.5 | **v0.5** | Feature-complete beta |
| **M6** | Polish & launch | 2.0 | 17.5 | **v1.0** | **Show HN** |
| **M7** | AI narration | 2.5 | 20 | **v1.1** | Citation-validator post |
| **M8** | MCP & GitHub connector | 2.0 | 22 | **v1.2** | Agent-integration post |

**Cadence: a public ship every 2–3 weeks, without exception.**

### Dependency graph

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5 ──▶ M6 ──▶ M7 ──▶ M8
        │      │             │      ▲       ▲             ▲
        │      └─ evidence ──┼──────┘       │             │
        │         engine     │              │             │
        └─ index + analysis ─┴──────────────┘             │
                                    eras (M5) ────────────┘
```

**Hard dependencies only:**

- M2 needs M1's index (hunks and blame require the store).
- M4 needs M3's shell and M1's rollups.
- M5's Why *panel* needs M2's engine — but only the rendering, so it's cheap.
- M7 needs M5's eras and M2's evidence bundles. Nothing else.
- M8 needs a stable query layer, which exists from M2.

**Deliberately not dependencies:** the UI does not block the CLI, and AI does not
block anything. Both are why the plan can ship early.

---

## 3. Definition of Done — applies to every milestone

A milestone is not done until all eight are true. Items 7 and 8 are the momentum
forcing functions, and they are the ones most likely to be skipped under pressure.

1. **Works on all three reference targets** — the fixture corpus, `ripgrep` (~2k
   commits), `rust-analyzer` (~20k commits).
2. **Tests written and green.** Every bug found gets a fixture *before* it gets a fix.
3. **The milestone's perf budget is asserted in CI** and passing.
4. **Works fully offline with no API key** (through M6; M7 adds the AI path and keeps
   the offline path tested).
5. **Docs updated in the same commit** — README and any affected spec page.
6. **Published to npm** with a changelog entry and a git tag.
7. **The public artifact is actually posted.** Not drafted. Posted.
8. **Zero known P0/P1 bugs.** P2s go in the tracker with a milestone label.

---

## 4. The milestones

### M0 — Foundations & fixture DSL · 2 weeks

**Objective.** Establish the workspace and prove one thread through every layer.
Publish the test infrastructure as a standalone package.

**Depends on:** nothing.

**Deliverables**

1. pnpm workspace per [LEAN-V1 §5](LEAN-V1.md), all 9 packages stubbed with their
   public interfaces.
2. CLI skeleton (`commander`), daemon skeleton (Hono + SSE), SQLite schema v1 with
   migrations.
3. **The `repo()` fixture DSL** — deterministic timestamps, authors, and OIDs;
   builders for commit, add, edit, rename, delete, branch, merge, revert, mailmap.
4. **Walking skeleton:** `excavate index` on a fixture → 100 commits in SQLite →
   `GET /commits` → a plain HTML list → click shows the message.
5. CI: build, test, lint, typecheck on Linux and macOS.

**Testing.** Unit tests for every DSL construct (each produces the expected Git
objects, verified by shelling out to `git`). One daemon integration test. CI green.

**Perf budget.** None yet — establish the harness.

**Acceptance criteria**

- [ ] `pnpm dev` starts the daemon and serves the skeleton page from a clean checkout
- [ ] `repo().commit('a', c => c.add('x.ts', '…')).build()` produces a valid repo
- [ ] 100-commit fixture indexes and renders end to end
- [ ] CI green on both platforms

**Public artifact.** Publish `@excavate/git-fixtures` to npm with a real README, plus
a short post: *"Testing git tooling deterministically."* This is a genuinely useful
standalone package — it builds credibility and a small audience before the product
exists.

**Cut first if behind:** the HTML list can be `JSON.stringify`. The DSL cannot be cut;
it's the foundation of every later milestone's testing.

---

### M1 — Index engine & `excavate stats` · 3 weeks · **v0.1**

**Objective.** The first genuinely useful product. A correct index and a terminal
report that tells you something about your codebase you didn't know.

**Depends on:** M0.

**Deliverables**

1. **Streaming git walk** — one `git log --all --first-parent --reverse --numstat -z
   --find-renames=50%` pass, parsed and batched into SQLite ([LEAN-V1
   §5.1](LEAN-V1.md#51-the-one-piece-of-genuinely-careful-engineering)).
2. **Identity merging** — the five-step resolution from [Part 8
   §8.3.1](08-domain-model.md), `.mailmap`, bot detection.
3. **Rename resolution** — file identity with alias chains. *Explicit renames and
   resurrection only; delete+add heuristics deferred to M2.*
4. **Noise classification** — generated, vendored, lockfile-only, bulk mechanical.
5. **Analysis (subset):** significance scoring, ownership with recency decay, bus
   factor, knowledge islands, hotspots.
6. **Incremental update** — fast-forward path. Rewrite detection → full rebuild.
7. **`excavate stats`** — a genuinely well-designed terminal report: repo vitals, cast
   of characters, top hotspots with factor breakdown, knowledge islands, most
   significant commits. `--json` for scripting.

**Explicitly deferred to M2:** hunks, eras, coupling, revert detection, blame. None
are needed for `stats`, and deferring them is what makes 3 weeks feasible.

**Testing**

- Full rename fixture matrix (~12 cases): simple, with-edit, chains, across merges,
  rename-back, resurrection.
- Identity fixtures: mailmap, name variants, email variants, bots, co-authored-by.
- Property tests: alias non-overlap; every `(commit, path)` resolves to exactly one
  `FileId`.
- **Determinism test:** index twice → byte-identical derived tables.
- **The anti-embarrassment test:** on all three targets, assert no format-only,
  generated, or lockfile-only commit appears in the top-50 by significance.
- Snapshot tests of `stats` output per fixture.

**Perf budget.** Walk ≥ 25k commits/min. `ripgrep` full index < 8s. `rust-analyzer`
< 45s. Index ≤ 5% of `.git`.

**Acceptance criteria**

- [ ] `npx excavate stats` works on any repo with no configuration
- [ ] 100% of rename and identity fixtures pass
- [ ] Determinism test passes
- [ ] Hotspots on `rust-analyzer` are recognizable to someone who knows the project
- [ ] Knowledge islands are correct on fixtures with known contributor departures
- [ ] Re-running on an unchanged repo completes in < 1.5s
- [ ] Perf budgets asserted in CI

**Public artifact.** **v0.1 on npm.** A screenshot of `npx excavate stats` on a
well-known repository, leading with the knowledge-islands section. Post framing:
*"One command. No install, no account. Here's what it found in [famous repo]."*

**Cut first if behind:** `--json` output; the cast-of-characters section. **Never cut:**
rename correctness or the determinism test — [risk R1](B-risk-register.md) is the
project's top existential risk and this is the milestone that contains it.

---

### M2 — Evidence engine & `excavate why` · 3 weeks · **v0.2**

**Objective.** The signature feature, in a terminal, with no AI. This is the milestone
that proves the product thesis.

**Depends on:** M1.

**Deliverables**

1. **Hunk extraction** — stored per commit/file for text files under a size cap.
2. **Blame** — via `git blame -C -M` with `.git-blame-ignore-revs`, LRU-cached, with
   the hunk table as a pre-filter.
3. **Rename resolution completion** — delete+add similarity heuristics, merge
   reconciliation.
4. **Revert / re-land detection** — all three confidence tiers ([Part 8
   §8.5.3](08-domain-model.md)).
5. **PR reference mining** — `(#N)`, `Merge pull request #N`, `PR-URL:`, `Change-Id`.
   Offline, free, and covers most GitHub repos.
6. **Six evidence collectors** — Blame, CommitContext, PrReference, RevertPair,
   TemporalNeighbor, TestSibling.
7. **Ranking and budget fitting** — the four-factor score, dedup, per-kind floors,
   stable `E#` IDs.
8. **Deterministic confidence** with enumerated reasons.
9. **Change coupling** (cheap, and File Evolution needs it later).
10. **`excavate why <path>:<line>`** — cited chain rendered for a terminal;
    `--json` for scripting and agent use.

**Testing**

- Per-collector unit tests on fixtures with known histories.
- **Ranking tests:** for 20 hand-labelled targets, the correct evidence ranks first.
- Bundle hash stability across runs and across incremental updates.
- Confidence calibration on 20 hand-labelled cases.
- Revert-pair fixtures: explicit, diff-inverse, message-only, revert-with-no-reland.
- Blame correctness with copies, moves, and ignored revisions.

**Perf budget.** Bundle assembly < 250ms on `rust-analyzer` (cold blame), < 50ms warm.

**Acceptance criteria**

- [ ] `excavate why src/foo.ts:42` returns a useful chain in < 250ms
- [ ] Revert/re-land pairs appear, correctly ordered
- [ ] PR references extract correctly from squash-merge subjects on a real GitHub repo
- [ ] Confidence is HIGH only when a substantive body or PR reference exists
- [ ] Gaps are named explicitly ("no PR body cached")
- [ ] **The gate:** five people who have never seen the tool can explain unfamiliar
      code using only this output. If they can't, the fix is evidence *ranking* — do
      not proceed to M3 until it passes.

**Public artifact.** **v0.2 on npm.** A terminal GIF: `git blame` on a confusing line,
then `excavate why` on the same line. Post framing: *"`git blame` tells you who.
`excavate why` tells you why — with receipts, and no LLM."*

This is the strongest single artifact before v1.0. Give it real production effort.

**Cut first if behind:** TestSibling and TemporalNeighbor collectors (down to 4);
change coupling (defer to M5). **Never cut:** the five-person gate. It is the only
protection against building a chat tool by accident.

---

### M3 — Web shell & Overview · 2 weeks · **v0.3**

**Objective.** The first visual release. Establishes every UI pattern the rest of the
project follows.

**Depends on:** M1 (data), M0 (daemon).

**Deliverables**

1. **`excavate .`** → indexes → opens `127.0.0.1:<port>/?token=…` in the default
   browser.
2. **Design tokens** ([Part 12 §12.3](12-design-system.md)) — both themes,
   APCA-verified.
3. **~14 components** on Radix + Tailwind, including `CommitRef`, `PersonChip`,
   `FilePath`, `MetricWithEvidence`, `ConfidenceBadge`.
4. **App shell** — three-column layout, collapsible panels, status bar.
5. **URL as state** — routing, deep links, back/forward.
6. **⌘K** — commands and entity navigation (FTS5 content search lands in M5).
7. **Overview view**, complete, on real data.
8. **Indexing progress screen** — streaming facts, never a bare spinner.
9. **Loading / empty / error / partial states** per [Part 12
   §12.9](12-design-system.md).

**Testing.** Component tests for each `ui` export. `axe-core` on every route in both
themes — zero critical violations. Keyboard-only navigation test. Deep-link
round-trip test.

**Perf budget.** Overview interactive < 1.5s on `rust-analyzer` (warm index). ⌘K opens
in < 50ms.

**Acceptance criteria**

- [ ] `excavate .` opens a browser with real data, no configuration
- [ ] Every action is keyboard-reachable; `⇧?` lists all bindings
- [ ] Deep links round-trip exactly
- [ ] Both themes pass APCA thresholds
- [ ] Zero unstyled empty or error states
- [ ] Zero critical `axe` violations

**Public artifact.** **v0.3 on npm.** Screenshot of the Overview with the
knowledge-islands and hotspots sections. Post framing: *"`excavate .` now opens a
real UI."* Modest, but it keeps the cadence and shows visual quality for the first
time.

**Cut first if behind:** the light theme (dark only, ship light in M6); ⌘K commands
(entities only).

---

### M4 — Map & Timeline · 2.5 weeks · **v0.4**

**Objective.** The differentiator. This milestone produces the best artifact of the
entire pre-launch period.

**Depends on:** M3 (shell), M1 (rollups).

**Deliverables**

1. **Canvas2D scene renderer** — ~400 lines: layer compositing, camera with pan/zoom,
   quadtree picking, DOM label overlay, dirty-region redraw.
2. **Squarified treemap** with the **stable-ordering rule** (children ordered by path,
   never by size).
3. **Persistent Layout** — positions computed once over the union of all files that
   have ever existed; time changes opacity and color only.
4. **Directory aggregation** above 15k files.
5. **Five lenses** — age, churn, ownership, hotspot, knowledge risk. Switching is a
   color-buffer swap, cross-faded.
6. **Timeline band** — activity ribbon, release markers, draggable global time cursor,
   `[`/`]` stepping, semantic zoom over precomputed buckets.
7. **Global time propagation** — scrubbing updates the Map and every panel.
8. **Accessible table twin** (`T`).

**Testing**

- **Layout determinism:** identical input → identical output, cross-platform.
- **Persistent Layout assertion:** scrub across the full history, assert no cell
  position changes numerically. This is the milestone's most important test.
- Picking accuracy at three zoom levels.
- Table twin contains identical data to the canvas.

**Perf budget.** 12k cells at 60fps pan/zoom. Lens switch < 100ms. Timeline scrub
60fps. Initial layout < 500ms.

**Acceptance criteria**

- [ ] Map renders `rust-analyzer` at 60fps
- [ ] Lens switching < 100ms with no relayout
- [ ] **Scrubbing time moves no cell** — asserted numerically, not by eye
- [ ] Timeline shows recognizable release markers
- [ ] `T` toggles a working table view
- [ ] Reduced-motion mode is complete and good

**Public artifact.** **v0.4 on npm.** *The* GIF: dragging the time cursor from 2019 to
2025 while the Map fills in, then cycling lenses. Post framing: *"Watching a codebase
grow. The trick is that nothing moves — positions are computed once and frozen, so
your eye can actually track what's happening."*

Pair it with a short technical post on Persistent Layout. This is the most interesting
visualization-engineering idea in the project and it deserves its own writeup.

**Cut first if behind:** two lenses (ship age, churn, hotspot); semantic zoom on the
Timeline (fixed monthly granularity). **Never cut:** Persistent Layout or its test.

---

### M5 — Story, Why panel, Files, ⌘K search · 3 weeks · **v0.5**

**Objective.** Feature-complete beta. Every v1.0 capability present, in rough form.

**Depends on:** M4 (treemap reuse), M2 (evidence engine).

**Deliverables**

1. **Era detection** — binary segmentation over the 5-dimension weekly series, robust
   z-scoring, boundary snapping to releases, short-era merging, `boundary_reason`.
2. **Story view** — era scroll with template-generated names and structured summaries,
   key commits, reverts, contributors, releases.
3. **Directory-mass panel** — a treemap per era that morphs on scroll ([LEAN-V1
   §6.1](LEAN-V1.md#61-the-replacement-for-the-architecture-sidecar)). Reuses M4's
   treemap.
4. **Why panel in the UI** — evidence chain, confidence badge, gaps, superscript
   citations. The engine already exists; this is rendering.
5. **`?` binding** on line, file, and directory targets.
6. **File Evolution view** — life ribbon, churn sparkline, ownership bands, key
   commits, coupled files, embedded CodeMirror with the line-age gutter.
7. **FTS5 search in ⌘K** — commits, paths, entities; grouped results.

**Testing**

- **Era stability:** identical boundaries across runs and across incremental updates.
- Every era carries a defensible `boundary_reason`.
- File Evolution correctness on renamed and resurrected fixture files.
- Line-age heatmap matches blame ground truth.
- Search relevance on 20 labelled queries.
- E2E: the full demo path as a Playwright test.

**Perf budget.** Story renders < 800ms. ⌘K first results < 50ms. File Evolution
< 400ms.

**Acceptance criteria**

- [ ] Eras on `rust-analyzer` land on transitions its maintainers would recognize
- [ ] Every era's `boundary_reason` is human-readable and defensible
- [ ] The Story is worth reading with template names and no prose
- [ ] `?` works from the Map, the file tree, and inside the code view
- [ ] File Evolution shows the complete life of a twice-renamed file
- [ ] ⌘K returns useful results in < 50ms

**Public artifact.** **v0.5 beta on npm.** A 60-second screen recording of the full
loop: Overview → Story → Map → scrub → click a hotspot → File Evolution → `?`. Post
framing: *"Feature-complete beta. Still zero API keys."* Explicitly ask for feedback
before v1.0 — this is the milestone where external input can still change things.

**Cut first if behind:** the directory-mass morph (static per-era treemap); CodeMirror
integration (plain `<pre>` with the gutter). **Never cut:** era stability testing —
[risk R5](B-risk-register.md).

---

### M6 — Polish & launch · 2 weeks · **v1.0**

**Objective.** The difference between "works" and the [Part 2
§2.5](02-principles.md) quality bar.

**Depends on:** M5.

**Deliverables**

1. **Performance pass** — profile every budget, fix every regression, optimize the
   three worst paths.
2. **Accessibility audit** — manual keyboard pass, screen-reader pass on every view,
   `axe` clean, table twin verified.
3. **Copy pass** — every string against [Part 12 §12.11](12-design-system.md); every
   empty and error state written by a person.
4. **Visual polish** — motion timing, spacing rhythm, focus states, dark/light parity.
5. **Onboarding** — first-run flow, `excavate --demo` with a bundled pre-indexed
   fixture, a skippable tour.
6. **`excavate doctor`** — environment, git version, index integrity, disk space.
7. **Documentation** — user docs, troubleshooting, `CONTRIBUTING.md`, good-first-issues
   labelled.
8. **Website** — excavate.dev with the demo GIF and docs.
9. **Cross-platform verification** — manual QA on macOS, Linux, Windows.

**Testing.** All perf budgets green. Full manual a11y audit including a real screen
reader. Clean-machine install from npm on all three platforms. The Part 6 §6.5 demo
script running as an automated E2E test. **Ten external testers** complete an
"understand this unfamiliar repo" task; time and friction recorded.

**Acceptance criteria**

- [ ] Every [LEAN-V1](LEAN-V1.md) perf budget met
- [ ] Zero critical a11y violations; screen-reader pass complete
- [ ] Install → first insight in < 3 minutes, measured across 10 testers
- [ ] `excavate --demo` works with no repository and no configuration
- [ ] Windows verified manually
- [ ] Every M0–M5 acceptance criterion still passing

**Public artifact.** **v1.0 — Show HN.** The launch post leads with *"reads your git
history, tells you why the code is the way it is, needs no API key and no account."*
Screenshots before prose. The Persistent Layout post is already published and can be
linked as depth.

**Cut first if behind:** the tour (the first-run flow is enough); the website (README
carries it). **Never cut:** the a11y audit or the external-tester round.

---

### M7 — AI narration · 2.5 weeks · **v1.1**

**Objective.** Cited prose, with the validator that makes it trustworthy.

**Depends on:** M5 (eras), M2 (bundles). Nothing depends on this.

**Deliverables**

1. **Three providers** — Anthropic, OpenAI-compatible (covers Ollama, LM Studio,
   OpenRouter, OpenAI, Groq), Deterministic. Capability flags, not descriptors.
2. **Two pipelines** — era narration, Why synthesis.
3. **Prompt architecture** — versioned templates, static/volatile split for prompt
   caching, cache-effectiveness asserted in CI.
4. **Citation validator** — all four checks, three verdicts ([Part 10
   §10.6](10-ai-architecture.md)). Rejection falls back to the deterministic renderer.
5. **Budget system** — pre-flight estimate from real `count_tokens`, runtime meter from
   `usage` fields, hard limits.
6. **30-case eval harness**, weighted adversarial; CI integration.
7. **Settings UI** — provider config, keychain storage, budget.

**Testing**

- Provider conformance: all three pass the same behavioural suite.
- **Validator adversarial fixtures:** hallucinated IDs, ungrounded numerics, uncited
  sentences — all rejected.
- **Prompt-injection fixtures** in commit messages do not alter behaviour.
- Cache: identical bundle → cache hit, zero tokens.
- Cost estimate within 15% of actual across 20 runs.
- **The offline suite still passes with no provider configured.**

**Acceptance criteria**

- [ ] The Story generates for `rust-analyzer` in < 2 min for < $1.50
- [ ] Every generated sentence carries a resolvable citation
- [ ] Citation precision ≥ 0.95; hallucination rate ≤ 0.02 on the 30 cases
- [ ] Cost estimate shown before every paid run
- [ ] A local model via Ollama produces acceptable output
- [ ] **Everything still works with no provider configured** — full offline E2E green

**Public artifact.** **v1.1.** Post: *"Making LLM-generated code history verifiable."*
Lead with the validator and the rejection path, not the feature. Show a rejected
generation and the fallback. This is the most interesting AI-engineering story in the
project and it is differentiated precisely because everyone else ships the feature and
skips the validator.

**Cut first if behind:** the settings UI (config file only); Why synthesis (ship era
narration alone). **Never cut:** the validator or the offline test.

---

### M8 — MCP & GitHub connector · 2 weeks · **v1.2**

**Objective.** Turn the tool into infrastructure, and close the biggest remaining
quality gap.

**Depends on:** M2 (query layer), M7 for the confidence-model update.

**Deliverables**

1. **`excavate mcp`** — the typed toolset (`search_commits`, `blame`, `file_history`,
   `why`, `who_owns`, `find_prs`) over stdio and HTTP, versioned, documented for agent
   integration.
2. **GitHub connector** — PR bodies, review threads with line-position mapping, linked
   issues, incremental sync, ETag caching, rate-limit handling, token in the keychain.
3. **Forge evidence collector** + confidence model update.
4. **"The Debate"** section in the Why panel.

**Testing.** MCP conformance per tool. Cassette-based connector tests exercising
rate-limit and pagination paths. Everything still works with no forge configured.

**Acceptance criteria**

- [ ] An agent configured with `excavate mcp` answers a history question it otherwise
      could not
- [ ] With GitHub connected, Why confidence measurably rises on the eval set
- [ ] Review comments map to the correct lines
- [ ] Rate-limit exhaustion degrades gracefully with a clear staleness indicator

**Public artifact.** **v1.2.** Post: *"Your coding agent has no memory of why the code
is that way. Now it can ask."* Include a copy-pasteable MCP config block — the goal is
for people to add it to their agent setup in under a minute.

---

## 5. Momentum protocol

Solo projects fail by stalling, not by building the wrong thing. Six rules, and the
first is the one that matters.

**1. Timebox the milestone, not the scope.** Dates are fixed; scope is the variable.
Every milestone above has a pre-declared **"cut first if behind"** list. When you hit
the date, you cut from that list and ship. You never slip a ship date.

**2. Write the announcement before the milestone starts.** One paragraph and a
description of the screenshot, committed to `docs/ships/MN.md` on day one. If you
can't write a compelling paragraph, the milestone's scope is wrong — fix it before
building, not after.

**3. Never more than three weeks between public ships.** If a milestone is
overrunning, split it and ship the half that works.

**4. Ship to npm every milestone from M1.** Real users from week 5 means real issues,
real feedback, and the accountability that makes the cadence stick. A private branch
is where momentum goes to die.

**5. Fixture-first bug fixing.** Every bug gets a fixture before it gets a fix. This
is the only discipline that keeps a solo project's regression suite honest, and it
compounds.

**6. One day of dogfooding per milestone.** Run Excavate on Excavate. Findings become
issues. The tool's own history is a genuinely good test corpus by M3.

### Slip protocol

| Behind by | Action |
|---|---|
| < 3 days | Absorb it. No action. |
| 3–7 days | Cut from the milestone's pre-declared cut list. Ship on date. |
| > 7 days | Split the milestone. Ship the working half as a point release, move the rest to the next milestone, and re-baseline everything after it. |

Never: extend a milestone twice; skip the public artifact to "catch up"; or work on a
later milestone's scope while the current one is unshipped.

---

## 6. What lands when

For anyone tracking the product rather than the plan:

| Week | You can | Version |
|---:|---|---|
| 2 | Generate deterministic git fixtures for your own tests | — |
| **5** | **Run one command and learn where your codebase's risk is** | v0.1 |
| **8** | **Ask why any line of code exists, and get a cited answer** | v0.2 |
| 10 | See it in a browser | v0.3 |
| **12.5** | **Watch your codebase grow, and see where the pain is spatially** | v0.4 |
| 15.5 | Read your repository's history as a story | v0.5 |
| **17.5** | **Recommend it to someone** | **v1.0** |
| 20 | Have it explain itself in prose, with citations | v1.1 |
| 22 | Let your coding agent query it | v1.2 |

The bolded rows are the ones worth a real launch effort. The others keep the cadence.
