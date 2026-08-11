/**
 * Person identity resolution — the five-step ladder of Part 8 §8.3.1.
 *
 * **Why this is one of the two hard problems in the project.** Ownership, bus factor, and
 * knowledge islands are all arithmetic over *people*. Get identity wrong and one engineer
 * becomes three, every bus factor triples, and the report is confidently, invisibly wrong.
 * There is no error to notice — which is why M0 shipped a deliberate one-person-per-email
 * fake rather than a half-real version, and why every rule below records *how* it merged.
 *
 * The ladder, earlier wins:
 *
 * 1. **`.mailmap`** — the repository's own declaration. Always authoritative.
 * 2. **Exact email**, case-insensitively.
 * 3. **Normalised email** — strip `+tag`, unify Gmail dots, unwrap GitHub noreply.
 * 4. **Same normalised name and same email domain** — catches `dana@corp.com` versus
 *    `d.rivera@corp.com` where the human name matches.
 * 5. **Heuristic**: high name similarity *plus* non-overlapping activity windows. Marked
 *    as such, and reversible in the UI, because this is the one rule that guesses.
 *
 * **What is deliberately never merged:** identical names with unrelated emails whose
 * activity windows *overlap*. That is two people called Chen, and merging them would be
 * the worst kind of wrong — plausible, and destructive of exactly the data the product
 * exists to report.
 */

import type {
  Identity,
  MergeSource,
  Person,
  PersonId,
  Timestamp,
} from '@wise-excavate/core';
import { compareTimestamps, personId } from '@wise-excavate/core';
import type { Mailmap } from '@wise-excavate/git';

/* ── Email normalisation ───────────────────────────────────────────────────── */

/** `1234567+octocat@users.noreply.github.com` and `octocat@users.noreply.github.com`. */
const GITHUB_NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;

/** Providers where `a.b@x` and `ab@x` are the same mailbox. */
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The canonical form of an email for comparison purposes.
 *
 * Note what this deliberately does **not** do: it never strips a subdomain, and never
 * treats two different domains as equal. `dana@corp.com` and `dana@personal.com` stay
 * distinct here — step 4 handles the same-human-different-mailbox case using the *name* as
 * corroboration, which is a much safer signal than the local part alone.
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed === '') return '';

  /* A GitHub noreply address identifies an account, so it normalises to that account
     rather than to its literal mailbox. This is what merges a contributor's web-UI commits
     with their command-line ones. */
  const noreply = GITHUB_NOREPLY.exec(trimmed);
  if (noreply?.[1] !== undefined) return `${noreply[1]}@users.noreply.github.com`;

  const at = trimmed.lastIndexOf('@');
  if (at < 1) return trimmed;

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  // `+tag` addressing is a routing hint, not a different person.
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);

  if (DOT_INSENSITIVE_DOMAINS.has(domain)) local = local.replaceAll('.', '');

  return `${local}@${domain}`;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).toLowerCase();
}

/** Case- and punctuation-insensitive name key, so `D. Rivera` and `d rivera` compare equal. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[.,_]/g, ' ').replace(/\s+/g, ' ');
}

/* ── Bot detection ─────────────────────────────────────────────────────────── */

/**
 * Bots are flagged rather than dropped: their commits are real provenance, but including
 * them in ownership would make Dependabot the top expert on every lockfile in the
 * repository, and put it in the cast of characters ahead of humans.
 *
 * Matching is on both name and email because the two conventions differ — GitHub Apps use
 * the `[bot]` suffix in the *name*, CI systems usually give themselves a service address.
 */
const BOT_EMAIL_PATTERNS: readonly RegExp[] = [
  /\[bot\]@/i,
  /^(?:dependabot|renovate|greenkeeper|snyk-bot|imgbot|allcontributors)\b/i,
  /@(?:dependabot|renovate)\b/i,
  /^(?:actions|github-actions|gitlab-ci|jenkins|travis|circleci|buildkite)@/i,
  /^noreply@github\.com$/i,
];

const BOT_NAME_PATTERNS: readonly RegExp[] = [
  /\[bot\]\s*$/i,
  /^(?:dependabot|renovate|greenkeeper|snyk bot|imgbot)\b/i,
  /^(?:github[- ]actions|gitlab ci|jenkins|travis ci|circleci)\b/i,
];

