/**
 * The B1 boundary, and its one implementation.
 *
 * LEAN-V1 §3.1 cuts gitoxide, the `HybridBackend`, and the second implementation:
 * there is one backend, and it shells out to `git`, whose rename detection has 20
 * years of hardening behind it and which every user already has installed.
 */

import type { Identity, LineRange, Oid, RefKind, Timestamp } from '@wise-excavate/core';
import { ExcavateError, NotImplementedError, isOid, parseOid } from '@wise-excavate/core';

import type { GitCommand } from './exec.js';
import {
  DEFAULT_GIT_BINARY,
  exitCodeOfGit,
  runGit,
  spawnGit,
  stderrOf,
  tryRunGit,
} from './exec.js';
import type { Mailmap } from './mailmap.js';
import { parseMailmap } from './mailmap.js';
import type { RawChange, RawCommit, WalkSpec } from './walk.js';
import { parseLogStream, walkArgs } from './walk.js';

export interface RawRef {
  readonly name: string;
  readonly kind: RefKind;
  readonly target: Oid;
  readonly isHead: boolean;
}

export interface DiffOptions {
  readonly findRenames: number;
  readonly findCopies: boolean;
  /** Skip hunk bodies for files above this size. Hunks are a skippable artifact. */
  readonly maxBlobBytes: number;
}

export interface BlameOptions {
  /** `-C -M`: follow copies and moves. */
  readonly followCopies: boolean;
  /** Honour `.git-blame-ignore-revs`. */
  readonly ignoreRevs: ReadonlySet<Oid>;
}

export interface BlameHunk {
  readonly oid: Oid;
  /** The path the lines came from, which is not necessarily the path blamed. */
  readonly originalPath: string;
  /** Lines in the file being blamed. */
  readonly range: LineRange;
  /** The corresponding lines in the originating commit. */
  readonly originalRange: LineRange;
  readonly author: Identity;
  readonly authoredAt: Timestamp;
}

export interface TreeEntry {
  readonly path: string;
  readonly oid: Oid;
  /**
   * The numeric POSIX mode, not the octal digits git prints: `100644` on the wire
   * becomes `0o100644` — 33188 — so that the type-and-permission bits are testable
   * with arithmetic rather than string comparison.
   */
  readonly mode: number;
  readonly sizeBytes: number | null;
}

/**
 * Thin at v1 because there is only one backend. It exists so the capability checks
 * that gate blame-ignore support and SHA-256 repositories have somewhere honest to
 * live, rather than being version sniffs scattered through callers.
 */
export interface BackendCapabilities {
  readonly gitVersion: string;
  readonly supportsBlameIgnoreRevs: boolean;
  readonly supportsSha256: boolean;
}

/**
 * The B1 boundary, named.
 *
 * One implementation ships (`CliGitBackend`) plus a fixture-backed double in tests.
 * Per LEAN-V1 §2.1 this is also the seam along which the walk would be ported if a
 * 1M-commit repository ever makes Node the bottleneck — a contained change rather
 * than a rewrite.
 */
export interface GitBackend {
  head(): Promise<Oid>;
  refs(): Promise<readonly RawRef[]>;
  /** Streams. Never materialises the whole history — that is the point. */
  walk(spec: WalkSpec): AsyncIterable<RawCommit>;
  diff(from: Oid | null, to: Oid, options: DiffOptions): Promise<readonly RawChange[]>;
  blame(
    path: string,
    at: Oid,
    range: LineRange,
    options: BlameOptions,
  ): Promise<readonly BlameHunk[]>;
  readBlob(oid: Oid): Promise<Uint8Array>;
  treeAt(commit: Oid): Promise<readonly TreeEntry[]>;
  /**
   * The repository's `.mailmap`, or `null` when it has none.
   *
   * On the backend rather than in the indexer because reading a tracked file is repository
   * I/O, and boundary rule B1 says only this package does that. Read from HEAD rather than
   * the working tree so the answer does not depend on whether someone has uncommitted edits.
   */
  readMailmap(): Promise<Mailmap | null>;
  /**
   * Whether `ancestor` is reachable from `descendant`.
   *
   * This is what separates a fast-forward from a rewrite on the incremental path, and it has
   * to tolerate `ancestor` no longer existing at all — the usual outcome of an amend or a
   * force-push — by answering `false` rather than throwing.
   */
  isAncestor(ancestor: Oid, descendant: Oid): Promise<boolean>;
  capabilities(): Promise<BackendCapabilities>;
}

