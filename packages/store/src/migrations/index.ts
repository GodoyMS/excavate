/**
 * The migration list.
 *
 * Ordered, forward-only, and the single source of truth for what schema v`n` means:
 * `docs/schema.md` is generated from it, `SCHEMA_VERSION` is *derived* from it rather
 * than declared beside it, and `openStore` refuses any database whose recorded
 * version exceeds it (Part 9 §9.10).
 *
 * Deriving the version matters more than it looks. A hand-maintained constant that
 * disagrees with the list produces an index that migrates correctly and then reports
 * itself corrupt forever — a bug with no visible cause. Adding a migration is
 * therefore exactly one edit: append the module below.
 */

import { ExcavateError } from '@wise-excavate/core';

import type { Migration } from '../index.js';
import { migration as init } from './0001-init.js';

const ORDERED: readonly Migration[] = [init];

/** The ordered migration list. `docs/schema.md` is generated from it. */
export function migrations(): readonly Migration[] {
  return ORDERED;
}

/** The highest schema version this build can produce. */
export function latestSchemaVersion(): number {
  const last = ORDERED[ORDERED.length - 1];
  return last === undefined ? 0 : last.version;
}

/**
 * Called from `migrate()`. Sequential-and-gapless is not pedantry: `migrate()` applies
 * every migration whose version exceeds the stored one, so a duplicated or skipped
 * version would silently re-run or omit DDL and leave a database that claims a schema
 * it does not have.
 */
export function assertMigrationsWellFormed(): void {
  ORDERED.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new ExcavateError(
        'MIGRATION_FAILED',
        `migration ${migration.name} declares version ${migration.version} but sits at ` +
          `position ${index + 1}; the list must be sequential and gapless`,
        { details: { migration: migration.name, position: index + 1 } },
      );
    }
  });
}
