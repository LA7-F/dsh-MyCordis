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
