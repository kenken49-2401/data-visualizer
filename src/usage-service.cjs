'use strict';

const { EventEmitter } = require('node:events');
const { normalizeUsage, publicError } = require('./usage.cjs');

class UsageService extends EventEmitter {
  constructor(client, { intervalMs = 60000, clock = Date.now } = {}) {
    super();
    this.client = client;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.state = { status: 'loading', usage: null, updatedAt: null, error: null };
    this.timer = null;
    this.inflight = null;
    this.running = false;
    this.generation = 0;
    this.failures = 0;
    client.on('notification', (method) => {
      if (!this.running) return;
      if (method === 'account/updated' || method === 'account/login/completed') {
        // Do not show a previous account's quota after an account switch.
        this.generation++;
        this.publish({ status: 'loading', usage: null, updatedAt: null, error: null });
        void this.refresh();
      } else if (method === 'account/rateLimits/updated') {
        // Notifications may be sparse: reread the authoritative snapshot.
        void this.refresh();
      }
    });
  }

  publish(state) { this.state = state; this.emit('state', state); }
  start() { if (this.running) return; this.running = true; void this.refresh(); }

  async refresh() {
    if (this.inflight) return this.inflight;
    clearTimeout(this.timer);
    this.timer = null;
    const generation = this.generation;
    this.inflight = this.fetch(generation);
    try { await this.inflight; }
    finally {
      this.inflight = null;
      if (this.running) {
        // Retry sooner after an account change; otherwise back off on errors.
        const delay = generation !== this.generation ? 0 : Math.min(300000, this.intervalMs * 2 ** Math.min(this.failures, 3));
        this.timer = setTimeout(() => { void this.refresh(); }, delay);
      }
    }
  }

  async fetch(generation) {
    try {
      const response = await this.client.request('account/rateLimits/read', {});
      if (generation !== this.generation || !this.running) return;
      const usage = normalizeUsage(response);
      this.failures = 0;
      this.publish({ status: 'ready', usage, updatedAt: this.clock(), error: null });
    } catch (error) {
      if (generation !== this.generation || !this.running) return;
      this.failures++;
      if (error?.code === 'TIMEOUT') this.client.close();
      const safeError = publicError(error);
      // Authentication loss invalidates cached usage; connection failures may retain a labeled snapshot.
      const retain = safeError.kind !== 'auth' && this.state.usage != null;
      this.publish({ status: retain ? 'stale' : 'error', usage: retain ? this.state.usage : null,
        updatedAt: retain ? this.state.updatedAt : null, error: safeError });
    }
  }

  stop() { this.running = false; this.generation++; clearTimeout(this.timer); this.client.close(); }
}

module.exports = { UsageService };
