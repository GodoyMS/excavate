# Changelog

All notable changes to Excavate are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Before 1.0 the minor version tracks the milestone that produced it — M1 ships v0.1, M2
ships v0.2, through v1.0 at M6 ([ROADMAP §2](docs/spec/ROADMAP.md)). Every milestone
ends in a release with an entry here, by construction: a milestone is not done until it
is "published to npm with a changelog entry and a git tag"
([ROADMAP §3](docs/spec/ROADMAP.md), item 6). There is no released version yet, so this
file has exactly one section.

## Unreleased

**M0 — Foundations & fixture DSL.** Complete, with one item outstanding: the write-up has
not been posted.

`@wise-excavate/git-fixtures@0.1.0` is published and tagged `v0.1.0-fixtures`. CI is green
on Linux and macOS across Node 22 and 24. The walk has been verified against both reference
corpora — `ripgrep` (2,255 commits) and `rust-analyzer` (12,832) — which is what caught the
walk-order bug below. The product itself is unreleased; the first product release is
`excavate stats` at **M1 (v0.1)**.

The npm scope is `@wise-excavate` rather than `@excavate`, and the CLI will publish as
`wise-excavate` rather than `excavate`, because both of those names are taken — see
[ADR-0002](docs/adr/0002-npm-naming.md). The command remains `excavate`.

M0 is foundations, so the entries below describe walls rather than a finished house.
Every package's public interface exists, and the M0 thread through it —
fixtures, git, store, daemon, CLI — is implemented; every analyzer, collector, and AI
entry point beyond M0's scope throws `NotImplementedError` naming the milestone that
fills it in. That distinction is deliberate and load-bearing: a tool whose only asset is
that its answers can be trusted must never let a changelog imply a capability it does
not have. `excavate --help` and those errors, not this file, are the authority on what
runs today.

`@wise-excavate/git-fixtures` is the **first published artifact** — M0's public deliverable,
released on its own ahead of anything else. It is genuinely useful outside this
repository (deterministic Git repositories are hard to build and every project testing
Git tooling needs them), which is why it ships first: it earns a small audience while
the product that depends on it is still being built.

### Fixed

- **The walk emitted children before their parents on some real repositories**, which made
  indexing fail with `FOREIGN KEY constraint failed`. `git log --reverse` reverses git's
  default ordering, which is by commit date rather than topology, so a rebase or clock skew
  yields a commit dated before its own parent. `walkArgs` now passes `--topo-order` for every
  projection: emission order is an index concern (referential integrity needs parents first)
  while presentation order is a query concern.

  Found by indexing `rust-analyzer`, which contains exactly one such pair in 12,832
  commits — `ripgrep` has none and neither does any fixture, so the whole suite passed while
  the walk was wrong. Regression test in `tests/walk-order.test.ts`.

- **`Store` could write the `meta` table but never read it**, so the daemon inferred
  readiness from a row count. An index truncated by an interrupted walk therefore reported
  itself `ready`, which is the failure Part 7 §7.7 and LEAN-V1 §9.1 exist to forbid. Added
  `Store.meta`; the session now reads the persisted state and the history's real date range.

- **Boundary rules B1 and B3 were bypassable.** `check-deps` compared against `node:`-prefixed
  specifiers only, so `import 'child_process'` walked through a rule the README and ADR-0001
  both described as mechanical. Builtins are now matched with or without the prefix, `ai` is
  denied filesystem/subprocess/network capability outright (so "AI never retrieves" is a
  property rather than a promise), and the root `tests/` tree — previously scanned by
  nothing — is checked against B2.

- **Internal faults were reported to clients as `GIT_FAILED`**, sending anyone debugging one
  to the wrong subsystem. Added `ErrorCode.INTERNAL`.

- **`excavate index` was a silent no-op on an already-indexed repository**, exiting 0 while
  its help text promised "build or update". It now says what it did, and the partial-index
  badge no longer advises re-running a command that cannot help.

### Added

- **Workspace.** One pnpm workspace, TypeScript throughout — nine packages plus the
  `excavate` CLI and the standalone fixture library, per
  [LEAN-V1 §5](docs/spec/LEAN-V1.md). TypeScript project references build the solution
  in dependency order and make an import cycle a compile error. Strict mode plus
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `erasableSyntaxOnly`.
- **The package graph, and a lint that enforces it.** `pnpm check:deps` checks a table
  of permitted edges against every `package.json` and `tsconfig.json`: illegal edges,
  phantom dependencies, `workspace:*` protocol, `tsconfig` reference drift, and
  acyclicity with computed depths. It also enforces boundary rules B1 (only
  `@wise-excavate/git` may import `node:child_process`) and B2 (only `@wise-excavate/store` may
  import a SQLite driver) mechanically rather than in review — there is no reviewer.
  B3 ("AI never retrieves") is enforced structurally instead: `@wise-excavate/ai` depends on
  `@wise-excavate/core` alone, so it has no store handle, no repository access, and no
  collector to call. See [ADR-0001](docs/adr/0001-package-graph.md).
