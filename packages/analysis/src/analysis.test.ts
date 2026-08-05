import { describe, expect, it } from 'vitest';

import {
  ANALYZERS,
  ANALYZER_IDS,
  COUPLING_MAX_FILES_PER_COMMIT,
  MAX_ERAS,
  MIN_ERAS,
} from './index.js';

describe('the analyzer registry', () => {
  it('registers every declared analyzer exactly once', () => {
    const declared = Object.values(ANALYZER_IDS);
    const registered = ANALYZERS.map((a) => a.id);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...declared].sort());
  });

  it('starts every analyzer at version 1, since version bumps drive invalidation', () => {
    for (const analyzer of ANALYZERS) {
      expect(analyzer.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('declares dependencies only on analyzers that exist', () => {
    const known = new Set(ANALYZERS.map((a) => a.id));
    for (const analyzer of ANALYZERS) {
      for (const dependency of analyzer.dependsOn) {
        expect(known).toContain(dependency);
      }
    }
  });

  it('is ordered so every dependency appears before its dependent', () => {
    const seen = new Set<string>();
    for (const analyzer of ANALYZERS) {
      for (const dependency of analyzer.dependsOn) {
        expect(seen).toContain(dependency);
      }
      seen.add(analyzer.id);
    }
  });

  it('declares no dependency cycles', () => {
    const byId = new Map(ANALYZERS.map((a) => [a.id as string, a] as const));
    const visit = (id: string, stack: readonly string[]): void => {
      expect(stack).not.toContain(id);
      for (const dependency of byId.get(id)?.dependsOn ?? []) {
        visit(dependency, [...stack, id]);
      }
    };
    for (const analyzer of ANALYZERS) visit(analyzer.id, []);
  });
});

describe('tuning constants that encode a design decision', () => {
  it('excludes codemods from coupling, or everything couples to everything', () => {
    expect(COUPLING_MAX_FILES_PER_COMMIT).toBe(30);
  });

  it('targets the 3–12 segment range where binary segmentation matches PELT', () => {
    expect(MIN_ERAS).toBe(3);
    expect(MAX_ERAS).toBe(12);
    expect(MIN_ERAS).toBeLessThan(MAX_ERAS);
  });
});
