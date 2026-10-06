# MyCordis（我的Cordis）

[![npm version](https://img.shields.io/npm/v/dsh-mycordis.svg)](https://www.npmjs.com/package/dsh-mycordis)
[![MIT license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-blue.svg)](#适配环境)

> **DeepSeek Harness（DSH）会话级动态插件的打包 / 安装 / 便携化 / 管理面板。**
> 在会话里造出来的插件，一键打成可分发的安装包或跨会话便携文件；顺带把包装回 DSH、管理收藏与常驻。

本仓库面向正式版 **DSH 桌面版 `0.2.0-rc.2`**（cordis `4.0.4`）。

- 修掉 10 处让插件「装得上、跑不起来」的缺陷（B1–B10），见[适配改动一览](#适配改动一览)；
- 把单体 `host.js` 按功能拆成 **17 个功能分包**（[`dev/src/packages/**`](dev/src/packages)），由
  [`dev/src/manifest.mjs`](dev/src/manifest.mjs) 拼回同一个 `host.js`（仍是一个 async 函数体）；
  分层地图与依赖方向见 [`dev/src/README.md`](dev/src/README.md)。

---

## 目录

- [特性](#特性)
- [适配环境](#适配环境)
- [安装](#安装)
- [使用](#使用)
- [HTTP API](#http-api)
- [产物格式](#产物格式)
- [目录结构](#目录结构)
- [开发](#开发)
- [适配改动一览](#适配改动一览)
- [安全与限额](#安全与限额)
- [已知限制](#已知限制)
- [许可证](#许可证)

---

## 特性

| 能力 | 说明 |
| --- | --- |
| **打包整包** | 一次产出 dsh 安装包（`.tgz`）+ 便携包（`.dshplugin.json`），每插件一个子目录；支持单个与批量 |
| **真实安装 / 卸载** | 面板里选 `.tgz` 即走 `dsh plugin add / remove`（profile 级真实安装，重启 DSH 生效） |
| **便携包跨会话** | 默认导出 **host + client 两个半区**，导入别的会话或机器后 UI 同样能复现；可勾「仅 host 半区」导出更小的纯 host 定义 |
| **`.tgz` 也能当便携包** | 选 `.tgz` 导入时只用**系统 tar 解包**取两半区，**不安装**（不写 profile、不用选 profile、不用重启）；重启即消失，要常驻请收藏或真实安装 |
| **导入即注册** | 导入只注册，点「运行 / 恢复」才启动；收藏（☆）、常驻（★ 重启自动恢复）、同名去重 |
| **零会话唤醒** | 运行临时插件默认走「面板手势」通道（`settleUserRun → agent.inject`），只注入一条上下文，**不消耗会话轮次**；要唤醒需显式勾选 |
| **会话归属可选** | `GET /api/sessions` 列出存活会话（按「历史对话标题 - 会话 id」展示），导入 / 运行不必再手填 id |
| **安全加固** | 请求信任栅栏、请求体上限 80 MB（超限统一 413）、路径与文件名净化、错误信息脱敏 |
| **零外部依赖** | 只用 DSH 自带的 `webServer / dynamicCordisRunner / fs / shell / sandboxPolicy` 等服务，无数据库；唯一持久状态是工作区里的 `packer2-favorites.json` |

## 适配环境

| 项 | 版本 / 说明 |
| --- | --- |
| DSH | 桌面版 `0.2.0-rc.2`（Electron，GUI 默认 `http://127.0.0.1:19387`） |
| cordis | `4.0.4` |
| 加载形态 | profile 层 bundle 插件（`package.json` 的 `dsh.bundle.patch`），或作为会话级动态插件加载 |
| 平台 | host 半区跨平台（Windows / POSIX 命令分支）；便携包目前主要在 Windows 验证 |
| 运行时依赖 | 无；打包用 DSH 内置 pnpm（`resources/runtime/pnpm`），不要求 PATH 上有 pnpm |

---

## 安装

### 方式一：从 npm 安装（推荐）

```sh
pnpm dsh plugin --profile web add dsh-mycordis   # 从 npm 注册表安装
pnpm dsh --profile web                           # 重启 dsh
```

### 方式二：从 git 安装

```sh
# Gitee 镜像（国内，免代理）
pnpm dsh plugin --profile web add git+https://gitee.com/LA7_F/dsh-MyCordis.git
# GitHub
pnpm dsh plugin --profile web add git+https://github.com/LA7-F/dsh-MyCordis.git
pnpm dsh --profile web
```

### 方式三：先克隆再本地安装

```sh
git clone https://gitee.com/LA7_F/dsh-MyCordis.git          # 或 GitHub
pnpm dsh plugin --profile web add E:\harness\dsh-MyCordis   # 绝对路径
pnpm dsh plugin --profile web add ..\dsh-MyCordis           # 相对路径
pnpm dsh plugin --profile web add file:.\dsh-MyCordis       # 拷贝安装
pnpm dsh plugin --profile web add link:.\dsh-MyCordis       # 链接安装（改源码即时生效，适合调试）
pnpm dsh --profile web
```

### 方式四：本地 dsh 安装包（`.tgz`）

```sh
cd <tgz 所在目录>
pnpm pack                                   # 或在本插件面板里「打包」得到
pnpm dsh plugin --profile web add .\your-plugin-0.1.0.tgz
pnpm dsh --profile web
```

### 方式五：改源码后本地生效（开发者）

源码按功能分层放在 [`dev/src/`](dev/src)（地图见 [`dev/src/README.md`](dev/src/README.md)），
[`lib/host.js`](lib/host.js) 是**产物**。改完片段后：

```sh
node dev/tools/check.mjs        # 只读门禁（并行改动时用这个）
node dev/tools/build.mjs        # 由 src/packages/** 重新生成 lib/host.js
node dev/tests/smoke.test.mjs   # 回归门禁
```

要让改动生效，二选一：

- **链接安装**（推荐调试）：`pnpm dsh plugin --profile web add link:.<本仓库>`，
  之后改 `lib/` 即时生效，只需重启 DSH；
- 或按方式一至四之一**重新安装 / 升级**包，再重启 DSH。

> 装到 `desktop` profile 必须**完全退出桌面版**（官方 `requireDesktopProfile` 约束）。

### client 半区（可选，默认不装）

[`lib/client.js`](lib/client.js) 是本插件唯一的静态 client 半区，只做一件事：页面 boot 后把停在 `client-pending` 的
临时插件自动装进本页（等价于官方面板那一行「运行」）。它**默认不安装**——任何一个激活失败的 client entry
都会让 web boot 直接弹「应用无法启动」。它刻意不声明 `inject`，运行时用 `ctx.get` 惰性取服务；
运行走 `settleUserRun → agent.inject`（不唤醒会话，但会往归属会话注入一条上下文）。

本仓库**不附带**改写已安装 profile 的脚本。装 client 半区之前请先确保能回滚：
保留一份不含 `lib/client.js` 的包，出问题就用它重装一次。

---

## 使用

入口：DSH 界面右下角**悬浮按钮** →「我的Cordis」页面；也可直接访问 `/packer2`（`?embed=1` 为嵌入模式）。

页面共四个页签：

| 页签 | 作用 |
| --- | --- |
| **打包** | 设置放置目录（默认 `<工作区>/packer2-out`）→ 选打包类型（`dsh 包` / `便携包` / `整包`）→ 单个打包或「一键打包」批量 |
| **安装** | 上传 `.tgz` **真实安装**；导入 `.dshplugin.json` **或 `.tgz`**（仅解包注册，不安装、不自动运行）；选择所属会话 |
| **临时插件** | 当前会话已注册的插件：运行 / 强制重启、复制跨会话定位信息、导出定义 |
| **管理与卸载** | 列出指定 profile 已安装的插件并卸载；收藏 / 常驻 / 恢复收藏 / 同名插件去重 |

「打包整包」的产物布局：

```
放置目录/
└── <插件ID>-<包ID>/
    ├── <插件名>-0.1.0.tgz               # dsh 安装包（附带 SHA-256 与字节数）
    └── <插件ID>-<包ID>.dshplugin.json   # 便携包（默认含 host + client 两个半区）
```

> 打包产物版本号固定为 `0.1.0`，包名取自会话级插件的名称；产物落在工作区外的路径会触发沙箱提升。

---

## HTTP API

全部挂在 `/packer2` 前缀下，仅接受 loopback Host + 同源 Origin 的请求（见[安全与限额](#安全与限额)）。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/packer2` | GET | Web 面板（`?embed=1` 嵌入模式） |
| `/packer2/api/plugins` | GET | 会话级插件清单（含默认输出目录、当前 profile） |
| `/packer2/api/sessions` | GET | 存活会话清单（id / cwd / 标题，供面板选「所属会话」） |
| `/packer2/api/pack` | POST | 单个插件打包（`.tgz`） |
| `/packer2/api/pack-batch` | POST | 批量打包（`.tgz`） |
| `/packer2/api/pack-whole` | POST | **打包整包**：`.tgz` + 便携包，一插件一子目录 |
| `/packer2/api/export` | GET | 下载便携包（attachment；`pureHost=1` 只导 host 半区） |
| `/packer2/api/export-batch` | POST | 批量导出便携包（默认含 client） |
| `/packer2/api/snapshot` | POST | 导出插件快照到工作区 `packer2-snapshot/` |
| `/packer2/api/import` | POST | 导入便携包：`data`（`.dshplugin.json` 对象）或 `tgzPath`（`.tgz` 解包，**不安装**）；注册；`allowWake` 才走会唤醒的通道 |
| `/packer2/api/run` | POST | 运行 / 重启已注册插件（默认零唤醒；`wake:true` 才唤醒） |
| `/packer2/api/upload` | POST | 上传 `.tgz` / `.dshplugin` 文件 |
| `/packer2/api/install` | POST | 安装 dsh 包（真实安装） |
| `/packer2/api/uninstall` | POST | 卸载 dsh 插件 |
| `/packer2/api/installed` | GET | 指定 profile 的已安装插件清单 |
| `/packer2/api/favorites` | GET | 收藏列表 |
| `/packer2/api/favorite` | POST | 收藏 / 取消收藏 / 设为常驻 |
| `/packer2/api/restore-one` | POST | 恢复单个插件（注册并启动） |
| `/packer2/api/restore-favorites` | POST | 恢复全部收藏 |
| `/packer2/api/dedupe` | POST | 同名插件去重（按名称合并版本） |
| `/packer2/api/browse` | GET | 目录选择能力探测（`native` / `browse`） |
| `/packer2/api/browse/pick` | POST | 原生目录选择 |
| `/packer2/api/browse/create` | POST | 新建目录 |

---

## 产物格式

### dsh 安装包（`.tgz`）

标准 npm 包布局，可由 `dsh plugin add` 安装：

```
your-plugin-0.1.0.tgz
├── package.json        # name / version / main: index.js / dsh.bundle.patch
├── index.js            # 入口：把 host.js 作为 async 函数体求值并挂载插件
├── host.js             # host 半区源码
├── client.js           # client 半区存档（浏览器沙箱代码，不随 Node 执行）
└── cordis.patch.yml    # 组合补丁：声明插入的插件行
```

> 上面说的是**面板打包出来的插件包**。本仓库自身也是一个 profile 层 bundle 包，按 DSH 官方约定布局：
> 代码放 `lib/`，`cordis.patch.yml` 与 `lib/` 同级放在包根（`dsh.bundle.patch` 指过去），`files` 只带这几项。

### 便携包（`.dshplugin.json`）

纯定义文件，跨会话导入，或由新会话 AI 直接 `read` 后 `cordis_define` 重建（省 token）：

```json
{
  "__dshDynamicPlugin": true,
  "format": 1,
  "pluginId": "mycrd-1",
  "packageId": "pkg-4",
  "ownerSessionId": "session-...",
  "name": "我的Cordis",
  "purpose": "…",
  "code": { "host": "…", "client": "…" }
}
```

### 用 `.tgz` 当便携包（**不安装**）

便携包的语义就是「不落 profile」，所以便携源格式不必是专用 JSON —— dsh 包 `.tgz` 本身就是它的超集。
`POST /api/import` 的 `tgzPath`（面板「安装 → ② 导入便携包」选 `.tgz` 文件）走的就是这条路：

- 用**系统自带 tar**（Windows 10 1803+ 的 bsdtar / macOS / Linux，零新依赖）解到 `<工作区>/.packer2/tgz-<rand>`，用完即删；
- 读 `package/{package.json,host.js,client.js}`，摊成与 `.dshplugin.json` 同形的定义，走**同一个** `runner.define` 通道（零唤醒语义不变）；
- **全程不碰 `dsh plugin add`、不写 `$DSH_HOME`**：不用选 profile、不用完全退出桌面版、不用重启；代价是重启即消失；
- 人类可读名 / 用途随包带走：打包生成的 `package.json` 顶层多一块 `packer2: { format, name, purpose, pluginId, packageId }`
  （npm/pnpm 忽略未知顶层键，不影响真实安装）；老 `.tgz` 没有这一块时退回 `name` / `description`；
- 空的 `client.js` 视为「没有 client 半区」（不会被误判成 `client-pending`）；工作区外的 `.tgz` 会在解包命令上申请提权；
- `.dshplugin.json` 仍然可导入（两种解析器按扩展名分派），导出侧 API 与「整包」布局不变。

---

## 目录结构

```
mycordis-v3/
├── .gitignore              # 忽略中间产物（见「仓库约定」）
├── package.json            # 独立 npm 包声明：name / version / main / exports / files / dsh.bundle / dsh.client
├── cordis.patch.yml        # 对宿主的组合声明（DSH 官方 bundle 约定：补丁与 lib/ 同级）
├── dsh.plugin.json         # 插件元数据（id / version / main；DSH 不读，纯存档）
├── lib/                    # 发布 / 运行内容：DSH 按 package.json 里的相对路径读取
│   ├── index.js            # 宿主半边（Node ESM）：读 ./host.js → new Function 求值并挂载
│   ├── host.js             # ★ 构建产物（勿手改；由 dev/tools/build.mjs 从 dev/src/** 生成）
│   └── client.js           # 客户端半边（浏览器 classic script，默认不装）
├── dev/                    # 开发资产：不在 package.json 的 files 里，因此不进 npm 包
│   ├── README.md           # 开发入口：怎么改、改完跑什么
│   ├── src/                # host 半区源码：按功能分层
│   │   ├── README.md       # 分层地图（17 个分包的职责与依赖方向）
│   │   ├── manifest.mjs    # ★ 唯一事实源：拼接顺序 / 职责 / provides
│   │   └── packages/
│   │       ├── base/       # 与 DSH 无关的纯工具：text / http-io / security（信任栅栏在此）
│   │       ├── runtime/    # DSH 服务接入：workspace / shell / cli / picker
│   │       ├── cordis/     # 会话级插件领域：inventory / portable / pack / import / favorites
│   │       ├── install/    # profile 层真实安装：profile.js
│   │       ├── ui/         # 浏览器 UI：button.js（悬浮入口）/ page.js（面板页面）
│   │       ├── http/       # 路由表：router.js（handleRequest）
│   │       └── plugin.js   # 入口：inject + apply（必须最后）
│   ├── tools/              # 构建与门禁（唯一会写 lib/host.js 的地方）
│   │   ├── lib/bundle.mjs  # 读 manifest → 拼接 → 静态门 / 分层方向门（build 与 check 共用）
│   │   ├── build.mjs       # dev/src/** → lib/host.js；--check 只校验不写盘
│   │   └── check.mjs       # 只读门禁（并行安全）
│   └── tests/              # 回归门禁
│       └── smoke.test.mjs  # base 层行为断言 + 产物结构断言
├── README.md               # 本文件
├── LICENSE                 # MIT
└── 缓存/                    # 不进版本库：跑起来才会产生的东西（见 缓存/说明.md）
```

逐片段的职责与对外提供的名字见 [`dev/src/README.md`](dev/src/README.md)，清单事实源是 [`dev/src/manifest.mjs`](dev/src/manifest.mjs)。

---

## 开发

### 功能分层约定

- [`dev/src/manifest.mjs`](dev/src/manifest.mjs) 是**唯一事实源**：数组顺序即拼接顺序，`plugin` 必须最后（它含顶层 `return`）。
- 每个片段只能是**顶层声明**（`function` / `const` / `let` / `var`）：不得出现 `import` / `export`，
  顶层名字全局唯一，片段之间直接互相引用即可（拼接后同处一个作用域）。
- 新增或移动功能：先改 `dev/src/packages/**`，再把 manifest 里的 `id / file / role / provides` 对齐；
  `dev/tools/check.mjs` 会逐条对账（`provides` 与代码里的顶层声明一一对应、无重名、首行分节标记正确）。
- 依赖方向保持 `base → runtime → cordis → install → ui / http → plugin` **单向**，
  `dev/tools/check.mjs` 的分层方向门会拦下任何「底层反向引用上层」。

### 常用命令

```sh
node dev/tools/check.mjs          # 只读门禁：静态结构 + 分层方向 + 求值 + inject（并行改动时用这个）
node dev/tools/build.mjs          # 由 src/packages/** 生成 lib/host.js
node dev/tools/build.mjs --check  # 只校验 src 与 lib/host.js 是否同步，不写盘（CI 友好）
node dev/tests/smoke.test.mjs     # 回归门禁（当前基线：passed=55 failed=0）
```

### 提交前检查

1. `node dev/tools/check.mjs` → `CHECK OK`；
2. `node dev/tools/build.mjs --check` → `src 与 lib/host.js 同步`
   （`lib/host.js` 是产物，但它随包分发，必须与源码一起提交）；
3. `node dev/tests/smoke.test.mjs` → `RESULT OK passed=55 failed=0`。

### 并行纪律

多个 agent 同时改**不同功能片段**时，只跑只读的 `node dev/tools/check.mjs`，
不要跑 `build.mjs`（它会写 `lib/host.js`，与其它改动竞争）；改完后由一人统一 `build.mjs` 生成产物。

### 仓库约定

- **源码、工具、测试都在版本库里**：`dev/src/`（分层源码）、`dev/tools/`（构建与门禁）、`dev/tests/`（回归）。
  它们在 `package.json` 的 `files` 之外，因此**不会被发进 npm 包**——发布物只有
  `package.json`、`cordis.patch.yml`、`dsh.plugin.json`、`lib/`、`README.md`、`LICENSE`；
- 只有「跑起来才会产生、删掉也能再生」的东西才进 `缓存/`（该目录被 [.gitignore](.gitignore) 忽略），
  见 [`缓存/说明.md`](缓存/说明.md)；
- 代码按功能分层存放，不堆在一个文件里（详见[功能分层约定](#功能分层约定)）。

### 贡献

欢迎提交 issue 与 PR。动手前请先读 [`dev/src/README.md`](dev/src/README.md) 的分层地图与依赖方向，
并保证上面三条提交前检查全绿；涉及行为变化时，请同步补 `dev/tests/smoke.test.mjs` 的断言与本文档。

---

## 适配改动一览

在 `0.2.0-rc.2` 上修复的问题：

| # | 严重度 | 问题 | 修法 |
| --- | --- | --- | --- |
| B1 | **阻断** | 桌面版下所有 POST 恒 403（`dsh-app://` 转发会删掉 Origin，旧栅栏「无 Origin 拒绝写方法」） | 信任栅栏改为与官方 `isTrustedApiRequest` 同语义：无 Origin 放行 + 同源精确比对 + socket 远端校验 |
| B2 | 功能失效 | 安装 / 卸载硬编码 `<工作区>/apps/cli/lib/bin.js`（只存在于 DSH 源码仓库） | 改为解析桌面版 CLI（`resources/runtime/cli`）与当前 profile |
| B3 | 功能失效 | `pnpm pack` 依赖 PATH 上的全局 pnpm，桌面版只有内置 pnpm | 定位 DSH 内置 `resources/runtime/pnpm`，并保留工作区 / PATH 兜底 |
| B4 | 中 | 面板调用不存在的路由 `/api/host.pickDirectory` | 改调真实路由 `/packer2/api/browse/pick`（原生目录选择） |
| B5 | 中 | 悬浮按钮用了不存在的设计 token `--dsw-alias-bg`，暗色下白底浅字 | 换用官方语义 token，并清理 `var(--dsw-…)` 的字面量兜底 |
| B6 | 低 | 文档写「请求体上限 10MB」，代码是 80MB | **改文档不改代码**，按 `MAX_BODY_BYTES` 更正（见[安全与限额](#安全与限额)） |
| B7 | 低 | `void autoRestoreResident(ctx)` 无 catch，可能未处理拒绝 | 补 `.catch`，用 `safeErrorMsg` 脱敏后输出 |
| B8 | 低 | `/api/browse/pick` 重复调用 `svc.capability()`、未使用变量 | 缓存能力探测结果，清理未用变量 |
| B9 | **阻断** | 工作区根目录解析错：只读部署兜底 `sandboxPolicy.workspaceRoot`，产物 / 收藏落到 profile 目录 | 按官方规范 `agent.session.header.cwd ?? sandboxPolicy.workspaceRoot` 重建解析链，并给收藏加旧位置回读兜底 |
| B10 | **阻断** | 写入的沙箱策略仍走部署兜底根：全局 HTTP 路由下 `ctx.sandboxPolicy.resolve()` 的根是 profile 目录（不是会话工作区），于是工作区内的写入被判越界——`fs` 报 `file access denied under workspace-write mode`，`pwsh` 的 `New-Item` 报「对路径".packer2"的访问被拒绝」（导入 `.tgz`、上传、导出、打包、收藏都会中） | 新增 `workspaceWritePolicy(ws)`（`runtime/workspace`）：**工作区内的每一次 fs / shell 写入都显式带 `{ mode:'workspace-write', workspaceRoot:<本工作区> }`**，工作区外仍显式 `danger-full-access`；不再依赖部署兜底根 |

同批次还落地了：便携包默认导出完整定义（host + client）、便携包写盘不再依赖 PowerShell、
打包 / 清理目录与哈希计算跨平台化、临时插件运行默认零唤醒（`settleUserRun → agent.inject`）、
`.tgz` 直接当便携包用（系统 tar 解包 → 同一个 `define` 通道，**不安装**，见[产物格式](#产物格式)）、
工作区内写入显式钉住本工作区的沙箱策略（B10：`fs` 与 `pwsh` 两个沙箱都不再按部署兜底根把工作区判成越界）。

---

## 安全与限额

### 请求信任栅栏

`/packer2` 下的请求依次校验：

1. `Host` 必须是 loopback（`127.x.x.x` / `localhost` / `[::1]`），否则 403；
2. `Sec-Fetch-Site: cross-site` 直接拒绝；
3. socket 远端地址必须是 loopback（纵深防御，IPv4-mapped 归一化）；
4. `Origin` **缺失即放行**——与官方 `dsh-client-connection` 的 `isTrustedApiRequest` 同语义。
   桌面版 `dsh-app://` 代理转发会删掉 `Origin` 与 `Sec-Fetch-Site`，旧规则因此让桌面版每个 POST 恒 403。
   跨站浏览器写请求必带 `Origin`，带上时仍走第 5 步的精确比对；DNS rebinding 伪造不了 `Host`。
5. `Origin` 存在时按 `scheme://host:port` 精确比对，非 loopback / 端口不符一律拒绝。

### 限额

| 项 | 值 | 实现 |
| --- | --- | --- |
| HTTP 请求体上限 | **80 MB**，超限统一 413 | `dev/src/packages/base/http-io.js` `MAX_BODY_BYTES` |
| 面板上传单个文件 | 50 MB | `dev/src/packages/ui/page.js` |
| 上传体 base64 上限 | 70 MB | `dev/src/packages/cordis/pack.js` |

三个值互相自洽：50 MB 原始文件 → base64 约 66.7 MB < 70 MB < 80 MB。
上游 README 写的「10MB」是**文档错误**，本版按代码更正（B6），未改动代码。

其它：安装 / 卸载 / 工作区外输出需提升沙箱权限；导入会在 DSH 进程内执行包内代码，
**只导入可信来源的便携包**；错误信息输出前会剥离绝对路径并截断超长片段。

---

## 已知限制

- **会话级动态插件是进程级状态**：DSH 重启后需重新导入 / 恢复；便携定义文件（`.dshplugin.json`）与 `.tgz` 包才是持久产物
  （`.tgz` 走便携导入同样只在当前进程生效，要跨重启请收藏 / 常驻，或走 `dsh plugin add` 真实安装）。
- **装到 `desktop` profile 需完全退出桌面版**（官方 `requireDesktopProfile` 约束），装 `web` profile 则重启对应进程即可。
- **index 注入行表在启动时收集一次**：运行时新导入的动态插件不会立刻长出悬浮按钮，需要重启 DSH。
- **多会话并存时工作区可能退回部署兜底**：HTTP 请求没有 agent 上下文，`workspaceRoot` 解析链通常拿不到
  `currentInitiator()`，且要求**恰好一个 root 会话**；多会话并存时会退回 `sandboxPolicy.workspaceRoot`
  （桌面版进程 cwd = profile 目录），产物 / 收藏可能落到 `<profile>/`。这是「插件是全局 webServer 路由、
  工作区是 per-session 概念」的固有张力；会话归属已通过 `GET /api/sessions` + 面板会话下拉缓解。
- **`lib/client.js` 是唯一的 client 半区**，默认不安装；它的自动装入会让 `client-pending` 的包在本页执行 client 代码，
  信任边界与「导入」一致——只导入可信来源。装 client 半区前请先确保能回滚（保留一份不含 `lib/client.js` 的包）。
- **便携包目前主要在 Windows 验证**，跨平台路径已做适配但未全面实测。
- **工作区外输出 / 安装需要沙箱提升**：建议给插件创作单独建一个工作区。

---

## 许可证

[MIT](LICENSE) © 2026 LA7-F

## 相关链接

- 上游仓库：GitHub <https://github.com/LA7-F/dsh-MyCordis> ｜ Gitee <https://gitee.com/LA7_F/dsh-MyCordis>
- [Cordis](https://github.com/cordiverse/cordis) —— 底层插件运行时
- [src/README.md](dev/src/README.md) —— 17 个功能分包的分层地图与改码流程
