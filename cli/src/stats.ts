/**
 * `excavate stats` — the first output of this project a stranger will ever see.
 *
 * ROADMAP calls this "a genuinely well-designed terminal report", and the M1 artifact is a
 * screenshot of it. So the layout matters as much as the numbers, and three rules shape it:
 *
 * 1. **Knowledge islands lead.** They are the only section that tells you something
 *    actionable you almost certainly did not know. Repo vitals are interesting; islands are
 *    the reason to run the command twice.
 * 2. **No bare scores.** Part 8 §8.5.3 forbids showing a hotspot as a number without its
 *    factor breakdown, and the same principle applies everywhere: every figure here is either
 *    a count you could verify with `git`, or a score shown with what produced it.
 * 3. **Say what is missing.** A repository with no islands, or one indexed without the
 *    analysis tier, gets a sentence explaining that — never an empty heading, and never a
 *    silently omitted section.
 *
 * Colour is applied only when stdout is a TTY and `NO_COLOR` is unset, so piping to a file or
 * into `jq` produces clean text.
 */

import type { StatsReport, Timestamp } from '@wise-excavate/core';
import { SECONDS_PER_DAY, shortOid } from '@wise-excavate/core';

/* ── Presentation primitives ───────────────────────────────────────────────── */

export interface StatsStyle {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly warn: (text: string) => string;
  readonly heading: (text: string) => string;
}

const ANSI: StatsStyle = {
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
  dim: (t) => `\x1b[2m${t}\x1b[22m`,
  warn: (t) => `\x1b[33m${t}\x1b[39m`,
  heading: (t) => `\x1b[1m\x1b[4m${t}\x1b[24m\x1b[22m`,
};

const PLAIN: StatsStyle = {
  bold: (t) => t,
  dim: (t) => t,
  warn: (t) => t,
  heading: (t) => t,
};

/**
 * `NO_COLOR` is honoured as an unconditional opt-out, per the informal standard: any value at
 * all, including the empty string, disables colour. A tool that emits escape codes into a log
 * file is a tool people stop piping.
 */
export function styleFor(
  isTty: boolean,
  env: Record<string, string | undefined>,
): StatsStyle {
  if (env['NO_COLOR'] !== undefined) return PLAIN;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return ANSI;
  return isTty ? ANSI : PLAIN;
}

const n = (value: number): string => value.toLocaleString('en-US');

function isoDay(at: Timestamp): string {
  return new Date(at.epochSeconds * 1000).toISOString().slice(0, 10);
}

function agoDays(at: Timestamp, now: Timestamp): number {
  return Math.max(0, Math.round((now.epochSeconds - at.epochSeconds) / SECONDS_PER_DAY));
}

/** "3 years" reads better than "1,138 days" for the ages this report shows. */
function humanAge(days: number): string {
  if (days < 45) return `${days}d`;
  if (days < 730) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** Middle-elided so both the directory and the filename survive, which is what identifies a file. */
export function elidePath(path: string, width: number): string {
  if (path.length <= width) return path;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base.length + 2 >= width) return `…${base.slice(-(width - 1))}`;
  const head = width - base.length - 2;
  return `${path.slice(0, head)}…/${base}`;
}

/* ── The report ────────────────────────────────────────────────────────────── */

