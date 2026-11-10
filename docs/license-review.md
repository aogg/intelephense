# intelephense 官方包 LICENSE 审查

- 审查对象：`node_modules/intelephense`（intelephense@1.18.5，npm 源直装）
- 许可文件：`node_modules/intelephense/LICENSE.txt`（65 行，3459 字节），`package.json` 的 `license` 字段为 `"SEE LICENSE IN LICENSE.txt"`
- 审查日期：2026-11-10；结论仅对应 1.18.5，升级版本必须重新审查

## 一、许可性质

这不是开源协议，而是一份**专有最终用户许可协议（EULA）**：

> Copyright (c) 2019 - present Intelephense <ben@intelephense.com>
> By installing this software you agree to be bound by the provisions of this agreement.

无 OSI 认证、无再分发条款、无衍生作品授权。npm 元数据里的 `SEE LICENSE IN LICENSE.txt` 即指本文件。

## 二、关键条款摘要

| 条款 | 内容 | 对本项目的影响 |
| --- | --- | --- |
| §2 GRANT OF LICENCE | 授权是 **personal、non-transferable、non-exclusive**（个人、不可转让、非独占） | 授权主体是「最终用户个人」，不是我们这个二开项目 |
| §3 INTENDED USE | 个人最终用户可将软件**搭配一个 LSP 兼容的 IDE/编辑器**使用，为该用户自己提供 PHP 代码智能 | 这是「使用」授权，**不是再分发授权**；官方包由最终用户自行安装、搭配自己的编辑器使用，最贴近本条意图 |
| §1d Premium Features | 列举 11 项仅持 Licence Key 者可用的功能：rename; code folding; find all implementations; go to type definition; go to declaration; smart select; code actions; code lens; type hierarchy; inlay hints; document links | 与 docs/vip-features.md 清单一一对应；无 key 时官方将这些 provider 注册为 `false`（已用 initialize 探针实测确认） |
| §4 LICENCE KEYS | key 终身有效、限大版本内升级；Personal key 仅限购买者本人，Business key 限本企业员工且分档限人数 | key 归最终用户，我们不得代持、代发、共享 key |
| §5a | **禁止**编辑、修改、改动软件的任何部分 | 官方包必须原样安装、原样运行；我们的代码只能以外挂中间件进程方式协作 |
| §5b | **禁止**反编译、反汇编、逆向工程 | 不反混淆 bundle；不通过观察 bundle 代码反推实现（premium 等价功能一律净室自研） |
| §5c | **禁止**复制、分发、转售软件整体或任何部分（§3 允许范围除外） | 官方包文件不得进入 git 仓库、不得打进发布包 |
| §5d | **禁止**禁用、修改或隐藏软件发出的通知 | 中间件**不得过滤**官方下发的通知消息（如未注册版提示、窗口日志）；转发必须原样透传 |
| §5e/f | 禁止转售 key、禁止超范围分发/共享 key | 同 §4 |
| §5g | **禁止**无有效 key 访问 Premium Features | 不绕过、不伪造、不 patch license 校验；premium 等价能力全部由我们自有代码实现，不走官方 premium 代码路径 |
| §6 OWNERSHIP | 对软件作出的一切修改，其知识产权归 Licensor 所有 | 再次印证「修改官方包」这条路完全不可行 |
| §7/§8 | AS IS、免责声明 | 按原样转发官方能力，不对其行为做任何担保 |

## 三、场景判定

| 场景 | 判定 | 依据 |
| --- | --- | --- |
| git 仓库提交 `node_modules/intelephense` 或其任何文件拷贝 | ❌ 禁止 | §5c：仓库（尤其公开仓库）即分发行为 |
| 发布包（zip / npm 包）内内置官方包文件 | ❌ 禁止 | §5c |
| 修改官方包内文件后运行 | ❌ 禁止 | §5a、§6 |
| 反混淆 / 逆向 bundle 以了解实现 | ❌ 禁止 | §5b |
| 绕过、伪造、patch license 校验以解锁 premium | ❌ 禁止 | §5g |
| 过滤或隐藏官方发出的通知（如免费版提示） | ❌ 禁止 | §5d |
| 在 `package.json` 声明 `intelephense` 为依赖，由**最终用户机器上**的 npm 从官方源拉取后原样运行 | ✅ 允许方向 | 依赖声明不是软件拷贝的分发；每个最终用户自行安装并搭配自己的编辑器使用，符合 §3 意图 |
| 我们的外挂中间件进程与官方进程间做 JSON-RPC 转发/拦截增强 | ✅ 未落入任何明确禁止条款 | 未修改（§5a）、未逆向（§5b）、未分发（§5c）、未屏蔽通知（§5d）、未无 key 访问官方 premium（§5g） |
| premium 等价功能由我们净室自研实现 | ✅ 允许 | §5g 限制的是「访问本软件的 Premium Features」；自研实现不触碰官方 premium 代码路径（前提：不看 bundle 反推） |

**残余风险提示**：EULA 对「进程外中间件包裹转发」没有明文授权，属于未明确禁止的灰色地带。若日后 openidea 规模化分发，建议联系 Licensor 获取书面确认或合作授权；在那之前保持本文件第四节的全部红线。

## 四、打包决策建议（默认结论）

1. **git 仓库只提交自研代码与 `package.json`**（依赖声明、锁文件、文档、脚本），绝不提交官方包的任何文件。
2. **最终发布包不含官方代码**：提供安装脚本（或直接要求最终用户 `npm install` / `npm ci`）在**最终用户环境**拉取 `intelephense@^1.18.5`，用 `package-lock.json` 锁定版本保证行为一致。
3. 除非取得 Licensor 明确的书面再分发授权，**不做任何形式的官方包再分发**。
4. 合规红线（对所有后续开发者生效）：
   - 不反混淆、不逆向官方 bundle；
   - 不绕过、不伪造 license 校验；
   - 不修改官方包的任何文件；
   - 不过滤、不隐藏官方发出的任何通知；
   - 不在仓库或发布物中内置官方包文件。
5. 附注：官方包自身的依赖（`vscode-languageserver`、`fast-glob` 等）各自持有 MIT 等独立开源协议，本审查仅针对 `intelephense` 包本体。
