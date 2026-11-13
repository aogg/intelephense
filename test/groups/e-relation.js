'use strict';
/**
 * test/groups/e-relation.js — E 组：definition 通道 ThinkPHP 关联跳转（src/features/relation.ts）。
 *
 * 合成 fixture 复刻 zuodian admin/controller/product/Product.php 第 101-102 行形态
 * （控制器属性 docblock @property + use 别名 → 模型关联方法），全部为内存 didOpen
 * 合成文档（t5test/ 路径不落盘，Z 组零残留 + 哈希基线兜底），不引用外部项目绝对路径。
 *
 * E1  P0 字符串实参 with('category')（zuodian 跨行形态）→ 模型 category() 方法名上
 * E2  P0 数组列表 ['category','spec'] → 两个元素分别命中 category()/spec()
 * E3  P0 数组键 ['category' => closure] → 键命中 category()；闭包体内 where('x.y') 不触发
 * E4  P0 复合名 'category.sub' 第二段经第一段 @return 下钻 → T5RelCategory::sub()
 * E5  P0 复合名 'spec.deeper' 第二段推不出（无 @return）→ 只回第一段 spec()（第一段光标同）
 * E6  P0 has('category') 同样接受关联名
 * E7  P0 负样本：where('name',...)/field('a.b,c')/order('id desc') 普通字符串不触发（空结果）
 * E8  P0 接收方类型未知（未声明 $this->ghost）→ 全局同名搜索返回多个 Location（fixture 两模型）
 * E9  P1 方法名 __call 转发：stub 基类 __call 证明 → 全局搜 with 命中 stub Query::with（vendor 同名列作证据）
 * E10 P1 层级完整且无 __call（clean）→ 严格 null（防污染，不全局兜底）
 * E11 P1 接收方完全未知 → 全局兜底唯一命中 stub Query::t5RelGlobalProbe
 * E12 P1 __call 层级在但全局搜不到 → 诚实 null（不编造位置）
 * E13 回归：$this->model 用法仍走主通道（docblock @property 标签），relation 不劫持
 */

const T = require('../helpers/text');

// ---------- fixture（内嵌 PHP 文本；类名带 T5Rel 前缀避免与宿主工作区真实类重名） ----------

/** 模型文件：关联方法定义 + __call 门槛基类 + 无 __call 普通模型 */
const MODELS_TEXT = `<?php

namespace T5\\rel\\model;

/**
 * 分类模型（嵌套关联下钻目标）
 */
class T5RelCategory
{
    public function sub()
    {
        return [];
    }
}

/**
 * stub think\\Model：基类仅声明 __call（P1 魔法转发门槛）
 */
class T5RelBaseModel
{
    public function __call($method, $args)
    {
        return null;
    }
}

/**
 * 商品模型（复刻 zuodian admin/model/product/Product.php 形态）
 */
class T5RelProduct extends T5RelBaseModel
{
    /**
     * 关联分类
     *
     * @return T5RelCategory
     */
    public function category()
    {
        return $this->belongsTo(T5RelCategory::class, 'category_id', 'id', [], 'LEFT');
    }

    /**
     * 关联规格（无 @return：复合名第二段推不出的负样本）
     */
    public function spec()
    {
        return [];
    }
}

/**
 * 第二个带同名 category() 的模型（接收方未知时全局搜索返回多个 Location）
 */
class T5RelPost extends T5RelBaseModel
{
    /**
     * 关联分类
     *
     * @return T5RelCategory
     */
    public function category()
    {
        return $this->belongsTo(T5RelCategory::class, 'category_id', 'id', [], 'LEFT');
    }
}

/**
 * 层级完整且无 __call 的普通模型（P1 防污染负样本）
 */
class T5RelPlainModel
{
    public function getName()
    {
        return '';
    }
}
`;

