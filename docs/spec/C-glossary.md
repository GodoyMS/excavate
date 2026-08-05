# Appendix C — Glossary

Normative vocabulary. These terms are used consistently in code, UI, CLI output, and
documentation. The "not called" column is as binding as the definition — vocabulary
drift between surfaces is how a product starts feeling incoherent.

---

## C.1 Core domain

**Alias** — One `(path, from_commit, to_commit)` segment in a file's identity chain.
Aliases of a file never overlap in time. *Not called: rename record, path history.*

**Bus factor** — The minimum number of people whose combined knowledge of a file
exceeds 50%. A bus factor of 1 means one person understands it. *Framed as a property
of the code, never of the person.*

**Bundle** (Evidence Bundle) — A ranked, budget-fitted collection of evidence
assembled for a single target, with stable IDs `E1..En`, a confidence rating, a gap
list, and a hash. The unit of input to every generation pipeline and the unit of
caching. *Not called: context, payload, retrieval set.*

**Certainty** — The epistemic status of a single piece of evidence: `Observed`
(directly in Git), `Inferred` (derived by an algorithm), or `Reported` (asserted by a
human). Distinct from **Confidence**, which is about an answer.

**Confidence** — `HIGH` / `MEDIUM` / `LOW` for an answer, computed deterministically
from the bundle *before* generation, with enumerated reasons. Cannot be inflated by
fluent prose.

**Coupling** (change coupling) — The tendency of two files to change in the same
commit, measured over a decayed window with a support threshold.
*Not called: dependency (that word is reserved for import edges).*

**Decision** — A mined architectural decision: a technology adoption, removal,
architectural change, convention change, reversal, or an actual ADR file. Has a
status (`Active`, `Superseded`, `Reverted`, `Partial`). Collectively, the ADR log the
project never wrote.

**Era** — A detected period of repository history, produced by change-point detection
over a multivariate activity series and snapped to a salient event. Every era carries
a `boundary_reason` explaining why it starts where it does. *Not called: phase,
chapter, period.*

**Evidence** — A single citable fact with a machine-resolvable locator, a
human-readable excerpt, a kind, and a certainty. The atomic unit of the citation
contract. *Not called: source, reference, citation.*

**File** — A resolved identity that survives renames, moves, and resurrection —
**not** a path. `FileId` is the join key everywhere; paths are display and lookup
only.

**Hotspot** — A file scoring high on churn × complexity × recency × fix density.
Always displayed with its factor breakdown and links to the underlying commits, never
as a bare number.

**Hunk** — A contiguous changed line range within one file in one commit. Stored, not
recomputed, because it is what makes symbol attribution cheap.

**Knowledge** — A person's recency-decayed, dilution-adjusted familiarity with a
file. *Not called: expertise score, ownership points, contribution weight.*

**Knowledge island** — A file with bus factor 1 whose sole knowledge holder has been
inactive for more than six months. The highest-signal risk indicator in the product.
*Not called: orphaned code, abandoned file.*

**Lens** — A pure function from `(file, time window)` to a value, plus a color scale
and a legend. Switching a lens re-colors the Map without relayout. *Not called: view
mode, filter, overlay.*

**Link** — A typed, confidence-weighted edge in the evidence graph, carrying its
supporting evidence and its source (`Explicit`, `Pattern`, `Statistical`, `Model`).

**Ownership** — The normalized distribution of knowledge over people for a file.
Used for routing ("who should I ask"), never for ranking.

