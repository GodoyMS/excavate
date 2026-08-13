# Excavate

[![CI](https://github.com/GodoyMS/excavate/actions/workflows/ci.yml/badge.svg)](https://github.com/GodoyMS/excavate/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/wise-excavate?label=wise-excavate)](https://www.npmjs.com/package/wise-excavate)
[![npm](https://img.shields.io/npm/v/@wise-excavate/git-fixtures?label=%40wise-excavate%2Fgit-fixtures)](https://www.npmjs.com/package/@wise-excavate/git-fixtures)

> **Git tells you what changed. Excavate tells you why.**

Excavate turns any Git repository into a story you can read, a map you can explore, and
a question you can ask — with receipts on every claim.

> **Status: alpha — v0.1, milestone M1 of nine.** Useful today, and narrower than the
> paragraph above it will eventually describe. That paragraph is the destination; this block
> is the current position, and it will stay honest at every release.
>
> What works today: `excavate stats` on any repository — knowledge
> islands, hotspots with their factor breakdown, the most significant commits, and the cast
> of characters, plus `--json` for scripting. Underneath: a streaming git walk, identity
> merging, rename resolution with alias chains, noise classification, incremental update, and
> the [`repo()` fixture DSL](fixtures) with a 24-case matrix.
>
> Deliberately _not_ here: hunks, blame, eras, coupling, and `excavate why` — those are
> **M2 (v0.2)**, and each stub throws `NotImplementedError` naming the milestone that fills
> it in. There is no UI until M3; the terminal is the product today.
>
> Plan: [ROADMAP.md](docs/spec/ROADMAP.md) · Scope: [LEAN-V1.md](docs/spec/LEAN-V1.md) ·
> Reference: [SPEC.md](SPEC.md)

## Try it

No install, no account, no API key. Run it inside any git repository:

```sh
npx wise-excavate stats
```

Here is part of what it finds in [ripgrep](https://github.com/BurntSushi/ripgrep) — 2,255
commits indexed in about a second:

```
  KNOWLEDGE ISLANDS
  One person holds the knowledge, and they have stopped contributing.

  ● crates/searcher/src/searcher/mmap.rs      howmanysmall     last seen 8mo ago
  ● crates/globset/src/serde_impl.rs          David Torosyan   last seen 13mo ago
  ● crates/core/flags/complete/encodings.sh   Jan Verbeek      last seen 2.6y ago
  ● fuzz/fuzz_targets/fuzz_glob.rs            William Johnson  last seen 2.6y ago

  HOTSPOTS
  churn × complexity × recency × fix density. Every factor shown.

   score  churn cmplx recent fixes   chgs  file
   0.836   .85  .82    .96  .25    123  tests/tests.rs
   0.807   .89  .94    .96  .00     33  crates/core/flags/defs.rs
   0.658   .85  .73    .97  .10     84  crates/ignore/src/walk.rs
   0.629   .82  .75    .93  .09     69  crates/globset/src/lib.rs
```

A **knowledge island** is a file exactly one person understands, who has stopped
contributing. Both halves are required: a bus factor of 1 on a file whose owner committed
yesterday is _normal_, and reporting those would bury the signal. The islands section comes
first because it is the part most likely to tell you something you did not know.

A **hotspot** score is a _product_, never a sum, so a file has to score on more than one axis
to rank — the biggest file in the repository is not a hotspot if nobody changes it. Every
factor is always shown, because a bare 0.836 is not an answer.

The command is `excavate`; the npm package is `wise-excavate`, because `excavate` was already
taken ([ADR-0002](docs/adr/0002-npm-naming.md)).

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

| Depth | Package                                        | Responsibility                                                                              |
| ----: | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
|     0 | [`@wise-excavate/core`](packages/core)         | Domain types, IDs, errors, time, and the API contract. No dependencies, no `node:` imports. |
|     0 | [`@wise-excavate/git-fixtures`](fixtures)      | The `repo()` DSL — build real repositories deterministically. Published standalone.         |
|     1 | [`@wise-excavate/git`](packages/git)           | All reading of Git object data, by shelling out to `git`.                                   |
|     1 | [`@wise-excavate/store`](packages/store)       | SQLite schema, migrations, typed queries, FTS5. One file: `index.db`.                       |
|     1 | [`@wise-excavate/ai`](packages/ai)             | Providers, pipelines, prompts, the citation validator, budget.                              |
|     1 | [`@wise-excavate/ui`](packages/ui)             | The browser application and the Canvas2D map.                                               |
|     2 | [`@wise-excavate/index`](packages/index)       | The single streaming walk: renames, identity merging, noise.                                |
|     2 | [`@wise-excavate/analysis`](packages/analysis) | Significance, ownership, coupling, hotspots, reverts, eras.                                 |
|     2 | [`@wise-excavate/evidence`](packages/evidence) | Six collectors, ranking, confidence, bundle hashing.                                        |
|     3 | [`@wise-excavate/server`](packages/server)     | The daemon, and the composition root.                                                       |
|     4 | [`wise-excavate`](cli)                         | `index`, `open`, `stats`, `why`, `doctor` — and it picks the front end the daemon serves.   |

Also: [`prompts/`](prompts) (versioned templates, M7), [`evals/`](evals) (30 golden
cases, M7), [`docs/adr/`](docs/adr) (decision records), [`docs/spec/`](docs/spec) (the
specification).

### Boundaries

Five rules from [Part 7 §7.3](docs/spec/07-product-architecture.md) protect the
packages from each other. Three are enforced mechanically by `pnpm check:deps`; two are
review gates. **B3 and B5 are the two that make Excavate what it is** — if either
erodes, the product becomes a repo-chat tool with extra steps.

| #   | Rule                                             | Enforced by                                                                                                                 |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| B1  | Only `@wise-excavate/git` touches the repository | `check:deps` — no other package may import `child_process`                                                                  |
| B2  | Only `@wise-excavate/store` writes SQL           | `check:deps` — no other package may import a SQLite driver                                                                  |
| B3  | AI never retrieves                               | The graph (`ai` depends on `core` alone) **and** `check:deps`, which denies it filesystem, subprocess, and network builtins |
| B4  | The UI computes nothing analytical               | Review, plus CLI/UI/MCP agreement tests                                                                                     |
| B5  | Every feature has a no-AI path                   | Review, plus an offline E2E suite that must stay green                                                                      |

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