/** stub 查询器：P1 __call 转发 / 全局兜底的同名方法目标（with 方法名语义对标 think\db\Query::with） */
const QUERY_TEXT = `<?php

namespace T5\\rel\\db;

/**
 * stub think\\db\\Query：P1 __call 转发 / 全局兜底的同名方法目标
 */
class T5RelQuery
{
    public function with($relation)
    {
        return $this;
    }

    public function where($field, $op = null, $value = null)
    {
        return $this;
    }

    public function t5RelGlobalProbe()
    {
        return $this;
    }
}
`;

/** 控制器：复刻 zuodian 控制器形态（docblock @property + use 别名 + 跨行 ->with()） */
const CONTROLLER_TEXT = `<?php

namespace T5\\rel\\controller;

use T5\\rel\\model\\T5RelProduct as ProductModel;
use T5\\rel\\model\\T5RelPlainModel as PlainModel;

/**
 * 商品控制器（复刻 zuodian admin/controller/product/Product.php 第 101-102 行形态）
 *
 * @property ProductModel $model
 * @property PlainModel $plain
 */
class Product
{
    public function index()
    {
        // P0-a 字符串实参（zuodian 101-102 跨行形态）
        return $this->model
            ->with('category');
    }

    public function scenarios()
    {
        // P0-b 数组列表实参
        $this->model->with(['category', 'spec']);
        // P0-c 数组键实参（闭包体内 where 不触发）
        $this->model->with(['category' => function ($q) {
            $q->where('x.y', 1);
        }]);
        // P0-d 复合名：第二段经 @return 下钻
        $this->model->with('category.sub');
        // P0-e 复合名第二段推不出：只回第一段
        $this->model->with('spec.deeper');
        // has 同样接受关联名
        $this->model->has('category');
        // P0 负样本：普通查询字符串不触发
        $this->model->where('name', 'like', '%x%');
        $this->model->field('a.b,c');
        $this->model->order('id desc');
        // P0 接收方未知：全局同名搜索（fixture 两模型均含 category()）
        return $this->ghost->with('category');
    }

    public function detail()
    {
        // P1-a 方法名 __call 转发（基类 __call 证明 → 全局搜 with）
        return $this->model->with('category')->find();
    }

    public function plainCase()
    {
        // P1-b 层级完整无 __call：严格不兜底
        return $this->plain->with('category');
    }

    public function probe()
    {
        // P1-c 接收方完全未知：全局兜底
        return $this->ghost->t5RelGlobalProbe();
    }

    public function missing()
    {
        // P1-d __call 层级在但全局搜不到：诚实 null
        return $this->model->totallyMissing();
    }
}
`;

