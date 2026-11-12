'use strict';

// The one Express router behind /api. Every module in this folder registers its
// routes on it, and ../api.js requires them in a fixed order, so middleware
// order (serverScope before the per-server routes, the error handler last) and
// the flat route stack are exactly what a single file would produce.

const express = require('express');

module.exports = express.Router();
