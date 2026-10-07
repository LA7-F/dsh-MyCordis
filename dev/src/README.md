# dev/src/ —— host 半区的分层源码

> 面向**要改这个插件的人**。用户文档在 [../../README.md](../../README.md)；
> 文件归属约定在 [../../缓存/说明.md](../../缓存/说明.md)。

## 1. 这里是什么

`lib/host.js`（随包分发的产物）**不是手写的**：它是下面这些片段按
[manifest.mjs](manifest.mjs) 的顺序、**无分隔符**拼出来的一个 async 函数体，
由 `lib/index.js` 用 `new Function` 求值后挂载。

所以每个片段都必须满足三条硬约束（`dev/tools/check.mjs` 会逐条拦）：

1. **只能是顶层声明**（`function` / `const` / `let` / `var`），**不得出现 `import` / `export`**；
2. **顶层名字全插件唯一**——拼接后同处一个作用域，重名会**静默**互相覆盖；
3. 片段之间**直接互相引用**即可（函数声明会提升），既不需要也不能 import。

## 2. 分层与依赖方向

```
base  →  runtime  →  cordis  →  install  →  ui / http  →  plugin
纯工具    DSH 服务    插件领域    真装/卸    对外呈现      入口
```

**单向**：每个片段只能引用**同层或更早层**提供的名字。同层内不论先后（函数声明提升）；
跨层反向引用即使语法合法，运行期也一定拿不到，`dev/tools/check.mjs` 会直接判 FAIL。

| 层 | 职责 |
|---|---|
| `base` | 通用文本与标识工具：HTML 转义、跨平台 shell 引用、随机标识；HTTP 底层 I/O：回包助手、请求体读取与上限、URL 拆分；信任栅栏（loopback Host + 同源 Origin + 无 Origin 放行）与路径/文件名/错误净化；安装源规格：npm 包名校验、git 地址归一、凭据打码 |
| `runtime` | 工作区与会话解析：当前会话 id、工作区根目录（B9 解析链）；shell 服务封装、跨平台目录助手与存在性探测；dsh CLI 与 pnpm 的可执行入口定位（桌面版 resources / 工作区 / PATH，跨平台）；原生目录选择器：直接调用 DSH 自己的 directoryPicker（native 能力） |
| `cordis` | 会话级动态插件清单：当前包名、runner.inventory 归一化；便携包定义与导出：脱敏标识、单/批量导出、快照导出；打包：包入口源码生成、上传解包、单插件/批量/整包（dsh + 便携）；导入定义（define/run）、手动运行与同名去重；收藏持久化（串行写入 + 旧位置迁移兜底）、恢复、常驻自动拉起 |
| `install` | 安装源识别（未压缩文件夹的 package.json 预检、已存在路径归类）；profile 层真实安装/卸载：dsh plugin add/remove、已装清单 |
| `ui` | 页面右下角悬浮入口按钮与其 index 注入脚本；「我的Cordis」面板页面（HTML/CSS/前端 JS 模板） |
| `http` | HTTP 路由表：请求分发、统一错误处理、各 API 端点 |
| `(入口)` | 插件入口：inject 声明、路由注册、index 注入、常驻自恢复 |

## 3. 逐片段地图

由 [manifest.mjs](manifest.mjs) 定义（这里是它的可读副本，改分层请同步）：

