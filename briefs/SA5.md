# SA5 任务书 —— 旧动态插件 shell.run 迁移

工作区（会话当前目录）：E:\结果插件\myCordisChange

## 背景
0.2.0-rc.2 / cordis 4.0.4 的 shell seam 里没有 shell.run(spec) 这个方法了。
现行调用链（证据：asar 内 dsh-pwsh-local/lib/index.js 的 resolve/execute）是：
  const spec = shell.resolve({ command, workdir, timeoutMs, sandboxPolicy })
  const handle = await shell.execute(spec)
  const res = await handle.result()      // { exitCode, stdout:{text}, stderr:{text} }
工作区里还有两个旧动态插件在调用已被删除的 shell.run。

## 你唯一可改的文件
1. 版本1.2.0/packr-5-pkg-10/host.js
2. 版本1.2.0/packr-5-pkg-10/extracted/package/host.js
3. 版本1.1.0/instmg-3-pkg-3/extracted/package/host.js
4. 版本1.2.0/packr-5-pkg-10/packr-5-pkg-10.dshplugin.json  （内嵌 "host" 源码字符串，需与 1 同步）
5. 版本1.1.0/instmg-3-pkg-3/instmg-3-pkg-3.dshplugin.json  （内嵌 "host" 源码字符串，需与 3 同步）
不要改其它任何文件。

## 要做的事
逐处修改：
- 把  const res = await shell.run(spec)
  改成  const res = await (await shell.execute(spec)).result()
- 把守卫里的  typeof shell.run !== 'function'
  改成  typeof shell.execute !== 'function'

已知命中位置（行号仅供参考，请自行核对上下文）：
- 版本1.2.0/packr-5-pkg-10/host.js:38,43,71,73
- 版本1.2.0/packr-5-pkg-10/extracted/package/host.js:39,44,72,74
- 版本1.1.0/instmg-3-pkg-3/extracted/package/host.js:13,15,19,21,117

保持原有语义：
- runShell 类助手会检查 res.exitCode !== 0 并抛错 —— 继续如此；
- dshHome 只取 stdout.text 的第一行 —— 继续如此；
- 有的调用原本是 await shell.run(spec) 直接拿结果，不要漏掉 result() 那一层。

.dshplugin.json 里的 host 是 JSON 字符串（换行以 \n 转义）。改完必须：
- 文件仍能被 JSON.parse；
- parse 出来的 host 源码里不再出现 shell.run；
- 与对应 host.js 语义一致（换行/转义风格可不同，但不得语法错误）。

## 硬纪律
- 只改上面列的 5 个文件。
- 不要顺手改这些插件里的其它调用（locateCli、pnpm、directoryPicker、writeAny 等）——那是别的 agent 的范围；
  本任务只做 shell.run → execute/result 这一项。
- 这些是 .dshplugin.json 归档文件，改完不要重新生成、不要格式化整份 JSON（保持原有结构，只改字符串内容）。

## 验收
对每个改过的 host.js 与 .dshplugin.json 内嵌的 host 源码：
  new Function('return (async () => {' + String.fromCharCode(10) + code + String.fromCharCode(10) + '})()')
能编译并求值返回对象（桩 ctx 不需要真的执行 apply），证明无语法错误。
JSON 文件用 JSON.parse 验证。把验证脚本输出贴进汇报。

## 汇报格式（简洁中文）
- 改了哪几个文件、每个文件改了几处；验证结果（编译/解析）；
- 遗留风险（例如 .dshplugin.json 与 host.js 之间是否本就有其它漂移）。
