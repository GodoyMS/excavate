import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { RepoSummary, ServerEvent, Tier } from '@excavate/core';
import {
  ExcavateError,
  NotImplementedError,
  TIERS,
  parseOid,
  repoId,
} from '@excavate/core';
import { createProgressBus } from '@excavate/server';
import { describe, expect, it, vi } from 'vitest';

import type { CliIo, CommandSpec, IndexableSession } from './index.js';
import { COMMANDS, indexWith, reportError, resolveArgv, run } from './index.js';

describe('the command surface', () => {
  it('keys every command by its own name', () => {
    for (const [key, spec] of Object.entries(COMMANDS)) {
      expect(spec.name).toBe(key);
    }
  });

  it('ships the two commands that make the CLI the early product', () => {
    // ROADMAP §1.1: `stats` at week 5 and `why` at week 8, both months before a UI.
    expect(COMMANDS.stats.since).toBe('M1');
    expect(COMMANDS.why.since).toBe('M2');
  });

  it('gives every command a usage line', () => {
    for (const spec of Object.values(COMMANDS)) {
      expect(spec.usage).toMatch(/^excavate/);
      expect(spec.summary.length).toBeGreaterThan(0);
    }
  });
});

describe('reportError', () => {
  const capture = (error: unknown): { code: number; lines: string[] } => {
    const lines: string[] = [];
    const code = reportError(error, (line) => lines.push(line));
    return { code, lines };
  };

  it('distinguishes "not built yet" from "failed"', () => {
    const notImplemented = capture(new NotImplementedError('excavate stats', 'M1'));
    expect(notImplemented.code).toBe(69);
    expect(notImplemented.lines[0]).toContain('M1');

    const failed = capture(new ExcavateError('NOT_A_REPOSITORY', 'no .git found'));
    expect(failed.code).toBe(1);
    expect(failed.lines[0]).toContain('NOT_A_REPOSITORY');
  });

  it('never leaks a stack trace for an unexpected throw', () => {
    const { code, lines } = capture(new TypeError('undefined is not a function'));
    expect(code).toBe(70);
    expect(lines[0]).toBe('excavate: unexpected error: undefined is not a function');
  });

  it('handles a non-Error throw', () => {
    expect(capture('boom').lines[0]).toContain('boom');
  });
});

/**
 * `excavate [path]` is resolved here rather than by a commander default command, so it
 * is tested here too — invoking `run([])` would start a daemon and never return.
 */
