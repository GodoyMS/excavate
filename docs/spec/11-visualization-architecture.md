# Part 11 — Visualization Architecture

Visualizations are not illustrations of the data — they are the primary interface.
This part specifies how they are computed, rendered, animated, and kept fast.

---

## 11.1 Principles

### V1 — Stability over optimality

A layout that is 20% less space-efficient but identical between renders beats an
optimal layout that reshuffles. Humans navigate by spatial memory; moving things
destroys it. **Every layout in Excavate is deterministic given its inputs**, and
where time is a variable, positions are frozen (§11.3.2).

### V2 — Hairballs are a bug class

No view renders "everything." Every graph view is focus + context with a hard node
budget. When the budget is exceeded, nodes aggregate into cluster nodes rather than
overflowing. A force-directed tangle is treated as a P1 rendering bug, not an
aesthetic preference.

### V3 — Encode with the strongest available channel

Ranked by human perceptual accuracy: position > length > angle > area > color
saturation > color hue. Excavate uses position for identity (stable), area for
magnitude, and color for the *active lens only*. Color is never spent on chrome
(Part 2, U6).

### V4 — Semantic zoom, not geometric zoom

Zooming does not just scale pixels; it changes what is represented. Timeline zoomed
out shows monthly aggregates and release markers; zoomed in it shows individual
commits. Map zoomed out shows directories; zoomed in it shows files, then symbols.

### V5 — Every visualization has an accessible twin

A toggle to a semantically equivalent table (Part 2, U9). Same data, same filters,
same sort, keyboard navigable, screen-reader friendly, copy-pasteable.

### V6 — 60fps or redesign

If a view cannot hit 16ms frame budget at its target scale, the view's design is
wrong — reduce what is drawn (LOD, aggregation, culling) rather than accepting jank.
Jank on direct manipulation makes an application feel broken in a way no amount of
polish elsewhere repairs.

---

## 11.2 Rendering strategy

### 11.2.1 The three-tier rule

| Tier | Technology | When | Why |
|---|---|---|---|
| **SVG** | React-rendered DOM | < 500 elements, needs text/a11y/CSS | Free hit-testing, accessible, styleable, printable |
| **Canvas2D** | Imperative | 500 – 5,000 elements | 10× SVG throughput, no GPU dependency, universally available |
| **WebGL2** | Custom instanced renderer | > 5,000 elements | The only option at 100k elements/60fps |

WebGL2 rather than WebGPU as the primary target: WebGPU availability inside Linux
WebKitGTK (the Tauri Linux WebView) is unreliable in 2026, and WebGL2 is universal.
WebGPU is a progressive enhancement behind a capability check, used for the
time-lapse particle effects where it helps and nowhere load-bearing.

### 11.2.2 The scene renderer — `@excavate/canvas`

A small internal package rather than a charting library, because the requirements
(instanced rendering, stable identity across frames, LOD, picking at 100k elements,
shared-element transitions between views) are not what charting libraries optimize
for, and fighting one is more work than writing 2,000 lines of renderer.

```ts
interface Scene {
  layers: Layer[];              // z-ordered
  camera: Camera;               // pan + zoom, animatable
  picker: SpatialIndex;         // R-tree, rebuilt only on layout change
}

interface Layer {
  id: string;
  primitives: PrimitiveBuffer;  // typed arrays: xywh, color, id
  lod: LodPolicy;
  visible(camera: Camera): boolean;
}
```

**Key techniques:**

- **Instanced quads.** One draw call for all treemap cells. Per-instance attributes
  (position, size, color, opacity) live in typed arrays uploaded as a single buffer.
- **Picking via ID buffer.** An off-screen render target encodes entity ID in RGB.
  Hover reads one pixel. This is O(1) regardless of element count and is dramatically
  simpler and faster than CPU-side hit testing at scale.
- **Dirty-region rendering.** Color-only changes (a lens switch) update the color
  buffer and re-render without touching geometry or the spatial index.
- **LOD by screen area.** Cells below ~4px² are merged into their parent's
  representation. Labels render only above a legibility threshold, and are
  DOM-overlaid (not canvas text) so they are selectable and accessible.
