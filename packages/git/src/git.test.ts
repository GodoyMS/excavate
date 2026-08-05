/**
 * The parser, against synthetic bytes.
 *
 * Every case here is a framing rule of `git log --raw --numstat -z` that the walk's
 * correctness depends on, expressed as the exact bytes git emits (captured from a real
 * repository, then reduced). Chunk boundaries are placed deliberately: the stream
 * arrives in ~64KB pieces in production, so a record split mid-field is the normal case
 * rather than an edge case, and the failure it produces — a dropped or garbled commit
 * — is invisible in aggregate numbers.
 *
 * The complementary layer, exercising the same parser against `git` itself, is in
 * `cli-backend.test.ts`.
 */

import { NotImplementedError, isExcavateError, parseOid } from '@excavate/core';
import { describe, expect, it } from 'vitest';

import {
  CliGitBackend,
  COMMIT_FORMAT,
  DEFAULT_WALK_SPEC,
  FIELD_SEPARATOR,
  RECORD_SEPARATOR,
  parseBlameIgnoreRevs,
  parseLogStream,
  parseMailmap,
  walkArgs,
  type RawCommit,
  type WalkSpec,
} from './index.js';

describe('the commit format', () => {
  const fields = COMMIT_FORMAT.split(FIELD_SEPARATOR);

  it('keeps the raw message last, since it is the only multi-line field', () => {
    expect(fields.at(-1)).toBe('%B');
    expect(fields.filter((f) => f === '%B')).toHaveLength(1);
  });

  it('captures both timestamps as an instant and an offset-bearing date', () => {
    // Part 8 §8.2.1 requires the original UTC offset; %at alone cannot supply it.
    expect(fields).toContain('%at');
    expect(fields).toContain('%ai');
    expect(fields).toContain('%ct');
    expect(fields).toContain('%ci');
  });

  it('captures author and committer separately — rebases make them diverge', () => {
    expect(fields).toContain('%an');
    expect(fields).toContain('%ae');
    expect(fields).toContain('%cn');
    expect(fields).toContain('%ce');
  });

  it('uses separators no format placeholder can emit', () => {
    // Not the same claim as "cannot occur in a commit message" — git forbids only NUL
    // there. A message carrying \x01 desynchronises the framing, and the walk raises
    // GIT_FAILED rather than splitting a commit in two silently; see the case below.
    expect(RECORD_SEPARATOR).toBe('\x01');
    expect(FIELD_SEPARATOR).toBe('\x02');
    expect(COMMIT_FORMAT).not.toContain(RECORD_SEPARATOR);
  });
});

describe('the default walk spec', () => {
  it('is first-parent at git’s own rename threshold', () => {
    expect(DEFAULT_WALK_SPEC.projection).toBe('first-parent');
    expect(DEFAULT_WALK_SPEC.findRenames).toBe(50);
  });
});

/* ── The argument vector ───────────────────────────────────────────────────── */

const spec = (overrides: Partial<WalkSpec> = {}): WalkSpec => ({
  ...DEFAULT_WALK_SPEC,
  ...overrides,
});

