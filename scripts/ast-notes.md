# php-parser 3.7.0 AST 调研笔记（T2 接手，验证够用即止）

调研脚本：`scripts/ast-recon.js`（可重跑）。时间：2026-11-10。

## 1. 引擎创建与错误容忍（关键坑）
```js
const p = require('php-parser').create({
  ast:    { withPositions: true },          // ← loc 挂载在这里，parser:{positions:true} 无效
  parser: { extractDoc: true, suppressErrors: true, version: 704 },  // ← 必须嵌套在 parser 子对象，顶层传不进去
  debug: false,
});
const ast = p.parseCode(src, 'file.php');
```
- `suppressErrors` 正确传入时**永不抛异常**；语法错误落在 `ast.errors[]`（`{kind:'error', message, line, loc}`），AST 照常产出已解析部分（半截 class/propertystatement/method 均能出节点）。

## 2. 位置（loc）形状与非 ASCII
- `node.loc = { source, start:{line,column,offset}, end:{...} }`；line **1 基**，column/offset 为 **JS 字符串索引 = UTF-16 code unit**（已用 `'中文值'` 实测 offset=JS idx 差 0）。
- → LSP 换算：`line = loc.line - 1`，`character = loc.column`。中文注释/中文标识符不偏移。
- comment 节点同样带完整 loc（`ast.comments[]` 全量列表）。

## 3. docblock 获取
- 3.7.0 **没有 `node.doc`**；`extractDoc:true` 的产物是语句节点上的 **`node.leadingComments[]`**（class / propertystatement / method / usegroup 等语句级节点都有），元素为 `{kind:'commentblock'|'commentline', value, loc}`。
- docblock = leadingComments 里 `kind==='commentblock'` 且 value 以 `/**` 开头的项。

## 4. include / require
- `kind:'include'`，字段 `{once:bool, require:bool, target}`；`require_once` → `{require:true,once:true}`。
- target：字面量为 `kind:'string'`（`value` 去引号内容）；拼接为 `kind:'bin', type:'.'`；`__DIR__` 是 `kind:'magic', value:'__DIR__'`；常量为 `kind:'name'`。

## 5. trait use adaptation
- `kind:'traituse'`：`traits[]`（name 节点，`resolution` 为 fqn/uqn），`adaptations`：
  - `traitprecedence`：`{trait, method:{kind:'identifier',name}, instead:[name]}`（insteadof）
  - `traitalias`：`{trait, method, as:{identifier}, visibility}`（as 新名/可见性，字段可缺省）
  - 无 `{}` 块时 `adaptations === null`。

## 6. 其他确认到的形状（实现直接引用）
- namespace 声明后子节点嵌套在 `namespace.children`；`use A\B as C;` 解析为 `usegroup`（`name`/`type` 顶层 + `items[]`），group use `use A\{B,C as D};` 也是 usegroup.items。
- `propertystatement`：`{visibility, isStatic, properties:[{kind:'property', name:{identifier}, value, type, nullable}]}`；属性原生类型在 `property.type`。
- `$this->xxx` = `propertylookup`：`what` = `variable(name:this)`，`offset` = `identifier(name)`；`Auth::instance()` = `staticlookup`（what=name, offset=identifier）。
- class 节点：`extends/implements/body`，body 含 `traituse/propertystatement/method/classconstant`；方法参数 `argument_list`、返回 `return`。

## 结论
调研到此为止（5 点齐），不再探索，进入实现。