module.exports = async function groupE(ctx) {
  const { client, suite, p, uriOf } = ctx;
  const g = suite.group('E relation 关联跳转（合成 fixture，zuodian 形态）');

  // ---------- fixture 文档（仅内存 didOpen，不落盘） ----------
  const modelsAbs = p('t5test', 'relation', 't5-relation-models.php');
  const queryAbs = p('t5test', 'relation', 't5-relation-query.php');
  const ctlAbs = p('t5test', 'relation', 't5-relation-controller.php');
  const modelsUri = uriOf(modelsAbs);
  const queryUri = uriOf(queryAbs);
  const ctlUri = uriOf(ctlAbs);
  ctx.openDoc(modelsAbs, MODELS_TEXT);
  ctx.openDoc(queryAbs, QUERY_TEXT);
  ctx.openDoc(ctlAbs, CONTROLLER_TEXT);

  // ---------- 定位（needle 唯一；occurrence 次序与 fixture 文本一致） ----------
  const productCategoryLine = T.locate(MODELS_TEXT, 'public function category', 0).line; // T5RelProduct::category
  const postCategoryLine = T.locate(MODELS_TEXT, 'public function category', 1).line; // T5RelPost::category
  const productSpecLine = T.locate(MODELS_TEXT, 'public function spec').line;
  const categorySubLine = T.locate(MODELS_TEXT, 'public function sub').line;
  const queryWithLine = T.locate(QUERY_TEXT, 'public function with').line;
  const queryProbeLine = T.locate(QUERY_TEXT, 'public function t5RelGlobalProbe').line;
  const propTagLine = T.locate(CONTROLLER_TEXT, '@property ProductModel $model').line;

  const def = async (needle, occurrence, offset, uri) => {
    const at = T.locate(CONTROLLER_TEXT, needle, occurrence);
    const pos = { line: at.line, character: at.character + offset };
    const resp = await client.request(
      'textDocument/definition',
      { textDocument: { uri: uri || ctlUri }, position: pos },
      { timeLabel: `E definition(${needle.slice(0, 24)}@${pos.line}:${pos.character})` }
    );
    return { resp, pos, locs: T.asLocations(resp.result) };
  };
  const at = (needle, occurrence, offset) => {
    const base = T.locate(CONTROLLER_TEXT, needle, occurrence);
    return { line: base.line, character: base.character + offset };
  };
  const hitIn = (locs, uri, line) => locs.find((l) => l.uri === uri && l.range.start.line === line);
  const assertNone = (locs, tag) => {
    if (locs.length > 0) {
      throw new Error(`期望空结果（relation 不触发），实际 ${JSON.stringify(locs.map((l) => [l.uri.split('/').pop(), l.range.start.line]))}`);
    }
  };

  // ---------- E1 P0 字符串实参（zuodian 跨行形态） ----------
  await g.it('E1.P0 with(\'category\') 字符串实参 → T5RelProduct::category()（range 落在方法名上）', async () => {
    const { resp, locs } = await def("->with('category');", 0, 9); // 光标落在 'category' 字符串内
    const hit = hitIn(locs, modelsUri, productCategoryLine);
    if (!hit) throw new Error(`无模型 category() 命中：${T.summary(resp.result)}`);
    const rangeText = T.textInRange(MODELS_TEXT, hit.range);
    if (!rangeText.includes('category')) throw new Error(`range 未落在方法名上：${JSON.stringify(rangeText)}`);
    return `t5-relation-models.php 0基 line=${hit.range.start.line}，range 文本="${rangeText}"（方法名 token）；结果数=${locs.length}`;
  });

  // ---------- E2 P0 数组列表实参 ----------
  await g.it('E2a.P0 数组列表 [\'category\',\'spec\'] 第一项 → category()', async () => {
    const { resp, locs } = await def("['category', 'spec']", 0, 3);
    const hit = hitIn(locs, modelsUri, productCategoryLine);
    if (!hit) throw new Error(`数组第一项未命中 category()：${T.summary(resp.result)}`);
    return `列表第一项 → models 0基 ${hit.range.start.line}（category）；结果数=${locs.length}`;
  });
  await g.it('E2b.P0 数组列表第二项 \'spec\' → spec()', async () => {
    const { resp, locs } = await def("['category', 'spec']", 0, 15);
    const hit = hitIn(locs, modelsUri, productSpecLine);
    if (!hit) throw new Error(`数组第二项未命中 spec()：${T.summary(resp.result)}`);
    return `列表第二项 → models 0基 ${hit.range.start.line}（spec）；结果数=${locs.length}`;
  });

  // ---------- E3 P0 数组键实参 + 闭包体排除 ----------
  await g.it('E3a.P0 数组键 [\'category\' => function] 键字符串 → category()', async () => {
    const { resp, locs } = await def("'category' => function", 0, 1);
    const hit = hitIn(locs, modelsUri, productCategoryLine);
    if (!hit) throw new Error(`数组键未命中 category()：${T.summary(resp.result)}`);
    return `数组键 → models 0基 ${hit.range.start.line}（category）；结果数=${locs.length}`;
  });
  await g.it('E3b.P0 排除：闭包体内 where(\'x.y\') 字符串不触发（空结果）', async () => {
    const { resp, locs } = await def("$q->where('x.y', 1)", 0, 12);
    assertNone(locs, 'E3b 闭包内 where');
    return `result=${JSON.stringify(resp.result)}（官方+自研均空，未误触发关联跳转）`;
  });

  // ---------- E4/E5 复合名 ----------
  await g.it('E4.P0 复合名 \'category.sub\' 第二段经 @return 下钻 → T5RelCategory::sub()', async () => {
    const { resp, locs } = await def("->with('category.sub');", 0, 18); // 光标在第二段 sub 内
    const hit = hitIn(locs, modelsUri, categorySubLine);
    if (!hit) throw new Error(`第二段未下钻到 sub()：${T.summary(resp.result)}（期望 0基 ${categorySubLine}）`);
    return `category.sub → models 0基 ${hit.range.start.line}（sub，第一段 category @return T5RelCategory 下钻）`;
  });
  await g.it('E5a.P0 复合名 \'spec.deeper\' 第二段推不出（spec 无 @return）→ 只回第一段 spec()', async () => {
    const { resp, locs } = await def("->with('spec.deeper');", 0, 14); // 光标在第二段 deeper 内
    const hit = hitIn(locs, modelsUri, productSpecLine);
    if (!hit) throw new Error(`第二段推不出时未回退第一段：${T.summary(resp.result)}`);
    const wrong = locs.find((l) => l.range.start.line !== productSpecLine && l.uri === modelsUri);
    if (wrong) throw new Error(`出现第一段之外命中（误跳）：${JSON.stringify([wrong.uri, wrong.range.start.line])}`);
    return `spec.deeper → models 0基 ${hit.range.start.line}（spec；第二段推不出诚实回退，不误跳不崩）`;
  });
  await g.it('E5b.P0 复合名第一段光标 \'spec.deeper\' → 同样 spec()', async () => {
    const { locs } = await def("->with('spec.deeper');", 0, 9); // 光标在第一段 spec 内
    const hit = hitIn(locs, modelsUri, productSpecLine);
    if (!hit) throw new Error(`第一段光标未命中 spec()：${JSON.stringify(locs)}`);
    return `第一段光标 → models 0基 ${hit.range.start.line}（spec）`;
  });

  // ---------- E6 has 同样接受关联名 ----------
  await g.it('E6.P0 has(\'category\') 字符串实参 → category()', async () => {
    const { resp, locs } = await def("->has('category');", 0, 7);
    const hit = hitIn(locs, modelsUri, productCategoryLine);
    if (!hit) throw new Error(`has 未命中 category()：${T.summary(resp.result)}`);
    return `has → models 0基 ${hit.range.start.line}（category）`;
  });

  // ---------- E7 P0 负样本：普通查询字符串不触发 ----------
  await g.it('E7a.P0 负样本 where(\'name\',\'like\',...) 光标在字符串 → 空结果', async () => {
    const { resp, locs } = await def("$this->model->where('name'", 0, 22);
    assertNone(locs, 'E7a where');
    return `result=${JSON.stringify(resp.result)}（where 非关联名，最内层调用即止）`;
  });
  await g.it('E7b.P0 负样本 field(\'a.b,c\') → 空结果', async () => {
    const { resp, locs } = await def("->field('a.b,c');", 0, 9);
    assertNone(locs, 'E7b field');
    return `result=${JSON.stringify(resp.result)}（field 点号字符串不卷入）`;
  });
  await g.it('E7c.P0 负样本 order(\'id desc\') → 空结果', async () => {
    const { resp, locs } = await def("->order('id desc');", 0, 9);
    assertNone(locs, 'E7c order');
    return `result=${JSON.stringify(resp.result)}`;
  });

  // ---------- E8 P0 接收方未知 → 全局同名搜索多命中 ----------
  await g.it('E8.P0 接收方类型未知（$this->ghost）→ 全局搜 category 返回多个 Location', async () => {
    const { resp, locs } = await def("ghost->with('category');", 0, 13);
    const productHit = hitIn(locs, modelsUri, productCategoryLine);
    const postHit = hitIn(locs, modelsUri, postCategoryLine);
    if (!productHit || !postHit) {
      throw new Error(`全局搜索未覆盖 fixture 两个 category()：${T.summary(resp.result)}（期望含 0基 ${productCategoryLine} 与 ${postCategoryLine}）`);
    }
    if (locs.length < 2) throw new Error(`期望多个 Location，实际 ${locs.length}`);
    return `结果数=${locs.length}：T5RelProduct::category @0基 ${productHit.range.start.line} + T5RelPost::category @0基 ${postHit.range.start.line}（编辑器出选择列表）`;
  });

  // ---------- E9 P1 方法名 __call 转发 ----------
  await g.it('E9.P1 方法名 with 层级证明 __call → 全局搜命中 stub Query::with', async () => {
    const { resp, locs } = await def("return $this->model->with('category')->find();", 0, 22); // 光标在 with 名字内
    const hit = hitIn(locs, queryUri, queryWithLine);
    if (!hit) throw new Error(`未命中 stub T5RelQuery::with：${T.summary(resp.result)}`);
    const others = locs.filter((l) => l.uri !== queryUri).length;
    return `Query stub 0基 ${hit.range.start.line}（with）；同名方法总数=${locs.length}（vendor 等同名 ${others} 个并列，编辑器出选择列表）`;
  });

  // ---------- E10 P1 clean 层级严格不兜底 ----------
  await g.it('E10.P1 层级完整且无 __call（T5RelPlainModel）→ 方法名跳转严格 null', async () => {
    const { resp, locs } = await def("return $this->plain->with('category');", 0, 22);
    assertNone(locs, 'E10 clean 层级');
    return `result=${JSON.stringify(resp.result)}（clean 层级不全局兜底，防污染）`;
  });

  // ---------- E11 P1 接收方完全未知 → 全局兜底 ----------
  await g.it('E11.P1 接收方完全未知（$this->ghost）→ 全局兜底唯一命中 t5RelGlobalProbe', async () => {
    const { resp, locs } = await def('return $this->ghost->t5RelGlobalProbe();', 0, 21);
    const hit = hitIn(locs, queryUri, queryProbeLine);
    if (!hit) throw new Error(`未命中 stub t5RelGlobalProbe：${T.summary(resp.result)}`);
    if (locs.length !== 1) throw new Error(`探针名应全局唯一，实际 ${locs.length} 个：${JSON.stringify(locs.map((l) => l.uri))}`);
    return `Query stub 0基 ${hit.range.start.line}（t5RelGlobalProbe）；结果数=1`;
  });

  // ---------- E12 P1 全局搜不到 → 诚实 null ----------
  await g.it('E12.P1 __call 层级在但全局无 totallyMissing → 诚实 null', async () => {
    const { resp, locs } = await def('return $this->model->totallyMissing();', 0, 21);
    assertNone(locs, 'E12 totallyMissing');
    return `result=${JSON.stringify(resp.result)}（搜不到不编造位置）`;
  });

  // ---------- E13 回归：主通道属性跳转不被 relation 劫持 ----------
  await g.it('E13.回归：$this->model 用法仍走主通道 → docblock @property 标签（非关联跳转）', async () => {
    const usage = at('$this->model', 0, '$this->'.length); // index() 内 return $this->model 行
    const resp = await client.request(
      'textDocument/definition',
      { textDocument: { uri: ctlUri }, position: usage },
      { timeLabel: 'E definition($this->model 用法回归)' }
    );
    const locs = T.asLocations(resp.result);
    if (locs.length === 0) throw new Error(`主通道属性跳转丢失：${T.summary(resp.result)}`);
    const hit = locs.find((l) => l.uri === ctlUri && l.range.start.line === propTagLine);
    if (!hit) throw new Error(`未落在 @property 标签（0基 ${propTagLine}）：${JSON.stringify(locs.map((l) => [l.uri.split('/').pop(), l.range.start.line]))}`);
    const rangeText = T.textInRange(CONTROLLER_TEXT, hit.range);
    return `控制器 docblock @property 标签 @0基 ${hit.range.start.line}，range 文本="${rangeText.slice(0, 40)}"；结果数=${locs.length}`;
  });
};
