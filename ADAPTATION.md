# MyCordis 适配「正式版 DSH」调研与改造规格

> 调研对象：`dsh-mycordis` v0.1.1（profile=desktop 已安装）
> 目标运行环境：DeepSeek Harness 桌面版 **0.2.0-rc.2** / cordis **4.0.4**（asar: `E:\harness\harness-desktop\resources\app.asar`）
> GUI：`http://127.0.0.1:19387`（Electron 桌面版，非浏览器直连）
> 本规格中每条结论都标了证据来源；**改代码前先读对应证据**。

---

## 0. 结论摘要

MyCordis 的功能骨架与 0.2.0-rc.2 的 API **基本兼容**（绝大多数调用都还成立），
真正让它「在正式版上不能用」的是 3 处**环境假设** + 1 处**信任栅栏语义**：

| # | 严重度 | 缺陷 | 证据 |
|---|---|---|---|
| B1 | **阻断** | 桌面版下**所有 POST 恒 403** | 实测：`POST /packer2/__probe__` 无 Origin → 403；带 Origin → 404 |
| B2 | **功能失效** | 安装/卸载硬编码 `<工作区>/apps/cli/lib/bin.js`（只存在于 DSH 源码仓库） | `src/packages/install/profile.js` `installBundle`/`uninstallBundle` |
| B3 | **功能失效** | `pnpm pack` 依赖 PATH 上的全局 pnpm；正式版用**内置 pnpm** | `packSessionPlugin` 的 `runShell('pnpm pack …')` |
| B4 | 中 | 面板调用**不存在的路由** `/api/host.pickDirectory` | `src/packages/ui/page.js` `pickNative()` |
| B5 | 中 | 悬浮按钮用**不存在的设计 token** `--dsw-alias-bg` → 暗色下白底浅字 | `src/packages/ui/button.js` `buttonScript()` |
| B6 | 低 | README 写「10MB 请求体上限」，代码是 `80 * 1024 * 1024` | `src/packages/base/http-io.js` `MAX_BODY_BYTES` |
| B7 | 低 | `void autoRestoreResident(ctx)` 无 catch → 可能未处理拒绝 | `src/packages/plugin.js` apply |
| B8 | 低 | `/api/browse/pick` 连续调用两次 `svc.capability()`；多处未用变量 | `src/packages/http/router.js` |

**已逐条核对确认「无需改动」的调用**（别再动）：见第 2 节。

---

## 1. 开发布局（功能分包，已就绪，勿破坏）

