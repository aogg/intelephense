'use strict';
/**
 * test/groups/c-robustness.js — C 组：健壮性。
 *
 * C1  语法错误 PHP 文档：definition/completion 不崩、不阻断后续请求
 * C2  增量 didChange（行插入 / 删除还原后 auth 解析仍正确）
 * C3  didClose：协议健全 + 内存/索引保留观察（记录型）
 * C4  workspace/didChangeConfiguration（intelephense.environment.phpVersion）转发不炸
 * C5  大文件（Product.php 1724 行）definition/hover/completion 耗时记录
 * C6  initialize → shutdown → exit 生命周期干净退出 + 无悬挂子进程（独立客户端）
 */

const { spawnSync } = require('node:child_process');
const T = require('../helpers/text');

const ORPHAN_PS = "ps -eo pid=,args= | grep -E 'intelephense/lib/intelephense\\.js|my/intelephense/dist/cli\\.js' | grep -v grep || true";

function orphanLines() {
  const r = spawnSync('bash', ['-c', ORPHAN_PS], { encoding: 'utf8', timeout: 10000 });
  return (r.stdout || '').split('\n').filter((s) => s.trim());
}

function rssOf(pid) {
  const r = spawnSync('bash', ['-c', `ps -o rss= -p ${pid} 2>/dev/null || echo 0`], { encoding: 'utf8', timeout: 10000 });
  return parseInt((r.stdout || '0').trim(), 10) || 0;
}

