# SA2 任务书 —— 安装/卸载 CLI 与 pnpm 适配

工作区（会话当前目录）：E:\结果插件\myCordisChange
先完整阅读 mycordis-v2/ADAPTATION.md，再动手。

## 背景
dsh-mycordis v0.1.1 要适配正式版桌面 DSH 0.2.0-rc.2。它的「安装/卸载插件」与「pnpm 打包」两条链路
都建立在「工作区就是 DSH 源码仓库」这一错误假设上，在普通工作区必然失败。

## 你唯一可改的文件
mycordis-v2/src/part3-api.js

## B2 安装/卸载的 CLI 定位（ADAPTATION.md 第 4 节）
现状：installBundle / uninstallBundle 硬编码
  const cliPath = ws + '/apps/cli/lib/bin.js'
并执行  node <cliPath> plugin --profile <p> add|remove <spec>。
该路径只在 DSH 源码仓库里存在（例：E:\harness\deepseek-harness-master\deepseek-harness-master\apps\cli\lib\bin.js）。

新增 async 助手 resolveDshCli(ctx)，按顺序探测并返回可拼进 PowerShell 的命令前缀：
1. 源码仓库：探测 <ws>/apps/cli/lib/bin.js 存在 → 用 node 调它；
2. 桌面打包版（优先）：
   - 若 typeof process !== 'undefined' 且 process.resourcesPath 存在：
     先试 <resourcesPath>/runtime/cli/bin/dsh.cmd（直接调）；
     否则  $env:ELECTRON_RUN_AS_NODE='1'; 然后  & "<process.execPath>" --expose-internals "<resourcesPath>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js>"
   - 所有路径都要用现有 sq() 做 PowerShell 单引号转义；
3. PATH 上的 dsh：用 shell 跑  $c = Get-Command dsh -ErrorAction SilentlyContinue; if ($c) { Write-Output $c.Source }
4. 全不命中：抛清晰错误并列出已探测的候选路径（不要静默失败）。

installBundle 与 uninstallBundle 都改用它。另外：官方 dsh-desktop-host/lib/cli.js 里的 requireDesktopProfile
明写「必须先完全退出桌面版，再运行 dsh plugin --profile desktop」，
所以 profile === 'desktop' 时成功与失败提示都要带上这条约束。

## B3 pnpm 定位（ADAPTATION.md 第 5 节）
现状：packSessionPlugin 直接跑  pnpm pack --reporter append-only --pack-destination <outDir>，依赖 PATH 上的全局 pnpm。
正式版自带 pnpm 11.7.0：<resourcesPath>/runtime/pnpm/bin/pnpm.mjs，
必须以 Electron 可执行文件 + ELECTRON_RUN_AS_NODE=1 + --expose-internals 调用。

新增 async 助手 resolvePnpm(ctx)，返回命令前缀，按序：
1. <resourcesPath>/runtime/pnpm/bin/pnpm.mjs 存在 →  $env:ELECTRON_RUN_AS_NODE='1'; 然后  & "<process.execPath>" --expose-internals "<pnpm.mjs>"
   （process 不可用时退化为 $env:DSH_DESKTOP_NODE_EXECUTABLE）；
2. <ws>/node_modules/.bin/pnpm 或 <ws>/node_modules/pnpm/bin/pnpm.cjs；
3. PATH 上的 pnpm；
4. 全不命中：清晰报错。
把 packSessionPlugin 里的 pnpm 调用改为用该前缀。探测可用 shell 的 Test-Path 或 fs 服务（两种形态都要能跑）。

## B7 / B8（ADAPTATION.md 第 7 节）
- apply 末尾的 void autoRestoreResident(ctx) 改为带 catch 的调用（只用 console 输出，不要假设 ctx.logger 存在）。
- /api/browse/pick 里 svc.capability() 被调两次 → 缓存到局部变量只调一次。
- packSessionPlugin 里若 const shell = ctx.get('shell') 确实未被使用，删掉它（先确认）。

## 硬纪律
- 只改 mycordis-v2/src/part3-api.js。不要动别的子 agent 的文件，不要改 mycordis-v2/tools/ 下任何文件。
- 改完只跑：node mycordis-v2/tools/check.mjs（只读），必须 CHECK OK。
- 绝对不要跑 tools/build.mjs（它会写 host.js，与其他 agent 竞争）。
- part3-api.js 会被原样拼进一个 async 函数体，不得出现 import/export，不得重复声明顶层 const/let。
- 只按 ADAPTATION.md 第 2 节已核实的真实 API 面写代码，不要发明 API。

## 验收
1. node mycordis-v2/tools/check.mjs → CHECK OK（它会报告 resolveDshCli / resolvePnpm 是否存在）。
2. 用 node 做一次行为小节验证：三段拼接 new Function 求值，用只实现 ctx.get 的桩确认返回对象带 apply 且不抛。

## 汇报格式（简洁中文）
- 改了哪个文件；resolveDshCli / resolvePnpm 的探测顺序与最终命令形态各一句话；check.mjs 结果；
- 遗留风险（尤其是无法在真实桌面环境外验证的部分）。不要贴大段代码。
