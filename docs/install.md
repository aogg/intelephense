# intelephense-openidea 安装指南（macOS / Windows）

- 目标：装好 OpenIDEA 桌面版 + Node.js + 本中间件，并把 `languages/php.toml` 放进 IDE 配置目录，使 `command = "intelephense"` 解析到中间件。
- 平台覆盖：macOS（Apple Silicon / Intel）、Windows（x64 / ARM64）。
- 步骤均为本仓库实测路径；标注「官方文档行为」的条目为 openidea 官方文档描述的通用机制说明。
- 本中间件拉起的是官方 intelephense npm 包（纯 JS），全程无需系统 PHP。

## 一、组件关系与接入原理

- **OpenIDEA**（github.com/l0ng-ai/openidea）：Rust 内核桌面 IDE。
- **intelephense-openidea**（本仓库）：stdio LSP 中间件——拉起官方 intelephense npm 包原样运行、双向转发，并对官方免费版缺席的 rename / typeHierarchy / codeLens / inlayHint 等 11+ 能力自研补齐（实现见 [docs/architecture.md](architecture.md)）。
- **接入方式**两步：
  1. 把本仓库伪装成 PATH 上的 `intelephense` 命令（macOS 软链 / Windows cmd shim）；
  2. 放一份上游 `languages/php.toml` 原文到 IDE 配置目录。同 id 的语言定义整体替换内置定义，且 **IDE 启动时只读取一次**（官方文档行为）。
- php.toml 的 `command = "intelephense"` 命中的就是中间件；`install-hint` 只是找不到命令时的提示文案，**不会执行**。

## 二、下载清单

| 用途 | macOS (Apple Silicon) | macOS (Intel) | Windows x64 | Windows ARM64 |
| --- | --- | --- | --- | --- |
| 桌面主程序 | `OpenIDEA_<版本>_aarch64.dmg` | `OpenIDEA_<版本>_x64.dmg` | `OpenIDEA_<版本>_x64-setup.exe`（另有 `arm64-setup.exe`、`windows_x64_portable.zip`、`msi`） | 同左 |
| node 运行时（≥18） | `node-<版本>-darwin-arm64.tar.xz` | `node-<版本>-darwin-x64.tar.xz` | `node-<版本>-win-x64.zip` 或 `.msi` | `node-<版本>-win-arm64.zip` |

- 官方发布页：`https://github.com/l0ng-ai/openidea/releases`。
- 镜像加速（实测全速可用）：在 GitHub 原始下载地址前加前缀，如 `https://ghfast.top/https://github.com/l0ng-ai/openidea/releases/download/<...>`。
- node 二进制镜像（npmmirror）：`https://registry.npmmirror.com/-/binary/node/v22.21.1/node-v22.21.1-darwin-arm64.tar.xz`（换平台替换文件名即可）。
- 远程开发用的 server 构建：`openidea-server-{linux,macos}-{x86_64,aarch64}.gz`（linux 为静态 musl、macos 为原生构建）。**无 Windows server**——Windows 只能当桌面端。

## 三、macOS 安装（实测路径，Apple Silicon 为例，Intel 替换对应文件名）

### 3.1 桌面主程序

```bash
hdiutil attach -nobrowse OpenIDEA_<版本>_aarch64.dmg
cp -R "/Volumes/OpenIDEA/OpenIDEA.app" /Applications/
hdiutil detach /Volumes/OpenIDEA
```

GUI 用户在 Finder 把 OpenIDEA.app 拖入「应用程序」等价。验证版本：

```bash
plutil -extract CFBundleShortVersionString raw /Applications/OpenIDEA.app/Contents/Info.plist
```

### 3.2 Node.js 运行时（≥18）

- brew：`brew install node`；
- 离线 tar 包：

```bash
sudo mkdir -p /usr/local/node-vX
sudo tar -xJf node-<版本>-darwin-arm64.tar.xz -C /usr/local/node-vX --strip-components 1
sudo ln -sf /usr/local/node-vX/bin/node /usr/local/bin/node
sudo ln -sf /usr/local/node-vX/bin/npm  /usr/local/bin/npm
sudo ln -sf /usr/local/node-vX/bin/npx  /usr/local/bin/npx
```

### 3.3 中间件

```bash
# 解包本仓库到 /usr/local/intelephense-openidea（发布整包或仓库拷贝均可）
cd /usr/local/intelephense-openidea
npm ci --omit=dev    # 离线场景可直接使用带 node_modules 的整包，跳过此步
sudo ln -sf /usr/local/intelephense-openidea/dist/cli.js /usr/local/bin/intelephense
```

- `dist/cli.js` 自带 `#!/usr/bin/env node`，软链后即可直接执行。
- 验证：`zsh -lc 'command -v intelephense'`（按登录 shell 视角确认）。

### 3.4 语言定义

```bash
mkdir -p ~/Library/Application\ Support/ai.l0ng.openidea/languages
# 把上游 languages/php.toml 原文放入上述目录
```

