import { describe, expect, it } from 'vitest';

import {
  ACCEPT_CITED_RATIO,
  AUTO_APPROVE_USD,
  CITATION_CHECKS,
  DOWNGRADE_CITED_RATIO,
  PIPELINE_IDS,
  PROVIDER_KINDS,
  isDisplayable,
} from './index.js';

describe('the provider set', () => {
  it('ships three providers, down from eight', () => {
    expect(PROVIDER_KINDS).toEqual(['anthropic', 'openai-compatible', 'deterministic']);
  });

  it('treats the no-key path as a provider, not a fallback branch', () => {
    // Modelling `deterministic` as a LanguageModel is what gives every pipeline one
    // code path, so the offline path (rule B5) cannot rot untested.
    expect(PROVIDER_KINDS).toContain('deterministic');
  });
});

describe('the pipeline set', () => {
  it('ships two pipelines, down from seven', () => {
    expect(PIPELINE_IDS).toEqual(['era-narration', 'why-synthesis']);
  });
});

describe('the citation validator', () => {
  it('keeps all four checks', () => {
    expect(CITATION_CHECKS).toHaveLength(4);
    expect(CITATION_CHECKS).toContain('numeric-grounding');
  });

  it('sets accept strictly above the downgrade floor', () => {
    expect(ACCEPT_CITED_RATIO).toBe(0.95);
    expect(DOWNGRADE_CITED_RATIO).toBe(0.7);
    expect(DOWNGRADE_CITED_RATIO).toBeLessThan(ACCEPT_CITED_RATIO);
  });

  it('displays accepted and downgraded prose, never rejected', () => {
    expect(isDisplayable('accept')).toBe(true);
    expect(isDisplayable('downgrade')).toBe(true);
    expect(isDisplayable('reject')).toBe(false);
  });
});

describe('budget', () => {
  it('auto-approves only trivially cheap runs', () => {
    expect(AUTO_APPROVE_USD).toBe(0.05);
  });
});
