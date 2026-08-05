# @excavate/git-fixtures

Build **real Git repositories** deterministically, for testing Git tooling.

```ts
const fixture = await repo()
  .commit('add the widget', (c) => c.add('src/widget.ts', 'export const x = 1;'))
  .commit('rename it', (c) => c.rename('src/widget.ts', 'src/gadget.ts'))
  .build();

// Same script, same OIDs — on your laptop and in CI.
fixture.oid('rename it'); // → '9c1f…'
```

Zero dependencies. Node 22+, `git` 2.30+.

## The problem

If you are writing anything that reads Git history — a blame tool, a metrics dashboard, a
rename tracker, a changelog generator — your tests need a repository with a known shape.
There are three usual approaches and all three hurt.

**Committing a fixture repository into your repository.** Nested `.git` directories fight
your tooling, the fixture is opaque in review (a reader cannot see what the history _is_
without checking it out), and extending it means a manual `git commit` from someone's
shell, with their identity and their clock baked into the OIDs forever.

**Mocking `git`'s output.** This tests your parser against your beliefs about git rather
than against git. Rename detection, `.mailmap` precedence, `-C` copy scoring,
`.git-blame-ignore-revs`, and merge conflict staging all have behaviour that is very hard
to imitate correctly and very easy to imitate _plausibly_. A plausible mock is worse than
no test: it makes a wrong parser green.

**Building a repository in a `beforeAll` with shell commands.** Correct in principle, and
this is what the package does — but the naive version is not reproducible, and the reason
is worth being precise about.

A commit OID is a SHA-1 over the commit object, whose bytes are:

```
tree <tree-oid>
parent <parent-oid>
author <name> <email> <timestamp> <offset>
committer <name> <email> <timestamp> <offset>

<message>
```

So the OID moves if _anything_ in there moves. `GIT_AUTHOR_DATE` is the one everybody
pins, and pinning it alone is not enough: **the committer date defaults to "now"**, so the
hash changes on every run and no test can hardcode it. The author's name comes from the
ambient `user.name`, so it changes per developer. And the _tree_ is not safe either — a
contributor with `core.autocrlf=true` gets different blobs, and a system `gitattributes`
marking `*.ts` as `text` does the same thing without appearing in any config you thought
to check.

This package closes all of those. The same DSL script produces byte-identical OIDs on
every run and every machine, and it does it by building an actual repository, so
`git log --numstat`, rename detection, `.mailmap`, and `git blame` behave exactly as they
will in production.

## Install

```sh
pnpm add -D @excavate/git-fixtures
```

ESM only. Requires `git` on the `PATH` (2.30 or newer) and Node 22+.

## A worked example

