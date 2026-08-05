# Part 12 — UI/UX Design System

---

## 12.1 Application shell

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ⌘ excavate/react            [Overview Story Map Timeline Files]    ⌘K  ⚙  │ ← 44px
├────────────┬──────────────────────────────────────────────┬───────────────┤
│            │                                              │               │
│  CONTEXT   │              PRIMARY VIEW                    │   INSPECTOR   │
│            │                                              │               │
│  Tree /    │        (Overview | Story | Map |             │   Why panel   │
│  Filters / │         File Evolution | Search)             │   Details     │
│  Lenses    │                                              │   Evidence    │
│            │                                              │               │
│  240px     │                 flexible                     │     380px     │
│  ⌘B toggle │                                              │   ⌘I toggle   │
├────────────┴──────────────────────────────────────────────┴───────────────┤
│  2019 ─────────── 2021 ─────────── 2023 ──────────▲── 2025     TIMELINE   │ ← 96px
├───────────────────────────────────────────────────────────────────────────┤
│ ● indexed · 12,481 commits · lens: knowledge risk · $0.04 this session    │ ← 24px
└───────────────────────────────────────────────────────────────────────────┘
```

**Why this layout.** Three columns and a persistent timeline is the standard
professional-tool arrangement (Figma, Linear, Xcode) because it maps cleanly onto
*navigate → work → inspect*. Excavate adds the fourth region — time — as a permanent
band, because time is the axis the entire product is organized around and hiding it
in a menu would make the concept abstract.

Both side panels collapse. The Story view collapses both by default; reading wants
width.

---

## 12.2 Navigation model

### 12.2.1 Primary views

| View | Shortcut | Purpose |
|---|---|---|
| Overview | `g o` | Orientation. The landing screen. |
| Story | `g s` | The narrative. Eras, cited. |
| Map | `g m` | Spatial. Lenses. |
| Timeline | `g t` | Temporal detail (the band is always visible; this expands it) |
| Files | `g f` | Tree + File Evolution |
| Search | `g /` | Full search results |
| People | `g p` | Cast, expertise routing |
| Decisions | `g d` | Mined ADR log *(v0.3)* |

Flat, not nested. Eight destinations is the ceiling; a ninth requires removing one.

### 12.2.2 Selection is global

Like time, selection is application state. Clicking a Map cell, a search result, a
tree node, or a Timeline marker sets the current entity, and every panel reacts. The
Inspector always shows the current selection. This is what removes the "which panel
is this about?" confusion that plagues multi-panel tools.

### 12.2.3 URL as state

```
excavate://<repo-id>/map
  ?lens=knowledge-risk
  &t=2021-06-14T00:00:00Z
  &window=2020-01-01,2022-01-01
  &projection=first-parent
  &focus=file:src/webhook/sender.ts
  &panel=why
  &why=line:210-224
```

Every state is reconstructible. Back and forward work. Links are shareable. Deep
links from the CLI (`excavate open --at 2021-06`) and from editor extensions land
exactly where intended.

---

## 12.3 Design tokens

### 12.3.1 Color — the chrome/data split

**Rule (Part 2, U6): chrome is achromatic; saturated color means data.**

```css
/* ── Dark (default) ─────────────────────────────────────────── */
--bg-base:        #0B0C0E;   /* app background */
--bg-surface:     #121417;   /* panels */
--bg-raised:      #191C21;   /* cards, popovers */
--bg-overlay:     #21252B;   /* menus, dialogs */
--bg-hover:       rgb(255 255 255 / 0.04);
--bg-active:      rgb(255 255 255 / 0.08);

--border-subtle:  rgb(255 255 255 / 0.06);
--border-default: rgb(255 255 255 / 0.10);
--border-strong:  rgb(255 255 255 / 0.18);

--fg-primary:     #E8EAED;   /* APCA Lc ~ 92 on --bg-base */
--fg-secondary:   #A0A6AE;   /* Lc ~ 62 */
--fg-tertiary:    #6B7280;   /* Lc ~ 42 — never for body text */
--fg-inverse:     #0B0C0E;

