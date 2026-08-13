/**
 * The analysis tier: one scan, four outputs.
 *
 * Everything M1 derives — significance, knowledge, ownership, hotspots — is a fold over the
 * same join of `changes` against `commits`. So the tier reads that join **once**, accumulates
 * in memory, and writes four rollups in one transaction. Part 8 §8.7 requires these be
 * materialised during indexing rather than aggregated per request; this is where that happens.
 *
 * The alternative shape — one analyzer per pass, each re-reading the join — is four full scans
 * of the largest table in the index for no benefit, since none of the four depends on another's
 * *output*. They depend on the same *input*.
 */

import type { CommitId, FileId, PathId, PersonId, Timestamp } from '@wise-excavate/core';
import { timestamp } from '@wise-excavate/core';
import type {
  HotspotWrite,
  KnowledgeWrite,
  OwnershipWrite,
  Store,
  Transaction,
} from '@wise-excavate/store';

import { HOTSPOT_MIN_CHANGES, hotspotOf, looksLikeFix } from './hotspots.js';
import { ANALYZER_IDS } from './index.js';
import { isKnowledgeIsland, summariseOwnership, type KnowledgeRow } from './ownership.js';
import {
  DEFAULT_SIGNIFICANCE_WEIGHTS,
  LARGE_BRANCH_COMMITS,
  pathRarity,
  significanceOf,
  touchesPublicApi,
  type SignificanceWeights,
} from './significance.js';

/** Everything the tier needs from outside itself, so it is testable without a repository. */
export interface AnalysisRunDeps {
  readonly store: Store;
  /** The instant decay is measured from. Injected so a test is not at the mercy of the clock. */
  readonly now: Timestamp;
  readonly signal: AbortSignal;
  readonly weights?: SignificanceWeights;
  /** HEAD, recorded against each analyzer run so a fast-forward can tell whether output is current. */
  readonly throughOid: string;
}

export interface AnalysisSummary {
  readonly commitsScored: number;
  readonly filesRanked: number;
  readonly knowledgeRows: number;
  readonly islands: number;
}

/** Message quality needs to know which subjects are boilerplate *in this repository*. */
const REPEATED_SUBJECT_MIN = 3;

