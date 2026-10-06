// tests/live-e2e.mjs —— 对运行中的 DSH 桌面版 GUI 做零副作用实测
//
// 目标：http://127.0.0.1:19387（可用环境变量 MYCORDIS_BASE 覆盖）
// 只做：5 个只读 GET + 2 个「打不存在路径」的 POST 探针。
// 绝不调用任何会改状态的接口（不 install / uninstall / pack / import / favorite / dedupe / browse/pick）。
//
// 运行： node mycordis-v2/tests/live-e2e.mjs                        信息性，exit 0
//        node mycordis-v2/tests/live-e2e.mjs --expect-patched       无 Origin POST 须 404 且 GET 全 200，否则 exit 1
//        node mycordis-v2/tests/live-e2e.mjs --expect-unpatched     无 Origin POST 须 403 且 GET 全 200，否则 exit 1
import process from 'node:process'

const BASE = (process.env.MYCORDIS_BASE || 'http://127.0.0.1:19387').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.MYCORDIS_TIMEOUT_MS || 10000)
const PROBE_PATH = '/packer2/__probe__' // 不存在：只用来区分「被信任栅栏挡下」与「越过栅栏到达路由」

const GETS = [
  { path: '/packer2', money: 'HTML 含「我的Cordis」' },
  { path: '/packer2/api/plugins', money: 'JSON' },
  { path: '/packer2/api/installed?profile=desktop', money: 'JSON' },
  { path: '/packer2/api/browse', money: 'JSON kind' },
  { path: '/packer2/api/favorites', money: 'JSON favorites' },
]

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length) }
const line = (s) => process.stdout.write(s + '\n')

// ── 可选判定开关（供 tools/accept.mjs / CI 编排做门禁）──
//   （不传）             信息性行为，始终 exit 0
//   --expect-patched     无 Origin 的 POST 必须是 404，且只读 GET 全 200，否则 exit 1
//   --expect-unpatched   无 Origin 的 POST 必须是 403，且只读 GET 全 200，否则 exit 1
// 两种 --expect-* 同时传 -> exit 2；连不上 DSH -> exit 2。
const argv = new Set(process.argv.slice(2))
const expectPatched = argv.has('--expect-patched')
const expectUnpatched = argv.has('--expect-unpatched')
if (expectPatched && expectUnpatched) {
  line('错误：--expect-patched 与 --expect-unpatched 不能同时使用。')
  process.exit(2)
}

async function fetchWith(path, init) {
  const res = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) { json = null }
  return { status: res.status, type: res.headers.get('content-type') || '', text, json }
}

function shapeOf(r) {
  if (r.json !== null) {
    const keys = Object.keys(r.json)
    const bits = []
    if (Array.isArray(r.json.plugins)) bits.push('plugins=' + r.json.plugins.length)
    if (Array.isArray(r.json.dependencies)) bits.push('dependencies=' + r.json.dependencies.length)
    if (Array.isArray(r.json.favorites)) bits.push('favorites=' + r.json.favorites.length)
    if (r.json.kind !== undefined) bits.push('kind=' + JSON.stringify(r.json.kind))
    if (r.json.available !== undefined) bits.push('available=' + r.json.available)
    if (r.json.profile !== undefined) bits.push('profile=' + JSON.stringify(r.json.profile))
    if (r.json.error !== undefined) bits.push('error=' + JSON.stringify(r.json.error))
    return 'keys=[' + keys.join(',') + ']' + (bits.length ? ' ' + bits.join(' ') : '')
  }
  return r.type.startsWith('text/html') ? 'HTML ' + r.text.length + ' 字节' : r.text.slice(0, 80)
}

line('目标: ' + BASE)
line('（只读 GET + 不存在路径 POST 探针；零副作用）')
line('')

