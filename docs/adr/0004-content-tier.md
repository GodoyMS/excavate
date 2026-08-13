# ADR-0004: Add a third indexing tier for hunks, splitting "needs git" from "needs only the store"

Status: accepted
Date: 2026-08-13
Deciders: Godoy Muñoz

## Context

[LEAN-V1 §3.3](../spec/LEAN-V1.md) trims Part 8's four indexing tiers to **two**: "Metadata (UI
usable) and Analysis (everything else)." A test asserts that count — `ships 2 indexing tiers, not
4` — and it failed when M2's hunk extraction landed, which is the fitness function doing its job
rather than an inconvenience to route around.

M2 needs hunk geometry for every commit ([ROADMAP M2](../spec/ROADMAP.md) deliverable 1). Two
facts about that work constrain where it can live:

1. **It is a second `git` traversal, and cannot be part of the first.** `--patch` puts arbitrary
   file content on the wire, so no byte is available to delimit commit records with — `ripgrep`'s
   patch output contains one `\x01`, one `\x02`, and one literal NUL. See `hunkArgs` in
   `@wise-excavate/git`. This is not a preference; the streams are physically separate.
2. **It is expensive.** Measured: `rust-analyzer` 12,864 commits, 9.7s for the hunk pass against
   11.5s for the metadata walk and analysis together. It roughly doubles a cold index.

Quality attributes in play:

- **Time to first usable index.** The two-tier split exists so the UI can render after
  `metadata`. Whatever holds hunks must not delay that.
- **Invalidation cost.** Part 7 §7.2.3 gives every analyzer a `version()` so that changing one
  formula recomputes that analyzer and its dependents — not the whole index. The unit of
  invalidation must not straddle "recompute from the store" and "re-read from git".
- **Layering (Part 8 §8.1).** Ground truth is never derived from a higher layer. Hunks are
  ground truth: they come from git and are not computed from anything.

## Decision

We will add a third tier, `content`, ordered `metadata → content → analysis`. It holds hunk
geometry and nothing else. `TIERS` becomes three values, and the LEAN-V1 §3.3 row is amended from
"2" to "3" with this ADR as the reason.

## Options considered

### Option A — A third `content` tier (chosen)

The tier boundary becomes **"what needs a git traversal" versus "what needs only the store"**,
which is the line invalidation actually cares about.

- **Pros:** `metadata` stays the fast path to a usable UI. Bumping the significance formula
  recomputes `analysis` alone — no git process, no patch parse. Ground truth and derived data stay
  in separate tiers, so §8.1's layering rule is visible in the tier list rather than only in prose.
- **Cons:** Three tiers where LEAN-V1 promised two, and every `Record<Tier, …>` gains a case —
  the progress printer needed a unit for it. One more state a partial index can be in.
- **Cost to reverse:** Low. Tiers are a runtime list plus a filter in `session.ts`; merging
  `content` into another tier later is a small change with no schema implications.

### Option B — Put hunks in the `analysis` tier

LEAN-V1's own framing is "Analysis (everything else)", so hunks arguably belong there by
definition, and the tier count stays at two.

- **Pros:** Honours the promised count. No new case anywhere.
- **Why rejected:** It breaks invalidation. `analyzer_runs` exists so that changing a formula
  recomputes only what depends on it; if hunks lived in `analysis`, bumping the hotspot weights
  would either re-run a full `git log --patch` for nothing, or force per-analyzer granularity
  _inside_ the tier — which is the tier split again, unnamed and undocumented. It also puts ground
  truth in the derived tier, which is precisely the inversion §8.1 forbids.

### Option C — Put hunks in the `metadata` tier

- **Why rejected:** `metadata` is defined as "UI usable". Adding a second full traversal to it
  doubles time-to-first-render, which is the one thing the two-tier split was for. On
  `rust-analyzer` that is 11.5s becoming 21s before anything can be shown.

### Option D — Do nothing; skip hunk storage

- **Why rejected:** `excavate why` is M2's entire thesis and cannot answer a line-level question
  without line-level geometry. Blame alone would mean blaming whole files per query, which misses
  M2's 250ms budget by an order of magnitude.

## Consequences

**Positive.** Time to a usable index is unchanged. Formula changes recompute without touching
git. The tier list now documents the ground-truth/derived boundary that previously lived only in
comments. `format-only` becomes derivable for the first time, retiring an M1 P2.

**Negative.** LEAN-V1's tier count is no longer 2, and this is the first numeric commitment in
that document to move — worth noting as precedent, because the value of a lean plan is that its
numbers are not negotiable by default. A cold index is roughly twice as slow: `ripgrep` 1.0s →
1.5s, `rust-analyzer` 11.5s → 21s. Both remain inside ROADMAP M1's budgets (8s and 45s), which is
what makes this acceptable rather than merely convenient; had either exceeded its budget, the
decision would have been to make `content` opt-in per command instead.

**Neutral.** `excavate stats` now builds hunks it does not yet read. That is deliberate: one
complete index beats making `excavate why` discover in M2 that it must re-index, and the
`format-only` work that consumes them lands in this same milestone.

## Enforcement

The test that caught this — `ships 2 indexing tiers, not 4` in `packages/core/src/core.test.ts` —
is updated to assert **3** and to name this ADR. It keeps its job: a fourth tier will fail it, and
whoever adds one has to come here and argue for it. `IMPLEMENTED_TIERS` in `session.ts` is the
second gate: a tier in `TIERS` but not there is reported to the user as an unbuilt gap, so a tier
cannot be declared and left unimplemented without the CLI saying so.
