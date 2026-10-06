# SA6 任务书 —— 修 B9：工作区根目录解析

工作区（会话当前目录）：E:\结果插件\myCordisChange
先读 mycordis-v2/ADAPTATION.md 的**第 11 节 B9**（含真机证据与官方规范），再动手。

## 背景（一句话）
MyCordis 的 workspaceRoot() 只读 sandboxPolicy.workspaceRoot，那是**部署兜底**；
桌面版进程 cwd = profile 目录，于是产物/收藏全落到 C:\Users\...\.dsh\profiles\desktop\。
官方规范是 agent.session.header.cwd ?? sandboxPolicy.workspaceRoot。

## 你可改的文件（只此三个）
1. mycordis-v2/src/part3-api.js        —— 改 workspaceRoot()，并给 readFavorites() 加迁移兜底
2. mycordis-v2/tests/_harness.mjs      —— 让桩 ctx 支持注入 agents
3. mycordis-v2/tests/host-router.test.mjs —— 补 B9 断言
4. mycordis-v2/README.md               —— 在「已知约束」补一条局限说明

## 要做的事

### 1) workspaceRoot(ctx) 新解析链（严格按此顺序）
1. ctx.get('agents')：
   - 若 agents.currentInitiator 是函数，取 currentInitiator()，读 agent.session.header.cwd（非空字符串则返回）；
   - 否则若 agents.roots 是函数且 roots().length === 1，读它的 session.header.cwd（非空则返回）。
   全部用 try/catch 包住，任何一步异常都继续往下走（不要抛）。
2. ctx.get('sandboxPolicy')：
   - 若 sp.resolve 是函数，sp.resolve()（无参）→ 取 .workspaceRoot（注意官方方法名是 **resolve**，不是 policy）；
   - 否则退回读 sp.workspaceRoot。
3. ctx.get('fs')：fs.processPath(await fs.resolve('.'))。
4. 返回 ''（调用方已有「无法确定工作区根目录」的报错，不要改那些调用方）。

读 cwd 的助手写成一个小函数（例如 sessionCwdOf(agent)），内部防御 agent / session / header / cwd 任一缺失。

### 2) readFavorites 迁移兜底
readFavorites(ctx) 若在**新位置**读不到文件（或解析失败），再尝试读旧的
`<sandboxPolicy.workspaceRoot>/packer2-favorites.json`（用 sp.resolve()/sp.workspaceRoot 取，注意用绝对路径）。
仍读不到才返回 { favorites: [] }。
writeFavorites 保持写新位置即可（不要双写）。

### 3) 测试（必须新增，且不得破坏现有 37 条）
在 host-router.test.mjs 里补：
- agents.currentInitiator() 返回带 session.header.cwd 的 agent → GET /api/plugins 的 defaultOutDir 前缀 = 该 cwd；
- currentInitiator 返回 undefined、agents.roots() 恰好 1 个且带 cwd → 同上；
- agents.roots() 返回 2 个 → 退回 sandboxPolicy（断言用的是 sandboxPolicy 桩给的根）；
- agents 完全缺失（get('agents') 返回 undefined）→ 退回 sandboxPolicy，且不抛。
必要时扩展 _harness.mjs 的 makeCtx 以注入 agents 与多 root。

## 硬纪律
- 只改上面列的 4 个文件。不要动 mycordis-v2/tools/、src/part1-core.js、src/part2-page.js、host.js。
- 改完跑：node mycordis-v2/tools/check.mjs（只读）→ 必须 CHECK OK；
  再跑 node mycordis-v2/tests/host-router.test.mjs → 必须 RESULT OK 且总数 ≥41。
- **绝对不要跑 tools/build.mjs**（协调者统一构建）。
- part3-api.js 会被原样拼进一个 async 函数体：不得 import/export，不得重复声明顶层 const/let。
- 不要发明 API：只按 ADAPTATION.md 第 11 节引用的官方实现写。

## 汇报（简洁中文）
改了哪几个文件、每条改动一句话、check.mjs 结果、回归通过数、以及你对「多会话并存仍退回兜底」这一局限的确认。