- **Text is never drawn in WebGL.** Labels are absolutely-positioned DOM elements
  synced to the camera, capped at ~200 visible. This keeps text crisp, selectable,
  translatable, and accessible — and avoids the entire SDF-font-atlas project.

### 11.2.3 Layout computation — `excavate-layout`, compiled twice

The same Rust crate is compiled to a native library (used by the daemon for
one-shot expensive layouts, cached to disk) and to WASM (used in a Web Worker for
interactive layouts that must respond to dragging).

Why not compute all layouts server-side? Because a force-directed graph the user is
dragging needs ~10 iterations per frame at 60fps; a round trip per frame is not
viable. Why not compute all layouts client-side? Because the initial treemap of a
50k-file repository takes ~800ms, which belongs in a cached artifact, not in the
user's first paint.

Identical code in both places means no drift between the cached layout and an
interactively recomputed one — a class of bug that would otherwise appear as
mysterious jumps.

---

## 11.3 The Repository Map

### 11.3.1 Layout algorithm

**Squarified treemap**, hierarchical by directory.

| Considered | Verdict |
|---|---|
| **Squarified treemap** | **Chosen.** Good aspect ratios, deterministic, fast, and — decisively — *stable* under the ordering rule below. |
| Voronoi treemap | Beautiful; iterative, slow, and unstable across inputs. Fatal for time-scrubbing. |
| Circle packing | Wastes 20–30% of space; poor for deep hierarchies. |
| Force-directed | Non-deterministic, hairball-prone, no containment semantics. |
| Space-filling curve | Perfectly stable and perceptually illegible. |

**The stability rule:** children are ordered by a stable key (path name), never by
size. Standard squarified treemaps sort by descending size for aspect ratio, which
means a file growing by one line can leap across the canvas. We take slightly worse
aspect ratios in exchange for positions that mean something.

```rust
pub fn squarify(node: &DirNode, rect: Rect, opts: &TreemapOpts) -> Vec<Cell> {
    let mut children = node.children.clone();
    children.sort_by(|a, b| a.stable_key.cmp(&b.stable_key));  // NOT by size
    // …standard squarified row packing over the stable order…
}
```

### 11.3.2 The Persistent Layout guarantee

The single most important visualization decision in the product.

```
Layout is computed ONCE, at the reference revision (default HEAD),
over the UNION of all files that have EVER existed in the repository.

Scrubbing time changes cell OPACITY and COLOR. It never changes cell
POSITION or SIZE.
```

Concretely, at time *t*:

| File state at *t* | Rendering |
|---|---|
| Exists | Full opacity, lens color |
| Not yet created | Invisible (its slot is empty and reserved) |
| Deleted before *t* | Invisible (slot reserved) |
| Being created at *t* (playback) | Fades in over 240ms with a brief highlight |
| Being deleted at *t* (playback) | Fades out over 240ms |

**Why this matters so much:** the naive implementation recomputes the treemap at each
timestep. Every file appearing or disappearing reflows every sibling, and scrubbing
becomes an unreadable boil of moving rectangles. With Persistent Layout you can watch
a subsystem fill in over two years and *understand what you are seeing*. It is the
difference between a screensaver and an instrument.

**The cost:** allocating space for files that no longer exist means the present-day
map has gaps. Mitigation: a **"Compact"** toggle that recomputes the layout for the
current time only — useful when the user is not scrubbing, and clearly labelled as
breaking positional continuity. Default is Persistent.

The layout artifact is computed at index time and cached in `layout/treemap-head.bin`
(Part 9 §9.1). Cost: ~800ms for 50k files, once.

### 11.3.3 Lenses

A lens is a pure function plus a scale:

```rust
pub trait Lens {
    fn id(&self) -> LensId;
    fn value(&self, file: FileId, window: TimeWindow, ctx: &LensCtx) -> Option<f32>;
    fn scale(&self) -> ColorScale;
    fn legend(&self) -> Legend;
}
```