| 文件 | id | 职责 | 对外提供的顶层名字 |
|---|---|---|---|
| `dev/src/packages/base/text.js` | `base/text` | 通用文本与标识工具：HTML 转义、跨平台 shell 引用、随机标识 | `esc` `isWindowsHost` `sq` `rand` |
| `dev/src/packages/base/http-io.js` | `base/http-io` | HTTP 底层 I/O：回包助手、请求体读取与上限、URL 拆分 | `send` `sendDownload` `sendHtml` `MAX_BODY_BYTES` `readBody` `parsePath` |
| `dev/src/packages/base/security.js` | `base/security` | 信任栅栏（loopback Host + 同源 Origin + 无 Origin 放行）与路径/文件名/错误净化 | `parseAuthority` `isLoopbackHostname` `parseOrigin` `defaultPort` `isTrustedRequest` `validProfile` `normPath` `sanitizeFilename` `safeErrorMsg` |
| `dev/src/packages/base/source-spec.js` | `base/source-spec` | 安装源规格（与 DSH 无关）：npm 包名校验、git 地址归一、凭据打码、类型名 | `PACKAGE_NAME_RE` `PACKAGE_NAME_MAX` `validPackageName` `redactUrl` `normalizeGitSpec` `isGitSource` `kindTextOf` |
| `dev/src/packages/runtime/workspace.js` | `runtime/workspace` | 工作区与会话解析：当前会话 id、工作区根目录（B9 解析链） | `resolveCurrentSessionId` `sessionTitleOf` `listSessions` `workspaceWritePolicy` `sessionCwdOf` `workspaceRoot` |
| `dev/src/packages/runtime/shell.js` | `runtime/shell` | shell 服务封装、跨平台目录助手与存在性探测 | `runShell` `ensureDir` `removeTree` `probePathExists` `probeAsarExists` `probeOnPath` |
| `dev/src/packages/runtime/cli.js` | `runtime/cli` | dsh CLI 与 pnpm 的可执行入口定位（桌面版 resources / 工作区 / PATH，跨平台） | `desktopQuitHint` `shellCallPrefix` `electronRunAsNodePrefix` `resolveDshCli` `resolvePnpm` |
| `dev/src/packages/runtime/picker.js` | `runtime/picker` | 原生目录选择器：直接调用 DSH 自己的 directoryPicker（native 能力） | `pickDirNative` |
| `dev/src/packages/cordis/inventory.js` | `cordis/inventory` | 会话级动态插件清单：当前包名、runner.inventory 归一化 | `pluginCurrentName` `listPlugins` |
| `dev/src/packages/cordis/portable.js` | `cordis/portable` | 便携包定义与导出：脱敏标识、单/批量导出、快照导出 | `FAKE_SESSION_ID` `isFakeSessionId` `sanitizePortable` `exportDynamicPlugin` `exportBatch` `snapshotPlugin` `readPluginFromTgz` |
| `dev/src/packages/cordis/pack.js` | `cordis/pack` | 打包：包入口源码生成、上传解包、单插件/批量/整包（dsh + 便携） | `entrySource` `uploadBundle` `fileSha256AndSize` `packSessionPlugin` `packBatch` `packWhole` |
| `dev/src/packages/cordis/import.js` | `cordis/import` | 导入定义（define/run）、手动运行与同名去重 | `tryRun` `importDynamicPlugin` `runDynamicPlugin` `dedupePlugins` |
| `dev/src/packages/cordis/favorites.js` | `cordis/favorites` | 收藏持久化（串行写入 + 旧位置迁移兜底）、恢复、常驻自动拉起 | `favQueue` `favSerialize` `favoritesPath` `legacyFavoritesPath` `readFavorites` `writePolicyFor` `writeFavorites` `favoriteAdd` `favoriteRemove` `favoriteSetResident` `restoreOne` `restoreFavorites` `autoRestoreResident` |
| `dev/src/packages/install/source.js` | `install/source` | 安装源识别（文件夹 package.json 预检 / 已存在路径归类，需要 fs 与 shell） | `readInstallManifest` `installPathKind` `localDirSource` `resolveInstallSource` |
| `dev/src/packages/install/profile.js` | `install/profile` | profile 层真实安装/卸载：dsh plugin add/remove、已装清单 | `PROFILE_BASE_BUNDLES` `SELF_PLUGIN_NAME` `installNoteFor` `installErrorHint` `installBundle` `dshHome` `profileNameOfDir` `activeProfile` `installedPlugins` `uninstallBundle` |
| `dev/src/packages/ui/button.js` | `ui/button` | 页面右下角悬浮入口按钮与其 index 注入脚本 | `buttonScript` `injectButton` |
| `dev/src/packages/ui/page.js` | `ui/page` | 「我的Cordis」面板页面（HTML/CSS/前端 JS 模板） | `pageHtml` |
| `dev/src/packages/http/router.js` | `http/router` | HTTP 路由表：请求分发、统一错误处理、各 API 端点 | `handleRequest` |
| `dev/src/packages/plugin.js` | `plugin` | 插件入口：inject 声明、路由注册、index 注入、常驻自恢复 | — |

## 4. 改码流程

```sh
# 1) 只改 src/packages/** 里对应的片段；新增/移动片段时同步改 src/manifest.mjs
# 2) 只读门禁（多人/多 agent 并行时用这个，不写盘）
node dev/tools/check.mjs                 # 期望 CHECK OK
# 3) 生成产物（lib/host.js 随包分发，必须与源码一起提交）
node dev/tools/build.mjs
# 4) 提交前确认产物与源码一致（CI 友好）
node dev/tools/build.mjs --check         # 期望「src 与 lib/host.js 同步」
```

## 5. 并行纪律

多人同时改**不同片段**时，**只跑 `node dev/tools/check.mjs`**，不要跑 `build.mjs`——
它会写 `lib/host.js`，与别人的改动竞争。改完由一人统一 `build.mjs` 生成产物。
