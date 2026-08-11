/**
 * The M0 shortcuts, quarantined in one file so that M1 deletes it wholesale.
 *
 * Everything in here is *knowably wrong*. It exists so the M0 walking skeleton
 * (Part 15, M0 deliverable 4) can thread a real commit from `git log` through the
 * store and back out of the daemon before any layer is built properly — which is
 * the entire point of M0: find the interface mistakes while they are still cheap.
 *
 * | Shortcut here          | M1 replacement           | Wrong until then                                |
 * | ---------------------- | ------------------------ | ----------------------------------------------- |
 * | `createM0PeopleTable`  | `createIdentityResolver` | one person per email — no mailmap, no bots       |
 * | `createM0FileTable`    | `createRenameResolver`   | a renamed file is two unrelated files            |
 * | `m0CommitFlags`        | `createNoiseClassifier`  | no penalty flags, so noise ranks as signal       |
 * | `M0_SIGNIFICANCE`      | the significance scorer  | every commit scores 0                            |
 * | `splitCommitMessage`   | a trailer-aware parser   | `Co-authored-by` and `PR-URL:` are simply absent |
 *
 * **Why this is safe in M0 and only in M0.** No M0 feature reads any of it. There
 * is no ownership, no bus factor, no knowledge island, no significance ranking and
 * no Why answer in this milestone — precisely because those features on top of this
 * file would ship confident wrong answers, which [Part 2 §2.5](../../../docs/spec/02-principles.md)
 * treats as worse than shipping nothing. LEAN-V1 §7 refuses to compress M1 for the
 * same reason: a lineage bug found four milestones later is brutal to diagnose
 * backwards.
 */

import type {
  CommitFlag,
  CommitId,
  FileEntity,
  FileId,
  Identity,
  PathId,
  Person,
  PersonId,
  Timestamp,
} from '@wise-excavate/core';
import { compareTimestamps, fileId, personId } from '@wise-excavate/core';
import type { RawChange, RawCommit } from '@wise-excavate/git';

/* ── Identity ──────────────────────────────────────────────────────────────── */

/**
 * One `PersonId` per distinct lowercased email address.
 *
 * Deliberately *not* an `IdentityResolver`: implementing that interface would claim
 * Part 8 §8.3.1's five-step resolution ran, and a `mergeSource` the UI can explain.
 * None of it did. What is missing, in the order M1 adds it: `.mailmap` (which is the
 * repository's own authoritative declaration and therefore the one source that must
 * never be second-guessed), email normalization (`+tag`, Gmail dots,
 * `NNNN+user@users.noreply.github.com`), name-and-domain merging, bot detection, and
 * the non-merge rule for identical names with overlapping activity windows.
 *
 * The visible consequence: one human who has committed from work and personal
 * addresses is two people here, and `dependabot[bot]` is a top contributor. That is
 * why M0 ships no cast of characters and no ownership.
 */
export interface M0PeopleTable {
  /**
   * `role` exists because `commitCount` means *commits authored* (Part 8 §8.3.1);
   * counting the committer too would double every rebased or squash-merged commit.
   */
  resolve(identity: Identity, seenAt: Timestamp, role: 'author' | 'committer'): PersonId;
  /**
   * The rows touched since the last drain, and *only* those. Draining rather than
   * returning the whole table is what lets the pipeline write people inside the same
   * batch as the commits that reference them, which `commits.author_id REFERENCES
   * people(id)` requires — the constraint is not deferrable, so "upsert everything at
   * the end" is not an option. Upserting the whole table every batch would be, and
   * costs `batches × people` writes for no benefit.
   *
   * Correct because the aggregate fields only move when `resolve` is called: the batch
   * containing a person's last commit is the batch that writes their final counts.
   */
  drain(): readonly Person[];
}

