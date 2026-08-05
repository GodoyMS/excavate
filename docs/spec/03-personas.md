# Part 3 — User Personas

Five personas. The first two are the design targets — if a feature does not serve
Priya or Marcus, it needs an unusually good argument. The last three are important
validators whose needs mostly overlap with the first two.

Each persona ends with **the feature it justifies**, so the traceability from person
to product is explicit.

---

## 3.1 Priya — The New Joiner

> *Senior backend engineer, 9 years experience, week 1 at a 60-person company.
> Inherited a 6-year-old Python/TypeScript service with 31k commits and 140
> contributors, 90 of whom have left.*

### Her week

- **Day 1–2:** Clones the repo. Opens it in her editor. Scrolls. Closes it. Reads
  the README, which was last meaningfully updated in 2022 and describes a
  directory structure that no longer exists.
- **Day 3:** Asks a teammate "where does the payment flow live?" and gets a
  10-minute whiteboard session that answers 20% of her questions and consumes an
  hour of a senior engineer's day.
- **Day 4–8:** Reads code linearly. Builds a mental model that is roughly correct
  about structure and completely absent about *intent*.
- **Week 2–4:** Ships small changes, cautiously. Twice, a reviewer says "we tried
  that in 2023, it caused X" — information that existed in the repo and that she
  had no way to find.
- **Week 6:** Feels productive. Six weeks of ramp for a senior hire.

### Her actual pain

- She does not know **what matters**. 31k commits, and she cannot tell which 60 of
  them are the ones that shaped the system.
- She does not know **who to ask** without pinging the whole channel.
- She keeps discovering **unwritten rules** by violating them in review.
- She cannot distinguish **deliberate weirdness from accidental weirdness**, so she
  treats all of it as sacred and the codebase never improves.

### What she does with Excavate

1. `excavate .` on day 1. Reads **The Story** in 20 minutes. Now she has the arc:
   monolith → extraction → the failed GraphQL experiment → the current shape.
2. Opens the **Map**, switches to the **age lens**. Instantly sees the 2019 core
   (dark, untouched) versus the 2025 rewrite (bright). Switches to **knowledge
   risk** and sees which two subsystems have nobody left who understands them.
3. Hits `?` on anything confusing, and gets the reasons instead of guessing.
4. Uses **Contributor** view not as a ranking but as a routing table: "for the
   payments module, the top current knowledge holder is Sam."

**Time to productive: days instead of weeks.** This is the headline outcome and the
primary thing the product optimizes.

> **Justifies:** Story, Map + lenses, Why, Overview, ownership routing.

---

## 3.2 Marcus — The Maintainer / Tech Lead

> *Staff engineer, 5 years on the same codebase, maintains a 14k-star OSS project on
> the side. Knows most of the history personally and is therefore a single point of
> failure.*

### His week

- Answers the same five history questions repeatedly, in Slack and in PR reviews.
- Reviews a drive-by contribution that violates an architectural constraint that
  exists only in his head.
- Is asked to estimate a refactor and has no data on where the actual risk is.
- Knows two subsystems are fragile but cannot demonstrate it to a planning meeting.
- Worries — correctly — about what happens when he takes a sabbatical.

### His actual pain

- He is a **human documentation server** and it is eating his week.
- He has **intuitions he cannot evidence**, so risky areas do not get prioritized.
- Onboarding new contributors costs him personally, every time.
- Architectural intent decays silently because nobody writes ADRs.

### What he does with Excavate

1. Runs it on his own repo and finds it **agrees with his intuition about the
   hotspots** — which is the moment he decides to trust it.
2. Uses **Hotspots + Knowledge Risk** in planning: "this module has 3× the fix
   density of anything else and a bus factor of 1" is an argument that wins.
3. When a contributor asks "why is this structured this way," he pastes a deep link
   to the Why panel instead of typing four paragraphs.
4. Publishes an `.excavate-pack` with each release so contributors can explore the
   project's history without indexing or an API key.
5. Uses **mined Decisions** as the ADR log the project never wrote.

> **Justifies:** Hotspots, knowledge risk, deep links, `.excavate-pack` export,
> Decisions.

---

## 3.3 Dana — The Archaeologist / Incident Responder

> *SRE-leaning senior engineer. Called into unfamiliar code at 2am, or assigned to a
> "figure out why this is like this before we migrate it" investigation.*

### Her moments

- **2am:** a service is failing in a code path she has never read. She needs to know
  what changed recently near the failure and whether this failure has happened
  before.
- **Post-incident:** writing the retro, she needs the actual chain — what
  introduced the bug, what the review said, whether it was reverted before.
