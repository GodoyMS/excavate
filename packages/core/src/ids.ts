/**
 * Identifiers.
 *
 * Two families, for the reason given in Part 8 §8.2.1: dense `number` keys for
 * everything stored in bulk (a 31k-commit repo has ~5× that many change rows, so
 * 4-byte keys instead of 40-char hashes is a large win in index size and join
 * speed), and branded `string` keys for content hashes and stable public IDs.
 *
 * Every ID is nominally typed, so passing a `FileId` where a `CommitId` belongs is
 * a compile error rather than a silently wrong query.
 */

declare const brand: unique symbol;

/** Nominal typing helper. Erased at runtime — a `CommitId` *is* a `number`. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/* ── Dense numeric IDs ─────────────────────────────────────────────────────── */

export type CommitId = Brand<number, 'CommitId'>;
export type FileId = Brand<number, 'FileId'>;
export type PathId = Brand<number, 'PathId'>;
export type PersonId = Brand<number, 'PersonId'>;
export type TagId = Brand<number, 'TagId'>;
export type ReleaseId = Brand<number, 'ReleaseId'>;
export type EraId = Brand<number, 'EraId'>;

export const commitId = (value: number): CommitId => value as CommitId;
export const fileId = (value: number): FileId => value as FileId;
export const pathId = (value: number): PathId => value as PathId;
export const personId = (value: number): PersonId => value as PersonId;
export const tagId = (value: number): TagId => value as TagId;
export const releaseId = (value: number): ReleaseId => value as ReleaseId;
export const eraId = (value: number): EraId => value as EraId;

/* ── Branded string IDs ────────────────────────────────────────────────────── */

/**
 * A stable identifier for an indexed repository: `hash(root_commit_oid +
 * canonical_path)`, per Part 7 §7.5. Using the root commit means a repository
 * moved on disk reuses its index; including the path means two worktrees of the
 * same project do not collide.
 */
export type RepoId = Brand<string, 'RepoId'>;

/** Stable within a bundle: `E1`…`En`. See Part 8 §8.4.1. */
export type EvidenceId = Brand<string, 'EvidenceId'>;

/** Content hash of an evidence bundle — the caching and reproducibility key. */
export type BundleHash = Brand<string, 'BundleHash'>;

export type AnalyzerId = Brand<string, 'AnalyzerId'>;
export type CollectorId = Brand<string, 'CollectorId'>;

export const repoId = (value: string): RepoId => value as RepoId;
export const bundleHash = (value: string): BundleHash => value as BundleHash;
export const analyzerId = (value: string): AnalyzerId => value as AnalyzerId;
export const collectorId = (value: string): CollectorId => value as CollectorId;

/** Build the `E<n>` ID for the nth (1-based) item in a bundle. */
export function evidenceId(ordinal: number): EvidenceId {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`evidence ordinal must be a positive integer, got ${ordinal}`);
  }
  return `E${ordinal}` as EvidenceId;
}

/* ── Object IDs ────────────────────────────────────────────────────────────── */

/** A Git object hash: 40 hex chars (SHA-1) or 64 (SHA-256). */
export type Oid = Brand<string, 'Oid'>;

const FULL_OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const ABBREVIATED_OID = /^[0-9a-f]{4,63}$/;

export function isOid(value: string): boolean {
  return FULL_OID.test(value);
}

/** Parse a full object ID, rejecting abbreviations and uppercase. */
export function parseOid(value: string): Oid {
  if (!isOid(value)) {
    throw new TypeError(`not a full object id: ${JSON.stringify(value)}`);
  }
  return value as Oid;
}

/**
 * An abbreviated OID as it appears in a commit message or a UI reference. Kept
 * distinct from `Oid` because an abbreviation is ambiguous: resolving one requires
 * the repository, so it must never be used as a key.
 */
export type AbbreviatedOid = Brand<string, 'AbbreviatedOid'>;

export function parseAbbreviatedOid(value: string): AbbreviatedOid {
  if (!ABBREVIATED_OID.test(value)) {
    throw new TypeError(`not an abbreviated object id: ${JSON.stringify(value)}`);
  }
  return value as AbbreviatedOid;
}

/** Display form. Seven characters is Git's own default. */
export function shortOid(oid: Oid, length = 7): string {
  return oid.slice(0, length);
}
