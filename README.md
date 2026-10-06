# MyCordis 适配版（针对正式版桌面 DSH 0.2.0-rc.2）

这是 `dsh-mycordis` v0.1.1（「我的Cordis」）适配 **正式版 DeepSeek Harness 桌面版**
（`0.2.0-rc.2` / cordis `4.0.4`）的工作副本与改造记录。

原始的 1522 行单体 `host.js` 现在按**功能分包**放在 `src/packages/**`，由 `tools/build.mjs`
按 `src/manifest.mjs` 的清单拼回**同一个 `host.js`**（一个 async 函数体），安装方式与上游一致。
分包的目的就是长期维护：改「打包」只碰 `cordis/pack.js`，改「信任栅栏」只碰
`base/security.js`，改「面板」只碰 `ui/*`，互不干扰、可回归。

---

## 目录

```
mycordis-v2/
├── ADAPTATION.md          # ★ 调研规格：每条缺陷 + 证据 + 目标语义
├── README.md              # 本文件
├── host.orig.js           # 冻结的原始基线（只读）
├── src/
│   ├── manifest.mjs       # ★ 功能分包清单（唯一事实源：顺序 / 职责 / provides）
│   └── packages/          # 每个 .js 是一个功能片段，按 manifest 顺序拼接
│       ├── base/          # 纯工具：text / http-io / security（信任栅栏在此）
│       ├── runtime/       # DSH 服务接入：workspace / shell / cli / picker
│       ├── cordis/        # 会话级插件领域：inventory / portable / pack / import / favorites
│       ├── install/       # profile 层真实安装：profile.js
│       ├── ui/            # 浏览器 UI：button.js / page.js
│       ├── http/          # 路由：router.js
│       └── plugin.js      # 入口：inject + apply（必须最后）
├── tools/
│   ├── lib/bundle.mjs     # 读 manifest → 拼接 → 静态门（build/check 共用）
│   ├── build.mjs          # packages/* → host.js（写文件；带结构门）
│   ├── check.mjs          # 只读结构门（并行安全）
│   ├── install.mjs        # 安装进 profile 包目录（自动备份、幂等）
│   └── accept.mjs         # 一键验收：check → build → 回归 →（--live）实测
├── tests/
│   ├── _harness.mjs
│   ├── host-router.test.mjs   # 无头回归（43 项）
│   └── live-e2e.mjs           # 对 127.0.0.1:19387 的零副作用实测
├── briefs/                # 历史存档：早期并行改装的子 agent 任务书（路径已过时）
└── host.js                # 构建产物（安装用，勿手改）
```

## 功能分包约定

- `src/manifest.mjs` 是**唯一事实源**：数组顺序即拼接顺序，`plugin` 必须最后（它含顶层 `return`）。
- 每个片段只能是**顶层声明**（`function` / `const` / `let` / `var`）：不得出现 `import`/`export`，
  顶层名字全局唯一，片段之间直接互相引用即可（拼接后同处一个作用域）。
- 新增/移动功能：先改 `src/packages/**`，再把 `manifest.mjs` 里的 `id / file / role / provides`
  对齐。`tools/check.mjs` 会校验 `provides` 与代码里的顶层声明**一一对应且无重名**。
- 依赖方向保持 `base → runtime → cordis → install → ui/http → plugin` 单向，避免底层反向依赖上层。

## 工作流

```powershell
# 1) 改 src/packages/<功能包>/<模块>.js
# 2) 只读结构门（并行时用这个）
node mycordis-v2/tools/check.mjs

# 3) 生成产物 + 确认与已安装版本是否一致
node mycordis-v2/tools/build.mjs
node mycordis-v2/tools/install.mjs --dry

# 4) 安装（目录在会话工作区之外，通常需要提升沙箱权限）
node mycordis-v2/tools/install.mjs --profile desktop

# 5) 完全退出并重启 DeepSeek Harness，然后实测
node mycordis-v2/tests/host-router.test.mjs
node mycordis-v2/tests/live-e2e.mjs
```

> 回归基线：`node mycordis-v2/tests/host-router.test.mjs` → `RESULT OK passed=82 failed=0`。
> 本次重分包已逐字节核验：新旧 `host.js` 的**行多重集完全一致**（1713 行，仅重排 +
> 17 行模块头注释），没有增删改任何一行代码。

