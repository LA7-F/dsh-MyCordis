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
  const policy = outside ? { mode: 'danger-full-access' } : undefined
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
