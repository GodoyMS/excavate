/**
 * The `repo()` DSL implementation.
 *
 * Two phases, deliberately: the builder methods only *record* steps, and `build()`
 * replays them against a real repository. That split is what makes `revert(subject)`
 * and `blameIgnore(subjects)` expressible — both need the OID of a commit the script
 * named earlier, which does not exist until the replay reaches it — and it is also
 * what lets one builder be built twice into two directories, which is how the
 * determinism test proves its point.
 *
 * Nothing here mocks git. Every construct goes through the real binary, so
 * `git log --numstat`, rename detection, `.mailmap`, and `git blame` behave in a
 * fixture exactly as they will in production. A fixture that lied about how git
 * behaves would be worse than no fixture at all.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { REPO_CONFIG, git, gitDate, gitLine, identityEnv, isolatedEnv } from './git.js';
import type { GitEnv, GitResult } from './git.js';
import type {
  CommitBuilder,
  FixtureRepo,
  Identity,
  MailmapEntry,
  MergeOptions,
  RepoBuilder,
  TagOptions,
} from './index.js';

/** The commit subject `mailmap()` uses. Fixed, so tests can name the commit. */
export const MAILMAP_COMMIT_SUBJECT = 'Add .mailmap';

/** The commit subject `blameIgnore()` uses. Fixed, for the same reason. */
export const BLAME_IGNORE_COMMIT_SUBJECT = 'Add .git-blame-ignore-revs';

/** The path git looks for when `blame.ignoreRevsFile` is set, by convention. */
export const BLAME_IGNORE_PATH = '.git-blame-ignore-revs';

/* ── Recorded steps ────────────────────────────────────────────────────────── */

type FileOp =
  | { readonly kind: 'add'; readonly path: string; readonly content: string }
  | {
      readonly kind: 'edit';
      readonly path: string;
      readonly content: string | ((previous: string) => string);
    }
  /** Internal upsert, used by `mailmap()` and `blameIgnore()`. Not on `CommitBuilder`. */
  | { readonly kind: 'write'; readonly path: string; readonly content: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'copy'; readonly from: string; readonly to: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'chmod'; readonly path: string; readonly mode: number }
  | { readonly kind: 'revert'; readonly subject: string };

/** An explicit instant plus the UTC offset to record with it, from `at()`. */
interface PinnedTime {
  readonly epochSeconds: number;
  readonly offset: string;
}

interface CommitSpec {
  readonly ops: FileOp[];
  readonly trailers: [string, string][];
  author: Identity | undefined;
  committer: Identity | undefined;
  at: PinnedTime | undefined;
  bodyText: string | undefined;
}

function emptySpec(ops: FileOp[] = []): CommitSpec {
  return {
    ops,
    trailers: [],
    author: undefined,
    committer: undefined,
    at: undefined,
    bodyText: undefined,
  };
}

type Step =
  | { readonly kind: 'commit'; readonly subject: string; readonly spec: CommitSpec }
  | { readonly kind: 'branch'; readonly name: string }
  | { readonly kind: 'checkout'; readonly name: string }
  | {
      readonly kind: 'merge';
      readonly branch: string;
      readonly options: MergeOptions | undefined;
    }
  | {
      readonly kind: 'tag';
      readonly name: string;
      readonly options: TagOptions | undefined;
    }
  | { readonly kind: 'mailmap'; readonly entries: readonly MailmapEntry[] }
  | { readonly kind: 'blameIgnore'; readonly subjects: readonly string[] };

/* ── Configuration handed in by `repo()` ───────────────────────────────────── */

/**
 * The clock and default identity, passed in rather than imported.
 *
 * `index.ts` owns the published constants; this module taking them as arguments keeps
 * the module graph acyclic (`index → builder → git`, never back), which matters
 * because a load-order cycle in the one package every other package's tests depend on
 * is an expensive bug to diagnose.
 */
export interface BuilderConfig {
  readonly name: string | undefined;
  readonly epochSeconds: number;
  readonly intervalSeconds: number;
  readonly defaultIdentity: Identity;
}

/* ── CommitBuilder ─────────────────────────────────────────────────────────── */

