'use strict';

// Settings and lifecycle for the panel's one http.Server, kept out of
// server.js so they can be tested without booting the whole panel.

/**
 * Node ends any request that takes longer than `requestTimeout` (300 s by
 * default) from first byte to last. Uploads go up to 4 GB per file, which at
 * a 20 Mbps uplink is about 27 minutes, so that ceiling cut off anything over
 * roughly 750 MB. Uploads are bounded by size limits and the disk quota
 * instead. `headersTimeout` stays, so a client that dribbles its headers
 * (slowloris) is still dropped.
 * @param {import('node:http').Server} httpServer
 */
function configureHttpTimeouts(httpServer) {
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 60_000;
  return httpServer;
}

/**
 * Stop cleanly on SIGTERM/SIGINT: stop accepting connections, close live
 * WebSocket views (an open socket would hold httpServer.close() forever),
 * let in-flight requests finish, then checkpoint and close the database so
 * the WAL is folded back into panel.db. A hard deadline (`graceMs`) caps it
 * below Docker's default 10 s stop timeout, after which the process exits 1.
 * @param {import('node:http').Server} httpServer
 * @param {{
 *   getWss: () => (import('ws').WebSocketServer | null | undefined),
 *   closeDb: () => void,
 *   exit: (code: number) => void,
 *   logger: { info: Function, warn: Function },
 *   graceMs?: number,
 * }} deps
 * @returns {(signal: string) => void} the shutdown function (also bound to the signals)
 */
function installGracefulShutdown(httpServer, { getWss, closeDb, exit, logger, graceMs = 8000 }) {
  let stopping = false;
  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting the panel down.', { signal });
    const deadline = setTimeout(() => {
      logger.warn('The panel did not stop in time, so it is exiting now.', { graceMs });
      httpServer.closeAllConnections();
      exit(1);
    }, graceMs);
    deadline.unref();

    const wss = getWss();
    if (wss) {
      for (const ws of wss.clients) {
        ws.close(1001, 'Panel shutting down');
        // A client that never answers the close frame still has to let go.
        setTimeout(() => ws.terminate(), 1000).unref();
      }
    }
    httpServer.close(() => {
      try {
        closeDb();
      } catch (err) {
        logger.warn('Closing the database during shutdown failed.', { err: err && err.message });
      }
      clearTimeout(deadline);
      exit(0);
    });
    // Keep-alive sockets with no request in flight would otherwise hold close() open.
    httpServer.closeIdleConnections();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
}

module.exports = { configureHttpTimeouts, installGracefulShutdown };
