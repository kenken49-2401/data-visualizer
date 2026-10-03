'use strict';
const { realpathSync } = require('node:fs');
const { fileURLToPath } = require('node:url');
function matchesDocument(value, expectedFile, { platform = process.platform, realpath = realpathSync } = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.search || url.hash) return false;
    const actual = realpath(fileURLToPath(url, { windows: platform === 'win32' }));
    const expected = realpath(expectedFile);
    // Windows may expand RUNNER~1 / other 8.3 aliases in a loaded document URL.
    return platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  } catch { return false; }
}
module.exports = { matchesDocument };