function identityFrom(name: string, email: string | undefined): Identity {
  if (email !== undefined) return { name, email };
  // A derived address keeps identity fixtures readable — `author('Ada Lovelace')`
  // yields `ada.lovelace@fixture.invalid` — while staying inside the reserved
  // `.invalid` TLD, so a fixture can never resolve to a real mailbox.
  const local = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return { name, email: `${local === '' ? 'anonymous' : local}@fixture.invalid` };
}

/**
 * Parse the `at()` argument.
 *
 * The offset is preserved rather than normalised to UTC because Part 8 §8.2.1 treats
 * the original offset as occasionally-meaningful evidence, and a corpus that always
 * said `+0000` could not exercise the code that reads it. An offset-less string is
 * rejected outright: it would mean local time, and local time means different OIDs on
 * different machines.
 */
function parsePinnedTime(iso: string): PinnedTime {
  const match = /(Z|[+-]\d{2}:?\d{2})$/.exec(iso);
  if (match === null) {
    throw new Error(
      `at(${JSON.stringify(iso)}): an ISO-8601 timestamp with an explicit offset is ` +
        `required (e.g. '2021-06-01T12:00:00Z' or '2021-06-01T12:00:00+02:00'); ` +
        `a local-time fixture would produce a different OID on every machine`,
    );
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new Error(`at(${JSON.stringify(iso)}): not a parseable ISO-8601 timestamp`);
  }
  const raw = match[1] ?? 'Z';
  return {
    epochSeconds: Math.floor(parsed / 1000),
    offset: raw === 'Z' ? '+0000' : raw.replace(':', ''),
  };
}

function createCommitBuilder(spec: CommitSpec): CommitBuilder {
  const builder: CommitBuilder = {
    add(path, content) {
      spec.ops.push({ kind: 'add', path, content });
      return builder;
    },
    edit(path, content) {
      spec.ops.push({ kind: 'edit', path, content });
      return builder;
    },
    rename(from, to) {
      spec.ops.push({ kind: 'rename', from, to });
      return builder;
    },
    copy(from, to) {
      spec.ops.push({ kind: 'copy', from, to });
      return builder;
    },
    delete(path) {
      spec.ops.push({ kind: 'delete', path });
      return builder;
    },
    chmod(path, mode) {
      spec.ops.push({ kind: 'chmod', path, mode });
      return builder;
    },
    revert(subject) {
      spec.ops.push({ kind: 'revert', subject });
      return builder;
    },
    author(name, email) {
      spec.author = identityFrom(name, email);
      return builder;
    },
    committer(name, email) {
      spec.committer = identityFrom(name, email);
      return builder;
    },
    at(iso) {
      spec.at = parsePinnedTime(iso);
      return builder;
    },
    body(text) {
      spec.bodyText = text;
      return builder;
    },
    trailer(key, value) {
      spec.trailers.push([key, value]);
      return builder;
    },
  };
  return builder;
}

/* ── Message assembly ──────────────────────────────────────────────────────── */

/**
 * Compose the commit message from subject, body, revert notice, and trailers.
 *
 * The revert notice is git's own wording — `This reverts commit <full oid>.` — because
 * that exact line is what tier-1 revert detection (Part 8 §8.5.3) parses. Producing it
 * here rather than letting `git revert` write the whole message is what lets a fixture
 * apply an inverse diff under a subject that does *not* announce itself as a revert,
 * which is exactly what the `revert-diff-inverse` case needs.
 */
function composeMessage(
  subject: string,
  spec: CommitSpec,
  revertedOids: readonly string[],
): string {
  const paragraphs: string[] = [subject];
  if (spec.bodyText !== undefined && spec.bodyText.trim() !== '') {
    paragraphs.push(spec.bodyText.trim());
  }
  for (const oid of revertedOids) {
    paragraphs.push(`This reverts commit ${oid}.`);
  }
  if (spec.trailers.length > 0) {
    paragraphs.push(spec.trailers.map(([key, value]) => `${key}: ${value}`).join('\n'));
  }
  return `${paragraphs.join('\n\n')}\n`;
}

/* ── The replay ────────────────────────────────────────────────────────────── */

