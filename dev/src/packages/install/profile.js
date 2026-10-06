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
