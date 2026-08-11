/**
 * The progress bus: SSE, not WebSocket (LEAN-V1 §5).
 *
 * Progress and streamed tokens are strictly server→client, so SSE is about ten lines,
 * reconnects natively, and needs no upgrade-handshake origin validation. That makes the
 * bus itself the only moving part, and it stays synchronous: publishing is called from
 * inside the index walk's hot loop, where allocating a promise per commit would be
 * measurable and pointless.
 */

import type { ServerEvent } from '@wise-excavate/core';

import type { ProgressBus } from './index.js';

/**
 * A throwing subscriber must not stop the other subscribers from receiving the event,
 * and must never propagate into the publisher. The publisher is usually the index walk;
 * a dropped SSE connection failing mid-write must not abort an index run.
 *
 * Iteration is over a copy of the listener set, so subscribing or unsubscribing from
 * inside a listener — which is exactly what an SSE teardown does — cannot corrupt the
 * in-flight dispatch.
 */
export function createProgressBus(): ProgressBus {
  const listeners = new Set<(event: ServerEvent) => void>();

  return {
    publish(event: ServerEvent): void {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          /* An advisory event's delivery is never worth failing the producer over. */
        }
      }
    },

    subscribe(listener: (event: ServerEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
