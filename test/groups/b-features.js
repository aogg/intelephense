'use strict';
/**
 * test/groups/b-features.js — B 组：全功能扫描（真实文件优先，合成文档补齐每类 ≥1 例）。
 *
 * foldingRange / selectionRange / documentLink（真实 public/index.php require）/
 * typeDefinition（$this->model → ProductModel）/ declaration（Redis::set → Driver 抽象声明 +
 * 合成接口对）/ implementation（真实 Driver 抽象类多子类 + 合成接口多实现）/
 * rename（真实低耦合小类 UploadException，WorkspaceEdit 断言 + 内存 apply 不落盘 + 零残留哈希）/
 * codeAction（自动 import / 实现抽象方法 / 生成 PHPDoc）/ codeLens（Product.php 类行 lens +
 * Backend 子类计数）/ inlayHint（真实参数名 + 合成返回类型）/ @mixin（合成文档成员合并）
 */

const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const T = require('../helpers/text');

module.exports = async function groupB(ctx) {
  const { client, suite, texts, abs, uriOf } = ctx;
  const g = suite.group('B 全功能扫描');

  const productUri = uriOf(abs.product);
  const productText = texts.product;

  // ---------- foldingRange ----------
  await g.it('B1a.foldingRange(Product.php) 非空且区间合法（start<end、界内）', async () => {
    const resp = await client.request('textDocument/foldingRange', { textDocument: { uri: productUri } });
    const folds = Array.isArray(resp.result) ? resp.result : [];
    if (folds.length === 0) throw new Error(`区域数=0：${T.summary(resp)}`);
    const totalLines = productText.split('\n').length;
    for (const f of folds) {
      if (!(f.startLine < f.endLine)) throw new Error(`非法区域 start>=end：${T.summary(f)}`);
      if (f.startLine < 0 || f.endLine >= totalLines) throw new Error(`越界区域：${T.summary(f)}`);
    }
    return `区域数=${folds.length}；样例=${T.summary(folds.slice(0, 3))}`;
  });

  await g.it('B1b.区域类型覆盖：方法体 / 注释块（kind=comment）/ use 导入块（kind=imports）', async () => {
    const resp = await client.request('textDocument/foldingRange', { textDocument: { uri: productUri } });
    const folds = Array.isArray(resp.result) ? resp.result : [];
    const initLoc = T.locate(productText, 'public function _initialize');
    const methodFold = folds.find((f) => f.startLine <= initLoc.line && f.endLine >= initLoc.line + 3);
    const commentFold = folds.find((f) => f.kind === 'comment');
    const firstUse = T.locate(productText, 'use app\\admin\\model\\product\\Category as CategoryModel;');
    const importsFold = folds.find((f) => f.kind === 'imports' && f.startLine <= firstUse.line && f.endLine >= firstUse.line);
    const misses = [];
    if (!methodFold) misses.push('方法体区域');
    if (!commentFold) misses.push('注释区域');
    if (!importsFold) misses.push('imports 区域');
    if (misses.length) throw new Error(`缺区域：${misses.join('、')}；kinds=${T.summary(folds.map((f) => f.kind))}`);
    return `_initialize@0基${initLoc.line} 被区域[${methodFold.startLine}-${methodFold.endLine}]覆盖；comment 区=${T.summary(commentFold)}；imports 区=[${importsFold.startLine}-${importsFold.endLine}]含首个 use 行 ${firstUse.line}`;
  });

  // ---------- selectionRange ----------
  await g.it('B2.selectionRange($this->auth 位置) 层级链 >1 且逐层严格嵌套、内层含光标', async () => {
    const authUsage = T.locate(productText, "$this->auth->check('product/product/add')");
    const pos = { line: authUsage.line, character: authUsage.character + '$this->'.length };
    const resp = await client.request('textDocument/selectionRange', {
      textDocument: { uri: productUri },
      positions: [pos],
    });
    const first = Array.isArray(resp.result) ? resp.result[0] : null;
    if (!first) throw new Error(`无结果：${T.summary(resp.result)}`);
    const chain = [];
    for (let cur = first; cur; cur = cur.parent) chain.push(cur.range);
    if (chain.length <= 1) throw new Error(`链长=${chain.length}（要求 >1）`);
    const starts = T.lineStarts(productText);
    const at = (p) => starts[p.line] + p.character;
    const off = at(pos);
    const inner = chain[0];
    if (!(at(inner.start) <= off && off <= at(inner.end))) throw new Error(`内层区间不含光标：${T.summary(inner)}`);
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const contains = at(b.start) <= at(a.start) && at(a.end) <= at(b.end);
      const bigger = at(b.end) - at(b.start) > at(a.end) - at(a.start);
      if (!contains || !bigger) {
        throw new Error(`第 ${i} 层嵌套破坏：child=${T.summary(a)} parent=${T.summary(b)}`);
      }
    }
    return `链长=${chain.length}；内层 3 层=${T.summary(chain.slice(0, 3))}；嵌套校验通过`;
  });

  // ---------- documentLink（真实文件） ----------
  await g.it('B3.documentLink(真实 public/index.php require __DIR__) → file:// URI 且目标文件存在', async () => {
    const uri = uriOf(abs.publicIndex);
    const resp = await client.request('textDocument/documentLink', { textDocument: { uri } });
    const links = Array.isArray(resp.result) ? resp.result : [];
    const hit = links.find((l) => typeof l.target === 'string' && l.target.endsWith('/thinkphp/start.php'));
    if (!hit) throw new Error(`未解析出 start.php 链接：links=${T.summary(links)}`);
    const targetPath = fileURLToPath(hit.target);
    if (!fs.existsSync(targetPath)) throw new Error(`目标不存在：${targetPath}`);
    const onLine = T.locate(texts.publicIndex, "require __DIR__ . '/../thinkphp/start.php';").line;
    return `target=${hit.target}（存在✓）；range 0基 line=${hit.range.start.line}（require 语句行 ${onLine}）；links 总数=${links.length}`;
  });

  // ---------- typeDefinition ----------
  await g.it('B4.typeDefinition($this->model 引用处) → ProductModel 类声明（model/product/Product.php，类名 Product 别名导入）', async () => {
    const use = T.locate(productText, '$this->model->getStatusList()');
    const pos = { line: use.line, character: use.character + '$this->'.length };
    const resp = await client.request('textDocument/typeDefinition', { textDocument: { uri: productUri }, position: pos });
    const locs = T.asLocations(resp.result);
    const declLine = texts.productModel.split('\n').findIndex((l) => /^class\s+Product\b/.test(l));
    if (declLine < 0) throw new Error('model/product/Product.php 内未找到 class Product 声明行（fixture 前提破坏）');
    const hit = locs.find(
      (l) =>
        typeof l.uri === 'string' &&
        l.uri.endsWith('/application/admin/model/product/Product.php') &&
        l.range.start.line === declLine
    );
    if (!hit) throw new Error(`无 ProductModel 声明命中：${T.summary(resp.result)}（期望行 ${declLine}）`);
    return `model/product/Product.php class Product（use …as ProductModel 别名）@0基 ${hit.range.start.line}（1基 ${declLine + 1}）；结果数=${locs.length}`;
  });

  // ---------- declaration（真实：实现 → 抽象声明） ----------
  await g.it('B5.declaration(Redis::set 实现) → Driver.php 抽象方法声明（真实继承对）', async () => {
    const redisUri = uriOf(abs.redis);
    const redisText = texts.redis;
    const driverText = texts.driver;
    const impl = T.locate(redisText, 'public function set');
    const implLineText = redisText.split('\n')[impl.line];
    const pos = { line: impl.line, character: impl.character + 'public function '.length + 2 };
    const resp = await client.request('textDocument/declaration', { textDocument: { uri: redisUri }, position: pos });
    const locs = T.asLocations(resp.result);
    const declLoc = T.locate(driverText, 'function set');
    const declLineText = driverText.split('\n')[declLoc.line];
    const hit = locs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('/token/Driver.php') && l.range.start.line === declLoc.line);
    if (!hit) throw new Error(`无 Driver.php 声明命中：${T.summary(resp.result)}（期望 0基 ${declLoc.line}）`);
    if (!declLineText.includes('abstract')) throw new Error(`声明行非抽象：${JSON.stringify(declLineText)}`);
    return `${implLineText.trim().slice(0, 40)} → Driver.php 0基 ${hit.range.start.line}（${declLineText.trim().slice(0, 60)}）`;
  });

  // ---------- declaration + implementation（合成接口多实现对） ----------
  const ifaceAbs = ctx.p('t5test', 'gateway-iface.php');
  const httpAbs = ctx.p('t5test', 'gateway-http.php');
  const queueAbs = ctx.p('t5test', 'gateway-queue.php');
  const ifaceText = `<?php
namespace T5\\gw;

interface T5Gateway
{
    public function send(string $payload): bool;

    public static function name(): string;
}
`;
  const httpText = `<?php
namespace T5\\gw;

class T5HttpGateway implements T5Gateway
{
    public function send(string $payload): bool
    {
        return strlen($payload) > 0;
    }

    public static function name(): string
    {
        return 'http';
    }
}
`;
  const queueText = `<?php
namespace T5\\gw;

class T5QueueGateway implements T5Gateway
{
    public function send(string $payload): bool
    {
        return $payload !== '';
    }

    public static function name(): string
    {
        return 'queue';
    }
}
`;
  const ifaceUri = uriOf(ifaceAbs);
  ctx.openDoc(ifaceAbs, ifaceText);
  ctx.openDoc(httpAbs, httpText);
  ctx.openDoc(queueAbs, queueText);
  const ifaceSendLine = T.locate(ifaceText, 'public function send(string $payload): bool;').line;
  const ifaceNameLine = T.locate(ifaceText, 'interface T5Gateway').line;

  await g.it('B5b.declaration(T5HttpGateway::send 实现) → 合成接口方法声明行', async () => {
    const impl = T.locate(httpText, 'public function send(string $payload): bool');
    const pos = { line: impl.line, character: impl.character + 'public function '.length + 2 };
    const resp = await client.request('textDocument/declaration', { textDocument: { uri: uriOf(httpAbs) }, position: pos });
    const locs = T.asLocations(resp.result);
    const hit = locs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('gateway-iface.php') && l.range.start.line === ifaceSendLine);
    if (!hit) throw new Error(`无接口声明命中：${T.summary(resp.result)}（期望 0基 ${ifaceSendLine}）`);
    const rangeText = T.textInRange(ifaceText, hit.range);
    if (!rangeText.includes('send')) throw new Error(`range 文本异常：${JSON.stringify(rangeText)}`);
    return `gateway-iface.php 接口方法声明 @0基 ${hit.range.start.line}（range 文本="${rangeText}"，落在方法名 token）`;
  });

  await g.it('B6a.implementation(真实 Driver 抽象类) → Mysql + Redis 两实现类（跨文件）', async () => {
    const driverUri = uriOf(abs.driver);
    const cls = T.locate(texts.driver, 'abstract class Driver');
    const pos = { line: cls.line, character: cls.character + 'abstract class '.length + 2 };
    const resp = await client.request('textDocument/implementation', { textDocument: { uri: driverUri }, position: pos });
    const locs = T.asLocations(resp.result);
    const mysql = locs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('/token/driver/Mysql.php'));
    const redis = locs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('/token/driver/Redis.php'));
    if (!mysql || !redis) throw new Error(`子类不全：${T.summary(resp.result)}`);
    return `结果数=${locs.length}：Mysql.php @0基 ${mysql.range.start.line}；Redis.php @0基 ${redis.range.start.line}`;
  });

  await g.it('B6b.implementation(合成接口 T5Gateway 类名) → 两个实现类；方法名 → 两处方法实现', async () => {
    const clsPos = { line: ifaceNameLine, character: T.locate(ifaceText, 'interface T5Gateway').character + 'interface '.length + 2 };
    const respCls = await client.request('textDocument/implementation', { textDocument: { uri: ifaceUri }, position: clsPos });
    const clsLocs = T.asLocations(respCls.result);
    const httpCls = clsLocs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('gateway-http.php'));
    const queueCls = clsLocs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('gateway-queue.php'));
    if (!httpCls || !queueCls) throw new Error(`类实现不全：${T.summary(respCls.result)}`);

    const mPos = { line: ifaceSendLine, character: T.locate(ifaceText, 'public function send').character + 'public function '.length + 2 };
    const respM = await client.request('textDocument/implementation', { textDocument: { uri: ifaceUri }, position: mPos });
    const mLocs = T.asLocations(respM.result);
    const httpM = mLocs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('gateway-http.php'));
    const queueM = mLocs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('gateway-queue.php'));
    if (!httpM || !queueM) throw new Error(`方法实现不全：${T.summary(respM.result)}`);
    return `类级 2 实现（http@${httpCls.range.start.line} queue@${queueCls.range.start.line}）；方法级 2 实现（http@${httpM.range.start.line} queue@${queueM.range.start.line}）`;
  });

  // ---------- rename（真实低耦合小类：UploadException） ----------
  const OLD = 'UploadException';
  const NEW = 'T5UploadExceptionRenamed';
  const excUri = uriOf(abs.uploadExc);
  const ajaxUri = uriOf(abs.ajax);
  const materialAbs = ctx.p('application', 'admin', 'controller', 'gallery', 'Material.php');
  const materialText = fs.readFileSync(materialAbs, 'utf8');
  const excText = texts.uploadExc;
  const excClassLoc = T.locate(excText, `class ${OLD}`);

  await g.it('B7a.prepareRename(UploadException 声明) → placeholder + range（真实小类可安全改名）', async () => {
    const pos = { line: excClassLoc.line, character: excClassLoc.character + 'class '.length + 2 };
    const resp = await client.request('textDocument/prepareRename', { textDocument: { uri: excUri }, position: pos });
    const r = resp.result;
    if (!r || r.placeholder !== OLD || !r.range) {
      throw new Error(`结果异常：${T.summary(resp.result)}`);
    }
    const rangeText = T.textInRange(excText, r.range);
    if (!rangeText.includes(OLD)) throw new Error(`range 文本不含原名：${JSON.stringify(rangeText)}`);
    return `placeholder=${r.placeholder}；range 文本="${rangeText}"（引用面：全仓 7 文件，均不落盘）`;
  });

  let renameFileChange = null;
  let editChanges = [];
  await g.it('B7b.rename(UploadException → 新名) → documentChanges 含 PSR-4 renameFile + 多文件 edit 分组', async () => {
    const pos = { line: excClassLoc.line, character: excClassLoc.character + 'class '.length + 2 };
    const resp = await client.request('textDocument/rename', {
      textDocument: { uri: excUri },
      position: pos,
      newName: NEW,
    }, { timeoutMs: 120000, timeLabel: 'B rename(UploadException 跨仓)' });
    const r = resp.result;
    if (!r) throw new Error(`rename 无结果：${T.summary(resp)}`);
    const docs = Array.isArray(r.documentChanges) ? r.documentChanges : [];
    renameFileChange = docs.find((c) => c.kind === 'rename') || null;
    editChanges = docs.filter((c) => c.kind === 'edit');
    if (!renameFileChange) {
      throw new Error(`无 renameFile（PSR-4 迁移）：documentChanges=${T.summary(docs.map((c) => ({ kind: c.kind, uri: (c.textDocument || {}).uri })))}`);
    }
    const okOld = renameFileChange.oldUri.endsWith('/application/common/exception/UploadException.php');
    const okNew = renameFileChange.newUri.endsWith(`/application/common/exception/${NEW}.php`);
    if (!okOld || !okNew) {
      throw new Error(`renameFile 路径不符：${renameFileChange.oldUri} → ${renameFileChange.newUri}`);
    }
    const uris = new Set(editChanges.map((c) => c.textDocument && c.textDocument.uri));
    if (!uris.has(excUri) || !uris.has(ajaxUri)) {
      throw new Error(`编辑分组缺本体/引用方：${T.summary([...uris])}`);
    }
    return `renameFile=${renameFileChange.oldUri.split('/').pop()} → ${renameFileChange.newUri.split('/').pop()}；edit 文件数=${editChanges.length}（含声明文件与 Ajax.php 等）`;
  });

  await g.it('B7c.rename 内存 apply（Ajax.php）：use 行 + 4 处 catch 全更新，旧名零残留（不落盘）', async () => {
    const change = editChanges.find((c) => c.textDocument && c.textDocument.uri === ajaxUri);
    if (!change) throw new Error('Ajax.php 无编辑组');
    const applied = T.applyTextEdits(texts.ajax, change.edits);
    if (!applied.includes(`use app\\common\\exception\\${NEW};`)) {
      throw new Error(`use 行未更新：${T.summary(applied.split('\n').find((l) => l.includes('use app\\common\\exception')))}`);
    }
    const catchCount = (applied.match(/catch \(T5UploadExceptionRenamed/g) || []).length;
    if (catchCount < 4) throw new Error(`catch 更新数=${catchCount}（期望 ≥4）`);
    if (new RegExp(`\\b${OLD}\\b`).test(applied)) throw new Error('旧名残留');
    return `use app\\common\\exception\\${NEW}; ✓；catch 更新 ${catchCount} 处；\\bUploadException\\b 残留=0；磁盘未写入（哈希校验见 B7e）`;
  });

  await g.it('B7d.rename 内存 apply（Material.php）：FQN throw/catch 全更新（未 didOpen 的磁盘文件也覆盖）', async () => {
    const change = editChanges.find((c) => c.textDocument && c.textDocument.uri === uriOf(materialAbs));
    if (!change) throw new Error('Material.php 无编辑组');
    const applied = T.applyTextEdits(materialText, change.edits);
    const fqnCount = (applied.match(new RegExp(`\\\\app\\\\common\\\\exception\\\\${NEW}`, 'g')) || []).length;
    if (fqnCount < 2) throw new Error(`FQN 更新数=${fqnCount}（期望 throw+catch ≥2）`);
    if (new RegExp(`\\b${OLD}\\b`).test(applied)) throw new Error('旧名残留');
    return `\\app\\common\\exception\\${NEW} 更新 ${fqnCount} 处（throw + catch）；旧名残留=0`;
  });

  await g.it('B7e.rename 零落盘：WorkspaceEdit 涉及文件哈希前后一致', async () => {
    const involved = [abs.uploadExc, abs.ajax, materialAbs, ...(renameFileChange ? [abs.uploadExc] : [])];
    const bad = [];
    for (const f of [...new Set(involved)]) {
      const now = T.sha256File(f, fs);
      const before = ctx.hashes.get(f);
      if (before !== now) bad.push(`${f}（${before} → ${now}）`);
    }
    if (bad.length) throw new Error(`落盘污染：${bad.join('；')}`);
    return `${new Set(involved).size} 个涉及文件 sha256 前后一致；rename 仅返回 WorkspaceEdit，未应用落盘`;
  });

  // ---------- codeAction（合成 3 例） ----------
  const paySvcAbs = ctx.p('t5test', 'ca-import-svc.php');
  const paySvcText = `<?php
namespace T5\\ca\\billing;

class T5PaymentGateway
{
    public function charge(int $cents): bool
    {
        return $cents >= 0;
    }
}
`;
  const callerAbs = ctx.p('t5test', 'ca-import-caller.php');
  const callerText = `<?php

namespace T5\\ca\\shop;

use T5\\ca\\util\\AlphaUtil;
use T5\\ca\\util\\ZetaUtil;

class T5OrderService
{
    public function pay(): T5PaymentGateway
    {
        return new T5PaymentGateway();
    }
}
`;
  ctx.openDoc(paySvcAbs, paySvcText);
  ctx.openDoc(callerAbs, callerText);
  const callerUri = uriOf(callerAbs);

  await g.it('B8a.codeAction/resolve(自动 import) → 插入 use T5\\ca\\billing\\T5PaymentGateway 且按字母序排在 AlphaUtil 前', async () => {
    const retLine = T.locate(callerText, 'public function pay(): T5PaymentGateway');
    const pos = { line: retLine.line, character: retLine.character + 'public function pay(): T5Payment'.length };
    const resp = await client.request('textDocument/codeAction', {
      textDocument: { uri: callerUri },
      range: { start: pos, end: pos },
      context: { diagnostics: [] },
    });
    const acts = Array.isArray(resp.result) ? resp.result : [];
    const action = acts.find((a) => a && a.kind === 'quickfix' && typeof a.title === 'string' && a.title.includes('T5PaymentGateway'));
    if (!action) throw new Error(`无 import action：${T.summary(acts.map((a) => ({ kind: a && a.kind, title: a && a.title })))}`);
    const resolved = await client.request('codeAction/resolve', action);
    const edits = ((resolved.result && resolved.result.edit && resolved.result.edit.changes) || {})[callerUri] || [];
    if (edits.length === 0) throw new Error(`resolve 后无编辑：${T.summary(resolved.result)}`);
    const applied = T.applyTextEdits(callerText, edits);
    const billingLine = applied.split('\n').findIndex((l) => l.includes('use T5\\ca\\billing\\T5PaymentGateway;'));
    const alphaLine = applied.split('\n').findIndex((l) => l.includes('use T5\\ca\\util\\AlphaUtil;'));
    if (billingLine < 0) throw new Error(`use 行未插入：${T.summary(applied.split('\n').slice(0, 10))}`);
    if (!(billingLine > 0 && billingLine < alphaLine)) {
      throw new Error(`字母序插入位置异常：billing@${billingLine} alpha@${alphaLine}`);
    }
    return `title="${action.title}"；resolve 后插入 use 行 @${billingLine} < AlphaUtil @${alphaLine}（全 FQN 字母序）`;
  });

  const pullIfaceAbs = ctx.p('t5test', 'pull-iface.php');
  const pullIfaceText = `<?php
namespace T5\\pull;

interface T5Puller
{
    public function pull(int $n): array;

    public static function label(): string;
}
`;
  const workerAbs = ctx.p('t5test', 'pull-worker.php');
  const workerText = `<?php
namespace T5\\pull;

class T5WorkerPuller implements T5Puller
{
}
`;
  ctx.openDoc(pullIfaceAbs, pullIfaceText);
  ctx.openDoc(workerAbs, workerText);

  await g.it('B8b.codeAction/resolve(实现抽象方法) → 一次生成 pull+label 两个类型化 stub', async () => {
    const clsLine = T.locate(workerText, 'class T5WorkerPuller implements T5Puller');
    const pos = { line: clsLine.line, character: clsLine.character + 12 };
    const resp = await client.request('textDocument/codeAction', {
      textDocument: { uri: uriOf(workerAbs) },
      range: { start: pos, end: pos },
      context: { diagnostics: [] },
    });
    const acts = Array.isArray(resp.result) ? resp.result : [];
    const action = acts.find((a) => a && a.kind === 'quickfix' && typeof a.title === 'string' && a.title.includes('实现'));
    if (!action) throw new Error(`无实现 action：${T.summary(acts.map((a) => ({ kind: a && a.kind, title: a && a.title })))}`);
    const resolved = await client.request('codeAction/resolve', action);
    const edits = ((resolved.result && resolved.result.edit && resolved.result.edit.changes) || {})[uriOf(workerAbs)] || [];
    const stub = edits.map((e) => e.newText).join('');
    const okPull = stub.includes('function pull(int $n): array');
    const okLabel = stub.includes('static function label(): string');
    if (!okPull || !okLabel) throw new Error(`stub 缺方法：pull=${okPull} label=${okLabel}；stub=${T.summary(stub)}`);
    return `title="${action.title}"；stub 含 pull(int $n): array + static label(): string（${edits.length} 条编辑）`;
  });

  const reportAbs = ctx.p('t5test', 'ca-report.php');
  const reportText = `<?php
namespace T5\\ca;

class T5Report
{
    public function build(T5PaymentGateway $gw, int $copies = 1): ?string
    {
        if ($copies < 0) {
            throw new \\InvalidArgumentException('bad copies');
        }
        return $gw->charge($copies) ? 'ok' : 'fail';
    }
}
`;
  ctx.openDoc(reportAbs, reportText);

  await g.it('B8c.codeAction/resolve(生成 PHPDoc) → @param×2 + @return ?string + @throws', async () => {
    const fnLine = T.locate(reportText, 'public function build(');
    const pos = { line: fnLine.line, character: fnLine.character + 20 };
    const resp = await client.request('textDocument/codeAction', {
      textDocument: { uri: uriOf(reportAbs) },
      range: { start: pos, end: pos },
      context: { diagnostics: [] },
    });
    const acts = Array.isArray(resp.result) ? resp.result : [];
    const action = acts.find((a) => a && a.kind === 'source' && typeof a.title === 'string' && a.title.includes('PHPDoc'));
    if (!action) throw new Error(`无 PHPDoc action：${T.summary(acts.map((a) => ({ kind: a && a.kind, title: a && a.title })))}`);
    const resolved = await client.request('codeAction/resolve', action);
    const edits = ((resolved.result && resolved.result.edit && resolved.result.edit.changes) || {})[uriOf(reportAbs)] || [];
    const block = edits.map((e) => e.newText).join('');
    const checks = {
      '@param T5PaymentGateway $gw': block.includes('@param T5PaymentGateway $gw'),
      '@param int $copies': block.includes('@param int $copies'),
      '@return ?string': block.includes('@return ?string'),
      '@throws \\InvalidArgumentException': block.includes('@throws \\InvalidArgumentException'),
    };
    const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`docblock 缺项：${missing.join('、')}；block=${T.summary(block)}`);
    return `title="${action.title}"；${Object.keys(checks).join(' / ')}`.replace('title="' + action.title + '"；', `title 命中；`);
  });

  // ---------- codeLens ----------
  await g.it('B9a.codeLens(Product.php) 类声明行有 lens 骨架（range+kind，无 command=惰性）', async () => {
    const resp = await client.request('textDocument/codeLens', { textDocument: { uri: productUri } });
    const lenses = Array.isArray(resp.result) ? resp.result : [];
    const classLine = T.locate(productText, 'class Product extends Backend').line;
    const classLens = lenses.find((l) => l.range && l.range.start.line === classLine);
    if (!classLens) throw new Error(`类行 ${classLine} 无 lens：${T.summary(lenses.slice(0, 6))}`);
    if (!classLens.data || !classLens.data.kind) throw new Error(`lens 缺 data.kind：${T.summary(classLens)}`);
    if (classLens.command) throw new Error(`骨架不应带 command：${T.summary(classLens.command)}`);
    const resolved = await client.request('codeLens/resolve', { codeLens: classLens });
    const cmdTitle = resolved.result && resolved.result.command && resolved.result.command.title;
    return `类行 0基 ${classLine} lens kind=${classLens.data.kind}；resolve command.title=${T.summary(cmdTitle)}（Product 当前无子类，零计数隐藏属预期）；全文档 lens 数=${lenses.length}`;
  });

  await g.it('B9b.codeLens/resolve(Backend 类行) → 子类计数为数字且 ≥1（全仓控制器继承）', async () => {
    const backendUri = uriOf(abs.backend);
    const resp = await client.request('textDocument/codeLens', { textDocument: { uri: backendUri } });
    const lenses = Array.isArray(resp.result) ? resp.result : [];
    const classLine = T.locate(texts.backend, 'class Backend extends Controller').line;
    const classLens = lenses.find((l) => l.range && l.range.start.line === classLine && l.data && l.data.kind === 'class-subtypes');
    if (!classLens) throw new Error(`Backend 类行无 class-subtypes lens：${T.summary(lenses.slice(0, 5))}`);
    const resolved = await client.request('codeLens/resolve', { codeLens: classLens });
    const title = resolved.result && resolved.result.command && resolved.result.command.title;
    if (typeof title !== 'string' || !/\d/.test(title)) throw new Error(`resolve 无数字计数：${T.summary(resolved.result)}`);
    const n = parseInt((title.match(/\d+/) || ['0'])[0], 10);
    if (n < 1) throw new Error(`子类计数 ${n} < 1`);
    return `resolve command.title="${title}"（子类数 ${n} ≥1）`;
  });

  await g.it('B9c.codeLens/resolve(Product.php 至少一条 lens 出数字计数)', async () => {
    const resp = await client.request('textDocument/codeLens', { textDocument: { uri: productUri } });
    const lenses = Array.isArray(resp.result) ? resp.result : [];
    const withNumber = [];
    for (const l of lenses) {
      const resolved = await client.request('codeLens/resolve', { codeLens: l });
      const title = resolved.result && resolved.result.command && resolved.result.command.title;
      if (typeof title === 'string' && /\d/.test(title)) withNumber.push(`${l.data && l.data.kind}@${l.range.start.line}="${title}"`);
      if (withNumber.length >= 3) break;
    }
    if (withNumber.length === 0) throw new Error(`全部 ${lenses.length} 条 lens resolve 后均无数字计数`);
    return `计数通道可用：${withNumber.join('；')}`;
  });

  // ---------- inlayHint ----------
  await g.it('B10a.inlayHint/resolve(真实 Product.php auth->check 实参) → 参数名 hint "name:"', async () => {
    const resp = await client.request('textDocument/inlayHint', { textDocument: { uri: productUri } });
    const hints = Array.isArray(resp.result) ? resp.result : [];
    const authUsage = T.locate(productText, "$this->auth->check('product/product/add')");
    const onLine = hints.filter((h) => h.position && h.position.line === authUsage.line && h.data && h.data.kind === 'param');
    if (onLine.length === 0) throw new Error(`53 行无参数 hint：全文档 hints=${hints.length}`);
    const resolved = await client.request('inlayHint/resolve', onLine[0]);
    const label = resolved.result && resolved.result.label;
    if (label !== 'name:') throw new Error(`label=${T.summary(label)}（期望 "name:"，Auth::check 首参 $name）`);
    return `0基 ${authUsage.line} 行参数 hint ${onLine.length} 条；resolve label="${label}"（Auth::check($name,…)）`;
  });

  const inlayAbs = ctx.p('t5test', 'inlay.php');
  const inlayText = `<?php
namespace T5\\hint;

class T5Ticker
{
    public function label(int $n)
    {
        if ($n > 0) {
            return 'plus';
        }
        return 'minus';
    }

    public function wrap(string $s, $pad = 0)
    {
        return $s . str_repeat('-', (int) $pad);
    }
}
`;
  ctx.openDoc(inlayAbs, inlayText);

  await g.it('B10b.inlayHint/resolve(合成) → 无返回类型标注方法补 ": string" 返回类型 hint', async () => {
    const inlayUri = uriOf(inlayAbs);
    const resp = await client.request('textDocument/inlayHint', { textDocument: { uri: inlayUri } });
    const hints = Array.isArray(resp.result) ? resp.result : [];
    const labelDecl = T.locate(inlayText, 'public function label(int $n)');
    const hint = hints.find((h) => h.data && h.data.kind === 'return' && h.position.line === labelDecl.line);
    if (!hint) throw new Error(`label 声明行无 return hint：hints=${T.summary(hints.map((h) => ({ line: h.position && h.position.line, kind: h.data && h.data.kind })))}`);
    const resolved = await client.request('inlayHint/resolve', hint);
    const ret = resolved.result && resolved.result.label;
    if (ret !== ': string') throw new Error(`返回类型 hint=${T.summary(ret)}（期望 ": string"，两处 return 字面量同型）`);
    const wrapDecl = T.locate(inlayText, 'public function wrap(string $s, $pad = 0)');
    const wrapHint = hints.find((h) => h.data && h.data.kind === 'return' && h.position.line === wrapDecl.line);
    return `label() @0基 ${labelDecl.line} → "${ret}"；wrap() return hint ${wrapHint ? '在列（惰性）' : '缺席'}；全文档 hints=${hints.length}`;
  });

  // ---------- @mixin ----------
  const kernelAbs = ctx.p('t5test', 'mixin-kernel.php');
  const kernelText = `<?php
namespace T5\\mix;

class T5Kernel
{
    /** @var string */
    public $kernelProp = 'k';

    public function kernelPing(string $who = 'x'): string
    {
        return 'pong-' . $who;
    }
}
`;
  const hostAbs = ctx.p('t5test', 'mixin-host.php');
  const hostText = `<?php
namespace T5\\mix;

use T5\\mix\\T5Kernel;

/**
 * 宿主（@mixin 成员合并，T5 合成样本）
 * @mixin T5Kernel
 */
class T5Host
{
    public function work()
    {
        return $this->kernelPing('t5') . $this->kernelProp;
    }
}
`;
  ctx.openDoc(kernelAbs, kernelText);
  ctx.openDoc(hostAbs, hostText);
  const hostKernel = T.locate(hostText, '$this->kernelPing(');

  await g.it('B11a.@mixin completion($this->) → kernelPing（origin=mixin）与 kernelProp 均并入', async () => {
    const pos = { line: hostKernel.line, character: hostKernel.character + '$this->'.length };
    const resp = await client.request('textDocument/completion', { textDocument: { uri: uriOf(hostAbs) }, position: pos });
    const items = T.asItems(resp.result);
    const ping = items.find((i) => i && i.label === 'kernelPing');
    const prop = items.find((i) => i && i.label === 'kernelProp');
    if (!ping || !prop) throw new Error(`缺 kernelPing/kernelProp：${T.summary(items.map((i) => i && i.label).slice(0, 30))}`);
    const detail = typeof ping.detail === 'string' ? ping.detail : T.summary(ping.detail);
    if (!detail.startsWith('mixin:')) throw new Error(`kernelPing.detail 非 mixin 来源：${detail}`);
    return `kernelPing detail="${detail}"；kernelProp 在列；总项数=${items.length}`;
  });

  await g.it('B11b.@mixin definition($this->kernelPing) → 跳 T5Kernel.php 方法声明（合并成员可解析）', async () => {
    const pos = { line: hostKernel.line, character: hostKernel.character + '$this->'.length };
    const resp = await client.request('textDocument/definition', { textDocument: { uri: uriOf(hostAbs) }, position: pos });
    const declLine = T.locate(kernelText, 'public function kernelPing(').line;
    const hit = T.asLocations(resp.result).find(
      (l) => typeof l.uri === 'string' && l.uri.endsWith('mixin-kernel.php') && l.range.start.line === declLine
    );
    if (!hit) throw new Error(`无 kernel 声明命中：${T.summary(resp.result)}（期望 0基 ${declLine}）`);
    return `mixin-kernel.php kernelPing 声明 @0基 ${hit.range.start.line}`;
  });
};
