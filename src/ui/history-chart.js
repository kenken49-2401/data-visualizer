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
// Select real first/last/min/max readings per horizontal bucket. Segment IDs
// survive sampling, so hidden missing intervals never become invented traces.
function sampleHistory(points, key, start, end, columns = 320) {
  const buckets = new Map();
  historySegments(points, key).forEach((segment, id) => {
    for (const point of segment) {
      const column = Math.max(0, Math.min(columns - 1, Math.floor((point.at - start) / (end - start) * columns)));
      const item = { point, id }, bucket = buckets.get(column);
      if (!bucket) buckets.set(column, { first: item, last: item, min: item, max: item });
      else { bucket.last = item; if (point[key] < bucket.min.point[key]) bucket.min = item; if (point[key] > bucket.max.point[key]) bucket.max = item; }
    }
  });
  const selected = new Map(); for (const bucket of buckets.values()) for (const item of Object.values(bucket)) selected.set(item.point.at, item);
  const result = []; let id, segment;
  for (const item of [...selected.values()].sort((a, b) => a.point.at - b.point.at)) {
    if (item.id !== id) { id = item.id; segment = []; result.push(segment); } segment.push(item.point);
  }
  return result;
}
if (typeof module !== 'undefined') module.exports.sampleHistory = sampleHistory;