export function createM0PeopleTable(): M0PeopleTable {
  interface Row {
    readonly id: PersonId;
    readonly canonicalName: string;
    readonly canonicalEmail: string;
    readonly identities: Identity[];
    firstSeen: Timestamp;
    lastSeen: Timestamp;
    commitCount: number;
  }

  const byEmail = new Map<string, Row>();
  /** Keys whose row has changed since the last drain. */
  const dirty = new Set<string>();

  return {
    resolve(identity, seenAt, role) {
      const key = identity.email.trim().toLowerCase();
      dirty.add(key);
      let row = byEmail.get(key);
      if (row === undefined) {
        row = {
          // Dense and 1-based, matching the `CommitId` convention: 0 is falsy, and a
          // falsy foreign key is a bug that hides in every truthiness check.
          id: personId(byEmail.size + 1),
          canonicalName: identity.name,
          canonicalEmail: identity.email,
          identities: [identity],
          firstSeen: seenAt,
          lastSeen: seenAt,
          commitCount: 0,
        };
        byEmail.set(key, row);
      } else if (
        !row.identities.some(
          (seen) => seen.name === identity.name && seen.email === identity.email,
        )
      ) {
        row.identities.push(identity);
      }

      if (compareTimestamps(seenAt, row.firstSeen) < 0) row.firstSeen = seenAt;
      if (compareTimestamps(seenAt, row.lastSeen) > 0) row.lastSeen = seenAt;
      if (role === 'author') row.commitCount += 1;
      return row.id;
    },

    drain() {
      const rows = [...dirty]
        .map((key) => byEmail.get(key))
        .filter((row): row is Row => row !== undefined);
      dirty.clear();
      return rows.map((row) => ({
        id: row.id,
        canonicalName: row.canonicalName,
        canonicalEmail: row.canonicalEmail,
        // Copied, not shared: the row keeps accumulating identities after this Person
        // has been handed to a transaction, and a caller holding a snapshot that
        // mutates later is a debugging nightmare for the price of one array.
        identities: [...row.identities],
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        commitCount: row.commitCount,
        // Recorded as `exact-email` because the merge key *is* the email. Claiming
        // `normalized-email` would advertise a normalization step that did not run,
        // and the whole purpose of `mergeSource` is to let a user check the merge.
        mergeSource: 'exact-email' as const,
        // No bot detection at all, so nothing is ever flagged. `isBot: false` on
        // `github-actions[bot]` is a lie the UI would repeat, which is the second
        // reason M0 shows no contributor list.
        isBot: false,
      }));
    },
  };
}

/* ── File identity ─────────────────────────────────────────────────────────── */

/**
 * One `FileId` per distinct path string.
 *
 * Deliberately *not* a `RenameResolver`, for a stronger reason than the identity
 * table: `RenameResolver`'s contract carries the two invariants every downstream
 * query depends on (Part 8 §8.8 — aliases of a `FileId` never overlap in
 * commit-time, and every `(commit, path)` resolves to exactly one `FileId`). This
 * table upholds the second and destroys the first, because it has no notion of a
 * chain at all.
 *
 * The visible consequence: `src/old.ts` renamed to `src/new.ts` becomes two files
 * with no link between them, so the older half of the history disappears from File
 * Evolution, from churn, and from ownership. `git log --find-renames` already told
 * us the truth and we are throwing it away — the raw rename *is* preserved on the
 * `Change` row's `oldPath`/`newPath`, but nothing stitches the two `FileId`s
 * together. That is `createRenameResolver`'s job, it is the project's top
 * existential risk (risk R1), and it gets the whole of M1 with a twelve-case
 * fixture matrix.
 */
export interface M0FileTable {
  /**
   * The `FileId` a change belongs to, or `null` when the change names no path at
   * all — which `git` will not produce, but the `RawChange` type permits.
   */
  observe(change: RawChange, commit: CommitId): FileId | null;
  /**
   * The rows touched since the last drain, for the reason `M0PeopleTable.drain` gives:
   * `changes.file_id REFERENCES files(id)` is not deferrable either, so a file row has
   * to be written in the same transaction as the change rows that point at it.
   *
   * A rename dirties *two* rows — the vacated path's row learns that it died — and
   * forgetting the second one is exactly how a dirty-set optimisation loses a write.
   *
   * `internPath` is injected rather than resolved internally because a `PathId` only
   * exists inside a `Transaction`, and this must be callable from a flush without the
   * table knowing what a store is.
   */
  drain(internPath: (path: string) => PathId): readonly FileEntity[];
}

