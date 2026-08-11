/**
 * The single streaming walk — "the one piece of genuinely careful engineering"
 * (LEAN-V1 §5.1).
 *
 * Everything downstream of the index reads from SQLite, so every fact the product
 * ever states about a repository enters through this file. Two properties are
 * therefore non-negotiable:
 *
 * **It streams.** A 50k-commit repository produces tens of megabytes of `git log`
 * output. The parser holds one record plus one chunk, never the history, so memory is
 * flat in the size of the repository and the first commit is available to the indexer
 * before git has finished walking.
 *
 * **It is framing-exact.** `-z` is what makes the stream unambiguous — paths are
 * emitted raw rather than C-quoted, so a path containing a newline, a quote, or a
 * non-UTF-8 byte cannot desynchronise the parse. The cost is that the numstat framing
 * changes shape (see `parseDiffSection`), and getting that wrong is the classic way
 * this parser is subtly and silently incorrect.
 */

import type {
  ChangeKind,
  HistoryProjection,
  Identity,
  Oid,
  Timestamp,
} from '@wise-excavate/core';
import { ExcavateError, isOid, parseOid, timestamp } from '@wise-excavate/core';

/**
 * Field and record separators for the log stream.
 *
 * `\x01` and `\x02` are used because no `git log` placeholder can emit them and no real
 * commit message contains them, so a record needs no escaping to be unambiguous. Note
 * the limit of that claim: git forbids only NUL in a commit message, so a message
 * carrying `\x01` *would* desynchronise the framing. It fails loudly when it happens —
 * the following text cannot parse as twelve header fields, so the walk raises
 * `GIT_FAILED` — rather than silently attributing half a commit to another.
 */
export const RECORD_SEPARATOR = '\x01';
export const FIELD_SEPARATOR = '\x02';

/**
 * The commit format for the single streaming walk (LEAN-V1 §5.1).
 *
 * **Deviation from LEAN-V1 §5.1, deliberate.** The spec's format string captures
 * `%at`/`%ct` — epoch seconds only — but Part 8 §8.2.1 requires the *original UTC
 * offset* to be preserved ("committed at 3am local" is occasionally meaningful
 * evidence). Epoch alone cannot reconstruct it. So each timestamp is emitted twice:
 * `%at` as the authoritative integer instant, and `%ai` purely to recover the
 * `+HHMM` offset. The cost is ~25 bytes per commit per timestamp on a stream that is
 * already megabytes; the alternative is a domain model that cannot honour its own
 * spec.
 *
 * `%B` — the raw body, which is multi-line — must stay last, which is what the
 * record separator is for.
 */
export const COMMIT_FORMAT = [
  '%H', // commit oid
  '%T', // tree oid
  '%P', // parent oids, space-separated
  '%an',
  '%ae',
  '%at', // author instant, epoch seconds
  '%ai', // author date with offset — offset only; see above
  '%cn',
  '%ce',
  '%ct',
  '%ci',
  '%B', // raw message; MUST be last
].join(FIELD_SEPARATOR);

/** Positions in a decoded header record. `%B` is last and absorbs any remainder. */
const FIELD_COUNT = 12;
const MESSAGE_FIELD = 11;

export interface WalkSpec {
  readonly projection: HistoryProjection;
  /**
   * Incremental walk: emit only commits not reachable from this tip. `null` walks
   * the whole history.
   */
  readonly since: Oid | null;
  readonly includeAllRefs: boolean;
  /** Rename similarity threshold, 0–100. Git's default of 50 is ours too. */
  readonly findRenames: number;
  readonly findCopies: boolean;
}

export const DEFAULT_WALK_SPEC: WalkSpec = {
  projection: 'first-parent',
  since: null,
  includeAllRefs: true,
  findRenames: 50,
  findCopies: true,
};

/** One commit as it comes off the wire — paths are still strings, identities unresolved. */
export interface RawCommit {
  readonly oid: Oid;
  readonly tree: Oid;
  readonly parents: readonly Oid[];
  readonly author: Identity;
  readonly authoredAt: Timestamp;
  readonly committer: Identity;
  readonly committedAt: Timestamp;
  /** Raw `%B`: subject, blank line, body, trailers. Splitting is the index's job. */
  readonly message: string;
  readonly changes: readonly RawChange[];
}