export interface CliGitBackendOptions {
  readonly repoRoot: string;
  /** Resolved from `PATH` when omitted. */
  readonly gitBinary?: string;
}

/** `blame.ignoreRevsFile` arrived in git 2.23. */
const BLAME_IGNORE_REVS_SINCE = [2, 23] as const;
/** `--object-format=sha256` arrived in git 2.29. */
const SHA256_SINCE = [2, 29] as const;

/**
 * Field separator for the `for-each-ref` format. Shares `\x02` with the log walk for
 * the same reason: git's own refname rules forbid control characters, so the parse
 * needs no escaping and no quoting mode to get wrong.
 */
const REF_FIELD = '\x02';

export class CliGitBackend implements GitBackend {
  readonly repoRoot: string;
  private readonly gitBinary: string;

  constructor(options: CliGitBackendOptions) {
    this.repoRoot = options.repoRoot;
    this.gitBinary = options.gitBinary ?? DEFAULT_GIT_BINARY;
  }

  private command(args: readonly string[]): GitCommand {
    return { binary: this.gitBinary, cwd: this.repoRoot, args };
  }

  async head(): Promise<Oid> {
    const output = await runGit(this.command(['rev-parse', 'HEAD']));
    return requireOid(output.trim(), 'HEAD');
  }

  /**
   * Branches, tags, remotes, and `HEAD` itself.
   *
   * `HEAD` is listed as its own ref so that a detached checkout — a bisect, a CI
   * build, a `git checkout <tag>` — is still representable; without it, "where are we"
   * would be unanswerable in exactly the states where a user is most likely to ask.
   * It costs a second invocation because `for-each-ref` walks the ref namespace only
   * and does not match `HEAD` at all.
   *
   * An annotated tag reports its *peeled* target, because the object a release points
   * at is the commit, never the tag object. A ref that peels to something other than a
   * commit is dropped: repositories really do tag blobs (`git.git` tags a GPG public
   * key that way), and a "release" whose target is not a commit would be a landmine for
   * every consumer downstream.
   */
  async refs(): Promise<readonly RawRef[]> {
    const format = [
      '%(refname)',
      '%(objectname)',
      '%(objecttype)',
      '%(*objectname)',
      '%(*objecttype)',
      '%(HEAD)',
    ].join(REF_FIELD);
    const output = await runGit(
      this.command([
        'for-each-ref',
        `--format=${format}`,
        'refs/heads',
        'refs/tags',
        'refs/remotes',
      ]),
    );

    const refs: RawRef[] = [];
    try {
      refs.push({ name: 'HEAD', kind: 'head', target: await this.head(), isHead: true });
    } catch (error) {
      // An unborn HEAD — a freshly initialised repository — is a state to describe
      // rather than an error, and `for-each-ref` has already proved git works and the
      // repository is real. Every *other* failure is rethrown: silently returning a ref
      // list with no `HEAD` in it would leave the caller unable to distinguish "this
      // repository has no commits" from "we could not find out", which is precisely the
      // confusion this package exists to prevent.
      if (!isMissingHead(error)) throw error;
    }
    for (const line of output.split('\n')) {
      if (line === '') continue;
      const [name = '', oid = '', type = '', peeledOid = '', peeledType = '', head = ''] =
        line.split(REF_FIELD);
      const kind = refKindOf(name);
      if (kind === null) continue;
      // A peeled target is present only for annotated tags, where it is the one we want.
      const target = peeledOid === '' ? oid : peeledOid;
      const targetType = peeledOid === '' ? type : peeledType;
      if (target === '' || targetType !== 'commit') continue;
      refs.push({
        name,
        kind,
        target: requireOid(target, `the target of ${name}`),
        isHead: kind === 'head' || head.trim() === '*',
      });
    }
    return refs;
  }

