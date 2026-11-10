# intelephense-openidea 中间件架构设计

- 定位：给 openidea 编辑器（`languages/php.toml`：`command = "intelephense"`、`args = ["--stdio"]`、`root-markers = ["composer.json", ".phpactor.json", "index.php"]`、`resync-on-configuration = true`）提供 PHP 语言服务的二开发行版。
- 架构定调（不可动摇）：
  1. 官方 `intelephense` npm 包**原样依赖、原样运行**，提供免费版能力；
  2. 自研 TypeScript 代码作为 **LSP 中间件**（stdio 入口），转发请求、拦截/合并响应与 serverCapabilities；
  3. premium 等价功能**全部自研**；不反混淆、不逆向、不绕过/伪造 license、不修改官方包文件、不过滤官方通知（见 docs/license-review.md）。
- 已验证事实（本仓库实测）：
  - `npm install` 后 `node_modules/intelephense/lib/intelephense.js`（8.7MB bundle，1.18.5）可执行；
  - `node dist/cli.js --stdio` 透传通道下，官方对 `initialize` 正常返回 capabilities 并输出 `window/logMessage: "Initialising intelephense 1.18.5"`；
  - 官方免费模式 capabilities 快照：`rename/typeDefinition/declaration/implementation/foldingRange/selectionRange/codeAction/typeHierarchy` 为 `false`，`codeLens/inlayHint/documentLink` 不注册；`completion/signatureHelp/definition/references/hover/documentSymbol/workspaceSymbol/documentHighlight/formatting/inlineValue` 为 `true`。

## 一、进程模型

```
openidea (php.toml: intelephense --stdio)
   │  stdin/stdout (JSON-RPC over stdio)
   ▼
┌────────────────────────────┐
│  dist/cli.js  ← bin "intelephense"   （自研中间件，本包入口）
│  ┌──────────────────────┐  │    ┌──────────────────────────────┐
│  │ Framer  帧解析/序列化 │  │    │ 官方 intelephense 子进程       │
│  │ Router  消息路由       │──┼───▶│ node node_modules/intelephense│
│  │ Caps    能力合并       │  │    │ /lib/intelephense.js --stdio │
│  │ Engine  自研语义引擎   │  │    │ （原样运行，零修改零补丁）      │
│  └──────────────────────┘  │    └──────────────────────────────┘
└────────────────────────────┘
```

1. **stdio 入口**：`bin.intelephense = dist/cli.js`。openidea 拉起的是中间件进程（满足 php.toml 的 `command = "intelephense"`），`--stdio` 参数透传给官方服务。
2. **拉起官方服务**：中间件 `spawn(process.execPath, [require.resolve('intelephense/lib/intelephense.js'), '--stdio'])`。解析顺序：先 `require.resolve`（保证与 lockfile 锁定的安装一致），兜底 `node_modules` 相对路径。官方包文件零修改。
3. **双向消息路由**：中间件同时解析两侧的 `Content-Length` 帧：
   - `client → official`（请求/通知）：默认转发；命中自研路由表的方法（§三）截留在中间件；
   - `official → client`（响应/通知）：默认转发；`initialize` 响应进能力合并器（§二）；`publishDiagnostics` 等通知原样透传（**绝不过滤**，合规 §5d），自研诊断另行以独立 `source` 下发；
   - 需要官方数据又需自研数据的方法（completion 等）：中间件同时向官方转发并向引擎查询，`Promise.all` 合并去重后应答。
4. **文档镜像（fan-out）**：`textDocument/didOpen|didChange|didClose` 转发官方的同时，镜像全量内容（didChange 含增量时按 `range` 应用补丁）到自研引擎的文档缓存，驱动增量重析。
5. **生命周期**：`initialize/initialized/shutdown/exit` 原样透传；中间件退出时向官方子进程转发 SIGTERM，等待 `exit` 后结束，避免僵尸进程。
6. **configuration**：php.toml 的 `resync-on-configuration = true` 意味着客户端会重发 `workspace/didChangeConfiguration`；中间件透传官方，并自留一份（控制自研开关，如 `premiumPassthrough`、折叠/注解偏好）。

## 二、能力合并策略（initialize 拦截）

`initialize` 响应的 `result.capabilities` 按以下规则合并（自研能力优先）：