export interface RawChange {
  readonly kind: ChangeKind;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  /** 0–100, present for `rename` and `copy`. */
  readonly similarity: number | null;
  readonly insertions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
}

/**
 * Build the `git log` argument vector for a walk spec.
 *
 * **`--raw` is not in the LEAN-V1 §5.1 sketch and is required anyway.** `--numstat`
 * reports line counts and paths and nothing else: it cannot distinguish an added file
 * from an appended one, a delete from a truncation, or a rename from a copy, and it
 * carries no similarity score. `RawChange.kind` and `RawChange.similarity` are
 * therefore unobtainable without it. Asking for both formats in one pass costs one
 * extra line per changed file on the wire and keeps the promise that matters — that
 * the whole index is built from a *single* traversal.
 */
export function walkArgs(spec: WalkSpec): readonly string[] {
  const args = [
    'log',
    // The record separator leads the format so that every record — including the
    // first — is introduced the same way, which is what lets the parser resynchronise
    // rather than special-casing the head of the stream.
    `--format=${RECORD_SEPARATOR}${COMMIT_FORMAT}`,
    '--raw',
    '--numstat',
    '-z',
    // A user with `log.showSignature=true` configured would otherwise have gpg's
    // verification output interleaved between records — text that is not a commit, in a
    // stream whose framing has no way to describe it. It is the one ambient git config
    // that can inject bytes into this stream, so it is refused explicitly.
    '--no-show-signature',
    `--find-renames=${spec.findRenames}%`,
    '--reverse',
    /**
     * **Load-bearing, and not merely a preference.**
     *
     * `--reverse` on its own reverses git's *default* order, which is by commit date — and
     * commit date is not topological. A rebase, a cherry-pick, or plain clock skew on one
     * machine produces a commit whose parent carries a later date, and that commit is then
     * emitted before its own parent.
     *
     * Downstream assumes the opposite everywhere: `@wise-excavate/index` assigns dense
     * `CommitId`s in walk order and writes parent edges as it goes, so an inverted pair
     * makes `commit_parents.parent_id` reference a row that does not exist yet. That is not
     * a hypothetical — `rust-analyzer` contains exactly one such inversion out of 12,832
     * first-parent commits, and indexing it failed with `FOREIGN KEY constraint failed`
     * while `ripgrep` (2,255 commits, zero inversions) passed. One commit in twelve
     * thousand is precisely the density that survives every fixture and dies on a real
     * repository.
     *
     * Applied for every projection because emission order is an *index* concern —
     * referential integrity demands parents first — while presentation order is a query
     * concern. `--author-date-order` below still selects the author-date *tie-break* within
     * the topological constraint, which is what that projection actually wants.
     */
    '--topo-order',
  ];
  if (spec.findCopies) args.push('--find-copies');

  switch (spec.projection) {
    case 'first-parent':
      // v1 exercises this projection only (LEAN-V1 §3.1). It is also what makes
      // merges yield a diff at all: without it `--numstat` prints nothing for them.
      args.push('--first-parent');
      break;
    case 'topological':
      break;
    case 'author-date':
      args.push('--author-date-order');
      break;
  }

  if (spec.includeAllRefs) args.push('--all');
  // A revision range must come last: anything after it reads as a further revision.
  if (spec.since !== null) args.push(`${spec.since}..HEAD`);
  return args;
}

/**
 * Parse the log stream into commits.
 *
 * Incremental by construction: text accumulates until a record separator proves a
 * record is complete, and the buffer is compacted once per chunk so a record split
 * across a chunk boundary — or across a hundred of them — costs nothing more than the
 * record itself.
 */
