/**
 * The row↔entity boundary.
 *
 * Every conversion between a SQLite row and a `@wise-excavate/core` entity happens here and
 * nowhere else, for the same reason boundary rule B2 exists at all: an encoding that
 * is applied in four places will eventually be applied differently in one of them.
 *
 * **The integer codes below are part of the on-disk format.** Appending a value is a
 * compatible change. Renumbering one silently reinterprets every existing row, which
 * no migration can detect and no integrity check can catch — so don't. Each table is
 * written as `satisfies Record<Union, number>` so that adding a member to the union in
 * `@wise-excavate/core` is a compile error here rather than a runtime `undefined`.
 */

import type {
  Change,
  ChangeKind,
  Commit,
  CommitFlag,
  FileEntity,
  FileFlag,
  MergeSource,
  Oid,
  PathAlias,
  Person,
  Trailer,
} from '@wise-excavate/core';
import {
  ExcavateError,
  commitId,
  fileId,
  pathId,
  personId,
  timestamp,
} from '@wise-excavate/core';

/* ── Flag bitmasks ─────────────────────────────────────────────────────────── */

/**
 * Order is the bit order and is frozen. The penalty flags (`format-only` onwards) are
 * the mechanism by which noise stays out of significance ranking (Part 8 §8.2.1), so
 * they are stored on the commit rather than recomputed per query.
 */
const COMMIT_FLAG_BITS = {
  merge: 1 << 0,
  root: 1 << 1,
  revert: 1 << 2,
  reland: 1 << 3,
  empty: 1 << 4,
  signed: 1 << 5,
  'format-only': 1 << 6,
  'generated-only': 1 << 7,
  'vendored-only': 1 << 8,
  'lockfile-only': 1 << 9,
  'bulk-mechanical': 1 << 10,
} satisfies Record<CommitFlag, number>;

const FILE_FLAG_BITS = {
  generated: 1 << 0,
  vendored: 1 << 1,
  test: 1 << 2,
  binary: 1 << 3,
} satisfies Record<FileFlag, number>;

/**
 * Decoding walks the declaration order, so a decoded flag array is always in the same
 * order for the same mask. Part 8 §8.8 invariant 13 (re-indexing produces
 * byte-identical derived tables) depends on details exactly this small.
 */
const COMMIT_FLAG_ENTRIES = Object.entries(COMMIT_FLAG_BITS) as readonly [
  CommitFlag,
  number,
][];
const FILE_FLAG_ENTRIES = Object.entries(FILE_FLAG_BITS) as readonly [FileFlag, number][];

export function encodeCommitFlags(flags: readonly CommitFlag[]): number {
  let mask = 0;
  for (const flag of flags) mask |= COMMIT_FLAG_BITS[flag];
  return mask;
}

export function decodeCommitFlags(mask: number): readonly CommitFlag[] {
  const flags: CommitFlag[] = [];
  for (const [flag, bit] of COMMIT_FLAG_ENTRIES) {
    if ((mask & bit) !== 0) flags.push(flag);
  }
  return flags;
}

export function encodeFileFlags(flags: readonly FileFlag[]): number {
  let mask = 0;
  for (const flag of flags) mask |= FILE_FLAG_BITS[flag];
  return mask;
}

export function decodeFileFlags(mask: number): readonly FileFlag[] {
  const flags: FileFlag[] = [];
  for (const [flag, bit] of FILE_FLAG_ENTRIES) {
    if ((mask & bit) !== 0) flags.push(flag);
  }
  return flags;
}

/* ── Enumerated codes ──────────────────────────────────────────────────────── */

/** Numbered from 1 so that a zero — a coerced NULL, an uninitialised field — is never a valid kind. */
const CHANGE_KIND_CODES = {
  add: 1,
  modify: 2,
  delete: 3,
  rename: 4,
  copy: 5,
  mode: 6,
} satisfies Record<ChangeKind, number>;

const CHANGE_KIND_BY_CODE = new Map<number, ChangeKind>(
  (Object.entries(CHANGE_KIND_CODES) as readonly [ChangeKind, number][]).map(
    ([kind, code]) => [code, kind],
  ),
);

export function encodeChangeKind(kind: ChangeKind): number {
  return CHANGE_KIND_CODES[kind];
}

export function decodeChangeKind(code: number): ChangeKind {
  const kind = CHANGE_KIND_BY_CODE.get(code);
  if (kind === undefined) {
    throw corrupt(`unknown change kind code ${code}`, { code });
  }
  return kind;
}

/**
 * Stored as text (see `0001-init.ts` on encoding policy), so it needs validating on
 * the way back in. Recorded at all because Part 8 §8.3.1 requires the UI to be able to
 * explain a merge — a heuristic merge presented as fact is how an ownership model
 * loses trust.
 */
