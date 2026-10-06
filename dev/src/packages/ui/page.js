// [ui/page] 「我的Cordis」面板页面（HTML/CSS/前端 JS 模板）
function pageHtml(embed) {
  const head = embed ? '' : '<header>我的Cordis <span class="sub">会话级动态插件 · 打包 / 安装 / 便携 / 管理与卸载</span></header>'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的Cordis</title><style>
/* ── 主题令牌：浅色 / 深色（跟随系统，Electron 下等价于 DSH 的深浅色设置） ── */
:root{
  --bg:#f2f4f7;--panel:#ffffff;--panel2:#f7f8fa;--panel3:#eceff4;
  --line:#e2e6ec;--line2:#eef1f5;
  --fg:#1f2329;--fg2:#4b5563;--muted:#8b93a0;
  --accent:#3b7cf6;--accent-weak:#eaf1ff;--accent-line:#cadcff;
  --ok:#1a7f37;--ok-weak:#e9f7ee;--ok-line:#c3e6cf;
  --err:#c0392b;--err-weak:#fdecea;--err-line:#f3c6c0;
  --warn:#8a5b00;--warn-weak:#fff5e0;--warn-line:#f0dcae;
  --r:10px;--r2:7px;--r3:5px;
  --shadow:0 1px 2px rgba(16,24,40,.05);
  --mono:"Cascadia Code",Consolas,"SFMono-Regular",Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#15171a;--panel:#1d2024;--panel2:#23272c;--panel3:#2b3037;
  --line:#31363d;--line2:#282c32;
  --fg:#e7e9ec;--fg2:#b7bec8;--muted:#838b96;
  --accent:#5c95ff;--accent-weak:#1c2b45;--accent-line:#2c4570;
  --ok:#5cc97c;--ok-weak:#16281c;--ok-line:#27503a;
  --err:#ff7f70;--err-weak:#2e1a18;--err-line:#5c2f2a;
  --warn:#e6b34a;--warn-weak:#2b2416;--warn-line:#54452a;
  --shadow:0 1px 2px rgba(0,0,0,.32);
}}
/* ── 基础 ── */
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0}
body{background:var(--bg);color:var(--fg);font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:var(--line);border:3px solid transparent;border-radius:8px;background-clip:content-box}
*::-webkit-scrollbar-thumb:hover{background:var(--muted);border:3px solid transparent;background-clip:content-box}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px;border-radius:var(--r3)}
header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;background:var(--panel);border-bottom:1px solid var(--line);font-weight:700;font-size:14px}
header .sub{font-weight:400;font-size:11px;color:var(--muted)}
/* ── 页签：分段胶囊 ── */
nav{display:flex;gap:4px;padding:8px 10px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:6}
nav button{height:32px;padding:0 14px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--fg2);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s,box-shadow .15s}
nav button:hover{background:var(--panel2);color:var(--fg)}
nav button.active{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;box-shadow:0 1px 3px rgba(59,124,246,.32)}
/* ── 版面 ── */
main{padding:12px;max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:10px}
.view{display:flex;flex-direction:column;gap:10px}
.box{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:12px}
.box>.section:first-child{margin-top:0}
.section{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12.5px;font-weight:600;color:var(--fg);margin:14px 0 6px}
.section::before{content:"";flex:none;width:3px;height:13px;border-radius:2px;background:var(--accent)}
.section .hint{font-weight:400}
.desc{font-size:11.5px;line-height:1.7;color:var(--fg2);margin:0 0 8px}
.desc b{color:var(--fg);font-weight:600}
/* 长说明默认折叠：面板只有 560~680px 宽，整段文字会把真正要操作的东西挤下去 */
.note{background:var(--panel2);border:1px solid var(--line2);border-radius:var(--r2);margin:0 0 9px;padding:0 10px}
.note>summary{display:flex;align-items:center;gap:6px;padding:7px 0;font-size:11.5px;color:var(--muted);cursor:pointer;list-style:none;user-select:none}
.note>summary::-webkit-details-marker{display:none}
.note>summary::before{content:"▸";font-size:10px;transition:transform .15s}
.note[open]>summary::before{transform:rotate(90deg)}
.note>summary:hover{color:var(--accent)}
.note>.desc{margin:0;padding:0 0 9px}
/* ── 表单控件 ── */
label{display:block;font-size:11.5px;color:var(--muted);margin:0 0 5px}
input[type=text],select{width:100%;height:30px;padding:0 9px;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);color:var(--fg);font:inherit;font-size:12.5px;transition:border-color .15s,box-shadow .15s}
input[type=text]::placeholder{color:var(--muted)}
input[type=text]:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak)}
.btn{display:inline-flex;align-items:center;justify-content:center;flex:none;height:30px;padding:0 12px;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);color:var(--fg);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s,box-shadow .15s}
.btn:hover:not(:disabled){background:var(--panel3);border-color:var(--muted)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 1px 3px rgba(59,124,246,.32)}
.btn.primary:hover:not(:disabled){filter:brightness(1.07);background:var(--accent);border-color:var(--accent)}
.btn.danger{background:var(--err-weak);border-color:var(--err-line);color:var(--err);font-weight:600}
.btn.danger:hover:not(:disabled){background:var(--err);border-color:var(--err);color:#fff}
.btn:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
.row input[type=text]{flex:1;min-width:120px}
.chk{display:inline-flex;align-items:center;gap:5px;height:30px;font-size:12px;color:var(--fg2);white-space:nowrap;flex:none;cursor:pointer;user-select:none}
.chk input{margin:0;accent-color:var(--accent)}
.hint{color:var(--muted);font-size:11.5px}
.ok{color:var(--ok)}.err{color:var(--err)}.warn{color:var(--warn)}
/* ── 列表 ── */
ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);max-height:340px;overflow:auto;overscroll-behavior:contain}
.table{border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);overflow:hidden}
.table ul{border:none;border-radius:0;max-height:300px}
.ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid{display:grid;grid-template-columns:22px minmax(0,1fr) 96px 118px 58px;gap:8px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--line2);font-size:12.5px;min-width:0}
.grid:last-child{border-bottom:none}
.grid:not(.head):hover{background:var(--panel2)}
.grid.head{position:sticky;top:0;z-index:1;background:var(--panel);font-size:10.5px;color:var(--muted);letter-spacing:.03em;border-bottom:1px solid var(--line)}
.grid input[type=checkbox]{margin:0;accent-color:var(--accent)}
.grid select{height:26px;font-size:12px}
.name{font-weight:600;font-size:12.5px}
.id{font-family:var(--mono);font-size:10.5px;color:var(--muted)}
.grid .mini{height:24px;padding:0 8px;border:1px solid var(--line);border-radius:var(--r3);background:var(--panel2);color:var(--fg2);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.grid .mini:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-weak)}
/* ── 已安装插件行：名称 + 标签一行，来源路径一行 ── */
.mitem{display:flex;align-items:center;gap:10px;padding:9px 11px;border-bottom:1px solid var(--line2);font-size:12.5px;min-width:0}
.mitem:last-child{border-bottom:none}
.mitem:not(.head):not(.loading):not(.fail):hover{background:var(--panel2)}
.mitem .mi-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.mitem .mi-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.mitem .nm{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.mitem .mono{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mitem .mono.link{color:var(--fg2)}
.mitem.loading,.mitem.fail{color:var(--muted);justify-content:center;font-size:12px}
.mitem.fail{color:var(--err)}
.tag{display:inline-flex;align-items:center;flex:none;height:16px;padding:0 6px;border:1px solid transparent;border-radius:999px;background:var(--panel3);color:var(--muted);font-size:10px;line-height:1;white-space:nowrap}
.tag.bundle{background:var(--accent-weak);border-color:var(--accent-line);color:var(--accent)}
.tag.self{background:var(--warn-weak);border-color:var(--warn-line);color:var(--warn)}
.tag.miss{background:var(--err-weak);border-color:var(--err-line);color:var(--err)}
/* ── 插件卡片 ── */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}
.card{min-height:134px;max-width:300px;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);padding:8px;display:flex;flex-direction:column;gap:5px;position:relative;min-width:0;overflow:hidden;transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:var(--accent-line);box-shadow:var(--shadow)}
.card .star{position:absolute;top:4px;right:4px;width:22px;height:22px;background:none;border:none;border-radius:6px;cursor:pointer;font-size:14px;line-height:1;color:#d4a017;padding:0}
.card .star:hover{background:var(--panel3)}
.card .cname{font-weight:600;font-size:11.5px;line-height:1.3;padding-right:20px;height:30px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;flex:none}
.card .cid{font-family:var(--mono);font-size:9.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
.card select{width:100%;height:24px;font-size:10.5px;flex:none}
/* 四个动作压在一行（运行 / 常驻 / 恢复 / 复制）：等分 + 省略号，多一个动作也不会换行 */
.card .cactions{display:flex;gap:3px;margin-top:auto;flex:none}
.card .cactions button{flex:1 1 0;min-width:0;height:24px;padding:0;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--line);border-radius:var(--r3);background:var(--panel2);color:var(--fg2);font:inherit;font-size:10.5px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.card .cactions button:hover:not(:disabled){border-color:var(--muted);color:var(--fg)}
.card .cactions button:disabled{opacity:.4;cursor:not-allowed}
.card .cactions .resbtn.on{background:var(--accent-weak);border-color:var(--accent-line);color:var(--accent);font-weight:600}
.card .cactions .runbtn{background:var(--ok-weak);border-color:var(--ok-line);color:var(--ok);font-weight:600}
.card .cactions .runbtn:hover:not(:disabled){border-color:var(--ok);color:var(--ok)}
.empty{grid-column:1/-1;color:var(--muted);font-size:12px;padding:18px 12px;text-align:center}
li.empty{display:block}
/* ── 底部运行日志：空则折叠，出结果自动展开 ── */
.console{position:sticky;bottom:0;z-index:5;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:0 -2px 12px rgba(16,24,40,.07);overflow:hidden}
.console-hd{display:flex;align-items:center;background:var(--panel2);border-bottom:1px solid transparent}
.console:not(.collapsed) .console-hd{border-bottom-color:var(--line2)}
.chd-main{display:flex;align-items:center;gap:7px;flex:1;min-width:0;height:32px;padding:0 10px;border:none;background:none;color:var(--fg2);font:inherit;font-size:11.5px;cursor:pointer;text-align:left}
.chd-main:hover{color:var(--fg)}
.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--muted);opacity:.55}
.dot.ok{background:var(--ok);opacity:1}.dot.err{background:var(--err);opacity:1}.dot.warn{background:var(--warn);opacity:1}
.chd-main .chev{display:block;flex:none;width:0;height:0;margin-left:auto;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--muted);transition:transform .15s}
.console:not(.collapsed) .chd-main .chev{transform:rotate(180deg)}
.chd-x{flex:none;height:22px;margin-right:8px;padding:0 8px;border:1px solid var(--line);border-radius:var(--r3);background:var(--panel);color:var(--muted);font:inherit;font-size:10.5px;cursor:pointer}
.chd-x:hover{color:var(--fg);border-color:var(--muted)}
.console.collapsed #log{display:none}
pre{margin:0;padding:8px 11px;max-height:168px;overflow:auto;background:var(--panel);font-family:var(--mono);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-all}
#log>div+div{margin-top:2px}
#log>div.step{color:var(--fg2)}
</style></head><body>
${head}
<nav role="tablist">
  <button id="tabPack" class="active" role="tab" aria-selected="true">打包</button>
  <button id="tabInst" role="tab" aria-selected="false">安装</button>
  <button id="tabTemp" role="tab" aria-selected="false">临时插件</button>
  <button id="tabMgmt" role="tab" aria-selected="false">管理与卸载</button>
