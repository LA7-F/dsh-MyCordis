// [ui/button] 页面右下角悬浮入口按钮与其 index 注入脚本
function buttonScript() {
  return `(function () {
  'use strict'
  var ID = 'dsh-plugin-builder2-entry'
  var PANEL_ID = 'dsh-plugin-builder2-panel'
  var panel = null
  function el(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e }
  // 面板外壳与 iframe 内页必须同一套深浅色：内页用 prefers-color-scheme 判断，
  // 这里读同一个媒体查询，避免「深色页面 + 亮白标题栏」的割裂。
  function theme() {
    var dark = false
    try { dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) } catch (e) { dark = false }
    return dark
      ? { bg: '#1d2024', head: '#23272c', fg: '#e7e9ec', muted: '#838b96', line: '#31363d', shadow: '0 22px 48px rgba(0,0,0,.55)' }
      : { bg: '#ffffff', head: '#f7f8fa', fg: '#1f2329', muted: '#8b93a0', line: '#e2e6ec', shadow: '0 18px 44px rgba(15,20,30,.22)' }
  }
  function closePanel() {
    if (!panel) return
    panel.style.opacity = '0'; panel.style.transform = 'translateY(-8px) scale(.985)'
    var p = panel; panel = null
    setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p) }, 220)
  }
  function toggle(btn) {
    if (panel) { closePanel(); return }
    var t = theme()
    var W = 640, H = 620
    var maxW = Math.min(W, window.innerWidth - 16)
    var maxH = Math.min(H, Math.round(window.innerHeight * 0.84))
    var p = el('div'); p.id = PANEL_ID
    p.style.cssText = 'position:fixed;z-index:9999;width:' + maxW + 'px;height:' + maxH + 'px;display:flex;flex-direction:column;overflow:hidden;'
      + 'background:' + t.bg + ';border:1px solid ' + t.line + ';border-radius:12px;box-shadow:' + t.shadow + ';'
      + 'font-family:var(--dsw-font-family,sans-serif);font-size:12px;color:' + t.fg + ';opacity:0;transform:translateY(-8px) scale(.985);'
      + 'transition:opacity .18s ease,transform .2s cubic-bezier(.2,.8,.3,1)'
    var r = btn.getBoundingClientRect()
    var left = r.right - maxW
    if (left < 8) left = r.left
    if (left + maxW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - maxW - 8)
    var top = r.top - maxH - 8
    if (top < 8) top = Math.min(r.bottom + 8, Math.max(8, window.innerHeight - maxH - 8))
    p.style.left = left + 'px'; p.style.top = top + 'px'
    var head = el('div')
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:0 8px 0 13px;background:' + t.head + ';border-bottom:1px solid ' + t.line + ';height:38px;box-sizing:border-box'
    var dot = el('span')
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#3b7cf6;flex:none'
    var title = el('span', '我的Cordis')
    title.style.cssText = 'font-weight:600;font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    var close = el('button', '✕')
    close.type = 'button'
    close.title = '关闭（Esc）'
    close.style.cssText = 'width:26px;height:26px;border:none;border-radius:7px;background:transparent;color:' + t.muted + ';cursor:pointer;font-size:12px;line-height:1;font-family:inherit'
    close.onmouseenter = function () { close.style.background = t.bg; close.style.color = t.fg }
    close.onmouseleave = function () { close.style.background = 'transparent'; close.style.color = t.muted }
    close.onclick = closePanel
    head.appendChild(dot); head.appendChild(title); head.appendChild(close)
    p.appendChild(head)
    var fr = el('iframe'); fr.style.cssText = 'flex:1;border:none;width:100%;background:' + t.bg
    fr.src = '/packer2/?embed=1'
    p.appendChild(fr)
    document.body.appendChild(p)
    panel = p
    requestAnimationFrame(function () { requestAnimationFrame(function () { p.style.opacity = '1'; p.style.transform = 'translateY(0) scale(1)' }) })
  }
  function mount() {
    var existing = document.getElementById(ID)
    if (existing && existing.getAttribute('data-p2') === '1') return
    if (!document.body) return
    if (existing) existing.parentNode.removeChild(existing)
    var a = el('a', '我的Cordis'); a.id = ID; a.href = '#'; a.title = '我的Cordis：动态插件打包/安装/便携'
    a.setAttribute('data-p2', '1')
    a.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9998;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2,#555555);border-radius:18px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-specific-menu,rgba(255,255,255,.92));box-shadow:0 4px 16px rgba(15,20,30,.2);font-family:var(--dsw-font-family,sans-serif);font-size:13px;line-height:20px;cursor:pointer;text-decoration:none;white-space:nowrap;user-select:none;transition:transform .15s ease,box-shadow .15s ease'
    a.onmouseenter = function () { a.style.transform = 'translateY(-1px)'; a.style.boxShadow = '0 8px 22px rgba(15,20,30,.28)' }
    a.onmouseleave = function () { a.style.transform = 'none'; a.style.boxShadow = '0 4px 16px rgba(15,20,30,.2)' }
    a.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); toggle(a) }
    document.body.appendChild(a)
  }
  document.addEventListener('click', function (ev) { if (!panel) return; if (panel.contains(ev.target)) return; var b = document.getElementById(ID); if (b && b.contains(ev.target)) return; closePanel() })
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePanel() })
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setInterval(mount, 1000) }) } else { setInterval(mount, 1000) }
})()`
}
function injectButton(html) {
  if (typeof html !== 'string' || html.includes('dsh-plugin-builder2-entry')) return html
  return html.replace('</body>', '<script>' + buttonScript() + '</script>\n</body>')
}