const MERGE_SOURCES = {
  mailmap: true,
  'exact-email': true,
  'normalized-email': true,
  'name-and-domain': true,
  heuristic: true,
} satisfies Record<MergeSource, true>;

export function decodeMergeSource(value: string): MergeSource {
  if (!Object.hasOwn(MERGE_SOURCES, value)) {
    throw corrupt(`unknown merge source ${JSON.stringify(value)}`, { value });
  }
  return value as MergeSource;
}

/* ── Trailers ──────────────────────────────────────────────────────────────── */

export function encodeTrailers(trailers: readonly Trailer[]): string {
  return JSON.stringify(trailers.map(({ key, value }) => ({ key, value })));
}

export function decodeTrailers(json: string): readonly Trailer[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw corrupt('commits.trailers is not a JSON array');
  }
  const trailers: Trailer[] = [];
  for (const entry of parsed as readonly unknown[]) {
    const record = entry as Record<string, unknown> | null;
    const key = record?.['key'];
    const value = record?.['value'];
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw corrupt('commits.trailers holds an entry that is not {key, value}');
    }
    trailers.push({ key, value });
  }
  return trailers;
}

/* ── Row shapes ────────────────────────────────────────────────────────────── */

export interface CommitRow {
  readonly id: number;
  readonly oid: string;
  readonly tree_oid: string;
  readonly author_id: number;
  readonly committer_id: number;
  readonly authored_at: number;
  readonly authored_tz: number;
  readonly committed_at: number;
  readonly committed_tz: number;
  readonly subject: string;
  readonly body: string | null;
  readonly trailers: string;
  readonly generation: number;
  readonly flags: number;
  readonly significance: number;
}

export interface ChangeRow {
  readonly commit_id: number;
  readonly file_id: number;
  readonly kind: number;
  readonly old_path_id: number | null;
  readonly new_path_id: number | null;
  readonly similarity: number | null;
  readonly insertions: number;
  readonly deletions: number;
  readonly is_binary: number;
}

export interface FileRow {
  readonly id: number;
  readonly current_path: number | null;
  readonly born_commit: number;
  readonly died_commit: number | null;
  readonly language: string | null;
  readonly flags: number;
}

export interface FileAliasRow {
  readonly file_id: number;
  readonly path_id: number;
  readonly from_commit: number;
  readonly to_commit: number | null;
}

export interface PersonRow {
  readonly id: number;
  readonly canonical_name: string;
  readonly canonical_email: string;
  readonly first_seen: number;
  readonly first_seen_tz: number;
  readonly last_seen: number;
  readonly last_seen_tz: number;
  readonly commit_count: number;
  readonly merge_source: string;
  readonly is_bot: number;
}

export interface IdentityRow {
  readonly person_id: number;
  readonly name: string;
  readonly email: string;
}

/* ── Row → entity ──────────────────────────────────────────────────────────── */

export const bit = (value: boolean): number => (value ? 1 : 0);
const unbit = (value: number): boolean => value !== 0;

export function toCommit(row: CommitRow, parents: readonly number[]): Commit {
  return {
    id: commitId(row.id),
    oid: row.oid as Oid,
    tree: row.tree_oid as Oid,
    parents: parents.map(commitId),
    author: personId(row.author_id),
    committer: personId(row.committer_id),
    authoredAt: timestamp(row.authored_at, row.authored_tz),
    committedAt: timestamp(row.committed_at, row.committed_tz),
    subject: row.subject,
    body: row.body,
    trailers: decodeTrailers(row.trailers),
    generation: row.generation,
    flags: decodeCommitFlags(row.flags),
    significance: row.significance,
  };
}

export function toChange(row: ChangeRow): Change {
  return {
    commit: commitId(row.commit_id),
    file: fileId(row.file_id),
    kind: decodeChangeKind(row.kind),
    oldPath: row.old_path_id === null ? null : pathId(row.old_path_id),
    newPath: row.new_path_id === null ? null : pathId(row.new_path_id),
    similarity: row.similarity,
    insertions: row.insertions,
    deletions: row.deletions,
    isBinary: unbit(row.is_binary),
  };
}

export function toFileEntity(row: FileRow, aliases: readonly FileAliasRow[]): FileEntity {
  return {
    id: fileId(row.id),
    currentPath: row.current_path === null ? null : pathId(row.current_path),
    aliases: aliases.map(toPathAlias),
    born: commitId(row.born_commit),
    died: row.died_commit === null ? null : commitId(row.died_commit),
    language: row.language,
    flags: decodeFileFlags(row.flags),
  };
}

export function toPathAlias(row: FileAliasRow): PathAlias {
  return {
    path: pathId(row.path_id),
    from: commitId(row.from_commit),
    to: row.to_commit === null ? null : commitId(row.to_commit),
  };
}

