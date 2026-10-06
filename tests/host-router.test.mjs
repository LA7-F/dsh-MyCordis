// tests/host-router.test.mjs —— MyCordis host 半区回归测试（零依赖，node:assert + 自写 mini runner）
// 面向 ADAPTATION.md 的「目标语义」断言，而不是迁就当前有 bug 的实现。
// 运行： node mycordis-v2/tests/host-router.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadPlugin, loadCoreInternals, makeCtx, startServer, rawRequest, postOversized,
  hasFunction, silenceConsole, tempDir, makeShellStub, makeFsStub,
} from './_harness.mjs'

const write = (s) => process.stdout.write(s + '\n')
const restoreConsole = silenceConsole()

let passed = 0
let failed = 0
let skipped = 0
const failures = []
const pendingFailures = []

function test(name, fn, opts = {}) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') throw new Error('同步用例里返回了 Promise，请用 testAsync')
    passed += 1
    write('  ok   ' + name)
  } catch (e) {
    failed += 1
    const msg = (e && e.message ? e.message : String(e)).split('\n')[0]
    failures.push([name, msg])
    if (opts.pending) {
      pendingFailures.push(name)
      write('  FAIL ' + name + '  -> ' + msg + '   [预期：B1/B2/B3 改造后转绿]')
    } else {
      write('  FAIL ' + name + '  -> ' + msg)
    }
  }
}
async function testAsync(name, fn, opts = {}) {
  try {
    await fn()
    passed += 1
    write('  ok   ' + name)
  } catch (e) {
    failed += 1
    const msg = (e && e.message ? e.message : String(e)).split('\n')[0]
    failures.push([name, msg])
    if (opts.pending) {
      pendingFailures.push(name)
      write('  FAIL ' + name + '  -> ' + msg + '   [预期：B1/B2/B3 改造后转绿]')
    } else {
      write('  FAIL ' + name + '  -> ' + msg)
    }
  }
}
function skip(name, why) {
  skipped += 1
  write('  SKIP ' + name + '  -> ' + why)
}
const section = (t) => write('\n' + t)

// ── [0] 插件结构 ──────────────────────────────────────────────────────────
section('[0] 功能分包拼接加载与插件结构')
const plugin = await loadPlugin()
test('功能分包拼接可作为 async 函数体求值，返回对象', () => assert.equal(typeof plugin, 'object'))
test('inject 含 webServer', () => assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('webServer'), 'inject=' + JSON.stringify(plugin.inject)))
test('apply 是函数', () => assert.equal(typeof plugin.apply, 'function'))

