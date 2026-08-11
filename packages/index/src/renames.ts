/**
 * File identity across renames — Part 8 §8.3.2, and the project's top existential risk
 * (R1).
 *
 * **What breaks if this is wrong.** A `FileId` is the spine of every file-scoped answer:
 * churn, ownership, knowledge, hotspots, and later File Evolution and every Why chain. If
 * a rename severs a file's lineage, the older half of its history silently vanishes — the
 * file looks younger, its churn looks lower, its original author disappears from its
 * ownership, and the report still reads as authoritative. Nothing errors. That is why
 * LEAN-V1 §7 gives this the whole of M1 and forbids compressing it.
 *
 * **The model.** A file is a `FileId` plus an ordered list of `PathAlias` segments, each
 * `[from, to)` in commit-time. A rename appends a segment; a resurrection appends a segment
 * after a gap. The three invariants of Part 8 §8.8 are what everything downstream assumes,
 * and are property-tested rather than merely intended:
 *
 * 1. Every `(commit, path)` resolves to exactly one `FileId`.
 * 2. A `FileId`'s aliases never overlap in commit-time.
 * 3. `born ≤` every alias `from`, and `died` (when set) `≥` every alias `to`.
 *
 * **Scope at M1**, per ROADMAP: explicit renames — the ones `git log --find-renames`
 * reports — and resurrection. The delete+add content-similarity heuristic for backends and
 * workflows that *lose* rename detection is M2, and is deliberately not faked here: a
 * guessed rename that is wrong is worse than a missing one, because a missing one is
 * visible as two files while a wrong one silently welds two histories together.
 */

import type {
  ChangeKind,
  CommitId,
  FileEntity,
  FileFlag,
  FileId,
  PathAlias,
  PathId,
} from '@wise-excavate/core';
import { fileId } from '@wise-excavate/core';
import type { RawChange, RawCommit } from '@wise-excavate/git';

export interface RenameResolver {
  /**
   * Advance the `path → FileId` frontier across one commit's changes, and report which
   * file each change affected.
   *
   * Must be called once per commit, in walk order — the frontier *is* the state, and the
   * walk is single-pass by design.
   *
   * **It returns a per-change map rather than leaving the caller to re-derive identities
   * from paths**, because after a delete the path is no longer live and `resolve` cannot
   * answer for it. Re-deriving would silently drop exactly the change rows that record a
   * file's death, which is the half of its lifetime File Evolution most needs.
   */
  advance(
    commit: RawCommit,
    commitId: CommitId,
    classifyPath: PathClassifier,
  ): ReadonlyMap<RawChange, FileId>;
  /** The file currently living at `path`, or `null` if none does. */
  resolve(path: string): FileId | null;
  /**
   * Rows touched since the last drain, each carrying its **complete** current alias chain.
   *
   * Incremental because `changes.file_id REFERENCES files(id)` is immediate: a batch's file
   * rows must land in the same transaction as the change rows pointing at them. Safe to
   * re-emit a row in a later batch — `upsertFiles` rewrites a file's aliases wholesale, so
   * a rename that extends a chain replaces the row rather than appending a second, partial
   * view of it.
   */
  drain(internPath: (path: string) => PathId): readonly FileEntity[];
  /** Every file the walk has seen. Used by the final consistency pass and by tests. */
  all(internPath: (path: string) => PathId): readonly FileEntity[];
}

export type PathClassifier = (path: string) => readonly FileFlag[];

interface FileRow {
  readonly id: FileId;
  readonly born: CommitId;
  died: CommitId | null;
  /** Open-ended segments are closed when the path stops being live. */
  readonly aliases: { path: string; from: CommitId; to: CommitId | null }[];
  flags: readonly FileFlag[];
  /** Set for a copy; the source keeps its own identity. */
  copiedFrom: FileId | null;
  /** Highest path count seen at once, used only to detect the merge-reconciliation case. */
  language: string | null;
}

