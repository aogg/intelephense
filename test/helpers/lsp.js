'use strict';
/**
 * test/helpers/lsp.js — 独立最小 stdio LSP 客户端（与 scripts/probe.ts 的 ProbeClient 无共享代码）。
 *
 * - Content-Length 帧解析 / JSON-RPC 请求 / 通知 / 超时
 * - 对「服务端 → 客户端」请求按客户端惯例应答（workspace/configuration 等），避免官方服务等待悬挂
 * - 请求可携带 timeLabel，自动记录耗时到 client.timings
 * - 收集 window/logMessage（用于 initialize 就绪判断）与全部服务端通知
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

class LspClient {
  /**
   * @param {object} opts
   * @param {string} opts.cliPath 中间件入口（dist/cli.js）
   * @param {string[]} [opts.serverArgs] 命令行参数（['--stdio'] 或 []）
   * @param {string} opts.cwd 工作目录
   * @param {string} [opts.name] 客户端标签
   * @param {number} [opts.requestTimeoutMs] 默认请求超时
   */
  constructor(opts) {
    this.name = opts.name || 't5-client';
    this.requestTimeoutMs = opts.requestTimeoutMs || 45000;
    this.timings = [];
    this.notifications = [];
    this.logLines = [];
    this.serverRequests = [];
    this.exitInfo = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.buffer = Buffer.alloc(0);
    this.stderrTail = '';

    this.child = spawn(process.execPath, [opts.cliPath, ...(opts.serverArgs || [])], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (c) => this._push(c));
    this.child.stderr.on('data', (c) => {
      this.stderrTail = (this.stderrTail + c.toString()).slice(-4000);
    });
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal, at: Date.now() };
      for (const [, p] of this.pending) {
        p.reject(new Error(`${this.name}: server exited (code=${code} signal=${signal}) while awaiting response`));
      }
      this.pending.clear();
    });
  }

  get pid() {
    return this.child.pid;
  }

  get alive() {
    return this.exitInfo === null;
  }

  _push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const sep = this.buffer.indexOf('\r\n\r\n');
      if (sep < 0) break;
      const header = this.buffer.slice(0, sep).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) break;
      const len = parseInt(m[1], 10);
      const total = sep + 4 + len;
      if (this.buffer.length < total) break;
      const body = this.buffer.slice(sep + 4, total).toString('utf8');
      this.buffer = this.buffer.slice(total);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // 服务端 → 客户端请求：按惯例应答，避免服务端挂等
    if (msg.method !== undefined && msg.id !== undefined) {
      this.serverRequests.push({ method: msg.method, params: msg.params });
      let result = null;
      if (msg.method === 'workspace/configuration') {
        const items = ((msg.params || {}).items || []).map(() => ({}));
        result = items;
      }
      try {
        this._write({ jsonrpc: '2.0', id: msg.id, result });
      } catch {
        // 通道已关
      }
      return;
    }
    // 通知
    if (msg.method !== undefined) {
      this.notifications.push(msg);
      if (msg.method === 'window/logMessage') {
        this.logLines.push(String((msg.params || {}).message || ''));
      }
      this.waiters = this.waiters.filter((w) => {
        if (w.match(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
      return;
    }
    // 对自己请求的响应
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      p.resolve(msg);
    }
  }

  _write(msg) {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  /** 发请求；opts.timeoutMs 超时；opts.timeLabel 记录耗时（ms）到 this.timings */
  request(method, params, opts = {}) {
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs || this.requestTimeoutMs;
    const started = process.hrtime.bigint();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: timeout ${timeoutMs}ms waiting ${method} (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    this._write({ jsonrpc: '2.0', id, method, params });
    return (async () => {
      const resp = await promise;
      if (opts.timeLabel) {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        this.timings.push({ label: opts.timeLabel, method, ms: Math.round(ms * 10) / 10 });
      }
      return resp;
    })();
  }

  /** 取某 timeLabel 最近一次耗时（ms）；无记录返回 null */
  lastTiming(label) {
    const hits = this.timings.filter((t) => t.label === label);
    return hits.length ? hits[hits.length - 1].ms : null;
  }

  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  /** 等待匹配的通知出现；超时返回 null（不抛错） */
  waitNotification(matchFn, timeoutMs = 8000) {
    const hit = this.notifications.find(matchFn);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        resolve(null);
      }, timeoutMs);
      this.waiters.push({
        match: matchFn,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** initialize + initialized 通知；可选等待官方 "Initialising intelephense" 日志（超时不失败） */
  async initialize(rootUri, rootPath, opts = {}) {
    const waitForReadyMs = opts.waitForReadyMs === undefined ? 20000 : opts.waitForReadyMs;
    const resp = await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        rootPath,
        workspaceFolders: [{ uri: rootUri, name: path.basename(rootPath) }],
        capabilities: {
          textDocument: {
            completion: { completionItem: { snippetSupport: false } },
            synchronization: { didSave: true },
          },
          workspace: { workspaceFolders: true },
        },
      },
      { timeLabel: opts.timeLabel },
    );
    this.notify('initialized', {});
    if (waitForReadyMs > 0) {
      const start = Date.now();
      while (Date.now() - start < waitForReadyMs) {
        if (this.logLines.some((l) => l.includes('Initialising intelephense'))) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return resp;
  }

  /** 规范 shutdown → exit 通知；5s 未退出 SIGKILL 兜底。返回 {shutdownOk, exitWithinMs, exitCode, signal} */
  async stop() {
    const out = { shutdownOk: false, exitWithinMs: null, exitCode: null, signal: null };
    try {
      const resp = await this.request('shutdown', null, { timeoutMs: 5000 });
      out.shutdownOk = !resp.error;
    } catch {
      // 超时也继续发 exit
    }
    try {
      this.notify('exit', null);
    } catch {
      // stdin 可能已关
    }
    const t0 = Date.now();
    const exited = await new Promise((resolve) => {
      if (this.exitInfo) return resolve(true);
      this.child.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 5000);
    });
    if (!exited) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 100));
    out.exitWithinMs = this.exitInfo ? Date.now() - t0 : null;
    out.exitCode = this.exitInfo ? this.exitInfo.code : null;
    out.signal = this.exitInfo ? this.exitInfo.signal : null;
    return out;
  }
}

module.exports = { LspClient };