// ── [1] 信任栅栏矩阵（ADAPTATION.md 第 3 节，13 行）────────────────────────
section('[1] 信任栅栏矩阵（目标语义：Origin 缺失即放行，其余防护一条不减）')
const core = await loadCoreInternals()
assert.equal(typeof core.isTrustedRequest, 'function', 'base/security 里找不到 isTrustedRequest')
const PORT = process.env.DSH_PORT || '19387'
const SAME_ORIGIN = 'http://127.0.0.1:' + PORT
const req = (headers, extra) => Object.assign({ method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' } }, extra)

// 1–3 桌面代理（Origin 与 sec-fetch-site 均被 forwardWebRequest 删除）
test('无 Origin + POST + 无 sec-fetch-site -> true', () => assert.equal(core.isTrustedRequest(req({ host: '127.0.0.1:' + PORT }, { method: 'POST' })), true), { pending: true })
test('无 Origin + DELETE -> true', () => assert.equal(core.isTrustedRequest(req({ host: '127.0.0.1:' + PORT }, { method: 'DELETE' })), true), { pending: true })
test('无 Origin + GET -> true', () => assert.equal(core.isTrustedRequest(req({ host: '127.0.0.1:' + PORT })), true))
// 4–6 Origin 存在时的同源比对
test("Origin dsh-app://app + POST -> false", () => assert.equal(core.isTrustedRequest(req({ host: '127.0.0.1:' + PORT, origin: 'dsh-app://app' }, { method: 'POST' })), false))
test('同源 ' + SAME_ORIGIN + ' + POST -> true', () => assert.equal(core.isTrustedRequest(req({ host: '127.0.0.1:' + PORT, origin: SAME_ORIGIN }, { method: 'POST' })), true))
test('跨站 https://evil.example + POST -> false', () => assert.equal(core.isTrustedRequest(req({ host: '127.0.0.1:' + PORT, origin: 'https://evil.example' }, { method: 'POST' })), false))
// 7–9
test('sec-fetch-site: cross-site 且无 Origin + GET -> false', () => assert.equal(core.isTrustedRequest(req({ host: '127.0.0.1:' + PORT, 'sec-fetch-site': 'cross-site' })), false))
test('Origin 字符串 null + POST -> false', () => assert.equal(core.isTrustedRequest(req({ host: '127.0.0.1:' + PORT, origin: 'null' }, { method: 'POST' })), false))
test('同主机不同端口 Origin -> false', () => assert.equal(core.isTrustedRequest(req({ host: '127.0.0.1:' + PORT, origin: 'http://127.0.0.1:' + PORT + '1' }, { method: 'POST' })), false))
// 10–13 DNS rebinding / 非 loopback 防御（放宽 Origin 后仍必须成立）
test('Host evil.example:<port> -> false', () => assert.equal(core.isTrustedRequest(req({ host: 'evil.example:' + PORT }, { method: 'POST' })), false))
test('Host 局域网 IP -> false', () => assert.equal(core.isTrustedRequest(req({ host: '192.168.1.10:' + PORT }, { method: 'POST' })), false))
test('socket 远端 10.0.0.5 -> false', () => assert.equal(core.isTrustedRequest({ method: 'POST', headers: { host: '127.0.0.1:' + PORT }, socket: { remoteAddress: '10.0.0.5' } }), false))
test('缺 Host 头 -> false', () => assert.equal(core.isTrustedRequest(req({}, { method: 'POST' })), false))

// ── [2] 路由矩阵 ─────────────────────────────────────────────────────────
section('[2] 路由矩阵（经真实 node:http 服务器打插件注册的 handler）')
const runnerRows = [{
  pluginId: 'p1', agentId: 'session-test', currentPackageId: 'pk1', name: 'MyPlugin',
  packages: [{ packageId: 'pk1', name: 'MyPlugin', hasHostHalf: true, hasClientHalf: false }],
}]
const ctx = makeCtx({ runnerRows })
plugin.apply(ctx)
test('apply 注册了一个 prefix 路由 /packer2', () => {
  assert.equal(ctx.registeredRoutes.length, 1)
  assert.equal(ctx.registeredRoutes[0].kind, 'prefix')
  assert.equal(ctx.registeredRoutes[0].path, '/packer2')
  assert.equal(typeof ctx.handler, 'function')
})
test('webserver/index-inject 注入 script 行且含「我的Cordis」', () => {
  const table = []
  const n = ctx.emit('webserver/index-inject', table)
  assert.ok(n >= 1, '没有 index-inject 订阅者')
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script')
  assert.ok(String(table[0].text).includes('我的Cordis'), '注入脚本不含我的Cordis')
})
const srv = await startServer(ctx.handler)
const H = { origin: srv.url } // 浏览器同源写请求（先隔离 B1，单独用探针验证无 Origin）

await testAsync('GET /packer2 -> 200 HTML 含「我的Cordis」', async () => {
  const r = await rawRequest(srv.url, '/packer2')
  assert.equal(r.status, 200)
  assert.match(String(r.headers['content-type']), /text\/html/)
  assert.ok(r.text.includes('我的Cordis'), 'HTML 不含我的Cordis')
})
await testAsync('GET /packer2 -> 四个同级页签，临时插件卡片独立成 viewTemp，不再混在 viewMgmt', async () => {
  const r = await rawRequest(srv.url, '/packer2')
  assert.equal(r.status, 200)
  for (const id of ['tabPack', 'tabInst', 'tabTemp', 'tabMgmt']) assert.ok(r.text.includes('id="' + id + '"'), '缺页签 ' + id)
  const iMgmt = r.text.indexOf('id="viewMgmt"')
  const iTemp = r.text.indexOf('id="viewTemp"')
  const iLog = r.text.indexOf('<pre id="log">')
  assert.ok(iMgmt > 0 && iTemp > iMgmt && iLog > iTemp, 'viewMgmt/viewTemp/log 顺序不对')
  const mgmt = r.text.slice(iMgmt, iTemp)
  const temp = r.text.slice(iTemp, iLog)
  assert.ok(mgmt.includes('id="instList"'), 'viewMgmt 应有已装插件列表')
  assert.ok(!mgmt.includes('id="favCards"'), 'viewMgmt 不该再放临时插件卡片')
  assert.ok(temp.includes('id="favCards"') && temp.includes('id="unfavCards"'), 'viewTemp 应有已收藏/未收藏卡片容器')
  assert.ok(temp.includes('id="frestore"') && temp.includes('id="dedupe"'), 'viewTemp 应有恢复收藏/去重按钮')
  assert.ok(temp.includes('id="wakeok"'), 'viewTemp 应有「允许唤醒会话（应急）」开关（零唤醒是默认）')
  assert.ok(temp.includes('零唤醒'), '临时插件页应讲清默认零唤醒通道')
  assert.ok(r.text.includes("'client-pending': '待页面装入'"), 'runStatusText 应把 client-pending 译成「待页面装入」')
  assert.ok(r.text.includes('grid-template-columns:1fr 1fr'), '卡片按钮应为 2×2 网格')
  assert.ok(r.text.includes('actions.appendChild(rest); actions.appendChild(copy)'), '复制信息应并入 cactions 网格')
  assert.ok(r.text.includes("switchTab('temp')") && r.text.includes("function loadTemp()"), '页签切换未接上 temp')
})
await testAsync('GET /packer2/api/plugins -> 200 {available,plugins,defaultOutDir}', async () => {
  const r = await rawRequest(srv.url, '/packer2/api/plugins')
  assert.equal(r.status, 200)
  assert.equal(r.json.available, true)
  assert.ok(Array.isArray(r.json.plugins))
  assert.equal(r.json.plugins[0].pluginId, 'p1')
  assert.equal(typeof r.json.defaultOutDir, 'string')
})
await testAsync('GET /packer2/api/installed?profile=x -> 200 {profile,dependencies[]}', async () => {
  const r = await rawRequest(srv.url, '/packer2/api/installed?profile=x')
  assert.equal(r.status, 200)
  assert.equal(r.json.profile, 'x')
  assert.ok(Array.isArray(r.json.dependencies), '缺少 dependencies 数组: ' + JSON.stringify(r.json))
  const dep = r.json.dependencies.find((d) => d.name === 'dsh-mycordis')
  assert.ok(dep, '夹具依赖 dsh-mycordis 未出现')
  assert.equal(dep.isBundle, true)
  assert.equal(dep.isBase, false)
})
await testAsync('GET /packer2/api/browse -> 200 {kind:"native"}', async () => {
  const r = await rawRequest(srv.url, '/packer2/api/browse')
  assert.equal(r.status, 200)
  assert.equal(r.json.kind, 'native')
})
await testAsync('GET /packer2/api/favorites -> 200 {ok:true,favorites:[]}', async () => {
  const r = await rawRequest(srv.url, '/packer2/api/favorites')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(Array.isArray(r.json.favorites))
})
await testAsync('未知路径 GET /packer2/api/does-not-exist -> 404', async () => {
  const r = await rawRequest(srv.url, '/packer2/api/does-not-exist')
  assert.equal(r.status, 404)
})
await testAsync('未知路径 GET /packer2/nope -> 404', async () => {
  const r = await rawRequest(srv.url, '/packer2/nope')
  assert.equal(r.status, 404)
})
// B1 关键验收：桌面代理删掉 Origin 后，探针必须越过栅栏到达路由（404），而不是 403
await testAsync('POST /packer2/__probe__ 无 Origin -> 404（不是 403）', async () => {
  const r = await rawRequest(srv.url, '/packer2/__probe__', { method: 'POST' })
  assert.notEqual(r.status, 403, '被信任栅栏拒绝（B1 未修复）')
  assert.equal(r.status, 404)
}, { pending: true })
await testAsync('POST /packer2/__probe__ 同源 Origin -> 404', async () => {
  const r = await rawRequest(srv.url, '/packer2/__probe__', { method: 'POST', headers: { origin: srv.url } })
  assert.equal(r.status, 404)
})

// ── [2b] 打包页「浏览…」：目录选择调用 DSH 自己的 directoryPicker ──────────
section('[2b] 浏览按钮走 DSH 原生目录选择器（不再自跑 PowerShell + WinForms）')
const pickSignals = []
const capCalls = []
const pickCtx = makeCtx({
  services: {
    directoryPicker: {
      capability: () => { capCalls.push(1); return { kind: 'native', pick: (signal) => { pickSignals.push(signal); return Promise.resolve('C:\\picked\\dir') } } },
    },
  },
})
plugin.apply(pickCtx)
const pickSrv = await startServer(pickCtx.handler)
await testAsync('POST /api/browse/pick -> {picked}，capability()/pick() 各恰好一次', async () => {
  const r = await rawRequest(pickSrv.url, '/packer2/api/browse/pick', { method: 'POST', headers: { origin: pickSrv.url }, body: { start: 'C:\\ignored' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.picked, 'C:\\picked\\dir', JSON.stringify(r.json))
  assert.equal(capCalls.length, 1, 'capability() 应恰好调用一次')
  assert.equal(pickSignals.length, 1, 'pick() 应恰好调用一次')
  assert.ok(pickSignals[0] instanceof AbortSignal, 'pick(signal) 应收到 AbortSignal')
})
test('选目录全程不执行 shell 命令（旧实现会写 .packer2/pick-dir.ps1 再跑 powershell）', () => {
  assert.equal(pickCtx.shellCommands.length, 0, JSON.stringify(pickCtx.shellCommands))
})
await testAsync('browse 后端（远程部署无原生选择器）-> {picked:null, error:...不可用}', async () => {
  const browseCtx = makeCtx({ services: { directoryPicker: { capability: () => ({ kind: 'browse' }) } } })
  plugin.apply(browseCtx)
  const browseSrv = await startServer(browseCtx.handler)
  try {
    const r = await rawRequest(browseSrv.url, '/packer2/api/browse/pick', { method: 'POST', headers: { origin: browseSrv.url }, body: {} })
    assert.equal(r.status, 200)
    assert.equal(r.json.picked, null)
    assert.match(String(r.json.error), /不可用/)
    assert.equal(browseCtx.shellCommands.length, 0)
  } finally { await browseSrv.close() }
})
await pickSrv.close()

// ── [3] 请求体 ───────────────────────────────────────────────────────────
section('[3] 请求体：非法 JSON -> 400；超大 body -> 413')
await testAsync('POST /api/snapshot 非法 JSON -> 400', async () => {
  const r = await rawRequest(srv.url, '/packer2/api/snapshot', { method: 'POST', headers: H, body: '{ 这不是 JSON' })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
})
await testAsync('POST /api/snapshot 超大 body (>80MB) -> 413', async () => {
  const bytes = 80 * 1024 * 1024 + 1024
  const r = await postOversized(srv.port, '/packer2/api/snapshot', { ...H, 'content-type': 'application/json' }, bytes)
  assert.equal(r.status, 413, '实际 ' + JSON.stringify(r))
})

// ── [4] 收藏 round-trip（fs 桩落到 os.tmpdir() 下的临时工作区）─────────────
section('[4] 收藏 round-trip：add -> resident -> remove -> GET /api/favorites')
const favCtx = makeCtx({ runnerRows })
plugin.apply(favCtx)
const favSrv = await startServer(favCtx.handler)
const FH = { origin: favSrv.url }
const favPath = join(favCtx.workspaceRoot, 'packer2-favorites.json')

await testAsync('POST /api/favorite add -> ok,count=1，磁盘出现 packer2-favorites.json', async () => {
  const r = await rawRequest(favSrv.url, '/packer2/api/favorite', { method: 'POST', headers: FH, body: { action: 'add', pluginId: 'p1', packageId: 'pk1' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true, JSON.stringify(r.json))
  assert.equal(r.json.count, 1)
  assert.ok(existsSync(favPath), '收藏文件未落盘: ' + favPath)
})
await testAsync('GET /api/favorites -> 1 条，resident=false', async () => {
  const r = await rawRequest(favSrv.url, '/packer2/api/favorites')
  assert.equal(r.json.favorites.length, 1)
  assert.equal(r.json.favorites[0].pluginId, 'p1')
  assert.equal(r.json.favorites[0].name, 'MyPlugin')
  assert.equal(r.json.favorites[0].resident, false)
})
await testAsync('POST /api/favorite resident -> ok,count=1', async () => {
  const r = await rawRequest(favSrv.url, '/packer2/api/favorite', { method: 'POST', headers: FH, body: { action: 'resident', pluginId: 'p1', packageId: 'pk1', resident: true } })
  assert.equal(r.json.ok, true, JSON.stringify(r.json))
  assert.equal(r.json.count, 1)
})
await testAsync('GET /api/favorites -> resident=true', async () => {
  const r = await rawRequest(favSrv.url, '/packer2/api/favorites')
  assert.equal(r.json.favorites.length, 1)
  assert.equal(r.json.favorites[0].resident, true)
})
await testAsync('POST /api/favorite remove -> ok,count=0', async () => {
  const r = await rawRequest(favSrv.url, '/packer2/api/favorite', { method: 'POST', headers: FH, body: { action: 'remove', pluginId: 'p1' } })
  assert.equal(r.json.ok, true, JSON.stringify(r.json))
  assert.equal(r.json.count, 0)
})
await testAsync('GET /api/favorites -> 0 条', async () => {
  const r = await rawRequest(favSrv.url, '/packer2/api/favorites')
  assert.equal(r.json.favorites.length, 0)
  const onDisk = JSON.parse(readFileSync(favPath, 'utf8'))
  assert.equal(onDisk.favorites.length, 0)
})

// ── [5] 安装链路命令构造（B2）────────────────────────────────────────────
section('[5] 安装链路：resolveDshCli 命中候选与命令行构造')
if (!hasFunction('resolveDshCli')) {
  skip(
    '安装链路（候选命中 / plugin --profile add / 不拼 apps/cli/lib/bin.js）',
    'src 尚无 resolveDshCli（B2 未落地）。落地后本段自动启用：工作区放 apps/cli/lib/bin.js 时应命中它；没有时应改走桌面/PATH 候选或抛清晰错误。',
  )
} else {
  const installRunnerRows = [{ pluginId: 'p1', agentId: 'session-test', name: 'MyPlugin', packages: [] }]

  // A. 工作区里真的有 apps/cli/lib/bin.js -> 应命中，命令形如 node "<abs>" plugin --profile desktop add "<tgz>"
  await testAsync('有 apps/cli/lib/bin.js 时：命令含 plugin --profile 与 add，并指向该 bin.js', async () => {
    const wsA = tempDir('mycordis-cli-a-')
    const binA = join(wsA, 'apps', 'cli', 'lib', 'bin.js')
    mkdirSync(join(wsA, 'apps', 'cli', 'lib'), { recursive: true })
    writeFileSync(binA, '// fake dsh cli\n', 'utf8')
    const ctxA = makeCtx({ workspaceRoot: wsA, runnerRows: installRunnerRows })
    plugin.apply(ctxA)
    const srvA = await startServer(ctxA.handler)
    try {
      const r = await rawRequest(srvA.url, '/packer2/api/install', { method: 'POST', headers: { origin: srvA.url }, body: { path: 'C:\\fake\\bundle.tgz', profile: 'desktop' } })
      assert.equal(r.status, 200)
      const cmds = ctxA.shellCommands.map((c) => c.command)
      const install = cmds.find((c) => /plugin --profile/.test(c) && / add /.test(c))
      assert.ok(install, '没有构造出 plugin --profile ... add 命令；实际命令: ' + JSON.stringify(cmds))
      assert.ok(install.includes('apps') && install.includes('bin.js'), '未命中工作区 apps/cli/lib/bin.js: ' + install)
    } finally { await srvA.close() }
  })

  // B. 工作区没有 apps/cli -> 绝不能「执行」<ws>/apps/cli/lib/bin.js（这正是 B2 的 bug）
  // 注意：把它当作候选路径去 Test-Path 探测是允许且必要的，禁止的是把它拼进实际执行的命令。
  await testAsync('无 apps/cli 时：不执行 apps/cli/lib/bin.js，且失败时列出已探测候选', async () => {
    const wsB = tempDir('mycordis-cli-b-') // 刻意不创建 apps/cli
    const ctxB = makeCtx({ workspaceRoot: wsB, runnerRows: installRunnerRows })
    plugin.apply(ctxB)
    const srvB = await startServer(ctxB.handler)
    try {
      const r = await rawRequest(srvB.url, '/packer2/api/install', { method: 'POST', headers: { origin: srvB.url }, body: { path: 'C:\\fake\\bundle.tgz', profile: 'desktop' } })
      assert.equal(r.status, 200)
      const cmds = ctxB.shellCommands.map((c) => c.command)
      const execBad = cmds.find((c) => /plugin --profile/.test(c) && /apps[\\/]cli[\\/]lib[\\/]bin\.js/.test(c))
      assert.equal(execBad, undefined, '工作区无 apps/cli 却执行了硬编码路径: ' + JSON.stringify(execBad))
      // 该路径必须「被探测过」，否则说明根本没走候选探测（仍然硬编码）
      const probed = cmds.some((c) => /Test-Path/.test(c) && /apps[\\/]cli[\\/]lib[\\/]bin\.js/.test(c))
      assert.ok(probed, '未对工作区候选做存在性探测；命令: ' + JSON.stringify(cmds))
      // 没有可用候选时必须非静默失败，且候选列表在 safeErrorMsg 脱敏后仍可读。
      // safeErrorMsg 会把绝对路径换成 <路径>、并把每行截断到 160 字符，
      // 所以「未找到 CLI」的文案必须用路径形状占位符（<工作区>/…、<resourcesPath>/…、
      // PATH 上的 dsh），否则用户在面板里只会看到 <路径>。这里要求响应里至少存活 2 个候选形状。
      assert.equal(r.json.ok, false, '不应静默假装成功: ' + JSON.stringify(r.json))
      assert.equal(typeof r.json.message, 'string')
      assert.ok(r.json.message.length > 20, '错误信息过短: ' + r.json.message)
      assert.match(r.json.message, /未找到|无法|失败/, '错误信息未说明失败: ' + r.json.message)
      const shapes = [...r.json.message.matchAll(/<工作区>|<resourcesPath>|PATH 上|app\.asar|dsh\.cmd/g)].map((m) => m[0])
      const distinct = [...new Set(shapes)]
      assert.ok(distinct.length >= 2, '错误信息里可读的候选形状 <2（被脱敏或 160 字符截断吞掉），实际命中 ' + JSON.stringify(distinct) + '：' + r.json.message)
    } finally { await srvB.close() }
  })
}

// ── [6] B9 工作区根目录解析（ADAPTATION.md 第 11 节）─────────────────────────
section('[6] B9 工作区根目录解析：agents cwd > 唯一 root > sandboxPolicy')
const b9RunnerRows = [{ pluginId: 'p1', agentId: 'session-test', name: 'MyPlugin', packages: [] }]
const cwdOf = (cwd) => ({ id: 'session-test', session: { header: { cwd } } })
/** 起一台服务器打真实 handler，取 GET /api/plugins 的 defaultOutDir。 */
async function b9DefaultOutDir(ctxB9) {
  plugin.apply(ctxB9)
  const sB9 = await startServer(ctxB9.handler)
  try {
    const rB9 = await rawRequest(sB9.url, '/packer2/api/plugins')
    assert.equal(rB9.status, 200)
    assert.equal(typeof rB9.json.defaultOutDir, 'string')
    return rB9.json.defaultOutDir
  } finally { await sB9.close() }
}
const outOf = (root) => root.replace(/[\\/]+$/, '') + '/packer2-out'

await testAsync('currentInitiator().session.header.cwd -> defaultOutDir 前缀 = 该 cwd', async () => {
  const fallback = tempDir('mycordis-b9-fb-')
  const cwd = tempDir('mycordis-b9-cwd-')
  const ctxB9a = makeCtx({ workspaceRoot: fallback, runnerRows: b9RunnerRows, agents: { currentInitiator: () => cwdOf(cwd), roots: () => [] } })
  const out = await b9DefaultOutDir(ctxB9a)
  assert.equal(out, outOf(cwd))
  assert.ok(!out.startsWith(fallback), '仍落在 sandboxPolicy 兜底根: ' + out)
})

await testAsync('currentInitiator 为 undefined + roots() 恰好 1 个带 cwd -> 同上', async () => {
  const fallback = tempDir('mycordis-b9-fb-')
  const cwd = tempDir('mycordis-b9-cwd-')
  const ctxB9b = makeCtx({ workspaceRoot: fallback, runnerRows: b9RunnerRows, agents: { currentInitiator: () => undefined, roots: () => [cwdOf(cwd)] } })
  const out = await b9DefaultOutDir(ctxB9b)
  assert.equal(out, outOf(cwd))
  assert.ok(!out.startsWith(fallback), '仍落在 sandboxPolicy 兜底根: ' + out)
})

await testAsync('agents.roots() 返回 2 个 -> 退回 sandboxPolicy 桩给的根', async () => {
  const fallback = tempDir('mycordis-b9-fb-')
  const ctxB9c = makeCtx({
    workspaceRoot: fallback,
    runnerRows: b9RunnerRows,
    agents: { currentInitiator: () => undefined, roots: () => [cwdOf(tempDir('mycordis-b9-r1-')), cwdOf(tempDir('mycordis-b9-r2-'))] },
  })
  const out = await b9DefaultOutDir(ctxB9c)
  assert.equal(out, outOf(fallback))
})

await testAsync('agents 服务缺失（get 返回 undefined）-> 退回 sandboxPolicy 且不抛', async () => {
  const fallback = tempDir('mycordis-b9-fb-')
  const ctxB9d = makeCtx({ workspaceRoot: fallback, runnerRows: b9RunnerRows, agents: null })
  assert.equal(ctxB9d.get('agents'), undefined)
  const out = await b9DefaultOutDir(ctxB9d)
  assert.equal(out, outOf(fallback))
})

await testAsync('sandboxPolicy 只暴露官方 resolve() -> 取返回值的 .workspaceRoot', async () => {
  const fallback = tempDir('mycordis-b9-fb-')
  const spRoot = tempDir('mycordis-b9-sp-')
  const ctxB9e = makeCtx({ workspaceRoot: fallback, runnerRows: b9RunnerRows, agents: null, sandboxPolicy: { resolve: () => ({ workspaceRoot: spRoot }) } })
  const out = await b9DefaultOutDir(ctxB9e)
  assert.equal(out, outOf(spRoot))
})

await testAsync('readFavorites 迁移兜底：新位置缺失时回读 <sandboxPolicy.workspaceRoot>/packer2-favorites.json', async () => {
  const oldRoot = tempDir('mycordis-b9-old-')
  const newCwd = tempDir('mycordis-b9-newcwd-')
  writeFileSync(join(oldRoot, 'packer2-favorites.json'), JSON.stringify({ favorites: [{ pluginId: 'p-legacy', packageId: 'pk-legacy', name: 'Legacy' }] }), 'utf8')
  const ctxB9f = makeCtx({ workspaceRoot: oldRoot, runnerRows: b9RunnerRows, agents: { currentInitiator: () => cwdOf(newCwd), roots: () => [] } })
  plugin.apply(ctxB9f)
  const sB9f = await startServer(ctxB9f.handler)
  try {
    const r = await rawRequest(sB9f.url, '/packer2/api/favorites')
    assert.equal(r.status, 200)
    assert.equal(r.json.favorites.length, 1, JSON.stringify(r.json))
    assert.equal(r.json.favorites[0].pluginId, 'p-legacy')
    assert.ok(!existsSync(join(newCwd, 'packer2-favorites.json')), '迁移回读不应写新位置')
  } finally { await sB9f.close() }
})


// ── [7] 卸载链路与 activeProfile 推断（install/profile.js）──────────────────
section('[7] 卸载链路：保护名单 / 参数校验 / 命令构造 / 失败透出；activeProfile 推断')
const umRunnerRows = [{ pluginId: 'p1', agentId: 'session-test', name: 'MyPlugin', packages: [] }]

// 自定义 shell 桩：把 profile manifest 换成指定内容（用于验证 bundles 并集语义）。
function shellWithManifest(record, manifest) {
  const base = makeShellStub(record)
  return {
    resolve: (spec) => base.resolve(spec),
    execute: (spec) => {
      const c = String((spec && spec.command) || '')
      if (/Get-Content/.test(c) && /package\.json/.test(c)) {
        return Promise.resolve({ result: async () => ({ exitCode: 0, stdout: { text: JSON.stringify(manifest) }, stderr: { text: '' } }) })
      }
      return base.execute(spec)
    },
  }
}

await testAsync('GET /api/plugins -> activeProfile 从 <DSH_HOME>/profiles/<name> 形状推断出 desktop', async () => {
  const dir = 'C:\\Users\\test\\.dsh\\profiles\\desktop'
  const ctxU0 = makeCtx({ runnerRows: umRunnerRows, sandboxPolicy: { workspaceRoot: dir, resolve: () => ({ workspaceRoot: dir }) } })
  plugin.apply(ctxU0)
  const sU0 = await startServer(ctxU0.handler)
  try {
    const r = await rawRequest(sU0.url, '/packer2/api/plugins')
    assert.equal(r.status, 200)
    assert.equal(r.json.activeProfile, 'desktop', JSON.stringify(r.json))
  } finally { await sU0.close() }
})

await testAsync('GET /api/plugins -> 会话工作区形状不误判为 profile（activeProfile=空串）', async () => {
  const ctxU1 = makeCtx({ workspaceRoot: tempDir('mycordis-ap-'), runnerRows: umRunnerRows })
  plugin.apply(ctxU1)
  const sU1 = await startServer(ctxU1.handler)
  try {
    const r = await rawRequest(sU1.url, '/packer2/api/plugins')
    assert.equal(r.status, 200)
    assert.equal(r.json.activeProfile, '', JSON.stringify(r.json))
  } finally { await sU1.close() }
})

await testAsync('GET /api/installed -> 以 bundles 并集 dependencies，并标出 isBase/isSelf/missingDependency', async () => {
  const manifest = {
    dependencies: { 'pkg-dep': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-mycordis', 'only-in-bundles'] } },
  }
  const record = []
  const ctxU2 = makeCtx({ workspaceRoot: tempDir('mycordis-un2-'), runnerRows: umRunnerRows, services: { shell: shellWithManifest(record, manifest) } })
  plugin.apply(ctxU2)
  const sU2 = await startServer(ctxU2.handler)
  try {
    const r = await rawRequest(sU2.url, '/packer2/api/installed?profile=probe')
    assert.equal(r.status, 200)
    assert.equal(r.json.error, undefined, JSON.stringify(r.json))
    const rows = r.json.dependencies
    assert.deepEqual(rows.map((d) => d.name), ['dsh-mycordis', 'only-in-bundles', 'pkg-dep', '@deepseek-ai/dsh-base'], '用户装的在前、基础层沉底: ' + JSON.stringify(rows))
    const byName = Object.fromEntries(rows.map((d) => [d.name, d]))
    assert.equal(byName['@deepseek-ai/dsh-base'].isBase, true)
    assert.equal(byName['@deepseek-ai/dsh-base'].missingDependency, undefined, '基础包由安装目录提供，不应报缺依赖')
    assert.equal(byName['dsh-mycordis'].isSelf, true)
    assert.equal(byName['dsh-mycordis'].isBundle, true)
    assert.equal(byName['dsh-mycordis'].isBase, false)
    assert.equal(byName['only-in-bundles'].isBundle, true)
    assert.equal(byName['only-in-bundles'].missingDependency, true, '只在 bundles 里声明却没依赖，必须显式标出')
    assert.equal(byName['only-in-bundles'].spec, '')
    assert.equal(byName['pkg-dep'].isBundle, false)
    assert.equal(byName['pkg-dep'].isBase, false)
  } finally { await sU2.close() }
})

// 卸载链路：工作区有 apps/cli/lib/bin.js，resolveDshCli 命中后命令可断言。
const wsU = tempDir('mycordis-un-')
mkdirSync(join(wsU, 'apps', 'cli', 'lib'), { recursive: true })
writeFileSync(join(wsU, 'apps', 'cli', 'lib', 'bin.js'), '// fake dsh cli\n', 'utf8')
const ctxU = makeCtx({ workspaceRoot: wsU, runnerRows: umRunnerRows })
plugin.apply(ctxU)
const srvU = await startServer(ctxU.handler)
const uh = { origin: srvU.url }
const removeCmds = () => ctxU.shellCommands.filter((c) => / remove /.test(c.command))

await testAsync('POST /api/uninstall 基础包 -> ok:false 且不执行任何 remove', async () => {
  const before = removeCmds().length
  const r = await rawRequest(srvU.url, '/packer2/api/uninstall', { method: 'POST', headers: uh, body: { name: '@deepseek-ai/dsh-base', profile: 'plugtest' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false, JSON.stringify(r.json))
  assert.match(r.json.message, /拒绝卸载/)
  assert.equal(removeCmds().length, before, '基础包不应真的执行 remove: ' + JSON.stringify(removeCmds()))
})

await testAsync('POST /api/uninstall dsh-mycordis（本插件自身）-> 允许卸载，并用 isSelf/note 讲清后果', async () => {
  const before = removeCmds().length
  const r = await rawRequest(srvU.url, '/packer2/api/uninstall', { method: 'POST', headers: uh, body: { name: 'dsh-mycordis', profile: 'plugtest' } })
  assert.equal(r.json.ok, true, '本插件自身也必须能卸载: ' + JSON.stringify(r.json))
  assert.equal(r.json.isSelf, true)
  assert.match(r.json.note, /本插件自身/, 'note 必须提示面板会消失: ' + r.json.note)
  assert.equal(removeCmds().length, before + 1, '必须真的下发 remove')
})

await testAsync('POST /api/uninstall 非法 profile / 缺插件名 -> ok:false 且不执行 remove', async () => {
  const before = removeCmds().length
  const bad1 = await rawRequest(srvU.url, '/packer2/api/uninstall', { method: 'POST', headers: uh, body: { name: 'x', profile: '../evil' } })
  assert.equal(bad1.json.ok, false)
  assert.match(bad1.json.message, /非法的 profile 名称/)
  const bad2 = await rawRequest(srvU.url, '/packer2/api/uninstall', { method: 'POST', headers: uh, body: { profile: 'web' } })
  assert.equal(bad2.json.ok, false)
  assert.match(bad2.json.message, /缺插件名/)
  assert.equal(removeCmds().length, before)
})

await testAsync('POST /api/uninstall 合法请求 -> ok:true，命令为 plugin --profile <p> remove <name>', async () => {
  const r = await rawRequest(srvU.url, '/packer2/api/uninstall', { method: 'POST', headers: uh, body: { name: 'dsh-demo-echo', profile: 'plugtest' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true, JSON.stringify(r.json))
  assert.equal(r.json.profile, 'plugtest')
  assert.match(r.json.note, /重启 dsh 后生效/)
  const cmd = removeCmds().find((c) => c.command.includes('dsh-demo-echo'))
  assert.ok(cmd, '没有构造出 remove 命令：' + JSON.stringify(ctxU.shellCommands.map((c) => c.command)))
  assert.ok(cmd.command.includes("plugin --profile 'plugtest' remove 'dsh-demo-echo'"), '命令形状不对: ' + cmd.command)
  assert.equal(cmd.sandboxPolicy && cmd.sandboxPolicy.mode, 'danger-full-access', '卸载必须按 danger-full-access 申请权限')
})

await testAsync('POST /api/uninstall CLI 退出码非 0 -> ok:false 且 message 含「卸载失败」', async () => {
  const wsF = tempDir('mycordis-un-fail-')
  mkdirSync(join(wsF, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(wsF, 'apps', 'cli', 'lib', 'bin.js'), '// fake dsh cli\n', 'utf8')
  const record = []
  const base = makeShellStub(record)
  const failing = {
    resolve: (spec) => base.resolve(spec),
    execute: (spec) => {
      const c = String((spec && spec.command) || '')
      if (/ remove /.test(c)) return Promise.resolve({ result: async () => ({ exitCode: 1, stdout: { text: '' }, stderr: { text: 'ERR_PNPM_BOOM' } }) })
      return base.execute(spec)
    },
  }
  const ctxF = makeCtx({ workspaceRoot: wsF, runnerRows: umRunnerRows, services: { shell: failing } })
  plugin.apply(ctxF)
  const sF = await startServer(ctxF.handler)
  try {
    const r = await rawRequest(sF.url, '/packer2/api/uninstall', { method: 'POST', headers: { origin: sF.url }, body: { name: 'dsh-demo-echo', profile: 'plugtest' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false, JSON.stringify(r.json))
    assert.match(r.json.message, /卸载失败/)
    assert.match(r.json.message, /ERR_PNPM_BOOM/, '底层错误应透出: ' + r.json.message)
  } finally { await sF.close() }
})

await testAsync('POST /api/uninstall profile=desktop 失败时附「完全退出桌面版」提示；非 desktop 不加', async () => {
  const wsD = tempDir('mycordis-un-hint-')
  mkdirSync(join(wsD, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(wsD, 'apps', 'cli', 'lib', 'bin.js'), '// fake dsh cli\n', 'utf8')
  const record = []
  const base = makeShellStub(record)
  const failing = {
    resolve: (spec) => base.resolve(spec),
    execute: (spec) => {
      const c = String((spec && spec.command) || '')
      if (/ remove /.test(c)) return Promise.resolve({ result: async () => ({ exitCode: 1, stdout: { text: '' }, stderr: { text: 'EPERM' } }) })
      return base.execute(spec)
    },
  }
  const ctxD = makeCtx({ workspaceRoot: wsD, runnerRows: umRunnerRows, services: { shell: failing } })
  plugin.apply(ctxD)
  const sD = await startServer(ctxD.handler)
  try {
    const desktop = await rawRequest(sD.url, '/packer2/api/uninstall', { method: 'POST', headers: { origin: sD.url }, body: { name: 'some-pkg', profile: 'desktop' } })
    assert.match(desktop.json.message, /完全退出/)
    const other = await rawRequest(sD.url, '/packer2/api/uninstall', { method: 'POST', headers: { origin: sD.url }, body: { name: 'some-pkg', profile: 'web' } })
    assert.ok(!/完全退出/.test(other.json.message), '非 desktop profile 不该带退出桌面版的提示: ' + other.json.message)
  } finally { await sD.close() }
})

await srvU.close()


// ── [8] 临时插件：导入即运行 + 手动「运行」链路（cordis/import.js）──────────
section('[8] 临时插件：导入默认自动运行、拒绝不再静默、/api/run 的 mode 判定')

// runner 桩：分别记录两条通道 —— runHostHalf（纯 host 的静默通道）与 run（带 client 半区的请求通道）。
function makeRunRunner(opts) {
  const cfg = opts || {}
  const calls = []
  const hostCalls = []
  return {
    calls,
    hostCalls,
    inventory: () => cfg.rows || [],
    define: () => ({ pluginId: 'p-run', packageId: 'pk-run' }),
    inspectPackage: () => ({ code: { host: '// old' } }),
    undefine: async () => ({ ok: true }),
    runHostHalf: async (agent, pluginId, packageId, mode, requestId, approveFutureVersions) => {
      hostCalls.push({ agentId: agent && agent.id, pluginId: pluginId, packageId: packageId, mode: mode, requestId: requestId, approveFutureVersions: approveFutureVersions })
      if (cfg.refuse === true) return { ok: false, message: 'plugin "p-run" has no successful version yet' }
      return { ok: true, pluginId: pluginId, packageId: packageId, pluginRunId: 'run-1', waitingFor: [], startedHere: true }
    },
    run: async (agent, pluginId, packageId, mode) => {
      calls.push({ agentId: agent && agent.id, pluginId: pluginId, packageId: packageId, mode: mode })
      if (cfg.refuse === true) return { ok: false, reason: 'invalid-mode', message: 'plugin "p-run" has no successful version yet' }
      return { ok: true, status: cfg.status || 'running' }
    },
  }
}
// client=true 造一个双半包（走 run() 请求通道）；默认纯 host（走 runHostHalf 静默通道）。
const portable = (name, client) => ({ __dshDynamicPlugin: true, name: name, code: client === true ? { host: '// host half\n', client: '// client half\n' } : { host: '// host half\n' } })
async function withServer(runner, fn) {
  const c = makeCtx({ runnerRows: [], services: { dynamicCordisRunner: runner } })
  plugin.apply(c)
  const s = await startServer(c.handler)
  try { return await fn(s) } finally { await s.close() }
}

await testAsync('POST /api/import 默认自动运行（纯 host）-> 走静默通道 runHostHalf(requestId=null)，不碰 run()', async () => {
  const rr = makeRunRunner({ rows: [] })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/import', { method: 'POST', headers: { origin: s.url }, body: { sessionId: 'session-test', data: portable('X') } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(rr.hostCalls.length, 1, '导入后必须自动运行一次: ' + JSON.stringify(rr.hostCalls))
    assert.deepEqual(rr.hostCalls[0], { agentId: 'session-test', pluginId: 'p-run', packageId: 'pk-run', mode: 'run', requestId: null, approveFutureVersions: false })
    assert.equal(rr.calls.length, 0, '纯 host 包不该走会唤醒会话的 run(): ' + JSON.stringify(rr.calls))
    assert.equal(r.json.results[0].ran, true, JSON.stringify(r.json.results[0]))
    assert.equal(r.json.results[0].runStatus, 'running')
    assert.equal(r.json.results[0].silent, true)
  })
})

await testAsync('POST /api/import 双半包（带 client）-> 同样走零唤醒面板手势通道，不再 run() 唤醒', async () => {
  const rr = makeRunRunner({ rows: [] })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/import', { method: 'POST', headers: { origin: s.url }, body: { sessionId: 'session-test', data: portable('X', true) } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(rr.hostCalls.length, 1, '双半包也必须走 runHostHalf: ' + JSON.stringify(rr.hostCalls))
    assert.deepEqual(rr.hostCalls[0], { agentId: 'session-test', pluginId: 'p-run', packageId: 'pk-run', mode: 'run', requestId: null, approveFutureVersions: false })
    assert.equal(rr.calls.length, 0, '零唤醒优先：不该走会 agent.steer 的 run(): ' + JSON.stringify(rr.calls))
    assert.equal(r.json.results[0].silent, true)
    assert.equal(r.json.results[0].awaitingPage, true, JSON.stringify(r.json.results[0]))
    assert.equal(r.json.results[0].runStatus, 'client-pending')
  })
})

await testAsync('POST /api/import 双半包 allowWake:true -> 才退回 run() 请求通道（会唤醒一轮）', async () => {
  const rr = makeRunRunner({ rows: [] })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/import', { method: 'POST', headers: { origin: s.url }, body: { sessionId: 'session-test', allowWake: true, data: portable('X', true) } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(rr.calls.length, 1, JSON.stringify(rr.calls))
    assert.equal(rr.hostCalls.length, 0)
    assert.equal(r.json.results[0].silent, false)
  })
})

await testAsync('POST /api/import autoRun:false -> 不运行，results 不谎报 ran', async () => {
  const rr = makeRunRunner({ rows: [] })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/import', { method: 'POST', headers: { origin: s.url }, body: { sessionId: 'session-test', autoRun: false, data: portable('X') } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(rr.calls.length, 0, '关掉自动运行后不该再 run')
    assert.equal(rr.hostCalls.length, 0, '关掉自动运行后也不该 runHostHalf')
    assert.equal(r.json.results[0].ran, undefined)
  })
})

await testAsync('runner 返回 {ok:false} -> ran:false 且 runError 带原文（旧实现静默吞掉）', async () => {
  const rr = makeRunRunner({ rows: [], refuse: true })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/import', { method: 'POST', headers: { origin: s.url }, body: { sessionId: 'session-test', data: portable('X') } })
    assert.equal(r.json.ok, true, '定义成功仍算导入成功: ' + JSON.stringify(r.json))
    assert.equal(r.json.results[0].ran, false, JSON.stringify(r.json.results[0]))
    assert.match(r.json.results[0].runError, /no successful version yet/)
  })
  const rr2 = makeRunRunner({ rows: [], refuse: true })
  await withServer(rr2, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/import', { method: 'POST', headers: { origin: s.url }, body: { sessionId: 'session-test', data: portable('X', true) } })
    assert.equal(r.json.results[0].ran, false, JSON.stringify(r.json.results[0]))
    assert.match(r.json.results[0].runError, /no successful version yet/)
  })
})

const runRows = [{
  pluginId: 'p1', agentId: 'session-test', currentPackageId: 'pk1', name: 'MyPlugin',
  packages: [{ packageId: 'pk1', name: 'MyPlugin', hasClientHalf: false }, { packageId: 'pk2', name: 'MyPlugin', hasClientHalf: true }],
}]
await testAsync('POST /api/run 纯 host 当前包 -> 静默通道（runHostHalf, requestId=null），silent:true', async () => {
  const rr = makeRunRunner({ rows: runRows })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p1', packageId: 'pk1' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(r.json.mode, 'run')
    assert.equal(r.json.status, 'running')
    assert.equal(r.json.silent, true, '纯 host 包必须走静默通道（不唤醒会话）')
    assert.deepEqual(rr.hostCalls[0], { agentId: 'session-test', pluginId: 'p1', packageId: 'pk1', mode: 'run', requestId: null, approveFutureVersions: false })
    assert.equal(rr.calls.length, 0, '不该走 run(): ' + JSON.stringify(rr.calls))
  })
})

await testAsync('POST /api/run 换到带 client 的包 -> mode=update，仍走零唤醒通道并停在「待页面装入」', async () => {
  const rr = makeRunRunner({ rows: runRows })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p1', packageId: 'pk2' } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(r.json.mode, 'update')
    assert.equal(r.json.silent, true, '双半包默认零唤醒: ' + JSON.stringify(r.json))
    assert.equal(r.json.awaitingPage, true, JSON.stringify(r.json))
    assert.equal(r.json.status, 'client-pending')
    assert.equal(rr.hostCalls[0].mode, 'update')
    assert.equal(rr.hostCalls[0].requestId, null, '必须是面板手势(requestId=null)，否则会走 steer')
    assert.equal(rr.calls.length, 0, '不该走 run(): ' + JSON.stringify(rr.calls))
  })
})

