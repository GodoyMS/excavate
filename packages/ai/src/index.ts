/**
 * `@excavate/ai` — providers, pipelines, prompts, validator, budget.
 *
 * **Non-goals.** No retrieval. No scoring. No UI state.
 *
 * ---
 *
 * **Deliberate deviation from Part 14 §14.2, and the most important line in this
 * file: this package depends on `@excavate/core` and nothing else.**
 *
 * Part 14 had the AI crate depend on `evidence` and `store`. Boundary rule B3 — *"AI
 * never retrieves; all model input comes from an `EvidenceBundle`"* — was then a rule
 * enforced in code review. Removing both edges makes it a property of the dependency
 * graph instead: this package has no store handle, no repository access, and no
 * collector to call, so it *cannot* retrieve. A bundle goes in, validated prose comes
 * out.
 *
 * B3 and B5 are the two rules that make Excavate what it is (Part 7 §7.3). If either
 * erodes, the product becomes a repo-chat tool with extra steps — so the one that can
 * be made structural should be.
 *
 * The two capabilities that edge bought are replaced by ports the composition root
 * fills in: `GenerationCache` for response caching, and the caller passing bundles.
 */

import type { Confidence, EvidenceBundle, EvidenceId } from '@excavate/core';
import { NotImplementedError } from '@excavate/core';

/* ── Providers ─────────────────────────────────────────────────────────────── */

/**
 * Three providers, down from eight (LEAN-V1 §3.3). `openai-compatible` covers Ollama,
 * LM Studio, OpenRouter, OpenAI, and Groq in one adapter; `deterministic` is the
 * no-key path and is a first-class provider, not a fallback stub.
 */
export const PROVIDER_KINDS = [
  'anthropic',
  'openai-compatible',
  'deterministic',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Capability *descriptors* collapse to four booleans (LEAN-V1 §3.3). */
export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly promptCaching: boolean;
  /** A real `count_tokens` endpoint. Without it, pre-flight estimates are guesses. */
  readonly tokenCounting: boolean;
  readonly toolUse: boolean;
}

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface GenerateRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly signal: AbortSignal;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cache hits, when the provider reports them. Drives the CI cache-effectiveness assertion. */
  readonly cachedInputTokens: number;
}

export type ModelChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'done'; readonly usage: Usage };

export interface LanguageModel {
  readonly kind: ProviderKind;
  /** The concrete model this instance talks to. Configured, never hardcoded. */
  readonly modelId: string;
  capabilities(): ModelCapabilities;
  countTokens(request: GenerateRequest): Promise<number>;
  generate(request: GenerateRequest): AsyncIterable<ModelChunk>;
}

export interface ProviderConfig {
  readonly kind: ProviderKind;
  readonly modelId: string;
  /** Base URL for `openai-compatible`. Ignored otherwise. */
  readonly baseUrl?: string;
  /**
   * Resolved from the OS keychain at call time and never stored here, never written
   * to the index, never logged (Part 7 §7.4.2).
   */
  readonly apiKeyRef?: string;
}

export function createProvider(_config: ProviderConfig): LanguageModel {
  throw new NotImplementedError('createProvider', 'M7');
}

/**
 * The no-key path, as a provider.
 *
 * It renders the bundle's structured evidence directly — era names from deterministic
 * facts, Why answers as the evidence chain. Modelling it as a `LanguageModel` means
 * every pipeline has exactly one code path, so the offline path cannot rot: there is
 * no `if (hasApiKey)` branch to forget to test.
 */
export function createDeterministicProvider(): LanguageModel {
  throw new NotImplementedError('createDeterministicProvider', 'M7');
}

/* ── Prompts ───────────────────────────────────────────────────────────────── */

/**
 * Split so the provider can cache the invariant half. `static` is identical across
 * every request for a template version and goes first; `volatile` is the bundle. CI
 * asserts cache effectiveness, which is only possible because the split is explicit.
 */
export interface RenderedPrompt {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly static: string;
  readonly volatile: string;
}

/** Templates live in `prompts/<pipeline>/v<N>.md` and are versioned, never edited in place. */
export interface PromptRegistry {
  render(templateId: string, version: number, input: unknown): RenderedPrompt;
}

export function createPromptRegistry(_promptsDir: string): PromptRegistry {
  throw new NotImplementedError('createPromptRegistry', 'M7');
}

/* ── Pipelines ─────────────────────────────────────────────────────────────── */

/** Two pipelines, down from seven (LEAN-V1 §3.3). */
export const PIPELINE_IDS = ['era-narration', 'why-synthesis'] as const;
export type PipelineId = (typeof PIPELINE_IDS)[number];

export interface PipelineContext {
  readonly model: LanguageModel;
  readonly prompts: PromptRegistry;
  readonly validator: CitationValidator;
  readonly budget: BudgetMeter;
  readonly cache: GenerationCache;
  readonly signal: AbortSignal;
}

