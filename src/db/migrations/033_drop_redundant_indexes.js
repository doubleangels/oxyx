'use strict';

// Three indexes duplicate the leading columns of a wider index on the same
// table, so every write paid to maintain an index no query needs:
//  - idx_events_type (type)            covered by idx_events_type_id (type, id DESC)
//  - idx_library_sha (sha256)          covered by uniq_library_sha_cat (sha256, category)
//  - idx_chatcmd_server (server_id)    covered by UNIQUE (server_id, "trigger")
// IF EXISTS keeps this safe on a database where one was already removed.

function up(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_events_type;
    DROP INDEX IF EXISTS idx_library_sha;
    DROP INDEX IF EXISTS idx_chatcmd_server;
  `);
}

module.exports = { up };
