/**
 * `excavate` — the CLI.
 *
 * **The CLI is the early product** (ROADMAP §1.1). `excavate stats` and `excavate why`
 * need no UI and land months before one is possible, which is what lets the plan ship
 * something useful at week 5 instead of week 13.
 *
 * It is also the reason the daemon boundary is worth its one HTTP layer: every
 * subcommand here is the same typed API the browser and, later, `excavate mcp` speak.
 * Nothing analytical is computed in this package.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ExcavateError,
  NotImplementedError,
  TIERS,
  isExcavateError,
} from '@excavate/core';
import type { RepoSession } from '@excavate/server';
import { createServer, openSession } from '@excavate/server';
import { skeletonPage } from '@excavate/ui';
import { Command, CommanderError, InvalidArgumentError } from 'commander';

import {
  createIndexProgressPrinter,
  formatIndexSummary,
  formatPartialBadge,
} from './progress.js';

export type CommandName = 'index' | 'open' | 'stats' | 'why' | 'doctor';

export interface CommandSpec {
  readonly name: CommandName;
  readonly summary: string;
  readonly usage: string;
  /** The milestone that makes this command real. */
  readonly since: string;
}

/**
 * Ordered as a user meets them. `open` is what bare `excavate .` resolves to: index,
 * then open `127.0.0.1:<port>/?token=…` in the default browser — the way Jupyter,
 * Storybook, Vite, and `git instaweb` all work (LEAN-V1 §2.2).
 */
export const COMMANDS: Readonly<Record<CommandName, CommandSpec>> = {
  open: {
    name: 'open',
    summary: 'Index the repository and open it in your browser',
    usage: 'excavate [path]',
    since: 'M3',
  },
  index: {
    name: 'index',
    // Not "build or update": incremental update needs `detectUpdateKind`, which is M1.
    // Promising an update this release cannot perform is how a no-op reads as a success.
    summary: 'Build the index without opening anything',
    usage: 'excavate index [path]',
    since: 'M1',
  },
  stats: {
    name: 'stats',
    summary: 'Repo vitals, hotspots, and knowledge islands, in your terminal',
    usage: 'excavate stats [path] [--json]',
    since: 'M1',
  },
  why: {
    name: 'why',
    summary: 'Why does this line exist? A cited evidence chain, with no LLM',
    usage: 'excavate why <path>:<line> [--json]',
    since: 'M2',
  },
  doctor: {
    name: 'doctor',
    summary: 'Check environment, git version, index integrity, and disk space',
    usage: 'excavate doctor [path]',
    since: 'M6',
  },
};

/** Resolves `path:line` targets for `excavate why`. */
export interface LineTarget {
  readonly path: string;
  readonly line: number;
}

export function parseLineTarget(_spec: string): LineTarget {
  throw new NotImplementedError('parseLineTarget', 'M2');
}

/**
 * Where the CLI writes.
 *
 * Injectable so the argument surface can be tested without capturing the process's
 * streams, which is the difference between asserting on `--help` and hoping. Writers
 * take raw text, newlines included, because that is what `commander`'s
 * `configureOutput` hands over and re-splitting it would only lose information.
 */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const PROCESS_IO: CliIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/**
 * Read from the manifest rather than hard-coded, so `excavate --version` cannot drift
 * from the published package. Resolved relative to this module, which is correct both
 * from `dist/` and from source under vitest's alias. The fallback is deliberately not a
 * plausible version: a manifest that stopped being readable should fail a test, not
 * quietly report the wrong number.
 */
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { readonly version?: string };

const VERSION = manifest.version ?? '0.0.0-unknown';

/** 128 + the signal number, which is what a shell reports for a signalled child. */
const EXIT_ON_SIGNAL: Readonly<Record<'SIGINT' | 'SIGTERM', number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * Non-capturing, because only the shape is checked here — pulling the path and the line
 * apart is `parseLineTarget`'s job in M2, and two places that both split the spec is one
 * place too many. `.+` is greedy so a Windows `C:\src\db.ts:142` keeps its drive letter.
 */
const LINE_TARGET = /^.+:[1-9][0-9]*$/;