</nav>
<main>
<div id="viewPack" class="view">
  <div class="box">
    <label for="outDir">放置目录（打包产物输出目录）</label>
    <div class="row"><input id="outDir" type="text" spellcheck="false" placeholder="选择或粘贴打包产物输出目录"><button id="browse" class="btn">浏览…</button><button id="refresh" class="btn">刷新列表</button></div>
  </div>
  <div class="box">
    <div class="section">会话级动态插件</div>
    <label for="ptype">打包类型（勾选插件后一键打包，或点每行「打包」单打）</label>
    <div class="row">
      <select id="ptype" style="flex:1;min-width:180px"><option value="dsh">dsh 包（.tgz，真实安装）</option><option value="portable">便携包（host + client 完整定义）</option><option value="whole">整包（dsh 安装包 + 便携包）</option></select>
      <label class="chk" title="便携包默认把 host 与 client 半区一起导出，导入别的会话/机器后插件 UI 同样能复现；勾上则只留 host 半区（更小，但带 client UI 的插件会丢失界面）。"><input type="checkbox" id="ppure">仅 host 半区</label>
      <label class="chk"><input type="checkbox" id="all">全选</label>
      <button id="batch" class="btn primary">一键打包</button>
    </div>
    <div id="hint" class="hint" style="margin:8px 0 6px"></div>
    <div class="table">
      <div class="grid head"><span></span><span>插件名</span><span>插件 ID</span><span>版本</span><span>操作</span></div>
      <ul id="list"></ul>
    </div>
  </div>