export function createRenameResolver(): RenameResolver {
  const files: FileRow[] = [];
  /** Rows changed since the last drain. A rename dirties two rows, not one. */
  const dirty = new Set<FileRow>();
  /** The frontier: path → the file currently living there. */
  const live = new Map<string, FileRow>();
  /**
   * Paths that have died, most recent first, so a later `Add` at the same path can be
   * recognised as a resurrection rather than a new file. Users think of "deleted the file,
   * brought it back" as one file, and treating it as two destroys File Evolution.
   */
  const buried = new Map<string, FileRow>();

  const open = (row: FileRow, path: string, at: CommitId): void => {
    row.aliases.push({ path, from: at, to: null });
    live.set(path, row);
    dirty.add(row);
  };

  const close = (row: FileRow, path: string, at: CommitId): void => {
    for (let i = row.aliases.length - 1; i >= 0; i -= 1) {
      const alias = row.aliases[i];
      if (alias !== undefined && alias.path === path && alias.to === null) {
        alias.to = at;
        break;
      }
    }
    live.delete(path);
    dirty.add(row);
  };

  const create = (
    path: string,
    at: CommitId,
    classify: PathClassifier,
    copiedFrom: FileId | null,
  ): FileRow => {
    const row: FileRow = {
      id: fileId(files.length + 1),
      born: at,
      died: null,
      aliases: [],
      flags: classify(path),
      copiedFrom,
      language: languageOf(path),
    };
    files.push(row);
    open(row, path, at);
    return row;
  };

  return {
    advance(commit, commitId, classifyPath) {
      /* Deletes are applied before adds within a commit. Git reports a rename as a single
         `rename` change, so a delete+add pair in one commit is genuinely two files at M1 —
         but applying deletes first means a path freed and reoccupied in the same commit
         resolves to the *new* occupant, which is what the change rows for that commit must
         record. Sorting a copy leaves `commit.changes` untouched, so the returned map keys
         on the caller's own objects and order is irrelevant to them. */
      const ordered = [...commit.changes].sort(
        (a, b) => deleteFirst(a.kind) - deleteFirst(b.kind),
      );

      const affected = new Map<RawChange, FileId>();
      for (const change of ordered) {
        const row = applyChange(change, commitId, classifyPath);
        if (row !== null) affected.set(change, row.id);
      }
      return affected;
    },

    resolve(path) {
      return live.get(path)?.id ?? null;
    },

    drain(internPath) {
      const drained = [...dirty].map((row) => toEntity(row, internPath));
      dirty.clear();
      return drained;
    },

    all(internPath) {
      return files.map((row) => toEntity(row, internPath));
    },
  };

  /** Returns the file the change affected, or `null` when the change names no path. */
  function applyChange(
    change: RawChange,
    at: CommitId,
    classifyPath: PathClassifier,
  ): FileRow | null {
    switch (change.kind) {
      case 'add': {
        const path = change.newPath;
        if (path === null) return null;

        /* Resurrection: same path, same file, a new alias segment after a gap. The gap is
           implicit in the alias list — the previous segment's `to` is set — which is
           exactly what keeps invariant 2 (no overlap) true. */
        const risen = buried.get(path);
        if (risen !== undefined) {
          buried.delete(path);
          risen.died = null;
          open(risen, path, at);
          return risen;
        }

        /* A path can already be live if a previous commit added it and nothing removed
           it — that is git reporting an add for a file we already track (it happens across
           merge reconciliation). Keep the existing identity rather than forking it. */
        const existing = live.get(path);
        if (existing !== undefined) return existing;
        return create(path, at, classifyPath, null);
      }

      case 'rename': {
        const from = change.oldPath;
        const to = change.newPath;
        if (from === null || to === null) return null;

        const row = live.get(from);
        if (row === undefined) {
          /* Renaming a path we do not track. Under `--first-parent` this is normal: the
             source may have been created on a side branch the projection skipped. Treat the
             destination as a new file rather than inventing lineage we cannot substantiate,
             and record the raw rename on the Change row regardless so M2 can reconcile it. */
          return live.get(to) ?? create(to, at, classifyPath, null);
        }

        close(row, from, at);
        /* If something already occupies the destination, it is being overwritten: close it
           out as dead before the renamed file takes the path, or two files would claim the
           same path and invariant 1 would break. */
        const displaced = live.get(to);
        if (displaced !== undefined && displaced !== row) {
          close(displaced, to, at);
          displaced.died = at;
          buried.set(to, displaced);
        }
        open(row, to, at);
        /**
         * Reclassify from the *current* path.
         *
         * `flags` and `language` describe what a file is, and a rename can change both.
         * rust-analyzer's `crates/ide-db/src/generated/lints.rs` was born as
         * `crates/completion/src/generated_lint_completions.rs` and moved four times; because it
         * was classified once at birth it carried no `generated` flag for its whole life and
         * ranked as the repository's top hotspot — a codegen artefact presented as the most
         * dangerous file in the codebase. `language` has the same exposure the moment a file moves
         * from `.js` to `.ts`.
         *
         * Replaced rather than unioned. A union can only accumulate, so a file promoted *out* of
         * `generated/` into hand-maintained source would stay flagged for good. These flags
         * answer "what is this file now"; the alias chain is what remembers where it has been.
         */
        row.flags = classifyPath(to);
        row.language = languageOf(to);
        return row;
      }

      case 'copy': {
        const to = change.newPath;
        if (to === null) return null;
        const already = live.get(to);
        if (already !== undefined) return already;
        /* A copy is a *new* file with a link to its source, never an alias. Aliases must
           stay non-overlapping in time (invariant 2), and a copy means both paths are live
           simultaneously — modelling it as an alias would break every downstream query. */
        const source =
          change.oldPath === null ? null : (live.get(change.oldPath) ?? null);
        return create(to, at, classifyPath, source?.id ?? null);
      }

      case 'delete': {
        const path = change.oldPath ?? change.newPath;
        if (path === null) return null;
        const row = live.get(path);
        if (row === undefined) return null;
        close(row, path, at);
        row.died = at;
        buried.set(path, row);
        return row;
      }

      case 'modify':
      case 'mode': {
        /* A modify to an untracked path means the walk never saw its creation — again
           normal under a projection that skips branches. Start tracking it from here, so
           its churn is attributed rather than dropped. */
        const path = change.newPath ?? change.oldPath;
        if (path === null) return null;
        const tracked = live.get(path);
        if (tracked !== undefined) return tracked;
        return create(path, at, classifyPath, null);
      }
    }
  }
}