await testAsync('POST /api/run 双半包 wake:true -> 显式退回 run() 通道（承认会唤醒一轮）', async () => {
  const rr = makeRunRunner({ rows: runRows })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p1', packageId: 'pk2', wake: true } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(r.json.silent, false)
    assert.equal(rr.hostCalls.length, 0)
    assert.equal(rr.calls.length, 1)
    assert.equal(rr.calls[0].mode, 'update')
  })
})

// 已在运行同一个包：默认短路（省一次会话唤醒），force:true 才重启。
const runRowsRunning = [{
  pluginId: 'p1', agentId: 'session-test', currentPackageId: 'pk1', name: 'MyPlugin', latestRun: { status: 'running' },
  packages: [{ packageId: 'pk1', name: 'MyPlugin', hasClientHalf: false }, { packageId: 'pk2', name: 'MyPlugin', hasClientHalf: true }],
}]
await testAsync('POST /api/run 已在跑同一个包 -> noop 短路，完全不碰 runner（省一次唤醒）', async () => {
  const rr = makeRunRunner({ rows: runRowsRunning })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p1', packageId: 'pk1' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(r.json.noop, true, JSON.stringify(r.json))
    assert.equal(rr.calls.length, 0, '重复运行不该走 run()')
    assert.equal(rr.hostCalls.length, 0, '重复运行不该走 runHostHalf()')
    assert.match(r.json.note, /已在运行/)
  })
})

