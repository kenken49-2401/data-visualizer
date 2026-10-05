'use strict';
const { randomBytes, hkdfSync, createCipheriv, createDecipheriv } = require('node:crypto');
const MAX_BYTES = 2 * 1024 * 1024;
function masterKey(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid recording key');
  return Buffer.from(value, 'hex');
}
function derive(master, purpose) {
  if (!['state', 'history'].includes(purpose)) throw new Error('Invalid purpose');
  return Buffer.from(hkdfSync('sha256', masterKey(master), 'codex-usage-overlay-v1', purpose, 32));
}
function seal(value, key, purpose) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`codex-usage:${purpose}:1`));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  if (data.length > MAX_BYTES) throw new Error('Oversized recording');
  return JSON.stringify({ schema: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}
function open(text, key, purpose) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('Invalid recording');
  const raw = JSON.parse(text);
  if (raw.schema !== 1 || !['iv', 'tag', 'data'].every(k => typeof raw[k] === 'string')) throw new Error('Invalid recording');
  const iv = Buffer.from(raw.iv, 'base64'), tag = Buffer.from(raw.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid recording');
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(Buffer.from(`codex-usage:${purpose}:1`)); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]).toString('utf8'));
}
module.exports = { derive, seal, open, masterKey, MAX_BYTES };