/* the ONE chrome accent — selection, focus, active nav */
--accent:         #D89B4A;   /* excavation ochre */
--accent-muted:   rgb(216 155 74 / 0.14);

/* semantic, used sparingly and never as the only signal */
--danger:         #E5534B;
--warning:        #D89B4A;
--success:        #57A773;
--info:           #4A9EDB;
```

Light theme mirrors the scale with inverted luminance and a warm off-white base
(`#FAF9F7`), tuned so both themes pass APCA Lc ≥ 75 for body text and Lc ≥ 60 for
secondary.

### 12.3.2 Data color scales

Isolated from chrome tokens so the two can never be confused in code.

```css
/* Sequential — perceptually uniform, warm (age, churn, complexity, hotspot) */
--seq-0: #1B1B1F;  --seq-1: #3A2E28;  --seq-2: #5E4530;
--seq-3: #855D33;  --seq-4: #AE7735;  --seq-5: #D89B4A;
--seq-6: #EDBF7A;  --seq-7: #F7DFB4;

/* Diverging — knowledge risk, deltas, coverage */
--div-neg-3: #1F6F5C; --div-neg-2: #3E9B82; --div-neg-1: #7FC4B0;
--div-mid:   #2A2D33;
--div-pos-1: #E0A183; --div-pos-2: #C96A4E; --div-pos-3: #A03D28;

/* Categorical — ownership, languages. Okabe-Ito derived, max 8 + "other" */
--cat-1: #4A9EDB;  --cat-2: #E69F00;  --cat-3: #57A773;  --cat-4: #CC79A7;
--cat-5: #56B4E9;  --cat-6: #D55E00;  --cat-7: #B2A25D;  --cat-8: #8C74C4;
--cat-other: #5A5F66;
```

All validated for deuteranopia, protanopia, and tritanopia. Categorical encodings are
always paired with a second channel (pattern, label, or position) so color is never
the sole carrier of meaning.

### 12.3.3 Typography

```css
--font-ui:   "Inter Variable", -apple-system, "Segoe UI", system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", "Cascadia Code", monospace;
--font-prose:"Inter Variable", Georgia, serif;   /* Story body */

--text-2xs: 10px/14px;   /* axis labels, dense chart text */
--text-xs:  11px/16px;   /* metadata, timestamps */
--text-sm:  13px/20px;   /* UI default */
--text-base:14px/22px;   /* body */
--text-lg:  16px/26px;   /* Story body */
--text-xl:  20px/28px;   /* section headings */
--text-2xl: 28px/36px;   /* era titles */
--text-3xl: 36px/44px;   /* page titles */

--tracking-tight: -0.011em;  /* headings */
--tracking-normal: 0;
--tracking-wide: 0.02em;     /* small caps, labels */
```

**Non-negotiables:**

- `font-variant-numeric: tabular-nums` on **every** number in the interface. Columns
  of digits that jitter as they update look amateur and are harder to compare.
- The Story uses a longer measure (~68ch) and larger leading than the rest of the app.
  It is the only place designed for sustained reading.
- Monospace for SHAs, paths, code, and identifiers. Always.

### 12.3.4 Space, radius, elevation

```css
/* 4px base grid */
--sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
--sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-12: 48px; --sp-16: 64px;

--radius-sm: 4px;   /* inputs, chips */
--radius-md: 6px;   /* buttons, cards */
--radius-lg: 10px;  /* panels, dialogs */

/* Elevation: borders first, shadows sparingly. Dark UIs get muddy with shadows. */
--elev-1: 0 1px 2px rgb(0 0 0 / 0.24);
--elev-2: 0 4px 12px rgb(0 0 0 / 0.32);
--elev-3: 0 12px 32px rgb(0 0 0 / 0.44);
```

---

## 12.4 Component inventory

Deliberately small. Every component is a maintenance cost and an inconsistency risk.

### Primitives (`@excavate/ui`)

Built on Radix primitives for accessibility, styled with Tailwind v4 against the
tokens above.

