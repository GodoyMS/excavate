/**
 * Errors.
 *
 * One error type with an enumerated code, rather than a class hierarchy. Codes are
 * part of the API contract (Part 7 §7.4.3): they cross the daemon boundary, so the
 * UI and the CLI can branch on them without string-matching a message.
 */

export type ErrorCode =
  /* Repository and Git */
  | 'NOT_A_REPOSITORY'
  | 'GIT_UNAVAILABLE'
  | 'GIT_FAILED'
  | 'INVALID_OID'
  /* Index and store */
  | 'INDEX_CORRUPT'
  | 'SCHEMA_TOO_NEW'
  | 'MIGRATION_FAILED'
  | 'HISTORY_REWRITTEN'
  /* Query */
  | 'INVALID_TARGET'
  | 'NOT_FOUND'
  /* Daemon */
  | 'UNAUTHORIZED'
  | 'CANCELLED'
  /* AI — see Part 10. Every one of these has a deterministic fallback path. */
  | 'PROVIDER_UNAVAILABLE'
  | 'BUDGET_EXCEEDED'
  | 'UNCITED_OUTPUT'
  /**
   * A fault with no better description — a bug, not a condition. Distinct from
   * `GIT_FAILED` because attributing an internal error to git sends whoever is debugging
   * it to the wrong subsystem, and because a client cannot act on it the same way.
   */
  | 'INTERNAL'
  /* Scaffolding */
  | 'NOT_IMPLEMENTED';

export interface ExcavateErrorOptions extends ErrorOptions {
  /** Structured context. Must never contain repository content or API keys. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export class ExcavateError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options: ExcavateErrorOptions = {}) {
    super(message, options);
    this.name = 'ExcavateError';
    this.code = code;
    this.details = options.details ?? {};
  }
}

/**
 * Thrown by every M0.1 stub.
 *
 * Carrying the milestone makes the scaffold self-documenting: the failure tells you
 * where the implementation is scheduled rather than just that it is missing.
 */
export class NotImplementedError extends ExcavateError {
  readonly milestone: string;

  constructor(what: string, milestone: string) {
    super('NOT_IMPLEMENTED', `${what} is not implemented yet — lands in ${milestone}`);
    this.name = 'NotImplementedError';
    this.milestone = milestone;
  }
}

export function isExcavateError(value: unknown): value is ExcavateError {
  return value instanceof ExcavateError;
}

/** Serialisable shape for crossing the daemon boundary. */
export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (isExcavateError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}