/**
 * Reject anything that cannot be a line target *before* the command runs, so
 * `excavate why src/db.ts` fails with the shape it wanted rather than a milestone
 * notice. Resolving a well-formed spec into a {@link LineTarget} is `parseLineTarget`'s
 * job and lands with the rest of `why` in M2; this only guards the shape.
 */
function assertLineTargetSpec(spec: string): string {
  if (!LINE_TARGET.test(spec)) {
    throw new ExcavateError(
      'INVALID_TARGET',
      `'${spec}' is not a line target, so there is nothing to explain. ` +
        `Expected <path>:<line>, for example src/server.ts:142.`,
    );
  }
  return spec;
}

/**
 * `InvalidArgumentError` rather than an `ExcavateError`: a port out of range is a
 * command-line mistake, not a domain condition, and commander's wrapping names the
 * offending flag for free.
 */
function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) > 65_535) {
    throw new InvalidArgumentError('expected 0–65535, where 0 picks a free port.');
  }
  return Number(value);
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    /* Unreadable or absent is simply "not a path we can open". */
    return false;
  }
}

/** A `/`, a `\`, a leading `~`, or bare `.`/`..` — an argument only a path would be. */
const PATH_SHAPED = /[/\\]|^~|^\.\.?$/;

/**
 * Make `excavate [path]` — the usage string `COMMANDS.open` advertises — true, without
 * making `open` a commander default command.
 *
 * A default command would swallow every typo: `excavate stat` would be read as a
 * repository called `stat`, and the best it could say is "not a repository" where
 * commander would have said "did you mean stats?". Resolving the ambiguity here keeps
 * both messages available and each pointed at the mistake the user actually made.
 * Command names win over a same-named directory, which is the only precedence a user
 * could predict.
 */
export function resolveArgv(argv: readonly string[]): string[] {
  const first = argv[0];
  if (first === undefined) return [COMMANDS.open.name];
  // `Object.hasOwn`, not `in`: `in` walks the prototype, so a directory called
  // `constructor` or `toString` would be mistaken for a command name.
  if (first.startsWith('-') || Object.hasOwn(COMMANDS, first)) return [...argv];
  if (isExistingDirectory(first)) return [COMMANDS.open.name, ...argv];
  if (PATH_SHAPED.test(first)) {
    throw new ExcavateError(
      'NOT_A_REPOSITORY',
      `${first} is not a directory, so there is nothing to open. ` +
        `Give a path to a Git repository, or run \`excavate\` inside one.`,
    );
  }
  return [...argv];
}

/**
 * What indexing needs from a session, and no more.
 *
 * `Pick` rather than a hand-written interface, so it stays welded to `RepoSession` — a
 * signature change over in `@excavate/server` is a type error here, not a surprise at
 * runtime. Narrowing it this far is also what lets {@link indexWith} be tested against a
 * real `ProgressBus` with no repository, no store, and no casts.
 */
export type IndexableSession = Pick<RepoSession, 'bus' | 'summary' | 'ensureIndexed'>;

/**
 * Both tiers, always. LEAN-V1 §3.3 trimmed indexing to `metadata` and `analysis`, and
 * a CLI that indexed only one of them would make every later command's cost
 * unpredictable.
 *
 * Progress comes off `session.bus` — the daemon's own event stream, the same one the SSE
 * route serves — so the terminal reports exactly what the walk reported and nothing it
 * inferred. The subscription is released in a `finally` because the session outlives
 * this call in `open`: a listener left bound would keep writing to a stdout nobody is
 * reading any more.
 *
 * The closing summary is printed *after* the `try`, deliberately: a failed index must
 * propagate without first printing a line that reads like a completed one.
 *
 * Exported for the test that asserts exactly that, which is the only way to prove the
 * bus wiring without starting a daemon.
 */
export async function indexWith(session: IndexableSession, io: CliIo): Promise<void> {
  const printer = createIndexProgressPrinter((line) => {
    io.out(`${line}\n`);
  });
  const unsubscribe = session.bus.subscribe((event) => {
    printer.observe(event);
  });
  try {
    await session.ensureIndexed(TIERS);
  } finally {
    unsubscribe();
  }
  const summary = session.summary();
  io.out(`${formatIndexSummary(summary)}\n`);
  // On stderr, not stdout: the honest-degradation contract of Part 7 §7.7 has to survive
  // `excavate index > log.txt`. A caveat that can be piped away silently is not a caveat.
  // This fires on every M0 run, because M0 never builds the analysis tier.
  if (summary.partial !== null) {
    io.err(`${formatPartialBadge(summary.partial)}\n`);
  }
}