export function createM0FileTable(): M0FileTable {
  interface Row {
    readonly id: FileId;
    readonly path: string;
    readonly born: CommitId;
    died: CommitId | null;
  }

  const byPath = new Map<string, Row>();
  /** Paths whose row has changed since the last drain. */
  const dirty = new Set<string>();

  return {
    observe(change, commit) {
      // A rename does at least kill the vacated path, so `currentPath` is right at
      // HEAD. It buys honesty about *existence* and nothing about *lineage*: the
      // two halves of the file's life remain two unrelated files.
      if (change.kind === 'rename' && change.oldPath !== null) {
        const vacated = byPath.get(change.oldPath);
        if (vacated !== undefined) {
          vacated.died = commit;
          dirty.add(change.oldPath);
        }
      }

      const path = change.newPath ?? change.oldPath;
      if (path === null) return null;
      dirty.add(path);

      let row = byPath.get(path);
      if (row === undefined) {
        row = { id: fileId(byPath.size + 1), path, born: commit, died: null };
        byPath.set(path, row);
      }
      // A delete followed by a re-add reuses the row, so resurrection happens to
      // come out right — for the wrong reason. M1's version is deliberate about it.
      row.died = change.kind === 'delete' ? commit : null;
      return row.id;
    },

    drain(internPath) {
      const rows = [...dirty]
        .map((path) => byPath.get(path))
        .filter((row): row is Row => row !== undefined);
      dirty.clear();
      return rows.map((row) => ({
        id: row.id,
        currentPath: row.died === null ? internPath(row.path) : null,
        // Exactly one alias, spanning the row's whole life. A real file has one per
        // path it has ever lived at, and the M1 property test asserts they do not
        // overlap; a single alias passes that test trivially and vacuously.
        aliases: [{ path: internPath(row.path), from: row.born, to: row.died }],
        born: row.born,
        died: row.died,
        // Language detection ships with the language packs; extension sniffing here
        // would be a second, divergent implementation of that mapping.
        language: null,
        // `generated` / `vendored` / `test` / `binary` are the noise classifier's,
        // and `binary` is knowable from `RawChange.isBinary` today. Left empty on
        // purpose: a half-populated flag set is harder to reason about than none.
        flags: [],
      }));
    },
  };
}

/* ── Commit shape ──────────────────────────────────────────────────────────── */

/**
 * Every commit scores zero, so nothing can be ranked by significance and no view
 * that ranks commits can ship. That is the intended blocker, not an oversight: the
 * scorer's four factors need hunks and noise flags, neither of which exists yet, and
 * the anti-embarrassment test (ROADMAP M1) is what makes a score publishable.
 */
export const M0_SIGNIFICANCE = 0;

/**
 * The three flags that are *observations* rather than judgements.
 *
 * `merge` is here for a specific reason: under the `first-parent` projection the
 * second parent never reaches the store, so `parents.length > 1` stops being a merge
 * test the moment the row is written. The raw parent list is the last place the fact
 * is visible, and `CommitSummaryDto.isMerge` needs it in M0's commit list.
 *
 * Every *penalty* flag — `format-only`, `generated-only`, `vendored-only`,
 * `lockfile-only`, `bulk-mechanical` — belongs to `createNoiseClassifier` and is
 * absent here, along with `revert` / `reland` (M2 detection) and `signed` (not
 * carried on `RawCommit`). Absent penalty flags are exactly why nothing in M0 may
 * rank commits: without them, "the most significant commits in this repo" reliably
 * returns the Prettier migration and a lockfile refresh (Part 8 §8.5.1).
 */
export function m0CommitFlags(commit: RawCommit): readonly CommitFlag[] {
  const flags: CommitFlag[] = [];
  if (commit.parents.length === 0) flags.push('root');
  if (commit.parents.length > 1) flags.push('merge');
  if (commit.changes.length === 0) flags.push('empty');
  return flags;
}

/**
 * First line is the subject; everything past the first blank line is the body.
 *
 * Two things are wrong with that. Git's own `%s` collapses the entire first
 * *paragraph* into the subject, so a wrapped subject line loses its tail into the
 * body here. And trailers are left inside the body rather than parsed out, which
 * means `Commit.trailers` is empty for every commit — so `Co-authored-by` does not
 * reach ownership and `PR-URL:` / `Fixes:` / `Change-Id:` do not reach evidence.
 * Both are M1's, and this is the one function in this file M1 must *replace* rather
 * than simply delete.
 */
export function splitCommitMessage(message: string): {
  readonly subject: string;
  readonly body: string | null;
} {
  const normalized = message.replace(/\r\n/g, '\n').trim();
  const firstBreak = normalized.indexOf('\n');
  if (firstBreak === -1) return { subject: normalized, body: null };

  const subject = normalized.slice(0, firstBreak).trim();
  const body = normalized.slice(firstBreak + 1).trim();
  return { subject, body: body.length === 0 ? null : body };
}
