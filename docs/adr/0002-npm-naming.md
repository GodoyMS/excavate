# ADR-0002: Publish under the `@wise-excavate` scope, and drop `npx excavate`

Status: accepted
Date: 2026-08-11
Deciders: solo maintainer

## Context

[LEAN-V1 §2.1](../spec/LEAN-V1.md) makes npm distribution a load-bearing part of the
product's shape, not an implementation detail:

> **Decision: Node 22+ / TypeScript for the core.** … Distributed via npm (`npx excavate`),
> which also deletes code signing, notarization, and installers from the project.

And §2.2 leans on the same idea again — the whole argument for having no desktop shell is
that `npx` makes one unnecessary. The literal string `npx excavate` appears in LEAN-V1 as
the thing the user types.

Both names turn out to be unavailable:

| Name                          | State                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `excavate` (unscoped package) | **Taken** — v1.1.2, [sonic-sabers/excavate](https://github.com/sonic-sabers/excavate), _"Dig up what is buried in your codebase."_ |
| `@excavate` (npm org/scope)   | **Taken**                                                                                                                          |
| `@wise-excavate` (org)        | Created and owned by the maintainer                                                                                                |
| `wise-excavate` (unscoped)    | Available                                                                                                                          |

The collision is not a coincidence of naming — the squatting package is a codebase-analysis
tool in the same problem space. "Excavate" is an obvious name for this category, which is
weak evidence that the product name itself is generic.

## Decision

1. **Internal packages are `@wise-excavate/*`** — all nine, plus the fixture library, which
   is the only one published at M0.
2. **The CLI's npm package is `wise-excavate`; its binary stays `excavate`.** These are
   independent: `bin: { "excavate": "./dist/bin.js" }` means an installed copy is still
   invoked as `excavate`, which is what appears in every doc, screenshot, and terminal
   session.
3. **`npx excavate` is replaced by `npx wise-excavate`** for the zero-install path. The
   docs say so; nothing pretends otherwise.
4. **The product is still called Excavate.** The npm name is a registry constraint, not a
   rename. The cache directory stays `excavate/`, the daemon, the docs, and the CLI verb
   are unchanged.

The whole scope was renamed at once, four commits into the project, rather than publishing
the fixture library under one scope and leaving the other nine under another. A split
between the name in an import and the name on the registry is the kind of inconsistency
that is free to fix now and permanent later.

## Options considered

### Option A — `@wise-excavate/*` scope, CLI as `wise-excavate` (chosen)

- **Pros.** One scope for everything, owned outright. `npx wise-excavate` works with no
  further registry negotiation. The invoked command is still `excavate`, so the product's
  actual surface is unchanged. Reversible: if `excavate` is ever released, add it as an
  alias and deprecate.
- **Cons.** `npx wise-excavate` is worse than `npx excavate` — longer, and "wise" means
  nothing to a reader. The org name will read as arbitrary to anyone who did not watch this
  decision get made, which is why it is written down here.
- **Cost to reverse.** One rename commit plus a deprecation notice.

### Option B — rename the product

- **Pros.** A distinctive name would be available unscoped, and would remove the collision
  with a tool in the same category — which is a real long-term risk for search and word of
  mouth.
- **Cons.** SPEC.md, LEAN-V1, the ROADMAP, and every doc page use "Excavate" throughout, and
  the working name has been settled since Draft 1.0.
- **Why rejected — for now.** This is a product decision, not a packaging one, and M0 is the
  wrong moment: nothing is public, so there is no cost to deferring it and no benefit to
  rushing it. **Revisit before the M6 Show HN**, which is when the name starts accumulating
  value and the collision starts costing something. If it changes then, only the npm scope
  and the docs move — no code does.

### Option C — contact the `excavate` owner, or wait for it to lapse

- **Why rejected.** Unbounded, and it blocks M0's public artifact on someone else's reply.
  npm's dispute policy does not favour a project with no users over a published package.

### Option D — publish nothing, use git dependencies

- **Why rejected.** DoD item 6 requires an npm release each milestone, and ROADMAP §5 rule 4
  ("ship to npm every milestone from M1") is one of the six momentum rules. A private branch
  is where momentum goes to die.

## Consequences

**Positive.** Everything is under one owned scope with no further registry blockers. The
command users type — `excavate` — is unaffected. The M1 CLI release has a name ready.

**Negative.** `npx wise-excavate` is a worse first impression than `npx excavate`, and
LEAN-V1 §2.1 and §2.2 now contain a string the project does not honour. Those pages are the
authored specification and are deliberately **not** edited; this ADR is the reconciliation,
per the precedent set in ADR-0001. There is also a same-category name collision on npm that
will cost search visibility, and this ADR does not solve that — it defers it.

**Neutral / follow-on.** The `@excavate/*` → `@wise-excavate/*` rename touched 69 files and
no logic. Whether to rename the product is an open question with a scheduled decision point
(M6).

## Enforcement

- `pnpm check:deps` keys its architecture table on exact package names, so a half-finished
  rename fails the build rather than leaving a mixed graph.
- `pnpm typecheck` fails on any unrenamed import.
- The published surface is checked by `npm pack --dry-run` before each publish, which is
  also what caught the missing `LICENSE` in the first `git-fixtures` tarball.
