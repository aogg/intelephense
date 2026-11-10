'use strict';
/**
 * test/groups/a-acceptance.js — A 组：用户验收底线（zuodian 真实文件）。
 *
 * A1  Product.php 0 基 53 行 $this->auth 四角度：definition→Backend.php $auth 声明 /
 *     hover 含 Auth 类型 / $this-> 补全含 auth / auth-> 补全含 check() 且 detail 带参数签名
 * A2  typeHierarchy/prepare($this->auth) → Auth 类
 * A3  类注释 @property 通道：zuodian 真实样本 Admin.php（类 docblock @property×34）补全 +
 *     合成「父类类注释 @property」文档 definition/hover/completion/typeDefinition
 */

const T = require('../helpers/text');

module.exports = async function groupA(ctx) {
  const { client, suite, texts, abs, uriOf } = ctx;
  const g = suite.group('A 用户验收底线（zuodian 真实文件）');

  const productUri = uriOf(abs.product);
  const backendUri = uriOf(abs.backend);
  const productText = texts.product;
  const backendText = texts.backend;

  const authUsage = T.locate(productText, "$this->auth->check('product/product/add')");
  const authChar = { line: authUsage.line, character: authUsage.character + '$this->'.length };
  const authDeclLine = T.locate(backendText, '$auth = null').line;

  // ---------- A1 四角度 ----------
  await g.it('A1a.definition($this->auth @0基53) → Backend.php $auth 声明（0基44）+ range 文本含 "$auth"', async () => {
    if (authUsage.line !== 53) {
      throw new Error(`前提漂移：$this->auth->check 实际 0 基行=${authUsage.line}（任务基准 53）`);
    }
    if (authDeclLine !== 44) {
      throw new Error(`前提漂移：Backend $auth 声明实际 0 基行=${authDeclLine}（任务基准 1 基 45 → 0 基 44）`);
    }
    const resp = await client.request(
      'textDocument/definition',
      { textDocument: { uri: productUri }, position: authChar },
      { timeLabel: 'A definition(Product)' }
    );
    const locs = T.asLocations(resp.result);
    const hit = locs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('/application/common/controller/Backend.php'));
    if (!hit) throw new Error(`无 Backend.php 命中：结果=${T.summary(resp.result)}`);
    const rangeText = T.textInRange(backendText, hit.range);
    if (hit.range.start.line !== authDeclLine) {
      throw new Error(`命中行=${hit.range.start.line}（期望 ${authDeclLine}）；rangeText=${JSON.stringify(rangeText)}`);
    }
    if (!rangeText.includes('$auth')) {
      throw new Error(`range 文本不含 "$auth"：${JSON.stringify(rangeText)}`);
    }
    return `Backend.php 0基 line=${hit.range.start.line}（1基 ${hit.range.start.line + 1}），range 文本="${rangeText.trim()}"；结果总数=${locs.length}`;
  });

  await g.it('A1b.hover($this->auth) → 含 Auth 类型（docblock 佐证）', async () => {
    const resp = await client.request(
      'textDocument/hover',
      { textDocument: { uri: productUri }, position: authChar },
      { timeLabel: 'A hover(Product)' }
    );
    const value = T.hoverText(resp.result);
    if (!value.includes('Auth')) throw new Error(`hover 不含 Auth：${T.summary(resp.result)}`);
    const docblockOk = value.includes('权限控制类');
    const varOk = value.includes('$auth');
    return `markdown 含 "Auth"${docblockOk ? ' + 「权限控制类」' : ''}${varOk ? ' + "$auth"' : ''}；摘录=${value
      .split('\n')
      .filter((s) => s.includes('Auth'))
      .slice(0, 2)
      .join(' | ')
      .slice(0, 200)}`;
  });

  await g.it('A1c.completion($this->) → 含 auth（Backend 继承成员；model 同列佐证）', async () => {
    const compPos = T.locate(productText, '$this->model->getStatusList()');
    const pos = { line: compPos.line, character: compPos.character + '$this->'.length };
    const resp = await client.request(
      'textDocument/completion',
      { textDocument: { uri: productUri }, position: pos },
      { timeLabel: 'A completion($this->)' }
    );
    const items = T.asItems(resp.result);
    const auth = items.find((i) => i && i.label === 'auth');
    if (!auth) {
      throw new Error(`items(${items.length}) 无 auth：labels=${T.summary(items.slice(0, 30).map((i) => i && i.label))}`);
    }
    const alsoModel = items.some((i) => i && i.label === 'model');
    return `auth 在列（detail=${T.summary(auth.detail)} kind=${auth.kind}）；总项数=${items.length}；model 同列=${alsoModel}`;
  });

  await g.it('A1d.completion(auth->) → check 且 detail 带参数签名（$name）', async () => {
    const pos = { line: authUsage.line, character: authUsage.character + '$this->auth->'.length };
    const resp = await client.request(
      'textDocument/completion',
      { textDocument: { uri: productUri }, position: pos },
      { timeLabel: 'A completion(auth->)' }
    );
    const items = T.asItems(resp.result);
    const check = items.find((i) => i && i.label === 'check');
    if (!check) {
      throw new Error(`items(${items.length}) 无 check：labels=${T.summary(items.slice(0, 40).map((i) => i && i.label))}`);
    }
    const detail = typeof check.detail === 'string' ? check.detail : T.summary(check.detail);
    if (!/\$name/.test(detail)) throw new Error(`check.detail 无 $name：${detail}`);
    return `check detail="${detail}"；总项数=${items.length}`;
  });

  // ---------- A2 typeHierarchy ----------
  await g.it('A2.typeHierarchy/prepare($this->auth) → Auth 类（kind=5 + data.fqn + uri 指向 admin/library/Auth.php）', async () => {
    const resp = await client.request('textDocument/prepareTypeHierarchy', {
      textDocument: { uri: productUri },
      position: authChar,
    });
    const items = Array.isArray(resp.result) ? resp.result : [];
    const hit = items.find((i) => i && i.name === 'Auth');
    if (!hit) throw new Error(`无 Auth 项：${T.summary(items)}`);
    const okUri = typeof hit.uri === 'string' && hit.uri.endsWith('/application/admin/library/Auth.php');
    const okKind = hit.kind === 5;
    const okData = !!(hit.data && hit.data.fqn === 'app\\admin\\library\\Auth');
    const okShape = !!(hit.range && hit.selectionRange);
    if (!(okUri && okKind && okData && okShape)) {
      throw new Error(`字段不符：uri=${hit.uri} kind=${hit.kind} data=${T.summary(hit.data)} shape=${!!okShape}`);
    }
    return `name=Auth kind=${hit.kind}(Class) uri=…/${hit.uri.split('/').slice(-3).join('/')} fqn=${hit.data.fqn}`;
  });

  // ---------- A3 @property 通道 ----------
  await g.it('A3a.真实样本 Admin.php（类 docblock @property×34）→ completion($this->) 含虚拟属性 username/org_id', async () => {
    const adminText = texts.admin;
    const pos0 = T.locate(adminText, '$this->belongsTo');
    const pos = { line: pos0.line, character: pos0.character + '$this->'.length };
    const resp = await client.request('textDocument/completion', {
      textDocument: { uri: uriOf(abs.admin) },
      position: pos,
    });
    const items = T.asItems(resp.result);
    const labels = new Set(items.map((i) => i && i.label).filter(Boolean));
    const propNames = [...adminText.matchAll(/@property[-\w]*\s+\S+\s+(\$?\w+)/g)].map((m) => m[1].replace(/^\$/, ''));
    const hits = propNames.filter((n) => labels.has(n));
    if (!labels.has('username') || !labels.has('org_id')) {
      throw new Error(
        `虚拟属性缺失：username=${labels.has('username')} org_id=${labels.has('org_id')}；总项=${items.length}；docblock 属性 ${propNames.length} 个`
      );
    }
    return `类注释 @property 共 ${propNames.length} 个 → 补全命中 ${hits.length} 个（含 username/org_id）；总项数=${items.length}`;
  });

  // A3b 合成「父类类注释 @property」（父文档 + 子文档，均仅内存 didOpen，不落盘）
  const parentAbs = ctx.p('t5test', 'docprop-parent.php');
  const childAbs = ctx.p('t5test', 'docprop-child.php');
  const parentText = `<?php
namespace T5\\docprop;

/**
 * 父类类注释 @property 通道（T5 合成样本）
 * @property \\T5\\docprop\\KernelService $kernel 内核服务
 * @property string $tag 标签
 */
class DocPropBase
{
    public function boot()
    {
        return $this->kernel->ping();
    }
}

class KernelService
{
    /** @var string */
    public $name = 'ks';

    public function ping(): string
    {
        return 'pong-' . $this->name;
    }
}
`;
  const childText = `<?php
namespace T5\\docprop;

class DocPropChild extends DocPropBase
{
    public function run()
    {
        return $this->kernel->ping() . $this->tag;
    }
}
`;
  const parentUri = uriOf(parentAbs);
  const childUri = uriOf(childAbs);
  const propTagLine = T.locate(parentText, '@property \\T5\\docprop\\KernelService $kernel').line;
  const kernelClsLine = T.locate(parentText, 'class KernelService').line;
  const childKernel = T.locate(childText, '$this->kernel->ping()');
  const childKernelChar = { line: childKernel.line, character: childKernel.character + '$this->'.length };

  ctx.openDoc(parentAbs, parentText);
  ctx.openDoc(childAbs, childText);

  await g.it('A3b.definition(子类 $this->kernel) → 父类文档内可解析（记录落点语义：宿主类名 vs @property 标签行）', async () => {
    const resp = await client.request('textDocument/definition', { textDocument: { uri: childUri }, position: childKernelChar });
    const locs = T.asLocations(resp.result);
    const hit = locs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('docprop-parent.php'));
    if (!hit) throw new Error(`definition 不可解析（验收底线：$this->成员需可跳转）：${T.summary(resp.result)}`);
    const rangeText = T.textInRange(parentText, hit.range);
    const onTag = hit.range.start.line === propTagLine;
    const semantics = onTag
      ? `落在 @property 标签行 ${propTagLine}（最精确）`
      : `落在宿主类名 token（0基 ${hit.range.start.line}，"${rangeText}"；虚拟属性无实体声明，tag 行走 declaration 通道，见 A3c）`;
    if (!rangeText.includes('DocPropBase') && !onTag) {
      throw new Error(`落点不在父类声明附近：${T.summary(hit)}`);
    }
    return `跨文件命中 docprop-parent.php；${semantics}`;
  });

  await g.it('A3c.declaration(子类 $this->kernel) → 父类 docblock @property 标签行（tag 精确通道，跨文件）', async () => {
    const resp = await client.request('textDocument/declaration', { textDocument: { uri: childUri }, position: childKernelChar });
    const locs = T.asLocations(resp.result);
    const hit = locs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('docprop-parent.php'));
    if (!hit) throw new Error(`declaration 无父文档命中：${T.summary(resp.result)}`);
    if (hit.range.start.line !== propTagLine) {
      throw new Error(`未落在 @property 标签行：命中 0基 ${hit.range.start.line}（期望 ${propTagLine}）；结果=${T.summary(locs)}`);
    }
    const rangeText = T.textInRange(parentText, hit.range);
    return `docprop-parent.php @property 标签行 0基 ${hit.range.start.line}，range 文本="${rangeText}"`;
  });

  await g.it('A3b.hover(子类 $this->kernel) → 含 KernelService 类型', async () => {
    const resp = await client.request('textDocument/hover', { textDocument: { uri: childUri }, position: childKernelChar });
    const value = T.hoverText(resp.result);
    if (!value.includes('KernelService')) throw new Error(`hover 不含 KernelService：${T.summary(resp.result)}`);
    return `markdown 含 "KernelService"；摘录=${value.split('\n').slice(0, 3).join(' | ').slice(0, 180)}`;
  });

  await g.it('A3b.completion(子类 $this->) → 含 kernel 与 tag（父类类注释虚拟属性并入）', async () => {
    const pos = { line: childKernel.line, character: childKernel.character + '$this->'.length };
    const resp = await client.request('textDocument/completion', { textDocument: { uri: childUri }, position: pos });
    const items = T.asItems(resp.result);
    const labels = new Set(items.map((i) => i && i.label).filter(Boolean));
    if (!labels.has('kernel') || !labels.has('tag')) {
      throw new Error(`缺 kernel/tag：${T.summary([...labels].slice(0, 30))}`);
    }
    return `kernel 与 tag 均在列（父类 docblock @property）；总项数=${items.length}`;
  });

  await g.it('A3b.typeDefinition(子类 $this->kernel) → KernelService 类声明（@property 类型通道）', async () => {
    const resp = await client.request('textDocument/typeDefinition', { textDocument: { uri: childUri }, position: childKernelChar });
    const locs = T.asLocations(resp.result);
    const hit = locs.find((l) => typeof l.uri === 'string' && l.uri.endsWith('docprop-parent.php'));
    if (!hit) {
      throw new Error(
        `typeDefinition 返回 ${T.summary(resp.result)}（null/空）；同位置 hover 可给出 KernelService（A3b.hover PASS）、definition 可跳宿主类（A3b.definition PASS）——docblock @property 虚拟属性的类型通道未接入 typeDefinition，期望 class KernelService @0基 ${kernelClsLine}`
      );
    }
    if (hit.range.start.line !== kernelClsLine) {
      throw new Error(`命中行=${hit.range.start.line}（期望 class KernelService 行 ${kernelClsLine}）`);
    }
    return `docprop-parent.php class KernelService @0基 ${hit.range.start.line}`;
  });
};
