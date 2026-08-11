# ADR-0001: Enforce the package graph with project references and a dependency lint

Status: accepted
Date: 2026-08-04
Deciders: solo maintainer

## Context

[LEAN-V1 §5](../spec/LEAN-V1.md) collapses 17 Rust crates and 5 npm packages into 9
TypeScript packages plus a CLI and a fixture library. [Part 7 §7.3](../spec/07-product-architecture.md)
defines five boundary rules that protect those packages from each other:

| #   | Rule                                                               | Prevents                                       |
| --- | ------------------------------------------------------------------ | ---------------------------------------------- |
| B1  | Only `@wise-excavate/git` touches the repository                   | Scattered, unbounded Git I/O; untestable code  |
| B2  | Only `@wise-excavate/store` writes SQL                             | Schema knowledge leaking into every package    |
| B3  | AI never retrieves; all model input comes from an `EvidenceBundle` | Hallucinated grounding; unreproducible answers |
| B4  | The UI computes nothing analytical                                 | Divergence between CLI, MCP, and GUI answers   |
| B5  | Every feature has a no-AI path                                     | Silent dependence on a paid provider           |

Part 7 is explicit that **B3 and B5 are the two that make Excavate what it is. If
either erodes, the product becomes a repo-chat tool with extra steps.**

Constraints: one engineer, ~18 weeks, no reviewer to catch drift, and a `Cargo`
workspace's compile-time crate boundaries no longer available to do the enforcing.
Rules B1–B5 were previously protected by "enforced in review and (where possible) by a
dependency lint" — with a team of 3–4 in mind. A solo project has no review step.

## Decision

We enforce the package graph three ways, and we treat any rule that _can_ be made
structural as a rule that _must_ be:

1. **TypeScript project references.** Every package is `composite`, so `tsc -b` builds
   in dependency order and rejects a cycle at compile time.
2. **`scripts/check-deps.mjs`.** A table of permitted edges that is the single source
   of truth for the graph, checked against every `package.json` and `tsconfig.json`.
   Adding an edge means editing that table.
3. **Removing edges the graph does not need**, so a boundary rule becomes impossible
   to violate rather than merely forbidden.

Two edges from Part 14 §14.2 are deliberately dropped under point 3:

- **`ai` no longer depends on `evidence` or `store`.** It depends on `@wise-excavate/core`
  alone. B3 stops being a rule a reviewer enforces and becomes a fact about the
  dependency graph: the package has no store handle, no repository access, and no
  collector to call, so it _cannot_ retrieve. Response caching, the one capability
  those edges bought, becomes a `GenerationCache` port that the composition root fills
  in.
- **`evidence` no longer depends on `analysis`.** Every analysis output it needs —
  revert pairs, coupling, ownership — comes from the store's rollup tables, which is
  exactly what B2 buys. Analyzers and collectors become independently testable, and
  composition order stays the sole responsibility of `@wise-excavate/server`.

The resulting graph, with depth as the longest path to `core`:

```
depth 0  @wise-excavate/core            ← (nothing)
depth 0  @wise-excavate/git-fixtures    ← (nothing)
depth 1  @wise-excavate/git             ← core
depth 1  @wise-excavate/store           ← core
depth 1  @wise-excavate/ai              ← core
depth 1  @wise-excavate/ui              ← core
depth 2  @wise-excavate/index           ← core, git, store
depth 2  @wise-excavate/analysis        ← core, store
depth 2  @wise-excavate/evidence        ← core, git, store
depth 3  @wise-excavate/server          ← everything above except ui
depth 4  excavate                  ← core, server, ui
```

`server` is the composition root for the _engine_ and the only package that knows about
all of those. It does **not** depend on `ui`: no browser code enters the daemon's type
graph, so the daemon takes the document it serves as a string
(`ServerOptions.indexHtml`).