A test for a hypothetical rename tracker, using [Vitest](https://vitest.dev):

```ts
import { afterAll, expect, it } from 'vitest';
import { type FixtureRepo, repo } from '@excavate/git-fixtures';

const built: FixtureRepo[] = [];
afterAll(() => Promise.all(built.map((f) => f.cleanup())));

it('follows a file through two renames and an edit', async () => {
  const fixture = await repo('rename-chain')
    .commit('add the parser', (c) =>
      c.add('src/parse.ts', 'export const parse = () => {};\n'),
    )
    .commit('move it into lib', (c) => c.rename('src/parse.ts', 'src/lib/parse.ts'))
    .commit('rename and extend it', (c) =>
      c
        .rename('src/lib/parse.ts', 'src/lib/parser.ts')
        .edit(
          'src/lib/parser.ts',
          (previous) => `${previous}export const version = 2;\n`,
        ),
    )
    .build();
  built.push(fixture);

  const history = await myTool.fileHistory(fixture.path, 'src/lib/parser.ts');

  // Commit subjects are the handles. Nothing hardcodes a hash.
  expect(history.map((entry) => entry.commit)).toStrictEqual([
    fixture.oid('rename and extend it'),
    fixture.oid('move it into lib'),
    fixture.oid('add the parser'),
  ]);
});
```

Three things to notice, because they are the whole ergonomic argument:

1. **Subjects are the test-facing handles.** `fixture.oid('move it into lib')` instead of
   a hash literal. Building two commits with the same subject fails at build time rather
   than silently shadowing one of them, and `oid()` on an unknown subject throws with the
   full list of known ones.
2. **The script reads as the history.** A reviewer can see what the repository contains
   without checking anything out.
3. **`cleanup()` is honest.** It removes the temporary directory, does nothing if you
   passed `keep: true`, and does not throw if the directory is already gone — so it is
   safe in a `finally` or an `afterAll` that runs after a failure.

## API

### `repo(name?)`

Returns a `RepoBuilder`. `name` is cosmetic: it prefixes the temporary directory so a kept
fixture is identifiable in `/tmp`.

Builder methods only _record_ steps; nothing touches the disk until `build()`. That is
what makes `revert()` and `blameIgnore()` able to refer to commits by subject.

| `RepoBuilder`              | Does                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| `.commit(subject, build?)` | One commit. Omit `build` for an empty commit (`--allow-empty`).                 |
| `.branch(name)`            | Create a branch at the current tip and switch to it.                            |
| `.checkout(name)`          | Switch branches. Any committish works, but a tag or OID detaches `HEAD`.        |
| `.merge(branch, options?)` | `{ noFastForward }` forces a real merge commit; `{ subject }` sets the message. |
| `.tag(name, options?)`     | Lightweight, or `{ annotated: true, message }` for a tag object.                |
| `.mailmap(entries)`        | Commit a `.mailmap` mapping aliases to canonical identities.                    |
| `.blameIgnore(subjects)`   | Commit a `.git-blame-ignore-revs` naming previously built commits.              |
| `.build(options?)`         | `Promise<FixtureRepo>`. `{ path, keep }`.                                       |

| `CommitBuilder`            | Does                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| `.add(path, content)`      | New file. Throws if the path already exists.                              |
| `.edit(path, content)`     | Replace content. `content` may be `(previous) => next`. Throws if absent. |
| `.rename(from, to)`        | A real `git mv`. Creates the destination directory if needed.             |
| `.copy(from, to)`          | Copy, keeping the original — for `git diff -C`. Will not clobber `to`.    |
| `.delete(path)`            | `git rm`.                                                                 |
| `.chmod(path, mode)`       | Mode `0o755` records tree mode `100755`.                                  |
| `.revert(subject)`         | Apply the inverse patch of an already-built commit.                       |
| `.author(name, email?)`    | Email defaults to `first.last@fixture.invalid`.                           |
| `.committer(name, email?)` | Defaults to the author.                                                   |
| `.at(iso)`                 | Override the clock. ISO-8601 **with an offset**; the offset is recorded.  |
| `.body(text)`              | Message body below the subject.                                           |
| `.trailer(key, value)`     | e.g. `('Co-authored-by', 'Grace Hopper <grace@example.com>')`.            |

`FixtureRepo` is `{ path, oids, oid(subject), cleanup() }`, where `oids` is a
`ReadonlyMap<subject, oid>` in commit order.

Three subject conventions, since subjects are the handles:

- A `merge()` that **fast-forwards creates no commit**, so it registers no subject and
  `oid("Merge branch 'x'")` will throw. That is the honest answer — there is nothing to
  point at. Pass `{ noFastForward: true }` if you want a merge commit to name; a
  `{ noFastForward: true }` merge with nothing to merge fails at `build()` rather than
  quietly registering no subject.
- `mailmap()` commits under the subject `Add .mailmap`, and `blameIgnore()` under
  `Add .git-blame-ignore-revs`.
- `revert(subject)` appends git's own `This reverts commit <oid>.` line to the message but
  leaves the subject to you — so an inverse diff can be committed under a message that
  never mentions a revert, which is a case worth testing.

The clock starts at **2020-01-01T00:00:00Z** and advances one hour per step that creates a
commit: `commit()`, `mailmap()`, `blameIgnore()`, and `merge()` — including a `merge()`
that fast-forwards and therefore creates nothing, so that adding `{ noFastForward: true }`
to an existing script does not shift the commits after it. `tag()` reuses the instant of
the commit it points at and never advances the clock. `at()` overrides one commit's instant
without shifting any other.

### `fixture(name)` and `FIXTURE_CASES`

24 prebuilt cases, each of which actually exhibits the phenomenon it names:

```ts
const built = await fixture('rename-across-merge');
```

| Case                        | Exhibits                                                                          |
| --------------------------- | --------------------------------------------------------------------------------- |
| `simple-linear`             | Four commits, two authors, one annotated release tag. The baseline.               |
| `rename-simple`             | A pure `git mv`; git reports `R100`.                                              |
| `rename-with-edit`          | Rename plus a ~40% edit, so the similarity score lands in the 50–99 band.         |
| `rename-chain`              | a → b → c across three commits.                                                   |
| `rename-across-merge`       | Renamed on a branch, edited on the trunk, reconciled by a `--no-ff` merge.        |
| `rename-back`               | a → b → a; the original path is live at both ends and dead in the middle.         |
| `rename-delete-add-similar` | A delete and a ~90%-similar add in **separate** commits, which git will not pair. |
| `copy-detected`             | A copy whose source is modified in the same commit; `git diff -C` reports `C`.    |
| `resurrection`              | One path, deleted and later re-added with different content — two identities.     |
| `merge-fast-forward`        | A merge that creates no commit at all.                                            |
| `merge-true`                | Exactly one two-parent merge commit, plus a release tag.                          |
| `merge-conflicting-rename`  | rename/rename(1to2), resolved with both destinations live.                        |
| `revert-explicit`           | Git's own `Revert "…"` subject and `This reverts commit <oid>.` line.             |
| `revert-diff-inverse`       | An exact inverse diff whose message never says "revert".                          |
| `revert-message-only`       | A message that claims a revert its diff does not perform.                         |
| `revert-with-reland`        | Revert, then re-land the identical blob.                                          |
| `mailmap-identities`        | Three spellings of one person, two of another, and a `.mailmap`.                  |
| `coauthored-by`             | One and two `Co-authored-by` trailers, as forges write them.                      |
| `bot-authors`               | `dependabot[bot]`, `renovate[bot]`, `github-actions[bot]` address shapes.         |
| `blame-ignore-revs`         | A whole-file reindent listed in `.git-blame-ignore-revs`, with a real fix on top. |
| `empty-commit`              | A commit that changes nothing, between two that do.                               |
| `binary-file`               | A NUL-bearing blob; `--numstat` reports `-\t-`.                                   |
| `crlf-line-endings`         | CRLF bytes stored verbatim, then normalised to LF in a whitespace-only commit.    |
| `unicode-paths`             | Accented, CJK, and emoji paths, in NFC on every platform.                         |

The corpus is a declared list (`FIXTURE_CASES`), not whatever files happen to be in a
directory, so a case cannot quietly disappear. Every case is verified against `git` in
this package's own tests — `git fsck` clean, `git diff --name-status -M` showing the
statuses claimed above, `git check-mailmap` resolving the aliases.

## What is pinned, and why

| Pinned                                                  | Otherwise                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GIT_AUTHOR_NAME/EMAIL/DATE`                            | The OID depends on `user.name` and the wall clock.                                    |
| `GIT_COMMITTER_NAME/EMAIL/DATE`                         | **The one people miss.** The committer date defaults to now, so OIDs move every run.  |
| `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` → null device | `~/.gitconfig` changes blobs (`core.autocrlf`) and objects (`commit.gpgsign`).        |
| `GIT_CONFIG_NOSYSTEM=1`                                 | Older git ignores `GIT_CONFIG_SYSTEM`.                                                |
| `GIT_ATTR_NOSYSTEM=1`                                   | A system `gitattributes` marking a pattern `text` rewrites line endings during `add`. |
| `HOME` → inside the fixture's `.git`                    | Belt and braces behind the config variables above.                                    |
| `core.hooksPath` → an empty directory                   | A global `core.hooksPath` runs the developer's hooks in your fixture.                 |
| `commit.gpgsign` / `tag.gpgsign` = false                | A signature is part of the object; also, signing prompts hang CI.                     |
| `core.autocrlf` / `core.safecrlf` = false               | Blob bytes differ per platform.                                                       |
| `core.precomposeunicode=true`                           | macOS records NFD path bytes and Linux NFC, so the **tree OID differs by platform**.  |
| `core.fileMode=true`                                    | `chmod()` fixtures silently record `100644`.                                          |
| `gc.auto=0`, `maintenance.auto=false`                   | Background repacking during a build.                                                  |
| `core.logAllRefUpdates=false`                           | Reflogs embed wall-clock time, so `.git` is not byte-reproducible.                    |
| `TZ=UTC`, `LC_ALL=C`                                    | Locale-dependent output.                                                              |

Also: `git init -b main` (never the developer's `init.defaultBranch`), and
`GIT_CEILING_DIRECTORIES`, so that if a build ever failed, subsequent commands could not
walk up and operate on whatever repository encloses the temp directory.

Every argument goes through `execFile`-style argument arrays, never a shell string —
fixture content deliberately contains quotes, newlines, and unicode.

## Limits of the guarantee

Stated plainly, because a determinism claim with hidden caveats is worse than a modest
one.

- **OIDs are stable for a given DSL script, not across versions of this package.** If a
  fixture case changes shape in a minor release, its OIDs change. Prefer
  `fixture.oid(subject)` over hash literals; if you must hardcode, pin the version.
- **`git`'s own behaviour is an input.** `git mv`, `git revert`, and merge resolution run
  through your installed git. Object hashing has been stable for git's entire history, and
  the merge machinery has been `ort` since 2.34, but a sufficiently old or new git could in
  principle resolve a merge differently. Tested against 2.50; CI covers Linux and macOS.
- **SHA-1 repositories only.** Global config is neutralised, so `init` uses the built-in
  default. A SHA-256 fixture is not currently expressible.
- **Windows is unverified.** The null-device path comes from `os.devNull`, but POSIX file
  modes and the CRLF case have not been exercised there.
- **Merge conflicts resolve by a fixed rule**, not by choice: stage 2 ("ours") where it
  exists, otherwise stage 3 ("theirs"), otherwise the path is removed. This is what makes
  a conflicting fixture reproducible; it is not a claim about what a human would do.
- **No symlinks, submodules, LFS pointers, or case-only renames.** Deliberate omissions.
- **One `git` process per operation.** A 100-commit repository takes roughly 9 seconds on
  a 2023 laptop, and the full 24-case matrix about 20. Fine for a test suite; wrong tool
  for generating a 10,000-commit corpus. `git fast-import` is the obvious future path and
  is not implemented.

## Debugging a fixture

- **`build({ keep: true })`** leaves the directory in place and `cleanup()` becomes a
  no-op. The path is in `fixture.path`, prefixed with the name you passed to `repo()`.
- **Failures carry the argv and both output streams.** A `GitCommandError` reads
  `git mv -- a b failed with status 128\nfatal: …`, not "exit code 128". Both streams
  because git splits its diagnostics across them: `fatal:` goes to stderr, but
  `git commit --quiet` with nothing staged says `nothing added to commit` on **stdout** —
  which is exactly what you hit when an `edit()` writes the bytes that were already there.
- **My OIDs differ between machines.** In order of likelihood: a `.gitattributes`
  _committed by your own fixture_ that enables `text` conversion; a path written in NFD
  rather than NFC; a fixture that reads the clock (`new Date()`) to build its content; or
  a different major version of `git` resolving a merge differently. The first three are
  your script; the fourth is worth an issue.
- **`git status` is not clean in a fixture.** That is a bug here — every case is asserted
  clean. Please report it with the script.

## License

[Apache-2.0](../LICENSE). The explicit patent grant matters for a library that
corporations will run inside their own test suites.
