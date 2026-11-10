# intelephense-openidea

**intelephense 官方免费包 + 自研增强中间件**，为 openidea 编辑器的 `languages/php.toml`（`command = "intelephense"`）提供 premium 等价能力。

## 一、项目定位

- **官方包原样运行**：`intelephense` npm 包作为普通依赖安装（免费档能力：补全 / hover / definition / references / 诊断 / 格式化等），零修改、零补丁、零逆向。
- **自研 LSP 中间件**：本包入口（`dist/cli.js`）以 stdio 拉起官方服务，双向转发消息；对官方免费版关闭/缺席的能力（rename、typeHierarchy、codeLens、inlayHint 等十一项），由自有 TypeScript 语义引擎（php-parser 净室实现）**独立重实现**并在 `initialize` 时合并声明。
- **行为一致性**：无论用户是否持有官方 licence key，中间件声明的能力保持一致；官方 premium 项不触碰、不伪造、不绕过。

## 二、安装与构建

要求 Node.js ≥ 18。

```bash
npm install      # 官方 intelephense 依赖由用户环境 npm 正常拉取，版本由 package-lock.json 锁定
npm run build    # tsc 双 tsconfig 构建 → dist/（中间件 + 探针）
```

拉起方式（三种等价，均走 stdio）：

```bash
node dist/cli.js --stdio          # 显式 stdio（php.toml args 透传形态）
node dist/cli.js                  # 无参数 = 默认 stdio
intelephense --stdio              # bin 脚本形态（npm i -g / npm link 后，package.json bin.intelephense → dist/cli.js）
```

> 注意：本仓库 `node_modules/.bin/intelephense` 是**官方依赖自身的 bin**；本包的 `bin.intelephense` 在全局安装（`npm i -g .` / `npm link`）后才出现在 PATH 上，openidea 的 `command = "intelephense"` 解析到的是它。

### License 合规红线（简述）

官方 intelephense 是专有 EULA（非开源），详见 [docs/license-review.md](docs/license-review.md)。本项目遵守的硬约束：

1. 不修改、不逆向、不反混淆官方包任何文件（官方包不入库、不进发布物）；
2. 不绕过、不伪造、不 patch license 校验；premium 等价能力全部为自有代码净室实现；
3. 不过滤、不修改官方下发的任何通知（含未注册提示）；
4. 官方包由最终用户按其 EULA 自行安装使用；版本升级须重新做许可审查与能力探针回归。

## 三、功能矩阵

状态取值：**自研已实现**（本中间件独立实现，官方免费档不可用）/ **官方免费透传**（官方免费档已有，中间件直通）/ **自研增强**（官方结果 + 自研结果合并）/ **未实现·诚实降级**（保持官方缺席声明，不虚假注册）。

| 能力 | LSP 方法 | 状态 |
| --- | --- | --- |
| 增量同步 + 文档镜像 | `textDocumentSync`、didOpen/didChange/didClose | 官方免费透传 + 中间件镜像 |
| 补全（@property/@mixin 成员并入） | `textDocument/completion` + `completionItem/resolve` | 自研增强（官方+自研合并去重） |
| Hover（类型/docblock 推断兜底） | `textDocument/hover` | 自研增强 |
| Go to Definition（含 auth 链路兜底） | `textDocument/definition` | 自研增强 |
| 签名帮助 / 查找引用 / 文档符号 / 工作区符号 / 高亮 / 格式化 / 诊断 | signatureHelp、references、documentSymbol、workspace/symbol、documentHighlight、formatting(+range)、publishDiagnostics | 官方免费透传 |
| 语义 Rename（跨文件 + PSR-4 文件迁移 + docblock/字符串 FQN + mixin 通道） | `textDocument/rename`、`prepareRename` | 自研已实现 |
| Find all implementations | `textDocument/implementation` | 自研已实现 |
| Go to Type Definition | `textDocument/typeDefinition` | 自研已实现 |
| Go to Declaration | `textDocument/declaration` | 自研已实现 |
| Type Hierarchy（supertypes/subtypes） | `prepareTypeHierarchy`、`typeHierarchy/supertypes|subtypes` | 自研已实现 |
| Code Actions（自动 import / 批量实现抽象方法 / 生成 PHPDoc） | `textDocument/codeAction`、`codeAction/resolve` | 自研已实现 |
| Code Lens（引用数/子类数/实现数/重写关系/trait 使用数/docblock @property 引用数，resolve 惰性） | `textDocument/codeLens`、`codeLens/resolve` | 自研已实现 |
| Inlay Hints（形参名/返回类型/闭包签名，resolve 惰性，单文档 500 上限） | `textDocument/inlayHint`、`inlayHint/resolve` | 自研已实现 |
| Code Folding | `textDocument/foldingRange` | 自研已实现 |
| Smart Select | `textDocument/selectionRange` | 自研已实现 |
| Document Links（include/require 路径） | `textDocument/documentLink` | 自研已实现 |
| @mixin 合并（横切：completion/definition/hover/rename/codeLens） | 非独立方法 | 自研已实现 |
| Call Hierarchy / Method Hierarchy 弹层 / Go to File / Organize Imports 整理 | — | 未实现·诚实降级（见 docs/phpstorm-gap.md P1/P2） |
| 嵌入 HTML/JS 内非 PHP 文本改名 | — | 明确不做（limitation，见下） |

详细策略表与每项实现口径见 [docs/vip-features.md](docs/vip-features.md)，能力合并规则见 [docs/architecture.md](docs/architecture.md)。

## 四、openidea 接入

`languages/php.toml`（无需改动，即装即用）：

```toml
[language.php]
command = "intelephense"
args = ["--stdio"]
root-markers = ["composer.json", ".phpactor.json", "index.php"]
resync-on-configuration = true
# fallback 到 phpactor 的层保持原有配置即可；本中间件与其无冲突
```

- 中间件读取 `initialize` 的 rootUri/workspaceFolders 定位工作区根，按 composer.json psr-4 + 目录扫描建符号索引。
- `resync-on-configuration = true` 触发的 `workspace/didChangeConfiguration`（含 `intelephense` 环境段）原样转发官方，中间件自留一份供后续开关使用。
- laravel-lsp 层要求 intelephense 保留的 hover/rename/symbols 能力：hover/rename 由本中间件自研提供，symbols 官方透传，均满足。

## 五、验证

```bash
npm run build && npm run probe
```

协议级探针（`scripts/probe.ts`，45 项，非浏览器 e2e）：对中间件 stdio 通道发真实 LSP 请求，覆盖 auth 案例链路、
rename 跨文件与 PSR-4 迁移、typeHierarchy 三方法、codeAction 三类、codeLens 计数、inlayHint 三类、@mixin 合并、
嵌入语境改名、didChangeConfiguration 转发等；全部 PASS 输出逐项证据，exit 0。

## 六、已知限制

- 嵌入 HTML/JS 的 PHP 语义只覆盖 php-parser 解析出的表达式节点（双引号字符串插值、heredoc 插值、`<?= ?>` 内联块）；纯 HTML/JS 文本内的引用不做跨语言改名。
- docblock `@mixin` 的别名参数（alias）不改变合并行为，统一按目标类型全量合并。
- codeLens 的 `showReferences` 命令需要客户端实现；未实现时 lens 仅显示计数标题。
- inlayHint 返回类型推不出时（纯表达式串联等）诚实留空，不虚构类型。
