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
