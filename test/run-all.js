#!/usr/bin/env node
'use strict';
/**
 * test/run-all.js — T5 独立协议级验证套件入口（npm test）。
 *
 * 与 scripts/probe.ts 相互独立：独立 stdio LSP 客户端、独立定位/断言工具、独立用例集。
 *
 * 执行顺序：
 *   D1 干净构建（rm -rf dist && npm ci && npm run build，验证 lockfile 完整性；--skip-build 可跳过）
 *   D2 php.toml 两种拉起形态（--stdio / 无参数）initialize
 *   A  用户验收底线（zuodian 真实文件 $this->auth 四角度 + typeHierarchy + @property 通道）
 *   B  全功能扫描（真实文件优先，合成文档补齐）
 *   C  健壮性（语法错误 / 增量 didChange / didClose / 配置转发 / 大文件耗时）
 *   D3 官方免费透传不退化（references / documentSymbol / workspaceSymbol / formatting）
 *   C6 生命周期（initialize → shutdown → exit 干净退出 + 无悬挂子进程，独立客户端）
 *   Z  残留自检（zuodian 零落盘）
 *
 * 运行：
 *   npm test                          # 全量（含干净构建）
 *   node test/run-all.js --skip-build # 跳过干净构建（复用现有 dist，迭代用）
 *
 * 环境变量：
 *   T5_ZUODIAN_ROOT  目标项目根（默认 /code/www/gs/zuodian-worktree/zuodian--temp）
 *
 * 输出：逐项 PASS/FAIL + 证据；汇总表 + 耗时表；报告 JSON 写 /tmp/t5-report.json。
 * 退出码：0 全过 / 1 有失败 / 2 环境致命错误。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Suite } = require('./helpers/suite');
const { LspClient } = require('./helpers/lsp');
const T = require('./helpers/text');
const groupA = require('./groups/a-acceptance');
const groupB = require('./groups/b-features');
const groupC = require('./groups/c-robustness');
const groupD = require('./groups/d-env');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'dist', 'cli.js');
const ZUODIAN = process.env.T5_ZUODIAN_ROOT || '/code/www/gs/zuodian-worktree/zuodian--temp';

async function main() {
  const skipBuild = process.argv.slice(2).includes('--skip-build');
  const suite = new Suite();
  const startedAt = Date.now();

  // ---------- 环境预检 ----------
  if (!fs.existsSync(path.join(ZUODIAN, 'composer.json'))) {
    console.error(`FATAL 目标项目不存在或缺 composer.json: ${ZUODIAN}（可用 T5_ZUODIAN_ROOT 覆盖）`);
    process.exit(2);
  }
  const headSha = (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout || '').trim();

  const abs = {
    product: path.join(ZUODIAN, 'application', 'admin', 'controller', 'product', 'Product.php'),
    backend: path.join(ZUODIAN, 'application', 'common', 'controller', 'Backend.php'),
    authLib: path.join(ZUODIAN, 'application', 'admin', 'library', 'Auth.php'),
    admin: path.join(ZUODIAN, 'application', 'admin', 'model', 'Admin.php'),
    driver: path.join(ZUODIAN, 'application', 'common', 'library', 'token', 'Driver.php'),
    mysql: path.join(ZUODIAN, 'application', 'common', 'library', 'token', 'driver', 'Mysql.php'),
    redis: path.join(ZUODIAN, 'application', 'common', 'library', 'token', 'driver', 'Redis.php'),
    productModel: path.join(ZUODIAN, 'application', 'admin', 'model', 'product', 'Product.php'),
    publicIndex: path.join(ZUODIAN, 'public', 'index.php'),
    uploadExc: path.join(ZUODIAN, 'application', 'common', 'exception', 'UploadException.php'),
    ajax: path.join(ZUODIAN, 'application', 'admin', 'controller', 'Ajax.php'),
  };
  for (const [k, f] of Object.entries(abs)) {
    if (!fs.existsSync(f)) {
      console.error(`FATAL 目标文件缺失（${k}）: ${f}`);
      process.exit(2);
    }
  }

  const texts = {};
  for (const [k, f] of Object.entries(abs)) texts[k] = fs.readFileSync(f, 'utf8');

  // 零落盘哈希基线（在任何服务拉起前采样）
  const hashes = new Map();
  for (const f of [abs.product, abs.ajax, abs.uploadExc]) hashes.set(f, T.sha256File(f, fs));
  hashes.set(
    path.join(ZUODIAN, 'application', 'admin', 'controller', 'gallery', 'Material.php'),
    T.sha256File(path.join(ZUODIAN, 'application', 'admin', 'controller', 'gallery', 'Material.php'), fs)
  );

  const uriOf = (f) => 'file://' + f;
  const ctx = {
    suite,
    repo: REPO,
    cli: CLI,
    zuodian: ZUODIAN,
    rootUri: uriOf(ZUODIAN),
    abs,
    texts,
    hashes,
    uriOf,
    p: (...segs) => path.join(ZUODIAN, ...segs),
    timings: [], // {label, ms}（C5 显式采集）
    durations: {},
    productVersion: 1,
    client: null,
    openDoc(absPath, text, version = 1) {
      if (!ctx.client) throw new Error('主客户端未启动');
      ctx.client.notify('textDocument/didOpen', {
        textDocument: { uri: uriOf(absPath), languageId: 'php', version, text },
      });
    },
    openDocOn(client, absPath, text, version = 1) {
      client.notify('textDocument/didOpen', {
        textDocument: { uri: uriOf(absPath), languageId: 'php', version, text },
      });
    },
  };

  console.log('==== T5 独立协议级验证套件（intelephense 二开产物） ====');
  console.log(`仓库: ${REPO}（HEAD=${headSha || '?'}）`);
  console.log(`目标项目: ${ZUODIAN}`);
  console.log(`Node: ${process.version}；模式: ${skipBuild ? '--skip-build（复用现有 dist）' : '全量（含干净构建）'}`);

  // ---------- D1 干净构建 ----------
  const gd = suite.group('D 构建与环境');
  if (!skipBuild) {
    await groupD.cleanBuild(gd, ctx);
  } else {
    if (!fs.existsSync(CLI)) {
      console.error('FATAL --skip-build 但 dist/cli.js 不存在，请先 npm run build 或去掉 --skip-build');
      process.exit(2);
    }
    console.log('[skip] D1 干净构建（--skip-build）');
  }

  // ---------- D2 php.toml 兼容形态 ----------
  await groupD.launchForms(gd, ctx);

  // ---------- 主客户端 ----------
  console.log('\n━━ 启动主客户端（node dist/cli.js --stdio, root=zuodian）');
  const client = new LspClient({ cliPath: CLI, serverArgs: ['--stdio'], cwd: REPO, name: 't5-main' });
  ctx.client = client;
  try {
    const initResp = await client.initialize(ctx.rootUri, ZUODIAN, { waitForReadyMs: 20000 });
    const caps = (initResp.result && initResp.result.capabilities) || {};
    console.log(
      `  initialize ok：serverInfo=${JSON.stringify(initResp.result && initResp.result.serverInfo)}；foldingRangeProvider=${!!caps.foldingRangeProvider}`
    );

    // 打开真实文档（镜像 + 官方索引）
    for (const key of ['product', 'backend', 'authLib', 'admin', 'driver', 'mysql', 'redis', 'publicIndex', 'uploadExc', 'ajax']) {
      ctx.openDoc(abs[key], texts[key]);
    }

    // 就绪预热：等待 auth definition 首次命中 Backend（引擎懒扫描），不计入验收耗时
    const authUsage = T.locate(texts.product, "$this->auth->check('product/product/add')");
    const authChar = { line: authUsage.line, character: authUsage.character + '$this->'.length };
    let warmed = false;
    for (let i = 0; i < 60; i++) {
      try {
        const resp = await client.request('textDocument/definition', { textDocument: { uri: uriOf(abs.product) }, position: authChar });
        if (T.asLocations(resp.result).some((l) => typeof l.uri === 'string' && l.uri.endsWith('/application/common/controller/Backend.php'))) {
          warmed = true;
          break;
        }
      } catch {
        // 重试
      }
      await T.sleep(500);
    }
    console.log(`  预热: auth definition 命中=${warmed ? '✓' : '✗（超时 30s，继续执行用例取证）'}`);

    // ---------- 用例组 ----------
    await groupA(ctx);
    await groupB(ctx);
    await groupC.robustness(ctx);
    await groupD.passthrough(ctx);
  } finally {
    const stopInfo = await client.stop();
    console.log(
      `  主客户端收尾: shutdown=${stopInfo.shutdownOk ? '✓' : '✗'} exit=${stopInfo.exitCode} (${stopInfo.exitWithinMs}ms)`
    );
  }

  // ---------- C6 生命周期（独立客户端） ----------
  await groupC.lifecycle(ctx);

  // ---------- Z 残留自检 ----------
  const gz = suite.group('Z 残留自检');
  await gz.it('zuodian 零残留（无 t5test/T5 落盘文件；rename 未应用）', async () => {
    const r = spawnSync(
      'bash',
      [
        '-c',
        `find '${ZUODIAN}' -path '*/vendor' -prune -o -path '*/node_modules' -prune -o -path '*/runtime' -prune -o -type f \\( -name '*T5*' -o -path '*t5test*' \\) -print`,
      ],
      { encoding: 'utf8', timeout: 60000 }
    );
    const out = (r.stdout || '').trim();
    if (out) throw new Error(`残留文件：${out.split('\n').slice(0, 10).join('；')}`);
    // 哈希终检
    for (const [f, before] of hashes) {
      const now = T.sha256File(f, fs);
      if (before !== now) throw new Error(`哈希漂移：${f}`);
    }
    return `find 无 t5test/T5 落盘文件；${hashes.size} 个基线文件哈希不变（全部合成文档仅内存 didOpen）`;
  });

  // ---------- 汇总 ----------
  const exitCode = suite.printSummary();

  // 耗时表
  console.log('\n==== 耗时记录 ====');
  if (ctx.durations.cleanBuildMs) console.log(`  干净构建（rm -rf dist + npm ci + npm run build）: ${(ctx.durations.cleanBuildMs / 1000).toFixed(1)}s`);
  const allTimings = [...client.timings, ...ctx.timings];
  for (const t of allTimings) console.log(`  ${t.label}: ${t.ms}ms`);
  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`  套件总耗时: ${totalSec}s`);

  // 报告 JSON（供最终报告引用；不入库）
  try {
    const report = {
      meta: { repo: REPO, head: headSha, zuodian: ZUODIAN, node: process.version, startedAt: new Date(startedAt).toISOString(), totalMs: Date.now() - startedAt },
      totals: suite.totals(),
      groups: suite.groups.map((g) => ({ name: g.name, cases: g.cases })),
      timings: allTimings,
      durations: ctx.durations,
    };
    fs.writeFileSync('/tmp/t5-report.json', JSON.stringify(report, null, 2));
    console.log('报告 JSON: /tmp/t5-report.json');
  } catch {
    // 报告写失败不影响结论
  }

  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error('T5 FATAL:', err);
  process.exit(2);
});
