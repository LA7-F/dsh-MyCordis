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
