// [runtime/cli] dsh CLI 与 pnpm 的可执行入口定位（桌面版 resources / 工作区 / PATH，跨平台）
function desktopQuitHint(profile) {
  // 官方 requireDesktopProfile：运行 dsh plugin --profile desktop 前必须先完全退出桌面版。
  // 实测桌面版运行期间会报 EPERM: operation not permitted, open '…\profiles\desktop\package.json.lock'。
  return profile === 'desktop' ? "（注意：profile=desktop 必须先完全退出 DeepSeek Harness 桌面版再执行；桌面版运行期间会报 EPERM: operation not permitted, open '…\\profiles\\desktop\\package.json.lock'，完全退出后重试即可）" : ''
}
// 把「一个路径当命令跑」写成平台正确的形状：pwsh 需要调用运算符 &，POSIX 直接给路径。
function shellCallPrefix(p) {
  return isWindowsHost() ? '& ' + sq(p) : sq(p)
}
// 用 Electron 可执行文件跑一个 .mjs 脚本（内置 pnpm / 桌面版 CLI）：ELECTRON_RUN_AS_NODE 的环境变量
// 写法在 pwsh 与 sh 下不同，这里收口成一处。
function electronRunAsNodePrefix(runnerToken, script) {
  const tail = runnerToken + ' --expose-internals ' + sq(script)
  return isWindowsHost() ? "$env:ELECTRON_RUN_AS_NODE='1'; & " + tail : 'ELECTRON_RUN_AS_NODE=1 ' + tail
}
async function resolveDshCli(ctx) {
  // 候选列表一律用「路径形状」占位符：handleRequest 返回前会过 safeErrorMsg，
  // 绝对路径会被脱敏成 <路径>，只有形状能存活下来告诉用户该去哪里找 CLI。
  const tried = []
  const ws = (await workspaceRoot(ctx)) || ''
  if (ws !== '') {
    const srcCli = ws.replace(/[\\/]+$/, '') + '/apps/cli/lib/bin.js'
    tried.push('<工作区>/apps/cli/lib/bin.js')
    if (await probePathExists(ctx, srcCli)) return 'node ' + sq(srcCli)
  } else {
    tried.push('<工作区>/apps/cli/lib/bin.js（工作区根目录未知，未探测）')
  }
  const proc = typeof process === 'undefined' ? undefined : process
  const resourcesPath = (proc && typeof proc.resourcesPath === 'string' && proc.resourcesPath !== '') ? proc.resourcesPath.replace(/[\\/]+$/, '') : ''
  if (resourcesPath !== '') {
    // Windows 桌面版给的是 dsh.cmd；POSIX 安装给的是无扩展名的 dsh 垫片。
    const cliName = isWindowsHost() ? 'dsh.cmd' : 'dsh'
    const shim = resourcesPath + '/runtime/cli/bin/' + cliName
    tried.push('<resourcesPath>/runtime/cli/bin/' + cliName)
    if (await probePathExists(ctx, shim)) return shellCallPrefix(shim)
    const asarPath = resourcesPath + '/app.asar'
    const desktopCli = asarPath + '/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
    tried.push('<resourcesPath>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
    if (await probeAsarExists(ctx, asarPath)) {
      const execPath = (proc && typeof proc.execPath === 'string' && proc.execPath !== '') ? proc.execPath : ''
      if (execPath !== '') return electronRunAsNodePrefix(sq(execPath), desktopCli)
      tried.push('process.execPath（不可用，未能构造桌面 CLI 命令）')
    }
  } else {
    tried.push('<resourcesPath>/runtime/cli/bin/dsh.cmd（process/resourcesPath 不可用，未探测）')
    tried.push('<resourcesPath>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js（同上，未探测）')
  }
  const onPath = await probeOnPath(ctx, 'dsh')
  if (onPath !== '') return shellCallPrefix(onPath)
  tried.push('PATH 上的 dsh（Get-Command/command -v 无结果）')
  throw new Error('未找到可用的 dsh CLI（安装/卸载需要它）。已探测候选：' + tried.join('；') + '。可改用桌面版安装目录 resources/runtime/cli/bin 下的 dsh 垫片，或让 DSH 源码仓库工作区提供 apps/cli/lib/bin.js。')
}
async function resolvePnpm(ctx, wsHint) {
  const tried = []
  const proc = typeof process === 'undefined' ? undefined : process
  const resourcesPath = (proc && typeof proc.resourcesPath === 'string' && proc.resourcesPath !== '') ? proc.resourcesPath.replace(/[\\/]+$/, '') : ''
  if (resourcesPath !== '') {
    const pnpmMjs = resourcesPath + '/runtime/pnpm/bin/pnpm.mjs'
    tried.push('<resourcesPath>/runtime/pnpm/bin/pnpm.mjs')
    if (await probePathExists(ctx, pnpmMjs)) {
      const execPath = (proc && typeof proc.execPath === 'string' && proc.execPath !== '') ? proc.execPath : ''
      const runner = execPath !== ''
        ? sq(execPath)
        : (isWindowsHost() ? '"$env:DSH_DESKTOP_NODE_EXECUTABLE"' : '"$DSH_DESKTOP_NODE_EXECUTABLE"')
      return electronRunAsNodePrefix(runner, pnpmMjs)
    }
  } else {
    tried.push('<resourcesPath>/runtime/pnpm/bin/pnpm.mjs（process/resourcesPath 不可用，未探测）')
  }
  const ws = (wsHint !== undefined && wsHint !== '') ? String(wsHint) : ((await workspaceRoot(ctx)) || '')
  if (ws !== '') {
    const wsBase = ws.replace(/[\\/]+$/, '')
    const binShim = wsBase + '/node_modules/.bin/pnpm'
    const binCjs = wsBase + '/node_modules/pnpm/bin/pnpm.cjs'
    tried.push('<工作区>/node_modules/.bin/pnpm', '<工作区>/node_modules/pnpm/bin/pnpm.cjs')
    if (await probePathExists(ctx, binShim)) return shellCallPrefix(binShim)
    if (await probePathExists(ctx, binCjs)) return shellCallPrefix(binCjs)
  } else {
    tried.push('<工作区>/node_modules/.bin/pnpm、<工作区>/node_modules/pnpm/bin/pnpm.cjs（工作区根目录未知，未探测）')
  }
  const onPath = await probeOnPath(ctx, 'pnpm')
  if (onPath !== '') return shellCallPrefix(onPath)
  tried.push('PATH 上的 pnpm（Get-Command/command -v 无结果）')
  throw new Error('未找到可用的 pnpm（打包需要它）。已探测候选：' + tried.join('；') + '。桌面版自带 <resourcesPath>/runtime/pnpm/bin/pnpm.mjs，请确认安装完整。')
}