describe('resolveArgv', () => {
  it('reads a bare invocation as `open`, which is what the usage line promises', () => {
    expect(resolveArgv([])).toEqual(['open']);
  });

  it('reads an existing directory as a repository to open', () => {
    expect(resolveArgv(['.'])).toEqual(['open', '.']);
    expect(resolveArgv(['..', '--port', '0'])).toEqual(['open', '..', '--port', '0']);
  });

  it('leaves a command name, an option, and an unknown word for commander', () => {
    // The last one matters: `stat` must reach commander so it can suggest `stats`,
    // instead of being read as the name of a repository that does not exist.
    expect(resolveArgv(['stats', '--json'])).toEqual(['stats', '--json']);
    expect(resolveArgv(['--help'])).toEqual(['--help']);
    expect(resolveArgv(['stat'])).toEqual(['stat']);
  });

  /** `'toString' in COMMANDS` is true; `Object.hasOwn(COMMANDS, 'toString')` is not. */
  it('does not mistake an inherited object property for a command name', () => {
    const parent = mkdtempSync(join(tmpdir(), 'excavate-argv-'));
    try {
      const dir = join(parent, 'toString');
      mkdirSync(dir);
      expect(resolveArgv([dir])).toEqual(['open', dir]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a path that is not there rather than inventing a command', () => {
    expect(() => resolveArgv(['./no/such/checkout'])).toThrow(ExcavateError);
    expect(() => resolveArgv(['~/nope'])).toThrow(/NOT_A_REPOSITORY|not a directory/);
  });
});

/**
 * The indexing pipeline's terminal side, against a real `ProgressBus` and a stub
 * session. No repository, no store, no port: what is under test is that the CLI renders
 * the daemon's own events and never prints a completed-looking line for a failed run.
 */
describe('indexWith', () => {
  const summaryOf = (overrides: Partial<RepoSummary> = {}): RepoSummary => ({
    repoId: repoId('9f1c'),
    root: '/repo',
    headOid: parseOid('4f9c2ab'.padEnd(40, '0')),
    indexState: 'ready',
    commitCount: 1_600,
    personCount: 3,
    fileCount: 42,
    firstCommitAt: null,
    lastCommitAt: null,
    partial: null,
    ...overrides,
  });

  const streams = (): { io: CliIo; out: () => string; err: () => string } => {
    let out = '';
    let err = '';
    return {
      io: {
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
      },
      out: () => out,
      err: () => err,
    };
  };

  it("renders the walk's own events, then the summary, and asks for both tiers", async () => {
    const bus = createProgressBus();
    const { io, out } = streams();
    let requested: readonly Tier[] = [];

    const session: IndexableSession = {
      bus,
      summary: () => summaryOf(),
      ensureIndexed: (tiers) => {
        requested = tiers;
        bus.publish({
          type: 'index.progress',
          tier: 'metadata',
          done: 0,
          total: null,
          note: 'walking history',
        });
        bus.publish({
          type: 'index.progress',
          tier: 'metadata',
          done: 1_600,
          total: null,
        });
        bus.publish({
          type: 'index.progress',
          tier: 'analysis',
          done: 0,
          total: null,
          note: 'the analysis tier is not implemented before M1',
        });
        return Promise.resolve();
      },
    };

    await indexWith(session, io);

    expect([...requested].sort()).toEqual([...TIERS].sort());
    const lines = out().trimEnd().split('\n');
    expect(lines).toEqual([
      'metadata  walking history',
      'metadata  1,600 commits',
      'analysis  the analysis tier is not implemented before M1',
      '1,600 commits · 3 people · 42 files · head 4f9c2ab',
    ]);
  });

  it('puts a partial-index badge on stderr, where it cannot be piped away silently', async () => {
    const bus = createProgressBus();
    const { io, out, err } = streams();

    await indexWith(
      {
        bus,
        summary: () =>
          summaryOf({
            partial: { reason: 'interrupted', skipped: 'history after 1600 commits' },
          }),
        ensureIndexed: () => Promise.resolve(),
      },
      io,
    );

    expect(out()).toContain('1,600 commits');
    expect(err()).toContain('incomplete index');
    expect(err()).toContain('history after 1600 commits');
  });

  it('prints no summary line when indexing fails', async () => {
    const bus = createProgressBus();
    const { io, out } = streams();
    const boom = new ExcavateError('GIT_FAILED', 'git log exited 128');

    await expect(
      indexWith(
        {
          bus,
          summary: () => summaryOf(),
          ensureIndexed: () => Promise.reject(boom),
        },
        io,
      ),
    ).rejects.toBe(boom);

    // A closing count after a failed walk would read as a complete index.
    expect(out()).toBe('');
  });

  it('releases its bus subscription, so a later event writes nothing', async () => {
    const bus = createProgressBus();
    const { io, out } = streams();

    await indexWith(
      { bus, summary: () => summaryOf(), ensureIndexed: () => Promise.resolve() },
      io,
    );
    const afterIndexing = out();

    const stray: ServerEvent = {
      type: 'index.progress',
      tier: 'metadata',
      done: 99_999,
      total: null,
      note: 'nobody is listening',
    };
    bus.publish(stray);

    expect(out()).toBe(afterIndexing);
  });
});

/**
 * The argument surface only. Nothing here opens a session, touches a repository, or
 * starts the daemon: `index` and `open` are exercised at the integration level, and a
 * unit test that quietly bound a port would be worse than no test at all.
 */
describe('run', () => {
  /** Help wraps to the terminal width and may be colourised; neither is under test. */
  const plain = (text: string): string =>
    stripVTControlCharacters(text).replace(/\s+/g, ' ').trim();

  const invoke = async (
    argv: readonly string[],
  ): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await run(argv, {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    });
    return { code, out: plain(out), err: plain(err) };
  };

  it('documents every command, summary, and invocation in --help', async () => {
    const { code, out } = await invoke(['--help']);
    expect(code).toBe(0);
    for (const spec of Object.values(COMMANDS)) {
      expect(out).toContain(spec.name);
      expect(out).toContain(spec.summary);
      expect(out).toContain(spec.usage);
    }
  });

  it('reports the version recorded in the package manifest', async () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { readonly version: string };

    const { code, out } = await invoke(['--version']);
    expect(code).toBe(0);
    expect(out).toBe(pkg.version);
  });

  it('suggests the command a typo probably meant, and fails', async () => {
    const { code, err } = await invoke(['stat']);
    expect(code).not.toBe(0);
    expect(err).toContain("unknown command 'stat'");
    expect(err).toContain('stats');
  });

  it('says a path-shaped argument is not a directory, not "unknown command"', async () => {
    const { code, err } = await invoke(['./no/such/checkout']);
    expect(code).toBe(1);
    expect(err).toContain('NOT_A_REPOSITORY');
    expect(err).toContain('./no/such/checkout');
    expect(err).not.toContain('unknown command');
  });

  it('rejects an unknown option rather than ignoring it', async () => {
    const { code, err } = await invoke(['--depth=3']);
    expect(code).toBe(1);
    expect(err).toContain("unknown option '--depth=3'");
  });

  it('names the milestone rather than faking output for a command not yet built', async () => {
    const notYet: readonly { spec: CommandSpec; argv: readonly string[] }[] = [
      { spec: COMMANDS.stats, argv: ['stats'] },
      { spec: COMMANDS.why, argv: ['why', 'src/db.ts:142'] },
      { spec: COMMANDS.doctor, argv: ['doctor'] },
    ];

    for (const { spec, argv } of notYet) {
      const { code, out, err } = await invoke(argv);
      expect(code, `exit code for ${spec.name}`).toBe(69);
      expect(err).toContain(`excavate ${spec.name}`);
      expect(err).toContain(spec.since);
      expect(out).toBe('');
    }
  });

  it('explains the shape a why target must have when it is malformed', async () => {
    for (const target of ['src/db.ts', 'src/db.ts:0', 'src/db.ts:last', ':142']) {
      const { code, err } = await invoke(['why', target]);
      expect(code, `exit code for ${target}`).toBe(1);
      expect(err).toContain('INVALID_TARGET');
      expect(err).toContain('<path>:<line>');
    }
  });

  /**
   * Both cases must fail during parsing. Reaching the action would call `createServer`,
   * bind a port, and index this repository — so a regression here does not merely
   * mis-report, it hangs the suite.
   */
  it('validates the open port before anything is bound', async () => {
    for (const value of ['70000', 'abc', '-1', '1.5', '']) {
      const { code, err } = await invoke(['open', '--port', value]);
      expect(code, `exit code for --port ${value}`).toBe(1);
      expect(err).toContain('--port');
      expect(err).toContain('0–65535');
    }
  });

  /**
   * Help is the one place commander wants to exit the process. Every route into it has
   * to come back through `run` instead, on the root and on each subcommand, or the exit
   * code stops being the caller's to decide.
   */
  it('returns from every form of help rather than exiting', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit must not be called');
    });
    try {
      for (const argv of [
        ['--help'],
        ['-h'],
        ['help'],
        ['help', 'stats'],
        ['--version'],
        ['-V'],
        ['index', '--help'],
        ['open', '-h'],
        ['why', '--help'],
        ['stats', '--help'],
        ['doctor', '--help'],
      ]) {
        const { code, out } = await invoke(argv);
        expect(code, `exit code for ${argv.join(' ')}`).toBe(0);
        expect(out.length, `output for ${argv.join(' ')}`).toBeGreaterThan(0);
      }
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('leaves the exit code to the caller instead of calling process.exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit must not be called');
    });
    try {
      expect((await invoke(['--depth=3'])).code).toBe(1);
      expect((await invoke(['stat'])).code).toBe(1);
      expect((await invoke(['index', '--depth=3'])).code).toBe(1);
      expect((await invoke(['stats'])).code).toBe(69);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
