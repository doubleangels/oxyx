// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// JSON API consumed by the panel's own frontend.

// Mounted at /api. The routes live in ./api/, one module per domain, all
// registering on the one router in ./api/router.js. ORDER MATTERS: servers.js
// installs the /servers/:id serverScope gate that every later per-server route
// relies on, and the JSON error handler must come after every route.

const { makeJsonErrorHandler } = require('../middleware/jsonErrorHandler');
const router = require('./api/router');

require('./api/servers');
require('./api/keys');
require('./api/settings');
require('./api/apiTokens');
require('./api/packs');
require('./api/schedules');
require('./api/storage');
require('./api/backups');
require('./api/serverFeatures');
require('./api/mods');
require('./api/events');
require('./api/icons');
require('./api/users');
require('./api/modBrowser');

router.use(makeJsonErrorHandler('api', { fileTooLarge: 'That image is too large (max 16 MB).' }));

module.exports = router;
