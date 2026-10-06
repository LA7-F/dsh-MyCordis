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