module.exports.robustness = async function robustness(ctx) {
  const { client, suite, texts, abs, uriOf } = ctx;
  const g = suite.group('C 健壮性');

  const productUri = uriOf(abs.product);
  const productText = texts.product;
  const authUsage = T.locate(productText, "$this->auth->check('product/product/add')");
  const authChar = { line: authUsage.line, character: authUsage.character + '$this->'.length };
  const backendHit = (result) =>
    T.asLocations(result).find((l) => typeof l.uri === 'string' && l.uri.endsWith('/application/common/controller/Backend.php'));

  // ---------- C1 语法错误文档 ----------
  const brokenAbs = ctx.p('t5test', 'broken.php');
  const brokenUri = uriOf(brokenAbs);
  const brokenText = `<?php
namespace T5\\broken;

class T5Broken
{
    public function __construct()
    {
        $this->handle = new MissingThing(;
    }

    public function go()
    {
        return $this->handle->callMe();
    }
`;
  ctx.openDoc(brokenAbs, brokenText);
  const brokenMember = T.locate(brokenText, '$this->handle->callMe');
  const brokenPos = { line: brokenMember.line, character: brokenMember.character + '$this->'.length };

  await g.it('C1.语法错误文档：definition/completion 均应答（无 error、不挂死）', async () => {
    const def = await client.request(
      'textDocument/definition',
      { textDocument: { uri: brokenUri }, position: brokenPos },
      { timeoutMs: 30000 }
    );
    const comp = await client.request(
      'textDocument/completion',
      { textDocument: { uri: brokenUri }, position: brokenPos },
      { timeoutMs: 30000 }
    );
    if (def.error) throw new Error(`definition 返回 error：${T.summary(def.error)}`);
    if (comp.error) throw new Error(`completion 返回 error：${T.summary(comp.error)}`);
    return `definition result=${T.summary(def.result)}；completion items=${T.asItems(comp.result).length}（容错解析不崩）`;
  });

  await g.it('C1b.语法错误文档不阻断后续健康请求（auth definition 仍命中 Backend）', async () => {
    const resp = await client.request('textDocument/definition', { textDocument: { uri: productUri }, position: authChar });
    const hit = backendHit(resp.result);
    if (!hit) throw new Error(`健康请求被阻断：${T.summary(resp.result)}`);
    return `Backend.php 0基 ${hit.range.start.line} 命中（服务存活）`;
  });

  // ---------- C2 增量 didChange ----------
  await g.it('C2a.增量 didChange（行插入）后 auth 解析仍正确（53→54）', async () => {
    ctx.productVersion += 1;
    client.notify('textDocument/didChange', {
      textDocument: { uri: productUri, version: ctx.productVersion },
      contentChanges: [
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: '// T5-INJECT\n' },
      ],
    });
    const pos = { line: authUsage.line + 1, character: authChar.character };
    const resp = await client.request(
      'textDocument/definition',
      { textDocument: { uri: productUri }, position: pos },
      { timeoutMs: 30000 }
    );
    const hit = backendHit(resp.result);
    if (!hit) throw new Error(`插入后 definition 失效：${T.summary(resp.result)}`);
    if (hit.range.start.line !== 44) throw new Error(`插入后命中行漂移：${hit.range.start.line}（期望 44）`);
    return `插入注释行后 $this->auth @0基54 → Backend.php 0基${hit.range.start.line}（增量镜像同步正确，version=${ctx.productVersion}）`;
  });

  await g.it('C2b.增量 didChange（删除还原）后 auth 解析复位（54→53）', async () => {
    ctx.productVersion += 1;
    client.notify('textDocument/didChange', {
      textDocument: { uri: productUri, version: ctx.productVersion },
      contentChanges: [
        { range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, text: '' },
      ],
    });
    const resp = await client.request(
      'textDocument/definition',
      { textDocument: { uri: productUri }, position: authChar },
      { timeoutMs: 30000 }
    );
    const hit = backendHit(resp.result);
    if (!hit) throw new Error(`删除还原后 definition 失效：${T.summary(resp.result)}`);
    if (hit.range.start.line !== 44) throw new Error(`还原后命中行漂移：${hit.range.start.line}`);
    return `还原后 $this->auth @0基53 → Backend.php 0基${hit.range.start.line}（删除补丁同样生效）`;
  });

  // ---------- C3 didClose ----------
  const ephDefAbs = ctx.p('t5test', 'ephemeral-def.php');
  const ephUseAbs = ctx.p('t5test', 'ephemeral-use.php');
  const ephDefText = `<?php
namespace T5\\eph;

class T5Ephemeral
{
    public function onlyHere(): string
    {
        return 'only-in-memory';
    }
}
`;
  const ephUseText = `<?php
namespace T5\\ephuse;

use T5\\eph\\T5Ephemeral;

class T5EphemeralUser
{
    public function run()
    {
        /** @var \\T5\\eph\\T5Ephemeral $e */
        $e = T5Ephemeral::probe();
        return $e->onlyHere();
    }
}
`;
  const ephMember = T.locate(ephUseText, '$e->onlyHere()');
  const ephPos = { line: ephMember.line, character: ephMember.character + '$e->'.length };
  const ephUseUri = uriOf(ephUseAbs);
  const ephDefUri = uriOf(ephDefAbs);

  await g.it('C3a.didClose 前基线：跨文件解析 ephemeral 成员命中定义文档', async () => {
    ctx.openDoc(ephDefAbs, ephDefText);
    ctx.openDoc(ephUseAbs, ephUseText);
    const resp = await client.request('textDocument/definition', { textDocument: { uri: ephUseUri }, position: ephPos });
    const hit = T.asLocations(resp.result).find((l) => typeof l.uri === 'string' && l.uri.endsWith('ephemeral-def.php'));
    if (!hit) throw new Error(`关闭前无法解析：${T.summary(resp.result)}`);
    return `T5Ephemeral::onlyHere → ephemeral-def.php @0基 ${hit.range.start.line}`;
  });

  await g.it('C3b.didClose 后：请求不崩、响应有意义（内存/索引保留为设计行为，记录观察）', async () => {
    const rssBefore = rssOf(client.pid);
    client.notify('textDocument/didClose', { textDocument: { uri: ephDefUri } });
    await T.sleep(400);
    const resp = await client.request(
      'textDocument/definition',
      { textDocument: { uri: ephUseUri }, position: ephPos },
      { timeoutMs: 30000 }
    );
    if (resp.error) throw new Error(`didClose 后请求 error：${T.summary(resp.error)}`);
    const still = T.asLocations(resp.result).some((l) => typeof l.uri === 'string' && l.uri.endsWith('ephemeral-def.php'));
    const rssAfter = rssOf(client.pid);
    return `无 error；定义解析仍命中已关文档=${still}（engine.ts closeDocument 明示「文本缓存保留供索引」属设计行为，非崩溃）；中间件 RSS ${rssBefore}→${rssAfter}KB`;
  });

  // ---------- C4 didChangeConfiguration ----------
  await g.it('C4.workspace/didChangeConfiguration（intelephense.environment.phpVersion）转发不炸、自研通道存活', async () => {
    client.notify('workspace/didChangeConfiguration', {
      settings: { intelephense: { environment: { phpVersion: '8.1', phpVersionOverride: null } } },
    });
    // 自研通道：auth definition 仍命中
    const def = await client.request(
      'textDocument/definition',
      { textDocument: { uri: productUri }, position: authChar },
      { timeoutMs: 30000 }
    );
    if (def.error) throw new Error(`配置下发后 definition error：${T.summary(def.error)}`);
    const hit = backendHit(def.result);
    if (!hit) throw new Error(`配置下发后自研通道失效：${T.summary(def.result)}`);
    // 官方通道状态记录（结果形态问题归 D3a 取证，此处只验证「不炸」）
    const refs = await client.request(
      'textDocument/references',
      { textDocument: { uri: productUri }, position: authChar, context: { includeDeclaration: false } },
      { timeoutMs: 45000 }
    );
    const officialShape = Array.isArray(refs.result) ? 'array' : 'object（形态异常，见 D3a 取证）';
    return `settings.intelephense.environment.phpVersion=8.1 下发未崩；自研 definition→Backend.php @0基${hit.range.start.line}；官方 references 应答存活但形态=${officialShape}；无 error=${!refs.error}`;
  });

  // ---------- C5 大文件耗时 ----------
  const timedCase = async (name, label, fn) => {
    await g.it(name, async () => {
      const resp = await fn();
      const ms = client.lastTiming(label);
      if (ms === null) throw new Error('未采集到耗时');
      ctx.timings.push({ label, ms });
      if (ms > 30000) throw new Error(`耗时超 30s：${ms}ms`);
      return `${ms}ms；${resp._t5Evidence || ''}`;
    });
  };

  await timedCase(
    'C5a.大文件（1724 行）definition 耗时与正确性',
    'C5 definition(Product 1724行)',
    () =>
      client.request(
        'textDocument/definition',
        { textDocument: { uri: productUri }, position: authChar },
        { timeLabel: 'C5 definition(Product 1724行)', timeoutMs: 30000 }
      ).then((resp) => {
        const hit = backendHit(resp.result);
        if (!hit) throw new Error(`结果异常：${T.summary(resp.result)}`);
        resp._t5Evidence = `Backend.php @0基 ${hit.range.start.line}`;
        return resp;
      })
  );

  await timedCase(
    'C5b.大文件（1724 行）hover 耗时与正确性',
    'C5 hover(Product 1724行)',
    () =>
      client.request(
        'textDocument/hover',
        { textDocument: { uri: productUri }, position: authChar },
        { timeLabel: 'C5 hover(Product 1724行)', timeoutMs: 30000 }
      ).then((resp) => {
        const value = T.hoverText(resp.result);
        if (!value.includes('Auth')) throw new Error(`hover 异常：${T.summary(resp.result)}`);
        resp._t5Evidence = `markdown 含 Auth（${value.length} 字符）`;
        return resp;
      })
  );

  await timedCase(
    'C5c.大文件（1724 行）completion 耗时与正确性',
    'C5 completion(Product 1724行)',
    () => {
      const compPos = T.locate(productText, '$this->model->getStatusList()');
      const pos = { line: compPos.line, character: compPos.character + '$this->'.length };
      return client
        .request(
          'textDocument/completion',
          { textDocument: { uri: productUri }, position: pos },
          { timeLabel: 'C5 completion(Product 1724行)', timeoutMs: 30000 }
        )
        .then((resp) => {
          const items = T.asItems(resp.result);
          if (!items.some((i) => i && i.label === 'auth')) throw new Error(`completion 异常：无 auth；项数=${items.length}`);
          resp._t5Evidence = `items=${items.length}（含 auth）`;
          return resp;
        });
    }
  );
};