| Lens | Value | Scale |
|---|---|---|
| Age | days since last meaningful change | Sequential, perceptually uniform (warm) |
| Churn | commits in window, log-scaled | Sequential (cool) |
| Ownership | dominant owner | Categorical, ≤8 Okabe-Ito-derived hues + grey "contested" |
| Complexity | LOC × nesting proxy | Sequential |
| Hotspot | composite score | Sequential (warm, high-contrast top decile) |
| Knowledge risk | bus factor × owner inactivity | Diverging (safe → at-risk) |
| Test coverage *(if present)* | coverage % | Diverging |

**Switching a lens is a color-buffer swap.** No relayout, no re-upload of geometry,
cross-faded over 180ms. Measured target: < 100ms end to end.

All scales are perceptually uniform, colorblind-safe, and validated for APCA
contrast against both themes. A "colorblind-safe categorical" mode is not a setting —
it is the only palette we ship.

### 11.3.4 Interaction

| Input | Behaviour |
|---|---|
| Hover | Tooltip: path, size, age, owner, current lens value, hotspot rank |
| Click | Select — drives every other panel (Part 2, U3-adjacent: selection is global too) |
| Double-click | Drill into directory; breadcrumb appears |
| `⌘F` | Search overlay; matches pulse, non-matches desaturate |
| Scroll | Zoom at cursor |
| Drag | Pan |
| `L` | Cycle lens |
| `Esc` | Zoom out one level |
| Space (hold) | Peek: temporarily show the previous lens for comparison |

The peek gesture is worth the 20 lines — comparing two lenses is a constant need, and
holding a key is much better than a side-by-side split (Part 5 §5.2).

---

## 11.4 The Timeline

### 11.4.1 Composition

```
┌────────────────────────────────────────────────────────────────────────┐
│  2019      2020        2021         2022        2023      2024   2025  │ ← axis
├────────────────────────────────────────────────────────────────────────┤
│ ▁▂▅█▇▅▃▂▁▁ ▁▃▅▆█▇▅▃▂ ▂▄▆███▇▅▃▁ ▁▂▄▅▆▅▄▃▂ ▁▁▂▃▄▃▂▁ ▂▃▄▅▄▃  │ src/
│ ▁▁▂▃▂▁     ▁▂▄▅▄▂▁    ▃▅▇█▆▄▂    ▁▂▃▂▁      ▁▁▂▁     ▁▂▃▂    │ web/
│            ▁▂▃▂▁       ▂▄▅▄▂      ▃▅▆▅▃      ▄▆█▇▅    ▅▇█▆   │ api/
│ ▁▂▁         ▁▁          ▁▂▁        ▁▁▂▁       ▁▂▁      ▁▁     │ docs/
├────────────────────────────────────────────────────────────────────────┤
│    ▲v1.0        ▲v2.0      ▲v2.5        ▲v3.0      ▲v3.5   ▲v4.0       │ releases
│ ╎ Founding    ╎ Growth   ╎ TS Migration ╎ Extraction ╎ Maturity        │ eras
│           ✖             ✖✖          ✖              ✖                    │ incidents
└────────────────────────────────────────────────────────────────────────┘
                              ▲ time cursor (draggable)
```

- **Subsystem rows** are auto-derived: top-level directories, merged where co-change
  strength exceeds a threshold, capped at 8 rows with the remainder as "other."
- **Band height** = activity volume (log-scaled); **band color** = active lens.
- **Era boundaries** render as geological strata lines — a deliberate visual pun that
  also happens to be the clearest way to show a partition.
- **Incident markers** are revert clusters, not individual reverts. Three reverts in
  a week is a signal; one is Tuesday.

### 11.4.2 Data and level of detail

Timeline buckets are precomputed at index time at three granularities (day, week,
month) in the `timeline_buckets` table. Zoom selects granularity; there is no
aggregation at query time. This is what makes scrubbing hit the 16ms budget.

| Zoom | Granularity | Bars for 6 years |
|---|---|---|
| Full history | Month | 72 |
| 2 years | Week | 104 |
| 3 months | Day | 90 |
| 2 weeks | Day + individual commit ticks | ~14 + n |

