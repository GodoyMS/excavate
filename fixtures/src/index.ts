/**
 * `@wise-excavate/git-fixtures` — build real Git repositories deterministically.
 *
 * The highest-value item in M0 (Part 15) and one of the things LEAN-V1 §4 says must
 * not be touched: *"~300 lines, and it is the only way to test Git tooling
 * deterministically."* Every later milestone's testing rests on it. Write the fixture
 * matrix before the implementation, not after.
 *
 * **Deliberately zero dependencies — not even `@wise-excavate/core`.**
 *
 * This package is published on its own as a standalone testing library (ROADMAP M0's
 * public artifact), and a general-purpose Git fixture builder should not drag one
 * project's domain model in with it. So OIDs are plain strings here. The coupling
 * would also make publishing it require publishing core, for no benefit to either.
 *
 * **On repositories and boundary rule B1.** B1 says only `@wise-excavate/git` touches a
 * repository. This package shells out to `git` too, and the exemption is narrow and
 * deliberate: it only ever *creates* fixtures in a temporary directory, and never
 * reads a user's repository. `scripts/check-deps.mjs` allows exactly these two
 * packages and no others.
 *
 * ```ts
 * const fixture = await repo()
 *   .commit('add the widget', (c) => c.add('src/widget.ts', 'export const x = 1;'))
 *   .commit('rename it', (c) => c.rename('src/widget.ts', 'src/gadget.ts'))
 *   .build();
 * ```
 */

import { createRepoBuilder } from './builder.js';
import { CASE_SCRIPTS } from './matrix.js';

/**
 * Determinism is the whole point: same script in, same OIDs out, on every machine.
 *
 * Retained from the M0.1 stub surface. The DSL is fully implemented as of M0.3, so
 * nothing in this package throws this any more; it stays exported because it is part of
 * the declared surface and because a future construct that lands in a later milestone
 * should announce itself the same way rather than inventing a second convention.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet — lands in M0.3`);
    this.name = 'NotImplementedError';
  }
}

/**
 * A fixed instant, so commit OIDs are reproducible. 2020-01-01T00:00:00Z — chosen to
 * be recent enough that recency-decayed metrics behave realistically and round enough
 * to read in failure output.
 */
export const DETERMINISTIC_EPOCH = 1_577_836_800;

/** Each commit advances the clock by this much unless `at()` overrides it. */
export const COMMIT_INTERVAL_SECONDS = 3_600;

export const DEFAULT_AUTHOR: Identity = {
  name: 'Fixture Author',
  email: 'author@fixture.invalid',
};

export interface Identity {
  readonly name: string;
  readonly email: string;
}

/** Builds one commit. Every method chains. */
export interface CommitBuilder {
  add(path: string, content: string): CommitBuilder;
  edit(path: string, content: string | ((previous: string) => string)): CommitBuilder;
  /** An explicit `git mv`, so the backend reports a real rename. */
  rename(from: string, to: string): CommitBuilder;
  /** Copy content to a new path, keeping the original — exercises `-C` detection. */
  copy(from: string, to: string): CommitBuilder;
  delete(path: string): CommitBuilder;
  chmod(path: string, mode: number): CommitBuilder;
  /** Revert a previously built commit, referenced by its subject. */
  revert(subject: string): CommitBuilder;
  author(name: string, email?: string): CommitBuilder;
  committer(name: string, email?: string): CommitBuilder;
  /** Override the deterministic clock. Accepts an ISO-8601 string with an offset. */
  at(iso: string): CommitBuilder;
  /** Message body below the subject. */
  body(text: string): CommitBuilder;
  trailer(key: string, value: string): CommitBuilder;
}

export interface MergeOptions {
  /** Force a merge commit even when the merge could fast-forward. */
  readonly noFastForward?: boolean;
  readonly subject?: string;
}

export interface TagOptions {
  /** Annotated rather than lightweight. Releases are inferred from these. */
  readonly annotated?: boolean;
  readonly message?: string;
}

