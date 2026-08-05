import { describe, expect, it } from 'vitest';

import {
  ERA_DIMENSIONS,
  EXCERPT_MAX_CHARS,
  ExcavateError,
  LENSES,
  NotImplementedError,
  TIERS,
  compareTimestamps,
  evidenceId,
  isExcavateError,
  isOid,
  parseAbbreviatedOid,
  parseOid,
  shortOid,
  timeWindow,
  timestamp,
  toErrorPayload,
  toIsoWithOffset,
  windowContains,
} from './index.js';

const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('object ids', () => {
  it('accepts full sha-1 and sha-256 hashes', () => {
    expect(isOid(SHA1)).toBe(true);
    expect(isOid('0'.repeat(64))).toBe(true);
  });

  it('rejects abbreviations, uppercase, and wrong lengths', () => {
    expect(isOid('a1b2c3d')).toBe(false);
    expect(isOid(SHA1.toUpperCase())).toBe(false);
    expect(isOid('0'.repeat(41))).toBe(false);
    expect(() => parseOid('a1b2c3d')).toThrow(TypeError);
  });

  it('keeps abbreviations in a separate type, since resolving one needs the repo', () => {
    expect(parseAbbreviatedOid('a1b2c3d')).toBe('a1b2c3d');
    expect(() => parseAbbreviatedOid('xyz')).toThrow(TypeError);
  });

  it('abbreviates for display at git default length', () => {
    expect(shortOid(parseOid(SHA1))).toBe('a1b2c3d');
    expect(shortOid(parseOid(SHA1), 12)).toBe('a1b2c3d4e5f6');
  });
});

describe('evidence ids', () => {
  it('is 1-based, matching the E1..En citations users see', () => {
    expect(evidenceId(1)).toBe('E1');
    expect(evidenceId(12)).toBe('E12');
  });

  it('rejects ordinals that would produce an uncitable id', () => {
    expect(() => evidenceId(0)).toThrow(RangeError);
    expect(() => evidenceId(1.5)).toThrow(RangeError);
  });
});

describe('timestamps', () => {
  /** 2021-08-14T00:00:00Z — the date of the retry-with-jitter commit in the spec's demo. */
  const AUG_14_2021 = 1_628_899_200;

  it('renders in the original offset rather than normalising to UTC', () => {
    expect(toIsoWithOffset(timestamp(AUG_14_2021, 0))).toBe('2021-08-14T00:00:00Z');
    expect(toIsoWithOffset(timestamp(AUG_14_2021, 120))).toBe(
      '2021-08-14T02:00:00+02:00',
    );
    expect(toIsoWithOffset(timestamp(AUG_14_2021, -480))).toBe(
      '2021-08-13T16:00:00-08:00',
    );
  });

  it('handles half-hour offsets', () => {
    expect(toIsoWithOffset(timestamp(AUG_14_2021, 330))).toBe(
      '2021-08-14T05:30:00+05:30',
    );
  });

  it('orders by instant, never by offset', () => {
    const utc = timestamp(AUG_14_2021, 0);
    const sameInstantElsewhere = timestamp(AUG_14_2021, -480);
    expect(compareTimestamps(utc, sameInstantElsewhere)).toBe(0);
    expect(compareTimestamps(utc, timestamp(AUG_14_2021 + 1, 0))).toBeLessThan(0);
  });

  it('validates its inputs', () => {
    expect(() => timestamp(Number.NaN)).toThrow(RangeError);
    expect(() => timestamp(0, 24 * 60 + 1)).toThrow(RangeError);
  });
});

describe('time windows', () => {
  const a = timestamp(100);
  const b = timestamp(200);

  it('is half-open, so adjacent eras partition history without overlap', () => {
    const window = timeWindow(a, b);
    expect(windowContains(window, a)).toBe(true);
    expect(windowContains(window, timestamp(199))).toBe(true);
    expect(windowContains(window, b)).toBe(false);
  });

  it('rejects an inverted window', () => {
    expect(() => timeWindow(b, a)).toThrow(RangeError);
  });
});

describe('errors', () => {
  it('carries a code across the daemon boundary', () => {
    const error = new ExcavateError('NOT_A_REPOSITORY', 'no .git found', {
      details: { path: '/tmp/x' },
    });
    expect(isExcavateError(error)).toBe(true);
    expect(toErrorPayload(error)).toEqual({
      code: 'NOT_A_REPOSITORY',
      message: 'no .git found',
      details: { path: '/tmp/x' },
    });
  });

  it('names the milestone that fills in each stub', () => {
    const error = new NotImplementedError('CliGitBackend.blame', 'M2');
    expect(error.code).toBe('NOT_IMPLEMENTED');
    expect(error.milestone).toBe('M2');
    expect(error.message).toContain('M2');
  });

  it('normalises a non-Excavate throw', () => {
    expect(toErrorPayload(new Error('boom')).message).toBe('boom');
    expect(toErrorPayload('boom').message).toBe('boom');
  });
});

describe('the lean cuts are asserted, not just documented', () => {
  it('ships 5 lenses — Complexity was dropped for overlapping Hotspot', () => {
    expect(LENSES).toHaveLength(5);
    expect(LENSES).not.toContain('complexity');
  });

  it('ships 2 indexing tiers, not 4', () => {
    expect(TIERS).toEqual(['metadata', 'analysis']);
  });

  it('detects eras over 5 dimensions, not 10', () => {
    expect(ERA_DIMENSIONS).toHaveLength(5);
  });

  it('caps excerpts so a bundle stays budget-fittable', () => {
    expect(EXCERPT_MAX_CHARS).toBe(400);
  });
});