await testAsync('POST /api/run force:true -> 即使已在运行也照走（显式重启）', async () => {
  const rr = makeRunRunner({ rows: runRowsRunning })
  await withServer(rr, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p1', packageId: 'pk1', force: true } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(r.json.noop, undefined)
    assert.equal(rr.hostCalls.length, 1, 'force 必须真的重新运行')
  })
})

await testAsync('POST /api/run 缺 pluginId / 插件不存在 / 包不属于该插件 -> ok:false 且不调 run', async () => {
  const rr = makeRunRunner({ rows: runRows })
  await withServer(rr, async (s) => {
    const noId = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: {} })
    assert.equal(noId.json.ok, false)
    assert.match(noId.json.message, /缺 pluginId/)
    const ghost = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'nope' } })
    assert.equal(ghost.json.ok, false)
    assert.match(ghost.json.message, /找不到插件/)
    const badPkg = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p1', packageId: 'pk9' } })
    assert.equal(badPkg.json.ok, false)
    assert.match(badPkg.json.message, /不属于插件/)
    assert.equal(rr.calls.length, 0, '校验失败不该真的 run: ' + JSON.stringify(rr.calls))
    assert.equal(rr.hostCalls.length, 0, '校验失败不该真的 runHostHalf')
  })
})

await testAsync('POST /api/run 两条通道返回 {ok:false} -> ok:false 且带上 runner 原文', async () => {
  const rrHost = makeRunRunner({ rows: runRows, refuse: true })
  await withServer(rrHost, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p1', packageId: 'pk1' } })
    assert.equal(r.json.ok, false, JSON.stringify(r.json))
    assert.match(r.json.message, /运行被拒绝/)
    assert.match(r.json.message, /no successful version yet/)
  })
  // 零唤醒通道：双半包默认也走 runHostHalf，拒绝原文来自 host 半。
  const rrZero = makeRunRunner({ rows: runRows, refuse: true })
  await withServer(rrZero, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p1', packageId: 'pk2' } })
    assert.equal(r.json.ok, false, JSON.stringify(r.json))
    assert.match(r.json.message, /运行被拒绝/)
    assert.match(r.json.message, /no successful version yet/)
    assert.equal(rrZero.calls.length, 0, '零唤醒通道不该碰 run()')
  })
  const rrClient = makeRunRunner({ rows: runRows, refuse: true })
  await withServer(rrClient, async (s) => {
    const r = await rawRequest(s.url, '/packer2/api/run', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p1', packageId: 'pk2', wake: true } })
    assert.equal(r.json.ok, false, JSON.stringify(r.json))
    assert.match(r.json.message, /运行被拒绝/)
    assert.match(r.json.message, /invalid-mode/)
  })
})


