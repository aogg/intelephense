'use strict';
/**
 * test/groups/d-env.js — D 组：构建与环境。
 *
 * D1  干净构建：rm -rf dist && npm ci && npm run build（lockfile 完整性）
 * D2  php.toml 兼容形态：node dist/cli.js --stdio 与无参数两种方式 initialize
 * D3  官方免费透传不退化：references / documentSymbol / workspaceSymbol / formatting 各 1 例
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { LspClient } = require('../helpers/lsp');
const T = require('../helpers/text');

module.exports.cleanBuild = async function cleanBuild(g, ctx) {
  await g.it('D1.干净构建 rm -rf dist && npm ci && npm run build（验证 lockfile 完整性）', async () => {
    const t0 = Date.now();
    const r = spawnSync('bash', ['-c', 'rm -rf dist && npm ci && npm run build'], {
      cwd: ctx.repo,
      encoding: 'utf8',
      timeout: 900000,
    });
    const ms = Date.now() - t0;
    ctx.durations.cleanBuildMs = ms;
    if (r.error) throw new Error(`构建进程失败：${r.error.message}`);
    if (r.status !== 0) {
      throw new Error(
        `exit=${r.status}；stderr tail=${(r.stderr || '').slice(-500).replace(/\n/g, ' ')}；stdout tail=${(r.stdout || '')
          .slice(-300)
          .replace(/\n/g, ' ')}`
      );
    }
    if (!fs.existsSync(path.join(ctx.repo, 'dist', 'cli.js'))) throw new Error('构建后 dist/cli.js 不存在');
    if (!fs.existsSync(path.join(ctx.repo, 'dist', 'engine', 'engine.js'))) throw new Error('构建后 dist/engine/engine.js 不存在');
    return `exit=0，耗时 ${(ms / 1000).toFixed(1)}s；npm ci（lockfile 完整）+ tsc 双 tsconfig 通过；dist/cli.js、dist/engine/ 已生成`;
  });
};

module.exports.launchForms = async function launchForms(g, ctx) {
  const forms = [
    { args: ['--stdio'], label: 'node dist/cli.js --stdio（php.toml args 透传形态）', name: 't5-form-stdio' },
    { args: [], label: 'node dist/cli.js（无参数默认 stdio 形态）', name: 't5-form-noarg' },
  ];
  for (const f of forms) {
    await g.it(`D2.initialize ${f.label}`, async () => {
      const c = new LspClient({ cliPath: ctx.cli, serverArgs: f.args, cwd: ctx.repo, name: f.name });
      try {
        const resp = await c.initialize(ctx.rootUri, ctx.zuodian, { waitForReadyMs: 15000 });
        const result = resp.result || {};
        const caps = result.capabilities || {};
        const si = result.serverInfo;
        if (!si || si.name !== 'intelephense-openidea') throw new Error(`serverInfo 异常：${T.summary(si)}`);
        const checks = {
          '官方透传 definitionProvider': !!caps.definitionProvider,
          '官方透传 documentSymbolProvider': !!caps.documentSymbolProvider,
          '官方透传 documentFormattingProvider': !!caps.documentFormattingProvider,
          '自研 renameProvider.prepareProvider': !!(caps.renameProvider && caps.renameProvider.prepareProvider),
          '自研 typeHierarchyProvider': !!caps.typeHierarchyProvider,
          '自研 codeLensProvider.resolveProvider': !!(caps.codeLensProvider && caps.codeLensProvider.resolveProvider),
          '自研 inlayHintProvider.resolveProvider': !!(caps.inlayHintProvider && caps.inlayHintProvider.resolveProvider),
          '自研 foldingRangeProvider': !!caps.foldingRangeProvider,
        };
        const missing = Object.entries(checks)
          .filter(([, v]) => !v)
          .map(([k]) => k);
        if (missing.length) throw new Error(`能力缺失：${missing.join('、')}`);
        if (f.args.length === 0 && /未识别参数/.test(c.stderrTail || '')) {
          throw new Error(`无参数形态出现参数告警：${c.stderrTail.slice(0, 120)}`);
        }
        return `serverInfo=${si.name} ${si.version}；8 项关键能力（官方透传 3 + 自研注册 5）全部就绪；serverName 随形态不变`;
      } finally {
        await c.stop();
      }
    });
  }
};

module.exports.passthrough = async function passthrough(ctx) {
  const { client, suite, texts, abs, uriOf } = ctx;
  const g = suite.group('D3 官方免费透传不退化');

  await g.it('D3a.references(Auth::check 声明处) → 官方透传返回 ≥1 处引用', async () => {
    const checkDecl = T.locate(texts.authLib, 'public function check(');
    const pos = { line: checkDecl.line, character: checkDecl.character + 'public function '.length + 2 };
    const resp = await client.request(
      'textDocument/references',
      { textDocument: { uri: uriOf(abs.authLib) }, position: pos, context: { includeDeclaration: false } },
      { timeoutMs: 45000 }
    );
    if (resp.error) throw new Error(`references error：${T.summary(resp.error)}`);
    const locs = T.asLocations(resp.result);
    if (locs.length < 1) throw new Error(`无引用结果：${T.summary(resp.result)}`);
    const inProduct = locs.some((l) => typeof l.uri === 'string' && l.uri.endsWith('product/Product.php'));
    return `${locs.length} 处引用${inProduct ? '（含 Product.php 调用点）' : ''}；首条=${locs[0].uri.split('/').pop()}@${locs[0].range.start.line}`;
  });

  await g.it('D3b.documentSymbol(Product.php) → 官方透传含 Product 类与 _initialize 方法', async () => {
    const resp = await client.request(
      'textDocument/documentSymbol',
      { textDocument: { uri: uriOf(abs.product) } },
      { timeoutMs: 45000 }
    );
    if (resp.error) throw new Error(`documentSymbol error：${T.summary(resp.error)}`);
    const syms = Array.isArray(resp.result) ? resp.result : (resp.result && resp.result.symbols) || [];
    if (syms.length === 0) throw new Error(`符号为空：${T.summary(resp.result)}`);
    const names = new Set(syms.map((s) => s && s.name).filter(Boolean));
    for (const s of syms) {
      for (const c of (s && s.children) || []) names.add(c && c.name);
    }
    if (!names.has('Product')) throw new Error(`无 Product 类符号：${T.summary([...names].slice(0, 20))}`);
    if (!names.has('_initialize')) throw new Error(`无 _initialize 方法符号`);
    return `符号数=${syms.length}（顶层）；含 Product 类与 _initialize 方法（官方符号通道存活）`;
  });

  await g.it('D3c.workspace/symbol("Backend") → 官方透传返回 ≥1 条结果', async () => {
    const resp = await client.request('workspace/symbol', { query: 'Backend' }, { timeoutMs: 45000 });
    if (resp.error) throw new Error(`workspaceSymbol error：${T.summary(resp.error)}`);
    const syms = Array.isArray(resp.result) ? resp.result : [];
    if (syms.length === 0) throw new Error(`无结果：${T.summary(resp.result)}`);
    const hit = syms.find((s) => typeof s.name === 'string' && s.name.includes('Backend'));
    if (!hit) throw new Error(`无 Backend 命名符号：${T.summary(syms.slice(0, 6).map((s) => s && s.name))}`);
    return `${syms.length} 条结果；含 "${hit.name}"（${(hit.location && hit.location.uri || '').split('/').pop()}）`;
  });

  await g.it('D3d.formatting(Product.php) → 官方透传返回合法编辑数组', async () => {
    const resp = await client.request(
      'textDocument/formatting',
      {
        textDocument: { uri: uriOf(abs.product) },
        options: { tabSize: 4, insertSpaces: false },
      },
      { timeoutMs: 45000 }
    );
    if (resp.error) throw new Error(`formatting error：${T.summary(resp.error)}`);
    const edits = Array.isArray(resp.result) ? resp.result : null;
    if (!edits) throw new Error(`结果非数组：${T.summary(resp.result)}`);
    let appliedInfo = '0 条编辑（已符合目标格式）';
    if (edits.length > 0) {
      const applied = T.applyTextEdits(texts.product, edits);
      if (typeof applied !== 'string' || applied.length === 0) throw new Error('应用编辑后文本为空');
      appliedInfo = `${edits.length} 条编辑，内存应用后 ${applied.length} 字符（原 ${texts.product.length}）`;
    }
    return `formatting 返回 ${edits.length} 条编辑；${appliedInfo}（官方格式化通道存活，未落盘）`;
  });
};