`Button` · `IconButton` · `Input` · `Select` · `Combobox` · `Toggle` ·
`SegmentedControl` · `Tooltip` · `Popover` · `Dialog` · `Tabs` · `Badge` ·
`Separator` · `ScrollArea` · `Skeleton` · `Toast`

### Domain components

| Component | Notes |
|---|---|
| `CommitRef` | Short SHA (mono) + subject + relative date. Hover card with full detail. Used in ~30 places — the most important single component in the app. |
| `PersonChip` | Avatar (gravatar or generated) + name. Hover: tenure, top areas. Never a rank. |
| `FilePath` | Ellipsized with directory de-emphasis; copy-on-click; rename indicator. |
| `EvidenceCard` | Kind icon, excerpt, locator, certainty badge, jump link. |
| `EvidenceChain` | The vertical causal timeline in the Why panel. |
| `ConfidenceBadge` | HIGH/MEDIUM/LOW + reason tooltip. Never color-only. |
| `LensSelector` | Segmented control + legend + peek affordance. |
| `TimeScrubber` | The Timeline control surface. |
| `MetricWithEvidence` | A number that is always clickable through to its inputs (Part 2, P2 enforced in a component). |
| `EraCard` | Story chapter header block. |
| `CostMeter` | Status-bar spend indicator + budget state. |
| `SparklineChurn` | Tiny inline activity chart with markers. |
| `CodeView` | CodeMirror 6 + age gutter + `?` affordance. |

`MetricWithEvidence` deserves emphasis: making the evidence link *structural* rather
than *optional* means a developer physically cannot ship a bare number.

---

## 12.5 The Why panel

The most designed component in the product.

```
┌──────────────────────────────────────────────────────────┐
│  WHY                                              ✕      │
│  src/webhook/sender.ts : 210–224                         │
├──────────────────────────────────────────────────────────┤
│  Retry-with-jitter was added after synchronized retries  │
│  produced a thundering herd against a failing endpoint.¹ │
│  The first attempt was reverted the same day for         │
│  hammering upstream,³ and re-landed two days later with  │
│  the current backoff.⁴                                   │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ⬤ HIGH CONFIDENCE                                  │  │
│  │   PR body available · revert/re-land pair found ·  │  │
│  │   test changed in the same commit                  │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  THE CHAIN                                               │
│                                                          │
│   ●  2021-08-14  a1b2c3d          Dana R.                │
│   │  fix: add jitter to webhook retry (#412)             │
│   │  ↳ PR #412 · 9 comments · closes #398                │
│   │  ↳ also changed: sender.test.ts, reliability.md      │
│   │                                                      │
│   ✖  2021-08-14  9f8e7d6   REVERTED                      │
│   │  "retry loop hammered upstream"                      │
│   │                                                      │
│   ●  2021-08-16  4c5d6e7   RE-LANDED                     │
│      reland: retry with jitter                           │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  THE DEBATE                                    3 of 9 ▾  │
│  ❝ Can we bound the max delay? A 30s retry on a          │
│    webhook is worse than a drop. ❞  — Priya, on #412     │
├──────────────────────────────────────────────────────────┤
│  GAPS                                                    │
│  Issue #398 is not cached.  [ Connect GitHub ]           │
├──────────────────────────────────────────────────────────┤
│  Not enough?  [ Investigate deeper — est. $0.03 ]        │
└──────────────────────────────────────────────────────────┘
```

Design decisions worth stating:

- **Superscript citations, not inline brackets.** `[E1]` in reading text is hostile;
  superscript numerals are the convention readers already know. Hovering highlights
  the corresponding chain entry; clicking scrolls to it.
- **Confidence is above the fold and enumerated.** Not a subtle icon.
- **Gaps are an upsell, honestly framed.** "Issue #398 is not cached" plus a button
  is more useful and more honest than silently producing a worse answer.
- **The cost of escalation is shown before the click.**
- **With no model configured**, the prose block is replaced by the top three evidence
  cards under the heading "What we found." The panel is not degraded — it is the same
  panel minus one section.

---

## 12.6 The command bar

