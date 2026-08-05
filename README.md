# Excavate

> **Git tells you what changed. Excavate tells you why.**

Excavate turns any Git repository into a story you can read, a map you can explore, and
a question you can ask — with receipts on every claim.

> **Status: pre-alpha (M0 — foundations & walking skeleton).** Nothing is released yet.
>
> What works today: `excavate index` and `excavate open` on any repository, a real SQLite
> index (schema v1), a localhost daemon with a token-authenticated API, a plain HTML commit
> list, and the [`repo()` fixture DSL](fixtures) with a 24-case matrix. Deliberately _not_
> here: rename tracking, identity merging, significance, hotspots, ownership, eras, and
> every analysis feature — those are M1+, and each stub throws `NotImplementedError` naming
> the milestone that fills it in.
>
> So `excavate open` currently shows you a commit list, not insight. The first genuinely
> useful release is `excavate stats` at **M1 (v0.1)**.
>
> Plan: [ROADMAP.md](docs/spec/ROADMAP.md) · Scope: [LEAN-V1.md](docs/spec/LEAN-V1.md) ·
> Reference: [SPEC.md](SPEC.md)

## The contract

> Every claim Excavate makes is traceable to a commit SHA, a line range, a PR number,
> or an issue. **Uncited assertions are a bug, not a style preference.**

That, plus working completely with no API key and no account, is the whole
differentiator versus "AI chat over a repo."

## Getting started

Requires **Node 22+**, **pnpm 10+**, and **git 2.30+**.

```sh
pnpm install
pnpm verify          # check:deps → typecheck → lint → test
pnpm dev             # index this repository and serve it on 127.0.0.1
```

`pnpm dev` prints a URL carrying a session token. Open it and you get the commit list.

| Command           | Does                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `pnpm dev`        | Build, index this repository, and serve it — the whole loop in one command                    |
| `pnpm build`      | `tsc -b` across the solution, in dependency order                                             |
| `pnpm gen:schema` | Regenerate [`docs/schema.md`](docs/schema.md) from the migrations                             |
| `pnpm typecheck`  | Build, then typecheck the tests against the built declarations                                |
| `pnpm test`       | Vitest over every package (aliased to source, no build needed)                                |
| `pnpm test:watch` | The same, watching                                                                            |
| `pnpm lint`       | ESLint (type-aware) + Prettier check                                                          |
| `pnpm format`     | Prettier write                                                                                |
| `pnpm check:deps` | Enforce the package graph and boundary rules — see [ADR-0001](docs/adr/0001-package-graph.md) |
| `pnpm verify`     | All of the above, in the order CI will run them                                               |

## The workspace

Nine packages, a CLI, and a standalone fixture library, per
[LEAN-V1 §5](docs/spec/LEAN-V1.md). Depth is the longest path to `core`; a package may
only depend on packages of lower depth.

| Depth | Package                                   | Responsibility                                                                              |
| ----: | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
|     0 | [`@excavate/core`](packages/core)         | Domain types, IDs, errors, time, and the API contract. No dependencies, no `node:` imports. |
|     0 | [`@excavate/git-fixtures`](fixtures)      | The `repo()` DSL — build real repositories deterministically. Published standalone.         |
|     1 | [`@excavate/git`](packages/git)           | All reading of Git object data, by shelling out to `git`.                                   |
|     1 | [`@excavate/store`](packages/store)       | SQLite schema, migrations, typed queries, FTS5. One file: `index.db`.                       |
|     1 | [`@excavate/ai`](packages/ai)             | Providers, pipelines, prompts, the citation validator, budget.                              |
|     1 | [`@excavate/ui`](packages/ui)             | The browser application and the Canvas2D map.                                               |
|     2 | [`@excavate/index`](packages/index)       | The single streaming walk: renames, identity merging, noise.                                |
|     2 | [`@excavate/analysis`](packages/analysis) | Significance, ownership, coupling, hotspots, reverts, eras.                                 |
|     2 | [`@excavate/evidence`](packages/evidence) | Six collectors, ranking, confidence, bundle hashing.                                        |
|     3 | [`@excavate/server`](packages/server)     | The daemon, and the composition root.                                                       |
|     4 | [`excavate`](cli)                         | `index`, `open`, `stats`, `why`, `doctor` — and it picks the front end the daemon serves.   |

Also: [`prompts/`](prompts) (versioned templates, M7), [`evals/`](evals) (30 golden
cases, M7), [`docs/adr/`](docs/adr) (decision records), [`docs/spec/`](docs/spec) (the
specification).

### Boundaries

Five rules from [Part 7 §7.3](docs/spec/07-product-architecture.md) protect the
packages from each other. Three are enforced mechanically by `pnpm check:deps`; two are
review gates. **B3 and B5 are the two that make Excavate what it is** — if either
erodes, the product becomes a repo-chat tool with extra steps.

| #   | Rule                                        | Enforced by                                                                                                                 |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| B1  | Only `@excavate/git` touches the repository | `check:deps` — no other package may import `child_process`                                                                  |
| B2  | Only `@excavate/store` writes SQL           | `check:deps` — no other package may import a SQLite driver                                                                  |
| B3  | AI never retrieves                          | The graph (`ai` depends on `core` alone) **and** `check:deps`, which denies it filesystem, subprocess, and network builtins |
| B4  | The UI computes nothing analytical          | Review, plus CLI/UI/MCP agreement tests                                                                                     |
| B5  | Every feature has a no-AI path              | Review, plus an offline E2E suite that must stay green                                                                      |

`check:deps` matches builtins with or without the `node:` prefix — they are the same import,
and a rule bypassed by deleting five characters is worse than no rule, because the table
above claims this one is mechanical.

## Contributing

Not yet — the interfaces are still moving. Once M1 lands, the easiest contribution
paths and the good-first-issue labels arrive with it (M6).

Anything that changes a public contract needs an ADR in [`docs/adr/`](docs/adr) first.

## Non-goals

Excavate is **not** a chat interface with a repo attached, a code review tool, a hosted
SaaS, an enterprise compliance dashboard, or a code editor. It is **not** and will never
be a developer productivity or performance-management tool — that is a hard ethical
line, see [Part 2](docs/spec/02-principles.md).

**No telemetry.** Not off-by-default — absent, with no collection code path.

## License

[Apache-2.0](LICENSE). The explicit patent grant matters for a tool that corporations
will run against proprietary code, and it is the license large companies approve
without a legal review cycle.
