# intelephense Premium 能力清单与二开实现策略

- 基准版本：官方 intelephense@1.18.5（npm，闭源混淆 bundle，license = SEE LICENSE IN LICENSE.txt）
- 免费版能力依据：`docs/license-review.md` §1d（Premium Features 的 11 项列举）+ 实测探针（对本仓库中间件透传通道发 `initialize`，官方免费模式返回的 serverCapabilities）：
  - 官方注册为 `true`（免费可用）：`textDocumentSync(2)`、`documentSymbol`、`workspaceSymbol`、`completion(+resolve)`、`signatureHelp`、`definition`、`references`、`hover`、`documentHighlight`、`documentFormatting`、`documentRangeFormatting`、`inlineValue`、`workspaceFolders`
  - 官方注册为 `false`（无 key 即关闭）：`rename`、`typeDefinition`、`declaration`、`implementation`、`foldingRange`、`selectionRange`、`codeAction`、`typeHierarchy`
  - 官方根本不注册（快照中缺席）：`codeLens`、`inlayHint`、`documentLink`
- 策略取值：**透传官方**（官方免费已有，中间件直通）/ **自研**（premium 等价功能，由自有 php-parser 语义引擎实现，绝不触碰官方 premium 代码路径）/ **自研增强**（官方已有能力，中间件拦截后合并/补充自有结果）

合规前提见 license-review.md：不逆向、不绕过 license、不改官方文件、不过滤官方通知。所有「自研」项均为独立实现。

## 一、Premium 等价能力清单（自研补齐）

### 1. Rename（跨文件语义改名）

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/rename`、`textDocument/prepareRename` |
| 免费版 | ❌（`renameProvider: false`） |
| 策略 | **自研** |

- 范围：变量/参数/函数/常量/类/接口/trait/枚举/属性/方法/类常量（`textDocument/prepareRename` 先校验可改名与范围）。
- 跨文件：基于自研全局符号表（URI + 索引），收集全部引用处生成 `WorkspaceEdit`（`changes`/`documentChanges` 多文件文本编辑）。
- 类改名附加：可选移动文件（PSR-4：`app/Foo/Bar.php` 内 `Foo\Bar` → `Foo\Baz` 时移动文件路径），并改写全部 `use Foo\Bar;` 导入与 FQN 字面引用（字符串内的 `::class`、docblock 中的 FQN）。
- 嵌入 HTML/JS 中的 PHP 语义改名：见 §2.8。

### 2. Find all implementations

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/implementation` |
| 免费版 | ❌（`implementationProvider: false`） |
| 策略 | **自研** |

- 接口方法/抽象方法 → 全部实现处（类方法声明位置）；接口/抽象类 → 全部子类/实现类；trait → `use` 该 trait 的类。
- 依赖：继承链索引 + trait 展开索引（architecture.md §语义引擎）。

### 3. Go to type definition

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/typeDefinition` |
| 免费版 | ❌（`typeDefinitionProvider: false`） |
| 策略 | **自研** |

- 对「符号引用」解析出其**静态类型**，再跳到类型声明处：`$this->auth` → `Auth` 类所在文件。
- 类型来源优先级：docblock `@var` / 属性声明类型 / 赋值推断（`new X`、`X::instance()` 返回类型）→ 推不出则返回空（不误跳）。

### 4. Go to declaration

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/declaration` |
| 免费版 | ❌（`declarationProvider: false`） |
| 策略 | **自研** |

- 语义：跳到「声明处」而非「定义处」。PHP 中典型场景：接口/抽象方法声明的跳转目标 → `interface` 中的方法签名；属性引用 → 属性声明行。
- 与免费 `definition` 的分工：`definition` 落到最终实现；`declaration` 落到（最先）声明。目标类型同时是接口与实现时，两者结果不同。