export async function* parseLogStream(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<RawCommit, void, undefined> {
  // `{ stream: true }` is the whole reason this is a TextDecoder rather than
  // `Buffer.toString`: chunk boundaries land mid-character often enough on a
  // repository with non-ASCII authors or messages, and a replacement character in the
  // middle of a path would corrupt file identity rather than merely look wrong.
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  /** Where the current, possibly incomplete, record starts inside `buffer`. */
  let cursor = 0;
  /** False until the leading separator is seen; the text before it is not a record. */
  let started = false;

  for await (const chunk of stream) {
    // Every scan below ends in "no separator in the rest of the buffer", so resuming at
    // the new bytes rather than at the retained prefix keeps the total scanning linear in
    // the stream instead of quadratic in the largest record. Measured as a wash at 8k
    // files in one commit; it is the bound that matters, not the constant.
    const searchFrom = buffer.length;
    buffer += decoder.decode(chunk, { stream: true });
    let next = buffer.indexOf(RECORD_SEPARATOR, searchFrom);
    while (next >= 0) {
      if (started) yield parseRecord(buffer.slice(cursor, next));
      started = true;
      cursor = next + 1;
      next = buffer.indexOf(RECORD_SEPARATOR, cursor);
    }
    if (cursor > 0) {
      buffer = buffer.slice(cursor);
      cursor = 0;
    }
  }

  buffer += decoder.decode();
  const tail = buffer.slice(cursor);
  // The last record has no following separator, so end-of-stream is what completes it.
  if (started) {
    if (tail.length > 0) yield parseRecord(tail);
    return;
  }
  // Output that contains no record separator at all means the format never took effect —
  // a git that ignored `--format`, or a wrapper script standing in for it. An empty
  // stream is the legitimate "no commits" case; a non-empty one that yielded nothing
  // would otherwise be indistinguishable from it, and reporting a repository as having
  // no history is exactly the kind of confident wrong answer this package must not give.
  if (tail.length > 0) throw malformed('log stream: no record separator in', tail);
}

function malformed(what: string, sample: string): ExcavateError {
  return new ExcavateError(
    'GIT_FAILED',
    `git log produced a malformed ${what}: ${JSON.stringify(sample.slice(0, 120))}`,
    { details: { what } },
  );
}

function requireOid(value: string, what: string): Oid {
  if (!isOid(value)) throw malformed(what, value);
  return parseOid(value);
}

/**
 * One record: the header, a NUL, then the diff section git emits under `-z`.
 *
 * The NUL is unambiguous because a commit message is the only free-form field and
 * cannot contain one — that is the only byte git itself forbids.
 */
function parseRecord(record: string): RawCommit {
  const boundary = record.indexOf('\0');
  const header = boundary < 0 ? record : record.slice(0, boundary);
  const diff = boundary < 0 ? '' : record.slice(boundary + 1);

  const fields = header.split(FIELD_SEPARATOR);
  if (fields.length < FIELD_COUNT) throw malformed('commit record', header);

  const at = (index: number): string => fields[index] ?? '';
  // Rejoined rather than indexed: `\x02` is vanishingly unlikely in a commit message
  // but not actually forbidden, and a message that contained one would otherwise be
  // silently truncated at that byte.
  const message = fields.slice(MESSAGE_FIELD).join(FIELD_SEPARATOR);

  return {
    oid: requireOid(at(0), 'commit oid'),
    tree: requireOid(at(1), 'tree oid'),
    parents: parseParents(at(2)),
    author: { name: at(3), email: at(4) },
    authoredAt: parseTimestamp(at(5), at(6), 'author date'),
    committer: { name: at(7), email: at(8) },
    committedAt: parseTimestamp(at(9), at(10), 'committer date'),
    message: stripRecordNewline(message),
    changes: parseDiffSection(diff),
  };
}

function parseParents(field: string): readonly Oid[] {
  if (field === '') return [];
  return field.split(' ').map((parent) => requireOid(parent, 'parent oid'));
}

/**
 * `%B` carries the commit object's own terminating newline. Every consumer wants it
 * gone — the index splits a subject from a body, and a trailing blank line would show
 * up in rendered evidence — and git itself strips trailing blank lines when the commit
 * is created, so removing exactly one newline here loses nothing.
 */
function stripRecordNewline(message: string): string {
  if (message.endsWith('\r\n')) return message.slice(0, -2);
  if (message.endsWith('\n')) return message.slice(0, -1);
  return message;
}

/**
 * `%at` is authoritative for the instant; `%ai` exists only to recover the offset.
 *
 * A missing or unparseable offset degrades to UTC rather than failing the walk: the
 * offset is presentational (Part 8 §8.2.1 wants it for "committed at 3am local"
 * evidence), and losing a whole repository's history over a cosmetic field would be a
 * bad trade. A malformed *instant*, by contrast, is fatal — every ordering,
 * ownership-decay, and era computation is built on it.
 */
function parseTimestamp(epoch: string, dateWithOffset: string, what: string): Timestamp {
  const epochSeconds = Number(epoch);
  if (epoch === '' || !Number.isFinite(epochSeconds)) throw malformed(what, epoch);
  return timestamp(Math.trunc(epochSeconds), parseOffsetMinutes(dateWithOffset));
}

const OFFSET_PATTERN = /([+-])(\d{2})(\d{2})\s*$/;

function parseOffsetMinutes(dateWithOffset: string): number {
  const match = OFFSET_PATTERN.exec(dateWithOffset);
  if (match === null) return 0;
  const [, sign, hours, minutes] = match;
  const total = Number(hours) * 60 + Number(minutes);
  if (!Number.isInteger(total) || total > 24 * 60) return 0;
  return sign === '-' ? -total : total;
}

/* ── The diff section ──────────────────────────────────────────────────────── */

/** A `--raw` entry: authoritative for what happened to the file. */
interface StatusEntry {
  readonly kind: ChangeKind;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly similarity: number | null;
  readonly modeChanged: boolean;
}

/** A `--numstat` entry: authoritative for how much changed. */
interface CountEntry {
  /** The path the counts belong to — the *new* path for a rename or copy. */
  readonly path: string;
  readonly oldPath: string | null;
  readonly insertions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
}

/**
 * Parse everything git emitted after the commit header.
 *
 * Under `-z` this is a flat run of NUL-terminated tokens: every `--raw` entry first,
 * then every `--numstat` entry, in the same file order. Both blocks are absent for a
 * merge commit walked without `--first-parent`, which is *not* an error — git simply
 * has no single diff to show — and the record framing means the next commit's changes
 * cannot be mistaken for this one's.
 */
function parseDiffSection(section: string): readonly RawChange[] {
  // git separates the header's NUL terminator from the diff block with one newline.
  const body = section.startsWith('\n') ? section.slice(1) : section;
  if (body === '') return [];

  const tokens = body.split('\0');
  // Every token is NUL-*terminated*, so the split leaves a trailing empty string.
  if (tokens.at(-1) === '') tokens.pop();

  const statuses: StatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || !token.startsWith(':')) break;
    index += 1;
    const status = parseStatus(token);
    const paths = status.letter === 'R' || status.letter === 'C' ? 2 : 1;
    const first = tokens[index];
    const second = paths === 2 ? tokens[index + 1] : undefined;
    index += paths;
    if (first === undefined || (paths === 2 && second === undefined)) {
      throw malformed('raw diff entry', token);
    }
    statuses.push(toStatusEntry(status, first, second));
  }

  const counts: CountEntry[] = [];
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    index += 1;
    const parsed = parseCounts(token);
    if (parsed.renamedFrom) {
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];
      index += 2;
      if (oldPath === undefined || newPath === undefined) {
        throw malformed('numstat entry', token);
      }
      counts.push({ ...parsed.entry, path: newPath, oldPath });
    } else {
      counts.push(parsed.entry);
    }
  }

  return combine(statuses, counts);
}

