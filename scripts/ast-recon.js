/* AST 调研脚本：一次性验证 5 个要点（错误容忍、include、docblock、trait adaptation、非 ASCII 列位） */
const engine = require('php-parser');
const p = engine.create({ parser: { extractDoc: true, suppressErrors: true, version: 704 }, debug: false });

// 1) 错误容忍：半截代码
const bad = `<?php
namespace app\\common\\controller;
class Backend extends Controller {
  use \\app\\common\\traits\\FooTrait;
  /** 权限控制类
   * @var Auth
   */
  protected $auth = null;
  public function _initialize()
  {
    $this->auth = Auth::instance();
    if (true) { // 半截：括号未闭合
`;
const ast = p.parseCode(bad, 'Backend.php');
console.log('1) suppressErrors=true 不抛异常；顶层 children kinds:', ast.children.map(c => c.kind).join(','));
const ns = ast.children.find(c => c.kind === 'namespace');
const cls = ns.children.find(c => c.kind === 'class');
console.log('   class.body kinds:', cls.body.map(b => b.kind).join(','));
console.log('   use(traituse) node:', JSON.stringify(cls.body.find(b => b.kind === 'traituse'), (k, v) => k === 'loc' ? undefined : v).slice(0, 400));
const prop = cls.body.find(b => b.kind === 'propertystatement');
console.log('   doc(docblock) on propertystatement:', JSON.stringify(prop && prop.doc, (k, v) => k === 'loc' ? undefined : v));
console.log('   method _initialize body kinds:', cls.body.find(b => b.kind === 'method').body.children.map(c => c.kind).join(','));

// 2) include/require
const inc = p.parseCode(`<?php require_once __DIR__ . '/../foo/bar.php'; include "tpl/a.html"; require APP_PATH.'x.php';`, 'i.php');
console.log('2) include/require node:', JSON.stringify(inc.children, (k, v) => k === 'loc' ? { start: v.start, end: v.end } : v).slice(0, 1400));

// 4) trait adaptation
const tr = p.parseCode(`<?php class A { use T1, T2 { T1::m insteadof T2; T2::m as protected m2; } }`, 't.php');
console.log('4) traituse:', JSON.stringify(tr.children[0].body[0], (k, v) => k === 'loc' ? undefined : v).slice(0, 1200));

// 5) 非 ASCII 列位
const cn = `<?php
// 中文注释abc
/** 商品管理
 */
$x = '中文值';
class 量子 { public function 跳转() {} }
`;
const cnAst = p.parseCode(cn, 'cn.php');
const walk = (n, d) => {
  if (!n || typeof n !== 'object' || !n.kind || !n.loc) return;
  console.log('  '.repeat(d) + n.kind + ` L${n.loc.start.line}:${n.loc.start.column}..${n.loc.end.line}:${n.loc.end.column} off ${n.loc.start.offset}..${n.loc.end.offset} name=${n.name || ''}`);
  for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'doc' && k !== 'comments') walk(n[k], d + 1);
};
walk(cnAst, 0);
const idx = cn.indexOf("'中文值'");
console.log('JS string index of 中文字符串 =', idx, '| utf8 bytes before =', Buffer.byteLength(cn.slice(0, idx), 'utf8'));
const x = cnAst.children.find(c => c.kind === 'expressionstatement');
console.log('expressionstatement loc:', JSON.stringify(x.loc));
