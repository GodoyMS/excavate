# ADR-0002: Publish under the `@wise-excavate` scope, and drop `npx excavate`

Status: accepted
Date: 2026-08-11
Deciders: solo maintainer

## Context

[LEAN-V1 §2.1](../spec/LEAN-V1.md) makes npm distribution a load-bearing part of the
product's shape, not an implementation detail:

> **Decision: Node 22+ / TypeScript for the core.** … Distributed via npm (`npx excavate`),
> which also deletes code signing, notarization, and installers from the project.

§2.2 leans on the same idea again — the entire argument for shipping no desktop shell is
that `npx` makes one unnecessary. The literal string `npx excavate` appears in LEAN-V1 as
the thing a user types.

Neither name is available:

| Name                   | State                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `excavate` (unscoped)  | **Taken** — v1.1.2, [sonic-sabers/excavate](https://github.com/sonic-sabers/excavate), _"Dig up what is buried in your codebase."_ |
| `@excavate` (scope)    | **Taken**                                                                                                                          |
| `@wise-excavate` (org) | Created and owned by the maintainer                                                                                                |

The collision is not an accident of vocabulary: the occupying package is a
codebase-analysis tool in the same problem space. "Excavate" is an obvious name for this
category, which is weak evidence that the product name is generic.

## Decision

1. **Every workspace package is `@wise-excavate/*`** — the nine internal packages, the fixture
   library, and the CLI. One scope, owned outright, with no further registry negotiation for
   any package the project will ever publish.
2. **The CLI is published unscoped as `wise-excavate`, and its binary stays `excavate`.**
   Libraries are scoped, the command-line entry point is not — the split `vite` + `@vitejs/*`,
   `next` + `@next/*`, and `turbo` + `@turbo/*` all use. It exists precisely so the
   zero-install path stays short, and it avoids `npx @wise-excavate/excavate` saying the same
   word twice. `bin: { "excavate": "./dist/bin.js" }` means an installed copy is still invoked
   as `excavate`, which is what appears in every doc, screenshot, and terminal session.
3. **`npx excavate` becomes `npx wise-excavate`.** Longer by five characters; the docs say so
   rather than pretending otherwise.
4. **The product is still called Excavate.** A registry constraint is not a rename. The
   cache directory stays `excavate/`, and so do the daemon, the docs, and the CLI verb.

## Options considered

### Option A — a project-named org, `@wise-excavate/*`, for everything (chosen)

- **Pros.** Reads as a project rather than a person, which is what an Apache-2.0 tool
  intended to attract contributors needs — SPEC.md's governance section is explicit that
  language packs are the contribution path being optimised for, and a scope named after an
  individual is a poor host for that. An org can also add maintainers without transferring
  anything. One scope covers every package the project will ever publish.
- **Cons.** "wise" carries no independent meaning; it is a workaround for a taken name, and a
  reader will wonder what it refers to. That is the honest cost of the collision, and no
  arrangement of scopes removes it.
- **Cost to reverse.** One rename commit plus a deprecation notice on the old names.

### Option B — the maintainer's personal scope (`@godoyms/*`)

Briefly adopted and then reversed before anything was published, which is the only reason it
is recorded here rather than in an ADR of its own.

- **Pros.** Cannot be taken from under the project, needs no org administration, and is
  honest about what it is rather than dressing a workaround as a brand.
- **Cons.** Ties a project that wants contributors to one person's namespace. If maintainers
  are ever added, this is among the first things they would want changed, and changing it
  later means deprecating published versions rather than editing a manifest.
- **Why rejected.** The org already exists, and the cost of using it is a name that reads
  oddly — against the cost of a personal namespace, which reads _fine_ now and becomes wrong
  precisely if the project succeeds.

### Option C — rename the product

- **Pros.** A distinctive name would be available unscoped, giving back `npx <name>`, and
  would remove a same-category collision that will cost search visibility and word of mouth.
- **Cons.** SPEC.md, LEAN-V1, the ROADMAP, and every doc page say "Excavate", and the working
  name has been settled since Draft 1.0.
- **Why rejected — for now.** This is a product decision, not a packaging one, and M0 is the
  wrong moment to take it: nothing is public, so deferring costs nothing and rushing gains
  nothing. **Revisit before the M6 Show HN**, when the name begins accumulating value and the
  collision begins costing something. If it changes then, the scope and the docs move; no
  code does.

### Option D — contact the `excavate` owner, or wait for the name to lapse

- **Why rejected.** Unbounded, and it blocks M0's public artifact on a stranger's reply.
  npm's dispute policy does not favour a project with no users over a published package.

## Consequences

**Positive.** One owned scope with no remaining registry blockers, for every package the
project will ever publish. The command users type is unaffected.

**Negative.** `npx wise-excavate` is worse than `npx excavate`. LEAN-V1 §2.1 and §2.2 now contain a string the project does
not honour; those pages are the authored specification and are deliberately **not** edited,
so this ADR is the reconciliation, per the precedent in ADR-0001. "wise" is also unexplained
to anyone who did not watch this decision get taken, which is the main reason this file
exists. And the same-category npm collision remains: this ADR defers that question rather
than answering it.

**Neutral / follow-on.** The rename touched every package manifest and import and no logic.
Whether to rename the product is open, with a scheduled decision point (M6) — and because the
CLI's package name and its binary are already decoupled, a future rename changes what users
`npx` without changing what they type afterwards.

## Enforcement

- `pnpm check:deps` keys its architecture table on exact package names, so a half-finished
  rename fails the build rather than leaving a mixed graph.
- `pnpm typecheck` fails on any unrenamed import.
- `npm pack --dry-run` reviews the published surface before every publish. It has already
  caught two real defects this milestone: a missing `LICENSE` in the tarball, and a
  `repository.url` pointing at a placeholder slug that never existed.
