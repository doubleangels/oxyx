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

module.exports = { configureHttpTimeouts };
