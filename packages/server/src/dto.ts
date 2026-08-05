/**
 * Store rows → wire DTOs.
 *
 * **This file exists because of boundary rule B4: the UI computes nothing analytical.**
 * Every number a client displays is denormalised here, server-side, so the browser, the
 * CLI, and later `excavate mcp` cannot disagree about the same repository. A UI that
 * sums `insertions` itself is one refactor away from disagreeing with `excavate stats`,
 * and that is the one inconsistency users never forgive.
 */

import type {
  Commit,
  CommitDetailDto,
  CommitId,
  CommitSummaryDto,
  Oid,
  PersonId,
} from '@excavate/core';
import { ExcavateError } from '@excavate/core';
import type { Store } from '@excavate/store';

/** Shown when a commit's author cannot be resolved, which should only happen on a partial index. */
const UNKNOWN_PERSON = 'unknown';

export function toCommitSummary(store: Store, commit: Commit): CommitSummaryDto {
  const changes = store.commits.changesIn(commit.id);
  let insertions = 0;
  let deletions = 0;
  for (const change of changes) {
    insertions += change.insertions;
    deletions += change.deletions;
  }

  return {
    oid: commit.oid,
    subject: commit.subject,
    authorName: personName(store, commit.author),
    authoredAt: commit.authoredAt,
    insertions,
    deletions,
    filesChanged: changes.length,
    significance: commit.significance,
    // The flag is authoritative — it is what the walk recorded — but parent count is a
    // free cross-check for a store row written before flags existed.
    isMerge: commit.flags.includes('merge') || commit.parents.length > 1,
  };
}

export function toCommitDetail(store: Store, commit: Commit): CommitDetailDto {
  return {
    ...toCommitSummary(store, commit),
    body: commit.body,
    parents: commit.parents.map((parent) => parentOid(store, commit, parent)),
    committedAt: commit.committedAt,
    committerName: personName(store, commit.committer),
  };
}

/**
 * Resolve a stored parent edge to an object id, or refuse.
 *
 * **An unresolvable parent is not filtered out**, which is what an earlier draft did.
 * `Commit.parents` holds only the parents the walk actually saw — `@excavate/index` drops
 * the excluded side of a merge itself, so a projection artifact never reaches here — and
 * `commit_parents.parent_id` is a foreign key into `commits`. An id in that list with no
 * row behind it therefore means the index is damaged, and quietly serving a commit with
 * one parent where the store recorded two would misstate ancestry: the shape every
 * downstream lineage answer is built on. `INDEX_CORRUPT` is the code that offers a
 * rebuild (Part 7 §7.7), which is the only real remedy.
 */
function parentOid(store: Store, commit: Commit, parent: CommitId): Oid {
  const row = store.commits.byId(parent);
  if (row === null) {
    throw new ExcavateError(
      'INDEX_CORRUPT',
      `commit ${commit.oid} records a parent this index does not contain`,
      { details: { commit: commit.oid, parent } },
    );
  }
  return row.oid;
}

function personName(store: Store, person: PersonId): string {
  return store.people.byId(person)?.canonicalName ?? UNKNOWN_PERSON;
}
