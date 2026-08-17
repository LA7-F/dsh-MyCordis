// ── 我的Cordis：会话级动态插件打包/安装/便携化（host 半区，零依赖沙箱能力） ──────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function sq(p) {
  return "'" + String(p).replace(/'/g, "''") + "'"
}
function send(res, status, obj) {
  const body = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(body).length
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes, 'cache-control': 'no-store' })
  res.end(body)
}
function sendDownload(res, filename, obj) {
  const body = JSON.stringify(obj, null, 2)
  const bytes = new TextEncoder().encode(body).length
  const safeName = sanitizeFilename(filename)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes, 'content-disposition': 'attachment; filename="' + safeName + '"', 'cache-control': 'no-store' })
  res.end(body)
}
function sendHtml(res, html) {
  const bytes = new TextEncoder().encode(html).length
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': bytes, 'cache-control': 'no-store' })
  res.end(html)
}
// 请求体上限：防止超大 body 耗尽内存（DoS）
const MAX_BODY_BYTES = 80 * 1024 * 1024
// ── 便携包导出脱敏：ownerSessionId 用假 ID 替代，防止泄露会话标识；导入时自动落到当前/任一已存在会话 ──
const FAKE_SESSION_ID = 'session-00000000-0000-4000-8000-000000000000'
function isFakeSessionId(id) {
  const s = String(id || '')
  return s === '' || s === FAKE_SESSION_ID || /^session-0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s)
}
function sanitizePortable(data) {
  if (data && typeof data === 'object') data.ownerSessionId = FAKE_SESSION_ID
  return data
}
async function resolveCurrentSessionId(ctx) {
  try {
    const agents = ctx.get('agents')
    if (agents !== undefined) {
      if (typeof agents.currentInitiator === 'function') {
        const i = agents.currentInitiator()
        if (i && i.id) return String(i.id)
      }
      if (typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (roots && roots.length === 1) return String(roots[0].id || '')
      }
    }
  } catch (e) { /* 保持空 */ }
  return ''
}
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let total = 0
    let overflow = false
    let text = ''
    const td = new TextDecoder('utf-8')
    req.on('data', (c) => {
      if (overflow) return
      total += c.length
      if (total > MAX_BODY_BYTES) { overflow = true; reject(new Error('body-too-large')); return }
      try { text += td.decode(c, { stream: true }) } catch (e) { try { text += String(c) } catch (e2) { text += '' } }
    })
    req.on('end', () => {
      if (overflow) return
      try { text += td.decode() } catch (e) { /* ignore */ }
      resolvePromise(text)
    })
    req.on('error', reject)
  })
}
// ── 请求信任栅栏（v2 加固）：loopback Host + 同源 Origin（scheme://host:port 精确比对）+ 写操作强制 Origin + socket 远端校验 ──
function parseAuthority(authority) {
  const a = String(authority || '').trim()
  let host = ''
  let port = ''
  let rest = a
  if (a.startsWith('[')) {
    const end = a.indexOf(']')
    if (end === -1) return { host: a.toLowerCase(), port: '' }
    host = a.slice(0, end + 1).toLowerCase()
    rest = a.slice(end + 1)
  } else {
    const i = a.indexOf(':')
    host = (i === -1 ? a : a.slice(0, i)).toLowerCase()
    rest = i === -1 ? '' : a.slice(i + 1)
  }
  const j = rest.search(/[/?#]/)
  if (j !== -1) rest = rest.slice(0, j)
  if (rest.startsWith(':')) port = rest.slice(1)
  else if (rest !== '') port = rest
  return { host, port }
}
function isLoopbackHostname(h) {
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}
function parseOrigin(origin) {
  const s = String(origin || '').trim()
  if (s === '' || s === 'null') return null
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(s)
  if (!m) return null
  return { scheme: m[1].toLowerCase(), ...parseAuthority(m[2]) }
}
function defaultPort(scheme) {
  return scheme === 'https' ? '443' : scheme === 'http' ? '80' : ''
}
function isTrustedRequest(req) {
  const h = (req && req.headers) || {}
  const hostHeader = h.host
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  const hostAuth = parseAuthority(hostHeader)
  if (!isLoopbackHostname(hostAuth.host)) return false
  if (h['sec-fetch-site'] === 'cross-site') return false
  // 纵深防御：socket 远端必须是 loopback（IPv4-mapped 归一化后）
  const ra = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
  if (ra !== '' && !isLoopbackHostname(ra)) return false
  const method = String(req.method || 'GET').toUpperCase()
  const writeMethod = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  const origin = h.origin
  if (origin === undefined) return !writeMethod
  if (String(origin) === 'null') return false
  const o = parseOrigin(origin)
  if (!o || !isLoopbackHostname(o.host)) return false
  const reqScheme = (req.socket && req.socket.encrypted) ? 'https' : 'http'
  if (o.scheme !== reqScheme) return false
  const reqPort = hostAuth.port === '' ? defaultPort(reqScheme) : hostAuth.port
  const oPort = o.port === '' ? defaultPort(o.scheme) : o.port
  if (oPort !== reqPort) return false
  return o.host === hostAuth.host
}
// ── 其它安全助手：profile 白名单 / 路径规范化 / 文件名净化 ──
function validProfile(p) {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(String(p || ''))
}
function normPath(p) {
  const s = String(p || '').replace(/\\/g, '/')
  const abs = s.startsWith('/') || /^[a-zA-Z]:\//.test(s)
  const out = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (out.length) out.pop() }
    else out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}
function sanitizeFilename(name) {
  return String(name || 'download').replace(/[\r\n]/g, '').replace(/[^\w.\-]/g, '_')
}
// ── 错误信息脱敏：剥掉绝对路径与超长命令片段 ──
function safeErrorMsg(e) {
  let m = String(e && e.message ? e.message : e)
  m = m.replace(/[A-Za-z]:[\\/][^\s'";\n]*/g, '<路径>')
  m = m.split('\n').map(function (l) { return l.length > 160 ? l.slice(0, 160) + '…' : l }).join('\n')
  return m
}
function parsePath(reqUrl) {
  const raw = String(reqUrl || '/')
  const q = raw.indexOf('?')
  return { path: q === -1 ? raw : raw.slice(0, q), query: q === -1 ? '' : raw.slice(q + 1) }
}
function rand() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}
function entrySource(pkgName) {
  return [
    '/**',
    ' * ' + pkgName + ' — 由 我的Cordis 从会话级动态插件合成。',
    ' * host 半区以 async 函数体求值；harness.handle 桥接到私有 connection.rpc channel。',
    ' */',
    "import { readFileSync } from 'node:fs'",
    '',
    "const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))",
    "const HOST_CODE = readFileSync(new URL('./host.js', import.meta.url), 'utf8')",
    '',
    'export const name = manifest.name',
    '',
    '// 组合插件环境不提供动态沙箱的 harness 全局，注入等价垫片。',
    '// defineTool 透传（DSL 由 tools 服务校验），registerTool 落到 ctx.tools.register，',
    '// handle 捕获 handler，由 apply 里的私有 connection.rpc channel 分发（等价 host.call）。',
    'const handlers = new Map()',
    'const harness = {',
    '  defineTool(def) { return def },',
    '  registerTool(ctx, tool) {',
    "    const tools = (ctx && (ctx.tools || ctx.get('tools')))",
    "    if (tools && typeof tools.register === 'function') return tools.register(tool)",
    "    console.warn('[' + manifest.name + '] harness.registerTool: tools 服务不可用，工具未注册')",
    '    return function () {}',
    '  },',
    '  handle(method, fn) {',
    "    if (typeof method !== 'string' || method === '' || typeof fn !== 'function') throw new Error('harness.handle(method, fn) 需要方法名 + 处理函数')",
    '    handlers.set(method, fn)',
    '    return function () { if (handlers.get(method) === fn) handlers.delete(method) }',
    '  },',
    '}',
    '',
    'export async function apply(ctx, config) {',
    "  if (HOST_CODE.trim() === '') {",
    "    console.warn('[' + manifest.name + '] 此包无 host 半区（client-only），在 Node 组合中无可执行逻辑')",
    '    return',
    '  }',
    '  // 私有 RPC channel：客户端 host.call 经 connection.rpc.call 调到 harness.handle 注册的方法',
    "  const conn = ctx.get('connection')",
    "  if (conn && conn.rpc && typeof conn.rpc.handle === 'function') {",
    "    const dispose = conn.rpc.handle('/' + manifest.name, async function (endpoint, payload) {",
    '      const fn = handlers.get(endpoint)',
    "      if (typeof fn !== 'function') return { ok: false, error: { code: 'method-not-found', message: 'no handler \"' + endpoint + '\"', details: {} } }",
    '      try { return { ok: true, value: await fn(payload) } } catch (e) { return { ok: false, error: { code: \'handler-error\', message: String(e && e.message ? e.message : e), details: {} } } }',
    "    }, { authority: 'loopback' })",
    "    ctx.effect(function () { return dispose }, manifest.name + ': rpc channel')",
    '  }',
    "  const factory = new Function('harness', 'return (async () => {\\n' + HOST_CODE + '\\n})()')",
    '  const plugin = await factory(harness)',
    "  if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {",
    "    throw new Error('host 代码未返回带 apply(ctx) 的 Cordis Plugin 对象')",
    '  }',
    '  await ctx.plugin(plugin, config)',
    '}',
    '',
    'export default { name, apply }',
    '',
  ].join('\n')
}
function clientBundleSource(pkgName, clientCode) {
  if (String(clientCode || '').trim() === '') return '// no client half\n'
  const codeLit = JSON.stringify(String(clientCode))
  return [
    '// ' + pkgName + ' client 半区 — 由 我的Cordis 合成（factory-form CJS）',
    'window.__ModuleLoader__.load({ id: ' + JSON.stringify(String(pkgName)) + ', factory: (require) => {',
    'var module = { exports: {} }; var exports = module.exports;',
    "var React = require('react');",
    'var CLIENT_CODE = ' + codeLit + ';',
    'var __ctx = null;',
    'var host = { call: async function (method, args) {',
    "  var conn = __ctx && __ctx.get('connection');",
    "  if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') throw new Error('connection.rpc.call 不可用');",
    "  var r = await conn.rpc.call(" + JSON.stringify('/' + String(pkgName)) + ", method, args === undefined ? null : args);",
    "  if (!r || r.ok !== true) throw new Error((r && r.error && r.error.message) || 'RPC 调用失败');",
    '  return r.value;',
    '} };',
    'var styles = { insert: function () { return function () {} } };',
    'var __ready = null;',
    'function __load() {',
    '  if (!__ready) {',
    "    var f = new Function('React', 'host', 'styles', 'return (async () => {\\n' + CLIENT_CODE + '\\n})()');",
    '    __ready = f(React, host, styles);',
    '  }',
    '  return __ready;',
    '}',
    'module.exports = {',
    '  apply: async function (ctx) {',
    '    __ctx = ctx;',
    '    var inner = await __load();',
    "    if (inner && typeof inner.apply === 'function') return inner.apply(ctx);",
    '  },',
    '};',
    'return module.exports;',
    '} });',
    '',
  ].join('\n')
}
function injectButton(html) {
  if (typeof html !== 'string' || html.includes('dsh-plugin-builder2-entry')) return html
  const script = `(function () {
  'use strict'
  var ID = 'dsh-plugin-builder2-entry'
  var PANEL_ID = 'dsh-plugin-builder2-panel'
  var panel = null
  function el(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e }
  function findAnchor() {
    var buttons = document.querySelectorAll('button')
    for (var i = 0; i < buttons.length; i++) {
      var spans = buttons[i].querySelectorAll('span')
      for (var j = 0; j < spans.length; j++) { var t = spans[j].textContent; if (t && t.trim() === 'Session log') return buttons[i] }
    }
    return null
  }
  function closePanel() {
    if (!panel) return
    panel.style.opacity = '0'; panel.style.transform = 'translateY(-10px)'
    var p = panel; panel = null
    setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p) }, 240)
  }
  function toggle(btn) {
    if (panel) { closePanel(); return }
    var W = 560, H = 560
    var p = el('div'); p.id = PANEL_ID
    p.style.cssText = 'position:fixed;z-index:9999;width:' + W + 'px;height:' + H + 'px;max-width:96vw;max-height:80vh;display:flex;flex-direction:column;background:#ffffff;border:1px solid #d5d9e0;border-radius:10px;box-shadow:0 16px 40px rgba(15,20,30,.24);font-family:var(--dsw-font-family,sans-serif);font-size:12px;color:#1f2329;opacity:0;transform:translateY(-10px);transition:opacity .2s ease,transform .22s cubic-bezier(.2,.8,.3,1)'
    var r = btn.getBoundingClientRect()
    var left = r.right - W
    if (left < 8) left = r.left
    if (left < 8) left = 8
    if (left + W > window.innerWidth - 8) left = Math.max(8, window.innerWidth - W - 8)
    var top = r.bottom + 6
    if (top + H > window.innerHeight - 8) top = Math.max(8, window.innerHeight - H - 8)
    p.style.left = left + 'px'; p.style.top = top + 'px'
    var head = el('div')
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #e6e8eb;font-weight:600;font-size:12px;height:36px;box-sizing:border-box'
    head.appendChild(el('span', '我的Cordis'))
    var close = el('button', '✕')
    close.style.cssText = 'background:none;border:none;color:#6b7280;cursor:pointer;font-size:13px;padding:0 4px;height:24px'
    close.onclick = closePanel
    head.appendChild(close)
    p.appendChild(head)
    var fr = el('iframe'); fr.style.cssText = 'flex:1;border:none;width:100%'
    fr.src = '/packer2/?embed=1'
    p.appendChild(fr)
    document.body.appendChild(p)
    panel = p
    requestAnimationFrame(function () { requestAnimationFrame(function () { p.style.opacity = '1'; p.style.transform = 'translateY(0)' }) })
  }
  function mount() {
    var existing = document.getElementById(ID)
    var anchor = findAnchor()
    if (!anchor || !anchor.parentNode) return
    if (existing && existing.getAttribute('data-p2') === '1') return
    if (existing) existing.parentNode.removeChild(existing)
    var a = el('a', '我的Cordis'); a.id = ID; a.href = '#'; a.title = '我的Cordis：动态插件打包/安装/便携'
    a.setAttribute('data-p2', '1')
    a.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#555555);border-radius:18px;color:var(--dsw-alias-label-primary,inherit);background:transparent;font-family:var(--dsw-font-family,sans-serif);font-size:13px;line-height:20px;cursor:pointer;text-decoration:none;white-space:nowrap;user-select:none'
    a.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); toggle(a) }
    anchor.parentNode.insertBefore(a, anchor.nextSibling)
  }
  document.addEventListener('click', function (ev) { if (!panel) return; if (panel.contains(ev.target)) return; var b = document.getElementById(ID); if (b && b.contains(ev.target)) return; closePanel() })
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePanel() })
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setInterval(mount, 1000) }) } else { setInterval(mount, 1000) }
})()`
  return html.replace('</body>', '<script>' + script + '</script>\n</body>')
}
function pageHtml(embed) {
  const head = embed ? '' : '<header>我的Cordis <span class="sub">会话级动态插件 打包 / 安装 / 便携 / 管理与卸载</span></header>'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的Cordis</title><style>
:root{--bg:#ffffff;--panel:#ffffff;--panel2:#f7f8fa;--line:#e0e4ea;--fg:#1f2329;--muted:#6b7280;--accent:#e9ecf1;--ok:#1a7f37;--err:#c0392b;--warn:#9a6700;--mono:"Cascadia Code",Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--panel);border-bottom:1px solid var(--line);font-weight:700}
header .sub{font-weight:400;font-size:11px;color:var(--muted)}
nav{display:flex;border-bottom:1px solid var(--line);padding:0 12px;position:sticky;top:0;background:#ffffff;z-index:2}
nav button{background:none;border:none;padding:8px 16px;cursor:pointer;font-size:13px;color:var(--muted);border-bottom:2px solid transparent;height:40px;box-sizing:border-box}
nav button.active{color:var(--fg);border-bottom-color:#4f8cff}
main{padding:12px;max-width:760px;margin:0 auto}
label{display:block;font-size:11.5px;color:var(--muted);margin:8px 0 3px}
input[type=text],select,.btn{height:32px;box-sizing:border-box;border-radius:6px;font-size:12.5px;border:1px solid var(--line)}
input[type=text],select{width:100%;background:#ffffff;color:var(--fg);padding:0 8px}
.btn{background:var(--panel2);color:var(--fg);padding:0 12px;cursor:pointer;white-space:nowrap;font-family:inherit;flex-shrink:0}
.btn:hover:not(:disabled){border-color:#4f8cff}
.btn.primary{background:#4f8cff;border-color:#4f8cff;color:#fff}
.btn:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:6px;align-items:center;margin-top:6px}
.row input[type=text]{flex:1;min-width:0}
.grid{display:grid;grid-template-columns:24px 1fr 90px 130px 64px;gap:6px;align-items:center;padding:5px 8px;border-bottom:1px solid var(--line);font-size:12.5px}
.grid.head{font-size:11px;color:var(--muted)}
.grid .mini{height:24px;padding:0 6px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);cursor:pointer;font-family:inherit;white-space:nowrap}
.grid .mini:hover{border-color:#4f8cff}
ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:6px;background:#ffffff;max-height:280px;overflow:auto}
.ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.name{font-size:12.5px}.id{font-family:var(--mono);font-size:11px;color:var(--muted)}
.mitem{display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--line);font-size:12.5px;min-width:0}
.mitem .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mitem .mono{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis}
.mitem select{width:110px;flex:none}
.mitem .btn{flex:none}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:8px}
.card{height:142px;border:1px solid var(--line);border-radius:8px;background:#ffffff;padding:6px;display:flex;flex-direction:column;gap:3px;position:relative;min-width:0;overflow:hidden}
.card .star{position:absolute;top:4px;right:4px;background:none;border:none;cursor:pointer;font-size:14px;line-height:1;color:#d4a017;padding:0 2px}
.card .cname{font-weight:600;font-size:11px;line-height:1.25;padding-right:16px;height:28px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;flex:none}
.card .cid{font-family:var(--mono);font-size:9.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
.card select{width:100%;height:22px;font-size:10px;flex:none}
.card .cactions{display:flex;gap:4px;flex:none}
.card .cactions button{flex:1;min-width:0;height:22px;font-size:11px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);cursor:pointer;font-family:inherit;padding:0 3px;white-space:nowrap}
.card .cactions button:disabled{opacity:.4;cursor:not-allowed}
.card .cactions .resbtn.on{background:#e3ecff;border-color:#4f8cff;color:#4f8cff;font-weight:600}
.card .copybtn{flex:none;height:22px;font-size:10.5px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);cursor:pointer;font-family:inherit;padding:0 2px;white-space:nowrap}
pre{background:#fafbfc;border:1px solid var(--line);border-radius:6px;padding:6px 10px;max-height:160px;overflow:auto;font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;word-break:break-all;margin-top:8px}
.hint{color:var(--muted);font-size:11.5px}
.ok{color:var(--ok)}.err{color:var(--err)}.warn{color:var(--warn)}
.section{font-size:12.5px;font-weight:600;margin:14px 0 4px}
.desc{font-size:11px;color:var(--muted);margin:0 0 4px}
.empty{color:var(--muted);font-size:12px;border:1px dashed var(--line);border-radius:8px;padding:14px;text-align:center;grid-column:1/-1}
</style></head><body>
${head}
<nav>
  <button id="tabPack" class="active">打包</button>
  <button id="tabInst">安装</button>
  <button id="tabMgmt">管理与卸载</button>
</nav>
<main>
<div id="viewPack">
  <label>放置目录（打包产物输出目录）</label>
  <div class="row"><input id="outDir" type="text" spellcheck="false"><button id="browse" class="btn">浏览…</button><button id="refresh" class="btn">刷新列表</button></div>
  <label>打包类型（勾选插件后一键打包，或点每行「打包」单打）</label>
  <div class="row"><select id="ptype"><option value="dsh">dsh 包（.tgz，真实安装）</option><option value="portable">便携包（纯 host，无 client UI）</option><option value="whole">整包（dsh 安装包 + 便携包）</option></select><label style="margin:0;display:flex;align-items:center;gap:4px;height:32px;white-space:nowrap;flex-shrink:0"><input type="checkbox" id="all">全选</label><button id="batch" class="btn primary">一键打包</button></div>
  <span id="hint" class="hint"></span>
  <div class="grid head"><span></span><span>插件名</span><span>插件ID</span><span>版本</span><span>操作</span></div>
  <ul id="list"></ul>
</div>
<div id="viewInst" style="display:none">
  <div class="section">① 安装 dsh 包（真实安装，重启 dsh 生效）</div>
  <div class="desc">选择 .tgz 文件，自动上传并安装（等价于 dsh plugin add），需批准提升权限</div>
  <div class="row"><input id="iprofile" type="text" value="web" placeholder="profile（默认 web）"><input id="ifile" type="file" accept=".tgz,.dshplugin,application/gzip" style="display:none"><button id="ibtn" class="btn">安装 dsh 包</button></div>
  <div class="section">② 安装 Cordis 插件（临时，非真实安装）</div>
  <div class="desc">⚠ 导入会在 dsh 进程内执行包内代码，请只导入可信来源的便携包（.dshplugin.json，纯 host，一个插件一个文件）；导入后仅注册不运行，点「恢复」才启动。</div>
  <div class="row"><input id="xsess" type="text" placeholder="所属会话 id（可空）"><input id="xfile" type="file" accept=".json" style="display:none"><button id="xbtn" class="btn">导入便携包</button></div>
</div>
<div id="viewMgmt" style="display:none">
  <div class="section">① 已安装 dsh 插件（常驻，重启生效）</div>
  <div class="desc">列出 profile 已安装插件；卸载需批准提升权限，重启 dsh 生效</div>
  <div class="row"><input id="mprofile" type="text" value="web" placeholder="profile（默认 web）"><button id="mrefresh" class="btn">刷新</button></div>
  <ul id="instList"></ul>
  <div class="section">② 常用 Cordis 插件（会话级）</div>
  <div class="desc">☆ 收藏（仅显示卡片，不自动运行）/ 常驻（收藏 + 重启自动运行）/ 恢复（启动）/ 复制信息 / 同名合并版本</div>
  <div class="row"><button id="frestore" class="btn primary">恢复收藏</button><button id="dedupe" class="btn">去重</button></div>
  <div class="section" style="margin-top:10px">②-1 已收藏 <span class="hint" id="favCount"></span></div>
  <div class="desc">来自收藏记录 packer2-favorites.json，重启后仍显示卡片；点 ★ 取消收藏会移入下方「未收藏」，下次重启消失。</div>
  <div id="favCards" class="cards"></div>
  <div class="section">②-2 未收藏 <span class="hint" id="unfavCount"></span></div>
  <div class="desc">当前会话新建/导入且未收藏的插件；点 ☆ 收藏会移入上方「已收藏」，下次重启依旧存在。</div>
  <div id="unfavCards" class="cards"></div>
</div>
<pre id="log"></pre>
</main>
<script>
(function () {
  'use strict'
  var API = '/packer2/api'
  var $ = function (id) { return document.getElementById(id) }
  function log(cls, text) { var line = document.createElement('div'); line.className = cls; line.textContent = text; $('log').appendChild(line); $('log').scrollTop = $('log').scrollHeight }
  function switchTab(name) {
    $('viewPack').style.display = name === 'pack' ? 'block' : 'none'
    $('viewInst').style.display = name === 'install' ? 'block' : 'none'
    $('viewMgmt').style.display = name === 'mgmt' ? 'block' : 'none'
    $('tabPack').className = name === 'pack' ? 'active' : ''
    $('tabInst').className = name === 'install' ? 'active' : ''
    $('tabMgmt').className = name === 'mgmt' ? 'active' : ''
    if (name === 'mgmt') loadMgmt()
  }
  $('tabPack').onclick = function () { switchTab('pack') }
  $('tabInst').onclick = function () { switchTab('install') }
  $('tabMgmt').onclick = function () { switchTab('mgmt') }
  function getCache(key) { try { var c = JSON.parse(localStorage.getItem('packer2-pick-cache') || '{}'); return c[key] || '' } catch (e) { return '' } }
  function setCache(key, val) { try { var c = JSON.parse(localStorage.getItem('packer2-pick-cache') || '{}'); c[key] = val; localStorage.setItem('packer2-pick-cache', JSON.stringify(c)) } catch (e) {} }
  function toggleAll(on) { var items = $('list').querySelectorAll('li'); for (var i=0;i<items.length;i++){ var c=items[i].querySelector('input[type=checkbox]'); if(c) c.checked = on } }
  $('all').onchange = function () { toggleAll($('all').checked) }
  function getChecked() { var out=[]; var items=$('list').querySelectorAll('li'); for (var i=0;i<items.length;i++){ var c=items[i].querySelector('input[type=checkbox]'); var s=items[i].querySelector('select'); if(c&&c.checked&&s) out.push({pluginId:c.getAttribute('data-plugin'), packageId:s.value}) } return out }
  function packOne(pluginId, packageId) {
    var type = $('ptype').value
    var outDir = $('outDir').value.trim()
    $('log').textContent = ''
    if (type === 'whole') {
      log('step', '▸ 打包整包 ' + pluginId + '/' + packageId + '（dsh 安装包 + 便携包，一插件一子文件夹）…')
      fetch(API + '/pack-whole', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: [{ pluginId: pluginId, packageId: packageId }], outDir: outDir }) })
        .then(function (r) { return r.json() }).then(function (d) {
          ;(d.results || []).forEach(function (r) { if (r.ok) log('ok', '✔ ' + r.pluginId + '/' + r.packageId + ' → ' + r.dir + ' （' + r.tgzName + ' + ' + r.portableName + '）'); else log('err', '✘ ' + r.pluginId + '/' + r.packageId + '：' + (r.message || '失败')) })
        }).catch(function (e) { log('err', '✘ 请求失败: ' + e.message) })
      return
    }
    if (type === 'portable') {
      log('step', '▸ 导出 ' + pluginId + ' 便携包（纯 host）…')
      fetch(API + '/export-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: [{ pluginId: pluginId, packageId: packageId }], outDir: outDir }) })
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
    $('log').textContent = ''
    var outDir = $('outDir').value.trim()
    if (type === 'whole') {
      log('step', '▸ 一键打包整包 ' + checked.length + ' 个插件（dsh 安装包 + 便携包，每插件一个子文件夹）…')
      fetch(API + '/pack-whole', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: checked, outDir: outDir }) })
        .then(function (r) { return r.json() }).then(function (d) {
          ;(d.results || []).forEach(function (r) { if (r.ok) log('ok', '✔ ' + r.pluginId + '/' + r.packageId + ' → ' + r.dir); else log('err', '✘ ' + r.pluginId + '/' + r.packageId + '：' + (r.message || '失败')) })
        }).catch(function (e) { log('err', '✘ 请求失败: ' + e.message) })
      return
    }
    if (type === 'portable') {
      log('step', '▸ 导出 ' + checked.length + ' 个便携包（纯 host）到放置目录…')
      fetch(API + '/export-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: checked, outDir: outDir }) })
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
  function pickNative() {
    var rpcId = 'packer2-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    var body = JSON.stringify({ type: 'client-request', rpcId: rpcId, method: 'host.pickDirectory', payload: {} })
    return fetch('/api/host.pickDirectory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body })
      .then(function (r) { return r.json() })
      .then(function (resp) {
        var res = resp && resp.result
        if (res && res.ok === true) {
          if (res.value && typeof res.value.path === 'string' && res.value.path !== '') return { path: res.value.path }
          return { cancelled: true }
        }
        if (res && res.ok === false && res.error && res.error.code === 'cancelled') return { cancelled: true }
        return null
      })
  }
  function pickClassicInto(inputId, start) {
    fetch(API + '/browse/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: start || '' }) })
      .then(function (r2) { return r2.json() })
      .then(function (f) { if (f.picked) { $(inputId).value = f.picked; setCache(inputId, f.picked) } if (f.error) log('err', '⚠ ' + f.error) })
      .catch(function (e) { log('err', '✘ 浏览失败: ' + e.message) })
  }
  function pickInto(inputId) {
    var start = getCache(inputId) || ''
    pickNative().then(function (r) {
      if (r && r.cancelled) return
      if (r && r.path) { $(inputId).value = r.path; setCache(inputId, r.path); return }
      pickClassicInto(inputId, start)
    }).catch(function () { pickClassicInto(inputId, start) })
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
      $('log').textContent = ''
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
  function load() {
    fetch(API + '/plugins').then(function (r) { return r.json() }).then(function (d) {
      if (!d.outDir && $('outDir').value === '') $('outDir').value = d.defaultOutDir || ''
      if (d.defaultOutDir) { if (!getCache('outDir')) setCache('outDir', d.defaultOutDir); if (!getCache('ipath')) setCache('ipath', d.defaultOutDir) }
      if (!d.available) { $('hint').textContent = d.reason || '不可用'; $('list').textContent = ''; return }
      var ps = d.plugins || []
      $('hint').textContent = ps.length ? '共 ' + ps.length + ' 个会话级插件' : '当前没有会话级动态插件'
      var ul = $('list'); ul.textContent = ''
      ps.forEach(function (p) {
        var cur = p.currentPackageId; var pkgs = p.packages || []
        var li = document.createElement('li'); li.className = 'grid'
        var chk = document.createElement('input'); chk.type = 'checkbox'; chk.setAttribute('data-plugin', p.pluginId)
        var nm = document.createElement('b'); nm.className = 'name ellipsis'; nm.textContent = (pkgs.length ? (pkgs[pkgs.length-1].name || p.pluginId) : p.pluginId)
        var idc = document.createElement('code'); idc.className = 'id ellipsis'; idc.textContent = p.pluginId
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
  $('xfile').onchange = function () {
    var f = $('xfile').files[0]; if (!f) return
    var rd = new FileReader()
    rd.onload = function () {
      var data; try { data = JSON.parse(rd.result) } catch (e) { log('err','✘ JSON 解析失败: '+e.message); return }
      if (!data || (data.__dshDynamicPlugin !== true && data.__dshDynamicPlugins !== true)) { log('err','✘ 不是便携动态插件包'); return }
      $('log').textContent=''; log('step','▸ 导入并注册为 Cordis 插件（不运行）…')
      fetch(API+'/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:$('xsess').value.trim()||'',data:data})}).then(function(r){return r.json()}).then(function(d){
        if (d.ok && d.results) { d.results.forEach(function(r){log('ok','✔ 已注册（未运行）'+r.pluginId+'/'+r.packageId+'（'+r.name+'）')}); load() }
        else log('err','✘ '+(d.message||JSON.stringify(d)))
      }).catch(function(e){log('err','✘ 请求失败: '+e.message)})
    }
    rd.readAsText(f)
  }
  function loadInstalled() {
    var profile = $('mprofile').value.trim() || 'web'
    fetch(API + '/installed?profile=' + encodeURIComponent(profile)).then(function (r) { return r.json() }).then(function (d) {
      var ul = $('instList'); ul.textContent = ''
      if (d.error) { var li0 = document.createElement('li'); li0.className = 'mitem'; li0.textContent = '⚠ ' + d.error; ul.appendChild(li0); return }
      ;(d.dependencies || []).forEach(function (dep) {
        var li = document.createElement('li'); li.className = 'mitem'
        var nm = document.createElement('b'); nm.className = 'grow'; nm.textContent = dep.name + (dep.isBundle ? '（bundle）' : '') + (dep.isBase ? '（基础）' : ''); nm.title = dep.spec
        var sp = document.createElement('code'); sp.className = 'mono'; sp.textContent = dep.spec
        var btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = '卸载'; btn.disabled = dep.isBase
        btn.onclick = function () {
          log('step', '▸ 卸载 ' + dep.name + ' …（需批准提升权限）')
          fetch(API + '/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: dep.name, profile: profile }) })
            .then(function (r) { return r.json() }).then(function (x) { log(x.ok ? 'ok' : 'err', (x.ok ? '✔ ' : '✘ ') + (x.ok ? x.note : (x.message || JSON.stringify(x)))); loadInstalled() })
            .catch(function (e) { log('err', '✘ ' + e.message) })
        }
        li.appendChild(nm); li.appendChild(sp); li.appendChild(btn)
        ul.appendChild(li)
      })
    }).catch(function (e) { log('err', '✘ ' + e.message) })
  }
  function pname(p) {
    var pkgs = p.packages || []
    if (p.currentPackageId) { for (var i = 0; i < pkgs.length; i++) if (pkgs[i].packageId === p.currentPackageId) return pkgs[i].name || p.pluginId }
    return pkgs.length ? (pkgs[pkgs.length-1].name || p.pluginId) : p.pluginId
  }
  function elEmpty(text) { var d = document.createElement('div'); d.className = 'empty'; d.textContent = text; return d }
  function buildCard(entry) {
    var card = document.createElement('div'); card.className = 'card'
    var star = document.createElement('button'); star.className = 'star'; star.title = entry.isFav ? '取消收藏' : '收藏'; star.textContent = entry.isFav ? '★' : '☆'
    var nm = document.createElement('div'); nm.className = 'cname'; nm.textContent = entry.name; nm.title = entry.pluginId
    var idc = document.createElement('div'); idc.className = 'cid'; idc.textContent = entry.pluginId
    var sel = null
    if (entry.packages && entry.packages.length) {
      sel = document.createElement('select')
      entry.packages.forEach(function (pk) { var o = document.createElement('option'); o.value = pk.packageId; o.textContent = pk.packageId; if (pk.packageId === entry.currentPackageId) o.selected = true; sel.appendChild(o) })
    } else {
      sel = document.createElement('div'); sel.className = 'cid'; sel.textContent = entry.packageId || ''
    }
    var actions = document.createElement('div'); actions.className = 'cactions'
    var res = document.createElement('button'); res.className = 'resbtn' + (entry.resident ? ' on' : ''); res.textContent = '常驻'
    var rest = document.createElement('button'); rest.textContent = '恢复'; rest.disabled = !entry.isFav; rest.title = entry.isFav ? '恢复该插件并启动' : '先点 ☆ 收藏后才能恢复'
    var copy = document.createElement('button'); copy.className = 'copybtn'; copy.textContent = '复制信息'; copy.title = '导出定义文件并复制路径，供新会话 AI 直接 read（省 token）'
    var pid = entry.pluginId
    var pkgVal = (sel && sel.tagName === 'SELECT') ? sel.value : (entry.packageId || '')
    star.onclick = function () { setFav(pid, pkgVal, entry.isFav ? 'remove' : 'add') }
    res.onclick = function () { setResident(pid, pkgVal, !entry.resident) }
    rest.onclick = function () { restoreOne(pid) }
    copy.onclick = function () { copyInfo(pid) }
    actions.appendChild(res); actions.appendChild(rest)
    card.appendChild(star); card.appendChild(nm); card.appendChild(idc); card.appendChild(sel); card.appendChild(actions); card.appendChild(copy)
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
          }))
        })
      }
      $('favCount').textContent = '（' + favs.length + '）'
      var names = favs.map(function (f) { return f.name })
      var unfav = ps.filter(function (p) { return names.indexOf(pname(p)) === -1 })
      if (unfav.length === 0) { ug.appendChild(elEmpty('当前没有未收藏的会话级插件')) }
      else {
        unfav.forEach(function (p) {
          ug.appendChild(buildCard({ isFav: false, pluginId: p.pluginId, packageId: p.currentPackageId, name: pname(p), resident: false, packages: p.packages, currentPackageId: p.currentPackageId }))
        })
      }
      $('unfavCount').textContent = '（' + unfav.length + '）'
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
  function loadMgmt() { $('mprofile').value = $('mprofile').value.trim() || 'web'; loadInstalled(); loadCards() }
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
function pluginCurrentName(r) {
  const pkgs = (r && r.packages) || []
  if (r && r.currentPackageId) {
    for (let i = 0; i < pkgs.length; i += 1) {
      if (pkgs[i] && String(pkgs[i].packageId) === String(r.currentPackageId)) return String(pkgs[i].name || '')
    }
  }
  return pkgs.length ? String(pkgs[pkgs.length - 1].name || '') : ''
}
function listPlugins(ctx) {
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined || typeof runner.inventory !== 'function') {
    return { available: false, reason: 'dynamicCordisRunner 不可用（组合未挂载 cordis-host-runner）' }
  }
  let rows
  try { rows = runner.inventory() ?? [] } catch (e) { return { available: false, reason: '枚举失败: ' + safeErrorMsg(e) } }
  const plugins = rows.map(function (r) {
    const latest = r.latestRun
    return {
      pluginId: String(r.pluginId),
      packages: (r.packages || []).map(function (p) { return { packageId: String(p.packageId), name: p.name, hasHostHalf: p.hasHostHalf === true, hasClientHalf: p.hasClientHalf === true } }),
      ...(r.currentPackageId === undefined ? {} : { currentPackageId: String(r.currentPackageId) }),
      ...(latest === undefined ? {} : { latestRun: { status: latest.status } }),
    }
  })
  return { available: true, plugins }
}
async function workspaceRoot(ctx) {
  const sp = ctx.get('sandboxPolicy')
  if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '') return sp.workspaceRoot
  const fs = ctx.get('fs')
  if (fs) { try { const t = await fs.resolve('.'); return fs.processPath(t) } catch (e) { /* fallthrough */ } }
  return ''
}
async function runShell(ctx, command, workdir, policy, timeoutMs) {
  const shell = ctx.get('shell')
  if (shell === undefined) throw new Error('shell 服务不可用')
  const spec = shell.resolve({ command, workdir, timeoutMs: timeoutMs || 120000, ...(policy === undefined ? {} : { sandboxPolicy: policy }) })
  const result = await shell.run(spec)
  if (result.exitCode !== 0) {
    const out = (result.stdout && result.stdout.text) || ''
    const errText = (result.stderr && result.stderr.text) || ''
    throw new Error('命令退出码 ' + result.exitCode + (errText ? '：' + errText.slice(0, 500) : '') + (out ? '\n' + out.slice(0, 500) : ''))
  }
  return result
}
async function pickDirNative(ctx, startPath) {
  const fs = ctx.get('fs')
  const shell = ctx.get('shell')
  if (fs === undefined || shell === undefined) throw new Error('fs/shell 服务不可用')
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const dir = ws.replace(/[\\/]+$/, '') + '/.packer2'
  const script = dir + '/pick-dir.ps1'
  await runShell(ctx, 'New-Item -ItemType Directory -Force -Path ' + sq(dir))
  const start = String(startPath || '').trim()
  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$f.Description = '选择目录'",
  ]
  if (start !== '') lines.push("if ($args.Count -gt 0 -and $args[0] -ne '') { try { $f.SelectedPath = $args[0] } catch {} }")
  lines.push('$null = $f.ShowDialog()', "if ($f.SelectedPath -ne '') { Write-Output $f.SelectedPath }", '')
  const content = lines.join('\n')
  const target = await fs.resolve(script)
  await fs.writeText(target, content)
  try {
    const cmd = 'powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File ' + sq(script) + (start === '' ? '' : ' ' + sq(start))
    const spec = shell.resolve({ command: cmd, timeoutMs: 300000 })
    const result = await shell.run(spec)
    if (result.exitCode !== 0) {
      throw new Error('选择器退出码 ' + result.exitCode + ((result.stderr && result.stderr.text) ? '：' + String(result.stderr.text).slice(0, 300) : ''))
    }
    const out = (result.stdout && result.stdout.text) || ''
    const picked = String(out).trim()
    return picked === '' ? null : picked
  } finally {
    try { await runShell(ctx, 'Remove-Item -Force ' + sq(script)) } catch (e) { /* best effort */ }
  }
}
async function uploadBundle(ctx, payload) {
  const name = String((payload && payload.name) || '').trim()
  const b64 = String((payload && payload.base64) || '').replace(/\s+/g, '')
  if (name === '' || b64 === '') throw new Error('缺 name/base64')
  if (b64.length > 70 * 1024 * 1024) throw new Error('文件过大')
  const safeName = (name.split(/[\\/]/).pop() || 'bundle.tgz').replace(/[^\w.\- ]/g, '_')
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const dir = ws.replace(/[\\/]+$/, '') + '/.packer2/uploads'
  const id = rand()
  const b64Path = dir + '/' + id + '.b64'
  const outPath = dir + '/' + id + '-' + safeName
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  await runShell(ctx, 'New-Item -ItemType Directory -Force -Path ' + sq(dir))
  const target = await fs.resolve(b64Path)
  await fs.writeText(target, b64)
  try {
    const cmd = '$b = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath ' + sq(b64Path) + ').Trim()); [System.IO.File]::WriteAllBytes(' + sq(outPath) + ', $b); Remove-Item -Force ' + sq(b64Path)
    await runShell(ctx, cmd)
    return { ok: true, path: outPath, name: safeName, sizeBytes: Number(payload && payload.size) || 0 }
  } catch (error) {
    try { await runShell(ctx, 'Remove-Item -Force ' + sq(b64Path)) } catch (e) { /* best effort */ }
    throw error
  }
}
async function packSessionPlugin(ctx, payload) {
  const pluginId = String(payload.pluginId || '')
  const outDirRaw = String(payload.outDir || '').trim()
  if (!pluginId) throw new Error('缺 pluginId')
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined || typeof runner.inspectPackage !== 'function') throw new Error('dynamicCordisRunner 不可用')
  const row = (runner.inventory() || []).find(function (r) { return String(r.pluginId) === pluginId })
  if (row === undefined) throw new Error('会话级插件不存在: ' + pluginId)
  const want = payload.packageId && String(payload.packageId) !== ''
    ? String(payload.packageId)
    : (row.currentPackageId !== undefined ? String(row.currentPackageId) : (row.packages && row.packages.length ? String(row.packages[row.packages.length - 1].packageId) : undefined))
  if (want === undefined) throw new Error('插件 ' + pluginId + ' 没有任何包可打包')
  const inspected = runner.inspectPackage({ id: row.agentId }, pluginId, want)
  const hostCode = (inspected && inspected.code && inspected.code.host) || ''
  const clientCode = (inspected && inspected.code && inspected.code.client) || ''
  const pkgName = String((inspected && inspected.pluginId) || pluginId)
  const version = '0.1.0'
  const notes = []
  if (clientCode.trim() !== '') notes.push('client 半区已打包为组合环境可加载的 factory-form CJS（经 __ModuleLoader__ 装载，host.call 桥接 connection.rpc）')
  if (/(^|[^\w$.])harness\s*[.([]/.test(hostCode)) notes.push('host 半区引用沙箱全局 harness：安装为普通组合插件后运行时可能未定义')
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const staging = ws.replace(/[\\/]+$/, '') + '/.packer2/staging-' + rand()
  const outDir = outDirRaw === '' ? ws.replace(/[\\/]+$/, '') + '/packer2-out' : outDirRaw
  const wsNorm = normPath(ws).toLowerCase()
  const outNorm = normPath(outDir).toLowerCase()
  const outside = outNorm !== wsNorm && !outNorm.startsWith(wsNorm + '/')
  const policy = outside ? { mode: 'danger-full-access' } : undefined
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  const shell = ctx.get('shell')
  if (shell === undefined) throw new Error('shell 服务不可用')
  try {
    await runShell(ctx, 'New-Item -ItemType Directory -Force -Path ' + sq(staging) + ',' + sq(outDir), undefined, policy)
    const hasClient = clientCode.trim() !== ''
    const manifest = {
      name: pkgName, version, description: (inspected && inspected.purpose) || '', type: 'module', main: 'index.js',
      files: ['index.js', 'host.js', 'client.js', 'cordis.patch.yml'],
      ...(hasClient ? { exports: { '.': './index.js', './client': './client.js' } } : {}),
      dsh: { bundle: { patch: './cordis.patch.yml' }, ...(hasClient ? { client: { platform: 'web' } } : {}) },
    }
    const files = {
      'package.json': JSON.stringify(manifest, null, 2),
      'host.js': hostCode,
      'client.js': clientBundleSource(pkgName, clientCode),
      'index.js': entrySource(pkgName),
      'cordis.patch.yml': '# synthesized by packer2\n- insert:\n    - id: ' + pkgName + '\n      name: ' + pkgName + '\n',
    }
    for (const rel of Object.keys(files)) {
      const target = await fs.resolve(staging + '/' + rel)
      await fs.writeText(target, files[rel])
    }
    await runShell(ctx, 'pnpm pack --reporter append-only --pack-destination ' + sq(outDir), staging, policy)
    const artifact = outDir.replace(/[\\/]+$/, '') + '/' + pkgName + '-' + version + '.tgz'
    const cmd = '$h = (Get-FileHash -Algorithm SHA256 -Path ' + sq(artifact) + ').Hash.ToLower()'
      + '; $s = (Get-Item ' + sq(artifact) + ').Length'
      + '; Write-Output ("SHA256=" + $h)'
      + '; Write-Output ("SIZE=" + $s)'
      + '; Remove-Item -Recurse -Force ' + sq(staging)
    const res = await runShell(ctx, cmd, undefined, policy)
    const out = (res.stdout && res.stdout.text) || ''
    let sha256 = ''
    let sizeBytes = 0
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('SHA256=')) sha256 = line.slice(7).trim()
      if (line.startsWith('SIZE=')) sizeBytes = parseInt(line.slice(5), 10) || 0
    }
    if (!sha256) throw new Error('未能从 shell 输出解析 SHA-256：' + out.slice(0, 300))
    return { ok: true, artifactPath: artifact, artifactName: pkgName + '-' + version + '.tgz', sha256, sizeBytes, packageName: pkgName, version, packageId: want, notes }
  } catch (error) {
    try { await runShell(ctx, 'Remove-Item -Recurse -Force ' + sq(staging)) } catch (e) { /* best effort */ }
    const msg = String(error && error.message ? error.message : error)
    if (outside && /EPERM|denied|permission|沙箱/i.test(msg)) {
      throw new Error('输出目录 ' + outDir + ' 在沙箱允许范围外（当前工作区：' + ws + '）。请把放置目录改到工作区内（例如 ' + ws.replace(/[\\/]+$/, '') + '\\packer2-out），或调整沙箱策略后重试。')
    }
    throw error
  }
}
function exportDynamicPlugin(ctx, pluginId, packageId, pureHost) {
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined || typeof runner.inspectPackage !== 'function') throw new Error('dynamicCordisRunner 不可用')
  const row = (runner.inventory() || []).find(function (r) { return String(r.pluginId) === pluginId })
  if (row === undefined) throw new Error('会话级插件不存在: ' + pluginId)
  const want = packageId && String(packageId) !== ''
    ? String(packageId)
    : (row.currentPackageId !== undefined ? String(row.currentPackageId) : (row.packages && row.packages.length ? String(row.packages[row.packages.length - 1].packageId) : undefined))
  if (want === undefined) throw new Error('插件没有任何包可导出')
  const inspected = runner.inspectPackage({ id: row.agentId }, pluginId, want)
  const code = {}
  if (inspected.code && inspected.code.host !== undefined) code.host = inspected.code.host
  if (pureHost !== true && inspected.code && inspected.code.client !== undefined) code.client = inspected.code.client
  return {
    __dshDynamicPlugin: true,
    format: 1,
    pluginId: String(inspected.pluginId),
    packageId: String(want),
    ownerSessionId: String(row.agentId),
    name: inspected.name,
    purpose: inspected.purpose,
    code,
  }
}
async function exportBatch(ctx, payload) {
  const plugins = (payload && payload.plugins) || []
  const outDirRaw = String((payload && payload.outDir) || '')
  if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('未勾选任何插件')
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const outDir = outDirRaw === '' ? ws.replace(/[\\/]+$/, '') + '/packer2-out' : outDirRaw
  const wsNorm = normPath(ws).toLowerCase()
  const outNorm = normPath(outDir).toLowerCase()
  const outside = outNorm !== wsNorm && !outNorm.startsWith(wsNorm + '/')
  const policy = outside ? { mode: 'danger-full-access' } : undefined
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  await runShell(ctx, 'New-Item -ItemType Directory -Force -Path ' + sq(outDir), undefined, policy)
  const results = []
  for (const p of plugins) {
    try {
      const data = sanitizePortable(exportDynamicPlugin(ctx, p.pluginId, p.packageId))
      const artifact = outDir.replace(/[\\/]+$/, '') + '/' + data.pluginId + '-' + data.packageId + '.dshplugin.json'
      const target = await fs.resolve(artifact)
      await fs.writeText(target, JSON.stringify(data, null, 2), undefined, undefined, policy)
      results.push({ pluginId: p.pluginId, packageId: p.packageId, ok: true, path: artifact })
    } catch (e) {
      results.push({ pluginId: p.pluginId, packageId: p.packageId, ok: false, message: safeErrorMsg(e) })
    }
  }
  return { ok: true, results }
}
async function packBatch(ctx, payload) {
  const plugins = (payload && payload.plugins) || []
  const outDirRaw = String((payload && payload.outDir) || '')
  if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('未勾选任何插件')
  const results = []
  for (const p of plugins) {
    try {
      const r = await packSessionPlugin(ctx, { pluginId: p.pluginId, packageId: p.packageId, outDir: outDirRaw })
      results.push({ pluginId: p.pluginId, packageId: p.packageId, ok: true, artifactPath: r.artifactPath, sha256: r.sha256, sizeBytes: r.sizeBytes, notes: r.notes })
    } catch (e) {
      results.push({ pluginId: p.pluginId, packageId: p.packageId, ok: false, message: safeErrorMsg(e) })
    }
  }
  return { ok: true, results }
}
// ── 打包整包：dsh 安装包（.tgz）+ 便携包（.dshplugin.json）到同一文件夹（每插件一个子文件夹）──
async function packWhole(ctx, payload) {
  const plugins = (payload && payload.plugins) || []
  const outDirRaw = String((payload && payload.outDir) || '')
  if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('未勾选任何插件')
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const outDir = outDirRaw === '' ? ws.replace(/[\\/]+$/, '') + '/packer2-out' : outDirRaw
  const wsNorm = normPath(ws).toLowerCase()
  const outNorm = normPath(outDir).toLowerCase()
  const outside = outNorm !== wsNorm && !outNorm.startsWith(wsNorm + '/')
  const policy = outside ? { mode: 'danger-full-access' } : undefined
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  await runShell(ctx, 'New-Item -ItemType Directory -Force -Path ' + sq(outDir), undefined, policy)
  const results = []
  for (const p of plugins) {
    try {
      const pluginId = String(p.pluginId || '')
      const packageId = String(p.packageId || '')
      if (!pluginId) throw new Error('缺 pluginId')
      const subDir = outDir.replace(/[\\/]+$/, '') + '/' + pluginId + (packageId === '' ? '' : '-' + packageId)
      await runShell(ctx, 'New-Item -ItemType Directory -Force -Path ' + sq(subDir), undefined, policy)
      const tgz = await packSessionPlugin(ctx, { pluginId: pluginId, packageId: packageId, outDir: subDir })
      const data = sanitizePortable(exportDynamicPlugin(ctx, pluginId, packageId))
      const portableName = data.pluginId + '-' + data.packageId + '.dshplugin.json'
      const artifact = subDir.replace(/[\\/]+$/, '') + '/' + portableName
      const target = await fs.resolve(artifact)
      await fs.writeText(target, JSON.stringify(data, null, 2), undefined, undefined, policy)
      results.push({
        pluginId: pluginId,
        packageId: packageId,
        ok: true,
        dir: subDir,
        tgzPath: tgz.artifactPath,
        tgzName: tgz.artifactName,
        sha256: tgz.sha256,
        sizeBytes: tgz.sizeBytes,
        portablePath: artifact,
        portableName: portableName,
        notes: tgz.notes,
      })
    } catch (e) {
      results.push({ pluginId: String(p.pluginId || ''), packageId: String(p.packageId || ''), ok: false, message: safeErrorMsg(e) })
    }
  }
  return { ok: true, outDir, results }
}
async function importDynamicPlugin(ctx, payload, runIt) {
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined || typeof runner.define !== 'function') throw new Error('dynamicCordisRunner 不可用')
  const data = payload && payload.data
  let items = []
  if (data && data.__dshDynamicPlugins === true && Array.isArray(data.plugins)) items = data.plugins
  else if (data && data.__dshDynamicPlugin === true) items = [data]
  else throw new Error('不是便携动态插件包')
  let sessionId = String((payload && payload.sessionId) || (items.length ? items[0].ownerSessionId : '') || '')
  if (isFakeSessionId(sessionId)) sessionId = await resolveCurrentSessionId(ctx)
  if (sessionId === '') {
    // 兜底：取当前进程任一已存在会话（与自动恢复一致）
    try {
      const rows = runner.inventory() || []
      for (const r of rows) { if (r && r.agentId) { sessionId = String(r.agentId); break } }
    } catch (e) { /* 保持空 */ }
  }
  if (sessionId === '') throw new Error('导入需要所属会话 id（sessionId）')
  const results = []
  for (const item of items) {
    if (!item || item.__dshDynamicPlugin !== true) continue
    const name = String(item.name || 'imported-dynamic-plugin')
    const purpose = String(item.purpose || '')
    const code = {}
    if (item.code && typeof item.code.host === 'string') code.host = item.code.host
    if (item.code && typeof item.code.client === 'string') code.client = item.code.client
    if (code.host === undefined && code.client === undefined) continue
    let targetPluginId = null
    let targetSessionId = ''
    let targetCurrentId = ''
    try {
      const rows = runner.inventory() || []
      for (const r of rows) {
        if (pluginCurrentName(r) === name) {
          targetPluginId = String(r.pluginId)
          targetSessionId = String(r.agentId || '')
          targetCurrentId = r.currentPackageId !== undefined ? String(r.currentPackageId) : ''
          break
        }
      }
    } catch (e) { targetPluginId = null }
    const useSessionId = targetSessionId || sessionId
    const prefix = String(item.pluginId || 'dyn').replace(/-\d+$/, '').slice(0, 6).toLowerCase().replace(/[^a-z]/g, '') || 'dyn'
    let receipt
    if (targetPluginId !== null) {
      if (targetCurrentId !== '' && typeof runner.inspectPackage === 'function') {
        try {
          const inspected = runner.inspectPackage({ id: targetSessionId }, targetPluginId, targetCurrentId)
          const curHost = (inspected && inspected.code && inspected.code.host) || ''
          const newHost = (item.code && item.code.host) || ''
          if (curHost === newHost) {
            if (runIt !== false) {
              try { await runner.run({ id: useSessionId }, targetPluginId, targetCurrentId, 'run', undefined) } catch (e) { /* 运行可选 */ }
            }
            results.push({ pluginId: targetPluginId, packageId: targetCurrentId, name })
            continue
          }
        } catch (e) { /* 比较失败，走追加新版本 */ }
      }
      receipt = runner.define({ sessionId: useSessionId, plugin: { kind: 'existing', pluginId: targetPluginId }, name, purpose, code })
      if (runIt !== false) {
        try {
          const mode = targetCurrentId !== '' ? 'update' : 'run'
          await runner.run({ id: useSessionId }, receipt.pluginId, receipt.packageId, mode, undefined)
        } catch (e) { /* 运行可选 */ }
      }
    } else {
      receipt = runner.define({ sessionId: useSessionId, plugin: { kind: 'new', idPrefix: prefix }, name, purpose, code })
      if (runIt !== false) {
        try { await runner.run({ id: useSessionId }, receipt.pluginId, receipt.packageId, 'run', undefined) } catch (e) { /* 运行可选 */ }
      }
    }
    results.push({ pluginId: String(receipt.pluginId), packageId: String(receipt.packageId), name })
  }
  return { ok: true, results }
}
async function dedupePlugins(ctx) {
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined || typeof runner.inventory !== 'function' || typeof runner.undefine !== 'function') {
    throw new Error('dynamicCordisRunner 不可用（缺 inventory/undefine）')
  }
  const rows = runner.inventory() || []
  const byName = {}
  for (const r of rows) {
    const nm = pluginCurrentName(r)
    if (nm === '') continue
    if (byName[nm] === undefined) byName[nm] = []
    byName[nm].push(r)
  }
  const removed = []
  for (const nm of Object.keys(byName)) {
    const group = byName[nm]
    if (group.length < 2) continue
    const keep = group.find(function (r) { return r.activeRun !== undefined }) || group[0]
    for (const r of group) {
      if (r === keep) continue
      try {
        const res = await runner.undefine({ id: r.agentId }, r.pluginId)
        if (res && res.ok) removed.push(String(r.pluginId))
      } catch (e) { /* 静默 */ }
    }
  }
  const obj = await readFavorites(ctx)
  const seen = {}
  const favs = []
  for (const f of obj.favorites || []) {
    const nm = String(f.name || '')
    if (nm === '' || seen[nm]) continue
    seen[nm] = true
    favs.push(f)
  }
  obj.favorites = favs
  await writeFavorites(ctx, obj)
  return { ok: true, removed, favorites: obj.favorites.length }
}
async function installBundle(ctx, payload) {
  const path = String(payload && payload.path || '').trim()
  const profile = String(payload && payload.profile || 'web').trim()
  if (!validProfile(profile)) throw new Error('非法的 profile 名称（仅允许字母/数字/-/_）')
  if (!path) throw new Error('缺安装路径')
  const ws = await workspaceRoot(ctx) || ''
  let target = path
  let tmpDir = null
  if (/\.dshplugin$/i.test(path)) {
    tmpDir = ws.replace(/[\\/]+$/, '') + '/.packer2/install-' + rand()
    await runShell(ctx, 'New-Item -ItemType Directory -Force -Path ' + sq(tmpDir))
    target = tmpDir + '/install.tgz'
    await runShell(ctx, 'Copy-Item -Force ' + sq(path) + ' ' + sq(target))
  }
  const policy = { mode: 'danger-full-access' }
  const cliPath = ws.replace(/[\\/]+$/, '') + '/apps/cli/lib/bin.js'
  try {
    await runShell(ctx, 'node ' + sq(cliPath) + ' plugin --profile ' + sq(profile) + ' add ' + sq(target), ws, policy, 300000)
    if (tmpDir) { try { await runShell(ctx, 'Remove-Item -Recurse -Force ' + sq(tmpDir)) } catch (e) { /* best effort */ } }
    return { ok: true, path, profile, note: '已执行 dsh plugin add（built CLI）；重启 dsh 后生效（profile: ' + profile + '）' }
  } catch (error) {
    if (tmpDir) { try { await runShell(ctx, 'Remove-Item -Recurse -Force ' + sq(tmpDir)) } catch (e) { /* best effort */ } }
    const msg = String(error && error.message ? error.message : error)
    throw new Error('安装失败：' + msg + '（安装会写入 $DSH_HOME/profiles/' + profile + '，需要提升沙箱权限，请在弹窗中批准；若报 INVALID_DEPENDENCY_NAME，请用「安装 dsh 包」选 .tgz 文件而非中文名目录）')
  }
}
async function dshHome(ctx) {
  const res = await runShell(ctx, "if ($env:DSH_HOME) { Write-Output $env:DSH_HOME } else { Write-Output (Join-Path $env:USERPROFILE '.dsh') }")
  const out = String((res.stdout && res.stdout.text) || '').trim().split(/\r?\n/)[0]
  return (out || '').replace(/[\\/]+$/, '')
}
async function installedPlugins(ctx, profile) {
  if (!validProfile(profile)) return { profile, error: '非法的 profile 名称（仅允许字母/数字/-/_）' }
  const home = await dshHome(ctx)
  const manifestPath = home + '/profiles/' + profile + '/package.json'
  let text
  try {
    const res = await runShell(ctx, 'Get-Content -Raw -LiteralPath ' + sq(manifestPath), undefined, { mode: 'danger-full-access' })
    text = (res.stdout && res.stdout.text) || ''
  } catch (e) {
    console.log('installedPlugins 读取失败: ' + String(e && e.message ? e.message : e))
    return { profile, error: '读取 profile 失败' }
  }
  let manifest
  try { manifest = JSON.parse(text) } catch (e) { return { profile, error: 'profile manifest 解析失败' } }
  const deps = (manifest && manifest.dependencies) || {}
  const bundles = (manifest && manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
  const baseBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  return {
    profile,
    dependencies: Object.keys(deps).map(function (n) { return { name: n, spec: String(deps[n]), isBundle: bundles.indexOf(n) !== -1, isBase: baseBundles.indexOf(n) !== -1 } }),
  }
}
async function uninstallBundle(ctx, payload) {
  const name = String(payload && payload.name || '').trim()
  const profile = String(payload && payload.profile || 'web').trim()
  if (!validProfile(profile)) throw new Error('非法的 profile 名称（仅允许字母/数字/-/_）')
  if (!name) throw new Error('缺插件名')
  const ws = await workspaceRoot(ctx)
  const cliPath = ws.replace(/[\\/]+$/, '') + '/apps/cli/lib/bin.js'
  await runShell(ctx, 'node ' + sq(cliPath) + ' plugin --profile ' + sq(profile) + ' remove ' + sq(name), ws, { mode: 'danger-full-access' }, 300000)
  return { ok: true, name, profile, note: '已卸载 ' + name + '；重启 dsh 后生效（profile: ' + profile + '）' }
}
// 收藏文件写入串行化：避免并发 read-modify-write 竞态丢失更新
let favQueue = Promise.resolve()
function favSerialize(fn) {
  const run = favQueue.then(fn, fn)
  favQueue = run.then(function () {}, function () {})
  return run
}
async function favoritesPath(ctx) {
  const ws = await workspaceRoot(ctx)
  return ws.replace(/[\\/]+$/, '') + '/packer2-favorites.json'
}
async function readFavorites(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return { favorites: [] }
  try {
    const t = await fs.resolve(await favoritesPath(ctx))
    const txt = await fs.readText(t)
    const obj = JSON.parse(txt)
    return (obj && Array.isArray(obj.favorites)) ? obj : { favorites: [] }
  } catch (e) { return { favorites: [] } }
}
async function writeFavorites(ctx, obj) {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  const t = await fs.resolve(await favoritesPath(ctx))
  await fs.writeText(t, JSON.stringify(obj, null, 2))
}
async function favoriteAdd(ctx, pluginId, packageId) {
  return favSerialize(async function () {
    const data = exportDynamicPlugin(ctx, pluginId, packageId)
    const obj = await readFavorites(ctx)
    const idx = obj.favorites.findIndex(function (f) { return f.pluginId === data.pluginId || (f.name && data.name && f.name === data.name) })
    if (idx >= 0) { data.resident = obj.favorites[idx].resident; obj.favorites[idx] = data }
    else obj.favorites.push(data)
    await writeFavorites(ctx, obj)
    return { ok: true, count: obj.favorites.length }
  })
}
async function favoriteRemove(ctx, pluginId) {
  return favSerialize(async function () {
    const obj = await readFavorites(ctx)
    let name = ''
    try {
      const runner = ctx.get('dynamicCordisRunner')
      const row = (runner.inventory() || []).find(function (r) { return String(r.pluginId) === pluginId })
      if (row) name = pluginCurrentName(row)
    } catch (e) { name = '' }
    obj.favorites = obj.favorites.filter(function (f) {
      if (name !== '' && f.name === name) return false
      return String(f.pluginId) !== String(pluginId)
    })
    await writeFavorites(ctx, obj)
    return { ok: true, count: obj.favorites.length }
  })
}
async function favoriteSetResident(ctx, pluginId, packageId, resident) {
  return favSerialize(async function () {
    const obj = await readFavorites(ctx)
    const data = exportDynamicPlugin(ctx, pluginId, packageId)
    const idx = obj.favorites.findIndex(function (f) { return f.pluginId === data.pluginId || (f.name && data.name && f.name === data.name) })
    if (idx >= 0) {
      obj.favorites[idx] = data
      obj.favorites[idx].resident = resident === true
    } else {
      data.resident = resident === true
      obj.favorites.push(data)
    }
    await writeFavorites(ctx, obj)
    return { ok: true, count: obj.favorites.length }
  })
}
async function restoreOne(ctx, pluginId) {
  const obj = await readFavorites(ctx)
  let item = (obj.favorites || []).find(function (f) { return f.pluginId === pluginId })
  if (!item) {
    const runner = ctx.get('dynamicCordisRunner')
    let name = ''
    try {
      const row = (runner.inventory() || []).find(function (r) { return String(r.pluginId) === pluginId })
      if (row) name = pluginCurrentName(row)
    } catch (e) { name = '' }
    item = (obj.favorites || []).find(function (f) { return name !== '' && f.name === name })
  }
  if (!item) throw new Error('该插件尚未收藏：先点 ☆ 收藏，再恢复')
  return importDynamicPlugin(ctx, { data: item, sessionId: '' }, true)
}
async function restoreFavorites(ctx) {
  const obj = await readFavorites(ctx)
  const items = obj.favorites || []
  if (items.length === 0) return { ok: true, results: [], note: '暂无收藏' }
  return importDynamicPlugin(ctx, { data: { __dshDynamicPlugins: true, plugins: items }, sessionId: '' }, true)
}
async function autoRestoreResident(ctx) {
  const obj = await readFavorites(ctx)
  const items = (obj.favorites || []).filter(function (f) { return f && f.resident === true && f.__dshDynamicPlugin === true })
  if (items.length === 0) return
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined || typeof runner.inventory !== 'function') return
  const names = []
  const ids = []
  let sid = ''
  try {
    const rows = runner.inventory() || []
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]
      if (r && r.pluginId) ids.push(String(r.pluginId))
      if (r && r.agentId && sid === '') sid = String(r.agentId)
      const pkgs = (r && r.packages) || []
      for (let j = 0; j < pkgs.length; j += 1) {
        if (pkgs[j] && pkgs[j].name) names.push(String(pkgs[j].name))
      }
    }
  } catch (e) { /* 保持空 */ }
  const todoRaw = items.filter(function (f) {
    return names.indexOf(String(f.name || '')) === -1 && ids.indexOf(String(f.pluginId || '')) === -1
  })
  if (todoRaw.length === 0) return
  const seen = {}
  const todo = []
  for (let i = 0; i < todoRaw.length; i += 1) {
    const nm = String(todoRaw[i].name || '')
    if (nm === '') continue
    if (seen[nm]) continue
    seen[nm] = true
    todo.push(todoRaw[i])
  }
  if (todo.length === 0) return
  let currentSid = ''
  try {
    const agents = ctx.get('agents')
    if (agents) {
      if (typeof agents.currentInitiator === 'function') { const i = agents.currentInitiator(); if (i && i.id) currentSid = String(i.id) }
      if (currentSid === '' && typeof agents.roots === 'function') { const roots = agents.roots(); if (roots && roots.length === 1) currentSid = String(roots[0].id || '') }
    }
  } catch (e) { /* 保持空 */ }
  const sessionId = currentSid || String((todo[0] && todo[0].ownerSessionId) || '') || sid
  if (sessionId === '') return
  try { await importDynamicPlugin(ctx, { data: { __dshDynamicPlugins: true, plugins: todo }, sessionId: sessionId }, true) } catch (e) { /* 静默 */ }
}
async function snapshotPlugin(ctx, pluginId) {
  const data = sanitizePortable(exportDynamicPlugin(ctx, pluginId, ''))
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const dir = ws.replace(/[\\/]+$/, '') + '/packer2-snapshot'
  await runShell(ctx, 'New-Item -ItemType Directory -Force -Path ' + sq(dir))
  const artifact = dir + '/' + data.pluginId + '-' + data.packageId + '.dshplugin.json'
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  const target = await fs.resolve(artifact)
  await fs.writeText(target, JSON.stringify(data, null, 2))
  return { ok: true, path: artifact, pluginId: data.pluginId, packageId: data.packageId, name: data.name }
}
async function handleRequest(ctx, req, res) {
  try {
    if (!isTrustedRequest(req)) {
      send(res, 403, { ok: false, message: '请求被拒绝（Host 非 loopback 或 Origin 跨源）' })
      return
    }
    const u = parsePath(req.url)
    let path = u.path.replace(/^\/packer2/, '') || '/'
    if (path === '/') {
      if (req.method !== 'GET') { send(res, 405, { message: 'method not allowed' }); return }
      const embed = u.query.split('&').indexOf('embed=1') !== -1
      sendHtml(res, pageHtml(embed))
      return
    }
    if (path === '/api/plugins' && req.method === 'GET') {
      const d = listPlugins(ctx)
      send(res, 200, { ...d, defaultOutDir: (await workspaceRoot(ctx)) + '/packer2-out' })
      return
    }
    if (path === '/api/snapshot' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await snapshotPlugin(ctx, String(body && body.pluginId || ''))) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/export' && req.method === 'GET') {
      const p = u.query
      const qs = {}
      try {
        p.split('&').forEach(function (kv) { const i = kv.indexOf('='); if (i > 0) qs[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)) })
      } catch (e) { send(res, 400, { ok: false, message: '查询参数不是合法编码' }); return }
      try { const data = sanitizePortable(exportDynamicPlugin(ctx, qs.pluginId, qs.packageId)); sendDownload(res, data.pluginId + '-' + data.packageId + '.dshplugin.json', data) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/export-batch' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await exportBatch(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/pack-batch' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await packBatch(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/pack-whole' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await packWhole(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/import' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await importDynamicPlugin(ctx, body, false)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/install' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await installBundle(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/upload' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await uploadBundle(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/installed' && req.method === 'GET') {
      const qs = {}
      try {
        u.query.split('&').forEach(function (kv) { const i = kv.indexOf('='); if (i > 0) qs[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)) })
      } catch (e) { send(res, 400, { ok: false, message: '查询参数不是合法编码' }); return }
      const profile = String(qs.profile || 'web')
      try { send(res, 200, await installedPlugins(ctx, profile)) } catch (e) { send(res, 200, { profile, error: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/uninstall' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await uninstallBundle(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/dedupe' && req.method === 'POST') {
      try { send(res, 200, await dedupePlugins(ctx)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/favorites' && req.method === 'GET') {
      try { send(res, 200, { ok: true, favorites: (await readFavorites(ctx)).favorites.map(function (f) { return { pluginId: f.pluginId, packageId: f.packageId, name: f.name, resident: f.resident === true } }) }) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/favorite' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try {
        if (body && body.action === 'remove') send(res, 200, await favoriteRemove(ctx, String(body.pluginId || '')))
        else if (body && body.action === 'resident') send(res, 200, await favoriteSetResident(ctx, String(body.pluginId || ''), String(body.packageId || ''), body.resident === true))
        else send(res, 200, await favoriteAdd(ctx, String(body.pluginId || ''), String(body.packageId || '')))
      } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/restore-one' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await restoreOne(ctx, String(body && body.pluginId || ''))) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/restore-favorites' && req.method === 'POST') {
      try { send(res, 200, await restoreFavorites(ctx)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/browse' && req.method === 'GET') {
      const svc = ctx.get('directoryPicker')
      if (svc === undefined || typeof svc.capability !== 'function') { send(res, 200, { kind: 'none', reason: 'directoryPicker 服务不可用' }); return }
      const cap = svc.capability()
      if (cap.kind === 'native') { send(res, 200, { kind: 'native' }); return }
      if (cap.kind === 'browse') {
        let target
        try { target = u.query.startsWith('path=') ? decodeURIComponent(u.query.slice(5)) : undefined } catch (e) { target = undefined }
        if (target !== undefined && target !== '') {
          const ws = (await workspaceRoot(ctx)) || ''
          const tNorm = normPath(String(target)).toLowerCase()
          const wNorm = normPath(ws).toLowerCase()
          if (tNorm !== wNorm && !tNorm.startsWith(wNorm + '/')) { send(res, 200, { kind: 'browse', error: '路径超出工作区范围' }); return }
        }
        try { const listing = await cap.list(target === '' ? undefined : target); send(res, 200, { kind: 'browse', ...listing }); return } catch (e) { send(res, 200, { kind: 'browse', error: safeErrorMsg(e) }); return }
      }
      send(res, 200, { kind: 'none', reason: '未知 directoryPicker 后端: ' + cap.kind })
      return
    }
    if (path === '/api/browse/pick' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) {
        if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return }
        body = {}
      }
      const svc = ctx.get('directoryPicker')
      if (svc === undefined || typeof svc.capability !== 'function' || svc.capability().kind !== 'native') {
        send(res, 200, { picked: null, error: '原生目录选择不可用' })
        return
      }
      try { const picked = await pickDirNative(ctx, body && body.start); send(res, 200, { picked }) } catch (e) { send(res, 200, { picked: null, error: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/browse/create' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      const svc = ctx.get('directoryPicker')
      if (svc === undefined || typeof svc.capability !== 'function') { send(res, 200, { ok: false, message: 'directoryPicker 服务不可用' }); return }
      const cap = svc.capability()
      if (cap.kind !== 'browse') { send(res, 200, { ok: false, message: '当前后端不支持新建目录' }); return }
      try {
        const base = String((body && body.path) || '')
        const ws = (await workspaceRoot(ctx)) || ''
        const bNorm = normPath(base).toLowerCase()
        const wNorm = normPath(ws).toLowerCase()
        if (bNorm !== wNorm && !bNorm.startsWith(wNorm + '/')) { send(res, 200, { ok: false, message: '路径超出工作区范围' }); return }
        const created = await cap.createDirectory(base, String((body && body.name) || '')); send(res, 200, { ok: true, created }); return
      } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }); return }
    }
    if (path === '/api/pack' && req.method === 'POST') {
      let payload
      try { payload = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await packSessionPlugin(ctx, payload || {})) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    send(res, 404, { message: 'not found: ' + path })
  } catch (error) {
    const msg = String(error && error.message ? error.message : error)
    const status = msg === 'body-too-large' ? 413 : 500
    try { send(res, status, { ok: false, message: msg === 'body-too-large' ? '请求体过大' : safeErrorMsg(msg) }) } catch (e) { res.destroy() }
  }
}
return {
  inject: ['webServer', 'dynamicCordisRunner', 'fs'],
  apply(ctx) {
    const untap = ctx.webServer.tapIndex?.((html) => injectButton(html))
    if (untap !== undefined) ctx.effect(() => untap, 'packer2: shell button')
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/packer2',
      handler: (req, res) => { void handleRequest(ctx, req, res) },
    })
    ctx.effect(() => dispose, 'packer2: ui route')
    void autoRestoreResident(ctx)
  },
}