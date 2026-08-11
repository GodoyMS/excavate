/**
 * `.mailmap` and `.git-blame-ignore-revs` — the repository's own declarations.
 *
 * A `.mailmap` is always authoritative in the identity resolution of Part 8 §8.3.1:
 * it is the one signal a human wrote down deliberately, so it outranks all four
 * heuristic steps that follow it. Getting it wrong is expensive in a way that is hard
 * to see — a missed alias splits one person's ownership across two rows, which
 * silently manufactures a knowledge island where none exists.
 */

import type { Identity, Oid } from '@wise-excavate/core';
import { NotImplementedError } from '@wise-excavate/core';

/** The repository's own declaration of identity, and always authoritative (Part 8 §8.3.1). */
export interface Mailmap {
  resolve(identity: Identity): Identity;
  readonly entryCount: number;
}

/** What an entry replaces. `null` means "leave the commit's value alone". */
interface Replacement {
  readonly name: string | null;
  readonly email: string | null;
}

/**
 * Entries are keyed by the *commit* email, lower-cased, because that is what a commit
 * presents and what git matches on. A commit-name-qualified entry wins over the
 * unqualified one for the same email, which is how `.mailmap` disambiguates a shared
 * address (`root@localhost`, a CI account, a pair-programming mailbox).
 */
interface Bucket {
  generic: Replacement | null;
  readonly byName: Map<string, Replacement>;
}

/**
 * All four forms from gitmailmap(5):
 *
 * ```
 * Proper Name <proper@email>
 * <proper@email> <commit@email>
 * Proper Name <proper@email> <commit@email>
 * Proper Name <proper@email> Commit Name <commit@email>
 * ```
 *
 * The first form has no commit part, so the proper email doubles as the key: it says
 * "whoever commits as this address is really called this". Matching is
 * case-insensitive on both email and name, per git; the replacement keeps the exact
 * spelling the file used, since that spelling is the point of the file.
 */
const ENTRY_PATTERN = /^([^<>]*)<([^<>]+)>(?:\s*([^<>]*)<([^<>]+)>)?/;

export function parseMailmap(text: string): Mailmap {
  const buckets = new Map<string, Bucket>();
  let entryCount = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = ENTRY_PATTERN.exec(line);
    if (match === null) continue;
    const [, properName = '', properEmail = '', commitName = '', commitEmail] = match;

    const key = (commitEmail ?? properEmail).trim().toLowerCase();
    if (key === '') continue;

    const replacement: Replacement = {
      name: properName.trim() === '' ? null : properName.trim(),
      email: properEmail.trim(),
    };

    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { generic: null, byName: new Map() };
      buckets.set(key, bucket);
    }
    const qualifier = commitName.trim().toLowerCase();
    if (qualifier === '') bucket.generic = replacement;
    else bucket.byName.set(qualifier, replacement);
    entryCount += 1;
  }

  return {
    entryCount,
    resolve(identity: Identity): Identity {
      const bucket = buckets.get(identity.email.trim().toLowerCase());
      if (bucket === undefined) return identity;
      const replacement =
        bucket.byName.get(identity.name.trim().toLowerCase()) ?? bucket.generic;
      if (replacement === null || replacement === undefined) return identity;
      return {
        name: replacement.name ?? identity.name,
        email: replacement.email ?? identity.email,
      };
    },
  };
}

export function parseBlameIgnoreRevs(_text: string): ReadonlySet<Oid> {
  // Deliberately still a stub: nothing reads it until blame lands, and the file's
  // sharper semantics (an abbreviated revision is an error, unlike a mailmap line git
  // simply ignores) belong with the code that has to honour them.
  throw new NotImplementedError('parseBlameIgnoreRevs', 'M2');
}
