'use strict';
const VIEWER_URL = 'https://kenken49-2401.github.io/data-visualizer/';
function viewerAccessKey(config) {
  if (!Buffer.isBuffer(config?.key) || config.key.length !== 32) throw new Error('Cloud recording is not configured');
  // Export only the derived history key; this cannot unlock the cloud auth vault.
  return `view:${config.key.toString('hex')}`;
}
module.exports = { VIEWER_URL, viewerAccessKey };