### 5. Type hierarchy

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/prepareTypeHierarchy`、`typeHierarchy/supertypes`、`typeHierarchy/subtypes` |
| 免费版 | ❌（`typeHierarchyProvider: false`） |
| 策略 | **自研** |

- prepare 返回光标处类型的 `TypeHierarchyItem`（name/kind/uri/range/selectionRange）。
- supertypes：extends/implements 递归向上（含 trait use）；subtypes：全局反向索引向下。
- 支持接口、枚举（`enum` 的 implements）、匿名类挂靠命名类。

### 6. Code Actions

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/codeAction`、`codeAction/resolve` |
| 免费版 | ❌（`codeActionProvider: false`） |
| 策略 | **自研** |

- **自动 import**：诊断「未定义类型」→ 在 use 区插入 `use FQN;`（尊重别名冲突，自动加 `as`）；支持 `CodeActionKind.QuickFix` + `Source`。
- **批量实现抽象方法**：类声明处 implements/extends 抽象方法未实现 → 一次生成全部方法骨架（含参数默认值、返回类型、`@return`/`@throws` docblock），插入类体并按父类顺序排列。
- **自动生成 PHPDoc**：方法/属性/函数缺少 docblock 时生成，含：
  - `@param`：参数类型（声明类型/默认值推断）；
  - `@return`：返回值类型推断（`return <expr>` 的静态推断，见 architecture.md §类型推断）；
  - `@throws`：方法体内 `throw new XException` 扫描 + 被调用方法 `@throws` 传播合并。
- 所有 codeAction 带 `data`，懒 resolve 生成 WorkspaceEdit。

### 7. Code Lens

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/codeLens`、`codeLens/resolve` |
| 免费版 | ❌（快照中不注册） |
| 策略 | **自研** |

- 类/接口/trait 声明行：引用数（全文引用该符号的文件数/次数）、实现数（implementations）。
- trait 声明行：`use` 该 trait 的类数量。
- 方法声明行：重写（override）关系——「被 N 个子类重写 / 重写了父类 M 的方法」。
- lens 带 `data`（符号 uri+position），resolve 时查自研索引生成 `Command`（跳转到引用列表）。

### 8. Inlay hints

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/inlayHint`、`inlayHint/resolve` |
| 免费版 | ❌（快照中不注册） |
| 策略 | **自研** |

- 参数名 hint：字面量/简单实参前缀 `paramName:`（跳过与形参同名的命名参数）。
- 返回类型 hint：无返回类型声明的方法/闭包声明后缀 `: Type`（由 return 语句推断）。
- 匿名函数/箭头函数类型 hint：赋值目标 `@var` 或变量类型推断补全 `: Closure(...)`。
- 带 `data` 懒 resolve（tooltip 显示推断依据）。

### 9. Code folding

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/foldingRange` |
| 免费版 | ❌（`foldingRangeProvider: false`） |
| 策略 | **自研** |

- 折叠区域：函数/方法体、`use` 导入块、heredoc/nowdoc（`<<<SQL ... SQL;`）、连续注释块（docblock 与行注释段）、`namespace` 块、`switch/case`、`match`。
- 注意：openidea 客户端自身往往也有缩进折叠兜底；本 provider 提供语法级（非缩进级）区域。

### 10. Smart select（语法驱动扩选/缩选）

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/selectionRange` |
| 免费版 | ❌（`selectionRangeProvider: false`） |
| 策略 | **自研** |

- 由 php-parser AST 节点链（变量 → 表达式 → 语句 → 方法 → 类 → namespace → 文件）生成 `SelectionRange[]`，客户端 Alt+Shift+→/← 沿链扩缩。
- 要求返回与请求 `positions[]` 一一对应的数组；含 heredoc 内部位置的语法回退。

### 11. Document links

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/documentLink`、`documentLink/resolve` |
| 免费版 | ❌（快照中不注册） |
| 策略 | **自研** |

- `require`/`require_once`/`include`/`include_once` 的字符串参数 → 解析相对路径/CWD 相对路径，生成 `DocumentLink`（`target` 为 `file://` URI）。
- resolve 懒解析：确保目标文件存在后再填 `target`，不存在则不给 target（避免编辑器打开无效链接）。