interface ModeChange {
  readonly path: string;
  readonly executable: boolean;
}

class Replay {
  private readonly oids = new Map<string, string>();
  private readonly repoPath: string;
  private readonly config: BuilderConfig;
  private readonly baseEnv: GitEnv;
  private readonly homePath: string;
  private readonly hooksPath: string;
  private tick = 0;
  private lastTimestamp: string | undefined;

  constructor(repoPath: string, config: BuilderConfig) {
    this.repoPath = repoPath;
    this.config = config;
    // Both directories live *inside* `.git`, so they can never appear in a tree, in
    // `git status`, or in a `git add --all`. A sibling temp directory would work too
    // but would need cleaning up separately, and a forgotten one is a leak.
    this.homePath = join(repoPath, '.git', 'fixture-home');
    this.hooksPath = join(repoPath, '.git', 'fixture-hooks');
    this.baseEnv = isolatedEnv(this.homePath, dirname(repoPath));
  }

  private env(extra?: GitEnv): GitEnv {
    return extra === undefined ? this.baseEnv : { ...this.baseEnv, ...extra };
  }

  private run(args: readonly string[], extra?: GitEnv): string {
    return gitLine(args, { cwd: this.repoPath, env: this.env(extra) });
  }

  private tryRun(args: readonly string[], extra?: GitEnv): GitResult {
    return git(args, { cwd: this.repoPath, env: this.env(extra), allowFailure: true });
  }

  private nextTimestamp(pinned: PinnedTime | undefined): string {
    // The counter advances even when `at()` overrides the instant, so inserting an
    // explicitly-dated commit never shifts the timestamps of the commits after it.
    const generated = this.config.epochSeconds + this.tick * this.config.intervalSeconds;
    this.tick += 1;
    const stamp =
      pinned === undefined
        ? gitDate(generated)
        : gitDate(pinned.epochSeconds, pinned.offset);
    this.lastTimestamp = stamp;
    return stamp;
  }

  /**
   * The instant of the most recent commit, for tagging without advancing the clock.
   *
   * The *actual* last instant, remembered, rather than recomputed from the tick counter:
   * recomputing ignores `at()`, so an annotated tag placed after an explicitly-dated
   * commit was stamped with the generated time instead — which for a commit dated in the
   * future produces a tag object older than the commit it points at. Deterministic
   * either way, but a fixture whose tag predates its release is a confusing one to debug.
   */
  private currentTimestamp(): string {
    return this.lastTimestamp ?? gitDate(this.config.epochSeconds);
  }

  init(): void {
    mkdirSync(this.repoPath, { recursive: true });
    git(['init', '-b', 'main', '--quiet'], { cwd: this.repoPath, env: this.env() });
    mkdirSync(this.homePath, { recursive: true });
    mkdirSync(join(this.homePath, '.config'), { recursive: true });
    mkdirSync(this.hooksPath, { recursive: true });
    for (const [key, value] of REPO_CONFIG) {
      this.run(['config', key, value]);
    }
    // An empty directory rather than the null device: git only needs the path to hold
    // no executables. Without this, a global `core.hooksPath` in a developer's config
    // would run their hooks against every fixture.
    this.run(['config', 'core.hooksPath', this.hooksPath]);
  }

  step(step: Step): void {
    switch (step.kind) {
      case 'commit':
        this.commit(step.subject, step.spec);
        return;
      case 'branch':
        this.run(['checkout', '--quiet', '-b', step.name]);
        return;
      case 'checkout':
        this.run(['checkout', '--quiet', step.name]);
        return;
      case 'merge':
        this.merge(step.branch, step.options);
        return;
      case 'tag':
        this.tag(step.name, step.options);
        return;
      case 'mailmap':
        this.mailmap(step.entries);
        return;
      case 'blameIgnore':
        this.blameIgnore(step.subjects);
        return;
    }
  }

  finish(): ReadonlyMap<string, string> {
    return this.oids;
  }

  private register(subject: string, oid: string): void {
    const existing = this.oids.get(subject);
    if (existing !== undefined) {
      throw new Error(
        `duplicate commit subject ${JSON.stringify(subject)} in this fixture (already ` +
          `${existing.slice(0, 12)}). Subjects are the handles tests use to name ` +
          `commits, so a collision would silently shadow one of them — rename one.`,
      );
    }
    this.oids.set(subject, oid);
  }

