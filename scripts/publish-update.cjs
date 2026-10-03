'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { FILES, BASE, validateBundle } = require('../src/updater.cjs');
const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const files = {};
const names = new Set(FILES);
function discover(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) discover(name);
    else if (entry.isFile()) names.add(name);
    else throw new Error('Source bundles must not contain symlinks');
  }
}
discover('src');
for (const name of [...names].sort()) {
  const binary = /\.(png|ico|woff2)$/.test(name);
  const content = fs.readFileSync(path.join(root, name)).toString(binary ? 'base64' : 'utf8');
  files[name] = { encoding: binary ? 'base64' : 'utf8', content: binary ? content : content.replace(/\r\n/g, '\n') };
}
const bundle = { schema: 1, version, files };
validateBundle(bundle, version);
const bytes = Buffer.from(JSON.stringify(bundle));
const destination = path.join(root, 'updates', `${version}.json`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
if (fs.existsSync(destination) && !fs.readFileSync(destination).equals(bytes)) throw new Error('Published versions are immutable; bump the version before publishing another bundle');
fs.writeFileSync(destination, bytes);
fs.writeFileSync(path.join(root, 'update.json'), JSON.stringify({ schema: 1, version, url: `${BASE}updates/${version}.json`, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
console.log(`Prepared GitHub update ${version} (${bytes.length} bytes)`);
