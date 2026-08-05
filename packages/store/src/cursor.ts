/**
 * Pagination cursors.
 *
 * Keyset, not offset. `LIMIT 100 OFFSET 40000` makes SQLite walk and discard 40,000
 * rows, and it duplicates or skips rows whenever a write lands between two pages —
 * which, during a live index, is every page. A keyset cursor is a `WHERE` clause
 * against the same `(committed_at DESC, id DESC)` index the first page used, so page
 * 400 costs exactly what page 1 costs.
 *
 * The cursor is **opaque** because `CommitListQuery.cursor` in `@excavate/core` says so
 * (Part 7's API contract: "pagination is designed in from the first route rather than
 * retrofitted"). Opaque is a contract, not encryption: it means a client must not parse
 * or synthesise one, so the sort key can change in v2 without breaking any caller. It
 * carries a version tag for exactly that reason — a cursor minted by an older build is
 * rejected with a clear error instead of being misread as a different sort key.
 */

import { Buffer } from 'node:buffer';

import { ExcavateError } from '@excavate/core';

/** Bumped whenever the encoded key changes shape. `c1` = `(committed_at, id)`. */
const CURSOR_VERSION = 'c1';

/**
 * Decimal digits, optionally negative. Deliberately stricter than `Number.isSafeInteger`
 * on the parsed result, because `Number()` accepts things this cursor never mints and
 * turns some of them into *plausible* keys rather than rejecting them:
 *
 * - `Number('')` is `0`, so the payload `c1::` would decode to `(0, 0)` — a valid-looking
 *   cursor positioned before the beginning of history, which returns an empty page with
 *   `nextCursor: null`. The caller cannot tell that from "you have reached the end", and
 *   a truncated history that reports itself complete is the exact failure mode this
 *   project cannot afford.
 * - `Number('0x1f')`, `Number('1e3')` and `Number(' 42 ')` are all safe integers too, so
 *   a mangled cursor would silently page from somewhere the store never pointed at.
 *
 * Git timestamps can legitimately be negative (a commit dated before 1970), hence the
 * optional sign rather than digits alone.
 */
const DECIMAL_INTEGER = /^-?\d+$/;

/** The last row of the previous page: the sort key, plus the id that breaks its ties. */
export interface CommitCursor {
  readonly committedAt: number;
  readonly id: number;
}

export function encodeCommitCursor(cursor: CommitCursor): string {
  const payload = `${CURSOR_VERSION}:${cursor.committedAt}:${cursor.id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCommitCursor(raw: string): CommitCursor {
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split(':');
  const [version, committedAt, id] = parts;
  if (parts.length !== 3 || version !== CURSOR_VERSION) {
    throw invalidCursor(raw, 'unrecognised cursor format');
  }
  if (
    committedAt === undefined ||
    id === undefined ||
    !DECIMAL_INTEGER.test(committedAt) ||
    !DECIMAL_INTEGER.test(id)
  ) {
    throw invalidCursor(raw, 'cursor key is not an integer pair');
  }
  const at = Number(committedAt);
  const rowId = Number(id);
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(rowId)) {
    throw invalidCursor(raw, 'cursor key is outside the safe integer range');
  }
  return { committedAt: at, id: rowId };
}

/**
 * `INVALID_TARGET` rather than `NOT_FOUND`: a bad cursor is a malformed request, and
 * the daemon maps it to a 400 so a client bug does not read as an empty result set.
 * The raw cursor is echoed back because it is client-supplied and contains no
 * repository content — `ExcavateErrorOptions.details` must never carry either.
 */
function invalidCursor(raw: string, reason: string): ExcavateError {
  return new ExcavateError('INVALID_TARGET', `invalid page cursor: ${reason}`, {
    details: { cursor: raw },
  });
}