  private resolveSubject(subject: string, calledFrom: string): string {
    const oid = this.oids.get(subject);
    if (oid === undefined) {
      const known = [...this.oids.keys()].map((s) => JSON.stringify(s)).join(', ');
      throw new Error(
        `${calledFrom}: no commit with subject ${JSON.stringify(subject)} has been ` +
          `built yet. Built so far: ${known === '' ? '(none)' : known}`,
      );
    }
    return oid;
  }

  private absolute(path: string): string {
    const full = resolve(this.repoPath, path);
    // Via `relative` rather than a `startsWith(repoPath + '/')` prefix test: that test
    // hardcodes the POSIX separator, so on Windows it rejects *every* path in the
    // fixture, and it would also accept a sibling directory whose name merely starts
    // with the repository's.
    const inside = relative(this.repoPath, full);
    // `=== '..'` and `'../'`, not `startsWith('..')`, so a file legitimately named
    // `..rc` is not mistaken for an escape.
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error(`path ${JSON.stringify(path)} escapes the fixture repository`);
    }
    return full;
  }

  private write(path: string, content: string): void {
    const full = this.absolute(path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }

  private commit(subject: string, spec: CommitSpec): void {
    const date = this.nextTimestamp(spec.at);
    const author = spec.author ?? this.config.defaultIdentity;
    const committer = spec.committer ?? author;
    const commitEnv = identityEnv(author, committer, date);

    const modeChanges: ModeChange[] = [];
    const revertedOids: string[] = [];
    const touchedFiles = spec.ops.length > 0;

    for (const op of spec.ops) {
      switch (op.kind) {
        case 'add': {
          if (existsSync(this.absolute(op.path))) {
            throw new Error(
              `commit ${JSON.stringify(subject)}: add(${JSON.stringify(op.path)}) but ` +
                `that path already exists — use edit() to change it`,
            );
          }
          this.write(op.path, op.content);
          break;
        }
        case 'edit': {
          const full = this.absolute(op.path);
          if (!existsSync(full)) {
            throw new Error(
              `commit ${JSON.stringify(subject)}: edit(${JSON.stringify(op.path)}) but ` +
                `that path does not exist — use add() to create it`,
            );
          }
          this.write(
            op.path,
            typeof op.content === 'string'
              ? op.content
              : op.content(readFileSync(full, 'utf8')),
          );
          break;
        }
        case 'write': {
          this.write(op.path, op.content);
          break;
        }
        case 'rename': {
          // A real `git mv`, so the index records the same intent a developer's would.
          // The resulting tree is identical to a delete plus an add of the same bytes —
          // rename detection is a property of `git diff`, not of storage — but going
          // through `git mv` means the fixture cannot drift from the command it claims
          // to model. `git mv` will not create the destination directory itself, and a
          // rename that moves a file into a new package is the common case.
          mkdirSync(dirname(this.absolute(op.to)), { recursive: true });
          this.run(['mv', '--', op.from, op.to]);
          break;
        }
        case 'copy': {
          const from = this.absolute(op.from);
          const to = this.absolute(op.to);
          // Both guards exist because `copyFileSync` is happy to do the wrong thing
          // quietly: a missing source raises a bare ENOENT that names no commit, and an
          // existing destination is *overwritten*, so a fixture author who meant to
          // create a file would silently have clobbered one and the history would not
          // show what the script says it shows. `add()` refuses the same way.
          if (!existsSync(from)) {
            throw new Error(
              `commit ${JSON.stringify(subject)}: copy(${JSON.stringify(op.from)}, ` +
                `${JSON.stringify(op.to)}) but the source does not exist`,
            );
          }
          if (existsSync(to)) {
            throw new Error(
              `commit ${JSON.stringify(subject)}: copy(${JSON.stringify(op.from)}, ` +
                `${JSON.stringify(op.to)}) but the destination already exists — use ` +
                `edit() to overwrite it deliberately`,
            );
          }
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to);
          break;
        }
        case 'delete': {
          this.run(['rm', '--quiet', '-f', '-r', '--', op.path]);
          break;
        }
        case 'chmod': {
          const full = this.absolute(op.path);
          if (!existsSync(full)) {
            throw new Error(
              `commit ${JSON.stringify(subject)}: chmod(${JSON.stringify(op.path)}) ` +
                `but that path does not exist`,
            );
          }
          chmodSync(full, op.mode);
          modeChanges.push({ path: op.path, executable: (op.mode & 0o111) !== 0 });
          break;
        }
        case 'revert': {
          const target = this.resolveSubject(
            op.subject,
            `commit ${JSON.stringify(subject)}: revert(${JSON.stringify(op.subject)})`,
          );
          // `--no-commit` applies the inverse patch and stages it without committing,
          // which leaves the message entirely to `composeMessage`.
          this.run(['revert', '--no-edit', '--no-commit', target], commitEnv);
          revertedOids.push(target);
          break;
        }
      }
    }

    if (touchedFiles) {
      this.run(['add', '--all', '--', '.']);
    }
    for (const change of modeChanges) {
      // Belt and braces behind `core.fileMode`: on a filesystem that does not report
      // the execute bit, a `chmod()` fixture would otherwise record mode 100644 and the
      // failure would look like a bug in the code under test.
      this.run([
        'update-index',
        '--add',
        change.executable ? '--chmod=+x' : '--chmod=-x',
        '--',
        change.path,
      ]);
    }

    const args = [
      'commit',
      '--quiet',
      '--no-verify',
      '--no-gpg-sign',
      '-m',
      composeMessage(subject, spec, revertedOids),
    ];
    if (!touchedFiles) {
      // Only a commit that declared no operations may be empty. One that declared some
      // and produced no change is a bug in the fixture script, and git failing loudly
      // is the outcome we want.
      args.push('--allow-empty');
    }
    this.run(args, commitEnv);
    this.register(subject, this.run(['rev-parse', 'HEAD']));
  }

  private merge(branch: string, options: MergeOptions | undefined): void {
    const before = this.run(['rev-parse', 'HEAD']);
    const subject = options?.subject ?? `Merge branch '${branch}'`;
    const commitEnv = identityEnv(
      this.config.defaultIdentity,
      this.config.defaultIdentity,
      this.nextTimestamp(undefined),
    );

    const args = ['merge', '--no-edit', '--no-verify', '--no-gpg-sign'];
    if (options?.noFastForward === true) args.push('--no-ff');
    args.push('-m', subject, branch);

    const attempt = this.tryRun(args, commitEnv);
    if (attempt.status !== 0) {
      this.resolveConflicts(branch, attempt);
      this.run(
        ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', subject],
        commitEnv,
      );
    }

    const after = this.run(['rev-parse', 'HEAD']);
    const parents = this.run(['show', '-s', '--format=%P', 'HEAD']).split(/\s+/);
    const isMergeCommit = after !== before && parents.length > 1;
    // `--no-ff` promises a merge commit. If one was not created the merge was a no-op
    // ("Already up to date"), which means the fixture script's two branches were not
    // actually divergent — a script bug. Failing here, at the step that caused it, beats
    // failing much later in a test with `oid("Merge branch 'x'") threw`.
    if (options?.noFastForward === true && !isMergeCommit) {
      throw new Error(
        `merge(${JSON.stringify(branch)}, { noFastForward: true }) created no merge ` +
          `commit — HEAD is still ${after.slice(0, 12)}. The branch was already ` +
          `reachable from HEAD, so there was nothing to merge. Commit on both sides ` +
          `before merging.`,
      );
    }
    // A fast-forward creates no commit, so there is nothing to give a handle to.
    // Registering `after` under the merge subject would alias a commit that already has
    // one and make `oid()` ambiguous about which commit a test meant.
    if (isMergeCommit) {
      this.register(subject, after);
    }
  }

  /**
   * Resolve a conflicted merge deterministically: take stage 2 ("ours") where it
   * exists, otherwise stage 3 ("theirs"), otherwise remove the path.
   *
   * A fixed rule rather than a per-fixture choice. What matters about
   * `merge-conflicting-rename` is the *shape* of the history it leaves behind — a
   * rename/rename(1to2) resolved with both destinations live — and a rule that never
   * asks for human judgement is a rule that cannot make a fixture non-deterministic.
   */
  private resolveConflicts(branch: string, failed: GitResult): void {
    const raw = git(['ls-files', '--unmerged', '-z'], {
      cwd: this.repoPath,
      env: this.env(),
    }).stdout;

    const stages = new Map<string, Set<string>>();
    for (const record of raw.split('\0')) {
      if (record === '') continue;
      // `<mode> <oid> <stage>\t<path>`. Split on the *first* tab only: `-z` does not
      // quote paths, so a path containing a tab would otherwise be silently truncated
      // and its conflict left unresolved.
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const stage = record.slice(0, tab).split(' ')[2];
      const path = record.slice(tab + 1);
      if (stage === undefined || path === '') continue;
      const seen = stages.get(path) ?? new Set<string>();
      seen.add(stage);
      stages.set(path, seen);
    }
    if (stages.size === 0) {
      // Not a conflict at all: `git merge` failed for some other reason (an unknown
      // branch, unrelated histories, a dirty worktree). The original diagnostic is the
      // only thing that explains it, so it must not be dropped on the floor.
      const detail = [failed.stderr.trim(), failed.stdout.trim()]
        .filter((part) => part !== '')
        .join('\n');
      throw new Error(
        `merge(${JSON.stringify(branch)}) failed with status ${failed.status} and left ` +
          `no unmerged paths, so this is a failed command rather than a conflict to ` +
          `resolve:\n${detail === '' ? '(git printed nothing)' : detail}`,
      );
    }

    for (const [path, present] of stages) {
      const stage = present.has('2') ? '2' : present.has('3') ? '3' : undefined;
      if (stage === undefined) {
        this.run(['rm', '--quiet', '-f', '--', path]);
        continue;
      }
      this.run(['checkout-index', '-f', `--stage=${stage}`, '--', path]);
      this.run(['add', '--', path]);
    }
  }

  private tag(name: string, options: TagOptions | undefined): void {
    // Tags reuse the last commit's instant rather than consuming a clock tick, so
    // adding a tag to a fixture never shifts the commits after it.
    const env = identityEnv(
      this.config.defaultIdentity,
      this.config.defaultIdentity,
      this.currentTimestamp(),
    );
    if (options?.annotated === true) {
      this.run(
        ['tag', '--annotate', '--no-sign', '-m', options.message ?? name, name],
        env,
      );
      return;
    }
    this.run(['tag', name], env);
  }

  private mailmap(entries: readonly MailmapEntry[]): void {
    const content = `${entries
      .map(
        ({ canonical, alias }) =>
          `${canonical.name} <${canonical.email}> ${alias.name} <${alias.email}>`,
      )
      .join('\n')}\n`;
    this.commit(
      MAILMAP_COMMIT_SUBJECT,
      emptySpec([{ kind: 'write', path: '.mailmap', content }]),
    );
  }

  private blameIgnore(subjects: readonly string[]): void {
    const content = subjects
      .map((subject) => {
        const oid = this.resolveSubject(
          subject,
          `blameIgnore(${JSON.stringify(subject)})`,
        );
        return `# ${subject}\n${oid}\n`;
      })
      .join('');
    this.commit(
      BLAME_IGNORE_COMMIT_SUBJECT,
      emptySpec([{ kind: 'write', path: BLAME_IGNORE_PATH, content }]),
    );
    // `blame.ignoreRevsFile` is deliberately *not* configured in the repository. Real
    // projects commit the file and ask developers to opt in, and more importantly:
    // honouring it is the behaviour under test (M2 blame). A fixture that switched it
    // on in local config would silently do the job for the code and make a blame
    // collector that forgot the flag still pass.
  }
}