### 12. @mixin 支持

| 项 | 值 |
| --- | --- |
| LSP 方法 | 横切能力（影响 `completion`、`hover`、`definition`、`references` 等的响应内容，不是独立方法） |
| 免费版 | ❌ |
| 策略 | **自研** |

- 类 docblock 中 `@mixin TraitOrClass` / `@mixin \NS\Name AliasName` → 把目标符号的方法/属性按别名合并进该类的虚拟符号表。
- 影响面：`$obj->` 补全列表、成员 hover、成员 definition、code lens 计数；`@mixin` 目标自身的 docblock（含 `@method`）递归生效。
- 防环：mixin 链深度限制 + 已访问集合。

### 13. 嵌入 HTML/JS 内的 PHP 语义改名

| 项 | 值 |
| --- | --- |
| LSP 方法 | `textDocument/rename`（同一入口，内容感知） |
| 免费版 | ❌ |
| 策略 | **自研** |

- `.php` 视图文件中 PHP 块（`<?php ... ?>`、`<?= ... ?>`）内变量/符号改名，与纯 PHP 文件同一符号表；HTML/JS 文本段只做原样保留。
- JS 内引用 PHP 输出的场景不跨语言改名（改名范围严格限定 PHP 符号，避免误改字符串）。

## 二、免费版已有能力（透传官方）

以下能力官方免费版已提供，中间件默认**透传**；拦截仅用于镜像文档与诊断合并，不改变官方响应语义。

| 能力 | LSP 方法/通知 | 策略 |
| --- | --- | --- |
| 补全 | `textDocument/completion` + `completionItem/resolve` | 透传；后续可「自研增强」合并 @property/@mixin 成员（见 §三） |
| Hover | `textDocument/hover` | 透传；auth 案例 hover 类型依赖自研推断时由中间件增强（§三.3） |
| Go to definition | `textDocument/definition` | 透传；`$this->auth` 场景官方推不出时由自研 definition 兜底（§三.3） |
| 签名帮助 | `textDocument/signatureHelp` | 透传 |
| 查找引用 | `textDocument/references` | 透传；code lens 与 rename 复用自研索引 |
| 文档符号 / 工作区符号 | `textDocument/documentSymbol`、`workspace/symbol` | 透传 |
| 诊断 | `textDocument/publishDiagnostics`（通知） | 透传 + 与自研诊断按 `source` 合并（不隐藏官方任何消息，合规 §5d） |
| 格式化 | `textDocument/formatting`、`textDocument/rangeFormatting` | 透传 |
| 高亮 | `textDocument/documentHighlight` | 透传 |
| 增量同步 | `textDocumentSync: 2`、`didOpen/didChange/didClose` | 透传 + 中间件维护文档镜像（自研引擎增量重析） |

## 三、透传与自研的边界（中间件拦截点）

1. **能力声明**：`initialize` 响应拦截，合并 serverCapabilities——官方 `true` 且无自研对应 → 透传；官方 `false`/缺席且自研已实现 → 由自研声明；官方因用户持有效 licenceKey 而为 `true` 的 premium 项 → 默认仍自研优先（行为一致性），保留 `premiumPassthrough` 配置项交还官方（尊重用户已购授权）。
2. **请求路由**：自研声明的方法 → 自研引擎处理（不经官方）；透传方法 → 官方；`completion` 等合并型 → 双引擎结果合并去重（自研优先）。
3. **auth 案例（透传兜底 + 自研增强）**：`$this->auth` 在官方免费版下 definition/hover/completion 大概率失效（属性无原生类型、赋值在父类 `_initialize()` 内）；中间件用自研符号表（docblock `@var Auth` + 赋值推断双通道）补出 definition/hover/completion，详见 architecture.md §auth 案例。
4. **通知流**：官方 `publishDiagnostics` 原样透传；自研诊断以独立 `source`（`intelephense-openidea`）另行下发；两者按 URI 合并去重，绝不抑制官方通知。
