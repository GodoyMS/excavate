import { describe, expect, it } from 'vitest';

import type { FixtureCase } from './index.js';
import {
  COMMIT_INTERVAL_SECONDS,
  DEFAULT_AUTHOR,
  DETERMINISTIC_EPOCH,
  FIXTURE_CASES,
  NotImplementedError,
  fixture,
  repo,
} from './index.js';

describe('determinism', () => {
  it('pins the clock, since a moving timestamp moves every OID', () => {
    expect(DETERMINISTIC_EPOCH).toBe(1_577_836_800);
    expect(new Date(DETERMINISTIC_EPOCH * 1000).toISOString()).toBe(
      '2020-01-01T00:00:00.000Z',
    );
    expect(COMMIT_INTERVAL_SECONDS).toBeGreaterThan(0);
  });

  it('uses a reserved TLD for the default author, so fixtures cannot email anyone', () => {
    expect(DEFAULT_AUTHOR.email).toMatch(/\.invalid$/);
  });
});

describe('the fixture matrix', () => {
  it('names every case exactly once', () => {
    expect(new Set(FIXTURE_CASES).size).toBe(FIXTURE_CASES.length);
  });

  it('keeps the trimmed matrix at the 24 cases the docs claim', () => {
    // LEAN-V1 §3.3 budgeted "~22"; the declared list is 24, and README.md and the
    // `FIXTURE_CASES` doc comment both say 24. Pinned exactly rather than as a lower
    // bound so that adding a case without updating those two places fails here.
    expect(FIXTURE_CASES.length).toBe(24);
  });

  it('rejects an unknown case name, listing the ones that exist', async () => {
    // The `FixtureCase` union makes this unreachable from TypeScript. The cast reproduces
    // the JavaScript caller a published package also has — and asserts the failure
    // arrives as a rejection, not as a synchronous throw from a promise-returning
    // function, which no `.catch()` could handle.
    const unknown = 'no-such-case' as unknown as FixtureCase;
    await expect(fixture(unknown)).rejects.toThrow(
      /unknown fixture case "no-such-case".*simple-linear/s,
    );
  });

  it('covers every rename form — the project’s top existential risk', () => {
    const renameForms = FIXTURE_CASES.filter((c) => c.startsWith('rename-'));
    expect(renameForms).toContain('rename-simple');
    expect(renameForms).toContain('rename-with-edit');
    expect(renameForms).toContain('rename-chain');
    expect(renameForms).toContain('rename-across-merge');
    expect(renameForms).toContain('rename-back');
    expect(FIXTURE_CASES).toContain('resurrection');
  });

  it('drops exactly the four cases LEAN-V1 §3.3 defers', () => {
    for (const dropped of ['lfs', 'submodule', 'case-only-rename', 'long-path']) {
      expect(FIXTURE_CASES).not.toContain(dropped);
    }
  });
});

describe('the M0.1 surface', () => {
  /**
   * The original M0.1 assertion here was `expect(() => repo()).toThrow(NotImplementedError)`
   * — correct for a stub, and by construction the one test that M0.3 must invert. The
   * shape it was pinning (a chainable builder returning a thenable) is preserved
   * without building anything on disk; `builder.test.ts` owns the end-to-end version of
   * the acceptance criterion.
   */
  it('declares the DSL shape the M0 acceptance criterion uses', () => {
    const builder = repo().commit('a', (c) => c.add('x.ts', '…'));
    expect(typeof builder.commit).toBe('function');
    expect(typeof builder.build).toBe('function');
    // Recording only: no repository exists until `build()` is awaited, which is what
    // makes `revert()` and `blameIgnore()` able to name commits by subject.
    expect(builder.commit('b')).toBe(builder);
  });

  it('still exports the stub marker, for constructs a later milestone adds', () => {
    expect(new NotImplementedError('x()').message).toMatch(/M0\.3/);
  });
});