export function renderStats(report: StatsReport, style: StatsStyle): string {
  const { summary, generatedFor: now } = report;
  const out: string[] = [];
  const say = (line = ''): void => void out.push(line);

  /* ── Vitals ─────────────────────────────────────────────────────────────── */

  say();
  say(`  ${style.bold(summary.root)}`);
  const span =
    summary.firstCommitAt === null || summary.lastCommitAt === null
      ? ''
      : `  ${isoDay(summary.firstCommitAt)} → ${isoDay(summary.lastCommitAt)}`;
  say(
    style.dim(
      `  ${n(summary.commitCount)} commits · ${n(summary.personCount)} people · ${n(summary.fileCount)} files${span}`,
    ),
  );
  if (summary.partial !== null) {
    say(style.warn(`  incomplete index — ${summary.partial.skipped}`));
  }
  say();

  if (summary.commitCount === 0) {
    say('  This repository has no commits yet, so there is nothing to report.');
    say();
    return out.join('\n');
  }

  /* ── Knowledge islands, first ───────────────────────────────────────────── */

  const islands = report.knowledgeIslands;
  say(style.heading('  KNOWLEDGE ISLANDS'));
  say(style.dim('  One person holds the knowledge, and they have stopped contributing.'));
  say();
  if (islands.length === 0) {
    /* Not an empty heading. "None" is a real and good answer, and saying so is what makes the
       section trustworthy when it *does* list something. */
    say(
      style.dim(
        '  None. Every file has either more than one knowledgeable owner or an active one.',
      ),
    );
  } else {
    for (const island of islands) {
      const owner =
        island.ownerName === null || island.ownerLastSeen === null
          ? style.dim('owner unknown')
          : `${island.ownerName}  ${style.dim(`last seen ${humanAge(agoDays(island.ownerLastSeen, now))} ago`)}`;
      say(`  ${style.warn('●')} ${elidePath(island.path, 58).padEnd(58)}  ${owner}`);
    }
  }
  say();

  /* ── Hotspots, with the factor breakdown §8.5.3 requires ────────────────── */

  const hotspots = report.hotspots;
  say(style.heading('  HOTSPOTS'));
  say(style.dim('  churn × complexity × recency × fix density. Every factor shown.'));
  say();
  if (hotspots.length === 0) {
    say(style.dim('  No ranking available — the analysis tier has not been built.'));
  } else {
    say(
      style.dim(
        `  ${'score'.padStart(6)}  ${'churn'.padStart(5)} ${'cmplx'.padStart(5)} ${'recent'.padStart(6)} ${'fixes'.padStart(5)}  ${'chgs'.padStart(5)}  file`,
      ),
    );
    for (const spot of hotspots) {
      say(
        `  ${spot.score.toFixed(3).padStart(6)}  ${bar(spot.churn)} ${bar(spot.complexity)} ${bar(spot.recency).padStart(6)} ${bar(spot.fixDensity)}  ${style.dim(String(spot.changeCount).padStart(5))}  ${elidePath(spot.path, 42)}`,
      );
    }
  }
  say();

  /* ── Most significant commits ───────────────────────────────────────────── */

  const significant = report.significantCommits;
  say(style.heading('  MOST SIGNIFICANT COMMITS'));
  say(
    style.dim(
      '  Scored on scale, message quality, and path rarity — penalised for codemods,',
    ),
  );
  say(style.dim('  lockfiles, and generated output, so those never reach this list.'));
  say();
  if (significant.length === 0) {
    say(style.dim('  No ranking available — the analysis tier has not been built.'));
  } else {
    for (const commit of significant) {
      say(
        `  ${style.dim(shortOid(commit.oid))}  ${style.dim(isoDay(commit.authoredAt))}  ${truncate(commit.subject, 52)}  ${style.dim(`${commit.filesChanged}f`)}`,
      );
    }
  }
  say();

  /* ── Cast of characters ─────────────────────────────────────────────────── */

  const people = report.people;
  if (people.length > 0) {
    say(style.heading('  CAST OF CHARACTERS'));
    say(style.dim('  By commits authored. Bots excluded.'));
    say();
    for (const person of people) {
      const active = agoDays(person.lastSeen, now);
      say(
        `  ${n(person.commits).padStart(6)}  ${truncate(person.name, 30).padEnd(30)}  ${style.dim(
          active > 183
            ? `inactive ${humanAge(active)}`
            : `active ${humanAge(active)} ago`,
        )}`,
      );
    }
    /* The tail is reported as a count *and* its share of the commits, because "440 more" alone
       reads as "there is lots more to see" when on most repositories it means the opposite: a
       long tail of one-commit drive-by contributors. The number that answers "did I just see
       the whole story" is how many commits they account for between them. */
    /* The tail is reported as a count *and* its share of the commits, because "23 more" alone
       reads as "there is lots more to see" when on most repositories it means the opposite: a
       long tail of one-commit drive-by contributors. The number that answers "did I just see the
       whole story" is how many commits they account for between them. Both come from the report
       rather than being derived here, so bot commits are excluded from the tail as well as the
       list — see `StatsReport.otherCommits`. */
    if (report.otherPeople > 0) {
      const n_ = report.otherCommits;
      say(
        style.dim(
          `  ${n(report.otherPeople)} more, ${n(n_)} ${n_ === 1 ? 'commit' : 'commits'} between them`,
        ),
      );
    }
    say();
  }

  return out.join('\n');
}

/** A 0..1 factor as a compact two-character bar plus its value, so the number is never bare. */
function bar(value: number): string {
  return value.toFixed(2).replace(/^0\./, ' .');
}

function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/* ── The JSON shape ────────────────────────────────────────────────────────── */

/**
 * `--json`, for scripting and for agents.
 *
 * A stable, self-describing document rather than the rendered text: the terminal layout is
 * free to change with the design, and anything parsing the human output would break when it
 * does. Keys are the domain vocabulary of Part 14 §14.4, unabbreviated.
 */
export function statsAsJson(report: StatsReport): string {
  /* The DTO, verbatim, rather than a second hand-built shape. The terminal layout is free to
     change with the design; anything parsing the human output breaks when it does, and anything
     parsing a *reshaped* JSON breaks when the reshaping drifts from the DTO. Emitting the
     document the daemon assembled means `--json`, the M3 Overview, and M8's MCP tools are all
     reading the same fields with the same names. */
  return `${JSON.stringify(report, null, 2)}\n`;
}
