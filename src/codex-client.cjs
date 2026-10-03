'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { existsSync } = require('node:fs');
const path = require('node:path');

function codexExecutable() {
  const triples = {
    'win32-x64': ['win32-x64', 'x86_64-pc-windows-msvc'],
    'win32-arm64': ['win32-arm64', 'aarch64-pc-windows-msvc'],
    'linux-x64': ['linux-x64', 'x86_64-unknown-linux-musl'],
    'linux-arm64': ['linux-arm64', 'aarch64-unknown-linux-musl'],
    'darwin-x64': ['darwin-x64', 'x86_64-apple-darwin'],
    'darwin-arm64': ['darwin-arm64', 'aarch64-apple-darwin'],
  };
  const target = triples[`${process.platform}-${process.arch}`];
  try {
    if (!target) throw new Error('unsupported platform');
    const root = path.dirname(require.resolve(`@openai/codex-${target[0]}/package.json`));
    const executable = path.join(root, 'vendor', target[1], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (!existsSync(executable)) throw new Error('missing binary');
    return executable;
  } catch {
    throw Object.assign(new Error('Missing native Codex dependency'), { code: 'CLI_MISSING' });
  }
}

class CodexClient extends EventEmitter {
  constructor({ spawnProcess = spawn, executable = codexExecutable, timeoutMs = 20000, env = process.env } = {}) {
    super();
    this.spawnProcess = spawnProcess;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.starting = null;
    this.initialized = false;
  }

  async start() {
    if (this.initialized && this.process) return;
    if (this.starting) return this.starting;
    this.starting = this.connect();
    try { await this.starting; } finally { this.starting = null; }
  }

  async connect() {
    const child = this.spawnProcess(this.executable(), ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env,
    });
    this.process = child;
    let buffer = '';
    const disconnected = () => {
      if (this.process !== child) return;
      this.process = null;
      this.initialized = false;
      this.rejectPending(Object.assign(new Error('Codex disconnected'), { code: 'DISCONNECTED' }));
      this.emit('disconnected');
    };
    child.on('error', disconnected);
    child.on('exit', disconnected);
    child.stdin.on('error', disconnected);
    // Drain diagnostics without retaining credentials or arbitrary backend errors.
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.process !== child) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 2 * 1024 * 1024) { this.close(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { this.receive(JSON.parse(line)); } catch { /* non-JSON diagnostics are not UI data */ }
      }
    });
    try {
      await this.send('initialize', {
        clientInfo: { name: 'codex_usage_overlay', title: 'Codex Usage Overlay', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      });
      this.write({ method: 'initialized' });
      this.initialized = true;
    } catch (error) { this.close(); throw error; }
  }

  receive(message) {
    if (!message || typeof message !== 'object') return;
    if (Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(Object.assign(new Error(String(message.error.message ?? 'RPC error')), { code: message.error.code }));
      } else pending.resolve(message.result);
    } else if (typeof message.method === 'string') {
      this.emit('notification', message.method, message.params);
    }
  }

  write(message) {
    if (!this.process?.stdin.writable) throw Object.assign(new Error('Codex disconnected'), { code: 'DISCONNECTED' });
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async request(method, params = {}) { await this.start(); return this.send(method, params); }

  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  close() {
    const child = this.process;
    this.process = null;
    this.initialized = false;
    this.rejectPending(Object.assign(new Error('Codex stopped'), { code: 'DISCONNECTED' }));
    if (child) { child.stdin.end(); child.kill(); }
  }
}

module.exports = { CodexClient, codexExecutable };
