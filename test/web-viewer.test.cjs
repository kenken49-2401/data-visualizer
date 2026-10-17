'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { VIEWER_URL, viewerAccessKey } = require('../src/web-viewer.cjs');
const { derive, seal, open } = require('../src/cloud-crypto.cjs');
test('the desktop exports a read-only history key and a fixed key-free viewer URL', () => {
  const master = '6'.repeat(64), history = derive(master, 'history'), exported = viewerAccessKey({ key: history });
  assert.equal(exported, `view:${history.toString('hex')}`); assert.ok(!exported.includes(master));
  assert.equal(VIEWER_URL, 'https://kenken49-2401.github.io/data-visualizer/'); assert.equal(new URL(VIEWER_URL).hash, ''); assert.equal(new URL(VIEWER_URL).search, '');
  const vault = seal({ auth: 'only-a-test' }, derive(master, 'state'), 'state');
  assert.throws(() => open(vault, Buffer.from(exported.slice(5), 'hex'), 'state'));
  for (const config of [{}, { key: Buffer.alloc(31) }, { key: master }]) assert.throws(() => viewerAccessKey(config));
});
