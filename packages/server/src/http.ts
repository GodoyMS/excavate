/**
 * The Node listener.
 *
 * Separate from `createApp` for two reasons: the routes are then testable through
 * `app.request()` with no socket at all, and the one genuinely security-relevant line in
 * the daemon — the bind address — sits by itself where it cannot be lost in a diff.
 */

import { serve } from '@hono/node-server';
import { BIND_HOST } from '@wise-excavate/core';
import type { Hono } from 'hono';

export interface Listener {
  /** The address actually bound. Asserted in tests: it must always be loopback. */
  readonly host: string;
  /** The port actually bound, which with `port: 0` is one the OS chose. */
  readonly port: number;
  close(): Promise<void>;
}

export interface ListenOptions {
  /**
   * Where a server error raised *after* the socket is bound goes.
   *
   * It needs somewhere to go. An `'error'` event with no listener is an uncaught
   * exception, and a listener that discards it is a daemon that stops working without
   * saying why — so the default writes one line to stderr. The listener cannot report it
   * through the bind promise, which has already settled.
   */
  readonly onError?: (error: Error) => void;
}

function warn(error: Error): void {
  process.stderr.write(`excavate: the daemon's listener failed: ${error.message}\n`);
}

/**
 * Binds `BIND_HOST` and nothing else — never `0.0.0.0`, not even behind a flag (Part 7
 * §7.4.2). Remote use goes through SSH tunnelling, which costs the user one flag and
 * costs the product no exposure.
 *
 * Resolves only once the socket is listening, so the caller can hand out a URL that is
 * immediately connectable rather than one that races.
 */
export function listen(
  app: Hono,
  port: number,
  options: ListenOptions = {},
): Promise<Listener> {
  const onError = options.onError ?? warn;

  return new Promise<Listener>((resolveListener, rejectListener) => {
    /* EADDRINUSE and EACCES arrive as an event, not as a throw from `serve`. */
    const onBindError = (error: Error): void => {
      rejectListener(error);
    };

    const server = serve({ fetch: app.fetch, hostname: BIND_HOST, port }, (info) => {
      /* The bind phase is over, so a further `'error'` must not be dropped into a settled
         promise — which is what a single `on('error', reject)` would do. */
      server.off('error', onBindError);
      server.on('error', onError);

      resolveListener({
        host: info.address,
        port: info.port,
        close: () =>
          new Promise<void>((closed, failed) => {
            /* `close()` waits for open connections to end, and an SSE stream never
               ends on its own — so drop the sockets first or `close()` never resolves.
               Only the plain HTTP adapter is used, hence the capability check rather
               than a cast. */
            if ('closeAllConnections' in server) server.closeAllConnections();
            /* Detached first: closing is not a failure to report. */
            server.off('error', onError);
            server.close((error) => (error ? failed(error) : closed()));
          }),
      });
    });

    server.once('error', onBindError);
  });
}
