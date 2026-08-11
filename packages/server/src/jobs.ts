/**
 * The job queue: an async queue with an `AbortSignal`, and deliberately not the
 * scheduler with priorities and preemption that Part 13 §13.7 specified (LEAN-V1 §3.1).
 *
 * The only scheduling constraint that has ever mattered in this product is "one
 * concurrent index walk per session", which a concurrency limit expresses exactly. Every
 * additional feature a real scheduler has — priorities, preemption, dependencies,
 * requeueing — would be code with no caller.
 */

import { ExcavateError } from '@wise-excavate/core';

import type { JobQueue } from './index.js';

interface QueuedJob {
  readonly id: string;
  /** Its abort signal, created at submit time so `cancelAll` can reach a job that has been admitted but not yet begun. */
  readonly controller: AbortController;
  /** Opens the gate: the job may take its slot. */
  readonly admit: () => void;
  /** Refuses the job before it ever ran. */
  readonly refuse: (error: ExcavateError) => void;
}

export function createJobQueue(concurrency: number): JobQueue {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `job queue concurrency must be a positive integer, got ${concurrency}`,
    );
  }

  const waiting: QueuedJob[] = [];
  const running = new Set<AbortController>();
  let issued = 0;

  /**
   * Slots are taken synchronously, at admission rather than at first execution. Counting
   * them when the job's body actually starts — a microtask later — would let the loop
   * below admit the whole queue before any of it registered as running.
   */
  const pump = (): void => {
    while (running.size < concurrency) {
      const next = waiting.shift();
      if (next === undefined) return;
      running.add(next.controller);
      next.admit();
    }
  };

  return {
    /**
     * Resolves or rejects with the job's own outcome. Nothing is translated on the way
     * out: a caller that needs to distinguish "the job failed" from "the queue refused
     * it" branches on the `CANCELLED` code, not on a wrapper type.
     */
    submit<T>(kind: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
      issued += 1;
      const id = `${kind}-${issued}`;
      const controller = new AbortController();

      const admitted = new Promise<void>((admit, refuse) => {
        waiting.push({ id, controller, admit, refuse });
      });
      pump();

      return admitted.then(async () => {
        try {
          if (controller.signal.aborted) {
            throw new ExcavateError(
              'CANCELLED',
              `job ${id} was cancelled before it started`,
            );
          }
          // `run` may throw synchronously rather than returning a rejected promise;
          // either way it is this job failing, not the queue.
          return await run(controller.signal);
        } finally {
          running.delete(controller);
          pump();
        }
      });
    },

    /**
     * Aborts in-flight work and refuses everything still queued.
     *
     * Queued jobs are rejected rather than left to start later: after `cancelAll` the
     * caller's intent is unambiguous, and silently starting a job it just cancelled is
     * the kind of behaviour that makes cancellation untrustworthy. In-flight jobs get
     * their signal aborted and are left to settle on their own terms.
     */
    cancelAll(): void {
      for (const job of waiting.splice(0, waiting.length)) {
        job.refuse(
          new ExcavateError('CANCELLED', `job ${job.id} was cancelled before it started`),
        );
      }
      for (const controller of running) controller.abort();
    },

    get pending(): number {
      return waiting.length + running.size;
    },
  };
}
