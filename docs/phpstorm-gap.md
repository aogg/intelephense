# PHPStorm 跳转/导航能力 vs 本二开目标：对比与缺口清单

- 参照系：JetBrains PHPStorm（PhpLand 级 PHP 语言引擎）的导航能力
- 本项目目标：vip 清单（docs/vip-features.md）+ openidea 编辑器日常导航需求（auth 案例）
- 目的：找出 PHPStorm 有、而我们暂未覆盖的能力，给出实现优先级（P0 立即 / P1 次期 / P2 远期 / N/A 非语言服务器职责）

## 一、PHPStorm 能力清单与对照

| # | PHPStorm 能力 | 快捷键（默认） | 语言服务器侧对应 | 官方免费版 | 本二开 | 差距评估 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Go to Class | Ctrl+N | `workspace/symbol`（类过滤） | ✅ | 透传 | 基本对齐；PHPStorm 支持模糊/缩写匹配，客户端搜索框负责 |
| 2 | Go to File | Ctrl+Shift+N | 无标准方法（文件名检索） | ❌ | ❌ 缺口 | 见 G1 |
| 3 | Go to Symbol（函数/变量级） | Ctrl+Shift+Alt+N | `workspace/symbol` | ✅（函数/类/常量） | 透传 | 局部变量级跨文件检索 PHPStorm 也不做，对齐 |
| 4 | Go to Line | Ctrl+G | 纯编辑器功能 | N/A | N/A | 编辑器职责，语言服务器不参与 |
| 5 | Go to Declaration | Ctrl+B | `textDocument/declaration` | ❌ | ✅ 自研已实现（T3） | P0 已闭合；接口/抽象声明双向 + docblock @property 通道 |
| 6 | Go to Declaration/Definition 区分 | Ctrl+B vs Ctrl+Alt+B | `declaration` vs `definition` | definition ✅ / declaration ❌ | ✅ declaration 自研已实现（T3） | P0 已闭合；两跳语义齐备 |
| 7 | Quick Definition（peek 弹层预览） | Ctrl+Shift+I | 无标准方法（编辑器 peek UI + hover/definition 数据） | ✅（数据） | 编辑器侧 | N/A 语言服务器侧；openidea 需实现 peek UI（P1，编辑器任务） |
| 8 | Go to Implementation(s) | Ctrl+Alt+B | `textDocument/implementation` | ❌ | ✅ 自研已实现（T3） | P0 已闭合；类/接口/抽象方法/方法重写四级实现查找 |
| 9 | Go to Type Definition | Ctrl+Shift+B | `textDocument/typeDefinition` | ❌ | ✅ 自研已实现（T3） | P0 已闭合（auth 案例 A/B/C 通道实测） |
| 10 | Find Usages | Alt+F7 | `textDocument/references` | ✅ | 透传 | 基本对齐；PHPStorm 区分读/写 usage，我们用自研索引可补（见 G3） |
| 11 | Highlight Usages in File | Ctrl+Shift+F7 | `textDocument/documentHighlight` | ✅ | 透传 | 对齐 |
| 12 | Type Hierarchy | Ctrl+H | `typeHierarchy/*` | ❌ | ✅ 自研已实现（T3） | 已闭合；上溯含接口与 trait use，子类树下溯 |
| 13 | Method Hierarchy（方法重写树） | Ctrl+Shift+H | 无标准方法（自研查询，常借 typeHierarchy 派生） | ❌ | 🔶 部分闭合（T4 codeLens 重写关系标注） | 数据已有（双向 override 关系）；完整弹层视图仍见 G2 |
| 14 | Call Hierarchy | Ctrl+Alt+H | `textDocument/prepareCallHierarchy` + `incomingCalls/outgoingCalls` | ❌ | 缺口 | 见 G2 |
| 15 | Structure View（文件内符号树） | Ctrl+F12 | `textDocument/documentSymbol`（层次化） | ✅ | 透传 | 对齐；需确认官方返回 hierarchical vs flat 并在客户端渲染树 |
| 16 | Go to Super Method | Ctrl+U | `definition` 沿继承链（部分覆盖） | ✅（可达父类实现） | 透传 + 自研增强 | trait/接口场景官方会漏，自研符号表兜底（见 G4） |
| 17 | Go to Overriding Methods | Ctrl+Alt+鼠标 / 层级弹层 | 无标准方法（自研反向索引） | ❌ | 🔶 codeLens 已覆盖（T4：方法行「被 N 个子类重写 / 重写 父类::方法」） | 跳转弹层仍见 G2 |
| 18 | Rename（Shift+F6） | Shift+F6 | `textDocument/rename` | ❌ | ✅ 自研已实现（T3；T4 增 mixin 通道与嵌入语境实证） | P0 已闭合 |
| 19 | Recent Files / Recent Locations | Ctrl+E / Ctrl+Shift+E | 纯编辑器功能 | N/A | N/A | 编辑器职责 |
| 20 | Next/Previous Occurrence | F3/Shift+F3 | 纯编辑器功能（搜索） | N/A | N/A | 编辑器职责 |
| 21 | 错误/弱警告即导航（F2 下一问题） | F2 | `publishDiagnostics` | ✅ | 透传 + 自研诊断 | 对齐 |
| 22 | Import 优化（Optimize Imports） | Ctrl+Alt+O | codeAction（Source.OrganizeImports / 自研命令） | ❌ | 🔶 quickfix 单个 import 已实现（T3 codeAction）；整文件整理仍 P2（G6） | 部分闭合 |
| 23 | 深度流类型推断（局部变量流敏感推断） | 全程隐式 | 无标准方法，靠引擎 | 部分 | 自研 scoped 推断 | 见 G5 |