### 11.4.3 The global time cursor

```ts
interface TimeState {
  cursor: Timestamp;              // the "now" for every view
  window: [Timestamp, Timestamp]; // the analysis window for windowed lenses
  playing: boolean;
  speed: number;
  projection: HistoryProjection;
}
```

Owned by URL state, propagated through a React context, consumed by every view. This
is architectural, not cosmetic: it is what makes the application feel like one
instrument (Part 2, U3).

Interactions: drag the cursor; drag on the ribbon to set a window; `[`/`]` to step by
the current granularity; `,`/`.` to nudge; `space` to play/pause; click any marker to
jump.

### 11.4.4 Time-lapse playback (v1.0)

Playing time forward drives the Map: files flash on change with a brief highlight
ring, deleted files fade, and a subtle ripple propagates through co-changed
neighbours. This is the feature most likely to become the shared GIF, and it is
essentially free once Persistent Layout and the bucket rollups exist.

Rate limiting: playback advances by bucket, not by commit, so a 100k-commit repo
plays in 30 seconds rather than 30 minutes.

---

## 11.5 Graph views

### 11.5.1 The anti-hairball protocol

Mandatory for every graph view in the product:

1. **Start from a focus node.** Never from "the whole graph."
2. **Expand at most 2 hops** by default; further expansion is explicit.
3. **Hard budget: 300 visible nodes.** Beyond it, nodes collapse into cluster nodes
   labelled with their member count, expandable on click.
4. **Edge bundling** for edges sharing endpoints regions.
5. **Every edge explains itself on hover** — "these files changed together in 47 of
   58 commits" with a link to the evidence.
6. **Deterministic seeding.** Force layouts are seeded from a hash of the node set,
   so the same query produces the same picture every time. Non-deterministic layouts
   destroy the ability to say "look at the thing on the left."

### 11.5.2 Dependency graph (v0.3)

Sugiyama layered DAG: layer assignment by longest path, crossing reduction by
median heuristic, coordinate assignment by Brandes-Köpf. Cycles are detected via
Tarjan SCC, drawn in a warning color, and listed separately — cycle detection is
often the most immediately actionable output of the whole view.

Rendered in Canvas2D (typically < 2,000 nodes after clustering to module level).

### 11.5.3 Knowledge Graph (v1.0)

The most hairball-prone view in the product and therefore the last to ship.

Heterogeneous nodes (file, symbol, person, commit, PR, decision) with typed edges.
Radial focus+context layout: focus at center, hop-1 in a ring, hop-2 in an outer ring,
with the anti-hairball protocol applied strictly. Node type is encoded by shape;
color remains reserved for the lens.

Its real justification is as an **exploration surface for the evidence graph** —
"show me everything connected to this decision" — rather than as a picture of the
codebase.

### 11.5.4 Architecture Evolution — the alluvial (v1.0)

The highest-ceiling visualization in the product.

```
   Era 1        Era 2           Era 3            Era 4
  ┌──────┐    ┌──────┐        ┌──────┐         ┌──────┐
  │ core │════│ core │════╦═══│ core │═════════│ core │
  └──────┘    └──────┘    ║   └──────┘         └──────┘
  ┌──────┐    ┌──────┐    ║   ┌──────┐    ╔════┌──────┐
  │ web  │════│ web  │════╬═══│ web  │════╝    │ web  │
  └──────┘    └──────┘    ║   └──────┘    ╔════└──────┘
              ┌──────┐    ╚═══┌──────┐    ║
              │ api  │════════│ api  │════╝
              └──────┘        └──────┘
                              ┌──────┐         ┌──────┐
                              │ jobs │═════════│ jobs │
                              └──────┘         └──────┘
```

Nodes are architectural clusters per era (from P4, Part 10 §10.4.4). Ribbon width is
code mass; ribbons show mass flowing between clusters as code is moved, split, or
merged. Clusters that appear, dissolve, split, or merge are the visual events.

