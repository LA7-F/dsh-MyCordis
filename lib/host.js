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
// [install/profile] profile 层真实安装/卸载：dsh plugin add/remove、已装清单
// DSH 系统层包：由安装目录提供，任何 profile 都不应卸载（面板与后端双重拦住）。
const PROFILE_BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']
// 本插件自身的包名（package.json name）：禁止自我卸载，否则面板自己先消失。
const SELF_PLUGIN_NAME = 'dsh-mycordis'
async function installBundle(ctx, payload) {
  const path = String(payload && payload.path || '').trim()
  const profile = String(payload && payload.profile || 'web').trim()
  if (!validProfile(profile)) throw new Error('非法的 profile 名称（仅允许字母/数字/-/_）')
  if (!path) throw new Error('缺安装路径')
  const ws = await workspaceRoot(ctx) || ''
  // 暂存目录与清理都在工作区内：显式钉住本工作区为 workspace-write 边界
  // （全局路由下 ctx.sandboxPolicy.resolve() 的根是部署兜底根，不是会话工作区）。
  const wsPolicy = workspaceWritePolicy(ws)
  let target = path
  let tmpDir = null
  if (/\.dshplugin$/i.test(path)) {
    tmpDir = ws.replace(/[\\/]+$/, '') + '/.packer2/install-' + rand()
    await runShell(ctx, 'New-Item -ItemType Directory -Force -Path ' + sq(tmpDir), undefined, wsPolicy)
    target = tmpDir + '/install.tgz'
    await runShell(ctx, 'Copy-Item -Force ' + sq(path) + ' ' + sq(target), undefined, wsPolicy)
  }
  const policy = { mode: 'danger-full-access' }
  const cliPrefix = await resolveDshCli(ctx)
  const quitHint = desktopQuitHint(profile)
  try {
    await runShell(ctx, cliPrefix + ' plugin --profile ' + sq(profile) + ' add ' + sq(target), ws, policy, 300000)
    if (tmpDir) { try { await runShell(ctx, 'Remove-Item -Recurse -Force ' + sq(tmpDir), undefined, wsPolicy) } catch (e) { /* best effort */ } }
    return { ok: true, path, profile, note: '已执行 dsh plugin add；重启 dsh 后生效（profile: ' + profile + '）' + quitHint }
  } catch (error) {
    if (tmpDir) { try { await runShell(ctx, 'Remove-Item -Recurse -Force ' + sq(tmpDir), undefined, wsPolicy) } catch (e) { /* best effort */ } }
    const msg = String(error && error.message ? error.message : error)
    throw new Error('安装失败：' + msg + quitHint + '（安装会写入 $DSH_HOME/profiles/' + profile + '，需要提升沙箱权限，请在弹窗中批准；若报 INVALID_DEPENDENCY_NAME，请用「安装 dsh 包」选 .tgz 文件而非中文名目录）')
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
async function installedPlugins(ctx, profile) {
  if (!validProfile(profile)) return { profile, error: '非法的 profile 名称（仅允许字母/数字/-/_）' }
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
async function uninstallBundle(ctx, payload) {
  const name = String(payload && payload.name || '').trim()
  const profile = String(payload && payload.profile || 'web').trim()
  if (!validProfile(profile)) throw new Error('非法的 profile 名称（仅允许字母/数字/-/_）')
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
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:8px}
.card{height:152px;max-width:300px;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);padding:8px;display:flex;flex-direction:column;gap:5px;position:relative;min-width:0;overflow:hidden;transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:var(--accent-line);box-shadow:var(--shadow)}
.card .star{position:absolute;top:4px;right:4px;width:22px;height:22px;background:none;border:none;border-radius:6px;cursor:pointer;font-size:14px;line-height:1;color:#d4a017;padding:0}
.card .star:hover{background:var(--panel3)}
.card .cname{font-weight:600;font-size:11.5px;line-height:1.3;padding-right:20px;height:30px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;flex:none}
.card .cid{font-family:var(--mono);font-size:9.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
.card select{width:100%;height:24px;font-size:10.5px;flex:none}
.card .cactions{display:grid;grid-template-columns:1fr 1fr;gap:4px;flex:none}
.card .cactions button{min-width:0;height:24px;padding:0 3px;border:1px solid var(--line);border-radius:var(--r3);background:var(--panel2);color:var(--fg2);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.card .cactions button:hover:not(:disabled){border-color:var(--muted);color:var(--fg)}
.card .cactions button:disabled{opacity:.4;cursor:not-allowed}
.card .cactions .resbtn.on{background:var(--accent-weak);border-color:var(--accent-line);color:var(--accent);font-weight:600}
.card .cactions .runbtn{background:var(--ok-weak);border-color:var(--ok-line);color:var(--ok);font-weight:600}
.card .cactions .runbtn:hover:not(:disabled){border-color:var(--ok);color:var(--ok)}
.card .copybtn{flex:none;height:24px;padding:0 4px;border:1px solid var(--line);border-radius:var(--r3);background:var(--panel2);color:var(--fg2);font:inherit;font-size:10.5px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.card .copybtn:hover{border-color:var(--muted);color:var(--fg)}
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
      <div class="desc">来自「安装 → 导入便携包」的 .dshplugin.json：只在当前进程内注册，重启 dsh 即消失；常驻/收藏才会跨重启保留。☆ 收藏（仅显示卡片，不自动运行）/ 常驻（收藏 + 重启自动运行）/ 恢复（启动）/ 复制信息 / 同名合并版本。<br>token：运行<b>默认走零唤醒通道</b>（runHostHalf(requestId=null)，面板手势）——host 半静默启动，<b>不唤醒任何会话轮次</b>；带 client 半区的包停在「待页面装入」，去 DSH 侧边栏的 Cordis 面板点「运行」装入本页（settleUserRun → agent.inject，只注入一条上下文、不唤醒）。只有勾选「允许唤醒会话」才会退回会 agent.steer 的旧通道。</div>
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
    var copy = document.createElement('button'); copy.className = 'copybtn'; copy.textContent = '复制信息'; copy.title = '导出定义文件并复制路径，供新会话 AI 直接 read（省 token）'
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
    // 2×2：运行 / 常驻 在上，恢复 / 复制信息 在下。
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
      send(res, 200, { ...d, defaultOutDir: (await workspaceRoot(ctx)) + '/packer2-out', activeProfile: await activeProfile(ctx) })
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