export function isBotIdentity(identity: Identity): boolean {
  const email = identity.email.trim();
  const name = identity.name.trim();
  return (
    BOT_EMAIL_PATTERNS.some((re) => re.test(email)) ||
    BOT_NAME_PATTERNS.some((re) => re.test(name))
  );
}

/* ── Name similarity, for step 5 ───────────────────────────────────────────── */

/**
 * Jaro-Winkler, as Part 8 §8.3.1 specifies, with its 0.92 threshold.
 *
 * Chosen over edit distance because it weights *prefix* agreement, which is the right bias
 * for human names: "Jonathan Smith" versus "Jon Smith" should score highly, while "Smith"
 * versus "Smyth" — a different surname with the same length — should not score as well as
 * raw edit distance would suggest.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const from = Math.max(0, i - matchWindow);
    const to = Math.min(b.length, i + matchWindow + 1);
    for (let j = from; j < to; j += 1) {
      if (bMatched[j] === true || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (aMatched[i] !== true) continue;
    while (bMatched[k] !== true) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;

  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix += 1;

  return jaro + prefix * 0.1 * (1 - jaro);
}

export const HEURISTIC_NAME_SIMILARITY = 0.92;

/* ── The resolver ──────────────────────────────────────────────────────────── */

export interface IdentityResolver {
  /**
   * `role` exists because `commitCount` means *commits authored* (Part 8 §8.3.1). Counting
   * the committer as well would double every rebased or squash-merged commit, and on a
   * bors-style repository would make the merge bot the most prolific author alive.
   */
  resolve(identity: Identity, seenAt: Timestamp, role: 'author' | 'committer'): PersonId;
  /** Rows touched since the last drain, so the pipeline can write people in the same transaction as the commits referencing them. */
  drain(): readonly Person[];
  /** Every person, for the final consistency pass. */
  all(): readonly Person[];
}

interface Row {
  readonly id: PersonId;
  canonicalName: string;
  canonicalEmail: string;
  readonly identities: Identity[];
  firstSeen: Timestamp;
  lastSeen: Timestamp;
  commitCount: number;
  mergeSource: MergeSource;
  isBot: boolean;
  /** Normalised keys this row answers to, so a later identity can find it by any of them. */
  readonly keys: Set<string>;
}

