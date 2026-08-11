/**
 * The security posture of Part 7 §7.4.2, in one file with no HTTP types in it so every
 * rule below is testable as a pure function.
 *
 * None of this is box-ticking. A localhost daemon holding a full index of proprietary
 * code is an attractive target, and it is reachable by anything running on the machine
 * — including a page in the user's browser. The three defences here are what stand
 * between "a tool you can run at work" and "a data-exfiltration primitive":
 * loopback-only binding (the `BIND_HOST` constant, enforced at the listener),
 * a 256-bit per-session token on every request, and a strict `Origin` allowlist.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { AUTH_SCHEME, BIND_HOST } from '@wise-excavate/core';

/** 32 bytes = 256 bits, per Part 7 §7.4.2. */
export const SESSION_TOKEN_BYTES = 32;

/**
 * `base64url` rather than hex: it is URL-safe with no percent-encoding, survives a
 * shell copy-paste unquoted, and is 43 characters instead of 64 for the same entropy.
 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time token comparison. A token check that leaks timing is a token check that
 * leaks the token.
 *
 * `timingSafeEqual` throws on a length mismatch, and the obvious fix — comparing
 * lengths first and returning early — leaks the token's length. Comparing fixed-size
 * SHA-256 digests instead makes every input the same width, so there is no early
 * return and no throw: unequal lengths simply produce unequal digests.
 */
export function isAuthorized(
  presented: string | null | undefined,
  expected: string,
): boolean {
  /* `undefined` is accepted as well as `null` even though the daemon's own callers
     normalise it away in `bearerToken`. `timingSafeEqual` throws on a non-string, and the
     one place this function is used is auth middleware — so an unnormalised caller would
     turn a request that should be a clean 401 into a thrown 500. A security predicate that
     can throw is a security predicate that fails open somewhere downstream, and the M3 dev
     proxy and M8's MCP transport are both future callers that have no reason to know that.
     An empty `expected` must never authorize anything, however it arose. */
  if (presented === null || presented === undefined || expected === '') return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Strict allowlist of the daemon's own two spellings.
 *
 * Validating `Origin` is what blocks DNS rebinding — the one attack a loopback-bound
 * server is genuinely exposed to, where a page on `evil.com` re-resolves that name to
 * 127.0.0.1 and then talks to the daemon with the user's ambient access. Note that the
 * comparison must be against the *known* loopback origin and never against the request's
 * own `Host` header: under rebinding the attacker controls `Host`, so a self-consistency
 * check would wave the attack through.
 *
 * A missing `Origin` is allowed. Non-browser clients — the CLI, `curl`, `excavate mcp`
 * — send none, and they are not the thing rebinding attacks; they still have to present
 * the token. The literal string `'null'` that a sandboxed or `file://` document sends is
 * not in the allowlist and is therefore rejected.
 */
export function isAllowedOrigin(origin: string | null, port: number): boolean {
  if (origin === null || origin === '') return true;
  return (
    origin === `http://${BIND_HOST}:${port}` || origin === `http://localhost:${port}`
  );
}

/**
 * Extract the credential from an `Authorization` header. The scheme is compared
 * case-insensitively because RFC 7235 says it is case-insensitive, and clients differ.
 */
export function bearerToken(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const separator = header.indexOf(' ');
  if (separator < 0) return null;
  if (header.slice(0, separator).toLowerCase() !== AUTH_SCHEME.toLowerCase()) return null;
  const value = header.slice(separator + 1).trim();
  return value === '' ? null : value;
}
