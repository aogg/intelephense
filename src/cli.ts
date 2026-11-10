#!/usr/bin/env node
/**
 * intelephense-openidea — LSP middleware entry (stdio).
 *
 * 进程模型（MVP 脚手架占位，详见 docs/architecture.md）：
 *   client (openidea, php.toml: command=intelephense, args=["--stdio"])
 *     -> 本进程 (中间件)
 *       -> spawn 官方 intelephense --stdio（原样依赖，不改其文件）
 *
 * 本阶段仅完成双向 stdio 透传，保证 `intelephense --stdio` 以官方行为启动；
 * initialize 拦截、serverCapabilities 合并、语义引擎见 docs/architecture.md。
 */
import { spawn } from 'node:child_process';

function resolveOfficialServer(): string {
  // 官方包原样依赖：优先 require.resolve，兜底 node_modules 相对路径。
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require.resolve('intelephense/lib/intelephense.js');
  } catch {
    return require('node:path').join(__dirname, '..', 'node_modules', 'intelephense', 'lib', 'intelephense.js');
  }
}

const child = spawn(process.execPath, [resolveOfficialServer(), '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

// 透传阶段：客户端 -> 官方服务
process.stdin.pipe(child.stdin);
// 官方服务 -> 客户端（后续在此做响应拦截/合并）
child.stdout.pipe(process.stdout);

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
