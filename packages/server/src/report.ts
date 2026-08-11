/**
 * Assembling the stats report — the daemon's side of boundary rule B4.
 *
 * Every presentation surface gets this same document: `excavate stats` renders it as a table
 * today, M3's Overview renders it as a page, and `excavate mcp` will hand it to an agent in
 * M8. That is the point. Part 7 §7.3 names the failure B4 prevents as "divergence between
 * CLI, MCP, and GUI answers", and the only structural way to prevent it is for none of them to
 * do the querying.
 *
 * It also keeps `@wise-excavate/excavate` off `@wise-excavate/store`: the CLI renders a DTO
 * from `core` and never learns what a `FileId` is, let alone what SQL is.
 */

import type {
  FileId,
  HotspotReport,
  IslandReport,
  Person,
  PersonReport,
  StatsReport,
  Timestamp,
} from '@wise-excavate/core';
import type { Store } from '@wise-excavate/store';

import type { RepoSession } from './index.js';

export interface ReportLimits {
  readonly hotspots: number;
  readonly islands: number;
  readonly commits: number;
  readonly people: number;
}

export const DEFAULT_REPORT_LIMITS: ReportLimits = {
  hotspots: 10,
  islands: 8,
  commits: 8,
  people: 8,
};

export function buildStatsReport(
  session: RepoSession,
  now: Timestamp,
  limits: ReportLimits = DEFAULT_REPORT_LIMITS,
): StatsReport {
  const { store } = session;

  const humans = unlessDeferred(() => store.people.all({ includeBots: false }), []);
  const shown = humans.slice(0, limits.people);

  return {
    summary: session.summary(),
    knowledgeIslands: islandsOf(store, limits.islands),
    hotspots: hotspotsOf(store, limits.hotspots),
    significantCommits: significantOf(store, limits.commits),
    people: shown.map(asPersonReport),
    otherPeople: humans.length - shown.length,
    otherCommits: humans
      .slice(limits.people)
      .reduce((sum, person) => sum + person.commitCount, 0),
    generatedFor: now,
  };
}

function islandsOf(store: Store, limit: number): readonly IslandReport[] {
  return unlessDeferred(() => store.rollups.knowledgeIslands(limit), []).map((island) => {
    const owner = island.topPerson === null ? null : store.people.byId(island.topPerson);
    return {
      path: pathOf(store, island.file),
      busFactor: island.busFactor,
      entropy: island.entropy,
      ownerName: owner?.canonicalName ?? null,
      ownerLastSeen: owner?.lastSeen ?? null,
      topShare: island.topShare,
    };
  });
}

function hotspotsOf(store: Store, limit: number): readonly HotspotReport[] {
  return unlessDeferred(() => store.rollups.hotspots(limit), []).map((spot) => ({
    path: pathOf(store, spot.file),
    score: spot.score,
    churn: spot.factors.churn,
    complexity: spot.factors.complexity,
    recency: spot.factors.recency,
    fixDensity: spot.factors.fixDensity,
    // Surfaced because "312 changes" is what makes a normalised 0.85 concrete.
    changeCount: spot.changeCount,
  }));
}

/**
 * How far past `limit` to look when collapsing near-duplicates.
 *
 * ripgrep's top eight contained "libripgrep: initial commit introducing libripgrep" three
 * times — three distinct commits, three distinct oids, all reachable because the branch was
 * rebased and both the old and new tips are still referenced. Every one of them is a real
 * commit and the scorer is right to rank them highly, but spending three of eight slots on one
 * logical change is a worse report than showing the next three changes down. Over-fetching lets
 * the collapse still fill the list.
 */
const DUPLICATE_SCAN_FACTOR = 4;

function significantOf(store: Store, limit: number): StatsReport['significantCommits'] {
  const seen = new Set<string>();
  return (
    unlessDeferred(() => store.commits.mostSignificant(limit * DUPLICATE_SCAN_FACTOR), [])
      /* Same author, same subject: the rebase case. Keyed on both because "Update README" from
       two different people across five years is two real events, and merging those would hide
       a contributor rather than tidy a list. Scores arrive descending, so the first survivor
       is the highest-ranked of its group. */
      .filter((commit) => {
        const key = `${commit.author}\0${commit.subject.trim().toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit)
      .map((commit) => {
        const changes = store.commits.changesIn(commit.id);
        const author = store.people.byId(commit.author);
        return {
          oid: commit.oid,
          subject: commit.subject,
          authorName: author?.canonicalName ?? 'unknown',
          authoredAt: commit.authoredAt,
          insertions: changes.reduce((sum, change) => sum + change.insertions, 0),
          deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
          filesChanged: changes.length,
          significance: commit.significance,
          isMerge: commit.parents.length > 1,
        };
      })
  );
}

function asPersonReport(person: Person): PersonReport {
  return {
    name: person.canonicalName,
    email: person.canonicalEmail,
    commits: person.commitCount,
    firstSeen: person.firstSeen,
    lastSeen: person.lastSeen,
    mergeSource: person.mergeSource,
  };
}

function pathOf(store: Store, file: FileId): string {
  const entity = store.files.byId(file);
  if (entity?.currentPath == null) return `file ${file}`;
  return store.files.pathOf(entity.currentPath) ?? `file ${file}`;
}

/**
 * Treat an unimplemented query as "no data" rather than a crash.
 *
 * The report must render against an index built by an older build, or one where the analysis
 * tier never ran — the sections that *do* have data are worth showing, and letting a
 * `NotImplementedError` escape turns a partial report into no report at all. The rendering side
 * is what says "no ranking available", so the absence is visible rather than silent.
 */
function unlessDeferred<T>(
  query: () => readonly T[],
  fallback: readonly T[],
): readonly T[] {
  try {
    return query();
  } catch {
    return fallback;
  }
}
