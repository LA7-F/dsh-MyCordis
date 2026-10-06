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