**`excavate` → `ui` is the consequence of that, and is deliberate.** Something has to
choose which front end the daemon serves, and forbidding `server → ui` means it cannot be
the daemon. The CLI is the right owner: Part 7 §7.1 describes four presentation surfaces —
the Tauri shell, `excavate serve`, the CLI, and `excavate mcp` — sitting _above_ one
presentation-agnostic daemon, all speaking the same typed API. The process that launches
the daemon picking its front end is that shape, not a workaround for it.

At M0 the CLI passes `skeletonPage()`. From M3, `@wise-excavate/ui` becomes a real Vite bundle
and this becomes a static directory to serve rather than a string to pass; the daemon's side
of the seam does not change, which is the property that made the seam worth having.

## Options considered

### Option A — project references + a dependency-table lint (chosen)

- **Pros.** Cycles fail at compile time. Illegal edges fail in CI with a message that
  explains the rule. The permitted-edge table doubles as living documentation, and
  drift between `package.json`, `tsconfig.json`, and the intended graph is impossible
  to sustain. About 200 lines, written once.
- **Cons.** One more file to update when the graph legitimately changes — which is the
  intended friction, not an accident. The lint's import scan is regex-based, so a
  computed import specifier would slip past it.
- **Cost to reverse.** Delete one script.

### Option B — one package, enforced by directory convention

- **Pros.** Simplest possible build. No `workspace:*`, no project references, no
  cross-package version story.
- **Cons.** Nothing prevents `ui` from importing `better-sqlite3` or the AI layer from
  reaching into a collector. B1–B3 degrade to naming conventions. It also forecloses
  publishing `@wise-excavate/git-fixtures` on its own, which is M0's public artifact and
  the project's first credibility-building release.
- **Why rejected.** The boundary rules are the product's differentiator, not
  housekeeping. A structure that cannot express them is the wrong structure.

### Option C — ESLint `no-restricted-imports` per package

- **Pros.** No new script; uses tooling already present.
- **Cons.** Expresses "package X may not import Y" but not the _graph_ — no
  acyclicity check, no depth, no cross-validation against `package.json` or
  `tsconfig.json` references. Rules end up duplicated per package and drift silently.
- **Why rejected.** Enforces the symptom, not the invariant.

### Option D — do nothing; rely on review

- **Why it loses.** There is no reviewer. Part 7's own phrasing ("enforced in review")
  assumed a team of 3–4, and LEAN-V1 exists precisely because that team does not
  exist.

## Consequences

**Positive.** B1, B2, and B3 are now mechanical. A phantom dependency (importing a
package without declaring it) fails CI. `tsconfig` references cannot drift from
`package.json` dependencies. `ai` is a pure function from bundle to validated prose,
which makes it testable without a store, a repository, or a network.

**Negative.** The `GenerationCache` port is indirection that a direct `store`
dependency would not need — a real cost paid for a real guarantee. Eleven packages
mean eleven `package.json` and `tsconfig.json` files to keep consistent, which is only
tolerable _because_ the lint checks them. The regex import scan is a heuristic and
would miss a dynamically constructed specifier. The graph is flatter than Part 14's,
so anyone reading Part 14 first will find the depths do not match; this ADR is the
reconciliation.

**Neutral / follow-on.** B4 (the UI computes nothing analytical) and B5 (every feature
has a no-AI path) cannot be reduced to an import rule and remain review gates. B5 gets
a partial structural defence in M7: `deterministic` is modelled as a `LanguageModel`
provider rather than an `if (hasApiKey)` branch, so every pipeline has exactly one code
path and the offline path cannot rot untested. B4's real defence is the offline E2E
suite plus the M6 requirement that CLI, UI, and MCP agree.

## Enforcement

- `pnpm check:deps` — permitted edges, `workspace:*` protocol, phantom-dependency
  scan, B1/B2 import rules, `ui` browser purity, `tsconfig`-reference sync, and
  acyclicity with computed depths.
- `pnpm typecheck` — `tsc -b` across the solution; a cycle is a compile error.
- Both run in `pnpm verify`, which is what CI runs (M0.5).
