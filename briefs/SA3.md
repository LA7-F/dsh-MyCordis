# SA3 任务书 —— 面板页面与悬浮按钮修复

工作区（会话当前目录）：E:\结果插件\myCordisChange
先完整阅读 mycordis-v2/ADAPTATION.md 第 6 节，再动手。

## 背景
dsh-mycordis 的 UI 分两部分，都在同一个 host.js 里（已拆到 src/part2-page.js）：
- buttonScript()：注入到 DSH 页面 <body> 的脚本，在右下角加一个「我的Cordis」悬浮按钮，点开 iframe 面板；
- pageHtml(embed)：面板页面本体（独立 HTML，自带 <script> 与 CSS）。

## 你唯一可改的文件
mycordis-v2/src/part2-page.js

## B4 死路由
pageHtml 内嵌脚本里的 pickNative() 往 '/api/host.pickDirectory' 发 POST
（路由表里没有这个路由，而且它少了 /packer2 前缀）。当前靠 .catch 回落到 pickClassicInto 才没炸，
但每次点「浏览」都会先打一个必然 404 的请求。
改法：删掉这条 RPC 分支，让 pickInto() 直接调用 API + '/browse/pick'
（GET /packer2/api/browse 实测返回 {"kind":"native"}；/api/browse/pick 在 native 后端下返回 {picked}）。
先 grep 出 API 常量定义看清它是什么，别改坏其它调用；kind === 'browse' 时的行为不要退化。

## B5 不存在的设计 token
buttonScript() 里用了：
  background: var(--dsw-alias-bg, rgba(255,255,255,.92))
--dsw-alias-bg 在上游 design-platform.css 里零命中（已实测）。因为 var() fallback 合法，
浏览器静默用白色 → 暗色模式下白底 + 浅色字，几乎不可读。
改法：换成官方语义 token，例如 var(--dsw-specific-menu, ...)（等价于 bg-layer-3）。
同时把 buttonScript() 里所有 var(--dsw-..., <颜色字面量>) 形式的 fallback 排查一遍并在汇报里列出；
能替换成合法 token 的就替换。合法 token 有：
--dsw-alias-border-l1 / -l2 / --dsw-alias-label-primary / -secondary / -tertiary /
--dsw-alias-bg-base / -layer-1 / -layer-2 / -layer-3 / --dsw-specific-menu /
--dsw-alias-state-business-primary。

## 可选
面板页面本身是独立文档（自带 --bg/--panel 等变量），不要大改。
但如果 ?embed=1 嵌进暗色界面时明显不可读，可加 minimal 的 @media (prefers-color-scheme: dark) 变量覆盖，
并在汇报里说明取舍。

## 硬纪律
- 只改 mycordis-v2/src/part2-page.js。不要动别的子 agent 的文件，不要改 mycordis-v2/tools/ 下任何文件。
- 改完只跑：node mycordis-v2/tools/check.mjs（只读），必须 CHECK OK。
- 绝对不要跑 tools/build.mjs（它会写 host.js，与其他 agent 竞争）。
- part2-page.js 是模板字符串里的 HTML/JS，注意反引号与插值的转义不要被破坏；它会被原样拼进 async 函数体。
- 不要发明 API。

## 验收
1. node mycordis-v2/tools/check.mjs → CHECK OK。
2. 另写临时脚本（放 %TEMP%，不要留在工作区），直接对 src/part2-page.js 文本做断言：
   (a) 不含 'host.pickDirectory'；(b) 不含 '--dsw-alias-bg'；(c) 含 '/browse/pick'；
   (d) 用正则抠出 pageHtml 返回的 <script> 内容能被 new Function 编译（语法正确）。
   把脚本输出贴进汇报。

## 汇报格式（简洁中文）
- 改了哪个文件；B4 / B5 各一句话；排查出的 fallback 颜色字面量清单；check.mjs 与断言结果；遗留风险。
- 不要贴大段代码。