/**
 * Note the input type: a pipeline takes a bundle. There is no parameter through which
 * it could ask for more.
 */
export interface Pipeline<TInput, TOutput> {
  readonly id: PipelineId;
  run(input: TInput, ctx: PipelineContext): Promise<TOutput>;
}

/** Prose plus the verdict that let it be displayed. Never one without the other. */
export interface GeneratedProse {
  readonly text: string;
  readonly validation: ValidationResult;
  /** Possibly downgraded from the bundle's own confidence by a `downgrade` verdict. */
  readonly confidence: Confidence;
  readonly usage: Usage;
}

export const eraNarrationPipeline: Pipeline<readonly EvidenceBundle[], GeneratedProse> = {
  id: 'era-narration',
  run: () => {
    throw new NotImplementedError('eraNarrationPipeline', 'M7');
  },
};

export const whySynthesisPipeline: Pipeline<EvidenceBundle, GeneratedProse> = {
  id: 'why-synthesis',
  run: () => {
    throw new NotImplementedError('whySynthesisPipeline', 'M7');
  },
};

/**
 * A port, not a dependency. The composition root backs this with the store; tests
 * back it with a map. Either way this package never learns what SQL is.
 */
export interface GenerationCache {
  get(key: string): GeneratedProse | null;
  put(key: string, value: GeneratedProse): void;
}

/* ── Citation validation (Part 10 §10.6) ───────────────────────────────────── */

/**
 * What converts the citation contract from a prompt instruction into a guarantee.
 *
 * Roughly 150 lines, and LEAN-V1 §4.1 is blunt about its value: it "is the entire
 * difference between Excavate and a repo-chat wrapper." All four checks stay.
 */
/**
 * Run in this order, and all four ship (LEAN-V1 §4.1). Enumerated at runtime so the
 * count is asserted by a test rather than trusted to a code review.
 *
 * 1. `marker-syntax` — every sentence carries ≥1 `[E#]` marker; yields `citedRatio`.
 * 2. `referent-existence` — every referenced ID exists in the bundle that was sent. A
 *    hallucinated `[E9]` in a 5-item bundle is an immediate hard failure.
 * 3. `numeric-grounding` — every number in the prose (dates, counts, versions, PR
 *    numbers) appears in the cited evidence text. This catches the most damaging and
 *    most common failure mode: fluent, specific, invented detail.
 * 4. `entailment` — does `[E3]` actually support the sentence citing it? Sampled on
 *    high-stakes claims only, to control cost.
 */
export const CITATION_CHECKS = [
  'marker-syntax',
  'referent-existence',
  'numeric-grounding',
  'entailment',
] as const;
export type CitationCheck = (typeof CITATION_CHECKS)[number];

export type Verdict = 'accept' | 'downgrade' | 'reject';

export interface ValidationResult {
  /** Sentences with ≥1 marker, over total sentences. */
  readonly citedRatio: number;
  /** Markers not present in the bundle. Any entry forces `reject`. */
  readonly unknownIds: readonly EvidenceId[];
  /** Numbers in the prose absent from the cited evidence. Any entry forces `reject`. */
  readonly ungroundedNumerics: readonly string[];
  /** Sentence indices that failed the entailment spot-check. */
  readonly unsupported: readonly number[];
  readonly verdict: Verdict;
}

/** `accept` at or above this, with no unknown IDs and numerics grounded. */
export const ACCEPT_CITED_RATIO = 0.95;
/** `downgrade` at or above this; below it, `reject`. */
export const DOWNGRADE_CITED_RATIO = 0.7;

export interface CitationValidator {
  validate(prose: string, bundle: EvidenceBundle): ValidationResult;
}

export function createCitationValidator(): CitationValidator {
  throw new NotImplementedError('createCitationValidator', 'M7');
}

/**
 * `reject` discards the prose, renders the deterministic fallback, and records an
 * eval sample. A rising rejection rate for a template is a regression signal, so
 * rejections are counted rather than merely handled.
 */
export function isDisplayable(verdict: Verdict): boolean {
  return verdict !== 'reject';
}

/* ── Budget (Part 10 §10.7) ────────────────────────────────────────────────── */

export interface CostEstimate {
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
  readonly estimatedUsd: number;
}

/**
 * Pre-flight estimates come from a real `count_tokens` call where the provider offers
 * one; the runtime meter reads the `usage` fields. M7 requires the estimate to land
 * within 15% of actual across 20 runs.
 */
export interface BudgetMeter {
  estimate(request: GenerateRequest, model: LanguageModel): Promise<CostEstimate>;
  record(usage: Usage, model: LanguageModel): void;
  spentUsd(): number;
  /** `null` when no limit is configured. */
  remainingUsd(): number | null;
}

/** Below this, generation runs without asking. Above it, the user sees the estimate first. */
export const AUTO_APPROVE_USD = 0.05;

export function createBudgetMeter(_limitUsd: number | null): BudgetMeter {
  throw new NotImplementedError('createBudgetMeter', 'M7');
}
