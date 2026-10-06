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