</div>
<div id="viewInst" class="view" hidden>
  <div class="box">
    <div class="section">① 安装 dsh 包（真实安装，重启 dsh 生效）</div>
    <div class="desc">选择 .tgz 文件，自动上传并安装（等价于 dsh plugin add），需批准提升权限。</div>
    <div class="row"><input id="iprofile" type="text" value="web" placeholder="profile（默认 web）"><input id="ifile" type="file" accept=".tgz,.dshplugin,application/gzip" style="display:none"><button id="ibtn" class="btn primary">安装 dsh 包</button></div>
  </div>
  <div class="box">
    <div class="section">② 导入便携包（注册为临时插件，非真实安装）</div>
    <details class="note"><summary>说明与注意事项</summary>
      <div class="desc">⚠ 导入会在 dsh 进程内执行包内代码，请只导入可信来源的文件。<b>两种文件都不安装</b>：不写 $DSH_HOME/profiles、不用选 profile、不用重启 dsh，只在当前进程注册为临时插件（重启即消失），一个文件一个插件。<br>· <b>.tgz</b>（dsh 包，推荐）：自动用系统 tar 解到工作区临时目录，取包内 host.js + client.js；<br>· <b>.dshplugin.json</b>（便携定义，旧格式）：直接给 host + client 两个半区。<br>导入后默认自动运行，且<b>一律走零唤醒通道</b>：host 半静默启动（<b>不唤醒会话、不花 token</b>）；带 client 半区的包停在「待页面装入」，去 DSH 侧边栏的 Cordis 面板点「运行」把 client 半装入本页（那条结算用 agent.inject，只注入一条上下文、同样不唤醒）。多会话并存时先用左侧「会话…」下拉选所属会话：选项按「历史对话标题 - 会话id」展示（能自动解析或只有一个存活会话时会预选，否则手填 id）。</div>
    </details>
    <div class="row"><select id="xsessSel" style="flex:none;width:190px" title="选择所属会话（多会话并存时必选；选中即回填右侧 id）"></select><input id="xsess" type="text" placeholder="所属会话 id（可空）"><input id="xfile" type="file" accept=".tgz,.json,.dshplugin.json,.dshplugin,application/gzip" style="display:none"><label class="chk"><input type="checkbox" id="xauto" checked>导入后自动运行</label><button id="xbtn" class="btn primary">导入便携包</button></div>
  </div>
</div>
<div id="viewMgmt" class="view" hidden>
  <div class="box">
    <div class="section">① 已安装 dsh 插件（常驻，重启生效）<span class="hint" id="instCount"></span></div>
    <details class="note"><summary>说明与注意事项</summary>
      <div class="desc">以 dsh.profile.bundles 为基准并集 dependencies（用户装的排前面，基础层沉底）；profile 按当前部署自动回填（可手改）；只有基础包不可卸载；卸载需批准提升权限，重启 dsh 生效。注意 profile=desktop 必须先完全退出桌面版，否则会被 package.json.lock 挡住。</div>
    </details>
    <div class="row" style="margin-top:0"><input id="mprofile" type="text" value="web" placeholder="profile（默认 web）"><button id="mrefresh" class="btn">刷新</button></div>
    <ul id="instList" style="margin-top:10px"></ul>
  </div>
</div>
<div id="viewTemp" class="view" hidden>
  <div class="box">
    <div class="section">① 临时插件（会话级，仅当前 dsh 进程）</div>
    <details class="note"><summary>说明与注意事项</summary>
      <div class="desc">来自「安装 → 导入便携包」的 .dshplugin.json：只在当前进程内注册，重启 dsh 即消失；常驻/收藏才会跨重启保留。☆ 收藏（仅显示卡片，不自动运行）/ 常驻（收藏 + 重启自动运行）/ 恢复（启动）/ 复制 / 同名合并版本。<br>token：运行<b>默认走零唤醒通道</b>（runHostHalf(requestId=null)，面板手势）——host 半静默启动，<b>不唤醒任何会话轮次</b>；带 client 半区的包停在「待页面装入」，去 DSH 侧边栏的 Cordis 面板点「运行」装入本页（settleUserRun → agent.inject，只注入一条上下文、不唤醒）。只有勾选「允许唤醒会话」才会退回会 agent.steer 的旧通道。</div>
    </details>
    <div class="row" style="margin-top:0"><button id="frestore" class="btn primary">恢复收藏</button><button id="dedupe" class="btn">去重</button><label class="chk" title="应急开关：退回 run() 请求通道，结算走 agent.steer（唤醒一轮、花 token）。零唤醒通道可用时不要勾。"><input type="checkbox" id="wakeok">允许唤醒会话（应急）</label></div>
  </div>
  <div class="box">
    <div class="section">①-1 已收藏 <span class="hint" id="favCount"></span></div>
    <div class="desc">来自收藏记录 packer2-favorites.json，重启后仍显示卡片；点 ★ 取消收藏会移入下方「未收藏」，下次重启消失。</div>
    <div id="favCards" class="cards"></div>
  </div>
  <div class="box">
    <div class="section">①-2 未收藏 <span class="hint" id="unfavCount"></span></div>
    <div class="desc">当前会话新建/导入且未收藏的插件；点 ☆ 收藏会移入上方「已收藏」，下次重启依旧存在。</div>
    <div id="unfavCards" class="cards"></div>
  </div>
</div>
<div id="console" class="console collapsed">
  <div class="console-hd">
    <button id="logToggle" class="chd-main" type="button" aria-expanded="false"><span id="logDot" class="dot"></span><span>运行日志</span><span id="logMeta" class="hint"></span><span class="chev"></span></button>
    <button id="logClear" class="chd-x" type="button" title="清空日志">清空</button>
  </div>
  <pre id="log"></pre>
