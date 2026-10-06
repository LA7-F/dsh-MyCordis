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