describe('the walk argument vector', () => {
  it('asks for raw output too, without which no change kind is knowable', () => {
    // --numstat carries counts and paths only: an add and an append look identical,
    // and a rename carries no similarity. kind and similarity come from --raw.
    const args = walkArgs(spec());
    expect(args).toContain('--raw');
    expect(args).toContain('--numstat');
    expect(args).toContain('-z');
  });

  it('refuses the one ambient git config that can inject bytes into the stream', () => {
    // `log.showSignature=true` interleaves gpg's verification output between records,
    // which the framing has no way to describe.
    expect(walkArgs(spec())).toContain('--no-show-signature');
  });

  it('introduces every record with the separator, including the first', () => {
    const format = walkArgs(spec()).find((arg) => arg.startsWith('--format='));
    expect(format).toBe(`--format=${RECORD_SEPARATOR}${COMMIT_FORMAT}`);
  });

  it('walks oldest-first, because rename resolution advances a forward frontier', () => {
    expect(walkArgs(spec())).toContain('--reverse');
  });

  it('follows the first-parent line under the default projection', () => {
    expect(walkArgs(spec())).toContain('--first-parent');
  });

  it('orders explicitly under the two projections v1 does not exercise', () => {
    expect(walkArgs(spec({ projection: 'topological' }))).toContain('--topo-order');
    expect(walkArgs(spec({ projection: 'topological' }))).not.toContain('--first-parent');
    expect(walkArgs(spec({ projection: 'author-date' }))).toContain(
      '--author-date-order',
    );
  });

  it('includes every ref only when asked to', () => {
    expect(walkArgs(spec({ includeAllRefs: true }))).toContain('--all');
    expect(walkArgs(spec({ includeAllRefs: false }))).not.toContain('--all');
  });

  it('passes the rename threshold as a percentage git understands', () => {
    expect(walkArgs(spec({ findRenames: 75 }))).toContain('--find-renames=75%');
  });

  it('omits copy detection when the spec disables it', () => {
    expect(walkArgs(spec({ findCopies: true }))).toContain('--find-copies');
    expect(walkArgs(spec({ findCopies: false }))).not.toContain('--find-copies');
  });

  it('puts an incremental range last, where git cannot read it as another option', () => {
    const since = parseOid('b'.repeat(40));
    const args = walkArgs(spec({ since }));
    expect(args.at(-1)).toBe(`${since}..HEAD`);
    expect(walkArgs(spec({ since: null })).join(' ')).not.toContain('..HEAD');
  });
});

/* ── The stream ────────────────────────────────────────────────────────────── */

const OID = {
  first: '1'.repeat(40),
  second: '2'.repeat(40),
  third: '3'.repeat(40),
  tree: 'a'.repeat(40),
};

interface RecordOptions {
  readonly oid?: string;
  readonly parents?: readonly string[];
  readonly authorDate?: string;
  readonly committerDate?: string;
  readonly epoch?: string;
  readonly message?: string;
  /** Exactly what git puts after the header's NUL, minus the leading newline. */
  readonly diff?: string;
}

/**
 * Assemble one record the way git does: separator, `\x02`-joined header, NUL, then —
 * only when there is a diff at all — a newline and the NUL-terminated diff tokens.
 */
function record(options: RecordOptions = {}): string {
  const epoch = options.epoch ?? '1577836800';
  const header = [
    options.oid ?? OID.first,
    OID.tree,
    (options.parents ?? []).join(' '),
    'Ada Lovelace',
    'ada@example.test',
    epoch,
    options.authorDate ?? '2020-01-01 00:00:00 +0000',
    'Grace Hopper',
    'grace@example.test',
    epoch,
    options.committerDate ?? '2020-01-01 00:00:00 +0000',
    options.message ?? 'a subject\n',
  ].join(FIELD_SEPARATOR);
  const diff = options.diff ?? '';
  return `${RECORD_SEPARATOR}${header}\x00${diff === '' ? '' : `\n${diff}`}`;
}

async function* oneChunk(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/** Split on *byte* offsets, so a multi-byte character can straddle a boundary. */
async function* chunkedAt(
  text: string,
  ...offsets: readonly number[]
): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let start = 0;
  for (const offset of [...offsets, bytes.length]) {
    yield bytes.subarray(start, offset);
    start = offset;
  }
}

async function* byteAtATime(text: string): AsyncGenerator<Uint8Array> {
  for (const byte of new TextEncoder().encode(text)) yield new Uint8Array([byte]);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<RawCommit[]> {
  const commits: RawCommit[] = [];
  for await (const commit of parseLogStream(stream)) commits.push(commit);
  return commits;
}

/** The error code an operation failed with, as a value tests can compare. */
async function codeOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return isExcavateError(error) ? error.code : `not an ExcavateError: ${String(error)}`;
  }
  return 'no error thrown';
}