## 零会话唤醒（临时插件）

**「唤醒临时插件」默认不再唤醒任何会话轮次。** 判据是 run 往返用哪个动词收尾：`resolveRequestRun → agent.steer` 会唤醒一轮，`settleUserRun → agent.inject` 只注入一条上下文。

- 本插件现在一律走后者：`runHostHalf(agent, pluginId, packageId, mode, requestId=null, false)`（官方 runner 的「面板手势」入口）——host 半静默求值，带 client 半区的包停在 `status='client-pending'`（面板显示「待页面装入」）；
- client 半由**页面**装入：本插件现在自带一个**静态 client 半区**（`client.js`），页面 boot 后自动把 `client-pending` 的包经 `startUserRun → settleUserRun` 装进本页，**不必再去 DSH 侧边栏 Cordis 面板点「运行」**（那条路依旧可用）。client 半**默认不装**，要 `install.mjs --with-client` 才装；它**刻意不声明任何 inject**（运行时 `ctx.get` 惰性取服务），所以缺服务时最多是自动装入不生效，绝不会让 entry 卡在 inactive 把 web boot 拖崩。纯 host 半区装不了 client 半、必须有一个页面来收尾，这是 DSH 的设计边界；本插件补的就是这个页面侧角色；
- 应急仍可退回会唤醒的 `run()` 通道：面板勾「允许唤醒会话（应急）」，或 `POST /api/run` 带 `{ wake: true }`、`POST /api/import` 带 `{ allowWake: true }`。

完整推理、0.2.0-rc.2 源码实证与验收见 [`缓存/零会话唤醒-总结与方案.md`](./缓存/零会话唤醒-总结与方案.md)。

## 便携包（完整定义 + 跨平台）

便携包（`.dshplugin.json`）以前有两个通用性问题，本次一并修掉：

1. **丢掉 client 半区**：批量导出与「整包」的便携包都写死 `pureHost=true`，只导出 host 半区；
   而 `/api/export` 下载、收藏、快照却是完整定义。结果同一个插件的两种导出内容不一致，
   带 client UI 的插件导入别的会话后界面直接消失。
   现在**默认导出完整定义（host + client）**，与 `.tgz` 里的 `client.js` 对齐；
   面板新增「仅 host 半区」复选框（`pureHost:true`），需要更小的纯 host 定义时仍可显式取回。
2. **写盘依赖 Windows/PowerShell**：`exportBatch` / `snapshotPlugin` 用 pwsh 的 `New-Item` 建目录，
   `packSessionPlugin` 用 `Get-FileHash` / `Get-Item` / `Remove-Item`，非 Windows 上直接失败。
   现在：
   - 便携包导出**完全不碰 shell**——官方 fs-local 的 `writeFileAtomic` 本来就会递归建父目录（`mkdir`），
     所以不需要任何建目录命令；
   - 打包/清理目录走新增的跨平台助手 `ensureDir` / `removeTree`（pwsh 用 `New-Item`/`Remove-Item`，POSIX 用 `mkdir -p`/`rm -rf`）；
   - 产物的 SHA-256 与字节数改在进程内用 `fs.readBytes` + WebCrypto 计算，只在后端缺失时退回平台感知的 shell 摘要；
   - pnpm / dsh CLI 的命令前缀、PATH 探测（`Get-Command` vs `command -v`）、存在性探测（`Test-Path` vs `test -e`）都按宿主平台出命令；
   - `sq()` 变成跨平台单引号引用（pwsh 内部 `'` 翻倍，POSIX 用 `'\''`）。

回归测试新增 `[10]`/`[11]` 六条：默认完整定义、`pureHost:true` 退回纯 host、快照含 client、`/api/export` 的 `pureHost` 开关（都断言 **shell 命令数为 0**），以及「打包整包」的 `.tgz` + 完整便携包 + 进程内 SHA-256。

---

## 为什么要改（一句话版）

MyCordis 的功能骨架与 0.2.0-rc.2 基本兼容，真正让它「在正式版桌面版上不能用」的是
**信任栅栏语义**（所有 POST 恒 403）与两处**环境假设**（CLI 路径、pnpm 路径）。
逐条缺陷、证据与目标语义见 [ADAPTATION.md](./ADAPTATION.md)。