export async function runAnalysis(deps: AnalysisRunDeps): Promise<AnalysisSummary> {
  const { store, now } = deps;
  const weights = deps.weights ?? DEFAULT_SIGNIFICANCE_WEIGHTS;
  const paths = store.analysis.paths();
  const releases = store.analysis.releaseCommits();

  /* ── Pass 1: commits, for the corpus-wide facts significance needs ────────── */

  interface CommitAcc {
    readonly author: PersonId;
    readonly authoredAt: Timestamp;
    readonly subject: string;
    readonly hasBody: boolean;
    readonly trailerCount: number;
    readonly flags: readonly string[];
    readonly parentCount: number;
    files: number;
    churn: number;
    readonly touchedPaths: string[];
  }

  const commits = new Map<CommitId, CommitAcc>();
  const subjectCounts = new Map<string, number>();

  /**
   * `format-only`, derived from hunks — the flag M1 could not set.
   *
   * Read *before* the commit fold so the flag is present in `flags` when `significanceOf` sees it.
   * Setting it afterwards would store a correctly-flagged commit whose score was computed as
   * though it were not flagged, and the ranking is the only place the flag has any effect — the
   * whole reason `format-only` exists is the `penaltyFormatOnly` term. Two writes in one run that
   * disagree with each other are worse than not having the flag.
   *
   * Merged into the in-memory records as well as persisted, rather than re-reading every commit
   * after the update: one source of truth per run, and no second scan of the whole history.
   */
  const formatOnly = new Set<CommitId>(store.analysis.formatOnlyCommits());

  for (const commit of store.analysis.commits()) {
    throwIfAborted(deps.signal);
    commits.set(commit.id, {
      author: commit.author,
      authoredAt: commit.authoredAt,
      subject: commit.subject,
      hasBody: commit.body !== null && commit.body.length >= 40,
      trailerCount: commit.trailerCount,
      flags: formatOnly.has(commit.id) ? [...commit.flags, 'format-only'] : commit.flags,
      parentCount: commit.parentCount,
      files: 0,
      churn: 0,
      touchedPaths: [],
    });
    const key = commit.subject.trim().toLowerCase();
    subjectCounts.set(key, (subjectCounts.get(key) ?? 0) + 1);
  }

  const repeatedSubjects = new Set(
    [...subjectCounts].filter(([, n]) => n >= REPEATED_SUBJECT_MIN).map(([s]) => s),
  );

  /* ── Pass 2: changes — the one scan every output folds over ───────────────── */

  interface FileAcc {
    churn: number;
    changes: number;
    fixes: number;
    lastAt: Timestamp;
    /** Peak single-commit churn, the stand-in for file size; see the note at `complexity`. */
    peakChurn: number;
  }

  /* Files that are not maintained source. Part 8 §8.5.3's warning about hotspots is
     specifically that a lockfile must not surface as a top file, and the noise flags were
     until now applied only to *commits* — so `Cargo.lock` ranked 6th on `ripgrep` by churn
     and recency, exactly the embarrassment the flags exist to prevent. Ownership is filtered
     for the same reason in the other direction: "nobody owns this .gitignore" is true and
     worthless, and it crowds out the islands that matter. */
  const excluded = new Set(store.analysis.nonSourceFiles());

  const files = new Map<FileId, FileAcc>();
  const knowledge = new Map<
    string,
    { file: FileId; person: PersonId; acc: number; lastAt: Timestamp; commits: number }
  >();
  const changeCountByPath = new Map<string, number>();
  /** Top-level directory → the earliest commit that touched it, for the new-directory reward. */
  const firstTouchOfDir = new Map<string, CommitId>();

  for (const change of store.analysis.changes()) {
    throwIfAborted(deps.signal);
    const commit = commits.get(change.commit);
    if (commit === undefined) continue;
    /* Still counted toward the *commit's* size and churn — a dependency bump is a real change
       and its significance should reflect that — but never toward a file ranking. */
    const rankable = !excluded.has(change.file);

    /* Binary churn is not line churn. Git reports `-` for both counts, which the parser
       already turns into zeroes — carrying them into knowledge would credit whoever committed
       a 4MB PNG with the same expertise as someone who wrote 16 lines of logic. */
    const churn = change.isBinary ? 0 : change.insertions + change.deletions;

    commit.files += 1;
    commit.churn += churn;

    const path = change.pathId === null ? null : (paths.get(change.pathId) ?? null);
    if (path !== null) {
      commit.touchedPaths.push(path);
      changeCountByPath.set(path, (changeCountByPath.get(path) ?? 0) + 1);
      const topLevel = path.slice(0, Math.max(0, path.indexOf('/')));
      if (topLevel !== '' && !firstTouchOfDir.has(topLevel)) {
        firstTouchOfDir.set(topLevel, change.commit);
      }
    }

    if (!rankable) continue;

    const file = files.get(change.file);
    const isFix = looksLikeFix(commit.subject);
    if (file === undefined) {
      files.set(change.file, {
        churn,
        changes: 1,
        fixes: isFix ? 1 : 0,
        lastAt: commit.authoredAt,
        peakChurn: churn,
      });
    } else {
      file.churn += churn;
      file.changes += 1;
      if (isFix) file.fixes += 1;
      if (commit.authoredAt.epochSeconds > file.lastAt.epochSeconds) {
        file.lastAt = commit.authoredAt;
      }
      file.peakChurn = Math.max(file.peakChurn, churn);
    }

    /* Knowledge: √(lines_touched), summed. Sublinear so a codemod does not create an
       expert (Part 8 §8.5.2). Decay is applied at read time, not here. */
    const key = `${change.file}:${commit.author}`;
    const existing = knowledge.get(key);
    if (existing === undefined) {
      knowledge.set(key, {
        file: change.file,
        person: commit.author,
        acc: Math.sqrt(churn),
        lastAt: commit.authoredAt,
        commits: 1,
      });
    } else {
      existing.acc += Math.sqrt(churn);
      existing.commits += 1;
      if (commit.authoredAt.epochSeconds > existing.lastAt.epochSeconds) {
        existing.lastAt = commit.authoredAt;
      }
    }
  }

  /* ── Significance ─────────────────────────────────────────────────────────── */

  const totalCommits = commits.size;
  const significance: { commit: CommitId; score: number }[] = [];

  for (const [id, commit] of commits) {
    throwIfAborted(deps.signal);
    const quality = qualityOf(commit, repeatedSubjects);
    significance.push({
      commit: id,
      score: significanceOf(
        {
          filesTouched: commit.files,
          churn: commit.churn,
          flags: commit.flags as never,
          messageQuality: quality,
          pathRarity: pathRarity(commit.touchedPaths, changeCountByPath, totalCommits),
          touchesManifest: commit.touchedPaths.some(isManifestPath),
          touchesPublicApi: touchesPublicApi(commit.touchedPaths),
          firstTouchOfNewTopLevelDir: commit.touchedPaths.some((p) => {
            const top = p.slice(0, Math.max(0, p.indexOf('/')));
            return top !== '' && firstTouchOfDir.get(top) === id;
          }),
          isRelease: releases.has(id),
          /* A merge that brought in a large branch. Approximated by "is a merge and touched
             many files", because the true branch size needs the second parent's history —
             which `--first-parent` deliberately did not walk. Named rather than hidden. */
          mergesLargeBranch:
            commit.parentCount > 1 && commit.files >= LARGE_BRANCH_COMMITS,
        },
        weights,
      ),
    });
  }

  /* ── Ownership, islands, hotspots ─────────────────────────────────────────── */

  const bots = new Set(
    store.people
      .all({ includeBots: true })
      .filter((p) => p.isBot)
      .map((p) => p.id),
  );
  const lastSeenByPerson = new Map(
    store.people.all({ includeBots: true }).map((p) => [p.id, p.lastSeen]),
  );

  const knowledgeRows: KnowledgeWrite[] = [];
  const byFile = new Map<FileId, KnowledgeRow[]>();
  for (const row of knowledge.values()) {
    knowledgeRows.push({
      file: row.file,
      person: row.person,
      accumulated: row.acc,
      lastAt: row.lastAt,
      commits: row.commits,
    });
    /* Bots are excluded from ownership but kept in the knowledge table. Dropping them here
       too would lose the provenance record; including them below would make Dependabot the
       top owner of every lockfile and every one of those files would report a comfortable
       bus factor of 1. */
    if (bots.has(row.person)) continue;
    const list = byFile.get(row.file);
    const entry: KnowledgeRow = {
      person: row.person,
      accumulated: row.acc,
      lastAt: row.lastAt,
      commits: row.commits,
    };
    if (list === undefined) byFile.set(row.file, [entry]);
    else list.push(entry);
  }

  const ownership: OwnershipWrite[] = [];
  let islands = 0;
  for (const [file, rows] of byFile) {
    throwIfAborted(deps.signal);
    const summary = summariseOwnership(rows, now);
    const island = isKnowledgeIsland(
      summary,
      summary.topPerson === null
        ? null
        : (lastSeenByPerson.get(summary.topPerson) ?? null),
      now,
    );
    if (island) islands += 1;
    ownership.push({
      file,
      topPerson: summary.topPerson,
      topShare: summary.topShare,
      busFactor: summary.busFactor,
      entropy: summary.entropy,
      isIsland: island,
      contributors: summary.contributors,
    });
  }

  /* The maxima are taken over rankable files only. A single generated file added in one enormous
     commit would otherwise set `maxChurn` for the whole repository, and every real source file's
     normalised churn would be divided down toward zero by a file that is not even in the
     ranking. Normalising against the population being ranked is the only version that produces a
     readable spread. */
  const ranks = (acc: { readonly changes: number }): boolean =>
    acc.changes >= HOTSPOT_MIN_CHANGES;

  let maxChurn = 0;
  let maxComplexity = 0;
  for (const file of files.values()) {
    if (!ranks(file)) continue;
    maxChurn = Math.max(maxChurn, file.churn);
    maxComplexity = Math.max(maxComplexity, complexityOf(file));
  }

  const hotspots: HotspotWrite[] = [];
  for (const [file, acc] of files) {
    throwIfAborted(deps.signal);
    if (!ranks(acc)) continue;
    const factors = hotspotOf(
      {
        totalChurn: acc.churn,
        changeCount: acc.changes,
        complexity: complexityOf(acc),
        lastChangedAt: acc.lastAt,
        fixDensity: acc.changes === 0 ? 0 : acc.fixes / acc.changes,
      },
      { churn: maxChurn, complexity: maxComplexity },
      now,
    );
    hotspots.push({
      file,
      score: factors.score,
      churn: factors.churn,
      complexity: factors.complexity,
      recency: factors.recency,
      fixDensity: factors.fixDensity,
      changeCount: acc.changes,
      totalChurn: acc.churn,
    });
  }

  /* One transaction for all four outputs: a crash between them would leave ownership
     describing a knowledge table that no longer exists. */
  store.transaction((tx: Transaction) => {
    /* Persisted so `excavate stats` and the M3 UI can *say* a commit is formatting,
       not merely rank it lower. Written in the same transaction as the scores it
       produced, so the flag and the score can never be observed disagreeing. */
    tx.addCommitFlag([...formatOnly], 'format-only');
    tx.setSignificance(significance);
    tx.replaceKnowledge(knowledgeRows);
    tx.replaceOwnership(ownership);
    tx.replaceHotspots(hotspots);
    for (const id of Object.values(ANALYZER_IDS)) {
      tx.recordAnalyzerRun(id, 1, deps.throughOid);
    }
  });

  return {
    commitsScored: significance.length,
    filesRanked: hotspots.length,
    knowledgeRows: knowledgeRows.length,
    islands,
  };
}

