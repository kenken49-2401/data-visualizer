'use strict';
// Visibility is independent of placement, so dragging never disables the filter.
function visibleForChatGPT(settings, tracked, failed) {
  if (!settings.chatgptOnly) return true;
  return !failed && tracked?.present === true && tracked.active === true &&
    tracked.minimized === false;
}
module.exports = { visibleForChatGPT };
