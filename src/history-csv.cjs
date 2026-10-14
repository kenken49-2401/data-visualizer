'use strict';
function historyCsv(points) {
  const lines = ['timestamp_utc,five_hour_remaining_percent,seven_day_remaining_percent'];
  for (const p of points) lines.push([new Date(p.at).toISOString(), p.fiveHour ?? '', p.weekly ?? ''].join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}
module.exports = { historyCsv };