- **`@wise-excavate/git-fixtures`** — the `repo()` DSL, and the isolation layer underneath
  it. Builders for commit, add, edit, rename, delete, branch, checkout, merge, revert,
  tag, mailmap, and blame-ignore, plus the named fixture matrix — an explicit list
  rather than whatever files happen to exist in a directory, trimmed per
  [LEAN-V1 §3.3](docs/spec/LEAN-V1.md) while keeping every rename form. Every `git`
  invocation runs with a fully specified environment rather than an overlay of the
  caller's: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at the null device,
  `GIT_ATTR_NOSYSTEM`, a pinned `TZ`/`LC_ALL`, all four `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
  variables, and nothing interactive — so a commit OID depends on the fixture and on
  nothing about the machine that built it. Pinning only the author date is the classic
  version of this bug: the committer date then defaults to "now" and every OID changes
  on every run.
- **SQLite schema v1, as an ordered migration list.** `@wise-excavate/store` owns the whole
  schema and is the only package permitted to write SQL. One file on disk (`index.db`),
  FTS5 inside it, no sidecars. `SCHEMA_VERSION` is derived from the migration list
  rather than declared beside it, so the two cannot disagree, and the list is asserted
  sequential and gapless. Rollups, `hunks`, and the bundle cache are deliberately absent
  from v1 — they arrive in `0002`/`0003` with the code that fills them, so
  `schema_version` never claims the index contains something it does not.
- **The daemon.** `@wise-excavate/server` on Hono, with server-sent events for progress
  (strictly server-to-client, so no WebSocket upgrade handshake and no
  origin-validation surface on the stream), a per-session bearer token, an `Origin`
  allowlist against DNS rebinding, and a one-walk-at-a-time job queue. It is also the
  composition root: the only package that knows about all the others.
- **The CLI.** `excavate` on `commander`, with `open`, `index`, `stats`, `why`, and
  `doctor` registered and their contracts fixed. `index` and `open` are wired through to
  the daemon; `stats`, `why`, and `doctor` validate their arguments and then throw
  `NotImplementedError` naming the milestone that implements them (M1, M2, M6), so
  `--help` is accurate about the surface and running one is unambiguous about the state.
  Bare `excavate <dir>` resolves to `open` without making `open` a commander default
  command, so a mistyped `excavate stat` still gets "did you mean stats?" instead of
  "not a repository".
- **The walking skeleton** (**M0.4**). One thread through every layer, asserted end to end
  by `tests/walking-skeleton.test.ts` against a real 100-commit fixture:
  `excavate index` on a fixture repository writes commits to SQLite, `GET /api/commits`
  serves them, and a plain HTML page lists them and shows a commit message on click.
  Deliberately ugly and explicitly disposable — M3 replaces it wholesale. Two details in
  it are contractual rather than incidental: route strings come from `ROUTES` in
  `@wise-excavate/core`, so the page cannot drift from the daemon's route table, and commit
  text reaches the DOM through `textContent` only, because commit messages are
  attacker-controlled text in a tool people point at untrusted repositories. The page is
  handed to the daemon as a string (`ServerOptions.indexHtml`) rather than imported,
  because ADR-0001 forbids a `server → ui` edge — the browser application is a static
  artifact the daemon serves, not a module it links against — and when no page is
  supplied, `/` says so plainly instead of returning a 404.
- **CI on Linux and macOS.** `.github/workflows/ci.yml` runs `check:deps`, `typecheck`,
  `lint`, and `test` on `ubuntu-latest` and `macos-latest` across Node 22 and 24, in
  the same order as `pnpm verify` so a local failure and a CI failure land on the same
  step. Read-only token, superseded runs cancelled, pnpm version taken from
  `packageManager` so CI cannot drift from a developer's machine.
  `.github/workflows/perf.yml` (manual trigger only) establishes the reference-corpus
  checkout for `ripgrep` and `rust-analyzer` and asserts no performance budget at all:
  M0's budget is "none yet — establish the harness", and M1 is the milestone that adds
  thresholds. The one thing it does check is that the corpus clone is not shallow, since
  a shallow clone would otherwise print a plausible commit count and pass.
- **Issue forms.** A bug report that requires the Excavate, Node, and Git versions, the
  OS, `excavate doctor` output, and repository size — Excavate's failures are
  overwhelmingly environmental, so a report without those cannot be acted on. A feature
  request that makes the reporter confirm the roadmap and the LEAN-V1 §3 cut list first,
  and requires the problem rather than the proposed solution.