// ── [9] D2：/api/sessions 会话清单（多会话并存时由用户显式选择）───────────
section('[9] D2：GET /api/sessions 列出存活会话，供面板选「所属会话 id」')

async function sessionsWith(agentsStub) {
  const c = makeCtx({ agents: agentsStub })
  plugin.apply(c)
  const s = await startServer(c.handler)
  try { return await rawRequest(s.url, '/packer2/api/sessions') } finally { await s.close() }
}
const sessA = { id: 'session-aaaa', session: { header: { cwd: 'E:\\ws-a' } } }
const sessB = { id: 'session-bbbb', session: { header: { cwd: 'E:\\ws-b' } } }
const sessChild = { id: 'session-child', session: { header: { cwd: 'E:\\ws-c' } } }

await testAsync('GET /api/sessions -> 200，列出 root 会话（id/cwd/root），子代理不进列表', async () => {
  const r = await sessionsWith({ currentInitiator: () => undefined, roots: () => [sessA, sessB], list: () => [sessA, sessB, sessChild] })
  assert.equal(r.status, 200)
  assert.equal(r.json.available, true, JSON.stringify(r.json))
  assert.deepEqual(r.json.sessions.map((x) => x.id), ['session-aaaa', 'session-bbbb'])
  assert.deepEqual(r.json.sessions.map((x) => x.cwd), ['E:\\ws-a', 'E:\\ws-b'])
  assert.deepEqual(r.json.sessions.map((x) => x.root), [true, true])
  assert.deepEqual(r.json.sessions.map((x) => x.title), ['', ''], '没有 sessionTitle 服务时优雅降级为空标题')
  assert.equal(r.json.resolved, '', 'HTTP 请求没有 initiator，多会话时自动解析必须为空')
})

