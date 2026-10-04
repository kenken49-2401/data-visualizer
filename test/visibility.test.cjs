'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { visibleForChatGPT } = require('../src/visibility.cjs');
const { normalizeSettings } = require('../src/settings.cjs');
test('ChatGPT visibility filter applies to all positions and fails closed', () => {
  for (const mode of ['screen', 'follow', 'manual']) {
    const settings = normalizeSettings({ mode });
    const active = { present: true, active: true, minimized: false, menuOpen: false };
    assert.equal(visibleForChatGPT(settings, active, false), true);
    for (const patch of [{ active: false }, { present: false }, { minimized: true }, { menuOpen: true }]) {
      assert.equal(visibleForChatGPT(settings, { ...active, ...patch }, false), false);
    }
    assert.equal(visibleForChatGPT(settings, null, false), false);
    assert.equal(visibleForChatGPT(settings, active, true), false);
  }
});
test('saved user preference can turn the ChatGPT visibility filter off', () => {
  assert.equal(visibleForChatGPT(normalizeSettings({ chatgptOnly: false }), null, true), true);
  assert.equal(normalizeSettings({ mode: 'manual', x: 10, y: 20 }).chatgptOnly, true);
});
