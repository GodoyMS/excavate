/**
 * `@excavate/ui` — the browser application.
 *
 * **Boundary rule B4: the UI computes nothing analytical.** It renders API responses.
 * Any scoring, ranking, or aggregation that happens here is a divergence between what
 * the GUI says and what the CLI and MCP say about the same repository — which is the
 * one inconsistency users will never forgive.
 *
 * This package targets a browser and depends only on `@excavate/core`, which is
 * possible because core has no `node:` imports and the API contract lives there. Its
 * tsconfig sets `types: []` so a stray Node import fails the build.
 *
 * M0.1 declares the surface. The shell, tokens, and components arrive in M3; the
 * Canvas2D renderer and Persistent Layout in M4. What exists today is the M0.4 walking
 * skeleton in `./skeleton.ts`, which is scaffolding rather than product.
 */

import type { LensId, ViewId } from '@excavate/core';
import { NotImplementedError } from '@excavate/core';

export { escapeHtml, skeletonPage } from './skeleton.js';
export type { SkeletonPageConfig } from './skeleton.js';

export interface AppConfig {
  /** Same-origin in normal operation; configurable for `vite dev` against a running daemon. */
  readonly apiBaseUrl: string;
  readonly token: string;
}

/**
 * URL is state (Part 12 §12.2.3). Every one of these is in the address bar, which is
 * what makes deep links, back/forward, and shareable views work — and it is
 * impossible to retrofit once views own their state locally.
 */
export interface AppState {
  readonly view: ViewId;
  readonly lens: LensId;
  /** The global time cursor. Scrubbing it updates every view. */
  readonly at: number | null;
  readonly selection: string | null;
}

export function mount(_root: Element, _config: AppConfig): () => void {
  throw new NotImplementedError('mount', 'M3');
}

/* ── The Map (M4) ──────────────────────────────────────────────────────────── */

/**
 * Canvas2D, not WebGL (LEAN-V1 §2.3). p90 of repositories is ~12,000 files, which
 * Canvas2D draws with a quadtree for picking at a comfortable 60fps in about 400
 * lines. WebGL is a later optimization behind a clean seam, not a v1 requirement.
 */
export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fileId: number;
}

/**
 * **Persistent Layout** — the actual differentiator, and orthogonal to the renderer.
 *
 * Positions are computed once over the union of all files that have *ever* existed,
 * then held fixed. Scrubbing time changes opacity and colour only. That is what makes
 * time-travel legible instead of a hairball seizure, and M4 asserts it numerically:
 * scrub the full history and no cell position may change.
 *
 * Children are ordered by path, never by size — a size ordering would make the layout
 * jump as soon as churn changed, defeating the whole guarantee.
 */
export function squarifiedTreemap(
  _entries: readonly {
    readonly fileId: number;
    readonly path: string;
    readonly weight: number;
  }[],
  _bounds: { readonly width: number; readonly height: number },
): readonly Cell[] {
  throw new NotImplementedError('squarifiedTreemap', 'M4');
}

/** Above this many files, aggregate to directory-level cells — a 40k-cell treemap is unreadable anyway. */
export const DIRECTORY_AGGREGATION_THRESHOLD = 15_000;