async function runIndex(io: CliIo, path: string): Promise<void> {
  const session = await openSession({ repoRoot: resolve(path), port: 0 });
  // `session.root` rather than the argument: `discoverRepository` walks up to the
  // enclosing repository, so running this in `src/` indexes the root. Printing the
  // argument would name a directory that is not what was indexed.
  io.out(`${session.root}\n`);
  try {
    /* `ensureIndexed` is a no-op on a populated index — there is no incremental walk before
       M1, and re-walking would collide on every primary key. Saying so is the whole point:
       a command that printed a commit count and exited 0 without doing anything would be
       indistinguishable from one that had just indexed the repository, and the user would
       believe new commits had been picked up. */
    const before = session.store.commits.count();
    if (before > 0) {
      io.out(
        `already indexed — ${before.toLocaleString()} commits, nothing to do.\n` +
          `Incremental update lands in M1; until then delete the index directory to rebuild it.\n`,
      );
      return;
    }
    await indexWith(session, io);
  } finally {
    // `RepoSession` has no `close()`, so the store handle is the only lever there is.
    // `Store.close()` is a no-op on an already-closed handle.
    session.store.close();
  }
}

/**
 * `once`, not `on`: a second Ctrl-C during shutdown should reach Node's default
 * handler and kill the process. A daemon that ignores two interrupts is worse than one
 * that exits untidily.
 */