/* ── RepoBuilder ───────────────────────────────────────────────────────────── */

function slug(name: string | undefined): string {
  if (name === undefined) return 'repo';
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'repo' : cleaned.slice(0, 40);
}

function makeFixtureRepo(
  path: string,
  oids: ReadonlyMap<string, string>,
  keep: boolean,
): FixtureRepo {
  return {
    path,
    oids,
    oid(subject) {
      const found = oids.get(subject);
      if (found === undefined) {
        const known = [...oids.keys()].map((s) => `  ${JSON.stringify(s)}`).join('\n');
        throw new Error(
          `unknown fixture commit subject ${JSON.stringify(subject)}.\n` +
            `Known subjects:\n${known === '' ? '  (none)' : known}`,
        );
      }
      return found;
    },
    async cleanup() {
      if (keep) return;
      // `force` so a second call — or a directory the test already removed — is a
      // no-op rather than an exception thrown out of someone's `finally` block.
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export function createRepoBuilder(config: BuilderConfig): RepoBuilder {
  const steps: Step[] = [];

  const builder: RepoBuilder = {
    commit(subject, build) {
      const spec = emptySpec();
      if (build !== undefined) build(createCommitBuilder(spec));
      steps.push({ kind: 'commit', subject, spec });
      return builder;
    },
    branch(name) {
      steps.push({ kind: 'branch', name });
      return builder;
    },
    checkout(name) {
      steps.push({ kind: 'checkout', name });
      return builder;
    },
    merge(branch, options) {
      steps.push({ kind: 'merge', branch, options });
      return builder;
    },
    tag(name, options) {
      steps.push({ kind: 'tag', name, options });
      return builder;
    },
    mailmap(entries) {
      steps.push({ kind: 'mailmap', entries });
      return builder;
    },
    blameIgnore(subjects) {
      steps.push({ kind: 'blameIgnore', subjects });
      return builder;
    },
    async build(options) {
      const keep = options?.keep === true;
      const explicit = options?.path;
      const requested =
        explicit ?? mkdtempSync(join(tmpdir(), `excavate-${slug(config.name)}-`));
      mkdirSync(requested, { recursive: true });
      // Resolve symlinks up front: on macOS `os.tmpdir()` is under `/var`, a symlink to
      // `/private/var`, and git reports the resolved form. A test comparing
      // `fixture.path` with git's own output would fail on that difference alone.
      const path = realpathSync(requested);
      const replay = new Replay(path, config);
      try {
        replay.init();
        for (const step of steps) {
          replay.step(step);
          /**
           * Yield to the event loop between commits.
           *
           * Every git call here is `spawnSync`, which is right for the DSL — construction is
           * strictly sequential and synchronous keeps stack traces on the offending line — but it
           * means a large fixture blocks its thread for tens of seconds without interruption. Under
           * vitest that thread is also the one answering the reporter's RPC, so the run dies with
           * `[vitest-worker]: Timeout calling "onTaskUpdate"` while **every test passes and the
           * exit code is 1**: a green suite and a red build, which reads as flake and gets re-run
           * rather than read.
           *
           * `pool: 'forks'` in `vitest.config.js` stops one test file starving another's RPC, but
           * nothing stops a file starving its own — which is what a 240-commit fixture does. One
           * macrotask turn per commit is enough for the ping to be answered, and it costs nothing
           * measurable next to a `git commit`. Making `git()` itself async would also work and is
           * the larger fix, but `git` is exported from a published package and that is a breaking
           * change for no gain in the DSL's ergonomics.
           */
          await new Promise((resolve) => {
            setImmediate(resolve);
          });
        }
      } catch (cause) {
        // A build that throws never returns a `FixtureRepo`, so the caller has no
        // `cleanup()` to call and the directory would leak for the life of the machine.
        // A caller-supplied path is left alone: it is theirs, and deleting it would be
        // the more surprising behaviour.
        if (explicit === undefined && !keep) {
          rmSync(path, { recursive: true, force: true });
          if (cause instanceof Error) {
            // The path is named even though it is gone: it is the only handle on *which*
            // build failed when several are running, and it tells you exactly what
            // `{ keep: true }` would have left behind.
            cause.message +=
              `\n(the fixture directory ${path} was removed; rerun with ` +
              `build({ keep: true }) to inspect it)`;
          }
        }
        throw cause;
      }
      return makeFixtureRepo(path, replay.finish(), keep);
    },
  };

  return builder;
}