interface ParsedStatus {
  readonly letter: string;
  readonly similarity: number | null;
  readonly modeChanged: boolean;
}

/**
 * `:<oldmode> <newmode> <oldsha> <newsha> <status>` — the status letter carries the
 * similarity score for `R` and `C` (`R100` for an exact rename).
 */
function parseStatus(token: string): ParsedStatus {
  const parts = token.replace(/^:+/, '').split(' ');
  const status = parts.at(-1) ?? '';
  const score = status.slice(1);
  return {
    letter: status.slice(0, 1),
    similarity: score === '' ? null : Number.parseInt(score, 10),
    modeChanged: parts.length >= 2 && parts[0] !== parts[1],
  };
}

function toStatusEntry(
  status: ParsedStatus,
  first: string,
  second: string | undefined,
): StatusEntry {
  const kind = kindOf(status.letter);
  const oldPath = kind === 'add' ? null : first;
  const newPath = second ?? (kind === 'delete' ? null : first);
  return {
    kind,
    oldPath,
    newPath,
    similarity: kind === 'rename' || kind === 'copy' ? status.similarity : null,
    modeChanged: status.modeChanged,
  };
}

/**
 * `T` (typechange, e.g. a file replaced by a symlink) maps to `mode` because the mode
 * is precisely what changed. `U` (unmerged) and `X` (unknown) cannot appear in a `git
 * log` diff and degrade to `modify` rather than throwing, since a commit we cannot
 * classify is still a commit worth indexing.
 */
