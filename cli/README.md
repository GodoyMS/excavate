# wise-excavate

> **Git tells you what changed. Excavate tells you why.**

Point it at any Git repository. It reads the history and tells you which files are dangerous,
which knowledge is about to walk out of the door, and which commits actually mattered.

```sh
npx wise-excavate stats
```

No configuration, no server, no account. The index is a local SQLite file under your OS cache
directory, and nothing leaves your machine.

## What it looks like

Run on [ripgrep](https://github.com/BurntSushi/ripgrep) — 2,255 commits, indexed in 1.7s:

```
  2,255 commits · 450 people · 338 files  2016-02-27 → 2026-08-04

  KNOWLEDGE ISLANDS
  One person holds the knowledge, and they have stopped contributing.

  ● crates/searcher/src/searcher/mmap.rs      howmanysmall  last seen 8mo ago
  ● crates/globset/src/serde_impl.rs          David Torosyan  last seen 13mo ago
  ● crates/core/flags/complete/prelude.fish   Jan Verbeek  last seen 2.6y ago

  HOTSPOTS
  churn × complexity × recency × fix density. Every factor shown.

   score  churn cmplx recent fixes   chgs  file
   0.839   .85  .82    .96  .25    123  tests/tests.rs
   0.809   .89  .94    .96  .00     33  crates/core/flags/defs.rs
   0.660   .85  .73    .98  .10     84  crates/ignore/src/walk.rs

  MOST SIGNIFICANT COMMITS
  Scored on scale, message quality, and path rarity — penalised for codemods,
  lockfiles, and generated output, so those never reach this list.

  4846d63  2018-08-30  grep-cli: introduce new grep-cli crate  26f
  d9ca529  2018-04-29  libripgrep: initial commit introducing libripgrep  68f
  082245d  2023-10-16  cli: replace clap with lexopt and supporting code  47f
```

Islands come first because they are the only section that tells you something you probably did
not know and can act on today.

## The three questions it answers

**Which files are dangerous?** A hotspot is `churn × complexity × recency × (1 + fix density)` —
a _product_, so a file has to score on more than one axis to rank. The biggest file in your
repository is not a hotspot if nobody changes it; the most-churned file is not a hotspot if it
is a 30-line config. Every factor is printed, because a single number you cannot decompose is a
number you cannot argue with.

**Whose knowledge is at risk?** Knowledge decays: `√(lines touched) · e^(−Δt/τ)` with a one-year
half-life. The square root is why a 2,000-line codemod does not make you an expert, and the
decay is why someone who last touched a file in 2019 is not its owner today. A **knowledge
island** is a file with a bus factor of one whose owner has been gone for six months.

**Which commits mattered?** Ten rewards and five penalties, and the penalties are the point.
Without them, "the most significant commits" reliably returns the Prettier migration, the
licence-header sweep, and a lockfile refresh — the commits nobody wants to read about. On
ripgrep, `style: rustfmt everything` ranks 2,099th out of 2,255.

## Why the package is `wise-excavate` but the command is `excavate`

`excavate` and `@excavate` were both already taken on npm by an unrelated package. The binary
this installs is still `excavate`, so after a global install you type what you would expect:

```sh
npm i -g wise-excavate
excavate stats
```

Only `npx` needs the full package name. The reasoning is written up in
[ADR-0002](https://github.com/GodoyMS/excavate/blob/main/docs/adr/0002-npm-naming.md).

## Commands

| Command                 | What it does                                             | Status |
| ----------------------- | -------------------------------------------------------- | ------ |
| `excavate stats [path]` | Vitals, hotspots, knowledge islands, significant commits | v0.1   |
| `excavate index [path]` | Build or update the index without printing a report      | v0.1   |
| `excavate open [path]`  | Index, then open the repository in your browser          | M3     |
| `excavate why <p>:<n>`  | Why does this line exist? A cited chain, no LLM          | M2     |
| `excavate doctor`       | Environment, git version, index integrity, disk          | M6     |

`excavate stats --json` emits the same report as a document, which is the same shape the browser
UI and the future MCP server consume. Commands that are not built yet say so and exit 69 rather
than printing something plausible.

## What v0.1 does not do yet

Stated plainly, because a tool that quietly does less than it appears to is worse than one that
tells you where it stops:

- **No line-level history.** `excavate why` needs per-hunk data, which lands in M2. Until then
  nothing here can tell you about a specific line.
- **Formatting-only commits are detected from their message, not their diff.** A commit that
  says `rustfmt everything` is caught; one that silently reformats is not, until hunks arrive.
- **Complexity is LOC plus mean indentation depth**, not a parsed AST. It cannot tell a
  400-line data table from 400 lines of dense logic. It works on every language, including ones
  nobody has written a parser for.
- **First-parent history only.** Merge branches are not walked, so the commit counts are of the
  mainline. On a repository merged by a bot this matters, and `Co-authored-by` trailers are read
  precisely so the real authors are still credited.
- **Two identities with the same name and overlapping activity are never merged.** That is two
  people called Chen, and guessing wrong would attribute one person's work to another. Add a
  [`.mailmap`](https://git-scm.com/docs/gitmailmap) and it is treated as fact.

## Requirements

Node 22+ and `git` on your `PATH`. macOS, Linux, and Windows.

## Licence

Apache-2.0. Source and full specification at
[github.com/GodoyMS/excavate](https://github.com/GodoyMS/excavate).
