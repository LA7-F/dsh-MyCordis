// ── 我的Cordis：会话级动态插件打包/安装/便携化（host 半区，零依赖沙箱能力） ──────────
// [base/text] 通用文本与标识工具：HTML 转义、跨平台 shell 引用、随机标识
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
// 宿主平台判定：DSH 桌面/Node 宿主一定给得出 process；拿不到时按 Windows 处理（保持旧行为）。
// 「便携包」以前写死了 pwsh 的 New-Item/Remove-Item/Get-FileHash，非 Windows 直接失败；
// 有了这个判据，打包相关命令可以按平台各写一份，才算通用。
function isWindowsHost() {
  const proc = typeof process === 'undefined' ? undefined : process
  if (proc === undefined || typeof proc.platform !== 'string') return true
  return proc.platform === 'win32'
}
// 跨平台单引号引用：pwsh 把内部的 ' 翻倍即可；POSIX sh 单引号内无法转义，需写成 '\'' 拼接。
function sq(p) {
  const s = String(p)
  if (isWindowsHost()) return "'" + s.replace(/'/g, "''") + "'"
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
function rand() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}
// 宿主进程标识：整个 host 半区只求值一次，所以同一进程内恒定、dsh 一重启就换一个。
// 面板拿它作废「上一次运行留下的输入缓存」（见 ui/page 的安装源），不需要任何服务端状态。
const HOST_BOOT_ID = rand()
// [base/http-io] HTTP 底层 I/O：回包助手、请求体读取与上限、URL 拆分
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
// 注意：README 里写的「10MB 请求体上限」与实际不符——此处以代码为准（80MB）。
// 它与页面 50MB 文件上限、uploadBundle 的 70MB base64 上限自洽：
// 50MB 原始数据 → base64≈66.7MB < 70MB < 80MB。
// 已决定不改这个常量；待同步的是 README 文案（不在本文件职责内）。
const MAX_BODY_BYTES = 80 * 1024 * 1024
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
function parsePath(reqUrl) {
  const raw = String(reqUrl || '/')
  const q = raw.indexOf('?')
  return { path: q === -1 ? raw : raw.slice(0, q), query: q === -1 ? '' : raw.slice(q + 1) }
}
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
// [base/source-spec] 安装源规格（与 DSH 无关）：npm 包名校验、git 地址归一、凭据打码、类型名
// 安装源可以是未压缩文件夹 / git 仓库 / .tgz 文件 / npm 包名。这里只做**与 DSH 无关**的文本归一，
// 「这个路径在磁盘上是什么」由 install/source 问文件系统。
// 合法 npm 包名：首字符不能是 . 或 _，只允许小写字母/数字与 - . _（与 npm 自己的校验一致）。
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const PACKAGE_NAME_MAX = 214
function validPackageName(name) {
  const s = String(name === undefined || name === null ? '' : name).trim()
  return s.length > 0 && s.length <= PACKAGE_NAME_MAX && PACKAGE_NAME_RE.test(s)
}
// 回显用：带账号密码的 git URL（https://user:token@host/repo）把凭据打码。
function redactUrl(url) {
  const s = String(url === undefined || url === null ? '' : url)
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i.exec(s)
  return m === null ? s : m[1] + '***@' + s.slice(m[0].length)
}
/**
 * 归一 npm 的 git 写法：git+ 只是协议前缀（保留以表明是 git 源），git: 后面可能只有 owner/repo。
 *   owner/repo           -> git+https://github.com/owner/repo
 *   https://github.com/x -> git+https://github.com/x
 *   git+https://…        -> git+https://…（原样）
 *   git@host:x/y.git     -> git+git@host:x/y.git
 */
function normalizeGitSpec(rest) {
  let body = String(rest === undefined || rest === null ? '' : rest).trim()
  if (body === '') throw new Error('git 安装源缺仓库地址（可写 owner/repo、https://github.com/owner/repo 或 git+https://…）')
  const plus = /^git\+/i.test(body)
  const colon = /^git:/i.test(body)
  if (plus || colon) body = body.replace(/^git[:+]+/i, '')
  if (body === '') throw new Error('无法识别 git 安装源（git+ 后面是空的）')
  if (plus) return 'git+' + body
  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(body)
  if (m !== null) return 'git+https://github.com/' + m[1] + '/' + m[2]
  if (/^git@/.test(body)) return 'git+' + body
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(body)) return 'git+' + body
  if (colon) throw new Error('无法识别 git 安装源：' + body + '（可写 owner/repo、https://github.com/owner/repo 或 git+https://…）')
  return body
}
// 只认「明确的 git 写法」与 owner/repo 简写。http(s) 地址由调用方归到 git（见 resolveInstallSource），
// 这里刻意不认，免得把 npm 的 tarball URL（https://…/x-1.0.0.tgz）也当成 git 源。
function isGitSource(s) {
  return /^git[+:]|^git@/i.test(s) || /^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(s)
}
// 安装源类型的中文名（面板回显用）。
function kindTextOf(kind) {
  if (kind === 'local-dir') return '未压缩文件夹'
  if (kind === 'git') return 'git 仓库'
  if (kind === 'npm') return 'npm 包'
  return '本地安装包'
}
// [runtime/workspace] 工作区与会话解析：当前会话 id、工作区根目录（B9 解析链）
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
// ── D2+：历史对话标题（sessionTitle 服务折叠 session/title 事件）────────────
// 面板「会话…」下拉要显示「历史对话标题 - 会话id」。标题就是 DSH 侧边栏会话列表
// 用的同一个投影（sessionTitle.get(session).title：LLM/兜底生成的 session/title）。
// sessionTitle 是可选服务（headless 组装里可能没有），取不到就返回空串，面板自动退回只显示 id。
function sessionTitleOf(ctx, agent) {
  try {
    const st = ctx.get('sessionTitle')
    if (st === undefined || typeof st.get !== 'function') return ''
    const session = agent ? agent.session : undefined
    if (!session) return ''
    const snapshot = st.get(session)
    const title = snapshot ? snapshot.title : ''
    return typeof title === 'string' ? title : ''
  } catch (e) { return '' }
}
// ── D2：存活会话清单（面板选「所属会话 id」用）──────────────────────────────
// HTTP 请求不在 initiator 边界内（currentInitiator() 为空），而「恰好 1 个 root」只是
// 单会话时的巧合；多会话并存时导入/运行会卡在「导入需要所属会话 id」。这里把官方
// agents 服务的 roots()/list() 摊平成面板可选项，由用户显式选一个，而不是靠猜。
// 只列 top-level（root）会话；一个 root 都没有（异常形态）才退回 list()。
function listSessions(ctx) {
  try {
    const agents = ctx.get('agents')
    if (agents === undefined) return { available: false, reason: 'agents 服务不可用', sessions: [] }
    let roots = []
    let all = []
    try { if (typeof agents.roots === 'function') roots = agents.roots() || [] } catch (e) { roots = [] }
    try { if (typeof agents.list === 'function') all = agents.list() || [] } catch (e) { all = [] }
    const source = roots.length > 0 ? roots : all
    const rootIds = {}
    for (let i = 0; i < roots.length; i += 1) { const r = roots[i]; if (r && r.id) rootIds[String(r.id)] = true }
    let currentId = ''
    try {
      if (typeof agents.currentInitiator === 'function') { const i = agents.currentInitiator(); if (i && i.id) currentId = String(i.id) }
    } catch (e) { /* 保持空 */ }
    const sessions = []
    const seen = {}
    for (let i = 0; i < source.length; i += 1) {
      const a = source[i]
      if (!a || !a.id) continue
      const id = String(a.id)
      if (seen[id] === true) continue
      seen[id] = true
      sessions.push({ id: id, cwd: sessionCwdOf(a), title: sessionTitleOf(ctx, a), root: rootIds[id] === true, current: id === currentId })
    }
    // 当前请求的会话最前，其次 root；同组保持注册顺序（sort 稳定）。
    const rank = function (s) { return s.current ? 0 : (s.root ? 1 : 2) }
    sessions.sort(function (x, y) { return rank(x) - rank(y) })
    return { available: true, current: currentId, sessions: sessions }
  } catch (e) {
    return { available: false, reason: safeErrorMsg(e), sessions: [] }
  }
}
// ── 写操作的沙箱策略：必须显式钉住本工作区 ─────────────────────────────────
// 全局 HTTP 路由下没有 session，ctx.sandboxPolicy.resolve() 给的是「部署兜底根」
// （桌面版 = 进程 cwd = profile 目录，见 install/profile 的 activeProfile 注释），
// **不是**这里算出的会话工作区。只传 undefined 时，两个沙箱各按兜底根判一遍：
//   · fs 沙箱（fs-sandbox.checkedTarget）按兜底根判越界
//     → cannot write "…": file access denied under workspace-write mode
//   · pwsh 沙箱按兜底根派生写 SID（workspaceWriteSid(兜底根)），工作区里新建目录被 ACL 拒
//     → New-Item : 对路径"…\.packer2"的访问拒绝
// 所以「目标在工作区内」一律显式 workspace-write + 本工作区根：ACL 与 fs 判据都按该根，
// 待遇跟会话自己在工作区里的写入完全一样（不是提权）；工作区外才显式 danger-full-access。
function workspaceWritePolicy(ws) {
  const root = String(ws || '').replace(/[\\/]+$/, '')
  if (root === '') return { mode: 'danger-full-access' }
  return { mode: 'workspace-write', workspaceRoot: root }
}
// ── B9：工作区根目录解析 ────────────────────────────────────────────────────
// 官方规范：会话工作区 = agent.session.header.cwd ?? sandboxPolicy.workspaceRoot
// （dsh-api-terminal-controller/lib/index.js:783；dsh-tool-fs 的 sessionCwd）。
// sandboxPolicy.workspaceRoot 只是「部署兜底」：桌面版进程 cwd = profile 目录，
// 直接采用它会把产物/收藏落到 <profile>/ 而不是会话工作区。
function sessionCwdOf(agent) {
  // 防御 agent / session / header / cwd 任一缺失。
  try {
    const session = agent ? agent.session : undefined
    const header = session ? session.header : undefined
    const cwd = header ? header.cwd : undefined
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch (e) { /* 视为无 cwd */ }
  return ''
}
async function workspaceRoot(ctx) {
  // 1. agents：优先当前发起者，其次「恰好一个 root 会话」（唯一会话可无歧义代表工作区）。
  try {
    const agents = ctx.get('agents')
    if (agents) {
      if (typeof agents.currentInitiator === 'function') {
        const cwd = sessionCwdOf(agents.currentInitiator())
        if (cwd !== '') return cwd
      }
      if (typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (Array.isArray(roots) && roots.length === 1) {
          const cwd = sessionCwdOf(roots[0])
          if (cwd !== '') return cwd
        }
      }
    }
  } catch (e) { /* 继续往下走：agents 不可用不代表工作区不可知 */ }
  // 2. sandboxPolicy：官方方法名是 resolve()（返回带 workspaceRoot 的策略快照）。
  try {
    const sp = ctx.get('sandboxPolicy')
    if (sp) {
      if (typeof sp.resolve === 'function') {
        try {
          const resolved = sp.resolve()
          if (resolved && typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot !== '') return resolved.workspaceRoot
        } catch (e) { /* 退回读属性 */ }
      }
      if (typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '') return sp.workspaceRoot
    }
  } catch (e) { /* 继续往下走 */ }
  // 3. fs 服务：进程默认目录。
  const fsSvc = ctx.get('fs')
  if (fsSvc) { try { const t = await fsSvc.resolve('.'); return fsSvc.processPath(t) } catch (e) { /* fallthrough */ } }
  // 4. 无法确定：调用方已有「无法确定工作区根目录」的报错，这里只返回空串。
  return ''
}
// [runtime/shell] shell 服务封装、跨平台目录助手与存在性探测
async function runShell(ctx, command, workdir, policy, timeoutMs) {
  const shell = ctx.get('shell')
  if (shell === undefined) throw new Error('shell 服务不可用')
  const spec = shell.resolve({ command, workdir, timeoutMs: timeoutMs || 120000, ...(policy === undefined ? {} : { sandboxPolicy: policy }) })
  const result = await (await shell.execute(spec)).result()
  if (result.exitCode !== 0) {
    const out = (result.stdout && result.stdout.text) || ''
    const errText = (result.stderr && result.stderr.text) || ''
    throw new Error('命令退出码 ' + result.exitCode + (errText ? '：' + errText.slice(0, 500) : '') + (out ? '\n' + out.slice(0, 500) : ''))
  }
  return result
}
// ── 跨平台目录助手 ──────────────────────────────────────────────────────────
// 「便携包」以前一律用 pwsh 的 New-Item/Remove-Item 建目录/清理，非 Windows 上直接失败。
// 这两个助手按宿主平台出命令，调用方只管给路径与策略。
async function ensureDir(ctx, dir, policy) {
  const fs = ctx.get('fs')
  if (fs !== undefined && typeof fs.stat === 'function' && typeof fs.resolve === 'function') {
    try {
      const info = await fs.stat(await fs.resolve(dir))
      if (info && info.type === 'directory') return
    } catch (e) { /* 不存在（或后端不支持 stat）：继续走 shell 创建 */ }
  }
  const cmd = isWindowsHost()
    ? 'New-Item -ItemType Directory -Force -Path ' + sq(dir)
    : 'mkdir -p ' + sq(dir)
  await runShell(ctx, cmd, undefined, policy)
}
async function removeTree(ctx, dir, policy) {
  // 仅用于清理自己刚建的暂存目录：幂等、尽力而为，调用方自行 catch。
  const cmd = isWindowsHost()
    ? 'Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ' + sq(dir)
    : 'rm -rf ' + sq(dir)
  await runShell(ctx, cmd, undefined, policy)
}
// ── B2/B3：dsh CLI 与 pnpm 定位 ────────────────────────────────────────────────
// 正式版桌面把 CLI/pnpm 放在 Electron 的 resources 下，工作区通常不是 DSH 源码仓库，
// 所以不再硬编码 <工作区>/apps/cli/lib/bin.js，改为按序探测并返回可拼进 shell 的命令前缀。
async function probePathExists(ctx, p) {
  // 两种形态都要能跑：shell 的存在性探测与 fs 服务都试，任一命中即视为存在。
  const sh = ctx.get('shell')
  if (sh !== undefined) {
    try {
      const cmd = isWindowsHost()
        ? 'if (Test-Path -LiteralPath ' + sq(p) + ') { Write-Output "EXISTS" }'
        : 'test -e ' + sq(p) + ' && printf EXISTS'
      const spec = sh.resolve({ command: cmd, timeoutMs: 30000 })
      const r = await (await sh.execute(spec)).result()
      const probeOut = String((r.stdout && r.stdout.text) || '')
      if (probeOut.indexOf('EXISTS') !== -1 || /(^|\W)True(\W|$)/.test(probeOut)) return true
    } catch (e) { /* 落回 fs 探测 */ }
  }
  const fsSvc = ctx.get('fs')
  if (fsSvc !== undefined && typeof fsSvc.resolve === 'function' && typeof fsSvc.readText === 'function') {
    try { await fsSvc.readText(await fsSvc.resolve(p)); return true } catch (e) { return false }
  }
  return false
}
async function probeAsarExists(ctx, asarPath) {
  // 实测：PowerShell 的 Test-Path 看不见 asar 内部（对 asar 里的 cli.js 恒为 False，文件其实存在），
  // 所以只对 app.asar 文件本身做存在性探测，命中后无条件拼出内部路径。
  const sh = ctx.get('shell')
  if (sh !== undefined) {
    try {
      const cmd = isWindowsHost()
        ? 'if (Test-Path -LiteralPath ' + sq(asarPath) + ') { Write-Output "EXISTS" }'
        : 'test -e ' + sq(asarPath) + ' && printf EXISTS'
      const spec = sh.resolve({ command: cmd, timeoutMs: 30000 })
      const r = await (await sh.execute(spec)).result()
      const probeOut = String((r.stdout && r.stdout.text) || '')
      return probeOut.indexOf('EXISTS') !== -1 || /(^|\W)True(\W|$)/.test(probeOut)
    } catch (e) { return true /* 探测失败不阻塞：resourcesPath 来自运行中的 Electron */ }
  }
  return true /* 无 shell 可探测：resourcesPath 来自运行中的 Electron，按存在处理 */
}
async function probeOnPath(ctx, name) {
  const sh = ctx.get('shell')
  if (sh === undefined) return ''
  try {
    const cmd = isWindowsHost()
      ? '$c = Get-Command ' + name + ' -ErrorAction SilentlyContinue; if ($c) { Write-Output $c.Source }'
      : 'command -v ' + name + ' 2>/dev/null'
    const spec = sh.resolve({ command: cmd, timeoutMs: 30000 })
    const r = await (await sh.execute(spec)).result()
    const out = String((r.stdout && r.stdout.text) || '').trim()
    return out === '' ? '' : out.split(/\r?\n/)[0].trim()
  } catch (e) { return '' }
}
// [runtime/cli] dsh CLI 与 pnpm 的可执行入口定位（桌面版 resources / 工作区 / PATH，跨平台）
function desktopQuitHint(profile) {
  // 官方 requireDesktopProfile：运行 dsh plugin --profile desktop 前必须先完全退出桌面版。
  // 实测桌面版运行期间会报 EPERM: operation not permitted, open '…\profiles\desktop\package.json.lock'。
  return profile === 'desktop' ? "（注意：profile=desktop 必须先完全退出 DeepSeek Harness 桌面版再执行；桌面版运行期间会报 EPERM: operation not permitted, open '…\\profiles\\desktop\\package.json.lock'，完全退出后重试即可）" : ''
}
// 把「一个路径当命令跑」写成平台正确的形状：pwsh 需要调用运算符 &，POSIX 直接给路径。
function shellCallPrefix(p) {
  return isWindowsHost() ? '& ' + sq(p) : sq(p)
}
// 用 Electron 可执行文件跑一个 .mjs 脚本（内置 pnpm / 桌面版 CLI）：ELECTRON_RUN_AS_NODE 的环境变量
// 写法在 pwsh 与 sh 下不同，这里收口成一处。
function electronRunAsNodePrefix(runnerToken, script) {
  const tail = runnerToken + ' --expose-internals ' + sq(script)
  return isWindowsHost() ? "$env:ELECTRON_RUN_AS_NODE='1'; & " + tail : 'ELECTRON_RUN_AS_NODE=1 ' + tail
}
async function resolveDshCli(ctx) {
  // 候选列表一律用「路径形状」占位符：handleRequest 返回前会过 safeErrorMsg，
  // 绝对路径会被脱敏成 <路径>，只有形状能存活下来告诉用户该去哪里找 CLI。
  const tried = []
  const ws = (await workspaceRoot(ctx)) || ''
  if (ws !== '') {
    const srcCli = ws.replace(/[\\/]+$/, '') + '/apps/cli/lib/bin.js'
    tried.push('<工作区>/apps/cli/lib/bin.js')
    if (await probePathExists(ctx, srcCli)) return 'node ' + sq(srcCli)
  } else {
    tried.push('<工作区>/apps/cli/lib/bin.js（工作区根目录未知，未探测）')
  }
  const proc = typeof process === 'undefined' ? undefined : process
  const resourcesPath = (proc && typeof proc.resourcesPath === 'string' && proc.resourcesPath !== '') ? proc.resourcesPath.replace(/[\\/]+$/, '') : ''
  if (resourcesPath !== '') {
    // Windows 桌面版给的是 dsh.cmd；POSIX 安装给的是无扩展名的 dsh 垫片。
    const cliName = isWindowsHost() ? 'dsh.cmd' : 'dsh'
    const shim = resourcesPath + '/runtime/cli/bin/' + cliName
    tried.push('<resourcesPath>/runtime/cli/bin/' + cliName)
    if (await probePathExists(ctx, shim)) return shellCallPrefix(shim)
    const asarPath = resourcesPath + '/app.asar'
    const desktopCli = asarPath + '/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
    tried.push('<resourcesPath>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
    if (await probeAsarExists(ctx, asarPath)) {
      const execPath = (proc && typeof proc.execPath === 'string' && proc.execPath !== '') ? proc.execPath : ''
      if (execPath !== '') return electronRunAsNodePrefix(sq(execPath), desktopCli)
      tried.push('process.execPath（不可用，未能构造桌面 CLI 命令）')
    }
  } else {
    tried.push('<resourcesPath>/runtime/cli/bin/dsh.cmd（process/resourcesPath 不可用，未探测）')
    tried.push('<resourcesPath>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js（同上，未探测）')
  }
  const onPath = await probeOnPath(ctx, 'dsh')
  if (onPath !== '') return shellCallPrefix(onPath)
  tried.push('PATH 上的 dsh（Get-Command/command -v 无结果）')
  throw new Error('未找到可用的 dsh CLI（安装/卸载需要它）。已探测候选：' + tried.join('；') + '。可改用桌面版安装目录 resources/runtime/cli/bin 下的 dsh 垫片，或让 DSH 源码仓库工作区提供 apps/cli/lib/bin.js。')
}
async function resolvePnpm(ctx, wsHint) {
  const tried = []
  const proc = typeof process === 'undefined' ? undefined : process
  const resourcesPath = (proc && typeof proc.resourcesPath === 'string' && proc.resourcesPath !== '') ? proc.resourcesPath.replace(/[\\/]+$/, '') : ''
  if (resourcesPath !== '') {
    const pnpmMjs = resourcesPath + '/runtime/pnpm/bin/pnpm.mjs'
    tried.push('<resourcesPath>/runtime/pnpm/bin/pnpm.mjs')
    if (await probePathExists(ctx, pnpmMjs)) {
      const execPath = (proc && typeof proc.execPath === 'string' && proc.execPath !== '') ? proc.execPath : ''
      const runner = execPath !== ''
        ? sq(execPath)
        : (isWindowsHost() ? '"$env:DSH_DESKTOP_NODE_EXECUTABLE"' : '"$DSH_DESKTOP_NODE_EXECUTABLE"')
      return electronRunAsNodePrefix(runner, pnpmMjs)
    }
  } else {
    tried.push('<resourcesPath>/runtime/pnpm/bin/pnpm.mjs（process/resourcesPath 不可用，未探测）')
  }
  const ws = (wsHint !== undefined && wsHint !== '') ? String(wsHint) : ((await workspaceRoot(ctx)) || '')
  if (ws !== '') {
    const wsBase = ws.replace(/[\\/]+$/, '')
    const binShim = wsBase + '/node_modules/.bin/pnpm'
    const binCjs = wsBase + '/node_modules/pnpm/bin/pnpm.cjs'
    tried.push('<工作区>/node_modules/.bin/pnpm', '<工作区>/node_modules/pnpm/bin/pnpm.cjs')
    if (await probePathExists(ctx, binShim)) return shellCallPrefix(binShim)
    if (await probePathExists(ctx, binCjs)) return shellCallPrefix(binCjs)
  } else {
    tried.push('<工作区>/node_modules/.bin/pnpm、<工作区>/node_modules/pnpm/bin/pnpm.cjs（工作区根目录未知，未探测）')
  }
  const onPath = await probeOnPath(ctx, 'pnpm')
  if (onPath !== '') return shellCallPrefix(onPath)
  tried.push('PATH 上的 pnpm（Get-Command/command -v 无结果）')
  throw new Error('未找到可用的 pnpm（打包需要它）。已探测候选：' + tried.join('；') + '。桌面版自带 <resourcesPath>/runtime/pnpm/bin/pnpm.mjs，请确认安装完整。')
}
// [runtime/picker] 原生目录选择器：直接调用 DSH 自己的 directoryPicker（native 能力）
// 旧版自跑的 powershell + WinForms FolderBrowserDialog 已删除 —— 那是 DSH 之外的第二套壳弹窗；
// 现在让 DSH 在宿主屏幕上打开它自己的现代 OS 选择器。调用形状对齐官方 apiproxy：
// capability().kind === 'native' → capability().pick(signal)（Windows 上是 IFileOpenDialog）。
async function pickDirNative(cap) {
  if (cap === undefined || cap.kind !== 'native' || typeof cap.pick !== 'function') {
    throw new Error('原生目录选择不可用（当前 directoryPicker 后端: ' + String(cap && cap.kind) + '）')
  }
  try {
    // DSH 的 pick(signal) 不接受起始目录（由 OS 按上次位置打开）；用户取消时返回 null。
    return await cap.pick(new AbortController().signal)
  } catch (error) {
    throw new Error('原生目录选择失败: ' + safeErrorMsg(error))
  }
}
// [cordis/inventory] 会话级动态插件清单：当前包名、runner.inventory 归一化
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
// [cordis/portable] 便携包定义与导出：脱敏标识、单/批量导出、快照导出
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
/**
 * 把会话级动态插件的某个包摊平成便携定义。
 * pureHost=true 只带 host 半区（旧「纯 host」语义）；默认把 client 半区一并带上——
 * 便携包是持久的完整产物，丢掉 client 等于丢掉插件 UI，换成别的会话/机器就复现不出来。
 */
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
/**
 * 批量导出便携包。
 * 跨平台：目录由 fs.writeText 递归创建（官方 fs-local 的 writeFileAtomic 自带 mkdir），
 * 所以这里**不再**调用 shell —— 旧实现用 pwsh 的 New-Item 建目录，非 Windows 直接失败。
 * 默认导出完整定义（host + client）；显式传 pureHost:true 才退回只导 host 半区。
 */
async function exportBatch(ctx, payload) {
  const plugins = (payload && payload.plugins) || []
  const outDirRaw = String((payload && payload.outDir) || '')
  const pureHost = (payload && payload.pureHost) === true
  if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('未勾选任何插件')
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const outDir = outDirRaw === '' ? ws.replace(/[\\/]+$/, '') + '/packer2-out' : outDirRaw
  const wsNorm = normPath(ws).toLowerCase()
  const outNorm = normPath(outDir).toLowerCase()
  const outside = outNorm !== wsNorm && !outNorm.startsWith(wsNorm + '/')
  // 工作区内一律显式钉住本工作区（见 runtime/workspace 的 workspaceWritePolicy）：
  // 只传 undefined 会被 fs/pwsh 沙箱按「部署兜底根」判成越界，产物根本写不出来。
  const policy = outside ? { mode: 'danger-full-access' } : workspaceWritePolicy(ws)
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  const results = []
  for (const p of plugins) {
    try {
      const data = sanitizePortable(exportDynamicPlugin(ctx, p.pluginId, p.packageId, pureHost))
      const artifact = outDir.replace(/[\\/]+$/, '') + '/' + data.pluginId + '-' + data.packageId + '.dshplugin.json'
      const target = await fs.resolve(artifact)
      await fs.writeText(target, JSON.stringify(data, null, 2), undefined, undefined, policy)
      results.push({
        pluginId: data.pluginId,
        packageId: data.packageId,
        name: data.name,
        hasClientHalf: data.code.client !== undefined,
        ok: true,
        path: artifact,
      })
    } catch (e) {
      results.push({ pluginId: p.pluginId, packageId: p.packageId, ok: false, message: safeErrorMsg(e) })
    }
  }
  return { ok: true, outDir, pureHost, results }
}
/**
 * 导出某个插件的快照到工作区 packer2-snapshot/（「复制信息」用）。
 * 同样不依赖 shell：目录交给 fs.writeText 递归创建。
 */
async function snapshotPlugin(ctx, pluginId) {
  const data = sanitizePortable(exportDynamicPlugin(ctx, pluginId, ''))
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const dir = ws.replace(/[\\/]+$/, '') + '/packer2-snapshot'
  const artifact = dir + '/' + data.pluginId + '-' + data.packageId + '.dshplugin.json'
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  const target = await fs.resolve(artifact)
  await fs.writeText(target, JSON.stringify(data, null, 2), undefined, undefined, await writePolicyFor(ctx, artifact))
  return { ok: true, path: artifact, pluginId: data.pluginId, packageId: data.packageId, name: data.name, hasClientHalf: data.code.client !== undefined }
}
/**
 * 从 .tgz（dsh 包）读出便携定义 —— **只解包，不安装**。
 *
 * 便携包存在的意义就是「不落 profile」：所以便携源格式不必是专用 JSON，dsh 包本身就是它的超集
 * （package/host.js + package/client.js + package.json）。这里用系统自带的 tar 解到工作区临时目录，
 * 摊成与 exportDynamicPlugin 同形的定义，交给同一个 runner.define 通道；
 * 全程不碰 dsh plugin add、不写 $DSH_HOME，所以不需要 profile 选择、不需要重启 dsh。
 *
 * 与导出侧的对应关系（老 tgz 没有 packer2 元数据时退回 npm 的 name/description）：
 *   packer2.name    → name（人类可读名；缺省退回 package.json.name，也就是插件 id）
 *   packer2.purpose → purpose（缺省退回 description）
 * 空的 client.js 视为「没有 client 半区」——否则会被误判成 awaiting-approval 的 client-pending。
 */
async function readPluginFromTgz(ctx, tgzPath) {
  const raw = String(tgzPath || '').trim()
  if (raw === '') throw new Error('缺 .tgz 路径')
  const fsSvc = ctx.get('fs')
  if (fsSvc === undefined || typeof fsSvc.readText !== 'function') throw new Error('fs 服务不可用')
  if (ctx.get('shell') === undefined) throw new Error('shell 服务不可用（解包 .tgz 需要系统 tar）')
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  // 临时目录固定在工作区内；工作区外的文件（例如桌面）读它需要提权，判据与 pack.js 的输出目录一致。
  const wsNorm = normPath(ws).toLowerCase()
  const tgzNorm = normPath(raw).toLowerCase()
  const outside = tgzNorm !== wsNorm && !tgzNorm.startsWith(wsNorm + '/')
  // 建临时目录 / tar 解包 / 清理都在工作区内：必须显式 workspace-write + 本工作区根，
  // 否则 pwsh 沙箱按部署兜底根派生写 SID，New-Item 会直接「访问被拒绝」。
  const policy = outside ? { mode: 'danger-full-access' } : workspaceWritePolicy(ws)
  const tmp = ws.replace(/[\/]+$/, '') + '/.packer2/tgz-' + rand()
  const readIfAny = async (p) => {
    try { return String(await fsSvc.readText(await fsSvc.resolve(p))) } catch (e) { return '' }
  }
  try {
    await ensureDir(ctx, tmp, policy)
    try {
      // Windows 10 1803+ / macOS / Linux 都自带 tar（Windows 上是 bsdtar），无需额外依赖。
      await runShell(ctx, 'tar -xzf ' + sq(raw) + ' -C ' + sq(tmp), undefined, policy)
    } catch (error) {
      throw new Error('解包 .tgz 失败：' + safeErrorMsg(error) + '（需要系统 tar；若文件不是合法 .tgz 或不在沙箱允许范围内，请把它放进工作区后重试）')
    }
    const manifestText = await readIfAny(tmp + '/package/package.json')
    if (manifestText.trim() === '') throw new Error('不是 dsh 包：.tgz 里没有 package/package.json')
    let manifest
    try { manifest = JSON.parse(manifestText) } catch (e) { throw new Error('包内 package.json 不是合法 JSON：' + safeErrorMsg(e)) }
    if (manifest === null || typeof manifest !== 'object') throw new Error('包内 package.json 不是对象')
    const host = await readIfAny(tmp + '/package/host.js')
    const client = await readIfAny(tmp + '/package/client.js')
    const code = {}
    if (host.trim() !== '') code.host = host
    if (client.trim() !== '') code.client = client
    if (code.host === undefined && code.client === undefined) throw new Error('包内 host.js / client.js 都是空的：没有可导入的半区')
    const meta = (typeof manifest.packer2 === 'object' && manifest.packer2 !== null) ? manifest.packer2 : {}
    const pkgName = String(manifest.name || '').trim()
    const name = String(meta.name || pkgName).trim() || 'imported-dynamic-plugin'
    const purpose = meta.purpose !== undefined ? String(meta.purpose) : String(manifest.description || '')
    return {
      __dshDynamicPlugin: true,
      format: Number(meta.format) || 1,
      pluginId: String(meta.pluginId || pkgName || name),
      packageId: String(meta.packageId || ''),
      ownerSessionId: FAKE_SESSION_ID,
      name,
      purpose,
      code,
    }
  } finally {
    try { await removeTree(ctx, tmp, policy) } catch (e) { /* 尽力清理 */ }
  }
}
// [cordis/pack] 打包：包入口源码生成、上传解包、单插件/批量/整包（dsh + 便携）
function entrySource(pkgName) {
  return [
    '/**',
    ' * ' + pkgName + ' — 由 我的Cordis 从会话级动态插件合成。',
    ' * host 半区以 async 函数体求值；client 半区（浏览器沙箱代码）仅存档不运行。',
    ' */',
    "import { readFileSync } from 'node:fs'",
    '',
    "const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))",
    "const HOST_CODE = readFileSync(new URL('./host.js', import.meta.url), 'utf8')",
    '',
    'export const name = manifest.name',
    '',
    'export async function apply(ctx, config) {',
    "  if (HOST_CODE.trim() === '') {",
    "    console.warn('[' + manifest.name + '] 此包无 host 半区（client-only），在 Node 组合中无可执行逻辑')",
    '    return',
    '  }',
    "  const factory = new Function('return (async () => {\\n' + HOST_CODE + '\\n})()')",
    '  const plugin = await factory()',
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
  // 落 base64、解码、清理全在工作区内：显式钉住本工作区为 workspace-write 边界，
  // 否则会被按「部署兜底根」（桌面版 = profile 目录）判成越界（fs 报 FS_SANDBOX_DENIED，
  // pwsh 侧则是 New-Item 访问被拒绝）。
  const policy = workspaceWritePolicy(ws)
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  await ensureDir(ctx, dir, policy)
  const target = await fs.resolve(b64Path)
  await fs.writeText(target, b64, undefined, undefined, policy)
  try {
    // 跨平台 base64 解码：pwsh 用 .NET，POSIX 用 base64（-d 为 GNU、-D 为 BSD/macOS，二者择一）。
    const cmd = isWindowsHost()
      ? '$b = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath ' + sq(b64Path) + ').Trim()); [System.IO.File]::WriteAllBytes(' + sq(outPath) + ', $b); Remove-Item -Force ' + sq(b64Path)
      : '(base64 -d ' + sq(b64Path) + ' > ' + sq(outPath) + ' 2>/dev/null || base64 -D ' + sq(b64Path) + ' > ' + sq(outPath) + '); rm -f ' + sq(b64Path)
    await runShell(ctx, cmd, undefined, policy)
    return { ok: true, path: outPath, name: safeName, sizeBytes: Number(payload && payload.size) || 0 }
  } catch (error) {
    try { await removeTree(ctx, b64Path, policy) } catch (e) { /* best effort */ }
    throw error
  }
}
/**
 * 计算产物的 SHA-256 与字节数。优先走 fs.readBytes + WebCrypto（进程内、零命令、跨平台），
 * 后端没有 readBytes 时退回平台感知的 shell 摘要（pwsh 的 Get-FileHash / POSIX 的 shasum）。
 */
async function fileSha256AndSize(ctx, path, policy) {
  const fs = ctx.get('fs')
  const proc = typeof process === 'undefined' ? undefined : process
  const subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle)
    ? crypto.subtle
    : ((proc && proc.webcrypto && proc.webcrypto.subtle) ? proc.webcrypto.subtle : undefined)
  let inProcError = ''
  if (fs !== undefined && typeof fs.readBytes === 'function' && subtle !== undefined) {
    try {
      const target = await fs.resolve(path)
      let size = 0
      if (typeof fs.stat === 'function') {
        try { const info = await fs.stat(target); if (info && typeof info.size === 'number') size = info.size } catch (e) { /* 大小未知 */ }
      }
      const bytes = await fs.readBytes(target, undefined, size > 0 ? size : 512 * 1024 * 1024)
      const digest = await subtle.digest('SHA-256', bytes)
      const view = new Uint8Array(digest)
      let hex = ''
      for (let i = 0; i < view.length; i += 1) hex += view[i].toString(16).padStart(2, '0')
      return { sha256: hex, sizeBytes: bytes.length }
    } catch (e) { inProcError = String(e && e.message ? e.message : e) /* 落到 shell 摘要 */ }
  }
  const cmd = isWindowsHost()
    ? '$h = (Get-FileHash -Algorithm SHA256 -Path ' + sq(path) + ').Hash.ToLower()'
      + '; $s = (Get-Item ' + sq(path) + ').Length'
      + '; Write-Output ("SHA256=" + $h)'
      + '; Write-Output ("SIZE=" + $s)'
    : 'h=$(shasum -a 256 ' + sq(path) + ' | cut -d" " -f1); s=$(wc -c < ' + sq(path) + '); printf "SHA256=%s\\nSIZE=%s\\n" "$h" "$s"'
  const res = await runShell(ctx, cmd, undefined, policy)
  const out = (res.stdout && res.stdout.text) || ''
  let sha256 = ''
  let sizeBytes = 0
  for (const line of out.split(/\r?\n/)) {
    if (line.indexOf('SHA256=') === 0) sha256 = line.slice(7).trim()
    if (line.indexOf('SIZE=') === 0) sizeBytes = parseInt(line.slice(5), 10) || 0
  }
  if (!sha256) throw new Error('未能计算产物的 SHA-256：' + (inProcError !== '' ? '进程内摘要失败（' + inProcError + '）；' : '') + out.slice(0, 300))
  return { sha256, sizeBytes }
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
  if (clientCode.trim() !== '') notes.push('client 半区为浏览器沙箱代码，不进入 Node bundle（已存档 client.js）')
  if (/(^|[^\w$.])harness\s*[.([]/.test(hostCode)) notes.push('host 半区引用沙箱全局 harness：安装为普通组合插件后运行时可能未定义')
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const staging = ws.replace(/[\\/]+$/, '') + '/.packer2/staging-' + rand()
  const outDir = outDirRaw === '' ? ws.replace(/[\\/]+$/, '') + '/packer2-out' : outDirRaw
  const wsNorm = normPath(ws).toLowerCase()
  const outNorm = normPath(outDir).toLowerCase()
  const outside = outNorm !== wsNorm && !outNorm.startsWith(wsNorm + '/')
  // 暂存/产物目录在工作区内：显式钉住本工作区为 workspace-write 边界（见 workspaceWritePolicy）。
  const policy = outside ? { mode: 'danger-full-access' } : workspaceWritePolicy(ws)
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  if (ctx.get('shell') === undefined) throw new Error('shell 服务不可用')
  const pnpmPrefix = await resolvePnpm(ctx, ws)
  try {
    // 目录一律走跨平台助手（pwsh 的 New-Item / POSIX 的 mkdir -p），不再写死 Windows 命令。
    await ensureDir(ctx, staging, policy)
    await ensureDir(ctx, outDir, policy)
    // 便携往返用元数据：.tgz 也能当便携包之后，人类可读的插件名/用途只能从这里取
    // （package.json.name 必须是 npm 包名 = 插件 id）。放**顶层自定义键**：npm/pnpm 忽略未知顶层键，
    // 不塞进 dsh.* 以免参与官方安装器的清单校验。
    const purpose = String((inspected && inspected.purpose) || '')
    const manifest = {
      name: pkgName, version, description: purpose, type: 'module', main: 'index.js',
      files: ['index.js', 'host.js', 'client.js', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      packer2: { format: 1, name: String((inspected && inspected.name) || pkgName), purpose, pluginId: pkgName, packageId: String(want) },
    }
    const files = {
      'package.json': JSON.stringify(manifest, null, 2),
      'host.js': hostCode,
      'client.js': clientCode,
      'index.js': entrySource(pkgName),
      'cordis.patch.yml': '# synthesized by packer2\n- insert:\n    - id: ' + pkgName + '\n      name: ' + pkgName + '\n',
    }
    for (const rel of Object.keys(files)) {
      const target = await fs.resolve(staging + '/' + rel)
      // 暂存目录在工作区内：同样显式钉住本工作区，否则暂存文件一个也写不出来。
      await fs.writeText(target, files[rel], undefined, undefined, policy)
    }
    await runShell(ctx, pnpmPrefix + ' pack --reporter append-only --pack-destination ' + sq(outDir), staging, policy)
    const artifact = outDir.replace(/[\\/]+$/, '') + '/' + pkgName + '-' + version + '.tgz'
    const meta = await fileSha256AndSize(ctx, artifact, policy)
    try { await removeTree(ctx, staging, policy) } catch (e) { /* best effort */ }
    return { ok: true, artifactPath: artifact, artifactName: pkgName + '-' + version + '.tgz', sha256: meta.sha256, sizeBytes: meta.sizeBytes, packageName: pkgName, version, packageId: want, notes }
  } catch (error) {
    try { await removeTree(ctx, staging, policy) } catch (e) { /* best effort */ }
    const msg = String(error && error.message ? error.message : error)
    if (outside && /EPERM|denied|permission|沙箱/i.test(msg)) {
      throw new Error('输出目录 ' + outDir + ' 在沙箱允许范围外（当前工作区：' + ws + '）。请把放置目录改到工作区内（例如 ' + ws.replace(/[\\/]+$/, '') + '\\/packer2-out），或调整沙箱策略后重试。')
    }
    throw error
  }
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
// 便携包默认连同 client 半区一起导出，跟 .tgz 里的 client.js 保持一致；pureHost:true 可退回只导 host。
async function packWhole(ctx, payload) {
  const plugins = (payload && payload.plugins) || []
  const outDirRaw = String((payload && payload.outDir) || '')
  const pureHost = (payload && payload.pureHost) === true
  if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('未勾选任何插件')
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const outDir = outDirRaw === '' ? ws.replace(/[\\/]+$/, '') + '/packer2-out' : outDirRaw
  const wsNorm = normPath(ws).toLowerCase()
  const outNorm = normPath(outDir).toLowerCase()
  const outside = outNorm !== wsNorm && !outNorm.startsWith(wsNorm + '/')
  // 暂存/产物目录在工作区内：显式钉住本工作区为 workspace-write 边界（见 workspaceWritePolicy）。
  const policy = outside ? { mode: 'danger-full-access' } : workspaceWritePolicy(ws)
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  await ensureDir(ctx, outDir, policy)
  const results = []
  for (const p of plugins) {
    try {
      const pluginId = String(p.pluginId || '')
      const packageId = String(p.packageId || '')
      if (!pluginId) throw new Error('缺 pluginId')
      const subDir = outDir.replace(/[\\/]+$/, '') + '/' + pluginId + (packageId === '' ? '' : '-' + packageId)
      await ensureDir(ctx, subDir, policy)
      const tgz = await packSessionPlugin(ctx, { pluginId: pluginId, packageId: packageId, outDir: subDir })
      const data = sanitizePortable(exportDynamicPlugin(ctx, pluginId, packageId, pureHost))
      const portableName = data.pluginId + '-' + data.packageId + '.dshplugin.json'
      const artifact = subDir.replace(/[\\/]+$/, '') + '/' + portableName
      const target = await fs.resolve(artifact)
      await fs.writeText(target, JSON.stringify(data, null, 2), undefined, undefined, policy)
      results.push({
        pluginId: pluginId,
        packageId: data.packageId,
        ok: true,
        dir: subDir,
        tgzPath: tgz.artifactPath,
        tgzName: tgz.artifactName,
        sha256: tgz.sha256,
        sizeBytes: tgz.sizeBytes,
        portablePath: artifact,
        portableName: portableName,
        hasClientHalf: data.code.client !== undefined,
        notes: tgz.notes,
      })
    } catch (e) {
      results.push({ pluginId: String(p.pluginId || ''), packageId: String(p.packageId || ''), ok: false, message: safeErrorMsg(e) })
    }
  }
  return { ok: true, outDir, pureHost, results }
}
// [cordis/import] 导入定义（define/run）、手动运行与同名去重
/**
 * 运行一个包，并归一化结果。两条通道的区别就是「会不会唤醒会话」——
 * 判据是官方 runner 用哪个结算动词收尾（DSH 语义：**steer 唤醒、inject 不唤醒**）：
 *
 *  - 零唤醒通道（本插件默认）：官方 runner 的「面板手势」入口
 *      runHostHalf(agent, pluginId, packageId, mode, requestId = null, approveFutureVersions = false)
 *    requestId=null 表示「这是一次页面/面板手势」而不是模型请求：runner 不挂起 run 请求，因此永远
 *    不会走到 resolveRequestRun → steerRunOutcome → agent.steer（那一下就是"唤醒一轮"）。
 *    host 半在 vm 里静默求值；带 client 半区的包停在 status='client-pending'（等待页面装入），
 *    之后由某个页面 getClientCode + settleUserRun 装入，那条结算走 injectUserRunOutcome →
 *    agent.inject（**只注入一条上下文，不唤醒**）。纯 host 包到 host 半就结束，真正 0 上下文。
 *
 *  - 唤醒通道（仅在 allowWake=true，或旧运行时没有 runHostHalf 时兜底）：runner.run(...)
 *    对带 client 半区的包 emit cordis/request-run，等页面作答后 resolveRequestRun →
 *    agent.steer，**唤醒一整个会话轮次**（token 敏感时不要走）。
 *
 * runner.run / runHostHalf 对逻辑拒绝都是「返回 {ok:false}」而不是抛错，旧实现吞掉了返回值 ——
 * 这里统一收成 { ran, runStatus | runError }，并带上 silent / awaitingPage 两个事实。
 */
async function tryRun(ctx, runner, sessionId, pluginId, packageId, mode, hasClientHalf, allowWake) {
  const agentRef = { id: sessionId }
  const zeroWake = allowWake !== true && typeof runner.runHostHalf === 'function'
  try {
    if (zeroWake) {
      const started = await runner.runHostHalf(agentRef, pluginId, packageId, mode, null, false)
      if (started && started.ok === false) return { ran: false, runError: String(started.message || started.reason || '运行被拒绝') }
      // 带 client 半区的包：host 半已起来，client 半等页面装入（官方面板的「运行」会做这一步）。
      return { ran: true, runStatus: hasClientHalf === true ? 'client-pending' : 'running', silent: true, awaitingPage: hasClientHalf === true }
    }
    const res = await runner.run(agentRef, pluginId, packageId, mode, undefined)
    if (res && res.ok === false) return { ran: false, runError: (res.reason ? String(res.reason) + '：' : '') + String(res.message || '运行被拒绝') }
    return { ran: true, runStatus: String((res && res.status) || 'started'), silent: false, awaitingPage: false }
  } catch (e) {
    return { ran: false, runError: safeErrorMsg(e) }
  }
}
async function importDynamicPlugin(ctx, payload, runIt) {
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined || typeof runner.define !== 'function') throw new Error('dynamicCordisRunner 不可用')
  // 两种来源，同一个 define 通道：
  //   ① payload.data —— 便携定义 JSON（.dshplugin.json，或页面直接 POST 的对象）
  //   ② payload.tgzPath（别名 payload.path）—— dsh 包 .tgz：只解包、不安装，摊成同样的定义
  // 两者都给时以显式 data 为准（tgzPath 只当兜底）。
  let data = payload && payload.data
  const tgzPath = String((payload && (payload.tgzPath || payload.path)) || '').trim()
  if (tgzPath !== '' && (data === undefined || data === null)) data = await readPluginFromTgz(ctx, tgzPath)
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
    let targetHasClient = false
    try {
      const rows = runner.inventory() || []
      for (const r of rows) {
        if (pluginCurrentName(r) === name) {
          targetPluginId = String(r.pluginId)
          targetSessionId = String(r.agentId || '')
          targetCurrentId = r.currentPackageId !== undefined ? String(r.currentPackageId) : ''
          const cur = (r.packages || []).find(function (p) { return String(p.packageId) === targetCurrentId })
          targetHasClient = !!(cur && cur.hasClientHalf === true)
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
            const outcome = runIt === false ? {} : await tryRun(ctx, runner, useSessionId, targetPluginId, targetCurrentId, 'run', targetHasClient, payload && payload.allowWake === true)
            results.push({ pluginId: targetPluginId, packageId: targetCurrentId, name, ...outcome })
            continue
          }
        } catch (e) { /* 比较失败，走追加新版本 */ }
      }
      receipt = runner.define({ sessionId: useSessionId, plugin: { kind: 'existing', pluginId: targetPluginId }, name, purpose, code })
      const outcome = runIt === false ? {} : await tryRun(ctx, runner, useSessionId, receipt.pluginId, receipt.packageId, targetCurrentId !== '' ? 'update' : 'run', code.client !== undefined, payload && payload.allowWake === true)
      results.push({ pluginId: String(receipt.pluginId), packageId: String(receipt.packageId), name, ...outcome })
    } else {
      receipt = runner.define({ sessionId: useSessionId, plugin: { kind: 'new', idPrefix: prefix }, name, purpose, code })
      const outcome = runIt === false ? {} : await tryRun(ctx, runner, useSessionId, receipt.pluginId, receipt.packageId, 'run', code.client !== undefined, payload && payload.allowWake === true)
      results.push({ pluginId: String(receipt.pluginId), packageId: String(receipt.packageId), name, ...outcome })
    }
  }
  return { ok: true, results }
}
/**
 * 「运行」按钮：启动/重启某个已定义插件的指定包（缺 packageId 时用当前包）。
 * mode 由服务器判定：目标包 != currentPackageId 且已有 currentPackageId → 'update'，否则 'run'。
 * （resolvePlan 明确拒绝「run 一个与 current 不同的包」和「update 到 current 同一个包」。）
 * **默认零唤醒**：两条通道现在都走 runHostHalf(requestId=null)（面板手势），只有 payload.wake=true
 * 才退回会 agent.steer 的 run() 请求通道（见 tryRun 注释）。带 client 半区的包返回
 * status='client-pending' + awaitingPage=true，等 DSH 侧边栏 Cordis 面板把 client 半装入当前页。
 */
async function runDynamicPlugin(ctx, payload) {
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined || typeof runner.run !== 'function') throw new Error('dynamicCordisRunner 不可用（缺 run）')
  const pluginId = String((payload && payload.pluginId) || '').trim()
  if (pluginId === '') throw new Error('缺 pluginId')
  let rows = []
  try { rows = (typeof runner.inventory === 'function' ? runner.inventory() : []) || [] } catch (e) { rows = [] }
  const row = rows.find(function (r) { return String(r.pluginId) === pluginId })
  if (row === undefined) throw new Error('找不到插件 ' + pluginId + '（可能已被去重或移除，请刷新）')
  const pkgs = row.packages || []
  const current = row.currentPackageId !== undefined ? String(row.currentPackageId) : ''
  const want = String((payload && payload.packageId) || '').trim()
  const pkg = want !== '' ? want : (current !== '' ? current : String((pkgs[0] && pkgs[0].packageId) || ''))
  if (pkg === '') throw new Error('插件 ' + pluginId + ' 没有可运行的包')
  const entry = pkgs.find(function (p) { return String(p.packageId) === pkg })
  if (pkgs.length && entry === undefined) throw new Error('包 ' + pkg + ' 不属于插件 ' + pluginId + '（请刷新后重选）')
  let sid = String(row.agentId || '')
  if (sid === '') sid = await resolveCurrentSessionId(ctx)
  if (sid === '') throw new Error('缺少所属会话 id，无法运行（先在会话里使用过一次该插件再试）')
  const mode = (current !== '' && pkg !== current) ? 'update' : 'run'
  const hasClientHalf = !!(entry && entry.hasClientHalf === true)
  const allowWake = (payload && payload.wake) === true
  // 已经在跑同一个包就短路，不重复运行（重跑无收益；零唤醒通道也不会有 token 代价）。
  // 'client-pending' = host 半在跑、client 半还没被任何页面装入，同样不必重跑。
  const latestStatus = String((row.latestRun && row.latestRun.status) || '')
  const live = latestStatus === 'running' || latestStatus === 'client-pending'
  if (current !== '' && pkg === current && live && (payload && payload.force) !== true) {
    return {
      ok: true, noop: true, pluginId, packageId: pkg, mode, name: pluginCurrentName(row),
      status: latestStatus, silent: true, hasClientHalf, awaitingPage: latestStatus === 'client-pending',
      note: latestStatus === 'client-pending'
        ? 'host 半已在跑，client 半待页面装入（本页装不了，去 DSH 侧边栏 Cordis 面板点「运行」装入本页）；要重启请再点一次「运行」'
        : '该包已在运行，未重复运行；确需重启请再点一次「运行」',
    }
  }
  const outcome = await tryRun(ctx, runner, sid, pluginId, pkg, mode, hasClientHalf, allowWake)
  if (outcome.ran !== true) throw new Error('运行被拒绝：' + String(outcome.runError || 'unknown'))
  return {
    ok: true, pluginId, packageId: pkg, mode, name: pluginCurrentName(row),
    status: String(outcome.runStatus || 'running'), silent: outcome.silent === true,
    hasClientHalf, awaitingPage: outcome.awaitingPage === true,
  }
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
// [cordis/favorites] 收藏持久化（串行写入 + 旧位置迁移兜底）、恢复、常驻自动拉起
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
async function legacyFavoritesPath(ctx) {
  // B9 迁移兜底：旧版本用 sandboxPolicy.workspaceRoot（部署兜底）当工作区，
  // 收藏文件因此可能落在 <兜底根>/packer2-favorites.json。只回读，不写。
  try {
    const sp = ctx.get('sandboxPolicy')
    if (sp) {
      let base = ''
      if (typeof sp.resolve === 'function') {
        try { const resolved = sp.resolve(); if (resolved && typeof resolved.workspaceRoot === 'string') base = resolved.workspaceRoot } catch (e) { /* 退回读属性 */ }
      }
      if (base === '' && typeof sp.workspaceRoot === 'string') base = sp.workspaceRoot
      if (base !== '') return base.replace(/[\\/]+$/, '') + '/packer2-favorites.json'
    }
  } catch (e) { /* 无兜底位置 */ }
  return ''
}
async function readFavorites(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return { favorites: [] }
  const targets = []
  try { targets.push(await favoritesPath(ctx)) } catch (e) { /* 新位置不可知 */ }
  try {
    const legacy = await legacyFavoritesPath(ctx)
    if (legacy !== '' && targets.indexOf(legacy) === -1) targets.push(legacy)
  } catch (e) { /* 忽略兜底失败 */ }
  for (let i = 0; i < targets.length; i += 1) {
    if (targets[i] === '') continue
    try {
      const t = await fs.resolve(targets[i])
      const txt = await fs.readText(t)
      const obj = JSON.parse(txt)
      return (obj && Array.isArray(obj.favorites)) ? obj : { favorites: [] }
    } catch (e) { /* 读不到或解析失败：试下一个位置（旧位置迁移兜底） */ }
  }
  return { favorites: [] }
}
/**
 * 这次写入实际受哪条策略约束 —— fs 沙箱的 checkedTarget 用的是
 * sandboxPolicy.resolve() 的根，**不是** workspaceRoot(ctx)：
 * 全局 HTTP 路由下 workspaceRoot() 常常退回进程 cwd（= profile 目录），
 * 而策略根另有其人；两者不一致时写入会被判 FS_SANDBOX_DENIED。
 * 目标在策略根内 → 不传策略（沿用部署兜底）；在根外 → 显式申请 danger-full-access
 * （与 pack.js / portable.js 的产物写入同一手法）。
 */
async function writePolicyFor(ctx, target) {
  try {
    const sp = ctx.get('sandboxPolicy')
    let root = ''
    if (sp) {
      if (typeof sp.resolve === 'function') {
        const r = sp.resolve()
        if (r && typeof r.workspaceRoot === 'string') root = r.workspaceRoot
      }
      if (root === '' && typeof sp.workspaceRoot === 'string') root = sp.workspaceRoot
    }
    if (root === '') return undefined
    const rn = normPath(root).toLowerCase().replace(/\/+$/, '')
    const tn = normPath(target).toLowerCase()
    if (rn === '' || tn === rn || tn.indexOf(rn + '/') === 0) return undefined
    return { mode: 'danger-full-access' }
  } catch (e) { return undefined }
}
async function writeFavorites(ctx, obj) {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  const path = await favoritesPath(ctx)
  const t = await fs.resolve(path)
  await fs.writeText(t, JSON.stringify(obj, null, 2), undefined, undefined, await writePolicyFor(ctx, path))
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
// [install/source] 安装源识别（文件夹 package.json 预检 / 已存在路径归类，需要 fs 与 shell）
// 与 DSH 无关的文本归一在 base/source-spec；这里需要 fs / shell 服务，所以落在 install 层。
// 读目标包的 package.json：优先 fs 服务（进程内、跨平台），退回 shell 文本读取。
// 返回解析后的对象；读不到 / 解析不了返回 null（调用方据此报错或降级）。
async function readInstallManifest(ctx, manifestPath, policy) {
  let text = ''
  const fsSvc = ctx.get('fs')
  if (fsSvc !== undefined && typeof fsSvc.resolve === 'function' && typeof fsSvc.readText === 'function') {
    try {
      const res = await fsSvc.readText(await fsSvc.resolve(manifestPath))
      text = typeof res === 'string' ? res : String((res && res.text) || '')
    } catch (e) { /* 落到 shell */ }
  }
  if (text === '') {
    const cmd = isWindowsHost()
      ? 'Get-Content -Raw -Encoding UTF8 -LiteralPath ' + sq(manifestPath)
      : 'cat ' + sq(manifestPath)
    try { const res = await runShell(ctx, cmd, undefined, policy); text = (res.stdout && res.stdout.text) || '' } catch (e) { return null }
  }
  try { const obj = JSON.parse(text); return (obj && typeof obj === 'object') ? obj : null } catch (e) { return null }
}
// 问文件系统「这个路径是什么」。0=文件 / 1=目录 / -1=不确定（后端不支持 stat 或不存在）。
async function installPathKind(ctx, path) {
  const fsSvc = ctx.get('fs')
  if (fsSvc !== undefined && typeof fsSvc.stat === 'function' && typeof fsSvc.resolve === 'function') {
    try {
      const info = await fsSvc.stat(await fsSvc.resolve(path))
      if (info && info.type === 'directory') return 1
      if (info) return 0
    } catch (e) { return -1 }
  }
  if (await probePathExists(ctx, path)) return 0
  if (await probePathExists(ctx, path.replace(/[\\/]+$/, '') + '/package.json')) return 1
  return -1
}
// 未压缩文件夹：校验它确实是一个 dsh/npm 插件包（有 package.json 且 name 合法）。
async function localDirSource(ctx, dir, wsPolicy) {
  const manifestPath = dir.replace(/[\\/]+$/, '') + '/package.json'
  const manifest = await readInstallManifest(ctx, manifestPath, wsPolicy)
  if (manifest === null) throw new Error('该文件夹不是可安装的包：读不到或解析不了 package.json（' + dir + '）')
  const name = String(manifest.name === undefined || manifest.name === null ? '' : manifest.name).trim()
  if (!validPackageName(name)) {
    throw new Error('package.json 的 name 不是合法 npm 包名（' + JSON.stringify(name) + '）：请改成小写字母/数字/-._（如 dsh-my-plugin）。中文目录名或缺失 name 都会被 pnpm 判为 INVALID_DEPENDENCY_NAME。')
  }
  const p2 = (manifest.packer2 && typeof manifest.packer2 === 'object') ? manifest.packer2 : null
  const detail = (p2 && typeof p2.name === 'string' && p2.name !== '')
    ? (p2.name + (typeof p2.pluginId === 'string' && p2.pluginId !== '' ? '（' + p2.pluginId + '）' : '') + ' · 由我的Cordis 打包')
    : (name + '@' + String(manifest.version || '0.0.0'))
  return { kind: 'local-dir', spec: dir, detail: detail }
}
/**
 * 把一个「安装源」归类成 dsh plugin add 实际接收的规格：
 *   local-dir   未压缩文件夹（校验 package.json 的 name，避免 pnpm 的 INVALID_DEPENDENCY_NAME）；
 *   local-file  本地 .tgz / .dshplugin 文件；
 *   git         git 仓库（owner/repo 简写按 GitHub 展开，http(s)/ssh 地址加 git+ 前缀）；
 *   npm         npm 包名（含 @scope/name）。
 * kindHint 可选（''/auto 为自动判定）；自动模式下先按前缀/地址判定，再问磁盘「这个路径是否存在」，
 * 剩下的当 npm 包名交给 dsh/pnpm。
 */
async function resolveInstallSource(ctx, input, kindHint, wsPolicy) {
  const s = String(input === undefined || input === null ? '' : input).trim()
  const hint = String(kindHint === undefined || kindHint === null ? '' : kindHint).trim().toLowerCase()
  if (s === '') throw new Error('缺安装源（可填未压缩文件夹路径 / git 仓库地址 / npm 包名 / .tgz 文件）')
  if (s.charAt(0) === '-') throw new Error('安装源不能以 - 开头（会被当成 pnpm 命令行参数）')
  const declaredSpec = function (kind, spec, detail) {
    return { kind: kind, spec: spec, detail: detail + '（' + kindTextOf(kind) + '）' }
  }
  if (hint === 'dir' || hint === 'folder' || hint === 'path') return localDirSource(ctx, s, wsPolicy)
  if (hint === 'file' || hint === 'tgz') return declaredSpec('local-file', s, '本地安装包')
  if (hint === 'git') return declaredSpec('git', normalizeGitSpec(s), redactUrl(normalizeGitSpec(s)))
  if (hint === 'npm') return declaredSpec('npm', s, s)
  // 判定顺序很重要：显式前缀 → git 地址 → 本地路径 → 其余交给 npm。
  // link:/file: 是 npm 的本地依赖前缀，原样交给 dsh/pnpm（不经 npm 注册表解析）。
  if (/^link:/i.test(s)) return declaredSpec('local-dir', s, '链接安装（改源码即时生效，适合调试）')
  if (/^file:/i.test(s)) return declaredSpec('local-file', s, '本地安装包')
  if (/^git[+:]|^git@/i.test(s)) return declaredSpec('git', normalizeGitSpec(s), redactUrl(normalizeGitSpec(s)))
  // 只有「看起来是 git 仓库的 http(s)/ssh 地址」才补 git+ 前缀；npm 的 tarball URL
  // （https://…/x-1.0.0.tgz）要原样留给 npm，补成 git+ 会直接装不上。
  if (/^(https?|ssh):\/\//i.test(s) && (/\.git(?:#.*)?$/i.test(s) || /^(https?:\/\/)?(github|gitee|gitlab|bitbucket|codeberg)\.[^/]+\//i.test(s))) {
    return declaredSpec('git', normalizeGitSpec(s), redactUrl(normalizeGitSpec(s)))
  }
  // 远程 URL 一律交给 npm/pnpm：既能装 npm tarball，也能给 dsh plugin add 一个 http 依赖。
  if (/^(https?|file):\/\//i.test(s)) return declaredSpec('npm', s, s)
  if (/\.dshplugin(\.json)?$/i.test(s) || /\.(tgz|tar\.gz)$/i.test(s)) return declaredSpec('local-file', s, '本地安装包')
  const onDisk = await installPathKind(ctx, s)
  if (onDisk === 1) return localDirSource(ctx, s, wsPolicy)
  if (onDisk === 0) return declaredSpec('local-file', s, '本地安装包')
  if (isGitSource(s)) return declaredSpec('git', normalizeGitSpec(s), redactUrl(normalizeGitSpec(s)))
  return declaredSpec('npm', s, s)
}
// [install/profile] profile 层真实安装 / 卸载 / 导出：dsh plugin add/remove、已装清单、导出已装包
// DSH 系统层包：由安装目录提供，任何 profile 都不应卸载（面板与后端双重拦住）。
const PROFILE_BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']
// 本插件自身的包名（package.json name）：禁止自我卸载，否则面板自己先消失。
const SELF_PLUGIN_NAME = 'dsh-mycordis'
function installNoteFor(source, profile, quitHint) {
  const head = source.kind === 'local-dir'
    ? ('已执行 dsh plugin add（本地文件夹：' + source.spec + '；dsh link 会随源码改动生效）')
    : source.kind === 'git'
      ? ('已执行 dsh plugin add（git 仓库：' + source.detail + '）')
      : source.kind === 'npm'
        ? ('已执行 dsh plugin add（npm 包：' + source.detail + '）')
        : ('已执行 dsh plugin add（本地安装包：' + source.spec + '）')
  return head + '；重启 dsh 后生效（profile: ' + profile + '）' + quitHint
}
function installErrorHint(profile) {
  return '（安装会写入 $DSH_HOME/profiles/' + profile + '，按沙箱策略可能需要批准；'
    + '文件夹安装要求其 package.json 的 name 是合法 npm 包名——报 INVALID_DEPENDENCY_NAME 就是这个原因，'
    + '改 name 或改用「安装 dsh 包」上传 .tgz；git 安装需要机器上能访问该仓库与 git）'
}
/**
 * profile 层真实安装：安装源由 resolveInstallSource 归一。
 * payload.path 与 payload.source 等价（兼容旧面板），payload.sourceKind 可选（auto/dir/git/file/npm）。
 */
async function installBundle(ctx, payload) {
  const input = String((payload && (payload.source || payload.path)) || '').trim()
  const kindHint = String((payload && payload.sourceKind) || '').trim()
  const profile = await targetProfile(ctx, payload && payload.profile)
  if (!input) throw new Error('缺安装源（可填未压缩文件夹路径 / git 仓库地址 / npm 包名 / .tgz 文件）')
  const ws = await workspaceRoot(ctx) || ''
  // 暂存目录与清理都在工作区内：显式钉住本工作区为 workspace-write 边界
  // （全局路由下 ctx.sandboxPolicy.resolve() 的根是部署兜底根，不是会话工作区）。
  const wsPolicy = workspaceWritePolicy(ws)
  const source = await resolveInstallSource(ctx, input, kindHint, wsPolicy)
  let target = source.spec
  let staged = ''
  // .dshplugin 不是 npm 包，dsh plugin add 读不了：先在工作区里改名成 .tgz 再装（旧行为，保留）。
  if (source.kind === 'local-file' && /\.dshplugin$/i.test(source.spec)) {
    const dir = ws.replace(/[\\/]+$/, '') + '/.packer2/install-' + rand()
    await ensureDir(ctx, dir, wsPolicy)
    staged = dir + '/install.tgz'
    try {
      await runShell(ctx, isWindowsHost()
        ? 'Copy-Item -Force ' + sq(source.spec) + ' ' + sq(staged)
        : 'cp -f ' + sq(source.spec) + ' ' + sq(staged), undefined, wsPolicy)
    } catch (e) {
      try { await removeTree(ctx, dir, wsPolicy) } catch (e2) { /* best effort */ }
      throw new Error('暂存 .dshplugin 失败：' + safeErrorMsg(e))
    }
    target = staged
  }
  const policy = { mode: 'danger-full-access' }
  const cliPrefix = await resolveDshCli(ctx)
  const quitHint = desktopQuitHint(profile)
  try {
    await runShell(ctx, cliPrefix + ' plugin --profile ' + sq(profile) + ' add ' + sq(target), ws, policy, 300000)
    if (staged !== '') { try { await removeTree(ctx, staged.replace(/\/install\.tgz$/i, ''), wsPolicy) } catch (e) { /* best effort */ } }
    return { ok: true, path: input, source: input, kind: source.kind, detail: source.detail, profile, note: installNoteFor(source, profile, quitHint) }
  } catch (error) {
    if (staged !== '') { try { await removeTree(ctx, staged.replace(/\/install\.tgz$/i, ''), wsPolicy) } catch (e) { /* best effort */ } }
    throw new Error('安装失败：' + safeErrorMsg(error) + quitHint + installErrorHint(profile))
  }
}
async function dshHome(ctx) {
  const res = await runShell(ctx, "if ($env:DSH_HOME) { Write-Output $env:DSH_HOME } else { Write-Output (Join-Path $env:USERPROFILE '.dsh') }")
  const out = String((res.stdout && res.stdout.text) || '').trim().split(/\r?\n/)[0]
  return (out || '').replace(/[\\/]+$/, '')
}
/** 目录形状 <DSH_HOME>/profiles/<name> -> profile 名；不是该形状一律返回 ''（不猜）。 */
function profileNameOfDir(dir) {
  const m = /\/profiles\/([^/]+)$/i.exec(normPath(String(dir || '')))
  return (m && validProfile(m[1])) ? m[1] : ''
}
/**
 * 推断「当前正在运行的部署 profile」。
 * 面板两个 profile 输入框原本写死 'web'，桌面版（profile=desktop）打开就是空列表；
 * 这里按可靠性依次取候选目录，只认 <DSH_HOME>/profiles/<name> 这一种形状，
 * 所以会话工作区（E:\...\mycordis-v2）不会被误判成 profile。
 *   1. sandboxPolicy：部署兜底根（全局 HTTP 路由下通常就是 profile 目录）
 *   2. process.cwd()：桌面版进程 cwd = profile 目录（动态插件形态下 process 可能不存在）
 *   3. fs 服务默认目录：兜底
 * 全部落空返回 ''，由调用方保持原默认值。
 */
async function activeProfile(ctx) {
  const candidates = []
  try {
    const sp = ctx.get('sandboxPolicy')
    if (sp) {
      if (typeof sp.resolve === 'function') {
        try { const r = sp.resolve(); if (r && typeof r.workspaceRoot === 'string') candidates.push(r.workspaceRoot) } catch (e) { /* 退回读属性 */ }
      }
      if (typeof sp.workspaceRoot === 'string') candidates.push(sp.workspaceRoot)
    }
  } catch (e) { /* 继续下一个候选 */ }
  const proc = typeof process === 'undefined' ? undefined : process
  try { if (proc && typeof proc.cwd === 'function') candidates.push(proc.cwd()) } catch (e) { /* 继续 */ }
  try {
    const fsSvc = ctx.get('fs')
    if (fsSvc && typeof fsSvc.resolve === 'function' && typeof fsSvc.processPath === 'function') candidates.push(fsSvc.processPath(await fsSvc.resolve('.')))
  } catch (e) { /* 继续 */ }
  for (let i = 0; i < candidates.length; i += 1) {
    const name = profileNameOfDir(candidates[i])
    if (name !== '') return name
  }
  return ''
}
/**
 * 解析这次操作要落到哪个 profile。
 * 面板已经不再让用户选 profile（安装 / 管理与卸载的 profile 字段都删了），所以调用方不传时用
 * 「当前部署」——即 activeProfile 那条推断链认出来的那个（桌面版 = desktop）。显式传了名字就照用
 * （HTTP API 直接调用时这条路径仍然有效），并在这里统一校验，省得每个入口各写一遍 validProfile。
 * 三个候选全部落空（连 sandboxPolicy / process / fs 都拿不到）才退回 'web'。
 * 注意这里是 async：调用方必须 await，漏了就会把 payload 里的 undefined 当名字使。
 */
async function targetProfile(ctx, wanted) {
  const name = String(wanted || '').trim()
  if (name !== '') {
    if (!validProfile(name)) throw new Error('非法的 profile 名称（仅允许字母/数字/-/_，最长 32 个字符）')
    return name
  }
  const active = await activeProfile(ctx)
  return active !== '' ? active : 'web'
}
/**
 * 列出 $DSH_HOME/profiles 下已有的 profile（`GET /api/profiles`）。
 * 面板已经不用它做输入了（profile 字段删掉后固定走当前部署），留着是给 HTTP API / 脚本用：
 * 想换 profile 时先看有哪些、当前是哪个。
 * 只认合法目录名，并排掉 node_modules 与点开头目录：profiles 目录同时是 pnpm 的 workspace
 * 根，node_modules 会以普通目录的形式躺在那里，它不是 profile（实测存在）。
 * 目录还不存在（一个插件都没装过）时返回空列表，不报错——没有 profile 不是错误。
 * 注意：这里只是「列出」，新建 profile 由 dsh plugin --profile <新名> 自己初始化（实测会打印
 * 「dsh: initialized profile …」并落 package.json / cordis.patch.yml / pnpm-workspace.yaml）。
 */
async function listProfiles(ctx) {
  const home = await dshHome(ctx)
  const dir = home + '/profiles'
  const cmd = isWindowsHost()
    ? 'Get-ChildItem -LiteralPath ' + sq(dir) + ' -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name'
    : 'ls -1p ' + sq(dir) + " 2>/dev/null | sed -n 's#/$##p'"
  let names = []
  try {
    const res = await runShell(ctx, cmd, undefined, { mode: 'danger-full-access' })
    names = String((res.stdout && res.stdout.text) || '').split(/\r?\n/)
  } catch (e) { /* 目录不存在：一个 profile 都还没有 */ }
  const out = []
  names.forEach(function (raw) {
    const name = String(raw || '').trim()
    if (!validProfile(name) || name === 'node_modules' || name.charAt(0) === '.') return
    if (out.indexOf(name) === -1) out.push(name)
  })
  out.sort()
  // 当前部署的 profile 排最前：面板默认就用它。
  const active = await activeProfile(ctx)
  if (active !== '') {
    const at = out.indexOf(active)
    if (at === -1) out.unshift(active)
    else if (at > 0) { out.splice(at, 1); out.unshift(active) }
  }
  return { ok: true, profiles: out, active }
}
/**
 * 显式创建一个 profile 目录（$DSH_HOME/profiles/<name>）。
 * 面板「新增 profile」用它：在此之前只有「装插件时顺手初始化」这一条路（README 里的老说法），
 * 想在装之前先把 profile 建出来、或者只是想让它出现在下拉里，没有任何入口。
 * 复用 dsh 自己的初始化，不自己写 package.json / cordis.patch.yml：CLI 帮助原文写着
 * 「the profile whose plugins to manage (initialized on first use)」——实测 runPluginCommand
 * 在跑 pnpm 前会对缺失的 profile 调 initProfile。这里挑 pnpm 的 list 当那个「首次使用」：
 * 它只读本地 node_modules / lockfile，不装任何包、不写依赖。
 * 已存在的 profile 幂等返回 created:false（重复点「创建」不该报错）。
 * 名字先过一次 validProfile：它同时是路径段，必须挡住 ../ 这类穿越写法。
 */
async function createProfile(ctx, name) {
  const profile = String(name || '').trim()
  if (!validProfile(profile)) throw new Error('非法的 profile 名称（仅允许字母/数字/-/_，最长 32 个字符）')
  const home = await dshHome(ctx)
  if (await probePathExists(ctx, home + '/profiles/' + profile + '/package.json')) {
    return { ok: true, profile, created: false, note: 'profile ' + profile + ' 已存在，已选中（$DSH_HOME/profiles/' + profile + '）' }
  }
  const ws = await workspaceRoot(ctx)
  const cliPrefix = await resolveDshCli(ctx)
  const quitHint = desktopQuitHint(profile)
  try {
    await runShell(ctx, cliPrefix + ' plugin --profile ' + sq(profile) + ' list', ws, { mode: 'danger-full-access' }, 300000)
  } catch (error) {
    throw new Error('创建 profile 失败：' + safeErrorMsg(error) + quitHint)
  }
  return { ok: true, profile, created: true, note: '已创建 profile ' + profile + '（$DSH_HOME/profiles/' + profile + '）' + quitHint }
}
async function installedPlugins(ctx, wantedProfile) {
  const profile = await targetProfile(ctx, wantedProfile)
  const home = await dshHome(ctx)
  const manifestPath = home + '/profiles/' + profile + '/package.json'
  let text
  try {
    // 必须显式 -Encoding UTF8：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 代码页
    // 读取**无 BOM** 的 UTF-8 文件，profile 里带中文的依赖路径（如 file:E:/harness/插件开发/…）
    // 会整段解成乱码并原样显示在「管理与卸载」列表里。pwsh 7 默认就是 UTF-8，不受影响。
    const readCmd = isWindowsHost()
      ? 'Get-Content -Raw -Encoding UTF8 -LiteralPath ' + sq(manifestPath)
      : 'cat ' + sq(manifestPath)
    const res = await runShell(ctx, readCmd, undefined, { mode: 'danger-full-access' })
    text = (res.stdout && res.stdout.text) || ''
  } catch (e) {
    console.log('installedPlugins 读取失败: ' + String(e && e.message ? e.message : e))
    return { profile, error: '读取 profile 失败' }
  }
  let manifest
  try { manifest = JSON.parse(text) } catch (e) { return { profile, error: 'profile manifest 解析失败' } }
  const deps = (manifest && manifest.dependencies) || {}
  const bundles = (manifest && manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
  // 以 dsh 真正加载的层（dsh.profile.bundles）为基准，并集 dependencies：
  // 只读 dependencies 会漏掉「只声明为层」的包（如安装目录提供的 @deepseek-ai/dsh-base），
  // 只读 bundles 会漏掉「已装但未成层」的包。两者都列，并把异常态显式标出来。
  const names = []
  bundles.forEach(function (n) { const s = String(n || ''); if (s !== '' && names.indexOf(s) === -1) names.push(s) })
  Object.keys(deps).forEach(function (n) { if (names.indexOf(n) === -1) names.push(n) })
  const rows = names.map(function (n) {
    const inDeps = Object.prototype.hasOwnProperty.call(deps, n)
    const isBase = PROFILE_BASE_BUNDLES.indexOf(n) !== -1
    return {
      name: n,
      spec: inDeps ? String(deps[n]) : '',
      isBundle: bundles.indexOf(n) !== -1,
      isBase,
      isSelf: n === SELF_PLUGIN_NAME,
      ...(inDeps || isBase ? {} : { missingDependency: true }),
    }
  })
  // 用户自己装的插件排前面；基础层（由安装目录提供、不可卸载）沉底，别挡住真正要操作的行。
  rows.sort(function (a, b) { return (a.isBase ? 1 : 0) - (b.isBase ? 1 : 0) })
  return { profile, dependencies: rows }
}
/**
 * 已安装插件的包目录：<DSH_HOME>/profiles/<profile>/node_modules/<name>。
 * 只认这一条路径：pnpm 会为 profile 的每个依赖落一个实体目录（npm 装的是真目录、file: 是解包目录、
 * link: 是指向源码的联接），所以导出的是**这个 profile 里装好的那一份**，与 dependencies 里写的是 file:/git/npm 无关。
 * 基础层包（@deepseek-ai/dsh-*）由安装目录提供，不在 profile 的 node_modules 里 —— 这里明确报错，不猜。
 */
async function installedPluginDir(ctx, profile, name) {
  if (!validProfile(profile)) throw new Error('非法的 profile 名称（仅允许字母/数字/-/_）')
  if (!validPackageName(name)) throw new Error('非法的插件名（不是合法 npm 包名）：' + name)
  const home = await dshHome(ctx)
  const dir = home + '/profiles/' + profile + '/node_modules/' + name
  if (!(await probePathExists(ctx, dir + '/package.json'))) {
    // 报错里的路径一律用「形状」而不是绝对路径：路由会把错误过一遍 safeErrorMsg，
    // 它按 [A-Za-z]:[\/][^\s'";\n]* 贪婪替换绝对路径 —— 中文句子没有空格，绝对路径后面整句都会被吃掉。
    throw new Error('找不到已安装的包目录（<DSH_HOME>/profiles/' + profile + '/node_modules/' + name + '）：先在面板点「刷新」确认清单；基础层包由安装目录提供、不在 profile 的 node_modules 里，无法导出')
  }
  return dir
}
/**
 * 容错读取 $DSH_HOME 下的文本文件：不存在返回 ''（不抛错）。
 * 读的是工作区之外的路径，所以策略由调用方给（与「已装清单」一致：危险全权）。
 */
async function readInstalledText(ctx, path, policy) {
  const cmd = isWindowsHost()
    ? 'if (Test-Path -LiteralPath ' + sq(path) + ') { Get-Content -Raw -Encoding UTF8 -LiteralPath ' + sq(path) + ' }'
    : 'if [ -f ' + sq(path) + ' ]; then cat ' + sq(path) + '; fi'
  try {
    const res = await runShell(ctx, cmd, undefined, policy)
    return String((res.stdout && res.stdout.text) || '')
  } catch (e) { return '' }
}
/**
 * 把已装包摊成便携定义（.dshplugin.json 的内容），形状与 exportDynamicPlugin 一致。
 * 只认「host.js / client.js 半区」布局（我的Cordis 打出来的包、以及本插件自己）：
 * 动态插件的 host 半区是按 async 函数体求值的源码，普通 Cordis 组合插件的 ES 模块入口装不进去；
 * 与其生成一个导进去也跑不起来的文件，不如在这里明确拒绝，让用户改用 .tgz（可真实安装）。
 */
async function installedPortable(ctx, dir, manifest, policy) {
  // 半区可能直接在包根（面板「打包」产出的 .tgz 就是这种），也可能按 DSH bundle 约定放在 lib/ 下
  // ——本插件自身（代码在 lib/）以及所有「代码放 lib/」的 profile 包都属后者。两处都找，先包根后 lib/。
  // 只认包根会把 lib/ 布局的包误判成「不是半区布局」并给出误导性的报错（本插件自己就撞在这上面）。
  const readHalf = async (file) => {
    const root = await readInstalledText(ctx, dir + '/' + file, policy)
    if (root.trim() !== '') return root
    return readInstalledText(ctx, dir + '/lib/' + file, policy)
  }
  const host = await readHalf('host.js')
  const client = await readHalf('client.js')
  if (host.trim() === '' && client.trim() === '') {
    throw new Error('该包不是「host/client 半区」布局（包根与 lib/ 下都没有 host.js / client.js），无法导出便携包；请改用「dsh 安装包（.tgz）」格式（可真实安装）')
  }
  const meta = (typeof manifest.packer2 === 'object' && manifest.packer2 !== null) ? manifest.packer2 : {}
  const pkgName = String(manifest.name || '').trim()
  const code = {}
  if (host.trim() !== '') code.host = host
  if (client.trim() !== '') code.client = client
  // packageId 取包版本：已装插件没有会话级 packageId，版本是这个包唯一稳定又人类可读的标识。
  return sanitizePortable({
    __dshDynamicPlugin: true,
    format: 1,
    pluginId: String(meta.pluginId || pkgName),
    packageId: String(meta.packageId || manifest.version || ''),
    ownerSessionId: FAKE_SESSION_ID,
    name: String(meta.name || pkgName || 'imported-dynamic-plugin'),
    purpose: meta.purpose !== undefined ? String(meta.purpose) : String(manifest.description || ''),
    code,
  })
}
/** npm/pnpm 的 tarball 命名：@scope/name + 1.2.3 → scope-name-1.2.3.tgz。 */
function tarballNameOf(pkgName, version) {
  const base = String(pkgName || '').replace(/^@/, '')
  return base.split('/').join('-') + '-' + (String(version || '').trim() || '0.0.0') + '.tgz'
}
/**
 * 把已装目录打成 dsh 安装包（.tgz）：与「打包」页对会话级插件用的是同一条 pnpm pack，
 * 产物可直接「安装 dsh 包」或 dsh plugin add。pnpm 按 package.json 的 files 白名单打包，
 * 所以导出的是安装时的那一份，不会夹带 node_modules。
 * 命令的 cwd 在 $DSH_HOME 下（工作区之外），策略一律放宽 —— 与已装清单 / 卸载同一条规矩。
 */
async function packInstalledTgz(ctx, dir, pkgName, version, outDir, policy) {
  if (ctx.get('shell') === undefined) throw new Error('shell 服务不可用')
  const pnpmPrefix = await resolvePnpm(ctx, outDir)
  const res = await runShell(ctx, pnpmPrefix + ' pack --reporter append-only --pack-destination ' + sq(outDir), dir, policy, 300000)
  const expected = outDir.replace(/[\\/]+$/, '') + '/' + tarballNameOf(pkgName, version)
  // pnpm 会把产物的绝对路径打印在输出里，拿它最稳；拿不到再按命名规则拼一个并验证存在。
  const lines = String((res.stdout && res.stdout.text) || '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cand = lines[i].trim()
    if (/\.tgz$/i.test(cand) && await probePathExists(ctx, cand)) return cand
  }
  if (await probePathExists(ctx, expected)) return expected
  throw new Error('pnpm pack 结束但没找到产物（期望 ' + tarballNameOf(pkgName, version) + '）：请确认 package.json 的 files 白名单没有排除全部内容')
}
/**
 * 导出已安装（profile 层）的插件 —— 「管理与卸载」页每行的「导出」按钮。
 * 三种格式与「打包」页对齐：
 *   tgz      dsh 安装包（.tgz），可直接「安装 dsh 包」/ dsh plugin add；
 *   portable 便携包（host + client 完整定义），可「导入便携包」到别的会话（仅 host/client 半区布局的包）；
 *   whole    两者都要，一插件一个子文件夹（与整包布局一致）。
 * 与「打包」页不同：这里没有 packageId 可选，导出的是该 profile 里装好的那一份，packageId 即包版本。
 */
async function exportInstalledPlugin(ctx, p) {
  const name = String((p && p.name) || '').trim()
  const profile = await targetProfile(ctx, p && p.profile)
  const format = String((p && p.format) || 'tgz').trim()
  const outDirRaw = String((p && p.outDir) || '').trim()
  if (name === '') throw new Error('缺插件名')
  if (format !== 'tgz' && format !== 'portable' && format !== 'whole') throw new Error('未知的导出格式：' + format)
  const ws = await workspaceRoot(ctx)
  if (!ws) throw new Error('无法确定工作区根目录')
  const outDir = outDirRaw === '' ? ws.replace(/[\\/]+$/, '') + '/packer2-out' : outDirRaw
  const wsNorm = normPath(ws).toLowerCase()
  const outNorm = normPath(outDir).toLowerCase()
  const outside = outNorm !== wsNorm && !outNorm.startsWith(wsNorm + '/')
  // 读已装目录（以及 pnpm pack 的 cwd）一律在工作区外：统一用放宽策略；
  // 写产物按放置目录判断：工作区内钉住本工作区，工作区外放宽（与 exportBatch 同规矩）。
  const homePolicy = { mode: 'danger-full-access' }
  const writePolicy = outside ? { mode: 'danger-full-access' } : workspaceWritePolicy(ws)
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs 服务不可用')
  const dir = await installedPluginDir(ctx, profile, name)
  const manifestText = await readInstalledText(ctx, dir + '/package.json', homePolicy)
  if (manifestText.trim() === '') throw new Error('读不到已装包目录里的 package.json（<DSH_HOME>/profiles/' + profile + '/node_modules/' + name + '）')
  let manifest
  try { manifest = JSON.parse(manifestText) } catch (e) { throw new Error('包内 package.json 不是合法 JSON：' + safeErrorMsg(e)) }
  if (manifest === null || typeof manifest !== 'object') throw new Error('包内 package.json 不是对象')
  const pkgName = String(manifest.name || '').trim() || name
  const version = String(manifest.version || '').trim()
  await ensureDir(ctx, outDir, writePolicy)
  const out = { name, profile, format, packageName: pkgName, version, ok: true }
  let target = outDir
  if (format === 'whole') {
    target = outDir.replace(/[\\/]+$/, '') + '/' + pkgName + (version === '' ? '' : '-' + version)
    await ensureDir(ctx, target, writePolicy)
    out.dir = target
  }
  if (format === 'tgz' || format === 'whole') {
    const tgzPath = await packInstalledTgz(ctx, dir, pkgName, version, target, homePolicy)
    const meta = await fileSha256AndSize(ctx, tgzPath, writePolicy)
    out.tgzPath = tgzPath
    out.tgzName = tgzPath.split(/[\\/]/).pop()
    out.sha256 = meta.sha256
    out.sizeBytes = meta.sizeBytes
  }
  if (format === 'portable' || format === 'whole') {
    try {
      const data = await installedPortable(ctx, dir, manifest, homePolicy)
      const artifact = target.replace(/[\\/]+$/, '') + '/' + data.pluginId + '-' + data.packageId + '.dshplugin.json'
      await fs.writeText(await fs.resolve(artifact), JSON.stringify(data, null, 2), undefined, undefined, writePolicy)
      out.pluginId = data.pluginId
      out.packageId = data.packageId
      out.displayName = data.name
      out.hasClientHalf = data.code.client !== undefined
      out.portablePath = artifact
      out.portableName = artifact.split(/[\\/]/).pop()
    } catch (e) {
      // 整包：便携半区做不出来（普通 Cordis 组合包没有 host/client 半区）不该连已经打好的 .tgz
      // 一起判死——那一份是能真实安装的产物，丢掉它等于让用户白跑一次还把错误当成了「全失败」。
      // 记成 portableError（面板按警告渲染），只有「只要便携包」这一种格式才真的失败。
      if (format === 'portable') throw e
      out.portableError = safeErrorMsg(e)
    }
  }
  return out
}
/**
 * 批量导出已安装插件（「一键导出全部」）：单个失败不影响其余，逐项收成 results。
 * payload 里的 profile / format / outDir 是这批的公共参数，plugins 是 [{ name }]。
 */
async function exportInstalledBatch(ctx, payload) {
  const plugins = (payload && payload.plugins) || []
  if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('未勾选任何插件')
  const profile = await targetProfile(ctx, payload && payload.profile)
  const format = String((payload && payload.format) || 'tgz').trim()
  const outDir = String((payload && payload.outDir) || '')
  const results = []
  for (const p of plugins) {
    const name = String((p && p.name) || '')
    try { results.push(await exportInstalledPlugin(ctx, { name, profile, format, outDir })) }
    catch (e) { results.push({ name, profile, format, ok: false, message: safeErrorMsg(e) }) }
  }
  return { ok: true, profile, format, results }
}
async function uninstallBundle(ctx, payload) {
  const name = String(payload && payload.name || '').trim()
  const profile = await targetProfile(ctx, payload && payload.profile)
  if (!name) throw new Error('缺插件名')
  // 只拦基础包：它由安装目录提供，卸载会直接破坏 profile。
  // 本插件自身（SELF_PLUGIN_NAME）**允许卸载** —— 它同样是用户自己装的插件，用户可能就是要换装/清掉它；
  // 后果由面板二次确认 + isSelf 提示讲清楚，不由后端替用户决定。
  if (PROFILE_BASE_BUNDLES.indexOf(name) !== -1) throw new Error('拒绝卸载 ' + name + '：这是 DSH 系统层包（由安装目录提供），卸载会破坏该 profile')
  const ws = await workspaceRoot(ctx)
  const cliPrefix = await resolveDshCli(ctx)
  const quitHint = desktopQuitHint(profile)
  try {
    await runShell(ctx, cliPrefix + ' plugin --profile ' + sq(profile) + ' remove ' + sq(name), ws, { mode: 'danger-full-access' }, 300000)
  } catch (error) {
    throw new Error('卸载失败：' + safeErrorMsg(error) + quitHint)
  }
  const isSelf = name === SELF_PLUGIN_NAME
  return {
    ok: true, name, profile, isSelf,
    note: '已卸载 ' + name + '；重启 dsh 后生效（profile: ' + profile + '）'
      + (isSelf ? '（卸载的是本插件自身：重启后「我的Cordis」面板消失，需要时重新安装 dsh-mycordis 即可）' : '')
      + quitHint,
  }
}
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
/* ── 版面：全页一个节奏（main 间距 12 / box 内边距 13×14 / section 上 16 下 8） ── */
main{padding:14px;max-width:920px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.view{display:flex;flex-direction:column;gap:12px}
.box{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:13px 14px}
.box>*:first-child{margin-top:0}
.box>*:last-child{margin-bottom:0}
.section{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12.5px;font-weight:600;color:var(--fg);margin:16px 0 8px}
.section::before{content:"";flex:none;width:3px;height:13px;border-radius:2px;background:var(--accent)}
.section .hint{font-weight:400}
.desc{font-size:11.5px;line-height:1.7;color:var(--fg2);margin:0 0 8px}
.desc b{color:var(--fg);font-weight:600}
/* 长说明默认折叠：面板只有 560~680px 宽，整段文字会把真正要操作的东西挤下去 */
.note{background:var(--panel2);border:1px solid var(--line2);border-radius:var(--r2);margin:0 0 10px;padding:0 10px}
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
.row input[type=text],.fieldbar>input[type=text]{flex:1;min-width:120px}
.row .spacer,.fieldbar .spacer{flex:1;min-width:0}
.chk{display:inline-flex;align-items:center;gap:5px;height:30px;font-size:12px;color:var(--fg2);white-space:nowrap;flex:none;cursor:pointer;user-select:none}
.chk input{margin:0;accent-color:var(--accent)}
.hint{color:var(--muted);font-size:11.5px}
.ok{color:var(--ok)}.err{color:var(--err)}.warn{color:var(--warn)}
code{font-family:var(--mono);font-size:.92em;padding:0 4px;border-radius:4px;background:var(--panel3);color:var(--fg2)}
/* ── 安装源：字段 + 类型图例 + 动作条 ── */
.srcbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:7px 0 0}
.chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border:1px solid var(--line);border-radius:999px;background:var(--panel2);color:var(--muted);font-size:10.5px;line-height:1;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.chip.on{background:var(--accent-weak);border-color:var(--accent-line);color:var(--accent);font-weight:600}
.srckind{margin-left:auto;min-width:0;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.srckind.on{color:var(--accent)}.srckind.bad{color:var(--err)}
.fieldbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:9px 0 0}
.fieldbar .spacer{flex:1;min-width:0}
.box.drop{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak)}
/* ── 「选择文件」：一枚按钮收两个入口（文件夹 / 安装包），点开是一个小下拉 ── */
.pickspot{position:relative;flex:none;display:inline-flex}
.btn .caret{display:block;width:0;height:0;margin-left:5px;border-left:3.5px solid transparent;border-right:3.5px solid transparent;border-top:4.5px solid currentColor;opacity:.75}
.popmenu{position:absolute;top:calc(100% + 4px);right:0;z-index:8;min-width:216px;padding:4px;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);box-shadow:0 6px 20px rgba(16,24,40,.18);display:flex;flex-direction:column;gap:2px}
.pmi{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;padding:6px 9px;border:1px solid transparent;border-radius:var(--r3);background:none;color:var(--fg);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.pmi:hover:not(:disabled){background:var(--accent-weak);border-color:var(--accent-line);color:var(--accent)}
.pmi:disabled{opacity:.45;cursor:not-allowed}
.pmi-sub{font-size:10.5px;color:var(--muted)}
.pmi:hover:not(:disabled) .pmi-sub{color:inherit;opacity:.85}
/* ── 列表 ── */
ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);max-height:340px;overflow:auto;overscroll-behavior:contain}
.table{border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);overflow:hidden}
.table ul{border:none;border-radius:0;max-height:300px}
.ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid{display:grid;grid-template-columns:22px minmax(0,1fr) 76px 196px 54px;gap:8px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--line2);font-size:12.5px;min-width:0}
.grid:last-child{border-bottom:none}
.grid:not(.head):hover{background:var(--panel2)}
.grid.head{position:sticky;top:0;z-index:1;background:var(--panel);font-size:10.5px;color:var(--muted);letter-spacing:.03em;border-bottom:1px solid var(--line)}
.grid.head .chk{height:auto}
.grid input[type=checkbox]{margin:0;accent-color:var(--accent)}
.grid select{height:26px;font-size:11.5px}
.grid .mini{height:26px}
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
.tag{display:inline-flex;align-items:center;flex:none;height:17px;padding:0 7px;border:1px solid transparent;border-radius:999px;background:var(--panel3);color:var(--muted);font-size:10px;line-height:1;white-space:nowrap}
.tag.bundle{background:var(--accent-weak);border-color:var(--accent-line);color:var(--accent)}
.tag.self{background:var(--warn-weak);border-color:var(--warn-line);color:var(--warn)}
.tag.miss{background:var(--err-weak);border-color:var(--err-line);color:var(--err)}
/* ── 插件卡片 ── */
/* auto-fill（不是 auto-fit）：卡片只有一两张时也保持一行的等宽小卡，不会被拉成大块 */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.card{min-height:152px;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);padding:8px;display:flex;flex-direction:column;gap:5px;position:relative;min-width:0;overflow:hidden;transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:var(--accent-line);box-shadow:var(--shadow)}
.card .star{position:absolute;top:4px;right:4px;width:22px;height:22px;background:none;border:none;border-radius:6px;cursor:pointer;font-size:14px;line-height:1;color:#d4a017;padding:0}
.card .star:hover{background:var(--panel3)}
.card .cname{font-weight:600;font-size:11.5px;line-height:1.3;padding-right:20px;height:30px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;flex:none}
.card .cid{font-family:var(--mono);font-size:9.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
.card select{width:100%;height:24px;font-size:10.5px;flex:none}
/* 动作 2×2：运行 / 常驻 在上，恢复 / 复制 在下 */
.card .cactions{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:auto;flex:none}
.card .cactions button{min-width:0;height:24px;padding:0;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--line);border-radius:var(--r3);background:var(--panel2);color:var(--fg2);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.card .cactions button:hover:not(:disabled){border-color:var(--muted);color:var(--fg)}
.card .cactions button:disabled{opacity:.4;cursor:not-allowed}
.card .cactions .resbtn.on{background:var(--accent-weak);border-color:var(--accent-line);color:var(--accent);font-weight:600}
.card .cactions .runbtn{background:var(--ok-weak);border-color:var(--ok-line);color:var(--ok);font-weight:600}
.card .cactions .runbtn:hover:not(:disabled){border-color:var(--ok);color:var(--ok)}
.empty{grid-column:1/-1;color:var(--muted);font-size:12px;padding:22px 12px;text-align:center;border:1px dashed var(--line);border-radius:var(--r2);background:var(--panel2)}
/* 计数胶囊：跟着 section 标题走，空值自动隐藏 */
.count{display:inline-flex;align-items:center;justify-content:center;flex:none;height:17px;min-width:17px;padding:0 6px;border-radius:999px;background:var(--panel3);color:var(--fg2);font-size:10.5px;font-weight:600;line-height:1}
.count:empty{display:none}
li.empty{display:block;border:none;background:transparent}
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
    <div class="section">产物放置目录<span class="tag">打包与导出都落在这里</span></div>
    <div class="fieldbar" style="margin-top:0"><input id="outDir" type="text" spellcheck="false" placeholder="选择或粘贴打包产物输出目录"><button id="browse" class="btn">浏览…</button><button id="refresh" class="btn">刷新列表</button></div>
  </div>
  <div class="box">
    <div class="section">会话级动态插件<span class="tag">会话级 · 仅当前 dsh 进程</span></div>
    <label for="ptype">打包类型（勾选插件后一键打包，或点每行「打包」单打）</label>
    <div class="row" style="margin-top:0">
      <select id="ptype" style="flex:1;min-width:170px"><option value="dsh">dsh 包（.tgz，真实安装）</option><option value="portable">便携包（host + client 完整定义）</option><option value="whole">整包（dsh 安装包 + 便携包）</option></select>
      <label class="chk" title="便携包默认把 host 与 client 半区一起导出，导入别的会话/机器后插件 UI 同样能复现；勾上则只留 host 半区（更小，但带 client UI 的插件会丢失界面）。"><input type="checkbox" id="ppure">仅 host 半区</label>
      <button id="batch" class="btn primary">一键打包</button>
    </div>
    <div id="hint" class="hint" style="margin:8px 0 6px"></div>
    <div class="table">
      <div class="grid head"><label class="chk" title="全选 / 取消全选"><input type="checkbox" id="all"></label><span>插件名</span><span>插件 ID</span><span>版本</span><span>操作</span></div>
      <ul id="list"></ul>
    </div>
      <ul id="list"></ul>
    </div>
  </div>
</div>
<div id="viewInst" class="view" hidden>
  <div class="box">
    <div class="section">① 安装 dsh 包<span class="tag">真实安装 · 重启 dsh 生效</span></div>
    <details class="note"><summary>支持哪些安装源、装到哪、注意什么</summary>
      <div class="desc"><b>自动判定顺序</b>：显式前缀（<code>file:</code> / <code>link:</code> / <code>git+</code> / <code>git@</code>）→ 磁盘上真实存在的路径（目录 = 文件夹安装，文件 = 安装包）→ git 地址 → 其余按 npm 包名 / 远程 URL。<br>
      · <b>未压缩文件夹</b>：如 <code>E:\\harness\\dsh-MyCordis</code>，其 <code>package.json</code> 的 <code>name</code> 必须是合法 npm 包名（小写字母 / 数字 / <code>-._</code>）。<br>
      · <b>git 仓库</b>：<code>owner/repo</code>（按 GitHub 展开）、<code>https://gitee.com/…</code>、<code>git+https://…</code>、<code>git@host:owner/repo.git</code>；机器上要能访问该仓库并装有 git。<br>
      · <b>npm 包名</b>：<code>dsh-mycordis</code>、<code>@scope/name</code>，也支持带版本号（<code>dsh-mycordis@0.1.1</code>）。<br>
      · <b>本地安装包</b>：地址栏填 <code>.tgz</code> 路径，或点「选择文件」→「安装包…」上传、把文件拖进本框（上限 50MB）。<br>
      安装等价于 <code>dsh plugin add</code>，<b>需批准提升权限</b>，写进<b>当前部署那个 profile</b>（<code>$DSH_HOME/profiles/&lt;当前 profile&gt;</code>，面板不再让你选；目标 profile 名会写在下面的运行日志里），<b>重启 dsh 后生效</b>；当前部署就是 <code>desktop</code> 时必须先完全退出桌面版。</div>
    </details>
    <label for="ipath">安装源</label>
    <div class="row" style="margin-top:0"><input id="ifile" type="file" accept=".tgz,.dshplugin,application/gzip" style="display:none"><input id="ipath" type="text" spellcheck="false" placeholder="粘贴路径 / git 仓库 / npm 包名" title="未压缩文件夹 / git 仓库地址 / npm 包名都可以；也可以把 .tgz 文件直接拖进本框（上限 50MB）"><span class="pickspot"><button id="ipick" class="btn" type="button" aria-haspopup="true" aria-expanded="false" title="挑本机要安装的东西：未压缩文件夹，或 .tgz / .dshplugin 安装包">选择文件<span class="caret"></span></button><div id="ipickMenu" class="popmenu" hidden role="menu"><button id="ipathPick" class="pmi" type="button" role="menuitem" title="用 DSH 原生目录选择器挑一个未压缩文件夹（目录里要有合法的 package.json）">文件夹…<span class="pmi-sub">未压缩的插件目录</span></button><button id="ifilebtn" class="pmi" type="button" role="menuitem" title="挑一个本地 .tgz / .dshplugin 上传安装（上限 50MB）">安装包…<span class="pmi-sub">.tgz / .dshplugin，上限 50MB</span></button></div></span><button id="ibtn" class="btn primary">安装</button></div>
    <div class="srcbar"><span class="chip" data-kind="local-dir">文件夹</span><span class="chip" data-kind="git">git 仓库</span><span class="chip" data-kind="npm">npm 包</span><span class="chip" data-kind="local-file">.tgz 文件</span><span id="isrcKind" class="srckind"></span></div>
  </div>
  <div class="box">
    <div class="section">② 导入便携包<span class="tag">临时插件 · 不写 profile</span></div>
    <details class="note"><summary>说明与注意事项</summary>
      <div class="desc">⚠ 导入会在 dsh 进程内执行包内代码，请只导入可信来源的文件。<b>两种文件都不安装</b>：不写 $DSH_HOME/profiles、不用选 profile、不用重启 dsh，只在当前进程注册为临时插件（重启即消失），一个文件一个插件。<br>· <b>.tgz</b>（dsh 包，推荐）：自动用系统 tar 解到工作区临时目录，取包内 host.js + client.js；<br>· <b>.dshplugin.json</b>（便携定义，旧格式）：直接给 host + client 两个半区。<br>导入后默认自动运行，且<b>一律走零唤醒通道</b>：host 半静默启动（<b>不唤醒会话、不花 token</b>）；带 client 半区的包停在「待页面装入」，去 DSH 侧边栏的 Cordis 面板点「运行」把 client 半装入本页（那条结算用 agent.inject，只注入一条上下文、同样不唤醒）。多会话并存时先用左侧「会话…」下拉选所属会话：选项按「历史对话标题 - 会话id」展示（能自动解析或只有一个存活会话时会预选，否则手填 id）。</div>
    </details>
    <label for="xsess">所属会话（多会话并存时必选；左侧下拉选中即回填右侧 id）</label>
    <div class="row" style="margin-top:0"><input id="xfile" type="file" accept=".tgz,.json,.dshplugin.json,.dshplugin,application/gzip" style="display:none"><select id="xsessSel" style="flex:none;width:200px" title="选择所属会话（多会话并存时必选；选中即回填右侧 id）"></select><input id="xsess" type="text" spellcheck="false" placeholder="所属会话 id（可空）"></div>
    <div class="fieldbar"><label class="chk"><input type="checkbox" id="xauto" checked>导入后自动运行</label><span class="spacer"></span><button id="xbtn" class="btn primary">导入便携包</button></div>
  </div>
</div>
<div id="viewMgmt" class="view" hidden>
  <div class="box">
    <div class="section">已安装 dsh 插件<span class="tag">常驻 · 重启生效</span><span id="instProfile" class="tag"></span><span id="instCount" class="count"></span><button id="mrefresh" class="btn" style="margin-left:auto;height:26px;padding:0 10px;font-size:11.5px">刷新</button></div>
    <details class="note"><summary>说明与注意事项</summary>
      <div class="desc">以 dsh.profile.bundles 为基准并集 dependencies（用户装的排前面，基础层沉底）；profile 固定用<b>当前部署</b>那个（面板不再让你选，名字显示在标题行）；每行可<b>导出</b>（把 profile 里装好的那一份打成安装包 / 便携包）或卸载，只有基础包两样都不可行；导出读的是 $DSH_HOME 下该 profile 的包目录，卸载需批准提升权限、重启 dsh 生效。注意 profile=desktop 必须先完全退出桌面版，否则会被 package.json.lock 挡住。</div>
    </details>
    <label for="moutDir">导出到</label>
    <div class="row" style="margin-top:0"><input id="moutDir" type="text" spellcheck="false" placeholder="导出放置目录（缺省 = 工作区 packer2-out）"><button id="mbrowse" class="btn">浏览…</button><select id="mfmt" style="flex:none;width:180px" title="导出格式：dsh 安装包（.tgz）可直接「安装 dsh 包」；便携包（.dshplugin.json）可「导入便携包」到别的会话；整包两者都要，一插件一子文件夹"><option value="tgz">dsh 安装包（.tgz）</option><option value="portable">便携包（host + client）</option><option value="whole">整包（.tgz + 便携包）</option></select><button id="mexportAll" class="btn primary">一键导出全部</button></div>
    <ul id="instList" style="margin-top:10px"></ul>
  </div>
</div>
<div id="viewTemp" class="view" hidden>
  <div class="box">
    <div class="section">临时插件<span class="tag">会话级 · 仅当前 dsh 进程</span></div>
    <details class="note"><summary>说明与注意事项</summary>
      <div class="desc">来自「安装 → 导入便携包」的 .dshplugin.json：只在当前进程内注册，重启 dsh 即消失；常驻/收藏才会跨重启保留。☆ 收藏（仅显示卡片，不自动运行）/ 常驻（收藏 + 重启自动运行）/ 恢复（启动）/ 复制 / 同名合并版本。<br>token：运行<b>默认走零唤醒通道</b>（runHostHalf(requestId=null)，面板手势）——host 半静默启动，<b>不唤醒任何会话轮次</b>；带 client 半区的包停在「待页面装入」，去 DSH 侧边栏的 Cordis 面板点「运行」装入本页（settleUserRun → agent.inject，只注入一条上下文、不唤醒）。只有勾选「允许唤醒会话」才会退回会 agent.steer 的旧通道。</div>
    </details>
    <div class="fieldbar" style="margin-top:0"><button id="frestore" class="btn primary">恢复收藏</button><button id="dedupe" class="btn">去重</button><span class="spacer"></span><label class="chk" title="应急开关：退回 run() 请求通道，结算走 agent.steer（唤醒一轮、花 token）。零唤醒通道可用时不要勾。"><input type="checkbox" id="wakeok">允许唤醒会话（应急）</label></div>
  </div>
  <div class="box">
    <div class="section">已收藏<span id="favCount" class="count"></span></div>
    <div class="desc">来自收藏记录 packer2-favorites.json，重启后仍显示卡片；点 ★ 取消收藏会移入下方「未收藏」，下次重启消失。</div>
    <div id="favCards" class="cards"></div>
  </div>
  <div class="box">
    <div class="section">未收藏<span id="unfavCount" class="count"></span></div>
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
  function pickInto(inputId, after) {
    fetch(API + '/browse/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json() })
      .then(function (f) {
        if (f && f.picked) { $(inputId).value = f.picked; setCache(inputId, f.picked); if (after) after(); return }
        if (f && f.error) log('err', '⚠ ' + f.error)
      })
      .catch(function (e) { log('err', '✘ 浏览失败: ' + e.message) })
  }
  $('browse').onclick = function () { pickInto('outDir') }
  var installBusy = false
  function setInstalling(on) {
    installBusy = on
    $('ibtn').disabled = on
    $('ibtn').textContent = on ? '安装中…' : '安装'
    // 忙的时候连「选择文件」和它下面两个入口一起锁上，避免安装途中再弹一个系统对话框。
    $('ipick').disabled = on
    $('ipathPick').disabled = on
    $('ifilebtn').disabled = on
    if (on) closePickMenu()
  }
  function looksLikeGitSource(s) {
    return /^git[+:]|^git@/i.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(s)
  }
  // 前端粗判安装源类型：只用来点亮图例与提示，**不参与提交**——真正的判定在 host 半区
  // （disk 上是否真实存在只有那边知道），所以这里宁可判不准也不要去猜。
  var SRC_KIND_TEXT = { 'local-dir': '未压缩文件夹', git: 'git 仓库', npm: 'npm 包', 'local-file': '本地安装包' }
  function guessSourceKind(s) {
    if (s === '') return ''
    var isPkgFile = /\\.(tgz|dshplugin)$/i.test(s)
    var looksPath = /^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]/.test(s) || s.indexOf('\\\\') !== -1 || /^\\.\\.?[\\/]/.test(s) || /^(file|link):/i.test(s)
    if (looksPath) return isPkgFile ? 'local-file' : 'local-dir'
    if (/^git[+:]|^git@/i.test(s)) return 'git'
    if (/^https?:\\/\\//i.test(s)) {
      // 已知 git 托管站、或以 .git 结尾 → git；其余 https（含 npm tarball 直链）交给 npm。
      if (/(^|\\/\\/)(github|gitlab|gitee|bitbucket|codeberg)\\./i.test(s) || /\\.git$/i.test(s)) return 'git'
      return 'npm'
    }
    if (/^[\\w.-]+\\/[\\w.-]+$/.test(s)) return 'git'
    if (/^(@[a-z0-9-~][a-z0-9-._~]*\\/)?[a-z0-9-~][a-z0-9-._~]*(@[\\w.\\-+]+)?$/i.test(s)) return 'npm'
    return ''
  }
  // 图例同时充当状态灯：命中的那一枚点亮 + 右侧给一句人话；地址栏为空时提示还能拖文件。
  function refreshSourceKind() {
    var s = $('ipath').value.trim()
    var k = guessSourceKind(s)
    var chips = document.querySelectorAll('#viewInst .chip')
    for (var i = 0; i < chips.length; i += 1) chips[i].className = 'chip' + (chips[i].getAttribute('data-kind') === k ? ' on' : '')
    var el = $('isrcKind')
    if (s === '') { el.className = 'srckind'; el.textContent = '可点「选择文件」挑文件夹 / 安装包，也可拖入 .tgz'; return }
    if (k === '') { el.className = 'srckind bad'; el.textContent = '无法识别，检查一下写法'; return }
    el.className = 'srckind on'; el.textContent = '识别为 ' + SRC_KIND_TEXT[k]
  }
  // 地址栏有内容 → 按安装源（文件夹 / git / npm）安装；地址栏为空 → 走文件选择上传 .tgz。
  function readInstallSource() { return { source: $('ipath').value.trim() } }
  // 安装结果渲染：上传 .tgz 与「地址栏路径 / git」两条来源共用。
  function renderInstallResult(d) {
    var good = d && (d.ok !== false) && (d.note !== undefined)
    var detail = (d && d.detail) ? '（' + d.detail + '）' : ''
    log(good ? 'ok' : 'err', (good ? '✔ ' : '✘ ') + ((d && (d.note || d.message)) || JSON.stringify(d)) + (good ? detail : ''))
  }
  function doInstall(source, kind, label, done) {
    clearLog()
    log('step', '▸ 安装 ' + label + ' → 当前部署的 profile（后端解析，需批准提升权限）…')
    fetch(API + '/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: source, sourceKind: kind }) })
      .then(function (r) { return r.json() })
      .then(function (d) { renderInstallResult(d); done(false) })
      .catch(function (e) { log('err', '✘ ' + e.message); done(false) })
  }
  $('ibtn').onclick = function () {
    if (installBusy) return
    var src = readInstallSource().source
    // 地址栏为空：以前这里直接弹文件选择器，但按钮字面是「安装」，弹框会让人以为点错了。
    // 现在说清两条入口，并把焦点交回地址栏。
    if (src === '') {
      log('warn', '⚠ 请先填写安装源；要装本地文件请点「选择文件」→「安装包…」，或把 .tgz 拖进本框')
      $('ipath').focus()
      return
    }
    var looksPath = /^[a-zA-Z]:[\\/]/.test(src) || /^[\\/]/.test(src) || src.indexOf('\\\\') !== -1 || /^\.\.?[\\/]/.test(src) || /^(file|link):/i.test(src)
    var looksNpm = /^(@[a-z0-9-~][a-z0-9-._~]*\\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(src)
    if (!looksPath && !looksLikeGitSource(src) && !looksNpm) {
      log('err', '✘ 无法识别的安装源：' + src + '（本地文件请点「选择文件」→「安装包…」或直接拖入）')
      return
    }
    setInstalling(true)
    doInstall(src, 'auto', src, function () { setInstalling(false) })
  }
  // ① 只有一个「选择文件」：文件夹（DSH 原生目录选择器）与安装包（浏览器文件选择）是两种
  // 互斥的交互，系统的一个打开对话框没法一次选完，所以收进这枚按钮下面的两行小下拉。
  function closePickMenu() {
    var m = $('ipickMenu')
    if (m && !m.hidden) m.hidden = true
    if ($('ipick')) $('ipick').setAttribute('aria-expanded', 'false')
  }
  $('ipick').onclick = function (e) {
    if (installBusy) return
    // 别让这次点击冒泡到下面的 document 监听（否则菜单刚开就被自己关掉）。
    if (e && e.stopPropagation) e.stopPropagation()
    var m = $('ipickMenu')
    if (m.hidden) { m.hidden = false; $('ipick').setAttribute('aria-expanded', 'true') } else closePickMenu()
  }
  $('ipathPick').onclick = function () {
    if (installBusy) return
    closePickMenu()
    pickInto('ipath', function () { setCache('ipath', $('ipath').value); refreshSourceKind() })
  }
  $('ifilebtn').onclick = function () { if (installBusy) return; closePickMenu(); $('ifile').click() }
  // 点别处 / 按 Esc 就把小下拉收起来，免得它留在屏幕上挡事。
  document.addEventListener('click', function (e) {
    var m = $('ipickMenu'); if (!m || m.hidden) return
    var t = e.target
    if (t && t.closest && t.closest('.pickspot')) return
    closePickMenu()
  })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' || e.keyCode === 27) closePickMenu() })
  $('ipath').onkeydown = function (e) { if ((e.key === 'Enter' || e.keyCode === 13) && !installBusy) $('ibtn').click() }
  $('ipath').oninput = refreshSourceKind
  // .tgz / .dshplugin 上传安装：文件选择器、拖放共用同一条路径。
  function installFromFile(f) {
    if (!f || installBusy) return
    if (f.size > 50 * 1024 * 1024) { log('err', '✘ 文件过大（>50MB）'); return }
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
          log('step', '▸ 安装到当前部署的 profile（后端解析，需批准提升权限）…')
          return fetch(API + '/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: d.path, sourceKind: 'file' }) })
            .then(function (r2) { return r2.json() })
            .then(function (i) { renderInstallResult(i); setInstalling(false) })
        })
        .catch(function (e) { log('err', '✘ ' + e.message); setInstalling(false) })
    }
    rd.onerror = function () { log('err', '✘ 读取文件失败'); setInstalling(false) }
    rd.readAsDataURL(f)
  }
  $('ifile').onchange = function () { var f = $('ifile').files[0]; $('ifile').value = ''; installFromFile(f) }
  // 拖放：整块 ① 就是投放区，省掉「点按钮 → 在系统对话框里翻目录」那一步。
  var dropBox = $('viewInst').querySelector('.box')
  var dragDepth = 0
  function dragHasFiles(e) { var t = e.dataTransfer; if (!t || !t.types) return false; for (var i = 0; i < t.types.length; i += 1) { if (t.types[i] === 'Files') return true } return false }
  function setDrop(on) { if (dropBox) dropBox.className = on ? 'box drop' : 'box' }
  if (dropBox) {
    dropBox.addEventListener('dragenter', function (e) { if (!dragHasFiles(e)) return; e.preventDefault(); dragDepth += 1; setDrop(true) })
    dropBox.addEventListener('dragover', function (e) { if (!dragHasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy' } catch (err) { /* 只是光标样式 */ } })
    dropBox.addEventListener('dragleave', function (e) { if (!dragHasFiles(e)) return; dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; setDrop(false) } })
    dropBox.addEventListener('drop', function (e) { dragDepth = 0; setDrop(false); if (!dragHasFiles(e)) return; e.preventDefault(); installFromFile(e.dataTransfer.files && e.dataTransfer.files[0]) })
  }
  // 安装源默认留空：它是一次性动作的目标，把上次填的值一路留在框里（早期还会被塞进
  // 「放置目录」当默认值）只会误导。缓存按宿主进程号作废——dsh 一重启就回到空。
  function resetInstallSourceCacheOnNewBoot(bootId) {
    var id = String(bootId || '')
    if (id === '' || getCache('ipathBoot') === id) return
    setCache('ipath', '')
    setCache('ipathBoot', id)
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
      if (!d.outDir && $('outDir').value === '') $('outDir').value = d.defaultOutDir || ''
      if ($('moutDir').value === '') $('moutDir').value = getCache('moutDir') || d.defaultOutDir || ''
      if (d.defaultOutDir) { if (!getCache('outDir')) setCache('outDir', d.defaultOutDir); if (!getCache('moutDir')) setCache('moutDir', d.defaultOutDir) }
      resetInstallSourceCacheOnNewBoot(d.bootId)
      if ($('ipath').value === '' && getCache('ipath')) $('ipath').value = getCache('ipath')
      refreshSourceKind()
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
        sel.title = pkgs.length ? pkgs.map(function (pk) { return pk.packageId + (pk.packageId === cur ? ' (当前)' : '') }).join('\\n') : ''
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
  // 上一次读到的已装清单：给「一键导出全部」用（DOM 里再翻一遍不如留个引用稳）。
  var instDeps = []
  function elEmpty(text, tag) { var d = document.createElement(tag || 'div'); d.className = 'empty'; d.textContent = text; return d }
  function chip(text, cls) { var t = document.createElement('span'); t.className = 'tag' + (cls ? ' ' + cls : ''); t.textContent = text; return t }
  // 路径来源太长会挤掉插件名，只留尾部（文件名最有用），完整值仍在 title 里。
  function shortSpec(s) {
    var t = String(s || '').replace(/^file:/i, '')
    if (t.length <= 46) return t
    return '…' + t.slice(-45)
  }
  function loadInstalled() {
    // 面板不再让用户选 profile：请求不传，后端按「当前部署」解析并把结果回传（d.profile）。
    var profile = ''
    var ul = $('instList'); var seq = ++instSeq
    var disarmers = []
    function disarmAll() { for (var i = 0; i < disarmers.length; i += 1) disarmers[i]() }
    ul.textContent = ''
    $('instCount').textContent = ''
    $('instProfile').textContent = ''
    var loading = document.createElement('li'); loading.className = 'mitem loading'; loading.textContent = '读取中…'; ul.appendChild(loading)
    fetch(API + '/installed').then(function (r) { return r.json() }).then(function (d) {
      if (seq !== instSeq) return
      profile = String((d && d.profile) || '')
      $('instProfile').textContent = profile === '' ? '' : 'profile: ' + profile
      ul.textContent = ''
      if (d.error) { ul.appendChild(elEmpty('⚠ ' + d.error, 'li')); return }
      var deps = d.dependencies || []
      instDeps = deps
      $('instCount').textContent = String(deps.length)
      if (!deps.length) { ul.appendChild(elEmpty('当前 profile 下没有已安装的 dsh 插件', 'li')); return }
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
          fetch(API + '/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: dep.name }) })
            .then(function (r) { return r.json() }).then(function (x) { log(x.ok ? 'ok' : 'err', (x.ok ? '✔ ' : '✘ ') + (x.ok ? x.note : (x.message || JSON.stringify(x)))); loadInstalled() })
            .catch(function (e) { log('err', '✘ ' + e.message) })
        }
        var exb = document.createElement('button'); exb.className = 'btn'; exb.textContent = '导出'
        exb.disabled = !!dep.isBase
        exb.title = dep.isBase
          ? '基础包由安装目录提供，不在该 profile 的 node_modules 里，无法导出'
          : '导出「' + dep.name + '」：格式取上方下拉，产物落在上方放置目录'
        exb.onclick = function () { exportInstalled([dep.name], dep.name) }
        li.appendChild(main); li.appendChild(exb); li.appendChild(btn)
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
      sel.title = entry.packages.map(function (pk) { return pk.packageId + (pk.packageId === entry.currentPackageId ? ' (当前)' : '') }).join('\\n')
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
    // 2×2：运行 / 常驻 在上，恢复 / 复制 在下。
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
      $('favCount').textContent = String(favs.length)
      var names = favs.map(function (f) { return f.name })
      var unfav = ps.filter(function (p) { return names.indexOf(pname(p)) === -1 })
      if (unfav.length === 0) { ug.appendChild(elEmpty('当前没有未收藏的会话级插件')) }
      else {
        unfav.forEach(function (p) {
          ug.appendChild(buildCard({ isFav: false, pluginId: p.pluginId, packageId: p.currentPackageId, name: pname(p), resident: false, packages: p.packages, currentPackageId: p.currentPackageId, latestRun: p.latestRun }))
        })
      }
      $('unfavCount').textContent = String(unfav.length)
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
  // ── 导出已安装插件：把 profile 里装好的那一份导出成安装包 / 便携包 ──────────
  // 与「打包」页的区别：那边导出的是**会话级动态插件**，这边是**profile 里真实装好**的那一份
  // （读 $DSH_HOME/profiles/<profile>/node_modules/<name>），所以不需要选版本，装的是哪个就导哪个。
  function fmtText(v) { return v === 'portable' ? '便携包' : (v === 'whole' ? '整包（.tgz + 便携包）' : 'dsh 安装包（.tgz）') }
  function exportInstalled(names, label) {
    if (!names.length) { log('err', '✘ 没有可导出的插件（基础包由安装目录提供，不在 profile 的 node_modules 里）'); return }
    var format = $('mfmt').value
    var outDir = $('moutDir').value.trim()
    setCache('moutDir', outDir)
    clearLog()
    log('step', '▸ 导出 ' + label + '（' + fmtText(format) + '，当前部署的 profile）…')
    fetch(API + '/export-installed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: format, outDir: outDir, plugins: names.map(function (n) { return { name: n } }) }) })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (!d || d.ok !== true) { log('err', '✘ ' + ((d && d.message) || '导出失败')); return }
        ;(d.results || []).forEach(function (x) {
          if (!x || x.ok !== true) { log('err', '✘ ' + ((x && x.name) || '') + '：' + ((x && x.message) || '失败')); return }
          var paths = []
          if (x.tgzPath) paths.push(x.tgzPath)
          if (x.portablePath) paths.push(x.portablePath)
          if (paths.length) log('ok', '✔ ' + x.name + ' → ' + paths.join('  +  '))
          else log('warn', '⚠ ' + x.name + '：这次没有产出任何文件')
          // 整包：便携半区做不出来时 tgz 照样给，缺的那半说清楚原因（不整条判失败）。
          if (x.portableError) log('warn', '⚠ ' + x.name + ' 的便携包没导出：' + x.portableError)
        })
      })
      .catch(function (e) { log('err', '✘ 请求失败: ' + e.message) })
  }
  $('mexportAll').onclick = function () {
    // 基础包（由安装目录提供）先在面板侧滤掉：后端也会拒绝，没必要把一次全导出变成一堆红字。
    var names = []
    for (var i = 0; i < instDeps.length; i += 1) if (!instDeps[i].isBase) names.push(instDeps[i].name)
    exportInstalled(names, '全部已安装插件（' + names.length + ' 个）')
  }
  $('mbrowse').onclick = function () { pickInto('moutDir') }
  // 两个页签各管一半：管理与卸载 = profile 已装插件；临时插件 = 会话级动态插件（收藏/卡片）。
  function loadMgmt() { loadInstalled() }
  function loadTemp() { loadCards() }
  $('mrefresh').onclick = loadInstalled
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
// [http/router] HTTP 路由表：请求分发、统一错误处理、各 API 端点
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
      send(res, 200, { ...d, defaultOutDir: (await workspaceRoot(ctx)) + '/packer2-out', activeProfile: await activeProfile(ctx), bootId: HOST_BOOT_ID })
      return
    }
    if (path === '/api/profiles' && req.method === 'GET') {
      // 面板的 profile 输入用它做下拉：列出 $DSH_HOME/profiles 下已有的名字。
      // 手填一个不存在的名字也不算错——dsh plugin --profile <新名> 会自己初始化它。
      try { send(res, 200, await listProfiles(ctx)) } catch (e) { send(res, 200, { ok: false, profiles: [], message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/profile-create' && req.method === 'POST') {
      // 显式新建 profile（面板「新增 profile」）：dsh plugin --profile <新名> list 会把缺失的
      // profile 初始化出来（CLI 帮助原文 initialized on first use），pnpm list 本身只读。
      // 已存在时幂等返回 created:false——面板会先查 /api/profiles，正常不会走到这里。
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await createProfile(ctx, String((body && body.name) || ''))) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/sessions' && req.method === 'GET') {
      // D2：HTTP 请求没有 initiator；多会话并存时把存活会话摊给面板显式选择。
      // resolved = 服务端自动解析链当前的结果（非空说明本次请求其实不必手填）。
      const d = listSessions(ctx)
      send(res, 200, { ...d, resolved: await resolveCurrentSessionId(ctx) })
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
      // 默认完整定义（host + client）；?pureHost=1 退回只导 host 半区（与 /api/export-batch 的 pureHost 对齐）。
      try { const data = sanitizePortable(exportDynamicPlugin(ctx, qs.pluginId, qs.packageId, qs.pureHost === '1' || qs.pureHost === 'true')); sendDownload(res, data.pluginId + '-' + data.packageId + '.dshplugin.json', data) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
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
      // 默认导入即运行（autoRun:false 可关）：旧行为「只注册不运行」正是「导入后不能运行」的来源。
      try { send(res, 200, await importDynamicPlugin(ctx, body, body === null || body.autoRun !== false)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/run' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await runDynamicPlugin(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/install' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      // path 与 source 等价：path 是上传 .tgz 的落盘路径（旧面板），source 是「文件夹 / git 仓库 / npm 包名 / .tgz」安装源。
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
      // 面板不传 profile：交给 installedPlugins 按「当前部署」解析（旧默认值 'web' 会把桌面版指错地方）。
      const profile = String(qs.profile || '')
      try { send(res, 200, await installedPlugins(ctx, profile)) } catch (e) { send(res, 200, { profile, error: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/export-installed' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await exportInstalledBatch(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
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
      // 目录选择交给 DSH 自己的原生选择器（runtime/picker 调 directoryPicker.pick），本插件不再自跑 PowerShell。
      try { await readBody(req) } catch (e) {
        if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return }
      }
      const svc = ctx.get('directoryPicker')
      const cap = (svc !== undefined && typeof svc.capability === 'function') ? svc.capability() : undefined
      if (cap === undefined || cap.kind !== 'native') { send(res, 200, { picked: null, error: '原生目录选择不可用' }); return }
      try { const picked = await pickDirNative(cap); send(res, 200, { picked }) } catch (e) { send(res, 200, { picked: null, error: safeErrorMsg(e) }) }
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
// [plugin] 插件入口：inject 声明、路由注册、index 注入、常驻自恢复
return {
  inject: ['webServer', 'dynamicCordisRunner', 'fs'],
  apply(ctx) {
    // 桌面版（Electron）从 dsh-app:// 直接读盘提供 index.html，不走 webServer.renderIndex()，
    // 所以 tapIndex 在桌面版是静默失效的；结构化 index 行表才是两种模式通用的通道。
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'body', text: buttonScript() })
    })
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/packer2',
      handler: (req, res) => { void handleRequest(ctx, req, res) },
    })
    ctx.effect(() => dispose, 'packer2: ui route')
    autoRestoreResident(ctx).catch(function (err) {
      console.log('packer2 autoRestoreResident 失败: ' + safeErrorMsg(err))
    })
  },
}