await testAsync('GET /api/sessions 只有一个存活会话 -> resolved 非空（面板可自动预选）', async () => {
  const r = await sessionsWith({ currentInitiator: () => undefined, roots: () => [sessA], list: () => [sessA] })
  assert.equal(r.json.resolved, 'session-aaaa')
})

await testAsync('GET /api/sessions agents 服务缺失 -> 200 + available:false（手动填 id 的路不受影响）', async () => {
  const r = await sessionsWith(null)
  assert.equal(r.status, 200)
  assert.equal(r.json.available, false, JSON.stringify(r.json))
  assert.deepEqual(r.json.sessions, [])
  assert.match(String(r.json.reason), /agents/)
})

// 会话选择的标签来源：面板把每条会话渲染成「历史对话标题 - 会话id」，
// 标题取官方 sessionTitle 服务（与 DSH 侧边栏同一个 session/title 投影）。
async function sessionsWithTitle(titleStub) {
  const c = makeCtx({
    agents: { currentInitiator: () => undefined, roots: () => [sessA, sessB], list: () => [sessA, sessB] },
    services: { sessionTitle: titleStub },
  })
  plugin.apply(c)
  const s = await startServer(c.handler)
  try { return await rawRequest(s.url, '/packer2/api/sessions') } finally { await s.close() }
}

