import { describe, expect, it } from 'vitest';

import { COLLECTORS, COLLECTOR_IDS } from './index.js';

describe('the collector registry', () => {
  it('ships exactly six collectors', () => {
    // LEAN-V1 §3.3 trims ten to six. If this number grows, it should grow because
    // someone decided to add a collector — not because one crept in.
    expect(COLLECTORS).toHaveLength(6);
  });

  it('registers every declared collector exactly once', () => {
    const ids = COLLECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...Object.values(COLLECTOR_IDS)].sort());
  });

  it('does not include the four collectors deferred past v1', () => {
    const ids = new Set<string>(COLLECTORS.map((c) => c.id));
    for (const deferred of [
      'co-change',
      'doc-change',
      'adjacent-comment',
      'dependency-change',
      'forge',
      'szz',
    ]) {
      expect(ids).not.toContain(deferred);
    }
  });
});