| 官方声明 | 自研是否实现 | 合并结果 |
| --- | --- | --- |
| `true`（免费能力） | 无对应 | 透传官方值 |
| `true` 且属自研覆盖域（用户持有效 licenceKey 时官方会开启 premium） | 已实现 | **自研优先**（请求路由给引擎，保证有无 key 行为一致）；`premiumPassthrough` 配置打开时改透传官方，尊重用户已购授权 |
| `false` 或不注册 | 已实现 | 覆盖为自研 provider（rename、typeDefinition、declaration、implementation、foldingRange、selectionRange、codeAction、typeHierarchy、codeLens、inlayHint、documentLink） |
| `false` 或不注册 | 未实现 | 保持 `false`/不注册（诚实降级，不虚假声明） |
| 官方独有 | — | 透传 |

- 合并后附带 `serverInfo` 补充：`{ name: "intelephense-openidea", version }`（官方不返回 serverInfo，快照已验证），便于客户端与日志识别中间件层。
- `capabilities.positionEncoding` 等编码协商以客户端 `initialize` 请求为准，合并器不越权改写。
- `scripts.probe`（能力探针，预留）：对官方裸进程与本中间件各发一次 `initialize`，diff 两份 capabilities 快照，输出「自研新增/官方缺失」对照表，用于回归验证。

## 三、消息路由表

| 方法 | 方向 | 处理 |
| --- | --- | --- |
| `textDocument/rename` `prepareRename` | → | 自研引擎 |
| `textDocument/typeDefinition` `declaration` `implementation` | → | 自研引擎 |
| `textDocument/prepareTypeHierarchy` `supertypes` `subtypes` | → | 自研引擎 |
| `textDocument/codeAction` `codeAction/resolve` | → | 自研引擎 |
| `textDocument/codeLens` `codeLens/resolve` | → | 自研引擎 |
| `textDocument/inlayHint` `inlayHint/resolve` | → | 自研引擎 |
| `textDocument/foldingRange` `selectionRange` | → | 自研引擎 |
| `textDocument/documentLink` `documentLink/resolve` | → | 自研引擎 |
| `textDocument/completion` `completionItem/resolve` | ⇄ | 官方 + 自研合并（@property/@mixin 成员补充），自研优先去重 |
| `textDocument/hover` `definition` | ⇄ | 官方优先；官方为空且自研可解时用自研结果兜底（auth 案例关键路径） |
| `textDocument/references` `signatureHelp` `documentSymbol` `workspace/symbol` `documentHighlight` `formatting` | → | 透传官方 |
| `textDocument/didOpen/didChange/didClose/didSave` | → | 转发官方 + 引擎文档镜像 |
| `workspace/didChangeConfiguration` `didChangeWatchedFiles` | → | 转发官方 + 引擎缓存失效 |
| `publishDiagnostics`（通知） | ← | 官方原样透传；自研诊断独立下发，URI 内合并去重（source 标记区分） |
| 其余 | ⇄ | 默认透传 |

## 四、自研语义引擎设计

### 4.1 解析器选型：php-parser（纯 JS）

- 选 **php-parser**（JS 移植版 nikic/PHP-Parser，MIT 协议，纯 JavaScript，无 PHP binary 依赖）：intelephense 自身同样是纯 JS 方案，不引入 php 可执行文件与本环境约束一致。
- 容错解析（error-tolerant）：编辑中态的半截代码也能出 AST；每个文件持有「AST + 错误列表」，didChange 增量重析。
- 自研层只依赖其节点结构（`namespace/use/class/interface/trait/enum/propertystatement/method/assign/closure` 等），不依赖任何官方 intelephense 内部符号——满足净室要求。

### 4.2 符号表（Symbol Table）

- 每文件产出：`defines[]`（namespace 下类/接口/trait/枚举/函数/常量）与 `references[]`（符号引用 + 上下文作用域）。
- 符号记录：`fqn、kind、name、uri、range/selectionRange、members{properties,methods,constants}、docblock、modifiers`。
- 全局索引：`fqn → 符号`、`uri → 符号`、`fqn → 子类[]`（继承反向索引）、`trait → 使用者[]`、`symbol → 引用位置[]`。跨文件 rename/implementation/typeHierarchy 全部由这张索引支撑。
- 失效策略：didChange 单文件增量；didChangeWatchedFiles / composer.json 变更时按 PSR-4 目录批量失效重建。

### 4.3 docblock 解析

自研轻量 docblock 解析器（正则 + 缩进对齐，不引入第三方依赖），抽取：

