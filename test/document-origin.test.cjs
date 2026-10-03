'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { matchesDocument } = require('../src/document-origin.cjs');
test('accepts the real app document but rejects remote, alternate and query URLs', () => {
  const file = path.join(__dirname, '..', 'src/ui/index.html');
  const url = pathToFileURL(file).href;
  assert.equal(matchesDocument(url, file), true);
  for (const value of ['https://unrelated.example/index.html', url + '?other=1', url + '#other', url.replace('index.html', 'style.css'), 'not a URL']) {
    assert.equal(matchesDocument(value, file), false);
  }
});
test('Windows short aliases and expanded long names identify the same document', () => {
  const file = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\overlay\\src\\ui\\index.html';
  const realpath = value => value.replace(/RUNNER~1/gi, 'runneradmin');
  assert.equal(matchesDocument('file:///C:/Users/runneradmin/AppData/Local/Temp/overlay/src/ui/index.html', file, { platform: 'win32', realpath }), true);
  assert.equal(matchesDocument('file:///C:/Users/runneradmin/AppData/Local/Temp/another/src/ui/index.html', file, { platform: 'win32', realpath }), false);
});
