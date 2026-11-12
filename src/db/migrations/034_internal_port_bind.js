'use strict';

// Server containers now publish RCON and BlueMap on an internal address only
// (see src/docker/internalBind.js). Docker fixes port bindings when a container
// is created, so existing containers keep the old every-interface bindings
// until they are rebuilt. Flag them: a pending rebuild shows in the UI and is
// applied automatically on the next start.

function up(db) {
  db.exec(`UPDATE servers SET pending_recreate = 1 WHERE deleted_at IS NULL AND container_id IS NOT NULL`);
}

module.exports = { up };