  /**
   * Spawn the walk and stream it through the parser.
   *
   * The `completion()` await after the loop is load-bearing: git can fail *part way
   * through* a walk (a corrupt object, a killed process, a bad revision range), and
   * stdout simply ends when it does. Without this, a partial history would be indexed
   * and reported as complete, which would quietly falsify every ownership number,
   * every era boundary, and every Why answer derived from it. The `finally` kills a
   * walk the consumer abandoned, so a `break` in the indexer cannot leak a `git log`
   * process for the lifetime of the daemon.
   */
  async *walk(spec: WalkSpec): AsyncGenerator<RawCommit, void, undefined> {
    const stream = spawnGit(this.command(walkArgs(spec)));
    let drained = false;
    let yielded = 0;
    try {
      for await (const commit of parseLogStream(stream.stdout)) {
        yielded += 1;
        yield commit;
      }
      drained = true;
    } finally {
      // Only on an early exit. git closes stdout a moment before it exits, so killing
      // unconditionally here would turn a clean walk into a spurious signal failure.
      if (!drained) stream.kill();
    }

    try {
      await stream.completion();
    } catch (error) {
      // The one failure that is really a state: a repository with no commits, where
      // `git log` refuses the implicit HEAD outright. Part 8 §8.6.1 has a name for that
      // state (`uninitialized`) and callers are entitled to reach it without a special
      // case. Narrow deliberately — it applies only when nothing at all was yielded, so
      // it can never mask a walk that died part way through.
      if (yielded > 0 || !isUnbornHead(error)) throw error;
    }
  }

  diff(
    _from: Oid | null,
    _to: Oid,
    _options: DiffOptions,
  ): Promise<readonly RawChange[]> {
    throw new NotImplementedError('CliGitBackend.diff', 'M2');
  }

  blame(
    _path: string,
    _at: Oid,
    _range: LineRange,
    _options: BlameOptions,
  ): Promise<readonly BlameHunk[]> {
    throw new NotImplementedError('CliGitBackend.blame', 'M2');
  }

  readBlob(_oid: Oid): Promise<Uint8Array> {
    throw new NotImplementedError('CliGitBackend.readBlob', 'M2');
  }

  /**
   * The full file list at a commit, flattened. `-z` again, so a path containing a
   * newline or a quote is delivered intact rather than C-quoted.
   */
  async treeAt(commit: Oid): Promise<readonly TreeEntry[]> {
    const output = await runGit(this.command(['ls-tree', '-r', '-z', '--long', commit]));
    const entries: TreeEntry[] = [];
    for (const record of output.split('\0')) {
      if (record === '') continue;
      entries.push(parseTreeRecord(record));
    }
    return entries;
  }

  async readMailmap(): Promise<Mailmap | null> {
    /* `HEAD:.mailmap` rather than the file on disk: the mailmap is part of the history's
       own declaration of identity, and reading an uncommitted edit would make two people
       indexing the same commit get different ownership. A repository with no mailmap — the
       common case — exits non-zero, which is not an error here. */
    const result = await tryRunGit(this.command(['show', 'HEAD:.mailmap']));
    return result === null ? null : parseMailmap(result);
  }

  async isAncestor(ancestor: Oid, descendant: Oid): Promise<boolean> {
    /* `merge-base --is-ancestor` communicates through the exit code: 0 yes, 1 no, and
       128 when an object is missing. All three are expected, so this cannot use the
       throwing runner — a missing ancestor is the *answer* on a rewritten history, not a
       failure to compute one. */
    const outcome = await exitCodeOfGit(
      this.command(['merge-base', '--is-ancestor', ancestor, descendant]),
    );
    return outcome === 0;
  }

  async capabilities(): Promise<BackendCapabilities> {
    const output = await runGit(this.command(['--version']));
    const version = parseGitVersion(output);
    return {
      gitVersion: version.text,
      supportsBlameIgnoreRevs: atLeast(version.parts, BLAME_IGNORE_REVS_SINCE),
      supportsSha256: atLeast(version.parts, SHA256_SINCE),
    };
  }
}

