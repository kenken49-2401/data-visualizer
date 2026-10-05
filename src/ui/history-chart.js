'use strict';
// Shared by the sandboxed renderer and Node tests: elapsed time determines x,
// and missing samples always break the trace rather than inventing a value.
function historySegments(points, key) {
  const result = []; let segment = [], last;
  for (const point of points) {
    const value = point[key];
    if (!Number.isFinite(value)) { if (segment.length) result.push(segment); segment = []; last = undefined; continue; }
    if (last && point.at - last.at > Math.max(last.gapMs, point.gapMs)) { result.push(segment); segment = []; }
    segment.push(point); last = point;
  }
  if (segment.length) result.push(segment);
  return result;
}
if (typeof module !== 'undefined') module.exports = { historySegments };