export function createIdentityResolver(mailmap: Mailmap | null): IdentityResolver {
  const rows: Row[] = [];
  /** Normalised email (or mailmap-canonical email) → row. Steps 1–3. */
  const byKey = new Map<string, Row>();
  /** `name domain` → rows, for step 4. */
  const byNameDomain = new Map<string, Row[]>();
  const dirty = new Set<Row>();

  const remember = (row: Row, key: string): void => {
    if (key === '' || byKey.has(key)) return;
    byKey.set(key, row);
    row.keys.add(key);
  };

  const observe = (
    row: Row,
    identity: Identity,
    seenAt: Timestamp,
    role: string,
  ): void => {
    if (
      !row.identities.some((i) => i.name === identity.name && i.email === identity.email)
    ) {
      row.identities.push(identity);
    }
    if (compareTimestamps(seenAt, row.firstSeen) < 0) row.firstSeen = seenAt;
    if (compareTimestamps(seenAt, row.lastSeen) > 0) row.lastSeen = seenAt;
    if (role === 'author') row.commitCount += 1;
    // A row is a bot if *any* of its identities is one; the flag is sticky.
    if (isBotIdentity(identity)) row.isBot = true;
    dirty.add(row);
  };

  return {
    resolve(identity, seenAt, role) {
      /* Step 1 — .mailmap. Applied first and treated as fact: it is the repository
         telling us who these people are, and no heuristic may override it. */
      const mapped = mailmap?.resolve(identity) ?? identity;
      const viaMailmap = mapped.email !== identity.email || mapped.name !== identity.name;

      const exact = mapped.email.trim().toLowerCase();
      const normalized = normalizeEmail(mapped.email);
      const nameKey = normalizeName(mapped.name);
      const domain = emailDomain(normalized);

      /* Steps 2 and 3 — exact then normalised email. Both are lookups in the same map;
         the distinction only matters for the `mergeSource` we record. */
      let row = byKey.get(exact) ?? byKey.get(normalized);
      let source: MergeSource = viaMailmap
        ? 'mailmap'
        : byKey.has(exact)
          ? 'exact-email'
          : 'normalized-email';

      /* Step 4 — same normalised name and same email domain. Requires a domain, or every
         identity with an empty email would collapse into one person. */
      if (row === undefined && nameKey !== '' && domain !== '') {
        const candidates = byNameDomain.get(`${nameKey} ${domain}`) ?? [];
        row = candidates[0];
        if (row !== undefined) source = 'name-and-domain';
      }

      /* Step 5 — the heuristic, and the only rule that guesses. Requires high name
         similarity AND non-overlapping activity, because two people with similar names who
         were both committing last month are two people. */
      if (row === undefined && nameKey !== '') {
        for (const candidate of rows) {
          if (candidate.isBot) continue;
          const similarity = jaroWinkler(nameKey, normalizeName(candidate.canonicalName));
          if (similarity < HEURISTIC_NAME_SIMILARITY) continue;
          if (activityOverlaps(candidate, seenAt)) continue;
          row = candidate;
          source = 'heuristic';
          break;
        }
      }

      if (row === undefined) {
        row = {
          // Dense and 1-based: 0 is falsy, and a falsy foreign key hides in every
          // truthiness check downstream.
          id: personId(rows.length + 1),
          canonicalName: mapped.name,
          canonicalEmail: mapped.email,
          identities: [],
          firstSeen: seenAt,
          lastSeen: seenAt,
          commitCount: 0,
          mergeSource: viaMailmap ? 'mailmap' : 'exact-email',
          isBot: false,
          keys: new Set(),
        };
        rows.push(row);
      } else if (rankOf(source) > rankOf(row.mergeSource)) {
        /* Keep the *weakest* explanation on the row. If a person was merged by a
           heuristic at any point, the UI must say so rather than claiming the exact-email
           match that happened to come later — the whole purpose of `mergeSource` is to let
           a user audit the merge, and reporting the most flattering rule defeats it. */
        row.mergeSource = source;
      }

      remember(row, exact);
      remember(row, normalized);
      if (nameKey !== '' && domain !== '') {
        const key = `${nameKey} ${domain}`;
        const list = byNameDomain.get(key);
        if (list === undefined) byNameDomain.set(key, [row]);
        else if (!list.includes(row)) list.push(row);
      }

      /* A mailmap-canonical identity wins the display name outright; otherwise the
         earliest-seen spelling is kept so the report is stable across re-indexes. */
      if (viaMailmap) {
        row.canonicalName = mapped.name;
        row.canonicalEmail = mapped.email;
      }

      observe(row, identity, seenAt, role);
      return row.id;
    },

    drain() {
      const drained = [...dirty].map(toPerson);
      dirty.clear();
      return drained;
    },

    all() {
      return rows.map(toPerson);
    },
  };
}

/** Weakest-wins ordering for `mergeSource`; see the comment at its assignment. */
function rankOf(source: MergeSource): number {
  switch (source) {
    case 'mailmap':
      return 0;
    case 'exact-email':
      return 1;
    case 'normalized-email':
      return 2;
    case 'name-and-domain':
      return 3;
    case 'heuristic':
      return 4;
  }
}

/**
 * Whether a candidate was already active at this instant, within a tolerance.
 *
 * The window is deliberately generous: step 5 is only allowed to merge people whose
 * activity is *clearly* disjoint — the pattern of someone changing employer and email —
 * and a month of overlap is enough to mean they are contemporaries.
 */
const OVERLAP_TOLERANCE_SECONDS = 30 * 86_400;

function activityOverlaps(candidate: Row, seenAt: Timestamp): boolean {
  return (
    seenAt.epochSeconds >= candidate.firstSeen.epochSeconds - OVERLAP_TOLERANCE_SECONDS &&
    seenAt.epochSeconds <= candidate.lastSeen.epochSeconds + OVERLAP_TOLERANCE_SECONDS
  );
}

function toPerson(row: Row): Person {
  return {
    id: row.id,
    canonicalName: row.canonicalName,
    canonicalEmail: row.canonicalEmail,
    // Copied: the row keeps accumulating identities after this snapshot is handed to a
    // transaction, and a caller holding a value that mutates later is a debugging
    // nightmare for the price of one array.
    identities: [...row.identities],
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    commitCount: row.commitCount,
    mergeSource: row.mergeSource,
    isBot: row.isBot,
  };
}
