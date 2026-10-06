// [ui/button] 页面右下角悬浮入口按钮与其 index 注入脚本
function buttonScript() {
  return `(function () {
  'use strict'
  var ID = 'dsh-plugin-builder2-entry'
  var PANEL_ID = 'dsh-plugin-builder2-panel'
  var panel = null
  function el(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e }
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
    if (existing && existing.getAttribute('data-p2') === '1') return
    if (!document.body) return
    if (existing) existing.parentNode.removeChild(existing)
    var a = el('a', '我的Cordis'); a.id = ID; a.href = '#'; a.title = '我的Cordis：动态插件打包/安装/便携'
    a.setAttribute('data-p2', '1')
    a.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9998;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2,#555555);border-radius:18px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-specific-menu,rgba(255,255,255,.92));box-shadow:0 4px 16px rgba(15,20,30,.2);font-family:var(--dsw-font-family,sans-serif);font-size:13px;line-height:20px;cursor:pointer;text-decoration:none;white-space:nowrap;user-select:none'
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
