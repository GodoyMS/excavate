/**
 * Time.
 *
 * Git records two timestamps per commit and Excavate keeps both, per Part 8
 * §8.2.1: author date is what a human means by "when", commit date is what
 * topology means, and rebased repositories diverge wildly. The original UTC
 * offset is preserved too, because "committed at 3am local time" is occasionally
 * meaningful evidence.
 */

/** An instant, with the wall-clock offset it was originally recorded in. */
export interface Timestamp {
  /** Seconds since the Unix epoch, UTC. */
  readonly epochSeconds: number;
  /** Minutes east of UTC, as recorded by Git. `-480` for UTC-08:00. */
  readonly offsetMinutes: number;
}

export const EPOCH: Timestamp = { epochSeconds: 0, offsetMinutes: 0 };

export function timestamp(epochSeconds: number, offsetMinutes = 0): Timestamp {
  if (!Number.isFinite(epochSeconds)) {
    throw new RangeError(`epochSeconds must be finite, got ${epochSeconds}`);
  }
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 24 * 60) {
    throw new RangeError(`offsetMinutes out of range: ${offsetMinutes}`);
  }
  return { epochSeconds: Math.trunc(epochSeconds), offsetMinutes };
}

export function toDate(ts: Timestamp): Date {
  return new Date(ts.epochSeconds * 1000);
}

export function fromDate(date: Date, offsetMinutes = 0): Timestamp {
  return timestamp(Math.trunc(date.getTime() / 1000), offsetMinutes);
}

/** Sort comparator. Ordering is by instant; the offset never affects it. */
export function compareTimestamps(a: Timestamp, b: Timestamp): number {
  return a.epochSeconds - b.epochSeconds;
}

/**
 * ISO-8601 in the timestamp's *original* offset, which is what Git shows and what
 * makes local-time evidence readable. `toDate().toISOString()` would normalise to
 * UTC and lose that.
 */
export function toIsoWithOffset(ts: Timestamp): string {
  const shifted = new Date((ts.epochSeconds + ts.offsetMinutes * 60) * 1000);
  const local = shifted.toISOString().slice(0, 19);
  if (ts.offsetMinutes === 0) return `${local}Z`;

  const sign = ts.offsetMinutes < 0 ? '-' : '+';
  const total = Math.abs(ts.offsetMinutes);
  const hh = String(Math.trunc(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

/** A half-open interval `[from, to)`. Era boundaries rely on the half-openness to partition history without overlap (Part 8 §8.8, invariant 6). */
export interface TimeWindow {
  readonly from: Timestamp;
  readonly to: Timestamp;
}

export function timeWindow(from: Timestamp, to: Timestamp): TimeWindow {
  if (compareTimestamps(from, to) > 0) {
    throw new RangeError('time window `from` must not be after `to`');
  }
  return { from, to };
}

export function windowContains(window: TimeWindow, ts: Timestamp): boolean {
  return compareTimestamps(ts, window.from) >= 0 && compareTimestamps(ts, window.to) < 0;
}

export const SECONDS_PER_DAY = 86_400;

/**
 * The knowledge half-life from Part 8 §8.5.2: knowledge of a file halves roughly
 * annually. Exported here because both the analysis and evidence packages apply
 * the same decay and must not each carry their own constant.
 */
export const KNOWLEDGE_DECAY_TAU_DAYS = 365;
