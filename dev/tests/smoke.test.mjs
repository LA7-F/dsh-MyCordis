// dev/tests/smoke.test.mjs —— 零依赖回归门禁：直接对 dev/src/ 的分层片段做行为断言。
//
// 为什么能这样测：host 半区本来就是一个 async 函数体，拼接后的代码可以直接 new Function 求值。
// 这里先只取 base 层（与 DSH 无关的纯函数）拼成一个可调用对象来测语义，
// 再对完整产物做结构断言。跑法：
//   node dev/tests/smoke.test.mjs

import { readFileSync } from 'node:fs'
import { modules, buildSource, evaluatePlugin, hostPath } from '../tools/lib/bundle.mjs'

let passed = 0
let failed = 0
const fails = []

function ok(cond, msg) {
  if (cond === true) { passed += 1; return }
  failed += 1
  fails.push(msg)
  console.log('  FAIL ' + msg)
}
function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), msg + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）')
}

// ── base 层：拼成可调用对象 ────────────────────────────────────────────────
const baseMods = modules.filter((m) => m.id.indexOf('base/') === 0)
ok(baseMods.length === 3, 'base 层恰好 3 个片段')
const EXPORTS = '{ esc, isWindowsHost, sq, rand, parseAuthority, isLoopbackHostname, parseOrigin, defaultPort, isTrustedRequest, validProfile, normPath, sanitizeFilename, safeErrorMsg }'
const base = await new Function('return (async () => {\n' + buildSource(baseMods) + '\nreturn ' + EXPORTS + ';\n})()')()