function kindOf(letter: string): ChangeKind {
  switch (letter) {
    case 'A':
      return 'add';
    case 'D':
      return 'delete';
    case 'R':
      return 'rename';
    case 'C':
      return 'copy';
    case 'T':
      return 'mode';
    default:
      return 'modify';
  }
}

/**
 * `insertions\tdeletions\tpath` — except that under `-z` a rename or copy emits
 * `insertions\tdeletions\t` with an *empty* path, followed by two further tokens
 * holding the old and new paths. That asymmetry is the single most common place this
 * parser goes wrong, so the empty path is the explicit signal for it.
 */
function parseCounts(token: string): { entry: CountEntry; renamedFrom: boolean } {
  const firstTab = token.indexOf('\t');
  const secondTab = firstTab < 0 ? -1 : token.indexOf('\t', firstTab + 1);
  if (firstTab < 0 || secondTab < 0) throw malformed('numstat entry', token);

  const insertions = token.slice(0, firstTab);
  const deletions = token.slice(firstTab + 1, secondTab);
  const path = token.slice(secondTab + 1);
  // Binary files report `-` for both counts. Zeroing them keeps the numbers additive
  // downstream; `isBinary` is how a caller knows the zero means "unknown", not "none".
  const isBinary = insertions === '-' || deletions === '-';

  return {
    entry: {
      path,
      oldPath: null,
      insertions: isBinary ? 0 : countOf(insertions, token),
      deletions: isBinary ? 0 : countOf(deletions, token),
      isBinary,
    },
    renamedFrom: path === '',
  };
}

function countOf(value: string, token: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) throw malformed('numstat count', token);
  return count;
}

/**
 * Join the two blocks.
 *
 * `--raw` drives the result because it is the only source of `kind` and `similarity`,
 * and the join is by path rather than by position so that a block git emits in a
 * different order, or omits an entry from, degrades to zero counts instead of
 * attributing one file's churn to another.
 *
 * When `--raw` is absent — a caller assembling their own argument vector from the
 * LEAN-V1 §5.1 sketch — every change is still reported, with `kind` inferred as far as
 * numstat allows: a three-token entry is a rename, everything else is a modification.
 */
function combine(
  statuses: readonly StatusEntry[],
  counts: readonly CountEntry[],
): readonly RawChange[] {
  if (statuses.length === 0) {
    return counts.map((entry) => ({
      kind: entry.oldPath === null ? 'modify' : 'rename',
      oldPath: entry.oldPath ?? entry.path,
      newPath: entry.path,
      similarity: null,
      insertions: entry.insertions,
      deletions: entry.deletions,
      isBinary: entry.isBinary,
    }));
  }

  const byPath = new Map(counts.map((entry) => [entry.path, entry]));
  return statuses.map((status) => {
    const key = status.newPath ?? status.oldPath ?? '';
    const entry = byPath.get(key);
    const insertions = entry?.insertions ?? 0;
    const deletions = entry?.deletions ?? 0;
    return {
      // A `chmod` with no content change reports as `M` with differing modes and zero
      // counts. Reporting it as `modify` would inflate every churn metric with commits
      // that changed nothing a reader can see.
      kind:
        status.kind === 'modify' &&
        status.modeChanged &&
        insertions === 0 &&
        deletions === 0
          ? 'mode'
          : status.kind,
      oldPath: status.oldPath,
      newPath: status.newPath,
      similarity: status.similarity,
      insertions,
      deletions,
      isBinary: entry?.isBinary ?? false,
    };
  });
}
