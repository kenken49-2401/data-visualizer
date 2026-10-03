'use strict';
const { CodexClient } = require('../src/codex-client.cjs');
const { normalizeUsage, publicError } = require('../src/usage.cjs');

async function main() {
  const client = new CodexClient();
  try {
    const usage = normalizeUsage(await client.request('account/rateLimits/read', {}));
    console.log(JSON.stringify({ fiveHour: usage.fiveHour, weekly: usage.weekly, plan: usage.plan }, null, 2));
    if (!usage.fiveHour || !usage.weekly) {
      console.error('5時間・7日間の両方を確認できませんでした。返された期間は推測で補いません。');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(publicError(error).text);
    process.exitCode = 1;
  } finally { client.close(); }
}
void main();