// esc
eq(base.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', 'esc 转义 5 个危险字符')

// sq
if (base.isWindowsHost()) eq(base.sq("a'b"), "'a''b'", 'sq 在 Windows 上把内层单引号翻倍')
else eq(base.sq("a'b"), "'a'\\''b'", "sq 在 POSIX 上用 '\\'' 闭合拼接")

// rand
ok(base.rand() !== base.rand(), 'rand 两次调用不重复')

// parseAuthority
const a1 = base.parseAuthority('127.0.0.1:19387')
eq(a1.host, '127.0.0.1', 'parseAuthority 取 host')
eq(a1.port, '19387', 'parseAuthority 取 port')
const a2 = base.parseAuthority('[::1]:8080')
eq(a2.host, '[::1]', 'parseAuthority 支持 IPv6 方括号')
eq(a2.port, '8080', 'parseAuthority 支持 IPv6 端口')
eq(base.parseAuthority('localhost').port, '', 'parseAuthority 无端口时为空')

// isLoopbackHostname
ok(base.isLoopbackHostname('localhost'), 'localhost 是 loopback')
ok(base.isLoopbackHostname('127.0.0.1'), '127.0.0.1 是 loopback')
ok(base.isLoopbackHostname('127.1.2.3'), '127.x.x.x 是 loopback')
ok(base.isLoopbackHostname('::1'), '::1 是 loopback')
ok(base.isLoopbackHostname('[::1]'), '[::1] 是 loopback')
ok(!base.isLoopbackHostname('example.com'), 'example.com 不是 loopback')
ok(!base.isLoopbackHostname('10.0.0.1'), '10.0.0.1 不是 loopback')

// parseOrigin
eq(base.parseOrigin('null'), null, "Origin 'null' 解析为 null")
eq(base.parseOrigin(''), null, '空 Origin 解析为 null')
eq(base.parseOrigin('not-an-origin'), null, '非法 Origin 解析为 null')
const o1 = base.parseOrigin('http://127.0.0.1:19387')
eq(o1.scheme, 'http', 'parseOrigin 取 scheme')
eq(o1.host, '127.0.0.1', 'parseOrigin 取 host')
eq(o1.port, '19387', 'parseOrigin 取 port')

// defaultPort
eq(base.defaultPort('http'), '80', 'http 默认端口 80')
eq(base.defaultPort('https'), '443', 'https 默认端口 443')
eq(base.defaultPort('dsh-app'), '', '未知 scheme 无默认端口')

// isTrustedRequest：信任栅栏
function req(headers, remoteAddress, encrypted) {
  return {
    headers: headers,
    socket: {
      remoteAddress: remoteAddress === undefined ? '127.0.0.1' : remoteAddress,
      encrypted: encrypted === true,
    },
  }
}
ok(base.isTrustedRequest(req({ host: '127.0.0.1:19387' })), 'loopback Host + 无 Origin → 放行（桌面版 dsh-app:// 转发依赖这条）')
eq(base.isTrustedRequest(req({})), false, '缺 Host → 拒绝')
eq(base.isTrustedRequest(req({ host: 'example.com' })), false, '非 loopback Host → 拒绝')
eq(base.isTrustedRequest(req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })), false, 'cross-site → 拒绝')
eq(base.isTrustedRequest(req({ host: '127.0.0.1:19387', origin: 'null' })), false, "Origin: null → 拒绝")
eq(base.isTrustedRequest(req({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' })), true, '同源 Origin → 放行')
eq(base.isTrustedRequest(req({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:9999' })), false, '端口不符 → 拒绝')
eq(base.isTrustedRequest(req({ host: '127.0.0.1:19387', origin: 'https://127.0.0.1:19387' })), false, 'scheme 不符 → 拒绝')
eq(base.isTrustedRequest(req({ host: '127.0.0.1:19387', origin: 'http://example.com' })), false, '非 loopback Origin → 拒绝')
eq(base.isTrustedRequest(req({ host: '127.0.0.1:80', origin: 'http://127.0.0.1' })), true, '缺省端口按 scheme 归一后视为同源')
eq(base.isTrustedRequest(req({ host: '127.0.0.1:19387' }, '10.0.0.5')), false, 'socket 远端非 loopback → 拒绝')
eq(base.isTrustedRequest(req({ host: '127.0.0.1:19387' }, '::ffff:127.0.0.1')), true, 'IPv4-mapped loopback 归一后放行')

// validProfile
ok(base.validProfile('web'), 'web 是合法 profile')
ok(base.validProfile('desktop-2'), 'desktop-2 是合法 profile')
ok(!base.validProfile('../x'), '../x 不是合法 profile')
ok(!base.validProfile(''), '空 profile 不合法')
ok(!base.validProfile('a'.repeat(33)), '超过 32 字符的 profile 不合法')

// normPath
eq(base.normPath('a\\b\\c'), 'a/b/c', 'normPath 反斜杠归一为 /')
eq(base.normPath('a/./b/../c'), 'a/c', 'normPath 折叠 . 与 ..')
eq(base.normPath('C:\\x\\y'), '/C:/x/y', 'normPath 保留盘符的绝对语义')
eq(base.normPath('/a/../..'), '/', 'normPath 不会越过根')

// sanitizeFilename
eq(base.sanitizeFilename('a b/c?.tgz'), 'a_b_c_.tgz', 'sanitizeFilename 替换非白名单字符')
eq(base.sanitizeFilename('x\ny'), 'xy', 'sanitizeFilename 去掉换行')
eq(base.sanitizeFilename(''), 'download', 'sanitizeFilename 空名给默认值')

// safeErrorMsg
ok(base.safeErrorMsg(new Error('写入 C:\\Users\\x\\secret.txt 失败')).indexOf('C:\\Users') === -1, 'safeErrorMsg 剥掉绝对路径')
ok(base.safeErrorMsg(new Error('x'.repeat(300))).length <= 161, 'safeErrorMsg 截断超长行')

// ── 完整产物：结构断言 ─────────────────────────────────────────────────────
const code = buildSource()
const plugin = await evaluatePlugin(code)
ok(typeof plugin.apply === 'function', '完整产物求值后带 apply(ctx)')
ok(Array.isArray(plugin.inject) && plugin.inject.indexOf('webServer') !== -1, 'inject 含 webServer')
ok(modules[modules.length - 1].id === 'plugin', 'plugin 片段排在最后')
eq(readFileSync(hostPath, 'utf8') === code, true, 'lib/host.js 与 src 分层源码同步（等价于 build.mjs --check）')

console.log('')
console.log('RESULT ' + (failed === 0 ? 'OK' : 'FAILED') + ' passed=' + passed + ' failed=' + failed)
for (const f of fails) console.log('  - ' + f)
process.exit(failed === 0 ? 0 : 1)