- README「[四、openidea 接入](../README.md#四openidea-接入)」中的 toml 即该文件内容，**必须整份放入，不能只写半份**——同 id 语言定义整体替换内置定义（官方文档行为）。
- 日志目录：`~/Library/Logs/ai.l0ng.openidea/`。

### 3.5 启动验证

```bash
open -a OpenIDEA
```

打开带 `composer.json` 的 PHP 项目即自动拉起中间件；验证标准见 §五。

## 四、Windows 安装（实测路径，x64 为例，ARM64 替换对应安装包）

### 4.1 桌面主程序

- 双击 `OpenIDEA_<版本>_x64-setup.exe`；SmartScreen 拦截时选「更多信息 → 仍要运行」。
- 静默安装：`OpenIDEA_<版本>_x64-setup.exe /S`。注意 `/S` 结束时可能自启 app，属 NSIS 行为。
- 实测安装位置：机器级 `C:\Program Files\OpenIDEA`，主程序名 `openidea.exe`。

### 4.2 Node.js 运行时（≥18）

- 已有 nvm4w 版本亦可（实测 v24.21.0 可用）；
- 新装：`winget install OpenJS.NodeJS.LTS`，或用 npmmirror 的 zip / msi 离线安装。

### 4.3 中间件（用户级，免管理员）

1. 解包本仓库到 `%LOCALAPPDATA%\OpenIDEA-tools\intelephense-openidea`（实测用带 `node_modules` 的整包，解包即用；若拿到的是不含依赖的源码包，先在该目录执行 `npm ci --omit=dev`）。
2. 建 shim 目录 `%LOCALAPPDATA%\OpenIDEA-tools\bin`，写入 `intelephense.cmd`，内容一行：

   ```bat
   @node "%LOCALAPPDATA%\OpenIDEA-tools\intelephense-openidea\dist\cli.js" %*
   ```

3. 把 bin 目录追加到**用户** PATH：

   ```powershell
   $bin = "$env:LOCALAPPDATA\OpenIDEA-tools\bin"
   $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
   [Environment]::SetEnvironmentVariable('Path', "$userPath;$bin", 'User')
   ```

   ⚠️ 不要用 `setx`：其 1024 字符截断 bug 可能损坏已有 PATH。
4. 验证：**新开**一个终端执行 `where intelephense`（已开的终端不会拿到新 PATH）。

### 4.4 语言定义

- 放入 `%APPDATA%\ai.l0ng.openidea\languages\php.toml`（同 §3.4，必须整份原文）。
- 日志 / 本地数据：`%LOCALAPPDATA%\ai.l0ng.openidea\logs`。

### 4.5 启动验证

开始菜单启动 OpenIDEA，打开带 `composer.json` 的 PHP 项目；验证标准见 §五。

## 五、安装验证（两平台通用）

| 层级 | 操作 | 预期 |
| --- | --- | --- |
| 命令解析 | macOS `command -v intelephense` / Windows `where intelephense` | 命中中间件入口 |
| IDE 侧 | 打开 PHP 文件，对某标识符执行 Rename | 不出现「未安装 intelephense」提示；Rename 能跨文件生效 |
| 协议冒烟（可选，开发者级） | stdio 拉起 `node <中间件>/dist/cli.js --stdio`，发送 `initialize` | `serverInfo = {"name":"intelephense-openidea","version":"0.3.0"}`；`serverCapabilities` 含 `renameProvider` / `typeHierarchyProvider` / `inlayHintProvider` / `codeLensProvider` / `foldingRangeProvider`；可再抽验 rename 跨文件与 inlayHint |

- 仓库自带 `npm run probe`（45 项）面向开发侧回归：需真实 PHP 项目，`PROBE_ROOT` 指向含 `application/admin/controller/product/Product.php` 等的 ThinkPHP 工程；普通安装无需执行。

## 六、可选：离线远程 server 预置

桌面端 Remote 到 GitHub 不通的主机时，可提前把对应平台的 server 二进制放进桌面端本地数据目录：

```text
<本地数据目录>/server/<os>-<arch>/openidea-server
```

- 例：`server/linux-x86_64/openidea-server`。注意放的是 **gunzip 解压后的二进制**，不是 `.gz` 原文件。
- 数据目录：macOS `~/Library/Application Support/ai.l0ng.openidea/server/`；Windows `%LOCALAPPDATA%\ai.l0ng.openidea\server\`。
- 桌面与远端 server 版本必须配对，协议不一致会拒连。
- 也可用环境变量 `OPENIDEA_SERVER_BINARY` 直接指定 server 二进制路径。

## 七、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| PATH 看不到新加的 bin | Windows sshd 会话继承服务进程的环境快照，不随注册表即时刷新 | 桌面新开终端生效；macOS 用登录 shell `zsh -lc 'command -v intelephense'` 验证 |
| 语言定义改了不生效 | IDE 启动时只读取一次语言定义 | 重启 IDE |
| 新旧版本行为对不上 | 机器上有旧版 OpenIDEA（实测 0.1.42 与 0.1.43 共存易混） | 卸载旧版，只保留一个版本 |
| 安装包被系统拦截 | macOS Gatekeeper / Windows SmartScreen 首次运行校验 | 按 §3.1 / §4.1 的方式确认运行 |
| `npm ci` 慢或失败 | 默认 registry 网络不通 | `npm config set registry https://registry.npmmirror.com`；或改用带 `node_modules` 的整包（纯 JS 跨平台） |