describe('parsing the log stream', () => {
  it('yields nothing for an empty stream, which is how an empty repository looks', async () => {
    expect(await collect(oneChunk(''))).toEqual([]);
  });

  it('rejects output with no record separator instead of calling it an empty history', async () => {
    // A git that ignored `--format`, or a wrapper standing in for it. Yielding nothing
    // would make that indistinguishable from a repository with no commits — a confident
    // wrong answer about the one fact everything else is derived from.
    const code = await codeOf(() =>
      collect(oneChunk('1111111 2020-01-01 someone else’s format\n')),
    );
    expect(code).toBe('GIT_FAILED');
  });

  it('completes the final record at end of stream, which has no trailing separator', async () => {
    const commits = await collect(oneChunk(record({ diff: '1\t0\ta.txt\x00' })));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.oid).toBe(OID.first);
    expect(commits[0]?.changes[0]?.insertions).toBe(1);
  });

  it('reassembles a record whose header is split mid-field across two chunks', async () => {
    const text = record({ diff: '2\t1\tsrc/a.ts\x00' });
    // Land the boundary inside the commit oid — the worst place for it.
    const commits = await collect(chunkedAt(text, 20));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.oid).toBe(OID.first);
    expect(commits[0]?.changes[0]?.newPath).toBe('src/a.ts');
  });

  it('reassembles a record split inside its diff section', async () => {
    const text = record({ diff: '2\t1\tsrc/a.ts\x00' });
    const commits = await collect(chunkedAt(text, text.length - 6));
    expect(commits[0]?.changes).toEqual([
      {
        kind: 'modify',
        oldPath: 'src/a.ts',
        newPath: 'src/a.ts',
        similarity: null,
        insertions: 2,
        deletions: 1,
        isBinary: false,
      },
    ]);
  });

  it('produces the same commits whether the stream arrives whole or one byte at a time', async () => {
    const text = [
      record({
        oid: OID.first,
        diff: ':000000 100644 0000000 aaaaaaa A\x00a.txt\x001\t0\ta.txt\x00',
      }),
      record({ oid: OID.second, parents: [OID.first], message: 'second\n' }),
      record({ oid: OID.third, parents: [OID.second], diff: '0\t3\tb.txt\x00' }),
    ].join('');
    expect(await collect(byteAtATime(text))).toEqual(await collect(oneChunk(text)));
  });

  it('keeps a multi-byte character intact when it straddles a chunk boundary', async () => {
    const text = record({ message: 'réfactor — naïve caché 🏛️\n' });
    const bytes = new TextEncoder().encode(text);
    const marker = new TextEncoder().encode('🏛');
    const firstByte = bytes.indexOf(marker[0] ?? 0);
    expect(firstByte).toBeGreaterThan(0);
    // Split inside the four-byte sequence for U+1F3DB.
    const commits = await collect(chunkedAt(text, firstByte + 2));
    expect(commits[0]?.message).toBe('réfactor — naïve caché 🏛️');
  });

  it('preserves a body with blank lines and strips only git’s terminating newline', async () => {
    const message = 'Fix the thing\n\nBecause it was broken.\n\nRefs: #12\n';
    const commits = await collect(oneChunk(record({ message })));
    expect(commits[0]?.message).toBe(
      'Fix the thing\n\nBecause it was broken.\n\nRefs: #12',
    );
  });

  it('accepts a commit with a subject and no body', async () => {
    const commits = await collect(oneChunk(record({ message: 'terse\n' })));
    expect(commits[0]?.message).toBe('terse');
  });

  it('accepts a commit with no message at all', async () => {
    const commits = await collect(oneChunk(record({ message: '' })));
    expect(commits[0]?.message).toBe('');
  });

  it('records no parents for a root commit and both for a merge', async () => {
    const commits = await collect(
      oneChunk(
        record({ oid: OID.first }) +
          record({ oid: OID.third, parents: [OID.first, OID.second] }),
      ),
    );
    expect(commits[0]?.parents).toEqual([]);
    expect(commits[1]?.parents).toEqual([OID.first, OID.second]);
  });

  it('takes the instant from the epoch and the offset from the date field', async () => {
    const commits = await collect(
      oneChunk(
        record({
          epoch: '1577817000',
          authorDate: '2020-01-01 00:00:00 +0530',
          committerDate: '2019-12-31 10:30:00 -0800',
        }),
      ),
    );
    expect(commits[0]?.authoredAt).toEqual({
      epochSeconds: 1577817000,
      offsetMinutes: 330,
    });
    expect(commits[0]?.committedAt).toEqual({
      epochSeconds: 1577817000,
      offsetMinutes: -480,
    });
  });

  it('reports a rename with both paths and the similarity git measured', async () => {
    // -z framing: the numstat entry's path is *empty*, and the two paths follow it as
    // separate NUL-terminated tokens. Reading them as one field is the classic bug.
    const diff =
      ':100644 100644 94954ab 8b14c4f R87\x00old/name.ts\x00new/name.ts\x00' +
      '3\t1\t\x00old/name.ts\x00new/name.ts\x00';
    const commits = await collect(oneChunk(record({ diff })));
    expect(commits[0]?.changes).toEqual([
      {
        kind: 'rename',
        oldPath: 'old/name.ts',
        newPath: 'new/name.ts',
        similarity: 87,
        insertions: 3,
        deletions: 1,
        isBinary: false,
      },
    ]);
  });

  it('does not mistake a rename’s trailing paths for the next file’s counts', async () => {
    const diff =
      ':100644 100644 94954ab 94954ab R100\x00a.txt\x00b.txt\x00' +
      ':000000 100644 0000000 ccccccc A\x00c.txt\x00' +
      '0\t0\t\x00a.txt\x00b.txt\x00' +
      '9\t0\tc.txt\x00';
    const commits = await collect(oneChunk(record({ diff })));
    expect(commits[0]?.changes).toHaveLength(2);
    expect(commits[0]?.changes[1]).toMatchObject({
      kind: 'add',
      oldPath: null,
      newPath: 'c.txt',
      insertions: 9,
      deletions: 0,
    });
  });

  it('reports a binary file as binary with zeroed counts rather than NaN', async () => {
    const diff = ':000000 100644 0000000 c94be36 A\x00logo.png\x00-\t-\tlogo.png\x00';
    const commits = await collect(oneChunk(record({ diff })));
    expect(commits[0]?.changes[0]).toMatchObject({
      kind: 'add',
      newPath: 'logo.png',
      isBinary: true,
      insertions: 0,
      deletions: 0,
    });
  });

  it('reports a deletion with the path it had, and no new path', async () => {
    const diff =
      ':100644 000000 94954ab 0000000 D\x00gone.txt\x00' + '0\t7\tgone.txt\x00';
    const commits = await collect(oneChunk(record({ diff })));
    expect(commits[0]?.changes[0]).toMatchObject({
      kind: 'delete',
      oldPath: 'gone.txt',
      newPath: null,
      deletions: 7,
    });
  });

  it('classifies a permission change with no content change as a mode change', async () => {
    // Otherwise every `chmod +x` inflates churn with a commit nobody can see the effect of.
    const diff = ':100644 100755 587be6b 587be6b M\x00run.sh\x00' + '0\t0\trun.sh\x00';
    const commits = await collect(oneChunk(record({ diff })));
    expect(commits[0]?.changes[0]?.kind).toBe('mode');
  });

  it('gives a merge commit no changes rather than the next commit’s', async () => {
    // Walked without --first-parent, git prints no diff at all for a merge. The next
    // record's changes must not migrate onto it.
    const merge = record({
      oid: OID.second,
      parents: [OID.first, OID.third],
      message: 'merge\n',
    });
    const after = record({
      oid: OID.third,
      parents: [OID.second],
      diff: '4\t0\tafter.txt\x00',
    });
    const commits = await collect(chunkedAt(merge + after, merge.length - 3));
    expect(commits[0]?.changes).toEqual([]);
    expect(commits[0]?.message).toBe('merge');
    expect(commits[1]?.changes[0]?.newPath).toBe('after.txt');
  });

  it('keeps a path containing a newline intact, which is the whole point of -z', async () => {
    const diff =
      ':000000 100644 0000000 aaaaaaa A\x00we\nird.txt\x00' + '1\t0\twe\nird.txt\x00';
    const commits = await collect(oneChunk(record({ diff })));
    expect(commits[0]?.changes[0]?.newPath).toBe('we\nird.txt');
  });

  it('still reports every change when the caller omitted --raw', async () => {
    // The LEAN-V1 §5.1 sketch asks for --numstat only; kind and similarity degrade,
    // but no change may be silently dropped.
    const commits = await collect(
      oneChunk(record({ diff: '2\t0\ta.txt\x00' + '0\t0\t\x00old.ts\x00new.ts\x00' })),
    );
    expect(commits[0]?.changes).toEqual([
      {
        kind: 'modify',
        oldPath: 'a.txt',
        newPath: 'a.txt',
        similarity: null,
        insertions: 2,
        deletions: 0,
        isBinary: false,
      },
      {
        kind: 'rename',
        oldPath: 'old.ts',
        newPath: 'new.ts',
        similarity: null,
        insertions: 0,
        deletions: 0,
        isBinary: false,
      },
    ]);
  });

  it('rejects a truncated record rather than inventing a commit from it', async () => {
    const truncated = record().slice(0, 60);
    expect(await codeOf(() => collect(oneChunk(truncated)))).toBe('GIT_FAILED');
  });

  it('rejects a record whose oid is not an object id', async () => {
    const broken = record({ oid: 'not-a-real-oid' });
    expect(await codeOf(() => collect(oneChunk(broken)))).toBe('GIT_FAILED');
  });

  it('fails loudly on a message containing the record separator', async () => {
    // git forbids only NUL in a commit message, so \x01 is possible, if vanishingly
    // rare — and it desynchronises the framing. The guarantee is not that we parse such
    // a message (we cannot) but that the desynchronisation cannot pass unnoticed: the
    // text after the stray separator cannot form twelve header fields, so the walk
    // raises GIT_FAILED instead of quietly attributing half a commit to another.
    const code = await codeOf(() =>
      collect(oneChunk(record({ message: `subject${RECORD_SEPARATOR}body\n` }))),
    );
    expect(code).toBe('GIT_FAILED');
  });

  it('rejects a record with no parseable instant, on which all ordering depends', async () => {
    expect(await codeOf(() => collect(oneChunk(record({ epoch: '' }))))).toBe(
      'GIT_FAILED',
    );
  });

  it('tolerates a date field with no offset by falling back to UTC', async () => {
    // The offset is presentational; losing a repository over it would be a bad trade.
    const commits = await collect(
      oneChunk(record({ authorDate: '2020-01-01 00:00:00' })),
    );
    expect(commits[0]?.authoredAt.offsetMinutes).toBe(0);
  });
});

