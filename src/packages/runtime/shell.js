// [runtime/shell] shell 服务封装、跨平台目录助手与存在性探测
async function runShell(ctx, command, workdir, policy, timeoutMs) {
  const shell = ctx.get('shell')
  if (shell === undefined) throw new Error('shell 服务不可用')
  const spec = shell.resolve({ command, workdir, timeoutMs: timeoutMs || 120000, ...(policy === undefined ? {} : { sandboxPolicy: policy }) })
  const result = await (await shell.execute(spec)).result()
  if (result.exitCode !== 0) {
    const out = (result.stdout && result.stdout.text) || ''
    const errText = (result.stderr && result.stderr.text) || ''
    throw new Error('命令退出码 ' + result.exitCode + (errText ? '：' + errText.slice(0, 500) : '') + (out ? '\n' + out.slice(0, 500) : ''))
  }
  return result
}
// ── 跨平台目录助手 ──────────────────────────────────────────────────────────
// 「便携包」以前一律用 pwsh 的 New-Item/Remove-Item 建目录/清理，非 Windows 上直接失败。
// 这两个助手按宿主平台出命令，调用方只管给路径与策略。
async function ensureDir(ctx, dir, policy) {
  const fs = ctx.get('fs')
  if (fs !== undefined && typeof fs.stat === 'function' && typeof fs.resolve === 'function') {
    try {
      const info = await fs.stat(await fs.resolve(dir))
      if (info && info.type === 'directory') return
    } catch (e) { /* 不存在（或后端不支持 stat）：继续走 shell 创建 */ }
  }
  const cmd = isWindowsHost()
    ? 'New-Item -ItemType Directory -Force -Path ' + sq(dir)
    : 'mkdir -p ' + sq(dir)
  await runShell(ctx, cmd, undefined, policy)
}
async function removeTree(ctx, dir, policy) {
  // 仅用于清理自己刚建的暂存目录：幂等、尽力而为，调用方自行 catch。
  const cmd = isWindowsHost()
    ? 'Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ' + sq(dir)
    : 'rm -rf ' + sq(dir)
  await runShell(ctx, cmd, undefined, policy)
}
// ── B2/B3：dsh CLI 与 pnpm 定位 ────────────────────────────────────────────────
// 正式版桌面把 CLI/pnpm 放在 Electron 的 resources 下，工作区通常不是 DSH 源码仓库，
// 所以不再硬编码 <工作区>/apps/cli/lib/bin.js，改为按序探测并返回可拼进 shell 的命令前缀。
async function probePathExists(ctx, p) {
  // 两种形态都要能跑：shell 的存在性探测与 fs 服务都试，任一命中即视为存在。
  const sh = ctx.get('shell')
  if (sh !== undefined) {
    try {
      const cmd = isWindowsHost()
        ? 'if (Test-Path -LiteralPath ' + sq(p) + ') { Write-Output "EXISTS" }'
        : 'test -e ' + sq(p) + ' && printf EXISTS'
      const spec = sh.resolve({ command: cmd, timeoutMs: 30000 })
      const r = await (await sh.execute(spec)).result()
      const probeOut = String((r.stdout && r.stdout.text) || '')
      if (probeOut.indexOf('EXISTS') !== -1 || /(^|\W)True(\W|$)/.test(probeOut)) return true
    } catch (e) { /* 落回 fs 探测 */ }
  }
  const fsSvc = ctx.get('fs')
  if (fsSvc !== undefined && typeof fsSvc.resolve === 'function' && typeof fsSvc.readText === 'function') {
    try { await fsSvc.readText(await fsSvc.resolve(p)); return true } catch (e) { return false }
  }
  return false
}
async function probeAsarExists(ctx, asarPath) {
  // 实测：PowerShell 的 Test-Path 看不见 asar 内部（对 asar 里的 cli.js 恒为 False，文件其实存在），
  // 所以只对 app.asar 文件本身做存在性探测，命中后无条件拼出内部路径。
  const sh = ctx.get('shell')
  if (sh !== undefined) {
    try {
      const cmd = isWindowsHost()
        ? 'if (Test-Path -LiteralPath ' + sq(asarPath) + ') { Write-Output "EXISTS" }'
        : 'test -e ' + sq(asarPath) + ' && printf EXISTS'
      const spec = sh.resolve({ command: cmd, timeoutMs: 30000 })
      const r = await (await sh.execute(spec)).result()
      const probeOut = String((r.stdout && r.stdout.text) || '')
      return probeOut.indexOf('EXISTS') !== -1 || /(^|\W)True(\W|$)/.test(probeOut)
    } catch (e) { return true /* 探测失败不阻塞：resourcesPath 来自运行中的 Electron */ }
  }
  return true /* 无 shell 可探测：resourcesPath 来自运行中的 Electron，按存在处理 */
}
async function probeOnPath(ctx, name) {
  const sh = ctx.get('shell')
  if (sh === undefined) return ''
  try {
    const cmd = isWindowsHost()
      ? '$c = Get-Command ' + name + ' -ErrorAction SilentlyContinue; if ($c) { Write-Output $c.Source }'
      : 'command -v ' + name + ' 2>/dev/null'
    const spec = sh.resolve({ command: cmd, timeoutMs: 30000 })
    const r = await (await sh.execute(spec)).result()
    const out = String((r.stdout && r.stdout.text) || '').trim()
    return out === '' ? '' : out.split(/\r?\n/)[0].trim()
  } catch (e) { return '' }
}
