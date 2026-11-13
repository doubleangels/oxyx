'use strict';

// A game port change is now applied immediately (the container is rebuilt on
// the new port right away, and a running server restarted on it), so nothing
// is left "pending" any more. The columns from 029 stay (029 shipped on main).
// A server that had a pending move from an earlier build gets a history line
// saying the move was dropped, so nobody waits for a move that won't happen.

function up(db) {
  db.exec(`
    INSERT INTO events (server_id, actor, type, summary)
    SELECT id, 'system', 'config-changed',
           'A pending move to port ' || port_game_pending || ' was dropped by a panel update, so the server stays on '
             || port_game || '. Change the port again if you still want it.'
      FROM servers
     WHERE port_game_pending IS NOT NULL;
    UPDATE servers SET port_game_pending = NULL, port_rcon_pending = NULL
     WHERE port_game_pending IS NOT NULL OR port_rcon_pending IS NOT NULL;
  `);
}

module.exports = { up };
