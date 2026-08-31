'use strict';

// Hydro 5.0.0-beta.9 scans addon roots for index.js/index.ts and requires the
// discovered file directly; it does not resolve package.json#main.
module.exports = require('./dist/index.js');