/** C6 生命周期：独立客户端 initialize → shutdown → exit + 孤儿进程检查 */
module.exports.lifecycle = async function lifecycle(ctx) {
  const { LspClient } = require('../helpers/lsp');
  const g = suiteGroup(ctx, 'C6 生命周期');
  const baseline = orphanLines();
  const c = new LspClient({ cliPath: ctx.cli, serverArgs: ['--stdio'], cwd: ctx.repo, name: 't5-lifecycle' });
  let stopInfo = null;
  let openErr = null;

  await g.it('C6a.initialize→shutdown→exit 干净退出（shutdown 应答 + 5s 内退出 + code 0）', async () => {
    try {
      await c.initialize(ctx.rootUri, ctx.zuodian, { waitForReadyMs: 6000 });
      ctx.openDocOn(c, ctx.abs.product, ctx.texts.product);
      // 一次真实请求确认服务就绪后再走生命周期
      await c.request(
        'textDocument/documentSymbol',
        { textDocument: { uri: 'file://' + ctx.abs.product } },
        { timeoutMs: 45000 }
      );
    } catch (err) {
      openErr = err;
    }
    stopInfo = await c.stop();
    if (openErr) throw new Error(`生命周期前置失败：${openErr.message}`);
    if (!stopInfo.shutdownOk) throw new Error(`shutdown 未正常应答：${T.summary(stopInfo)}`);
    if (stopInfo.exitWithinMs === null) throw new Error('进程 5s 内未退出（SIGKILL 兜底）');
    if (stopInfo.exitCode !== 0) throw new Error(`exit code=${stopInfo.exitCode} signal=${stopInfo.signal}`);
    return `shutdown 应答 ✓；进程 ${stopInfo.exitWithinMs}ms 内退出；exit code=0（stderr tail=${(c.stderrTail || '').slice(-120).replace(/\n/g, ' ')})`;
  });

  await g.it('C6b.无悬挂子进程（中间件与官方 intelephense 均退出）', async () => {
    const after = orphanLines();
    if (after.length !== baseline.length) {
      throw new Error(`进程数变化：基线=${baseline.length} 结束后=${after.length}；当前=${after.join(' | ').slice(0, 300)}`);
    }
    return `基线 ${baseline.length} 个相关进程（其他会话），结束后仍 ${after.length} 个；本客户端的中间件+官方子进程全部退出`;
  });
};

function suiteGroup(ctx, name) {
  return ctx.suite.group(name);
}