The underlying data — cluster membership per era, plus file identity across renames —
already exists. The work is the ribbon geometry and the interaction (hover a ribbon →
"1,240 lines moved from `web/` to `api/` across 38 commits, mostly in the service
extraction [see commits]").

Genuinely novel, and worth being patient for.

---

## 11.6 File Evolution view

Composite, mostly SVG (small element counts, needs text and accessibility):

```
┌──────────────────────────────────────────────────────────────────────┐
│ src/webhook/sender.ts                          created 2019-08 · 412 loc│
├──────────────────────────────────────────────────────────────────────┤
│ LIFE   ●───────────▶◆──────▶✖✖──────▶●─────────────────────────────  │
│        born      renamed   reverted×2  rewritten                now   │
│              (was: src/hooks.ts)                                      │
├──────────────────────────────────────────────────────────────────────┤
│ CHURN  ▁▂▅█▇▅▃▂▁▁▃▅▆█▇▅▃▂▄▆███▇▅▃▁▂▄▅▆▅▄▃▂▁▂▃▄▃▂▁▂▃▄▅▄▃            │
│        │v1.0    │v2.0        │v2.5      │v3.0        │v4.0           │
├──────────────────────────────────────────────────────────────────────┤
│ OWNERS ████████░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░████████████████             │
│        Dana        Priya      Sam       Dana                          │
├──────────────────────────────────────────────────────────────────────┤
│ COUPLED WITH   test/webhook/sender.test.ts (0.81)                     │
│                src/queue/dispatcher.ts (0.64)                         │
│                docs/reliability.md (0.31)                             │
├──────────────────────────────────────────────────────────────────────┤
│ COMMITS THAT MATTERED                                                 │
│   a1b2c3d  2021-08-14  fix: add jitter to webhook retry (#412)   ★★★  │
│   4c5d6e7  2021-08-16  reland: retry with jitter                 ★★★  │
│   …                                                                   │
├──────────────────────────────────────────────────────────────────────┤
│ CODE  (line-age heatmap; `?` on any line)                             │
└──────────────────────────────────────────────────────────────────────┘
```

The **line-age heatmap** in the code view uses a left gutter strip colored by the age
of each line's introducing commit — cheap to compute from cached blame, and
immediately legible: fresh code is bright, ancient code is dark, and a lone bright
line in a dark region is a story.

Code rendering uses **CodeMirror 6** (Part 13 §13.4.4) with a custom gutter extension
and a line-decoration layer for the heatmap and the `?` affordance.

---

## 11.7 The Story view

Not a "visualization" in the chart sense, but the most designed surface in the app.

```
┌────────────────────────────┬────────────────────────────────────────┐
│  ═══ ERA 3 ═══             │                                        │
│  The TypeScript Migration  │        ┌────────┐   ┌────────┐         │
│  2021 Q2 — 2022 Q1         │        │  core  │───│  web   │         │
│                            │        └───┬────┘   └────────┘         │
│  Over ten months the team  │            │                           │
│  converted 340 JavaScript  │        ┌───▼────┐                      │
│  modules to TypeScript,    │        │  api   │  ◀── appears here    │
│  starting with the API     │        └────────┘                      │
│  layer. [E1][E4]           │                                        │
│                            │      (architecture at this era,        │
│  The migration stalled     │       morphs as you scroll)            │
│  twice… [E7]               │                                        │
│                            │                                        │
│  ── COMMITS THAT MATTERED  │                                        │
│  ── WHAT BROKE (2 reverts) │                                        │
│  ── WHO DROVE IT           │                                        │
│  ── DECISIONS (3)          │                                        │
└────────────────────────────┴────────────────────────────────────────┘
```

**Scroll-linked architecture sidecar.** As an era scrolls into view, the diagram
morphs to that era's architecture snapshot: nodes appear, merge, split, and dissolve
with matched-element transitions. Implemented with an IntersectionObserver driving a
spring-interpolated SVG scene — this is the "magic" moment in the demo and deserves
its polish budget.

Typography carries most of the weight here. Generous measure (~68ch), real vertical
rhythm, evidence markers as subtle superscript links rather than intrusive brackets.
This screen should feel like reading a well-set essay, not like using a dashboard.

---

## 11.8 Animation system

### 11.8.1 Timing

| Class | Duration | Curve | Examples |
|---|---|---|---|
| Micro | 100–140ms | ease-out | Hover, focus ring, tooltip |
| Standard | 180–220ms | ease-out | Panel open, lens cross-fade |
| Deliberate | 260–320ms | spring(0.8, 22) | View transitions, era morph |
| Direct manipulation | 0ms | none | Dragging the time cursor, panning |

**Direct manipulation is never eased.** The cursor is where the pointer is. Adding
easing to a drag is the single most common way to make an app feel laggy while
technically being fast.

### 11.8.2 Shared-element transitions

When the same entity appears in two views, it animates between them:

- Map cell → File Evolution header (the rectangle expands into the page header).
- Timeline commit tick → commit detail panel.
- Search result → the entity's view.

Implemented with FLIP for DOM and matched instance IDs for canvas. This is what makes
the app feel like one continuous space rather than a set of screens, and it is
directly load-bearing for spatial memory (V1).

### 11.8.3 Reduced motion

`prefers-reduced-motion: reduce` maps every transition to an instant state change
plus a 400ms highlight on the changed element. Playback becomes stepped rather than
continuous. The reduced path is designed, not degraded — it is tested as a
first-class mode, because a broken reduced-motion path is worse than no animation at
all.

---

## 11.9 Performance engineering

### 11.9.1 Budgets

| View | Scale | Budget |
|---|---|---|
| Map initial render | 50k cells | < 400ms |
| Map pan/zoom | 50k cells | 60fps sustained |
| Lens switch | 50k cells | < 100ms |
| Timeline scrub | 6 rows × 300 buckets | 60fps |
| Time-lapse playback | 50k cells | 30fps minimum |
| Graph layout (interactive) | 300 nodes | 60fps during drag |
| Story scroll + morph | — | 60fps |
| Code view w/ heatmap | 5k lines | < 200ms |

### 11.9.2 Techniques

- **Typed arrays end to end.** Layout positions arrive from the daemon as binary
  (Part 7 §7.4.1) and are uploaded to the GPU without an intermediate object graph.
  A 50k-cell layout as JSON objects is ~40MB of garbage and a visible stall; as
  `Float32Array` it is 800KB and a memcpy.
- **Never re-upload unchanged buffers.** Geometry uploads once; lens switches update
  only the color buffer.
- **Frustum culling** by camera bounds via the R-tree.
- **Offscreen layout.** All layout runs in a Web Worker (WASM); the main thread only
  renders.
- **Debounced camera-derived work** — labels, tooltips, and URL updates on a 60ms
  trailing edge, never per frame.
- **`ResizeObserver`, not window resize**, with a single rAF-batched relayout.
- **Backpressure on streamed events.** WebSocket messages are coalesced per frame;
  a fast indexer must not be able to starve the renderer.

### 11.9.3 Visual regression testing

Deterministic seeds → headless render → PNG → perceptual diff, in CI, per view per
theme. Catches the class of bug that unit tests structurally cannot: "the treemap is
correct but everything is 3px to the left."

---

## 11.10 Rejected visualizations

Recorded with reasons so they are not re-proposed.

| Rejected | Reason |
|---|---|
| 3D code city | Occlusion, navigation cost, and no information gain over a 2D treemap. The canonical code-viz gimmick. |
| Force-directed "whole repo" graph | Guaranteed hairball; violates V2. |
| Voronoi treemap | Unstable across inputs; breaks Persistent Layout. |
| Gource-style particle history | Beautiful, non-interactive, non-navigable. Time-lapse over the Map gets 80% of the delight and is actually useful. |
| Sunburst / radial hierarchy | Poor label legibility, poor area comparison, poor deep hierarchies. |
| Commit DAG as a railway diagram | Every implementation becomes unreadable past ~50 commits. |
| Word clouds of commit messages | No. |
| Punch-card (commit hour × weekday) | Interesting, does not aid understanding (Part 2, P1), and drifts toward surveillance. |

---

*Next: [Part 12 — UI/UX Design System](12-design-system.md)*