function waitForSignal(): Promise<'SIGINT' | 'SIGTERM'> {
  return new Promise((settle) => {
    const onInterrupt = (): void => {
      process.off('SIGTERM', onTerminate);
      settle('SIGINT');
    };
    const onTerminate = (): void => {
      process.off('SIGINT', onInterrupt);
      settle('SIGTERM');
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
  });
}

/**
 * The terminal handoff LEAN-V1 §2.2 asks for, and what `pnpm dev` runs.
 *
 * The URL is printed *before* indexing rather than after: the daemon is already
 * serving, so the browser can be open and watching progress instead of waiting on a
 * terminal. Launching that browser automatically is M3 (`COMMANDS.open.since`) —
 * until then the printed URL is the whole handoff, and it is deliberately the most
 * prominent line on screen.
 */
async function runOpen(io: CliIo, path: string, port: number): Promise<number> {
  /* The CLI is what decides which front end the daemon serves, and it is the only place
     that can be: ADR-0001 forbids a `server → ui` edge so that no browser code enters the
     daemon's type graph, and the daemon therefore takes its document as a string. That is
     the shape Part 7 §7.1 describes — the Tauri shell, `serve`, the CLI, and `mcp` are
     four presentation surfaces *above* one presentation-agnostic daemon.

     From M3 `@excavate/ui` is a real Vite bundle and this becomes a static directory to
     serve rather than a string to pass; the daemon's side of the seam does not change. */
  const server = await createServer({
    repoRoot: resolve(path),
    port,
    indexHtml: skeletonPage(),
  });
  try {
    io.out(`${server.session.root}\n\n    ${server.url}\n\n`);
    io.out('That URL carries a session token — treat it like a password.\n');
    io.out('Press Ctrl-C to stop.\n\n');
    await indexWith(server.session, io);
    const signal = await waitForSignal();
    io.out('\nstopping\n');
    return EXIT_ON_SIGNAL[signal];
  } finally {
    // `ExcavateServer.close()` closes the session's store as well as the listener, so
    // there is nothing else to release here.
    await server.close();
  }
}

/** Wired into the program so `--help` documents the real surface, and no further. */
function deferred(spec: CommandSpec): () => never {
  return () => {
    throw new NotImplementedError(`excavate ${spec.name}`, spec.since);
  };
}

/**
 * Built per call rather than module-scoped, because `commander` keeps parse state on
 * the command object; a shared program would leak options between invocations and make
 * the tests order-dependent.
 *
 * `exitOverride` is what keeps the exit code ours: without it commander calls
 * `process.exit` on a parse error and `run`'s return value stops meaning anything.
 */
function buildProgram(io: CliIo, outcome: { code: number }): Command {
  const program = new Command()
    .name('excavate')
    .description('Git tells you what changed. Excavate tells you why.')
    .version(VERSION)
    .exitOverride()
    .showHelpAfterError('(run `excavate --help` to see the commands)')
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .addHelpText(
      'after',
      [
        '',
        'Invocations:',
        ...Object.values(COMMANDS).map((spec) => `  ${spec.usage}`),
      ].join('\n'),
    );

  /**
   * Keyed by `CommandName`, so a command added to `COMMANDS` cannot be forgotten
   * here — the type is the checklist. Names, summaries, and milestones all come from
   * the table; only arguments, options, and behaviour live in code.
   */
  const configure: Readonly<Record<CommandName, (command: Command) => void>> = {
    open: (command) => {
      command
        .argument('[path]', 'Repository to open', '.')
        .option(
          '--port <number>',
          'Port to bind on 127.0.0.1; 0 picks a free one',
          parsePort,
          0,
        )
        .action(async (path: string, options: { readonly port: number }) => {
          outcome.code = await runOpen(io, path, options.port);
        });
    },
    index: (command) => {
      command
        .argument('[path]', 'Repository to index', '.')
        .action(async (path: string) => {
          await runIndex(io, path);
        });
    },
    stats: (command) => {
      command
        .argument('[path]', 'Repository to report on', '.')
        .option('--json', 'Emit the report as JSON instead of a table')
        .action(deferred(COMMANDS.stats));
    },
    why: (command) => {
      command
        .argument(
          '<target>',
          'The line to explain, as <path>:<line>',
          assertLineTargetSpec,
        )
        .option('--json', 'Emit the evidence chain as JSON')
        .action(deferred(COMMANDS.why));
    },
    doctor: (command) => {
      command
        .argument('[path]', 'Repository to check', '.')
        .action(deferred(COMMANDS.doctor));
    },
  };

  // `program.command()` rather than `addCommand()`: it copies the parent's
  // `exitOverride` and output configuration onto the subcommand, without which a
  // subcommand's own parse error would call `process.exit` and bypass `reportError`.
  for (const spec of Object.values(COMMANDS)) {
    configure[spec.name](program.command(spec.name).description(spec.summary));
  }

  return program;
}

/**
 * Returns the process exit code; `bin.ts` is what assigns it. Not calling
 * `process.exit` here is deliberate — it is the only reason the argument surface can be
 * asserted on in a test rather than in a subprocess.
 */
export async function run(
  argv: readonly string[],
  io: CliIo = PROCESS_IO,
): Promise<number> {
  // Long-running commands report their own code (Ctrl-C is not a failure but is not 0
  // either), and an action handler's return value is not visible to `parseAsync`.
  const outcome = { code: 0 };
  try {
    await buildProgram(io, outcome).parseAsync(resolveArgv(argv), { from: 'user' });
    return outcome.code;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help, version, and parse errors already wrote through `configureOutput`;
      // commander's own suggested code is the right one to hand back.
      return Number.isInteger(error.exitCode) ? error.exitCode : 1;
    }
    return reportError(error, (line) => {
      io.err(`${line}\n`);
    });
  }
}

/**
 * The single place a thrown error becomes terminal output. Keeping it here means every
 * subcommand can throw an `ExcavateError` and get a consistent, code-bearing message
 * rather than a stack trace.
 */
export function reportError(error: unknown, write: (line: string) => void): number {
  if (error instanceof NotImplementedError) {
    write(`excavate: ${error.message}`);
    return 69; // EX_UNAVAILABLE — the feature exists in the plan, not in this build.
  }
  if (isExcavateError(error)) {
    write(`excavate: ${error.code}: ${error.message}`);
    return 1;
  }
  write(
    `excavate: unexpected error: ${error instanceof Error ? error.message : String(error)}`,
  );
  return 70; // EX_SOFTWARE
}

export { ExcavateError };