/**
 * The complexity stand-in at M1.
 *
 * `complexityProxy` in `./hotspots.ts` wants file *content* — LOC and mean indentation — and
 * the index has none:
 * blobs arrive with the hunk table in M2. So peak single-commit churn stands in for size, on
 * the reasoning that the commit which created or rewrote a file is proportional to how big it
 * is. It is a genuine approximation and it is wrong in a specific way: a file assembled over
 * a hundred small commits reads as smaller than one pasted in whole. M2 replaces this with
 * the real proxy over blob content.
 */
function complexityOf(file: { readonly peakChurn: number }): number {
  return file.peakChurn;
}

function qualityOf(
  commit: {
    readonly subject: string;
    readonly hasBody: boolean;
    readonly trailerCount: number;
  },
  repeated: ReadonlySet<string>,
): number {
  const subject = commit.subject.trim();
  if (subject === '') return 0;
  let score = 0.15;
  if (subject.length >= 15 && subject.length <= 120) score += 0.3;
  else if (subject.length > 8) score += 0.15;
  if (commit.hasBody) score += 0.4;
  if (commit.trailerCount > 0) score += 0.15;
  if (
    /^(?:wip|fix|update|updates|changes|cleanup|misc|stuff|tmp|temp|minor|typo|\.+)$/i.test(
      subject,
    )
  ) {
    score -= 0.35;
  }
  if (repeated.has(subject.toLowerCase())) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

const MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
]);

function isManifestPath(path: string): boolean {
  return MANIFEST_BASENAMES.has(path.slice(path.lastIndexOf('/') + 1));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('analysis cancelled', 'AbortError');
  }
}

/** Re-exported so the pipeline can name the instant without importing core twice. */
export { timestamp };
export type { PathId };
