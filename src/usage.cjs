'use strict';

// A primary/secondary position alone is not evidence of a five-hour/week quota.
function normalizeWindow(raw, expectedMinutes) {
  if (!raw || raw.windowDurationMins !== expectedMinutes ||
      typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent) || raw.usedPercent < 0) {
    return null;
  }
  const remainingPercent = Math.max(0, 100 - raw.usedPercent);
  const resetsAt = Number.isSafeInteger(raw.resetsAt) && raw.resetsAt > 0
    ? raw.resetsAt * 1000 : null;
  return { usedPercent: raw.usedPercent, remainingPercent, resetsAt };
}

function normalizeUsage(response) {
  const bucket = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  if (!bucket || (bucket.limitId != null && bucket.limitId !== 'codex')) {
    throw Object.assign(new Error('Codex usage unavailable'), { code: 'NO_CODEX_QUOTA' });
  }
  const windows = [bucket.primary, bucket.secondary];
  return {
    fiveHour: windows.map(raw => normalizeWindow(raw, 300)).find(Boolean) ?? null,
    weekly: windows.map(raw => normalizeWindow(raw, 10080)).find(Boolean) ?? null,
    plan: typeof bucket.planType === 'string' ? bucket.planType : null,
  };
}

function publicError(error) {
  // RPC errors can contain backend URLs or account details. Do not display/log them.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/authentication required|not logged in|unauthorized|\b401\b/i.test(message)) {
    return { kind: 'auth', text: '同じ Plus アカウントでログインしてください' };
  }
  if (error?.code === 'TIMEOUT') return { kind: 'timeout', text: '取得がタイムアウトしました。再試行します' };
  if (error?.code === 'CLI_MISSING') return { kind: 'cli', text: 'Codex の実行ファイルがありません。npm ci を実行してください' };
  if (error?.code === 'NO_CODEX_QUOTA') return { kind: 'quota', text: 'Codex の利用枠が返されませんでした' };
  return { kind: 'connection', text: '使用量を取得できません。接続とログインを確認してください' };
}

function demoUsage(now = Date.now()) {
  return {
    fiveHour: { usedPercent: 28, remainingPercent: 72, resetsAt: now + 2 * 60 * 60 * 1000 },
    weekly: { usedPercent: 59, remainingPercent: 41, resetsAt: now + 3 * 24 * 60 * 60 * 1000 },
    plan: 'plus',
  };
}

module.exports = { normalizeWindow, normalizeUsage, publicError, demoUsage };