export interface RepoBuilder {
  /** Subjects must be unique within a fixture: they are how tests name commits. */
  commit(subject: string, build?: (c: CommitBuilder) => void): RepoBuilder;
  /** Create a branch at the current tip and switch to it. */
  branch(name: string): RepoBuilder;
  checkout(name: string): RepoBuilder;
  merge(branch: string, options?: MergeOptions): RepoBuilder;
  tag(name: string, options?: TagOptions): RepoBuilder;
  /** Write a `.mailmap`, for identity-merging fixtures. */
  mailmap(entries: readonly MailmapEntry[]): RepoBuilder;
  /** Write a `.git-blame-ignore-revs` naming previously built commits by subject. */
  blameIgnore(subjects: readonly string[]): RepoBuilder;
  build(options?: BuildOptions): Promise<FixtureRepo>;
}

export interface MailmapEntry {
  readonly canonical: Identity;
  readonly alias: Identity;
}

export interface BuildOptions {
  /** Defaults to a fresh directory under the OS temp dir. */
  readonly path?: string;
  /** Keep the directory after `cleanup()` — useful when a test fails and you want to look. */
  readonly keep?: boolean;
}

export interface FixtureRepo {
  readonly path: string;
  /** Commit subject → full OID, so assertions never hardcode a hash. */
  readonly oids: ReadonlyMap<string, string>;
  /** Resolve a commit by the subject it was built with. Throws if unknown. */
  oid(subject: string): string;
  cleanup(): Promise<void>;
}

/**
 * Start a fixture.
 *
 * The M0 acceptance criterion is exactly this shape:
 * `repo().commit('a', c => c.add('x.ts', '…')).build()` produces a valid repository.
 *
 * `name` is cosmetic — it only prefixes the temporary directory, so that a kept
 * fixture is identifiable in `/tmp` without opening it.
 */
export function repo(name?: string): RepoBuilder {
  return createRepoBuilder({
    name,
    epochSeconds: DETERMINISTIC_EPOCH,
    intervalSeconds: COMMIT_INTERVAL_SECONDS,
    defaultIdentity: DEFAULT_AUTHOR,
  });
}

/**
 * The fixture matrix — 24 cases, trimmed from ~40 (LEAN-V1 §3.3, which budgeted "~22").
 *
 * Keeps every rename form, merges, mailmap, blame-ignore, resurrection, empty commits,
 * binary, CRLF, and unicode paths. Drops LFS, submodules, case-only renames, and
 * paths over 255 bytes.
 *
 * Named here so the corpus is a declared list rather than whatever files happen to
 * exist in a directory.
 */
export const FIXTURE_CASES = [
  'simple-linear',
  'rename-simple',
  'rename-with-edit',
  'rename-chain',
  'rename-across-merge',
  'rename-back',
  'rename-delete-add-similar',
  'copy-detected',
  'resurrection',
  'merge-fast-forward',
  'merge-true',
  'merge-conflicting-rename',
  'revert-explicit',
  'revert-diff-inverse',
  'revert-message-only',
  'revert-with-reland',
  'mailmap-identities',
  'coauthored-by',
  'bot-authors',
  'blame-ignore-revs',
  'empty-commit',
  'binary-file',
  'crlf-line-endings',
  'unicode-paths',
] as const;

export type FixtureCase = (typeof FIXTURE_CASES)[number];

/**
 * Build one of the named matrix cases.
 *
 * `async`, so that *every* failure is a rejection. The `FixtureCase` union makes the
 * unknown-name branch unreachable from TypeScript, but this is a published package and
 * JavaScript callers get no such check; a function that returns a promise and also throws
 * synchronously is one a `.catch()` cannot protect against.
 */
export async function fixture(
  name: FixtureCase,
  options?: BuildOptions,
): Promise<FixtureRepo> {
  const script = CASE_SCRIPTS[name];
  if (script === undefined) {
    throw new Error(
      `unknown fixture case ${JSON.stringify(name)}. Known cases: ` +
        FIXTURE_CASES.join(', '),
    );
  }
  const builder = repo(name);
  script(builder);
  return await builder.build(options);
}
