'use strict';

function bottomLeft(area, size, inset = 14) {
  const width = Math.max(1, Math.min(size.width, area.width - Math.min(inset * 2, area.width - 1)));
  const height = Math.max(1, Math.min(size.height, area.height - Math.min(inset * 2, area.height - 1)));
  return { x: Math.round(area.x + Math.min(inset, Math.max(0, area.width - width))),
    y: Math.round(area.y + Math.max(0, area.height - height - inset)),
    width: Math.round(width), height: Math.round(height) };
}

function keepOnScreen(bounds, area) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return { width, height,
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)) };
}
module.exports = { bottomLeft, keepOnScreen };