/* ── .mailmap ──────────────────────────────────────────────────────────────── */

describe('parsing a mailmap', () => {
  const identity = (name: string, email: string) => ({ name, email });

  it('renames a person who commits under one address', () => {
    const mailmap = parseMailmap('Ada Lovelace <ada@example.test>\n');
    expect(mailmap.resolve(identity('ada', 'ada@example.test'))).toEqual(
      identity('Ada Lovelace', 'ada@example.test'),
    );
  });

  it('rewrites an alias address while leaving the name the commit used', () => {
    const mailmap = parseMailmap('<ada@example.test> <ada@laptop.local>\n');
    expect(mailmap.resolve(identity('ada', 'ada@laptop.local'))).toEqual(
      identity('ada', 'ada@example.test'),
    );
  });

  it('rewrites both name and address for an alias', () => {
    const mailmap = parseMailmap('Ada Lovelace <ada@example.test> <ada@laptop.local>\n');
    expect(mailmap.resolve(identity('ada', 'ada@laptop.local'))).toEqual(
      identity('Ada Lovelace', 'ada@example.test'),
    );
  });

  it('disambiguates a shared address by the name the commit carried', () => {
    // The form that exists precisely for root@localhost and CI accounts.
    const mailmap = parseMailmap(
      [
        'Ada Lovelace <ada@example.test> Ada <root@localhost>',
        'Grace Hopper <grace@example.test> Grace <root@localhost>',
      ].join('\n'),
    );
    expect(mailmap.resolve(identity('Ada', 'root@localhost')).email).toBe(
      'ada@example.test',
    );
    expect(mailmap.resolve(identity('Grace', 'root@localhost')).email).toBe(
      'grace@example.test',
    );
  });

  it('prefers a name-qualified entry over the unqualified one for the same address', () => {
    const mailmap = parseMailmap(
      [
        'Default Person <default@example.test> <shared@example.test>',
        'Specific Person <specific@example.test> Bot <shared@example.test>',
      ].join('\n'),
    );
    expect(mailmap.resolve(identity('Bot', 'shared@example.test')).email).toBe(
      'specific@example.test',
    );
    expect(mailmap.resolve(identity('Someone Else', 'shared@example.test')).email).toBe(
      'default@example.test',
    );
  });

  it('matches address and name case-insensitively, as git does', () => {
    const mailmap = parseMailmap(
      'Ada Lovelace <ada@example.test> ADA <OLD@Example.TEST>',
    );
    expect(mailmap.resolve(identity('ada', 'old@example.test')).name).toBe(
      'Ada Lovelace',
    );
  });

  it('leaves an identity the mailmap says nothing about exactly as it was', () => {
    const mailmap = parseMailmap('Ada Lovelace <ada@example.test>');
    const unknown = identity('Alan Turing', 'alan@example.test');
    expect(mailmap.resolve(unknown)).toEqual(unknown);
  });

  it('ignores comments, blank lines, and lines with no address', () => {
    const mailmap = parseMailmap(
      [
        '# the canonical spellings',
        '',
        '   ',
        'Ada Lovelace <ada@example.test>',
        '# Grace Hopper <grace@example.test>',
        'nonsense with no angle brackets',
      ].join('\n'),
    );
    expect(mailmap.entryCount).toBe(1);
    expect(mailmap.resolve(identity('g', 'grace@example.test')).name).toBe('g');
  });

  it('counts entries so a caller can report that a mailmap was found and used', () => {
    expect(parseMailmap('').entryCount).toBe(0);
    expect(parseMailmap('A <a@x.test>\nB <b@x.test> <b2@x.test>\n').entryCount).toBe(2);
  });
});

/* ── What is deliberately still missing ────────────────────────────────────── */

describe('the deferred surface', () => {
  it('constructs without touching a repository', () => {
    const backend = new CliGitBackend({ repoRoot: '/nonexistent' });
    expect(backend.repoRoot).toBe('/nonexistent');
  });

  it('reports which milestone implements each unfinished operation', () => {
    const backend = new CliGitBackend({ repoRoot: '/nonexistent' });
    // Blame, diff, and blob reads are M2 work — hunks and the store have to exist first.
    expect(() =>
      backend.blame(
        'a.ts',
        parseOid('0'.repeat(40)),
        { start: 1, end: 1 },
        { followCopies: true, ignoreRevs: new Set() },
      ),
    ).toThrow(/M2/);
    expect(() =>
      backend.diff(null, parseOid('0'.repeat(40)), {
        findRenames: 50,
        findCopies: true,
        maxBlobBytes: 1,
      }),
    ).toThrow(NotImplementedError);
    expect(() => backend.readBlob(parseOid('0'.repeat(40)))).toThrow(/M2/);
    expect(() => parseBlameIgnoreRevs('')).toThrow(/M2/);
  });
});