- **Pre-migration:** she must determine whether a 200-line function full of special
  cases can be simplified, or whether each special case is a scar from a real
  outage.

### Her actual pain

- `git log` is chronological, not *relevant*. She needs "what changed near this
  line, ranked by likely relevance," and no tool provides it.
- Prior incidents are invisible in the code. The revert that happened in 2023 is not
  discoverable from the file today.
- Special-case code is indistinguishable from cruft.

### What she does with Excavate

1. `excavate why src/billing/proration.ts:210-260` from the terminal, gets a cited
   chain in her incident doc without opening a GUI.
2. Uses **SZZ-derived history**: "this line's introducing commit has been implicated
   in 3 later fix commits." That is a red flag with receipts.
3. Uses **File Evolution** to see the file's whole life in one screen — churn
   sparkline, revert markers, authors over time, the six commits that mattered.

> **Justifies:** CLI `why`, SZZ-lite, File Evolution, revert/re-land detection.

---

## 3.4 Sam — The Open-Source Contributor

> *Wants to fix one bug in a project they have never seen. Has 90 minutes of
> motivation and will spend it on either understanding or contributing, not both.*

### Their pain

- CONTRIBUTING.md explains the build, not the codebase.
- The relevant module has no comments and three abstraction layers.
- They cannot tell whether the pattern they see is the project's convention or one
  contributor's habit.
- If understanding takes longer than 30 minutes, they close the tab. The
  contribution never happens.

### What they do with Excavate

1. Load a maintainer-published `.excavate-pack`, or run `excavate .` (works with no
   key, so there is no signup wall between them and value).
2. Read the Story's most recent era only — enough to know current direction.
3. Search semantically for the concept they are fixing; land on the right file.
4. `?` on the confusing abstraction; discover it exists to support a plugin API they
   did not know about — and write a correct patch on the first try.

> **Justifies:** zero-key first run, `.excavate-pack`, semantic search, hosted demo.

---

## 3.5 Riley — The AI Agent Operator

> *Runs coding agents against a large codebase. The agents are strong at writing
> code and blind to history.*

### Their pain

- Agents reintroduce previously-reverted approaches because nothing tells them the
  approach was tried and failed.
- Agents delete "unnecessary" code that exists for a reason not visible at `HEAD`.
- Feeding history into an agent's context is a manual, token-expensive mess.

### What they do with Excavate

1. `excavate mcp` and point their agent at it. The agent now has `blame`,
   `symbol_history`, `find_prs`, `who_owns`, and `search_commits` as typed tools.
2. Their agent's system prompt gains one line: *"Before removing or rewriting
   non-obvious code, call `excavate.why` on it."*
3. Failure rate on history-dependent edits drops measurably.

This persona is strategically important out of proportion to its size: it turns
Excavate from an app into a dependency.

> **Justifies:** MCP server, typed query toolset, daemon-first architecture.

---

## 3.6 Cross-persona synthesis

### The questions everyone asks

Ranked by frequency across all five personas — this is effectively the product
backlog, and every one maps to an MVP feature.

| Rank | Question | Served by |
|---|---|---|
| 1 | Why does this code exist / why is it like this? | **Why panel**, CLI `why` |
| 2 | What is this project, in five minutes? | **Overview**, **Story** |
| 3 | Where should I look for X? | **⌘K semantic search**, **Map** |
| 4 | Who knows about this? | **Ownership model** |
| 5 | What has changed here recently, and why? | **Timeline**, **File Evolution** |
| 6 | Where is the risk concentrated? | **Hotspots**, **knowledge risk** lens |
| 7 | How did the architecture get this shape? | **Story** + architecture sidecar |
| 8 | Has this been tried before? | **Revert/re-land detection**, **Decisions** |
| 9 | What is safe to change? | **Coupling** + hotspots + Why |

### The shared emotional need

Every persona is, underneath, asking for **permission to act**. They are blocked not
by missing code knowledge but by uncertainty about consequences. Excavate's real job
is converting *"I don't know what happens if I touch this"* into *"I know why this is
here, and now I can decide."*

That reframing is why the confidence rating matters as much as the answer, and why
"I don't know" must be a respectable output. A tool that reduces uncertainty
honestly is more useful than one that eliminates it dishonestly.

### Anti-persona: the Engineering Manager measuring output

Someone will want per-developer productivity reporting. Excavate does not serve this
persona, by design (Part 2, P7). Serving them would poison the tool for every
persona above — the moment engineers believe Excavate might be used to evaluate
them, they stop recommending it and start resenting it. This is a permanent no.

---

*Next: [Part 4 — Competitive Analysis](04-competitive-analysis.md)*