| 标签 | 用途 |
| --- | --- |
| `@property <Type> $name` / `@property-read` / `@property-write` | 类 docblock 中的**虚拟属性**，并入成员表（本阶段重点，见 auth 案例 B 通道） |
| `@var <Type>` | 属性/变量 docblock 类型声明（auth 案例 A 通道） |
| `@mixin <Type> [alias]` | mixin 合并（vip §12），`@method` 标签同批解析 |
| `@param/@return/@throws/@template` | codeAction 生成与 inlay hint 的输入 |
| `@see/@inheritDoc` | hover 富文本补充 |

类型字符串解析为 `TypeRef`：FQN、`use` 别名、`$this`、联合类型（`A|B|null`）、泛型形如 `Collection<Product>`（P1 再展开元素类型）。

### 4.4 use 别名解析

- 文件级 `use A\B;` `use A\B as C;` `use function/use const` 映射表：`别名 → FQN`。
- 所有引用先查本文件别名表，再落 namespace 兜底（当前 namespace + 类名）；docblock 内类型同样走此表。
- rename 改类名时，别名表直接决定 `use` 行是否需要改写（vip §1）。

### 4.5 继承链与 trait 展开

- `extends/implements` 递归展开（接口含父接口、枚举含 interface）；防环 + 深度上限。
- trait 展开：`use T1, T2 { T1::m as protected m2; T2::m insteadof T1; }` 的别名/排除语义按 PHP 运行时规则模拟；展开结果合并进类的有效成员表，每个成员标记 `origin: class|parent|trait:<name>|mixin|docblock`。
- 有效成员表是 `$this->xxx` 补全/跳转/hover 的唯一数据源。

### 4.6 属性类型推断（父类方法内赋值）

对属性 `P`（可能在任意祖先类声明）推断类型，按优先级合成联合类型：

1. **原生声明**：`protected Auth $auth`（PHP 7.4+ typed property）；
2. **属性 docblock**：声明上方的 `/** @var Type */`；
3. **赋值推断**：扫描全类体（含 trait、父类链）中 `$this->P = <expr>`：
   - `new X` → `X`（经别名表）；
   - `X::instance()` / 静态工厂 → 被调方法 `@return` 或返回类型声明；`return new X` 直接落类；
   - 字面量 → 标量类型；
   - 多处赋值 → 联合类型；`null` 初始化（`protected $auth = null;`）并入 `|null`；
4. **类 docblock `@property`**：虚拟属性通道（4.3）；
5. 推不出 → `unknown`：**不虚构类型、不误报**，相关特性诚实降级。

### 4.7 `$this->xxx` 解析

- 定位光标所在类作用域（含匿名类、闭包 `$this` 绑定）→ 取该类**有效成员表**（4.5 合并结果）→ 命中成员即得符号与类型。
- 查找顺序：本类声明 → trait 展开 → `@mixin` 合并 → 类 docblock `@property` → 父类链逐级向上（每级父类同样先跑 4.6 推断）。
- 产物直接供给：`definition`（跳声明）、`hover`（类型 + docblock）、`completion`（成员列表）、`typeDefinition`（跳类型）。

## 五、auth 案例设计（本阶段只设计，不实现）

**目标项目**：`/code/www/gs/zuodian-worktree/zuodian--temp/`（ThinkPHP/FastAdmin）。已核对的真实代码位置：

- `application/admin/controller/product/Product.php:54`：`'add' => $this->auth->check('product/product/add'),`
- `application/common/controller/Backend.php:45`：`protected $auth = null;` —— **无 PHP 原生类型**；属性上方 docblock 为 `/** 权限控制类 · @var Auth */`（后文 A 通道要用），类 docblock `后台控制器基类` 存在但**无** `@property`（B 通道的兜底口径）
- `application/common/controller/Backend.php:138`：`_initialize()` 内 `$this->auth = Auth::instance();`
- `application/admin/library/Auth.php:195`：`public function check($name, $uid = '', $relation = 'or', $mode = 'url')`
- `Backend.php` 头部 `use app\admin\library\Auth;`（别名解析入口）

**验收标准**（全部满足才算通过）：
1. Product.php:54 的 `$this->auth` 上 **definition** → 跳到 Backend.php:45；再在 Auth::instance() / 类型上走一跳 → `Auth` 类（`app\admin\library\Auth.php`）；
2. **hover** 显示 `Auth` 类型（含 docblock「权限控制类」）；
3. `$this->` **补全**包含 `auth`；
4. `auth->` **补全**包含 `check`（签名 $name/$uid/$relation/$mode）。

**中间件管线设计**：

