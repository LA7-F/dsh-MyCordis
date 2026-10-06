# SA4 任务书 —— 回归测试与实测脚本

工作区（会话当前目录）：E:\结果插件\myCordisChange
先完整阅读 mycordis-v2/ADAPTATION.md（尤其第 3、4、5、6、8 节），再动手。

## 背景
MyCordis 的 host 半区已机械拆成三段：mycordis-v2/src/part1-core.js + part2-page.js + part3-api.js。
它们按序拼接后是一个 async 函数体：
  const code = 三段按序拼接;
  const plugin = await new Function('return (async () => {' + String.fromCharCode(10) + code + String.fromCharCode(10) + '})()')();
返回 { inject, apply }。加载方式可参考 mycordis-v2/tools/check.mjs（直接照抄它的加载法最保险）。

## 你唯一可改/新建的文件
mycordis-v2/tests/ 下的一切。
严禁修改 mycordis-v2/src/、mycordis-v2/host.js、mycordis-v2/tools/ 下的任何文件。

## tests/_harness.mjs
1) loadPlugin()：按上面的方式加载三段拼接并返回 plugin（不要读 host.js，它可能落后于 src）。
2) makeCtx(overrides)：最小桩 ctx ——
   on(name, fn) 记录订阅，并支持触发 webserver/index-inject（传一个 table 数组给所有订阅者）；
   effect(fn, label) 立即执行 fn 并返回 disposer；
   webServer.register(route) 捕获 route.handler 并返回 disposer；
   get(name) 返回注入的服务桩（可用 overrides 覆盖各服务）；logger / console 静默。
3) startServer(handler)：用 node:http 起临时服务器，把 (req,res) 交给 handler，返回 { url, port, close }。

## tests/host-router.test.mjs（核心）
用 node:assert + 自写 mini runner，不引入任何依赖，不 npm install。必须覆盖：
1) 信任栅栏矩阵 —— ADAPTATION.md 第 3 节表格的 13 行，逐条断言；
2) 路由矩阵 —— GET /packer2（200，HTML 含「我的Cordis」）、/packer2/api/plugins、
   /packer2/api/installed?profile=x、/packer2/api/browse、/packer2/api/favorites 的状态码与 JSON 形状；
   未知路径 404；POST /packer2/__probe__（不存在的路径）无 Origin 时必须不是 403（打过补丁后应为 404）；
3) 请求体 —— 非法 JSON → 400；超大 body → 413；
4) 收藏 round-trip —— fs 桩指向 os.tmpdir() 下临时目录，依次 POST /api/favorite 的 add / resident / remove，
   再 GET /api/favorites，断言符合预期；
5) 安装链路命令构造 —— 若 src 里已有 resolveDshCli，构造 shell 桩让它命中某条候选，
   断言最终执行命令含 'plugin --profile' 与 ' add '，且当工作区没有 apps/cli 时不会拼出 apps/cli/lib/bin.js。
   若 resolveDshCli 尚未落地，这条标 SKIP 并在输出里说明。
最后打印  RESULT OK passed=N failed=0 ，失败则非零退出码。

## tests/live-e2e.mjs（零副作用实测）
目标 http://127.0.0.1:19387（Electron 桌面版 GUI）。只做：
- GET /packer2、/packer2/api/plugins、/packer2/api/installed?profile=desktop、/packer2/api/browse、/packer2/api/favorites；
- POST /packer2/__probe__ 分别带 Origin 与不带 Origin。
只打这个不存在的路径，绝不调用任何会改状态的接口。
打印对照表：未打补丁时「无 Origin」应为 403；已打补丁后应为 404。
用 Node 24 自带的 fetch 实现，不引入依赖。

## 硬纪律
- 只新建/修改 mycordis-v2/tests/ 下的文件。
- 测试要面向 ADAPTATION.md 描述的**目标语义**写，而不是迁就当前有 bug 的实现。
- 绝对不要跑 tools/build.mjs；可以跑 node mycordis-v2/tools/check.mjs（只读）。
- 不要为了让测试通过去改 src（你没有权限，也不许）。

## 验收
1) node mycordis-v2/tests/host-router.test.mjs 可运行；把当前 src（尚未完成改造时）的预期失败项列清楚。
2) node mycordis-v2/tests/live-e2e.mjs 跑一次，给出当前真实结果（未打补丁时无 Origin POST 应为 403）。
3) 汇报里给出运行命令与精简结果，不要贴整份测试文件。

## 汇报格式（简洁中文）
- 新建了哪些文件；各文件跑了什么、当前通过/失败数；预期改造完成后才会变绿的具体断言；
- live-e2e 的真实输出摘要。
