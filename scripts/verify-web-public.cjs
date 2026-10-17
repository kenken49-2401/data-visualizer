'use strict';

// Deployment validation runs on GitHub's runner. It never reads recording keys
// or user history, and verifies only the public static page and its assets.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const origin = 'https://kenken49-2401.github.io/data-visualizer/';
const files = [
  ['', /使用量の推移/, /text\/html/],
  ['app.mjs', /loadLatest/, /javascript/],
  ['data.mjs', /crypto\.subtle/, /javascript/],
  ['styles.css', /\.quota-card/, /text\/css/],
  ['icon.svg', /<svg/, /image\/svg/]
];
async function verify() {
  for (const [file, marker, mime] of files) {
    const response = await fetch(origin + file, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, `Public asset unavailable: ${file || 'index'}`);
    assert.match(response.headers.get('content-type') || '', mime, `Incorrect public asset MIME: ${file}`);
    const body = await response.text();
    assert.match(body, marker, `Incorrect public asset content: ${file}`);
    assert.equal(body, readFileSync(path.join(__dirname, '..', 'web', file || 'index.html'), 'utf8'), `Deployment has an older asset: ${file || 'index'}`);
  }
}
async function main() {
  let failure;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await verify(); console.log(`Public viewer verified: ${origin}`); return; }
    catch (error) { failure = error; if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 5000)); }
  }
  throw failure;
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