export function toPerson(row: PersonRow, identities: readonly IdentityRow[]): Person {
  return {
    id: personId(row.id),
    canonicalName: row.canonical_name,
    canonicalEmail: row.canonical_email,
    identities: identities.map(({ name, email }) => ({ name, email })),
    firstSeen: timestamp(row.first_seen, row.first_seen_tz),
    lastSeen: timestamp(row.last_seen, row.last_seen_tz),
    commitCount: row.commit_count,
    mergeSource: decodeMergeSource(row.merge_source),
    isBot: unbit(row.is_bot),
  };
}

/* ── Entity → bind parameters ──────────────────────────────────────────────── */

/**
 * Named rather than positional bind parameters on the wide inserts. A fifteen-column
 * positional list is one careless SQL edit away from writing `authored_at` into
 * `committed_at`, and both are integers so nothing would complain. The per-row cost is
 * a hash lookup per parameter, against a measured 2.2M inserts/sec — the walk needs
 * ~100k/s (LEAN-V1 §5.1), so this is not the budget to defend.
 */
export interface CommitBind {
  readonly id: number;
  readonly oid: string;
  readonly treeOid: string;
  readonly authorId: number;
  readonly committerId: number;
  readonly authoredAt: number;
  readonly authoredTz: number;
  readonly committedAt: number;
  readonly committedTz: number;
  readonly subject: string;
  readonly body: string | null;
  readonly trailers: string;
  readonly generation: number;
  readonly flags: number;
  readonly significance: number;
}

export function commitBind(commit: Commit): CommitBind {
  return {
    id: commit.id,
    oid: commit.oid,
    treeOid: commit.tree,
    authorId: commit.author,
    committerId: commit.committer,
    authoredAt: commit.authoredAt.epochSeconds,
    authoredTz: commit.authoredAt.offsetMinutes,
    committedAt: commit.committedAt.epochSeconds,
    committedTz: commit.committedAt.offsetMinutes,
    subject: commit.subject,
    body: commit.body,
    trailers: encodeTrailers(commit.trailers),
    generation: commit.generation,
    flags: encodeCommitFlags(commit.flags),
    significance: commit.significance,
  };
}

export interface ChangeBind {
  readonly commitId: number;
  readonly fileId: number;
  readonly kind: number;
  readonly oldPathId: number | null;
  readonly newPathId: number | null;
  readonly similarity: number | null;
  readonly insertions: number;
  readonly deletions: number;
  readonly isBinary: number;
}

export function changeBind(change: Change): ChangeBind {
  return {
    commitId: change.commit,
    fileId: change.file,
    kind: encodeChangeKind(change.kind),
    oldPathId: change.oldPath,
    newPathId: change.newPath,
    similarity: change.similarity,
    insertions: change.insertions,
    deletions: change.deletions,
    isBinary: bit(change.isBinary),
  };
}

export interface PersonBind {
  readonly id: number;
  readonly canonicalName: string;
  readonly canonicalEmail: string;
  readonly firstSeen: number;
  readonly firstSeenTz: number;
  readonly lastSeen: number;
  readonly lastSeenTz: number;
  readonly commitCount: number;
  readonly mergeSource: string;
  readonly isBot: number;
}

export function personBind(person: Person): PersonBind {
  return {
    id: person.id,
    canonicalName: person.canonicalName,
    canonicalEmail: person.canonicalEmail,
    firstSeen: person.firstSeen.epochSeconds,
    firstSeenTz: person.firstSeen.offsetMinutes,
    lastSeen: person.lastSeen.epochSeconds,
    lastSeenTz: person.lastSeen.offsetMinutes,
    commitCount: person.commitCount,
    mergeSource: person.mergeSource,
    isBot: bit(person.isBot),
  };
}

export interface FileBind {
  readonly id: number;
  readonly currentPath: number | null;
  readonly bornCommit: number;
  readonly diedCommit: number | null;
  readonly language: string | null;
  readonly flags: number;
}

export function fileBind(file: FileEntity): FileBind {
  return {
    id: file.id,
    currentPath: file.currentPath,
    bornCommit: file.born,
    diedCommit: file.died,
    language: file.language,
    flags: encodeFileFlags(file.flags),
  };
}

/* ── Corruption ────────────────────────────────────────────────────────────── */

/**
 * A row that cannot be decoded is a corrupt index, not a bad request: Part 7 §7.7's
 * degraded path for `INDEX_CORRUPT` is a one-click rebuild, which is always available
 * because `.git` is the source of truth (Part 9 §9.10).
 */
export function corrupt(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ExcavateError {
  return new ExcavateError('INDEX_CORRUPT', message, { details });
}
