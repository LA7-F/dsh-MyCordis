# SA1 任务书 —— 信任栅栏修复

工作区（会话当前目录）：E:\结果插件\myCordisChange

先完整阅读 mycordis-v2/ADAPTATION.md（调研规格，含每条结论的证据来源），再动手。

## 背景
dsh-mycordis v0.1.1 是「我的Cordis」插件，要适配正式版 DeepSeek Harness 桌面版 0.2.0-rc.2 / cordis 4.0.4。
桌面版用 dsh-app:// 协议代理转发页面请求，转发前删掉 origin / sec-fetch-site 头，
而 host.js 的信任栅栏写着「没有 Origin 就拒绝写方法」，导致桌面版里每个 POST 恒 403。
实测（未打补丁）：POST /packer2/__probe__ 无 Origin → 403；带 Origin: http://127.0.0.1:19387 → 404。

## 你唯一可改的文件
mycordis-v2/src/part1-core.js

## 要做的事（照 ADAPTATION.md 第 3 节 B1）
1. 把 isTrustedRequest 里这一行
   if (origin === undefined) return !writeMethod
   改成无 Origin 即放行（return true）。
2. 其余检查一条不减、并确保仍然生效：
   - socket.remoteAddress 必须 loopback；
   - Host 头必须存在、是 loopback 主机名、且端口等于服务端口；
   - Origin 存在时与 Host 精确同源（scheme://host:port）比对；
   - Origin 为字符串 "null" 时拒绝；
   - sec-fetch-site: cross-site 时拒绝。
3. 在代码里保留说明注释，解释为什么「Origin 缺失即放行」是安全的（对齐 DSH 自家 isTrustedApiRequest 的注释：
   跨站浏览器写请求一定带 Origin；DNS rebinding 被「Host 必须 loopback」挡下；非浏览器客户端本就受信任）。
4. 顺带（第 7 节 B6）：MAX_BODY_BYTES 保持 80*1024*1024 不改，只在其上方补一行注释，
   说明它与 README 里「10MB」的表述不一致、已决定以代码为准、文档待同步。

已验证过的参考实现与断言在：mycordis-fix/apply-fix.mjs（补丁正文）、mycordis-fix/verify-fix.mjs（13 条断言）。

## 硬纪律
- 只改 mycordis-v2/src/part1-core.js。不要动别的子 agent 的文件，不要改 mycordis-v2/tools/ 下任何文件。
- 改完只跑：node mycordis-v2/tools/check.mjs（只读，不写文件），必须 CHECK OK。
- 绝对不要跑 tools/build.mjs（它会写 host.js，与其他 agent 竞争）。
- part1-core.js 会被原样拼进一个 async 函数体（new Function 求值），不得出现 import/export，不得重复声明顶层 const/let。
- 不要发明 API。

## 验收
1. node mycordis-v2/tools/check.mjs → CHECK OK。
2. 另写一个临时脚本（放 %TEMP%，不要留在工作区）：把 part1-core.js 的
   defaultPort / parseAuthority / isLoopbackHostname / parseOrigin / isTrustedRequest 抠出来求值，
   跑完 ADAPTATION.md 第 3 节表格里的 13 条断言，全过。把脚本输出贴进汇报。

## 汇报格式（简洁中文）
- 改了哪个文件；每处改动一句话；check.mjs 与 13 条断言的结果；遗留风险。不要贴大段代码。