```
┌────────────────────────────────────────────────────────────────┐
│  ⌘  retry jitter                                               │
├────────────────────────────────────────────────────────────────┤
│  FILES                                                         │
│   ◈  src/webhook/sender.ts                    hotspot #3       │
│   ◈  test/webhook/sender.test.ts                               │
│  COMMITS                                                       │
│   ●  a1b2c3d  fix: add jitter to webhook retry (#412)  2021-08 │
│   ●  4c5d6e7  reland: retry with jitter                2021-08 │
│  SYMBOLS                                                       │
│   ƒ  sendWithRetry()                    src/webhook/sender.ts  │
│  COMMANDS                                                      │
│   ⚡ Switch lens → Knowledge risk                               │
│   ⚡ Jump to 2021-08                                            │
├────────────────────────────────────────────────────────────────┤
│  ↑↓ navigate   ⏎ open   ⌘⏎ open in inspector   ⇥ filter kind   │
└────────────────────────────────────────────────────────────────┘
```

- Results grouped by kind, interleaved by score, capped at 5 per group.
- `⇥` cycles a kind filter; typing `>` scopes to commands; `@` to people; `#` to
  commits; `/` to paths. Familiar from every good command bar.
- First results in < 50ms (lexical); semantic results stream in and re-rank without
  reordering what the user is already looking at — **never move a row under a
  descending finger.**
- Recents and pins when the input is empty.

---

## 12.7 Keyboard model

### Global