## 二、缺口清单与优先级

### P0（MVP 必须，与 vip 清单/需求直接对应）——✅ 全部闭合（T3/T4）
- **P0-1** ✅ `textDocument/declaration`、`typeDefinition`、`implementation`、`rename` 已实现（T3 探针实证；T4 补 codeLens/inlayHint/mixin）。
- **P0-2** ✅ auth 案例链路全通（T2 探针：definition/hover/completion + A/B/C 三通道；45 项探针回归中持续覆盖）。

### P1（次期，提升日常体验）
- **G1 Go to File**：LSP 无标准「按文件名检索」方法。方案：经 `workspace/symbol` 传特殊 query（`file:` 前缀约定）或 `workspace/executeCommand` 自定义命令返回文件列表；最终由 openidea 的文件弹窗消费。数据源用自研文件索引（含 `composer.json` PSR-4 映射）。
- **G2 层级类导航三件套**：`prepareCallHierarchy/incomingCalls/outgoingCalls`（Call Hierarchy）、Method Hierarchy（由自研继承链索引直接派生 override 树）、Go to Overriding Methods 弹层。实现顺序：先 typeHierarchy（标准协议）→ 再从 type hierarchy 索引派生 method/call 层级，避免重复建索引。
- **G3 Find Usages 读写区分**：官方 references 不区分读写；自研索引可按赋值/读取上下文分类，供客户端分组展示（find usages 面板增强）。
- **G4 Go to Super Method 增强**：trait use（含别名 `as`）、接口方法、`parent::` 在 trait 中的语义，官方免费版覆盖不全，由自研符号表在 `definition` 响应上合并（自研优先，官方结果兜底）。
- **G5 scoped 类型推断**：PHPStorm 的流敏感推断不可能一蹴而就；圈定范围——属性 docblock、同类/父类方法内赋值、`new`/静态工厂返回、`@return` 传播、`@mixin`，正好覆盖 auth 案例，先做「字段级」不做「表达式级」。

### P2（远期/按需）
- **G6 Optimize Imports 整文件动作**（`Source` 类 codeAction 批量整理 use 区）。
- **G7 hierarchy-from-here 视图**（以任意类/方法为根的双向层级浏览），依赖 G2 数据，纯客户端呈现问题。
- **G8 PHPStorm 级重构全家桶**（Extract Method/Inline、Change Signature 等）：LSP 无标准方法，需自定义命令 + 客户端配合，优先级最低。

### N/A（明确不做，非语言服务器职责）
- Go to Line、Recent Files/Locations、Next Occurrence、多光标等纯编辑器功能 → openidea 编辑器侧实现。
- 版本控制导航（Go to Change 等）→ 编辑器 + git 集成职责。

## 三、结论

1. P0 已全部闭合（T3/T4）：declaration/typeDefinition/implementation/rename + auth 案例验收 + codeLens/inlayHint/@mixin，共用同一套 php-parser 符号表基础设施。45 项协议探针（npm run probe）全 PASS。
2. PHPStorm 独有的层级导航（G2）数据层已部分落地（typeHierarchy 三方法 + codeLens 双向重写关系标注），剩余为客户端弹层呈现。
3. 编辑器侧（openidea）需要同步排期的三件事：peek/quick definition UI、find usages 分组面板、go-to-file 弹窗——语言服务器侧以标准 LSP + 少量自定义命令配合。