**Pack** (`.excavate-pack`) — A portable, self-contained exported index. What a
maintainer publishes so contributors get instant understanding with no indexing and
no API key. *Not called: bundle (that's evidence), archive, snapshot.*

**Persistent Layout** — The guarantee that spatial positions in the Map are computed
once at a reference revision and held fixed while time is scrubbed. Files change
opacity and color, never position. The single decision that makes time-travel
legible.

**Projection** (history projection) — The chosen linearization of the commit DAG:
`FirstParent`, `Topological`, or `AuthorDate`. Global, user-visible, part of URL
state, respected by every time-based query. *Not called: view, mode.*

**Significance** — The deterministic commit importance score, with penalties for
format-only, generated, vendored, lockfile-only, and bulk mechanical changes. Used
everywhere the product must choose which commits matter. *Not called: weight, rank,
priority.*

**Symbol** — A named code entity (function, method, class, struct, trait, constant)
with identity tracked across revisions and, where detectable, across files.

**Target** — The thing a Why question is about: a line range, a file, a symbol, a
directory, a dependency, or a decision. *Not called: subject, entity, focus.*

---

## C.2 Analysis terms

**Change point** — A statistically detected shift in the multivariate activity
series; the raw output of PELT before snapping and merging into eras.

**Dilution** — The extra decay applied to person A's knowledge of a file when person
B rewrites lines A authored. You do not still understand code someone else replaced.

**Fix density** — The fraction of a file's commits classified as fixes. An input to
the hotspot score and a strong standalone risk signal.

**Generation number** — A commit's depth in the DAG, enabling near-constant-time
ancestry queries. Reused from Git's `commit-graph` where available.

**Noise classification** — Marking commits and files as generated, vendored,
format-only, lockfile-only, or bulk mechanical, so they can be excluded from
significance and metrics. Without it, "the most important commits" is the Prettier
migration.

**PELT** — Pruned Exact Linear Time. The change-point detection algorithm used for
era segmentation.

**Re-land** — A commit that reintroduces previously reverted content, usually with a
fix. A revert/re-land pair is the highest-value evidence type in the product.

**Resurrection** — A file deleted and later recreated at the same path. Treated as
the same `FileId` with a gap, because that is how humans think about it.

**SZZ** — The family of algorithms for identifying bug-introducing changes by blaming
the lines a fix commit modifies. Excavate implements a conservative variant
("SZZ-lite") and always labels its output `Inferred`.

**Tier** (T0–T3) — Indexing stages: metadata, structure, semantic, interpretive. The
UI unlocks capability progressively as tiers complete.

---

## C.3 AI terms

**Citation contract** — The rule that every generated sentence carries a resolvable
evidence marker, enforced by a post-generation validator rather than by prompt
instruction alone.

**Deterministic provider** — The no-model implementation of every pipeline, rendering
templates from the evidence bundle. What makes the tool fully useful with no API key.

**Effort** — The provider-level dial controlling reasoning depth and token spend
(`low` … `max`). Set per pipeline, not globally.

**Gap** — A named piece of missing evidence surfaced to the user ("no PR body cached
for #412"). Both honest and a natural upsell to the forge connector.

**Investigation** — The bounded, opt-in, priced agentic loop over the typed query
toolset. The only place the model chooses what to look at.

**Pipeline** — One of the seven named generation flows (P1–P7), each specified as
input → deterministic preparation → model call → validation → output.

**Run manifest** — The record stored with every generated artifact: model, prompt
template version, effort, and evidence bundle hash. Makes narratives auditable,
reproducible, and correctly cacheable.

**Verdict** — The validator's output for a generation: `Accept`, `Downgrade`, or
`Reject`. Rejected generations fall back to deterministic rendering.

---

## C.4 Interface terms

**Accessible twin** — The semantically equivalent table view that every canvas
visualization provides via `T`. An accessibility requirement that also delivers
copy-paste and CLI parity.

**Command bar** — The ⌘K interface. Commands, entities, content, and temporal
expressions in one input.

**Inspector** — The right panel. Always shows the current global selection.

**Peek** — Holding a key to temporarily show alternative state (most importantly, the
previous lens), reverting on release.

**Strata ribbon** — The Timeline's subsystem activity bands. Era boundaries render as
geological strata lines.

**Time cursor** — The single global "now" for the entire application, owned by URL
state and driven by the Timeline.

**Why panel** — The panel opened by `?`. The signature interaction.

---

## C.5 Terms we deliberately avoid

| Avoided | Why | Use instead |
|---|---|---|
| "Technical debt" | Unmeasurable, contested, invites arguing about the metaphor | Hotspot, fix density, knowledge risk |
| "Code health score" | A number with no evidence behind it | The specific evidence-linked signals |
| "Productivity" | Not something Excavate measures, by design | — (nothing) |
| "Top contributor" | Implies ranking people | "Top knowledge holder for this file" |
| "AI-powered" | Says nothing and invites the wrong comparison | Name the specific capability |
| "Insights" | Marketing filler | The specific finding |
| "Smart" / "intelligent" | Says nothing | Describe the behaviour |
| "Simply" / "just" | Condescending in documentation | Delete the word |
| "Blame" (in UI copy) | Git's term, but the connotation is wrong for a tool about understanding | "Attribution", "who wrote this" |

The last one is a small thing that matters: Excavate's whole posture is
*understanding, not accountability*, and "blame" is the wrong word for that even
though it is the Git command.