/**
 * git prints full object ids, so a value that is not one means the binary on the other
 * end is not the git this package was written against.
 *
 * That is a `GIT_FAILED` — the code every caller already classifies and reports — rather
 * than the `TypeError` a branded-type constructor would throw, which would surface as an
 * internal error and tell the user nothing about which command produced it. The walk
 * already treats malformed output this way; this keeps the rest of the package speaking
 * the same vocabulary.
 */
function requireOid(value: string, what: string): Oid {
  if (!isOid(value)) {
    throw new ExcavateError(
      'GIT_FAILED',
      `git reported ${what} as ${JSON.stringify(value.slice(0, 80))}, which is not an object id`,
      { details: { what } },
    );
  }
  return parseOid(value);
}

/**
 * The two ways `git log` says "this repository has no commits yet".
 *
 * Deliberately narrow, and it must stay that way: `walk()` uses this to decide that a
 * failed traversal was really an empty one, so anything vaguer here — "unknown
 * revision", say — would turn a mistyped revision range into a silently empty history.
 */
function isUnbornHead(error: unknown): boolean {
  const stderr = stderrOf(error);
  return (
    /does not have any commits yet/i.test(stderr) ||
    /bad default revision 'HEAD'/i.test(stderr)
  );
}

/**
 * The same state as seen by `rev-parse`, which phrases it as an ambiguous argument
 * instead. Matching on the literal `'HEAD'` is what keeps this from also matching a
 * caller's bad revision: the only revision `head()` ever passes is `HEAD`.
 */
function isMissingHead(error: unknown): boolean {
  return isUnbornHead(error) || /ambiguous argument 'HEAD'/i.test(stderrOf(error));
}

function refKindOf(name: string): RefKind | null {
  if (name === 'HEAD') return 'head';
  if (name.startsWith('refs/heads/')) return 'branch';
  if (name.startsWith('refs/tags/')) return 'tag';
  if (name.startsWith('refs/remotes/')) return 'remote';
  return null;
}

/** `<mode> <type> <oid> <size>\t<path>`, with `size` right-aligned and `-` for non-blobs. */
const TREE_RECORD = /^(\d+) (\S+) ([0-9a-f]+)\s+(\S+)\t([\s\S]*)$/;

/**
 * A record that does not parse is an error, not an entry to skip. Dropping it would
 * make a file quietly absent from "what exists at this commit" — a wrong answer that
 * looks exactly like a right one, which is the failure mode this project cannot afford.
 */
function parseTreeRecord(record: string): TreeEntry {
  const match = TREE_RECORD.exec(record);
  if (match === null) {
    throw new ExcavateError(
      'GIT_FAILED',
      `git ls-tree produced a record this parser does not understand: ${JSON.stringify(
        record.slice(0, 120),
      )}`,
      { details: { record: record.slice(0, 120) } },
    );
  }
  const [, mode = '', , oid = '', size = '', path = ''] = match;
  const sizeBytes = Number.parseInt(size, 10);
  return {
    path,
    oid: requireOid(oid, `the object at ${path}`),
    mode: Number.parseInt(mode, 8),
    // Submodule ("commit") entries have no size of their own and report `-`.
    sizeBytes: Number.isInteger(sizeBytes) ? sizeBytes : null,
  };
}

const VERSION_PATTERN = /(\d+)\.(\d+)(?:\.(\d+))?/;

/**
 * `git --version` prints vendor noise on some platforms ("git version 2.50.1 (Apple
 * Git-155)"), so the reported version is the numeric part only — the thing a
 * capability check can actually compare.
 */
function parseGitVersion(output: string): { text: string; parts: readonly number[] } {
  const match = VERSION_PATTERN.exec(output);
  if (match === null) {
    throw new ExcavateError(
      'GIT_UNAVAILABLE',
      `could not read a version from ${JSON.stringify(output.trim().slice(0, 80))}`,
    );
  }
  const parts = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  return { text: parts.join('.'), parts };
}

function atLeast(parts: readonly number[], minimum: readonly [number, number]): boolean {
  const [major = 0, minor = 0] = parts;
  const [minMajor, minMinor] = minimum;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}