</div>
</main>
<script>
(function () {
  'use strict'
  var API = '/packer2/api'
  var $ = function (id) { return document.getElementById(id) }
  // ── 运行日志：空则折叠在底部，出结果自动展开并置顶滚动 ────────────────────
  var logCount = 0
  function logPanel() { return $('console') }
  function setLogExpanded(on) {
    logPanel().className = 'console' + (on ? '' : ' collapsed')
    $('logToggle').setAttribute('aria-expanded', on ? 'true' : 'false')
  }
  function clearLog() { $('log').textContent = ''; logCount = 0; $('logMeta').textContent = ''; $('logDot').className = 'dot'; setLogExpanded(false) }
  function log(cls, text) {
    var el = document.createElement('div'); el.className = cls; el.textContent = text
    $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight
    logCount += 1
    $('logMeta').textContent = logCount + ' 条'
    if (cls === 'ok') $('logDot').className = 'dot ok'
    else if (cls === 'err') $('logDot').className = 'dot err'
    else if (cls === 'warn') $('logDot').className = 'dot warn'
    setLogExpanded(true)
  }
  $('logToggle').onclick = function () { setLogExpanded(logPanel().className.indexOf('collapsed') !== -1) }
  $('logClear').onclick = clearLog
  // ── 页签 ────────────────────────────────────────────────────────────────
  var TABS = [['tabPack', 'viewPack', 'pack'], ['tabInst', 'viewInst', 'install'], ['tabTemp', 'viewTemp', 'temp'], ['tabMgmt', 'viewMgmt', 'mgmt']]
  function switchTab(name) {
    TABS.forEach(function (t) {
      var isOn = t[2] === name
      $(t[1]).hidden = !isOn
      var b = $(t[0]); b.className = isOn ? 'active' : ''; b.setAttribute('aria-selected', isOn ? 'true' : 'false')
    })
    if (name === 'temp') loadTemp()
    if (name === 'mgmt') loadMgmt()
  }
  TABS.forEach(function (t) { $(t[0]).onclick = function () { switchTab(t[2]) } })
  function getCache(key) { try { var c = JSON.parse(localStorage.getItem('packer2-pick-cache') || '{}'); return c[key] || '' } catch (e) { return '' } }
  function setCache(key, val) { try { var c = JSON.parse(localStorage.getItem('packer2-pick-cache') || '{}'); c[key] = val; localStorage.setItem('packer2-pick-cache', JSON.stringify(c)) } catch (e) {} }
  function toggleAll(on) { var items = $('list').querySelectorAll('li'); for (var i=0;i<items.length;i++){ var c=items[i].querySelector('input[type=checkbox]'); if(c) c.checked = on } }
  $('all').onchange = function () { toggleAll($('all').checked) }
  function getChecked() { var out=[]; var items=$('list').querySelectorAll('li'); for (var i=0;i<items.length;i++){ var c=items[i].querySelector('input[type=checkbox]'); var s=items[i].querySelector('select'); if(c&&c.checked&&s) out.push({pluginId:c.getAttribute('data-plugin'), packageId:s.value}) } return out }
  function packOne(pluginId, packageId) {
    var type = $('ptype').value
    var outDir = $('outDir').value.trim()
    clearLog()
    if (type === 'whole') {
      log('step', '▸ 打包整包 ' + pluginId + '/' + packageId + '（dsh 安装包 + 便携包，一插件一子文件夹）…')
      fetch(API + '/pack-whole', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: [{ pluginId: pluginId, packageId: packageId }], outDir: outDir, pureHost: $('ppure').checked }) })
        .then(function (r) { return r.json() }).then(function (d) {
          ;(d.results || []).forEach(function (r) { if (r.ok) log('ok', '✔ ' + r.pluginId + '/' + r.packageId + ' → ' + r.dir + ' （' + r.tgzName + ' + ' + r.portableName + '）'); else log('err', '✘ ' + r.pluginId + '/' + r.packageId + '：' + (r.message || '失败')) })
        }).catch(function (e) { log('err', '✘ 请求失败: ' + e.message) })
      return
    }
    if (type === 'portable') {
      log('step', '▸ 导出 ' + pluginId + ' 便携包（host' + ($('ppure').checked ? '' : ' + client') + '）…')
      fetch(API + '/export-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: [{ pluginId: pluginId, packageId: packageId }], outDir: outDir, pureHost: $('ppure').checked }) })
        .then(function (r) { return r.json() }).then(function (d) {
          ;(d.results || []).forEach(function (r) { if (r.ok) log('ok', '✔ ' + r.pluginId + ' → ' + r.path); else log('err', '✘ ' + r.pluginId + '：' + (r.message || '失败')) })
        }).catch(function (e) { log('err', '✘ 请求失败: ' + e.message) })
      return
    }
    log('step', '▸ 打包 ' + pluginId + '/' + packageId + ' …')
    fetch(API + '/pack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginId: pluginId, packageId: packageId, outDir: outDir }) })
      .then(function (r) { return r.json() }).then(function (d) {
        if (d.ok) log('ok', '✔ ' + d.pluginId + '/' + d.packageId + ' → ' + d.artifactPath)
        else log('err', '✘ ' + (d.message || JSON.stringify(d)))
      }).catch(function (e) { log('err', '✘ 请求失败: ' + e.message) })
  }
  function doBatch() {
    var type = $('ptype').value
    var checked = getChecked()
    if (!checked.length) { log('err', '✘ 请先勾选要打包的插件'); return }
    clearLog()
    var outDir = $('outDir').value.trim()
    if (type === 'whole') {
      log('step', '▸ 一键打包整包 ' + checked.length + ' 个插件（dsh 安装包 + 便携包，每插件一个子文件夹）…')
      fetch(API + '/pack-whole', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: checked, outDir: outDir, pureHost: $('ppure').checked }) })
        .then(function (r) { return r.json() }).then(function (d) {
          ;(d.results || []).forEach(function (r) { if (r.ok) log('ok', '✔ ' + r.pluginId + '/' + r.packageId + ' → ' + r.dir); else log('err', '✘ ' + r.pluginId + '/' + r.packageId + '：' + (r.message || '失败')) })
        }).catch(function (e) { log('err', '✘ 请求失败: ' + e.message) })
      return
    }
    if (type === 'portable') {
      log('step', '▸ 导出 ' + checked.length + ' 个便携包（host' + ($('ppure').checked ? '' : ' + client') + '）到放置目录…')
      fetch(API + '/export-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: checked, outDir: outDir, pureHost: $('ppure').checked }) })
        .then(function (r) { return r.json() }).then(function (d) {
          ;(d.results || []).forEach(function (r) { if (r.ok) log('ok', '✔ ' + r.pluginId + ' → ' + r.path); else log('err', '✘ ' + r.pluginId + '：' + (r.message || '失败')) })
        }).catch(function (e) { log('err', '✘ 请求失败: ' + e.message) })
      return
    }
    log('step', '▸ 一键打包 ' + checked.length + ' 个插件…')
    fetch(API + '/pack-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: checked, outDir: outDir }) })
      .then(function (r) { return r.json() }).then(function (d) {
        ;(d.results || []).forEach(function (r) { if (r.ok) log('ok', '✔ ' + r.pluginId + '/' + r.packageId + ' → ' + r.artifactPath); else log('err', '✘ ' + r.pluginId + '/' + r.packageId + '：' + (r.message || '失败')) })
      }).catch(function (e) { log('err', '✘ 请求失败: ' + e.message) })
  }
  $('batch').onclick = doBatch
  function fmtSize(n) { if (n === undefined || n === null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB' }
  // 目录选择：POST 本插件的 /browse/pick，由 host 半区调用 DSH 自己的原生选择器
  // （ctx.directoryPicker.capability().pick()，见 runtime/picker）；不再自跑 PowerShell 弹窗。
  function pickInto(inputId) {
    fetch(API + '/browse/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json() })
      .then(function (f) {
        if (f && f.picked) { $(inputId).value = f.picked; setCache(inputId, f.picked); return }
        if (f && f.error) log('err', '⚠ ' + f.error)
      })
      .catch(function (e) { log('err', '✘ 浏览失败: ' + e.message) })
  }
  $('browse').onclick = function () { pickInto('outDir') }
  var installBusy = false
  function setInstalling(on) {
    installBusy = on
    $('ibtn').disabled = on
    $('ibtn').textContent = on ? '安装中…' : '安装 dsh 包'
  }
  $('ibtn').onclick = function () { if (installBusy) return; $('ifile').click() }
  $('ifile').onchange = function () {
    var f = $('ifile').files[0]; if (!f) return
    $('ifile').value = ''
    if (f.size > 50 * 1024 * 1024) { log('err', '✘ 文件过大（>50MB）'); return }
    var profile = $('iprofile').value.trim() || 'web'
    setInstalling(true)
    var rd = new FileReader()
    rd.onload = function () {
      var b64 = String(rd.result || '').split(',')[1] || ''
      if (!b64) { log('err', '✘ 读取文件失败'); setInstalling(false); return }
      clearLog()
      log('step', '▸ 上传 ' + f.name + '（' + fmtSize(f.size) + '）…')
      fetch(API + '/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, base64: b64, size: f.size }) })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (!(d.ok && d.path)) { log('err', '✘ ' + (d.message || JSON.stringify(d))); setInstalling(false); return }
          log('ok', '✔ 已载入 → ' + d.path)
          log('step', '▸ 安装到 profile ' + profile + ' …（需批准提升权限）')
          return fetch(API + '/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: d.path, profile: profile }) })
            .then(function (r2) { return r2.json() })
            .then(function (i) { log(i.ok ? 'ok' : 'err', (i.ok ? '✔ ' : '✘ ') + (i.ok ? i.note : (i.message || JSON.stringify(i)))); setInstalling(false) })
        })
        .catch(function (e) { log('err', '✘ ' + e.message); setInstalling(false) })
    }
    rd.onerror = function () { log('err', '✘ 读取文件失败'); setInstalling(false) }
    rd.readAsDataURL(f)
  }
  var profilePrefilled = false
  // 只回填一次、且只覆盖写死的默认值 'web'/空值，避免踩掉用户手输的 profile。
  function applyActiveProfile(d) {
    if (profilePrefilled) return
    profilePrefilled = true
    var p = d && d.activeProfile
    if (!p) return
    ;['mprofile', 'iprofile'].forEach(function (id) {
      var el = $(id)
      if (el && (el.value === '' || el.value === 'web')) el.value = p
    })
  }
  // D2：拉取存活会话清单；服务端能自动解析就预选回填，多会话时由用户显式选。
  function loadSessions() {
    fetch(API + '/sessions').then(function (r) { return r.json() }).then(function (d) {
      var sel = $('xsessSel'); if (!sel) return
      var keep = sel.value
      sel.textContent = ''
      var o0 = document.createElement('option'); o0.value = ''; o0.textContent = '会话…'; sel.appendChild(o0)
      var list = (d && d.sessions) || []
      list.forEach(function (s) {
        var o = document.createElement('option'); o.value = s.id
        // 标签固定为「历史对话标题 - 会话id」；会话还没有标题时退回只显示 id。
        o.textContent = (s.title ? s.title + ' - ' : '') + s.id + (s.current ? '（当前请求）' : '')
        o.title = (s.title ? s.title + ' - ' : '') + s.id + (s.cwd ? ' · ' + s.cwd : '')
        sel.appendChild(o)
      })
      // 服务端能自动解析出会话就预选并回填；解析不出但只有一个存活会话时也预选（省得用户猜）。
      var pick = (d && d.resolved) ? String(d.resolved) : (list.length === 1 ? String(list[0].id) : '')
      if (pick !== '') { sel.value = pick; if ($('xsess').value.trim() === '') $('xsess').value = pick }
      else if (keep !== '') sel.value = keep
      if (!d || d.available !== true) sel.title = '会话列表不可用：' + ((d && d.reason) || '未知原因')
    }).catch(function () { /* 静默：手动填 id 仍可用 */ })
  }
  function load() {
    loadSessions()
    fetch(API + '/plugins').then(function (r) { return r.json() }).then(function (d) {
      applyActiveProfile(d)
      if (!d.outDir && $('outDir').value === '') $('outDir').value = d.defaultOutDir || ''
      if (d.defaultOutDir) { if (!getCache('outDir')) setCache('outDir', d.defaultOutDir); if (!getCache('ipath')) setCache('ipath', d.defaultOutDir) }
      if (!d.available) { $('hint').textContent = d.reason || '不可用'; $('list').textContent = ''; return }
      var ps = d.plugins || []
      $('hint').textContent = ps.length ? '共 ' + ps.length + ' 个会话级插件' : '当前没有会话级动态插件'
      var ul = $('list'); ul.textContent = ''
      if (!ps.length) { ul.appendChild(elEmpty('当前会话还没有可打包的动态插件', 'li')); return }
      ps.forEach(function (p) {
        var cur = p.currentPackageId; var pkgs = p.packages || []
        var li = document.createElement('li'); li.className = 'grid'
        var chk = document.createElement('input'); chk.type = 'checkbox'; chk.setAttribute('data-plugin', p.pluginId)
        var nm = document.createElement('b'); nm.className = 'name ellipsis'; nm.textContent = (pkgs.length ? (pkgs[pkgs.length-1].name || p.pluginId) : p.pluginId); nm.title = nm.textContent
        var idc = document.createElement('code'); idc.className = 'id ellipsis'; idc.textContent = p.pluginId; idc.title = p.pluginId
        var sel = document.createElement('select')
        pkgs.forEach(function (pk) { var o = document.createElement('option'); o.value = pk.packageId; o.textContent = pk.packageId + (pk.packageId === cur ? ' (当前)' : ''); if (pk.packageId === cur) o.selected = true; sel.appendChild(o) })
        var pb = document.createElement('button'); pb.className = 'mini'; pb.textContent = '打包'
        pb.onclick = (function (pid, selEl) { return function () { packOne(pid, selEl.value) } })(p.pluginId, sel)
        li.appendChild(chk); li.appendChild(nm); li.appendChild(idc); li.appendChild(sel); li.appendChild(pb)
        ul.appendChild(li)
      })
    }).catch(function (e) { $('hint').textContent = '请求失败: ' + e.message })
  }
  $('refresh').onclick = load
  $('xbtn').onclick = function () { $('xfile').click() }
  $('xsessSel').onchange = function () { if (this.value !== '') $('xsess').value = this.value }
  // 导入结果统一渲染：两条来源（便携 JSON / .tgz 解包）共用。
  function renderImportResult(d) {
    if (d.ok && d.results) {
      d.results.forEach(function(r){
        var id = r.pluginId + '/' + r.packageId + '（' + r.name + '）'
        if (r.ran === true) log('ok', '✔ 已导入并启动 ' + id + '（' + runStatusText(r.runStatus || 'started') + '）' + (r.silent === true ? (r.awaitingPage === true ? '，零唤醒：host 半已起、client 半待页面装入' : '，零唤醒启动：0 token') : '，已唤醒一轮'))
        else if (r.ran === false) log('err', '✘ 已导入但未能启动 ' + id + '：' + (r.runError || '未知原因') + '　→ 可在「临时插件」页点「运行」重试')
        else log('ok', '✔ 已导入（未运行）' + id + '　→ 去「临时插件」页点「运行」启动')
      })
      load(); loadCards()
    }
    else log('err','✘ '+(d.message||JSON.stringify(d)))
  }
  function postImport(body) {
    return fetch(API+'/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json()}).then(renderImportResult)
      .catch(function(e){log('err','✘ 请求失败: '+e.message)})
  }
  // .tgz 便携导入：先走已有的 /api/upload 落盘（浏览器给不出本地路径），再由 host 解包定义——
  // 全程不安装（不写 profile、不用重启），与 .dshplugin.json 走同一个 define 通道。
  function importTgz(f) {
    if (f.size > 50 * 1024 * 1024) { log('err', '✘ 文件过大（>50MB）'); return }
    var rd = new FileReader()
    rd.onload = function () {
      var b64 = String(rd.result || '').split(',')[1] || ''
      if (!b64) { log('err','✘ 读取文件失败'); return }
      clearLog()
      log('step','▸ 上传 '+f.name+'（'+fmtSize(f.size)+'）…')
      fetch(API+'/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.name,base64:b64,size:f.size})})
        .then(function(r){return r.json()})
        .then(function(d){
          if (!(d.ok && d.path)) { log('err','✘ '+(d.message||JSON.stringify(d))); return }
          log('ok','✔ 已载入 → '+d.path)
          log('step','▸ 解包并注册为临时插件（不安装到 profile）…')
          return postImport({ sessionId:$('xsess').value.trim()||'', autoRun:$('xauto').checked, tgzPath:d.path })
        })
        .catch(function(e){ log('err','✘ 请求失败: '+e.message) })
    }
    rd.onerror = function () { log('err','✘ 读取文件失败') }
    rd.readAsDataURL(f)
  }
  $('xfile').onchange = function () {
    var f = $('xfile').files[0]; if (!f) return
    $('xfile').value = ''
    if (f.name.toLowerCase().slice(-4) === '.tgz') { importTgz(f); return }
    var rd = new FileReader()
    rd.onload = function () {
      var data; try { data = JSON.parse(rd.result) } catch (e) { log('err','✘ JSON 解析失败: '+e.message); return }
      if (!data || (data.__dshDynamicPlugin !== true && data.__dshDynamicPlugins !== true)) { log('err','✘ 不是便携动态插件包'); return }
      clearLog(); log('step','▸ 导入并注册为 Cordis 插件（不安装、不落 profile）…')
      postImport({ sessionId:$('xsess').value.trim()||'', autoRun:$('xauto').checked, data:data })
    }
    rd.readAsText(f)
  }
  // ── 管理与卸载：profile 层的真实已装清单 ─────────────────────────────────
  var instSeq = 0
  function elEmpty(text, tag) { var d = document.createElement(tag || 'div'); d.className = 'empty'; d.textContent = text; return d }
  function chip(text, cls) { var t = document.createElement('span'); t.className = 'tag' + (cls ? ' ' + cls : ''); t.textContent = text; return t }
  // 路径来源太长会挤掉插件名，只留尾部（文件名最有用），完整值仍在 title 里。
  function shortSpec(s) {
    var t = String(s || '').replace(/^file:/i, '')
    if (t.length <= 46) return t
    return '…' + t.slice(-45)
  }
  function loadInstalled() {
    var profile = $('mprofile').value.trim() || 'web'
    var ul = $('instList'); var seq = ++instSeq
    var disarmers = []
    function disarmAll() { for (var i = 0; i < disarmers.length; i += 1) disarmers[i]() }
    ul.textContent = ''
    $('instCount').textContent = ''
    var loading = document.createElement('li'); loading.className = 'mitem loading'; loading.textContent = '读取中…'; ul.appendChild(loading)
    fetch(API + '/installed?profile=' + encodeURIComponent(profile)).then(function (r) { return r.json() }).then(function (d) {
      if (seq !== instSeq) return
      ul.textContent = ''
      if (d.error) { ul.appendChild(elEmpty('⚠ ' + d.error, 'li')); return }
      var deps = d.dependencies || []
      $('instCount').textContent = deps.length ? '共 ' + deps.length + ' 项' : ''
      if (!deps.length) { ul.appendChild(elEmpty('该 profile 下没有已安装的 dsh 插件', 'li')); return }
      deps.forEach(function (dep) {
        var li = document.createElement('li'); li.className = 'mitem'
        var main = document.createElement('div'); main.className = 'mi-main'
        var top = document.createElement('div'); top.className = 'mi-top'
        var nm = document.createElement('b'); nm.className = 'nm'; nm.textContent = dep.name; nm.title = dep.name
        top.appendChild(nm)
        if (dep.isBundle) top.appendChild(chip('bundle', 'bundle'))
        if (dep.isBase) top.appendChild(chip('基础', 'base'))
        if (dep.isSelf) top.appendChild(chip('本插件自身', 'self'))
        if (dep.missingDependency) top.appendChild(chip('仅层声明 · 缺依赖', 'miss'))
        var sp = document.createElement('code'); sp.className = 'mono' + (/^https?:/i.test(String(dep.spec || '')) ? ' link' : '')
        sp.textContent = dep.spec ? shortSpec(dep.spec) : '— 未在 dependencies 中声明'
        sp.title = dep.spec || '（未在 dependencies 中声明）'
        main.appendChild(top); main.appendChild(sp)
        var btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = '卸载'; btn.disabled = !!dep.isBase
        var baseTitle = dep.isBase
          ? '基础包由安装目录提供，不可卸载'
          : (dep.isSelf ? '本插件自身：卸载后面板立即消失，重启后要重装 dsh-mycordis 才能再用' : '从 profile ' + profile + ' 卸载该插件')
        btn.title = baseTitle
        var armed = false
        var timer = 0
        function disarm() {
          if (!armed) return
          armed = false
          if (timer) { clearTimeout(timer); timer = 0 }
          btn.textContent = '卸载'; btn.className = 'btn'; btn.title = baseTitle
        }
        disarmers.push(disarm)
        btn.onclick = function () {
          // 二次确认走按钮自身，不用 window.confirm（桌面版 webview 可能屏蔽模态框）。
          // 同一时刻只允许一个按钮处于待确认态，5 秒无操作自动撤回。
          if (!armed) {
            disarmAll()
            armed = true
            if (timer) clearTimeout(timer)
            timer = setTimeout(disarm, 5000)
            btn.textContent = '确认卸载'; btn.className = 'btn danger'
            log('warn', '⚠ 再点一次「确认卸载」：' + dep.name + (dep.isSelf ? ' —— 这是本插件自身，卸载后面板会消失' : '') + '（profile: ' + profile + '，重启 dsh 后生效；5 秒后自动撤回）')
            return
          }
          disarm()
          log('step', '▸ 卸载 ' + dep.name + ' …（需批准提升权限）')
          fetch(API + '/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: dep.name, profile: profile }) })
            .then(function (r) { return r.json() }).then(function (x) { log(x.ok ? 'ok' : 'err', (x.ok ? '✔ ' : '✘ ') + (x.ok ? x.note : (x.message || JSON.stringify(x)))); loadInstalled() })
            .catch(function (e) { log('err', '✘ ' + e.message) })
        }
        li.appendChild(main); li.appendChild(btn)
        ul.appendChild(li)
      })
    }).catch(function (e) {
      if (seq !== instSeq) return
      ul.textContent = ''
      ul.appendChild(elEmpty('⚠ 请求失败：' + e.message, 'li'))
    })
  }
  function pname(p) {
    var pkgs = p.packages || []
    if (p.currentPackageId) { for (var i = 0; i < pkgs.length; i++) if (pkgs[i].packageId === p.currentPackageId) return pkgs[i].name || p.pluginId }
    return pkgs.length ? (pkgs[pkgs.length-1].name || p.pluginId) : p.pluginId
  }
  function buildCard(entry) {
    var card = document.createElement('div'); card.className = 'card'
    var star = document.createElement('button'); star.className = 'star'; star.title = entry.isFav ? '取消收藏' : '收藏'; star.textContent = entry.isFav ? '★' : '☆'
    var nm = document.createElement('div'); nm.className = 'cname'; nm.textContent = entry.name; nm.title = entry.name
    var idc = document.createElement('div'); idc.className = 'cid'
    idc.textContent = entry.pluginId + (entry.latestRun && entry.latestRun.status ? ' · ' + runStatusText(entry.latestRun.status) : '')
    idc.title = entry.latestRun && entry.latestRun.status ? ('最近一次运行状态：' + entry.latestRun.status) : entry.pluginId
    var sel = null
    if (entry.packages && entry.packages.length) {
      sel = document.createElement('select')
      entry.packages.forEach(function (pk) { var o = document.createElement('option'); o.value = pk.packageId; o.textContent = pk.packageId; if (pk.packageId === entry.currentPackageId) o.selected = true; sel.appendChild(o) })
    } else {
      sel = document.createElement('div'); sel.className = 'cid'; sel.textContent = entry.packageId || ''
    }
    var actions = document.createElement('div'); actions.className = 'cactions'
    var runb = document.createElement('button'); runb.className = 'runbtn'; runb.textContent = '运行'
    var res = document.createElement('button'); res.className = 'resbtn' + (entry.resident ? ' on' : ''); res.textContent = '常驻'
    var rest = document.createElement('button'); rest.textContent = '恢复'; rest.disabled = !entry.isFav
    var copy = document.createElement('button'); copy.className = 'copybtn'; copy.textContent = '复制'; copy.title = '复制信息：导出定义文件并复制路径，供新会话 AI 直接 read（省 token）'
    var pid = entry.pluginId
    var pkgVal = (sel && sel.tagName === 'SELECT') ? sel.value : (entry.packageId || '')
    // 提示按「当前选中的包」实时更新：纯 host = 静默（0 token），带 client 半区 = 必须经页面、会唤醒。
    function syncTitles() {
      var v = (sel && sel.tagName === 'SELECT') ? sel.value : (entry.packageId || '')
      var pk = null
      if (entry.packages) { for (var i = 0; i < entry.packages.length; i++) if (entry.packages[i].packageId === v) pk = entry.packages[i] }
      var hc = !!(pk && pk.hasClientHalf === true)
      runb.title = hc
        ? '该包带 client 半区：host 半零唤醒静默启动，client 半停在「待页面装入」——去 DSH 侧边栏的 Cordis 面板点「运行」装入本页（settleUserRun → agent.inject，不唤醒）。只有勾了上方「允许唤醒会话」才走会 steer 的旧通道。'
        : '纯 host 包：零唤醒静默启动，不产生任何会话上下文（0 token）'
      res.title = '常驻：收藏 + 重启 dsh 后自动拉起' + (hc ? '；该包带 client 半区，启动时 host 半零唤醒拉起，client 半每次由页面按需装入（不唤醒会话）' : '；纯 host，启动时静默拉起')
      rest.title = entry.isFav ? '恢复该插件并启动' : '先点 ☆ 收藏后才能恢复'
    }
    syncTitles()
    if (sel && sel.tagName === 'SELECT') sel.onchange = syncTitles
    var forceRun = false
    var wakeArmed = false
    star.onclick = function () { setFav(pid, pkgVal, entry.isFav ? 'remove' : 'add') }
    // 零唤醒是默认通道：运行不再需要「允许唤醒会话」，也不再拦人。
    // 只有显式勾选「允许唤醒会话（应急）」才退回会 agent.steer 的 run() 请求通道，那时才二次确认。
    runb.onclick = function () {
      var v = (sel && sel.tagName === 'SELECT') ? sel.value : (entry.packageId || '')
      var pk = null
      if (entry.packages) { for (var i = 0; i < entry.packages.length; i++) if (entry.packages[i].packageId === v) pk = entry.packages[i] }
      var hc = !!(pk && pk.hasClientHalf === true)
      var live = !!(entry.latestRun && (entry.latestRun.status === 'running' || entry.latestRun.status === 'client-pending') && v === entry.currentPackageId)
      var wake = hc && $('wakeok').checked
      if (wake && !live && !wakeArmed) {
        wakeArmed = true
        log('warn', '⚠ ' + pid + '/' + v + ' 你勾了「允许唤醒会话」：将退回 run() 请求通道，等页面作答后走 agent.steer，会唤醒一轮（≈ 一整轮 token）。再点一次「运行」确认；不勾这项才是零唤醒。')
        return
      }
      wakeArmed = false
      var force = forceRun
      forceRun = false
      runOne(pid, v, force, function () { forceRun = true }, wake)
    }
    res.onclick = function () { setResident(pid, pkgVal, !entry.resident) }
    rest.onclick = function () { restoreOne(pid) }
    copy.onclick = function () { copyInfo(pid) }
    // 一行四个：运行 / 常驻 / 恢复 / 复制。
    actions.appendChild(runb); actions.appendChild(res); actions.appendChild(rest); actions.appendChild(copy)
    card.appendChild(star); card.appendChild(nm); card.appendChild(idc); card.appendChild(sel); card.appendChild(actions)
    return card
  }
  function loadCards() {
    fetch(API + '/favorites').then(function (r) { return r.json() }).then(function (fd) {
      var favs = (fd && fd.favorites) || []
      return fetch(API + '/plugins').then(function (r) { return r.json() }).then(function (d) { return { favs: favs, d: d } })
    }).then(function (rs) {
      var favs = rs.favs; var d = rs.d
      var fg = $('favCards'); fg.textContent = ''
      var ug = $('unfavCards'); ug.textContent = ''
      if (!d.available) { fg.appendChild(elEmpty('⚠ ' + (d.reason || '不可用'))); $('favCount').textContent = ''; $('unfavCount').textContent = ''; return }
      var ps = d.plugins || []
      if (favs.length === 0) { fg.appendChild(elEmpty('暂无收藏')) }
      else {
        favs.forEach(function (f) {
          var inst = null
          for (var i = 0; i < ps.length; i++) { if (pname(ps[i]) === f.name) { inst = ps[i]; break } }
          fg.appendChild(buildCard({
            isFav: true,
            pluginId: f.pluginId || (inst ? inst.pluginId : ''),
            packageId: f.packageId,
            name: f.name,
            resident: f.resident === true,
            packages: inst ? inst.packages : undefined,
            currentPackageId: inst ? inst.currentPackageId : undefined,
            latestRun: inst ? inst.latestRun : undefined,
          }))
        })
      }
      $('favCount').textContent = '（' + favs.length + '）'
      var names = favs.map(function (f) { return f.name })
      var unfav = ps.filter(function (p) { return names.indexOf(pname(p)) === -1 })
      if (unfav.length === 0) { ug.appendChild(elEmpty('当前没有未收藏的会话级插件')) }
      else {
        unfav.forEach(function (p) {
          ug.appendChild(buildCard({ isFav: false, pluginId: p.pluginId, packageId: p.currentPackageId, name: pname(p), resident: false, packages: p.packages, currentPackageId: p.currentPackageId, latestRun: p.latestRun }))
        })
      }
      $('unfavCount').textContent = '（' + unfav.length + '）'
    }).catch(function (e) { log('err', '✘ ' + e.message) })
  }
  function runStatusText(s) {
    var m = { running: '运行中', starting: '启动中', 'client-pending': '待页面装入', 'awaiting-approval': '等待批准', failed: '失败', stopped: '已停止', completed: '已结束' }
    return m[s] || String(s)
  }
  function runOne(pluginId, packageId, force, onNoop, wake) {
    log('step', '▸ 运行 ' + pluginId + ' / ' + packageId + ' …' + (force === true ? '（强制重启）' : '') + (wake === true ? '（允许唤醒会话）' : ''))
    fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginId: pluginId, packageId: packageId, force: force === true, wake: wake === true }) })
      .then(function (r) { return r.json() }).then(function (d) {
        if (d.ok && d.noop === true) {
          log('warn', '⚠ ' + d.pluginId + '/' + d.packageId + ' ' + (d.note || '已在运行，未重复运行'))
          if (onNoop) onNoop()
          return
        }
        if (d.ok) {
          log('ok', '✔ 已启动 ' + d.pluginId + '/' + d.packageId + '（' + runStatusText(d.status) + '）'
            + (d.silent === true
              ? '，零唤醒启动：未产生任何会话轮次' + (d.awaitingPage === true ? '；client 半待页面装入 → 去 DSH 侧边栏 Cordis 面板点「运行」' : '')
              : '；该包带 client 半区，已往会话注入一条上下文并唤醒一轮'))
          load(); loadCards()
        }
        else log('err', '✘ ' + (d.message || JSON.stringify(d)))
      }).catch(function (e) { log('err', '✘ ' + e.message) })
  }
  function setFav(pluginId, packageId, action) {
    fetch(API + '/favorite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: action, pluginId: pluginId, packageId: packageId }) })
      .then(function (r) { return r.json() }).then(function (x) { log(x.ok ? 'ok' : 'err', (x.ok ? '✔ ' : '✘ ') + (action === 'add' ? '已收藏 ' : '已取消收藏 ') + pluginId); loadCards() })
      .catch(function (e) { log('err', '✘ ' + e.message) })
  }
  function setResident(pluginId, packageId, on) {
    fetch(API + '/favorite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resident', pluginId: pluginId, packageId: packageId, resident: on }) })
      .then(function (r) { return r.json() }).then(function (x) { log(x.ok ? 'ok' : 'err', (x.ok ? '✔ ' : '✘ ') + (on ? '已设常驻（收藏 + 自动运行）' : '已取消常驻') + ' ' + pluginId); loadCards() })
      .catch(function (e) { log('err', '✘ ' + e.message) })
  }
  function restoreOne(pluginId) {
    log('step', '▸ 恢复（启动）' + pluginId + ' …')
    fetch(API + '/restore-one', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginId: pluginId }) })
      .then(function (r) { return r.json() }).then(function (d) {
        if (d.ok && d.results && d.results.length) { d.results.forEach(function (r) { log('ok', '✔ 已恢复并启动 ' + r.pluginId + '/' + r.packageId + '（' + r.name + '）') }); load(); loadCards() }
        else log('err', '✘ ' + (d.message || d.note || JSON.stringify(d)))
      }).catch(function (e) { log('err', '✘ ' + e.message) })
  }
  function copyText(text, done) {
    var ok = false
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {})
        ok = true
      }
    } catch (e) { ok = false }
    if (!ok) {
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        done()
      } catch (e) { log('err', '✘ 复制失败: ' + e.message) }
    }
  }
  function copyInfo(pluginId) {
    fetch(API + '/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginId: pluginId }) })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (!d.ok) { log('err', '✘ ' + (d.message || '导出快照失败')); return }
        var NL = String.fromCharCode(10)
        var text = '【跨会话定位动态插件】' + NL
          + '定义文件: ' + d.path + NL
          + 'pluginId: ' + d.pluginId + NL
          + 'packageId: ' + d.packageId + NL
          + '名称: ' + (d.name || '') + NL
          + NL + '【供新会话 AI】直接 read 上面的定义文件（.dshplugin.json）即可拿到完整 host/client 源码，据此 cordis_define 重建并优化，无需粘贴源码。'
        copyText(text, function () { log('ok', '✔ 已复制 ' + d.pluginId + ' 定位（定义已导出到 ' + d.path + '）') })
      })
      .catch(function (e) { log('err', '✘ ' + e.message) })
  }
  // 两个页签各管一半：管理与卸载 = profile 已装插件；临时插件 = 会话级动态插件（收藏/卡片）。
  function loadMgmt() { if ($('mprofile').value.trim() === '') $('mprofile').value = 'web'; loadInstalled() }
  function loadTemp() { loadCards() }
  $('mrefresh').onclick = function () { loadInstalled() }
  $('frestore').onclick = function () {
    log('step', '▸ 恢复收藏（启动）…')
    fetch(API + '/restore-favorites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json() }).then(function (d) {
        if (d.ok && d.results) { d.results.forEach(function (r) { log('ok', '✔ 已恢复并启动 ' + r.pluginId + '/' + r.packageId + '（' + r.name + '）') }); load(); loadCards() }
        else log('err', '✘ ' + (d.message || d.note || JSON.stringify(d)))
      }).catch(function (e) { log('err', '✘ ' + e.message) })
  }
  $('dedupe').onclick = function () {
    log('step', '▸ 去重（同名插件只留一个 + 收藏按名称去重）…')
    fetch(API + '/dedupe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json() }).then(function (d) {
        if (d.ok) { log('ok', '✔ 已清理 ' + ((d.removed || []).length) + ' 个重复插件实例，收藏剩 ' + d.favorites + ' 条'); load(); loadCards() }
        else log('err', '✘ ' + (d.message || JSON.stringify(d)))
      }).catch(function (e) { log('err', '✘ ' + e.message) })
  }
  load()
})()
</script>
</body></html>`
}
