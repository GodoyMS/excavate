/**
 * `@excavate/git` — depth 1.
 *
 * **Responsibility.** All reading of Git object data: history traversal, tree
 * diffing, rename detection, blame, ref and tag enumeration, `.mailmap`, and
 * `.git-blame-ignore-revs`.
 *
 * **Non-goals.** Never writes to the repository. Never interprets meaning. Never
 * touches the database.
 *
 * **Boundary rule B1: only this package touches the repository.** That is what makes
 * the rest of the graph testable — everything downstream reads from the store, and
 * `scripts/check-deps.mjs` fails the build if another package reaches for
 * `node:child_process`.
 *
 * LEAN-V1 §3.1 cuts gitoxide, the `HybridBackend`, and the second implementation:
 * there is one backend, and it shells out to `git`, whose rename detection has 20
 * years of hardening behind it and which every user already has installed.
 *
 * The split that matters is purity, not file count: `walk.ts` and `mailmap.ts` are pure
 * — bytes in, `RawCommit`s and `Identity`s out, no process and no filesystem — so the
 * framing rules that every downstream fact depends on are testable against synthetic
 * input, and `exec.ts` is the only module that spawns anything at all (`backend.ts` and
 * `discover.ts` go through it, which is how boundary rule B1 stays checkable).
 */

export * from './backend.js';
export * from './discover.js';
export * from './mailmap.js';
export * from './walk.js';
