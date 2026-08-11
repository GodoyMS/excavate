/**
 * Commit message parsing: subject, body, and trailers.
 *
 * Trailers are *parsed*, not merely stored (Part 8 §8.2.1), because three of them are
 * load-bearing later: `Co-authored-by` distributes ownership credit in the knowledge model,
 * and `PR-URL`, `Change-Id`, `Fixes`, and `Closes` feed the evidence engine's PR-reference
 * collector in M2. Storing the raw body and re-parsing it per query would mean the
 * knowledge model and the evidence engine could disagree about who wrote something.
 */

export interface ParsedMessage {
  readonly subject: string;
  readonly body: string | null;
  readonly trailers: readonly { readonly key: string; readonly value: string }[];
}

/**
 * Git's own trailer rule, deliberately: a trailer block is the **last** paragraph, and every
 * line in it must look like `Key: value`. Scanning the whole message for anything
 * colon-shaped would turn a body line like "Note: this is slow" into a trailer, and turn
 * a URL into a `https` trailer.
 */
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.+)$/;

/**
 * Continuation lines inside a trailer block, which git permits — a wrapped
 * `Co-authored-by` is common in squash merges.
 */
const CONTINUATION = /^\s+\S/;

export function splitCommitMessage(message: string): ParsedMessage {
  const normalized = message.replace(/\r\n/g, '\n').trimEnd();
  const newline = normalized.indexOf('\n');
  const subject = (newline < 0 ? normalized : normalized.slice(0, newline)).trim();
  if (newline < 0) return { subject, body: null, trailers: [] };

  const rest = normalized.slice(newline + 1).replace(/^\n+/, '');
  if (rest === '') return { subject, body: null, trailers: [] };

  const paragraphs = rest.split(/\n{2,}/);
  const last = paragraphs.at(-1);
  const trailers: { key: string; value: string }[] = [];

  if (last !== undefined && isTrailerBlock(last)) {
    for (const line of last.split('\n')) {
      if (CONTINUATION.test(line) && trailers.length > 0) {
        const previous = trailers.at(-1);
        if (previous !== undefined) previous.value += ` ${line.trim()}`;
        continue;
      }
      const match = TRAILER_LINE.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        // Canonicalised to lower case: git treats trailer keys case-insensitively, and
        // `Co-authored-by` versus `Co-Authored-By` must not become two different facts.
        trailers.push({ key: match[1].toLowerCase(), value: match[2].trim() });
      }
    }
    paragraphs.pop();
  }

  const body = paragraphs.join('\n\n').trim();
  return { subject, body: body === '' ? null : body, trailers };
}

function isTrailerBlock(paragraph: string): boolean {
  const lines = paragraph.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return false;
  let sawTrailer = false;
  for (const line of lines) {
    if (CONTINUATION.test(line)) {
      // A continuation before any trailer means this is prose that happens to be indented.
      if (!sawTrailer) return false;
      continue;
    }
    if (!TRAILER_LINE.test(line)) return false;
    sawTrailer = true;
  }
  return sawTrailer;
}

/**
 * Co-authors, as identities. Part 8 §8.5.2 distributes knowledge credit across them, which
 * is what stops a pair-programmed or squash-merged commit from crediting only whoever
 * pressed the button.
 */
const COAUTHOR_VALUE = /^(.*?)\s*<([^>]+)>\s*$/;

export function coAuthors(
  trailers: readonly { readonly key: string; readonly value: string }[],
): readonly { readonly name: string; readonly email: string }[] {
  const found: { name: string; email: string }[] = [];
  for (const trailer of trailers) {
    if (trailer.key !== 'co-authored-by') continue;
    const match = COAUTHOR_VALUE.exec(trailer.value);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      found.push({ name: match[1].trim(), email: match[2].trim() });
    }
  }
  return found;
}

/**
 * Message quality, 0–1, for the significance score (Part 8 §8.5.1).
 *
 * The three signals are: does it explain itself (a body), is it linked to anything
 * (trailers), and is it more than a shrug. `repeatedSubjects` is passed in because
 * "is this one of the most repeated subjects in this repository" is a property of the
 * corpus, not of the commit — a repo where 400 commits say "update" should not reward any
 * of them.
 */
const LOW_EFFORT_SUBJECT =
  /^(?:wip|fix|fixes|fixed|update|updates|updated|changes|cleanup|misc|stuff|tmp|temp|test|minor|typo|\.+)$/i;

export function messageQuality(
  parsed: ParsedMessage,
  repeatedSubjects: ReadonlySet<string>,
): number {
  const subject = parsed.subject.trim();
  if (subject === '') return 0;

  let score = 0;
  // A subject long enough to be a sentence, but not a pasted paragraph.
  if (subject.length >= 15 && subject.length <= 120) score += 0.3;
  else if (subject.length > 8) score += 0.15;

  if (parsed.body !== null && parsed.body.length >= 40) score += 0.4;
  else if (parsed.body !== null) score += 0.15;

  if (parsed.trailers.length > 0) score += 0.15;

  if (LOW_EFFORT_SUBJECT.test(subject)) score -= 0.35;
  if (repeatedSubjects.has(subject.toLowerCase())) score -= 0.2;

  return Math.max(0, Math.min(1, score + 0.15));
}