| Key | Action |
|---|---|
| `⌘K` | Command bar |
| `?` | Why (on the current selection) |
| `⇧?` | Shortcut overlay |
| `⌘B` / `⌘I` | Toggle context / inspector panel |
| `⌘\` | Split view *(v1.0)* |
| `⌘,` | Settings |
| `Esc` | Dismiss, or step out one level |

### Navigation (`g` prefix, Linear-style)

`g o` Overview · `g s` Story · `g m` Map · `g t` Timeline · `g f` Files ·
`g p` People · `g d` Decisions · `g /` Search

### Time

| Key | Action |
|---|---|
| `[` / `]` | Step back / forward one bucket |
| `,` / `.` | Nudge |
| `⇧[` / `⇧]` | Previous / next era |
| `⌥[` / `⌥]` | Previous / next release |
| `space` | Play / pause |
| `⌘0` | Reset to HEAD |

### View-specific

| Key | Context | Action |
|---|---|---|
| `L` | Map | Cycle lens |
| hold `space` | Map | Peek previous lens |
| `↑↓←→` | Map | Move selection spatially |
| `⏎` | Map | Drill in |
| `j` / `k` | Lists | Next / previous |
| `⌘F` | Any | Find in view |
| `T` | Any canvas view | Toggle accessible table twin |

Discoverability: `⇧?` opens a searchable overlay; every menu item shows its binding;
tooltips include the key.

---

## 12.8 Interaction patterns

| Pattern | Rule |
|---|---|
| **Hover** | Reveals information, never triggers navigation or mutation |
| **Click** | Selects (updates global selection + inspector) |
| **Double-click** | Drills in / opens |
| **`?`** | Explains the current selection |
| **Right-click** | Context menu with the same actions available elsewhere — never exclusive functionality |
| **Drag** | Only for the time cursor, panning, and panel resizing. Nothing else is draggable. |
| **Long press / hold** | Peek (temporary state that reverts on release) |

**Progressive disclosure ladder**, applied consistently:

```
glance → tooltip → inspector panel → dedicated view → raw evidence → SQL console
```

Each rung is one interaction from the previous. The last rung is behind a
developer-mode flag, and it exists because Part 2's D2 promises an inspectable index.

---

## 12.9 States

### Loading

Never a bare spinner. Three treatments by duration:

| Duration | Treatment |
|---|---|
| < 100ms | Nothing. Rendering a spinner for 80ms is worse than a brief pause. |
| 100ms – 2s | Skeleton matching the eventual layout |
| > 2s | Progress with **specific, changing facts** ("resolving renames — 8,200 / 12,481 commits") |

The indexing screen (§M1, Part 6) is the flagship: streaming facts, not a bar.

### Empty

Every empty state answers *why it is empty* and *what to do*:

| Where | Copy |
|---|---|
| No search results | "No matches for `retry jitter`. Semantic search is still indexing — results may improve in ~40s." |
| File with one commit | "This file has been touched once, in its creating commit. There is not much history to dig into yet." |
| No AI provider | "Excavate is running without a model. Everything here is computed from your repository — only the written summaries are missing. [Set up a model] [Use a local model]" |
| No PR data | "This repository has no cached pull-request data. Commit messages are the only narrative source, which lowers confidence. [Connect GitHub]" |

### Errors

Cause, consequence, action — in that order, in plain language:

> **Could not read `.git/objects/pack/pack-a1b2.idx`**
> The pack index is unreadable, so 2,481 commits could not be indexed. Everything
> else loaded normally.
> `[ Retry ]  [ Run git fsck ]  [ Continue without them ]`

Banned: "Oops!", "Something went wrong", raw error strings, stack traces in the UI
(they go to the log, with a copy button).

### Partial

When the index is incomplete (Part 9 §9.3.4), a persistent, non-modal badge in the
status bar expands to exactly what was skipped and offers to complete it. Partial
state is never invisible.

---

## 12.10 Accessibility

Not a checklist item — a design input, because a canvas-heavy app is accessible by
construction or not at all.

| Requirement | Implementation |
|---|---|
| Keyboard complete | Every action has a binding; focus order is logical; focus is always visible |
| Focus indication | 2px `--accent` ring with 2px offset; never removed, never subtle |
| Screen reader | Semantic HTML; ARIA only where semantics are insufficient; live regions for async results |
| **Canvas views** | Accessible twin toggle (`T`) — a sortable, navigable table with identical data |
| Contrast | APCA Lc ≥ 75 body, ≥ 60 secondary, ≥ 45 large. Verified in CI. |
| Color independence | Every color encoding is paired with text, shape, or position |
| Motion | `prefers-reduced-motion` fully honoured with a designed alternative |
| Zoom | Usable to 200% browser zoom without horizontal scroll |
| Targets | ≥ 32×32px interactive targets (desktop density) |
| Text | No text baked into images or canvas |

CI runs `axe-core` on every route in both themes; critical violations fail the build.
A manual keyboard-only pass is part of the release checklist.

---

## 12.11 Copy guidelines

The interface's voice is **a knowledgeable colleague, not a product**.

| Do | Don't |
|---|---|
| "This file was renamed from `src/hooks.ts` in 2021." | "File rename event detected." |
| "Nobody who has touched this file in the last year is still active." | "⚠️ Knowledge Risk: HIGH" |
| "We could not find a reason for this code. Here is what we did find." | "No results." |
| "Estimated cost: $0.94" | "This operation may incur charges." |
| "3 of 9 review comments" | "Comments (9)" |

Rules: no exclamation marks; no emoji in the interface chrome (they are fine in
generated prose if the repo's own voice uses them); no anthropomorphizing the tool
("I found" → "Excavate found" or, better, just state the finding); numbers always
with units and always with a click-through.

---

## 12.12 Density and responsiveness

Excavate is a **desktop application**. It targets ≥ 1280×800 and is optimized for
1600×1000+. There is no mobile layout and no apology for that — the Map and Timeline
require pixels.

| Width | Behaviour |
|---|---|
| ≥ 1600px | Full three-column + timeline |
| 1280–1600px | Inspector auto-collapses; opens over content on demand |
| 1024–1280px | Context panel auto-collapses too; Timeline shortens to 64px |
| < 1024px | Single column, tab-switched views, Timeline as a compact scrubber. Functional, not the target. |

A **density toggle** (comfortable / compact) adjusts row heights and font sizes by one
step. Compact is the default on displays over 1920px wide, because a spacious layout
on a large monitor wastes the information advantage that monitor exists to provide.

---

*Next: [Part 13 — Technical Architecture](13-technical-architecture.md)*
