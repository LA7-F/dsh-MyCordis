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