## 已核实的权威证据（0.2.0-rc.2）

| 事实 | 来源 |
|---|---|
| 官方信任栅栏是「Origin 缺失即放行」 | `dsh-client-connection/lib/index.js:205-219` —— `if (origin === void 0) return true` |
| 桌面把注入行表**一次性**在启动 ready 时收集 | `dsh-desktop-host/lib/index.js:341` `injections: ctx.webServer.collectIndexInjections()` |
| `webserver/index-inject` 行支持 `{kind:'script',placement:'body',text}` | `dsh-host-webserver/lib/index.js` `renderRow` |
| 官方 CLI = Electron 二进制 + `dsh-desktop-host/lib/cli.js` | `resources/runtime/cli/bin/dsh.cmd`；`dsh-desktop-host/lib/cli.js` |
| 官方内置 pnpm = `resources/runtime/pnpm/bin/pnpm.mjs` | `resources/runtime/versions.json`（pnpm 11.7.0）；`cli.js` 的 `packageManager` |
| 会话/shell/fs/directoryPicker/agents/sandboxPolicy 调用面 | 见 ADAPTATION.md 第 2 节逐条证据 |

## 已知约束（不是缺陷）

- 装到 `desktop` profile 必须**完全退出桌面版**再执行（官方 `requireDesktopProfile` 约束）。
- 桌面版的 index 注入行表在**启动时**收集一次，所以运行时新导入的动态插件不会立刻长出按钮，需重启。
- 会话级动态插件是**进程级**状态；便携定义文件（`.dshplugin.json`）才是持久产物。
- 本插件 UI 走「服务端页面 + index 注入」；`client.js` 是**唯一的 client 半区**，只做一件事：页面侧自动装入 `client-pending` 的临时插件（等价于官方面板那一行「运行」）。它走 `settleUserRun → agent.inject`（**不唤醒**），但会往归属会话注入一条 user 上下文消息；失败静默，官方面板仍可手动运行。它**刻意不声明 inject**、`dsh.client` 里也不写 `inject`——任何一个没激活的 client entry 都会让 web boot 直接致命失败（2026-10-05 首发版就是这么把桌面版弹崩的）。装：`node tools/install.mjs --profile desktop --with-client`；出问题回滚：`node tools/rollback-client.mjs --profile desktop`（清空 client.js + 去掉 exports/dsh.client，幂等、不依赖备份）。
- **工作区根目录**按官方规范 `agent.session.header.cwd ?? sandboxPolicy.workspaceRoot` 解析
  （依次尝试 `agents.currentInitiator()`、恰好一个 `agents.roots()`、`sandboxPolicy.resolve()`、
  `sandboxPolicy.workspaceRoot`、`fs.processPath(await fs.resolve('.'))`）。
  但本插件是**全局 webServer 路由**、HTTP 请求不带 agent 上下文：第 1 步通常拿不到
  `currentInitiator()`，第 2 步要求**恰好一个 root 会话**，所以**多会话并存时仍会退回部署兜底**
  （桌面版的进程 cwd 就是 profile 目录），产物/收藏会落到 `<profile>/` 而不是会话工作区。
  这是「插件是全局路由、工作区是 per-session 概念」的固有张力；彻底解决需要面板把 sessionId
  带进请求（未在本轮范围）。为免既有收藏「凭空消失」，`readFavorites` 在新位置读不到时会回读旧的
  `<sandboxPolicy.workspaceRoot>/packer2-favorites.json`（只读不写，写操作仍只写新位置）。
- **会话归属（D2）**：HTTP 请求没有 agent 上下文，导入/运行的 sessionId 以前只能手填；现在
  `GET /packer2/api/sessions` + 导入页「会话…」下拉会列出存活 root 会话，选项按
  **「历史对话标题 - 会话id」**展示（标题取自官方 `sessionTitle` 服务的 `session/title` 投影，
  与 DSH 侧边栏会话列表同源；该服务缺失或无标题时退回只显示 id），服务端能自动解析
  或只有一个存活会话时自动预选回填，多会话时由用户显式选。

## 上游

- 仓库：<https://github.com/LA7-F/dsh-MyCordis> ｜ Gitee 镜像 <https://gitee.com/LA7_F/dsh-MyCordis>
- 原始 README 存档：`README.upstream.md`