原始单体 `host.js` 先被机械拆成三段，随后在**不改一行代码**的前提下按功能重新分包为
`src/packages/**`（旧三段仍是同样的字节，只是重新分组 + 每个片段加了一行头注释）。
分包清单是唯一事实源：[\`src/manifest.mjs\`](./src/manifest.mjs)。

```
mycordis-v2/
├── host.orig.js          # 冻结的原始基线（只读参照）
├── src/
│   ├── manifest.mjs      # ★ 功能分包清单（顺序 / 职责 / provides）
│   └── packages/         # 每个文件是一个功能片段，按 manifest 顺序拼成一个 async 函数体
│       ├── base/         # 与 DSH 无关的纯工具：text / http-io / security
│       ├── runtime/      # DSH 运行时服务接入：workspace / shell / cli / picker
│       ├── cordis/       # 会话级动态插件领域：inventory / portable / pack / import / favorites
│       ├── install/      # profile 层真实安装：profile.js
│       ├── ui/           # 浏览器 UI：button.js（悬浮按钮+index 注入）/ page.js（面板页面）
│       ├── http/         # 路由表：router.js（handleRequest）
│       └── plugin.js     # 入口：return { inject, apply }（必须最后）
├── tools/
│   ├── lib/bundle.mjs    # 读 manifest → 拼接 → 静态门（build/check 共用）
│   ├── build.mjs         # packages/* → host.js（唯一产物，写文件）；**只由协调者跑**
│   └── check.mjs         # 只读结构门：拼接+编译+重名门+关键函数存在性；**子 agent 跑这个**
├── tests/                # 回归 + 实测
└── host.js               # ← 构建产物，安装用；不要手改
```

**等价性证据（重分包时逐字节核过）**：新旧 `host.js` 的**行多重集完全一致**
（1713 行，仅重排 + 17 行模块头注释）；旧三段拼接 = 新 `host.js` 去掉模块头。
即重分包没有增删改任何一行代码，43 项回归全绿。

**并行纪律**：多个子 agent 同时改**不同功能片段**时，
**只准跑 `node mycordis-v2/tools/check.mjs`（只读、不写任何文件）**，
**不要跑 `build.mjs`**（它会写 `host.js`，与其它 agent 竞争）。
最终由协调者在所有改动落地后统一 `node mycordis-v2/tools/build.mjs` 生成产物。

> 约束：`host.js` 最终仍是**一个 async 函数体**（`index.js` 用 `new Function` 求值，
> 动态插件形态下也一样），所以功能片段**不能**出现 `import`/`export`，
> 只能是函数声明与顶层 `const/let`，且拼接后不得重复声明（`check.mjs` 会拦）。

### 旧三段 → 新功能包对照

| 旧片段 | 现在的功能包 |
|---|---|
| `part1-core.js` | `base/text.js`、`base/http-io.js`、`base/security.js`、`runtime/workspace.js`(resolveCurrentSessionId)、`cordis/portable.js`(脱敏标识)、`cordis/pack.js`(entrySource) |
| `part2-page.js` | `ui/button.js`、`ui/page.js` |
| `part3-api.js` | `runtime/*`、`cordis/*`、`install/profile.js`、`http/router.js`、`plugin.js` |

---

## 2. 已核对的真实 API 面（0.2.0-rc.2，勿改）

> 证据文件均在 asar 内；用 `node _audit/asar-report.mjs <asar> read <path>` 复读。

| MyCordis 用法 | 结论 | 证据 |
|---|---|---|
| `ctx.on('webserver/index-inject', table => table.push({kind:'script',placement:'body',text}))` | ✅ 成立 | `dsh-host-webserver/lib/index.js`：`collectIndexInjections()` 就是 `emit('webserver/index-inject', table)`；`renderRow` 支持 `script/text/placement` |
| `ctx.webServer.register({kind:'prefix', path, handler})` | ✅ 成立，返回 disposer | 同上 `register(route)` |
| `ctx.effect(fn, label)` | ✅ 成立 | cordis 4.0.4 `fiber.ts`；审计文档已核 |
| `shell.resolve({command, workdir, timeoutMs, sandboxPolicy})` | ✅ 成立 | `dsh-pwsh-local/lib/index.js` `resolve(request)` 显式透传 `sandboxPolicy` |
| `(await shell.execute(spec)).result()` | ✅ 成立 | `dsh-pwsh-local` `execute(spec)` → `ShellExecution.result()` |
| `fs.resolve(p)` / `fs.processPath(t)` / `fs.readText(t)` | ✅ 成立 | `dsh-fs-local/lib/index.js` |
| `fs.writeText(target, content, expected, signal, sandboxPolicy)`（**5 参**） | ✅ 成立 | `dsh-fs-sandbox/lib/index.js:125` `writeText(target, content, expected, signal, sandboxPolicy)`（裸 local 只有 4 参，但运行时挂的是 sandbox 装饰器） |
| `ctx.directoryPicker.capability()` / `.list(path, signal)` / `.createDirectory(path, name)` | ✅ 成立 | `dsh-host-directory-picker-browse/lib/index.js` 的 `browseCapability` |
| `ctx.agents.currentInitiator()` / `.roots()` | ✅ 成立 | `dsh-agent/lib/index.js:368,621` |
| `ctx.get('sandboxPolicy').workspaceRoot` | ✅ 成立（绝对路径字符串） | `dsh-sandbox-policy/lib/index.js:103,113` |
| `runner.inventory()/inspectPackage/define/run/undefine` | ✅ 成立 | `_audit/DSH-API-AUDIT.md` 全文；`owned()` 只读 `agent.id` |
| profile 清单形状 `dependencies` + `dsh.profile.bundles` | ✅ 成立 | `C:\Users\Ljf20\.dsh\profiles\desktop\package.json` 实测 |

**实测运行状态（当前未打补丁）**：

| 请求 | 结果 |
|---|---|
| `GET /packer2/api/plugins` | 200 |
| `GET /packer2/api/installed?profile=desktop` | 200（列出 `dsh-mycordis`，`isBundle:true`） |
| `GET /packer2/api/browse` | 200 `{"kind":"native"}` |
| `GET /packer2` | 200（31KB 面板 HTML） |
| `POST /packer2/__probe__`（无 Origin） | **403** ← B1 |
| `POST /packer2/__probe__`（`Origin: http://127.0.0.1:19387`） | 404（说明已越过栅栏、到达路由） |

---

## 3. B1 —— 信任栅栏（`src/packages/base/security.js`，**最高优先级**）

### 现状

```js
const origin = h.origin
if (origin === undefined) return !writeMethod   // ← 桌面版所有 POST 死在这里
```

### 根因

桌面版（Electron）用自定义协议 `dsh-app://` 代理转发页面请求，转发前会删掉
`host`/`origin`/`cookie`/`sec-fetch-site`。于是在桌面版里：

- 页面点「打包/安装/导入/收藏/去重/新建目录」→ POST 无 Origin → 被拒 403；
- 浏览器直连 `http://127.0.0.1:19387` 时 Origin 完整 → 一切正常（「时好时坏」的错觉来源）。

### 目标语义（对齐 DSH 自家 `isTrustedApiRequest`）

> DSH `@deepseek-ai/dsh-client-connection` 的注释原文：
> *「over plain HTTP a browser attaches neither Origin nor Fetch-Metadata to reads … a browser
> cannot send a POST without Origin … **Host is the one header rebinding cannot forge**」*

所以规则是 **「Origin 缺失即放行」**，其余防护一条不减：

1. `socket.remoteAddress` 必须是 loopback（现有）；
2. `Host` 头必须是 loopback + 当前服务端口（现有，rebinding 伪造不了 Host）；
3. `origin === undefined` → **放行**（改这里）；
4. `Origin: null`（字符串）→ 拒绝（现有）；
5. Origin 存在 → 与 Host 精确同源比对（scheme/host/port，现有）；
6. `sec-fetch-site: cross-site` → 拒绝（现有，桌面代理会删掉该头，所以不会误伤）。

### 验收（必须全过）

| 输入 | 期望 |
|---|---|
| 无 Origin + POST + 无 sec-fetch-site | **true** |
| 无 Origin + DELETE | **true** |
| 无 Origin + GET | **true** |
| Origin `dsh-app://app` + POST | false |
| 同源 `http://127.0.0.1:<port>` + POST | true |
| 跨站 `https://evil.example` + POST | false |
| `sec-fetch-site: cross-site` 无 Origin GET | false |
| Origin 字符串 `null` + POST | false |
| 同主机不同端口 Origin | false |
| Host `evil.example:<port>` | false |
| Host 局域网 IP | false |
| socket 远端 `10.0.0.5` | false |
| 缺 Host 头 | false |

> 参考实现已在仓库里：`mycordis-fix/apply-fix.mjs` 与 `mycordis-fix/verify-fix.mjs`（13 条断言，
> `--dry` 已验证通过）。**可以照抄其文案与逻辑**，但要落到 `src/packages/base/security.js` 并保持注释。

---

## 4. B2 —— 安装/卸载的 CLI 定位（`src/packages/install/profile.js` + `src/packages/runtime/cli.js`）

### 现状（错）

```js
const cliPath = ws.replace(/[\\/]+$/, '') + '/apps/cli/lib/bin.js'
await runShell(ctx, 'node ' + sq(cliPath) + ' plugin --profile ' + sq(profile) + ' add ' + sq(target), ws, …)
```

`<工作区>/apps/cli/lib/bin.js` **只在 DSH 源码仓库里存在**（例如
`E:\harness\deepseek-harness-master\deepseek-harness-master\apps\cli\lib\bin.js`）。
当工作区是普通目录（例如现在的 `E:\结果插件\myCordisChange`）时 → 必然失败。

### 正式版的 CLI 真相

asar 内的 `dsh-desktop-host/lib/cli.js` 是官方入口：

```js
// resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js
import { runCli } from "@deepseek-ai/dsh/lib/bin.js";
async function runDesktopCli(runtimeDir, supportDir) {
  installOfficeEngineResolution(runtimeDir);
  await runCli({ manageDesktopProfile: true, packageManager: {
    command: process.execPath,
    args: ["--expose-internals", join(supportDir, "pnpm", "bin", "pnpm.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1", DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
           PATH: `${join(supportDir, "bin")}${delimiter}${process.env.PATH ?? ""}` } } });
}
```

打包好的 shim（**桌面安装器可能已把它放进用户 PATH**）：

```bat
:: resources/runtime/cli/bin/dsh.cmd
@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

本机实测：`dsh` **不在** PATH（`Get-Command dsh` 空）；`pnpm` 在 PATH
（`C:\Users\Ljf20\AppData\Roaming\npm\pnpm.ps1`，但版本不保证 = 内置 11.7.0）。

### 目标实现

新增 `resolveDshCli(ctx)`：按顺序探测，返回可直接拼进 PowerShell 的命令前缀：

1. **源码仓库**：`Test-Path <ws>/apps/cli/lib/bin.js` → `node "<abs>"`；
2. **桌面打包版**（优先，`process` 在 bundle 形态下可用；动态插件形态下 `typeof process === 'undefined'`，要 guard）：
   - 由 `process.resourcesPath`（Electron 主进程提供 = `…\resources`）推出
     `<resourcesPath>/runtime/cli/bin/dsh.cmd` → 直接用该 `.cmd`；
   - 退路：`$env:ELECTRON_RUN_AS_NODE='1'; & "<process.execPath>" --expose-internals "<resourcesPath>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js>"`；
3. **PATH 上的 `dsh`**：`Get-Command dsh`（源仓库里也可能有）。
4. 全不命中 → 抛清晰错误，列出已探测的候选路径（**不要静默**）。

参数拼接保持 `plugin --profile <p> add|remove <spec>`（官方 `dsh/lib/plugin-BGnVfe_D.js`
走 `runPluginCommand`/`runProfilePnpm`，语法一致）。

**额外硬约束（必须体现在错误提示里）**：官方 `requireDesktopProfile` 明写
*「Open DeepSeek Harness Desktop once to initialize its profile, then **fully quit it before
running dsh plugin --profile desktop**」* —— profile=desktop 的安装/卸载需要**完全退出桌面版**，
否则 pnpm 会因文件占用失败。安装成功提示里要带上这一条。

---

## 5. B3 —— pnpm 定位（`src/packages/runtime/cli.js`）

### 现状（错）

```js
await runShell(ctx, 'pnpm pack --reporter append-only --pack-destination ' + sq(outDir), staging, policy)
```

依赖 PATH 上的全局 pnpm。正式版**自带 pnpm 11.7.0**：
`<resourcesPath>/runtime/pnpm/bin/pnpm.mjs`，且必须用 Electron 可执行文件以
`ELECTRON_RUN_AS_NODE=1 --expose-internals` 运行（`resources/runtime/bin/node.cmd` 同理）。

### 目标实现

新增 `resolvePnpm(ctx, ws)`，返回可拼进 PowerShell 的命令前缀：

1. `<resourcesPath>/runtime/pnpm/bin/pnpm.mjs` 存在 → `$env:ELECTRON_RUN_AS_NODE='1'; & "<process.execPath>" --expose-internals "<pnpm.mjs>"`；
   （`process.execPath` 缺失时退化为 `"$env:DSH_DESKTOP_NODE_EXECUTABLE"`）
2. `<ws>/node_modules/pnpm/bin/pnpm.cjs` 或 `<ws>/node_modules/.bin/pnpm` → 直接调；
3. PATH 上的 `pnpm`；
4. 全不命中 → 清晰错误。

打包命令改为 `<pnpmPrefix> pack --reporter append-only --pack-destination <outDir>`。

---

## 6. B4/B5 —— 面板页面（`src/packages/ui/`）

### B4：`pickNative()` 调用不存在的路由

```js
var body = JSON.stringify({ type:'client-request', rpcId, method:'host.pickDirectory', payload:{} })
return fetch('/api/host.pickDirectory', …)   // ← 路由表里没有；且少了 /packer2 前缀
```

路由表只有 `/packer2/api/browse/pick`。当前靠 `.catch` 回落到 `pickClassicInto` 才没炸，
但每次点「浏览」都会先打一个必然 404 的请求。
**修法**：删掉 RPC 分支，`pickInto()` 直接调 `API + '/browse/pick'`
（后端 native 时该路由本来就返回 `{picked}`；`/api/browse` GET 已探测到 `kind:'native'`）。
保留 `kind==='browse'` 时的列表浏览能力（如果页面有对应 UI）。

### B5：不存在的设计 token

```js
background: var(--dsw-alias-bg, rgba(255,255,255,.92))
```

`--dsw-alias-bg` 在 `ui-theme/src/styles/design-platform.css` **零命中**（已实测）。
因为 `var()` fallback 合法，浏览器静默用白色 → **暗色模式下白底白字**。
**修法**：改用官方语义 token，例如 `var(--dsw-specific-menu)`（= `bg-layer-3`），
并顺带排查 `buttonScript()` 与 `pageHtml()` 里所有 `var(--dsw-…, <颜色字面量>)` 的 fallback。
面板页面本身是独立文档（自带 `--bg/--panel/…` 变量），不强制套用 `--dsw-*`，
但**嵌入模式（`?embed=1`）在暗色下可读性**要在报告里说明。

---

## 7. 其余小修

- **B6**：`MAX_BODY_BYTES` 保持 `80 * 1024 * 1024`（与页面 50MB 文件上限、`uploadBundle` 的
  70MB base64 上限自洽：50MB → base64≈66.7MB < 70MB < 80MB）。**改 README** 而不是改代码。
- **B7**：`void autoRestoreResident(ctx)` → `autoRestoreResident(ctx).catch(err => ctx.logger?.warn?.(…))`
  （注意：动态插件沙箱 ctx **没有** `logger`，只用 `console` 或静默；不要假设 `ctx.logger` 存在）。
- **B8**：`/api/browse/pick` 把 `svc.capability()` 缓存到局部变量；删掉 `packSessionPlugin` 里
  未使用的 `const shell`；`parsePath` 的 query 解析可抽成一个小助手（可选）。

---

## 8. 交付与验收

1. 改动只落在你被指派的文件；**不要动别的 agent 的文件**，**`tools/` 不改**。
2. 每次改完跑 `node mycordis-v2/tools/check.mjs`，必须 CHECK OK。
   （`build.mjs` 由协调者统一执行；并行期间跑它会写 `host.js` 造成竞争。）
3. 结构门：`new Function` 能编译、返回 `{apply}`、`inject` 含 `webServer`。
4. 回归测试全绿（`tests/host-router.test.mjs`）。
5. 实测脚本（`tests/live-e2e.mjs`，目标 `http://127.0.0.1:19387`）：
   - **0 副作用**：只做 GET 与「打不存在的路径」的 POST 探针；
   - 打补丁前 `POST /packer2/__probe__`（无 Origin）= 403；
   - 安装补丁并**重启 DSH** 后 = 404（越过栅栏）。
6. 安装脚本 `install.mjs`：把 `mycordis-v2/host.js` 复制到
   `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-mycordis\host.js`，
   先备份 `host.js.bak-before-<timestamp>`；幂等；不改包内其它文件。
   **注意**：该目录在会话工作区之外，写入需要提升沙箱权限。

### 已知不可为（不要尝试）

- 会话级动态插件是**进程级**状态，DSH 重启后需重新导入 —— 便携定义文件是持久产物。
- `client.js` 为空（client 半区仅存档）；本插件的 UI 走**服务端页面 + index 注入**，
  与官方 client 槽位机制无关，不要为此改成 client 半区。
- 装到 `desktop` profile 需要**关闭桌面版**才能成功（官方 `requireDesktopProfile` 约束）。

---

## 11. B9 —— 工作区根目录解析错了（真机验证阶段发现，**与 B1 同级重要**）

### 现象（真机实测）

补丁生效、写操作打通后，我检查「产物落在哪」，发现：

| 观测 | 结果 |
|---|---|
| `GET /packer2/api/plugins` → `defaultOutDir` | `C:\Users\Ljf20\.dsh\profiles\desktop/packer2-out` ← **profile 目录** |
| `POST /packer2/api/dedupe` 后 `packer2-favorites.json` 落在 | `C:\Users\Ljf20\.dsh\profiles\desktop\` |
| 会话真实工作区 `E:\结果插件\myCordisChange\packer2-favorites.json` | 不存在 |

### 根因

`workspaceRoot(ctx)` 只读了 `ctx.get('sandboxPolicy').workspaceRoot`：

```js
async function workspaceRoot(ctx) {
  const sp = ctx.get('sandboxPolicy')
  if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '') return sp.workspaceRoot
  ...
}
```

但 `sandboxPolicy.workspaceRoot` 是**部署兜底**，不是会话工作区：

```js
// dsh-sandbox-policy/lib/index.js:113
this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
// :141-148
resolve(request = {}) {
  const { session } = request
  return { mode: ..., workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot), ... }
}
```

桌面版进程的 `process.cwd()` 就是 profile 目录，所以兜底 = profile 目录。
在**源码仓库**里开发时 cwd 恰好是仓库根，所以这个 bug 一直没暴露 ——
又一个「环境假设」。

### 官方规范

会话工作区 = `agent.session.header.cwd`，优先级是
**`agent.session.header.cwd ?? sandboxPolicy.workspaceRoot`**：

```js
// dsh-api-terminal-controller/lib/index.js:783
cwd: agent.session.header.cwd ?? sandboxPolicy.workspaceRoot
```
```js
// dsh-tool-fs/lib/index.js:159-175（session-cwd）
* Derive the working directory ... the calling agent's per-session workspace
* (`exec.agent.session.header.cwd`), so each session's read/write/edit act on
* its workspace, not the server's launch directory.
function sessionCwd(exec) { return exec.agent?.session.header.cwd }
```

### 目标语义（`workspaceRoot` 的新解析链）

1. `ctx.get('agents').currentInitiator()` → `agent.session.header.cwd`；
2. 否则 `agents.roots()` **恰好 1 个** → 它的 `session.header.cwd`；
3. 否则 `sandboxPolicy.resolve({ session })`（有 session 时）或 `resolve()` → `.workspaceRoot`；
4. 否则 `sandboxPolicy.workspaceRoot`；
5. 否则 `fs.processPath(await fs.resolve('.'))`；
6. 否则 `''`（调用方报「无法确定工作区根目录」）。

**favorites 迁移兜底**：`readFavorites` 若新位置不存在，回读旧的
`<sandboxPolicy.workspaceRoot>/packer2-favorites.json`，避免用户已有收藏「凭空消失」。

### 已知局限（写进 README）

HTTP 请求没有 agent 上下文，所以第 1 步通常拿不到 `currentInitiator()`；
第 2 步要求**恰好一个 root 会话**。因此多会话并存时仍会退回部署兜底。
这是「插件是全局 webServer 路由、而工作区是 per-session 概念」的固有张力，
彻底解决需要面板把 sessionId 带进请求。
（导入/运行的会话归属已按 D2 落地：新增 `GET /packer2/api/sessions` + 导入页会话下拉，多会话时由用户显式选。）

### 验收

- 单测（`tests/host-router.test.mjs`）：注入桩 `agents` 给出 `currentInitiator().session.header.cwd`，
  断言 `GET /api/plugins` 的 `defaultOutDir` 前缀 = 该 cwd；再给 1 个 root 验证第 2 步；
  给 2 个 root 验证退回 `sandboxPolicy`。
- 真机：重启 DSH 后 `GET /packer2/api/plugins` 的 `defaultOutDir` 应为
  `E:\结果插件\myCordisChange/packer2-out`（前提：该会话是唯一 root）。
