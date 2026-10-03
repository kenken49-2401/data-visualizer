'use strict';
let currentState;
const formatter = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });

function render(state) {
  currentState = state;
  const old = state.status === 'ready' && Date.now() - state.updatedAt > 120000;
  const status = old ? 'stale' : state.status;
  document.body.dataset.status = status;
  const stamp = state.updatedAt ? timeFormatter.format(new Date(state.updatedAt)) : '';
  const labels = {
    loading: '使用量を取得中…',
    ready: `残り割合 · ${stamp} 更新`,
    demo: 'デモ表示 · 実際の使用量ではありません',
    stale: old ? `前回の取得値 · ${stamp} 以降更新されていません` : `前回の取得値 · ${stamp} 更新 / ${state.error?.text ?? '更新失敗'}`,
    error: state.error?.text ?? '使用量を取得できません',
  };
  document.querySelector('#status').textContent = state.loginPending ? 'ブラウザでログインを完了してください' : labels[status];
  for (const key of ['fiveHour', 'weekly']) {
    const section = document.querySelector(`[data-window="${key}"]`);
    const quota = state.usage?.[key];
    section.querySelector('.value').textContent = quota ? `${Math.round(quota.remainingPercent * 10) / 10}%` : '—';
    section.querySelector('.fill').style.width = quota ? `${quota.remainingPercent}%` : '0%';
    section.dataset.level = quota && quota.remainingPercent <= 0 ? 'empty' : quota && quota.remainingPercent < 20 ? 'low' : 'normal';
    const progress = section.querySelector('.track');
    if (quota) progress.setAttribute('aria-valuenow', String(quota.remainingPercent));
    else progress.removeAttribute('aria-valuenow');
    const reset = section.querySelector('.reset');
    const hasDate = quota?.resetsAt && Number.isFinite(new Date(quota.resetsAt).getTime());
    reset.textContent = hasDate ? `リセット ${formatter.format(new Date(quota.resetsAt))}${Date.now() >= quota.resetsAt ? ' · 再取得待ち' : ''}` : 'リセット時刻：不明';
    reset.title = hasDate ? new Date(quota.resetsAt).toLocaleString('ja-JP') : '';
  }
  document.querySelector('#login').hidden = state.status !== 'error' || state.error?.kind !== 'auth';
  document.querySelector('#login').disabled = state.loginPending;
  document.querySelector('#cancel-login').hidden = !state.loginPending;
  document.querySelector('#refresh').disabled = state.status === 'demo';
  document.querySelector('#placement').textContent = state.trackerFailed ? '追従できないため画面左下' : state.placement === 'app' ? 'アプリ左下に追従' : '画面左下';
}

window.usageOverlay.subscribe(render);
window.usageOverlay.getState().then(render);
document.querySelector('#quit').addEventListener('click', () => void window.usageOverlay.quit());
document.querySelector('#login').addEventListener('click', () => void window.usageOverlay.login());
document.querySelector('#cancel-login').addEventListener('click', () => void window.usageOverlay.cancelLogin());
document.querySelector('#mode').addEventListener('click', () => void window.usageOverlay.setMode(currentState?.mode === 'follow' ? 'screen' : 'follow'));
document.querySelector('#refresh').addEventListener('click', async () => {
  const button = document.querySelector('#refresh');
  button.disabled = true;
  try { await window.usageOverlay.refresh(); } finally { button.disabled = false; }
});
setInterval(() => { if (currentState) render(currentState); }, 15000);