// ── 1. GET 矩阵 ──
line('[GET]')
line('  ' + pad('路径', 46) + pad('状态', 6) + pad('类型', 26) + '形状 / 摘要')
const getResults = []
for (const g of GETS) {
  try {
    const r = await fetchWith(g.path, { method: 'GET' })
    let extra = shapeOf(r)
    if (g.path === '/packer2' && r.text.includes('我的Cordis')) extra += '  含「我的Cordis」=true'
    else if (g.path === '/packer2') extra += '  含「我的Cordis」=false'
    getResults.push({ path: g.path, status: r.status, ok: r.status === 200 })
    line('  ' + pad(g.path, 46) + pad(r.status, 6) + pad(String(r.type).slice(0, 24), 26) + extra)
  } catch (e) {
    getResults.push({ path: g.path, status: 0, ok: false })
    line('  ' + pad(g.path, 46) + pad('ERR', 6) + pad('-', 26) + String((e && e.message) || e))
  }
}

// ── 2. POST 探针（对照表）──
line('')
line('[POST 探针] ' + PROBE_PATH + '（该路由不存在；不会被任何状态改写）')
let noOrigin = null
let withOrigin = null
try {
  const r = await fetchWith(PROBE_PATH, { method: 'POST' })
  noOrigin = r.status
  line('  ' + pad('无 Origin（桌面 dsh-app:// 代理的形态）', 44) + ' -> ' + r.status + '  ' +
    (r.status === 403 ? '← 未打补丁（B1：桌面版所有 POST 恒 403）' : r.status === 404 ? '← 已打补丁（越过栅栏，到达路由）' : ''))
} catch (e) {
  line('  ' + pad('无 Origin', 44) + ' -> 连接失败: ' + String((e && e.message) || e))
}
try {
  const r = await fetchWith(PROBE_PATH, { method: 'POST', headers: { origin: BASE } })
  withOrigin = r.status
  line('  ' + pad('带同源 Origin: ' + BASE, 44) + ' -> ' + r.status + '  ' + (r.status === 404 ? '← 越过栅栏（基线，未打补丁时也应如此）' : ''))
} catch (e) {
  line('  ' + pad('带同源 Origin', 44) + ' -> 连接失败: ' + String((e && e.message) || e))
}

// ── 3. 结论 ──
const badGets = getResults.filter((g) => !g.ok)
const getsAllOk = badGets.length === 0
line('')
if (noOrigin === null && withOrigin === null) {
  line('结论: 无法连接 ' + BASE + '（DSH 桌面版可能未运行）。')
  process.exit(2)
}
if (noOrigin === 403) {
  line('结论: 【未打补丁】无 Origin 的 POST 被信任栅栏拒绝（403）。安装 mycordis-v2/host.js 并重启 DSH 后本行应为 404。')
} else if (noOrigin === 404) {
  line('结论: 【已打补丁】无 Origin 的 POST 越过栅栏到达路由（404）。B1 在运行实例上已生效。')
} else if (noOrigin === 0) {
  line('结论: 无 Origin 探针连接失败；带 Origin 探针状态=' + withOrigin + '。')
} else {
  line('结论: 无 Origin 探针状态=' + noOrigin + '（既非 403 也非 404，请人工核对）。')
}
line(getsAllOk ? '只读路由: 全部 200。' : '只读路由异常: ' + badGets.map((g) => g.path + '=' + g.status).join(', '))

// ── 4. 门禁模式 ──
if (expectPatched || expectUnpatched) {
  const want = expectPatched ? 404 : 403
  const label = expectPatched ? '--expect-patched' : '--expect-unpatched'
  const statusOk = noOrigin === want
  line('门禁 ' + label + ': 无 Origin POST 期望 ' + want + '，实际 ' + noOrigin + ' -> ' + (statusOk ? 'PASS' : 'FAIL'))
  line('门禁 只读 GET 全 200: ' + (getsAllOk ? 'PASS' : 'FAIL'))
  process.exit(statusOk && getsAllOk ? 0 : 1)
}
process.exit(0)
