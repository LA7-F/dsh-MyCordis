// [base/security] 信任栅栏（loopback Host + 同源 Origin + 无 Origin 放行）与路径/文件名/错误净化
// ── 请求信任栅栏（v2 加固）：loopback Host + 同源 Origin（scheme://host:port 精确比对）+ Origin 缺失即放行 + socket 远端校验 ──
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
  const origin = h.origin
  // ── 无 Origin 即放行：对齐 dsh-client-connection 的 isTrustedApiRequest ──
  // 桌面版（Electron）用 dsh-app:// 协议代理转发页面请求，转发前会删掉 origin 与
  // sec-fetch-site。旧规则「没有 Origin 就拒绝写方法」因此让桌面版里每个 POST
  // （打包/安装/导入/收藏/去重/新建目录）恒 403，而浏览器直连同一份代码却正常。
  // 放行是安全的，理由与 DSH 自家注释一致：
  //   - 跨站浏览器写请求一定带 Origin（POST 必带），带 Origin 时仍走下面
  //     的同源精确比对，防护一条不减；
  //   - DNS rebinding 伪造不了 Host，上面「Host 必须是 loopback + 本服务端口」
  //     仍然拦得住（Host 是 rebinding 唯一伪造不了的头）；
  //   - 非浏览器客户端（curl / PowerShell / 本地工具）本就受信任；
  //   - 万一 dsh-app:// 的 Origin 漏到这一层，它也匹配不上 loopback Host，仍被拒。
  if (origin === undefined) return true
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