await testAsync('GET /api/sessions sessionTitle 可用 -> 每条会话带历史对话标题', async () => {
  const titles = new Map([[sessA.session, '修复信任栅栏'], [sessB.session, '会话二']])
  const r = await sessionsWithTitle({
    get(session) {
      const t = titles.get(session)
      return t === undefined ? undefined : { title: t }
    },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.sessions.map((x) => x.title), ['修复信任栅栏', '会话二'])
  assert.deepEqual(r.json.sessions.map((x) => x.id), ['session-aaaa', 'session-bbbb'])
})

await testAsync('GET /api/sessions sessionTitle 抛错/返回空 -> 该条 title 退化空串，其余字段不受影响', async () => {
  const r = await sessionsWithTitle({ get() { throw new Error('boom') } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.sessions.map((x) => x.title), ['', ''])
  assert.deepEqual(r.json.sessions.map((x) => x.cwd), ['E:\\ws-a', 'E:\\ws-b'])
  assert.equal(r.json.available, true)
})

await testAsync('面板 HTML 含会话下拉 xsessSel，且绑定了回填 xsess 的 onchange', async () => {
  const r = await rawRequest(srv.url, '/packer2')
  assert.ok(r.text.includes('id="xsessSel"'), '面板缺会话下拉')
  assert.match(r.text, /xsessSel'\)\.onchange/, '下拉没有回填 xsess 的绑定')
})

// 收藏写入的策略：fs 沙箱按 sandboxPolicy 的根判定，而 workspaceRoot() 在全局路由下会退回
// 部署目录 —— 两者不一致时若不显式申请 danger-full-access，用户看到的就是「点 ☆ 收藏不上」。
async function favoriteWithRoots(wsRoot, policyRoot) {
  const writes = []
  const fsStub = {
    resolve: async (p) => String(p),
    processPath: (t) => String(t),
    readText: async () => { throw new Error('ENOENT') },
    writeText: async (t, content, expected, signal, policy) => { writes.push({ target: String(t), policy: policy === undefined ? null : policy }) },
  }
  const c = makeCtx({
    workspaceRoot: wsRoot,
    runnerRows: runRowsRunning,
    agents: { currentInitiator: () => ({ id: 'session-test', session: { header: { cwd: wsRoot } } }), roots: () => [] },
    sandboxPolicy: { workspaceRoot: policyRoot, resolve: () => ({ mode: 'workspace-write', workspaceRoot: policyRoot }) },
    services: { fs: fsStub },
  })
  plugin.apply(c)
  const s = await startServer(c.handler)
  try {
    const r = await rawRequest(s.url, '/packer2/api/favorite', { method: 'POST', headers: { origin: s.url }, body: { action: 'add', pluginId: 'p1', packageId: 'pk1' } })
    return { r, writes }
  } finally { await s.close() }
}

await testAsync('收藏写入在策略根外 -> 显式 danger-full-access（修「不能正常收藏」）', async () => {
  const out = await favoriteWithRoots(tempDir('mycordis-fav-ws-'), tempDir('mycordis-fav-pol-'))
  assert.equal(out.r.json.ok, true, JSON.stringify(out.r.json))
  assert.equal(out.writes.length, 1, JSON.stringify(out.writes))
  assert.ok(out.writes[0].target.indexOf('packer2-favorites.json') !== -1, out.writes[0].target)
  assert.deepEqual(out.writes[0].policy, { mode: 'danger-full-access' }, '策略根外写入必须申请 full access: ' + JSON.stringify(out.writes))
})

await testAsync('收藏写入在策略根内 -> 不申请提升（沿用部署策略）', async () => {
  const same = tempDir('mycordis-fav-same-')
  const out = await favoriteWithRoots(same, same)
  assert.equal(out.r.json.ok, true, JSON.stringify(out.r.json))
  assert.equal(out.writes.length, 1, JSON.stringify(out.writes))
  assert.equal(out.writes[0].policy, null, '根内写入不该无谓提权: ' + JSON.stringify(out.writes))
})

await srv.close()
await favSrv.close()

// ── [10] 便携包导出：完整定义（host + client）+ 不依赖 shell（跨平台）────────
section('[10] 便携包导出：默认含 client 半区、写盘零 shell（跨平台）')

const dualRows = [{
  pluginId: 'p2', agentId: 'session-test', currentPackageId: 'pk2', name: 'DualPlugin',
  packages: [{ packageId: 'pk2', name: 'DualPlugin', hasHostHalf: true, hasClientHalf: true }],
}]
function dualRunner() {
  return {
    inventory: () => dualRows,
    inspectPackage: () => ({ pluginId: 'p2', name: 'DualPlugin', purpose: 'dual', code: { host: '// host half\n', client: '// client half\n' } }),
  }
}
function dualCtx() {
  return makeCtx({ runnerRows: dualRows, services: { dynamicCordisRunner: dualRunner() } })
}

await testAsync('POST /api/export-batch 默认导出完整定义（code.client 保留），且不执行任何 shell', async () => {
  const dir = tempDir('mycordis-portable-')
  const c = dualCtx()
  plugin.apply(c)
  const s = await startServer(c.handler)
  try {
    const r = await rawRequest(s.url, '/packer2/api/export-batch', { method: 'POST', headers: { origin: s.url }, body: { plugins: [{ pluginId: 'p2', packageId: 'pk2' }], outDir: dir } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(r.json.results[0].ok, true, JSON.stringify(r.json.results[0]))
    assert.equal(r.json.results[0].hasClientHalf, true)
    assert.equal(r.json.results[0].packageId, 'pk2')
    const file = join(dir, 'p2-pk2.dshplugin.json')
    assert.ok(existsSync(file), '便携包未落盘: ' + file)
    const out = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(out.code.host, '// host half\n')
    assert.equal(out.code.client, '// client half\n', 'client 半区被丢弃了：' + JSON.stringify(out.code))
    assert.equal(out.ownerSessionId, 'session-00000000-0000-4000-8000-000000000000')
    assert.equal(c.shellCommands.length, 0, '便携包导出不该依赖 shell（旧实现在非 Windows 上直接失败）: ' + JSON.stringify(c.shellCommands))
  } finally { await s.close() }
})

await testAsync('POST /api/export-batch pureHost:true -> 只导 host 半区（旧语义仍可显式取回）', async () => {
  const dir = tempDir('mycordis-portable-pure-')
  const c = dualCtx()
  plugin.apply(c)
  const s = await startServer(c.handler)
  try {
    const r = await rawRequest(s.url, '/packer2/api/export-batch', { method: 'POST', headers: { origin: s.url }, body: { plugins: [{ pluginId: 'p2', packageId: 'pk2' }], outDir: dir, pureHost: true } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    const out = JSON.parse(readFileSync(join(dir, 'p2-pk2.dshplugin.json'), 'utf8'))
    assert.equal(out.code.host, '// host half\n')
    assert.equal(out.code.client, undefined, 'pureHost 应退回只导 host 半区')
    assert.equal(c.shellCommands.length, 0)
  } finally { await s.close() }
})

await testAsync('POST /api/snapshot 导出完整定义（含 client）且不执行 shell', async () => {
  const c = dualCtx()
  plugin.apply(c)
  const s = await startServer(c.handler)
  try {
    const r = await rawRequest(s.url, '/packer2/api/snapshot', { method: 'POST', headers: { origin: s.url }, body: { pluginId: 'p2' } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal(r.json.hasClientHalf, true)
    const out = JSON.parse(readFileSync(r.json.path, 'utf8'))
    assert.equal(out.code.client, '// client half\n')
    assert.equal(c.shellCommands.length, 0, '快照导出不该依赖 shell: ' + JSON.stringify(c.shellCommands))
  } finally { await s.close() }
})

await testAsync('GET /api/export 默认完整定义；pureHost=1 退回只导 host（与批量接口对齐）', async () => {
  const c = dualCtx()
  plugin.apply(c)
  const s = await startServer(c.handler)
  try {
    const full = await rawRequest(s.url, '/packer2/api/export?pluginId=p2&packageId=pk2')
    assert.equal(full.json.code.client, '// client half\n', JSON.stringify(full.json.code))
    const pure = await rawRequest(s.url, '/packer2/api/export?pluginId=p2&packageId=pk2&pureHost=1')
    assert.equal(pure.json.code.client, undefined)
    assert.equal(c.shellCommands.length, 0)
  } finally { await s.close() }
})

// ── [11] 打包整包：便携包与 .tgz 同出（便携包默认含 client；目录/摘要跨平台）──
section('[11] 打包整包：便携包与 .tgz 同出，便携包默认含 client')

/** 带 readBytes/stat 的 fs 桩：让 fileSha256AndSize 走进程内 WebCrypto 分支（不依赖 shell 摘要）。 */
function richFsStub() {
  const base = makeFsStub()
  return {
    ...base,
    stat: async (t) => { const b = readFileSync(String(t)); return { type: 'file', size: b.length } },
    readBytes: async (t, signal, maxBytes) => { const b = readFileSync(String(t)); return new Uint8Array(b.subarray(0, Math.min(b.length, maxBytes))) },
  }
}
/** 让 resolvePnpm 从 PATH 命中，并在 pnpm pack 时真的造出 .tgz。 */
function makePackShell(record) {
  const base = makeShellStub(record)
  return {
    resolve: (spec) => base.resolve(spec),
    execute: (spec) => {
      const c = String((spec && spec.command) || '')
      if (/Get-Command pnpm/.test(c)) {
        return Promise.resolve({ result: async () => ({ exitCode: 0, stdout: { text: 'C:\\fake\\pnpm.cjs' }, stderr: { text: '' } }) })
      }
      const m = /--pack-destination '([^']+)'/.exec(c)
      if (/pack --reporter/.test(c) && m) {
        const dir = m[1].split("''").join("'")
        mkdirSync(dir, { recursive: true })
        // packSessionPlugin 用 inspectPackage().pluginId（= p2）当 tgz 文件名。
        writeFileSync(join(dir, 'p2-0.1.0.tgz'), 'fake-tgz', 'utf8')
        return Promise.resolve({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) })
      }
      return base.execute(spec)
    },
  }
}

await testAsync('POST /api/pack-whole -> 子目录内 .tgz + 便携包，便携包含 client 且 sha256 为 64 位十六进制', async () => {
  const ws = tempDir('mycordis-whole-')
  const c = makeCtx({ workspaceRoot: ws, runnerRows: dualRows, services: { dynamicCordisRunner: dualRunner(), shell: makePackShell([]), fs: richFsStub() } })
  plugin.apply(c)
  const s = await startServer(c.handler)
  try {
    const r = await rawRequest(s.url, '/packer2/api/pack-whole', { method: 'POST', headers: { origin: s.url }, body: { plugins: [{ pluginId: 'p2', packageId: 'pk2' }], outDir: ws + '/out' } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    const row = r.json.results[0]
    assert.equal(row.ok, true, JSON.stringify(row))
    assert.equal(row.hasClientHalf, true)
    assert.ok(existsSync(row.tgzPath), 'tgz 未产出: ' + row.tgzPath)
    assert.match(String(row.sha256), /^[0-9a-f]{64}$/)
    const portable = JSON.parse(readFileSync(row.portablePath, 'utf8'))
    assert.equal(portable.code.host, '// host half\n')
    assert.equal(portable.code.client, '// client half\n', '整包的便携包也必须是完整定义')
    assert.equal(portable.packageId, 'pk2')
  } finally { await s.close() }
})

await testAsync('POST /api/pack-whole pureHost:true -> 便携包退回纯 host（.tgz 仍含 client.js）', async () => {
  const ws = tempDir('mycordis-whole-pure-')
  const c = makeCtx({ workspaceRoot: ws, runnerRows: dualRows, services: { dynamicCordisRunner: dualRunner(), shell: makePackShell([]), fs: richFsStub() } })
  plugin.apply(c)
  const s = await startServer(c.handler)
  try {
    const r = await rawRequest(s.url, '/packer2/api/pack-whole', { method: 'POST', headers: { origin: s.url }, body: { plugins: [{ pluginId: 'p2', packageId: 'pk2' }], outDir: ws + '/out', pureHost: true } })
    const row = r.json.results[0]
    assert.equal(row.ok, true, JSON.stringify(row))
    assert.equal(row.hasClientHalf, false)
    const portable = JSON.parse(readFileSync(row.portablePath, 'utf8'))
    assert.equal(portable.code.client, undefined)
  } finally { await s.close() }
})

// ── 汇总 ─────────────────────────────────────────────────────────────────
write('')
if (pendingFailures.length > 0) {
  write('待改造转绿（' + pendingFailures.length + '）：')
  for (const n of pendingFailures) write('  - ' + n)
}
write('RESULT ' + (failed === 0 ? 'OK' : 'FAILED') + ' passed=' + passed + ' failed=' + failed + ' skipped=' + skipped)
restoreConsole()
process.exit(failed === 0 ? 0 : 1)
