#!/usr/bin/env node
/**
 * intelephense-openidea — LSP middleware entry (stdio).
 *
 * 进程模型（docs/architecture.md）：
 *   client (openidea, php.toml: command=intelephense, args=["--stdio"])
 *     -> 本进程（中间件：Framer/Router/Caps/Engine）
 *       -> spawn 官方 intelephense --stdio（原样依赖，零修改零补丁）
 *
 * 生命周期：客户端 EOF/shutdown-exit 或官方进程退出时互相同步终止，避免僵尸进程。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Framer, type JsonRpcMessage } from './framer';
import { Router } from './router';
import { Engine } from './engine/engine';

function resolveOfficialServer(): string {
  try {
    return require.resolve('intelephense/lib/intelephense.js');
  } catch {
    return require('node:path').join(__dirname, '..', 'node_modules', 'intelephense', 'lib', 'intelephense.js');
  }
}

// openidea php.toml 两种拉起方式等价：`node dist/cli.js --stdio` 与 bin 脚本（package.json bin.intelephense）。
// 无参数 = 默认 stdio（php.toml args=["--stdio"] 透传场景与省略参数场景行为一致）；
// 未知参数仅 stderr 提示不阻断（保持 stdout 帧流纯净，协议通道绝不写日志）。
const argv = process.argv.slice(2);
for (const arg of argv) {
  if (arg === '--stdio') continue; // 官方子进程固定以 --stdio 拉起，此参数在此仅为兼容显式传入
  if (arg === '--version' || arg === '-v') {
    process.stdout.write('intelephense-openidea 0.3.0\n');
    process.exit(0);
  }
  process.stderr.write(`[intelephense-openidea] 未识别参数 ${arg}（忽略；默认以 stdio 模式运行）\n`);
}

const official: ChildProcess = spawn(process.execPath, [resolveOfficialServer(), '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const engine = new Engine();

const toServer = (msg: JsonRpcMessage): void => {
  if (official.stdin && !official.stdin.destroyed) official.stdin.write(Framer.encode(msg));
};
const toClient = (msg: JsonRpcMessage): void => {
  if (process.stdout.writable) process.stdout.write(Framer.encode(msg));
};

const router = new Router(engine, toClient, toServer);

const clientFramer = new Framer((msg) => router.onClientMessage(msg));
const serverFramer = new Framer((msg) => router.onServerMessage(msg));

process.stdin.on('data', (chunk: Buffer) => clientFramer.push(chunk));
official.stdout?.on('data', (chunk: Buffer) => serverFramer.push(chunk));

// 生命周期互相同步
let shuttingDown = false;
const terminate = (code: number): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    official.kill('SIGTERM');
  } catch {
    // already dead
  }
  // 给官方进程短暂收尾时间
  const killTimer = setTimeout(() => process.exit(code), 500);
  killTimer.unref();
  official.once('exit', () => process.exit(code));
};

process.stdin.on('end', () => terminate(0));
official.on('exit', (code) => {
  if (!shuttingDown) {
    shuttingDown = true;
    process.exit(code ?? 0);
  }
});
process.on('SIGTERM', () => terminate(0));
process.on('SIGINT', () => terminate(0));

official.on('error', (err) => {
  process.stderr.write(`[intelephense-openidea] failed to spawn official server: ${String(err)}\n`);
  process.exit(1);
});