```
didOpen Product.php ─▶ 引擎解析 ─▶ 引用 $this->auth ─▶
  ① 解析 Product 的继承链: Product → Backend → think\Controller
  ② 沿链找属性 auth: 命中 Backend.php:45 声明
  ③ 类型判定（双通道，命中即用，联合合并）:
     A. 属性 docblock @var Auth ──use 表──▶ app\admin\library\Auth   ← 本案例主通道
     B. 类 docblock @property（若存在）──▶ 同样解析                    ← 父类只有类注释、
                                                                        无 @var 时的通道
     C. 赋值推断兜底: Backend.php:138 $this->auth = Auth::instance()
        ──▶ Auth::instance() 的 @return/返回类型 ──▶ Auth            ← docblock 全缺失时的通道
  ④ 以 Auth 为类型产出四件套:
     definition=Backend.php:45(属性声明) / hover=Auth+docblock /
     completion( $this-> → auth; auth-> → check() ) /
     typeDefinition=Auth.php 类声明
  ⑤ 官方免费版此链路大概率断链（无原生类型+赋值在父类）:
     hover/definition 用「官方优先、自研兜底」合并规则补全（§三路由表）
```

- **通道 B 细节**（任务指定的「父类有类注释」场景）：类 docblock 解析出的每个 `@property[-read|-write] Type $name` 以 `origin: docblock` 并入有效成员表，参与上述①–④全程；`-read/-write` 记录读写性，供将来 usage 分组。
- **通道 C 细节**：`Auth::instance()` 无 `@return` 时，解析 `Auth` 类内 `instance()` 方法体 `return new self/static` → 落 `Auth`；再不行（如闭包动态返回）→ `unknown`，诚实降级。
- **诊断克制原则**：本管线只做「补能力」，不因推断失败发「无法解析属性」类噪声诊断——ThinkPHP 魔法注入（`$this->view`、`$this->model` 等）同类场景一并受益，不引入新噪音。

## 六、目录结构规划

```
intelephense-openidea/
├─ package.json          bin.intelephense → dist/cli.js；deps: intelephense ^1.18.5
├─ tsconfig.json
├─ src/
│  ├─ cli.ts             入口：spawn 官方 + 接线（已落地 MVP 透传）
│  ├─ framer.ts          Content-Length 帧解析/序列化（流式、分包安全）
│  ├─ router.ts          §三路由表 + 文档镜像 fan-out + 生命周期
│  ├─ caps.ts            §二能力合并 + serverInfo 补充
│  ├─ merge.ts           completion/hover/definition 合并去重
│  ├─ engine/
│  │  ├─ ast.ts          php-parser 封装 + 增量重析 + 文档缓存
│  │  ├─ docblock.ts     4.3 docblock 解析器
│  │  ├─ symbols.ts      4.2 符号表 + 全局索引 + PSR-4 失效
│  │  ├─ resolver.ts     4.4 use 别名 / 4.5 继承链与 trait 展开
│  │  ├─ infer.ts        4.6 属性类型推断（赋值/工厂/@var/@property）
│  │  └─ member.ts       4.7 有效成员表 + $this-> 解析
│  ├─ features/          rename / hierarchy / codeAction / codeLens /
│  │                     inlayHint / folding / selectionRange / documentLink
│  ├─ diagnostics.ts     自研诊断下发（独立 source，合并去重）
│  └─ probe.ts           scripts.probe 能力探针（官方 vs 中间件 caps diff）
├─ docs/                 license-review / vip-features / phpstorm-gap / architecture
└─ .gitignore            node_modules / dist / *.tsbuildinfo（官方包文件永不入库）
```

## 七、风险与边界

| 风险 | 对策 |
| --- | --- |
| 帧解析分包/粘包错误 | framer 以字节缓冲按 `Content-Length` 严格切帧（冒烟阶段已修复过一次偏移错误，沉淀为单测用例） |
| 官方诊断与自研诊断重复/冲突 | 自研仅补官方空白域（premium 功能域），诊断默认少量、克制，source 可过滤 |
| 大仓库性能 | AST/symbol 按文件缓存 + 增量失效；索引构建放 worker/空闲队列；先正确后性能 |
| 用户持 licenceKey 时行为分歧 | 默认自研优先保持一致性；`premiumPassthrough` 配置项交还官方 premium（合规且尊重授权），探针脚本负责回归对比 |
| 官方包版本升级 | 锁 lockfile；升级后重跑 license 审查（条款随版本可能变化）与能力探针 |
| 误报噪声毁掉口碑 | 所有推断失败一律 unknown + 静默降级，绝不虚构跳转与诊断 |