/**
 * A row as a stored `FileEntity`.
 *
 * An alias still open is open because the file is live *now* — represented by `to: null`,
 * never by closing it at whatever commit happens to be current. Closing it would make the
 * file look dead to every time-windowed query.
 */
function toEntity(row: FileRow, internPath: (path: string) => PathId): FileEntity {
  const aliases: PathAlias[] = row.aliases.map((a) => ({
    path: internPath(a.path),
    from: a.from,
    to: a.to,
  }));
  const current = row.aliases.find((a) => a.to === null);
  return {
    id: row.id,
    currentPath: current === undefined ? null : internPath(current.path),
    aliases,
    born: row.born,
    died: row.died,
    language: row.language,
    flags: row.flags,
  };
}

/** Deletes sort before everything else; see the comment in `advance`. */
function deleteFirst(kind: ChangeKind): number {
  return kind === 'delete' ? 0 : 1;
}

/**
 * Language by extension.
 *
 * Deliberately a lookup table rather than anything cleverer: LEAN-V1 §3.1 cuts tree-sitter
 * and the language packs from v1 entirely, so this exists only to label a file in the
 * report. Anything that needs to *parse* a language arrives in v1.4 with the packs.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  rs: 'Rust',
  py: 'Python',
  go: 'Go',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  scala: 'Scala',
  ex: 'Elixir',
  exs: 'Elixir',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  sql: 'SQL',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  vue: 'Vue',
  svelte: 'Svelte',
  md: 'Markdown',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
};

export function languageOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? null;
}
