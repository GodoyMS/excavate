/**
 * `@excavate/core` — depth 0.
 *
 * Everything depends on this package, so this package depends on nothing. The rule
 * from Part 14 §14.2 carries over verbatim: every dependency core takes is a
 * dependency *everything* takes. It has no runtime dependencies and imports no
 * `node:*` builtin, which is also what lets `@excavate/ui` consume it in a browser.
 *
 * `scripts/check-deps.mjs` enforces both halves of that.
 */

export * from './api.js';
export * from './entities.js';
export * from './errors.js';
export * from './ids.js';
export * from './time.js';
export * from './vocabulary.js';
