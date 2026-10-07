// dev/tests/smoke.test.mjs —— 零依赖回归门禁：直接对 dev/src/ 的分层片段做行为断言。
//
// 为什么能这样测：host 半区本来就是一个 async 函数体，拼接后的代码可以直接 new Function 求值。
// 这里先只取 base 层（与 DSH 无关的纯函数）拼成一个可调用对象来测语义，
// 再对完整产物做结构断言。跑法：
//   node dev/tests/smoke.test.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { modules, buildSource, evaluatePlugin, hostPath, srcDir } from '../tools/lib/bundle.mjs'

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
ok(baseMods.length === 4, 'base 层恰好 4 个片段')
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

// ── base/source-spec：安装源规格（文件夹 / git / npm 的归一） ────────────────
const specMods = modules.filter((m) => m.id === 'base/source-spec')
ok(specMods.length === 1, '安装源规格片段存在')
const SPEC_EXPORTS = '{ validPackageName, redactUrl, normalizeGitSpec, isGitSource, kindTextOf }'
const spec = await new Function('return (async () => {\n' + buildSource(specMods) + '\nreturn ' + SPEC_EXPORTS + ';\n})()')()

// validPackageName：中文目录名 / 缺失 name 就是 pnpm 报 INVALID_DEPENDENCY_NAME 的来源
ok(spec.validPackageName('dsh-mycordis'), '合法 npm 包名')
ok(spec.validPackageName('@scope/name'), 'scope 包名也合法')
ok(spec.validPackageName('my.plugin'), '含点的包名合法')
ok(!spec.validPackageName('插件开发'), '中文名不合法')
ok(!spec.validPackageName('MyPlugin'), '大写字母不合法')
ok(!spec.validPackageName('_hidden'), '下划线开头不合法')
ok(!spec.validPackageName('.hidden'), '点开头不合法')
ok(!spec.validPackageName(''), '空名不合法')
ok(!spec.validPackageName('a'.repeat(215)), '超长包名不合法')

// redactUrl：git URL 回显不许泄露账号密码
eq(spec.redactUrl('https://user:token@github.com/a/b.git'), 'https://***@github.com/a/b.git', 'redactUrl 打码账号密码')
eq(spec.redactUrl('https://github.com/a/b.git'), 'https://github.com/a/b.git', 'redactUrl 无凭据原样返回')
eq(spec.redactUrl('git+https://u:p@example.com/x'), 'git+https://***@example.com/x', 'redactUrl 认 git+ 前缀')

// normalizeGitSpec / isGitSource：git 安装源的归一
eq(spec.normalizeGitSpec('owner/repo'), 'git+https://github.com/owner/repo', 'owner/repo 简写按 GitHub 展开')
eq(spec.normalizeGitSpec('owner/repo.git'), 'git+https://github.com/owner/repo', '简写带 .git 也展开')
eq(spec.normalizeGitSpec('https://gitee.com/a/b.git'), 'git+https://gitee.com/a/b.git', 'http(s) 地址补 git+ 前缀')
eq(spec.normalizeGitSpec('git+https://github.com/a/b'), 'git+https://github.com/a/b', '已有的 git+ 原样返回')
eq(spec.normalizeGitSpec('git:https://github.com/a/b'), 'git+https://github.com/a/b', 'git: 前缀归一为 git+')
eq(spec.normalizeGitSpec('git@github.com:a/b.git'), 'git+git@github.com:a/b.git', 'ssh 简写补 git+ 前缀')
ok(spec.isGitSource('owner/repo'), 'owner/repo 识别为 git 源')
ok(spec.isGitSource('git+https://github.com/a/b'), 'git+ 识别为 git 源')
ok(spec.isGitSource('git:https://gitee.com/a/b'), 'git: 识别为 git 源')
ok(spec.isGitSource('git@github.com:a/b.git'), 'ssh 简写识别为 git 源')
ok(!spec.isGitSource('dsh-mycordis'), '普通包名不是 git 源')
ok(!spec.isGitSource('https://registry.npmjs.org/x/-/x-1.0.0.tgz'), 'npm tarball URL 不当成 git 源')
ok(!spec.isGitSource('E:/harness/dsh-MyCordis'), '盘符路径不是 git 源')

// kindTextOf：面板回显用的中文类型名
eq(spec.kindTextOf('local-dir'), '未压缩文件夹', 'local-dir 类型名')
eq(spec.kindTextOf('git'), 'git 仓库', 'git 类型名')
eq(spec.kindTextOf('npm'), 'npm 包', 'npm 类型名')
eq(spec.kindTextOf('local-file'), '本地安装包', 'local-file 类型名')
eq(spec.kindTextOf('unknown'), '本地安装包', '未知类型退回本地安装包')

// ── install/source：安装源识别（用假的 fs 服务，不碰真磁盘） ────────────────
// resolveInstallSource 需要 fs 与 shell 服务；这里只喂 fs（读 package.json / stat），
// shell 相关的兜底路径不会被走到，所以不注入 shell。
// 只取需要的片段（base/text → base/source-spec → install/source，与清单顺序一致）：
// 完整产物里的 runtime / cordis / ui 片段与本例无关，也不必在测试里桩掉它们的依赖。
const textModsForInstall = modules.filter((m) => m.id === 'base/text' || m.id === 'base/source-spec' || m.id === 'install/source')
const DISK = {
  '/work/my-plugin': { type: 'directory' },
  '/work/my-plugin/package.json': '{"name":"my-plugin","version":"1.2.3"}',
  '/work/packed': { type: 'directory' },
  '/work/packed/package.json': '{"name":"packed-plugin","version":"0.1.0","packer2":{"name":"我的插件","pluginId":"crd-9"}}',
  '/work/中文目录': { type: 'directory' },
  '/work/中文目录/package.json': '{"name":"中文包名","version":"1.0.0"}',
  '/work/no-manifest': { type: 'directory' },
  '/work/noname/package.json': '{"version":"1.0.0"}',
  '/work/noname': { type: 'directory' },
  '/work/x.tgz': { type: 'file' },
  '/work/x.dshplugin': { type: 'file' },
}
const fakeFs = {
  resolve: async (p) => p,
  processPath: (p) => p,
  stat: async (p) => { const e = DISK[p]; if (e === undefined) throw new Error('ENOENT'); return e },
  readText: async (p) => { const e = DISK[p]; if (typeof e !== 'string') throw new Error('ENOENT'); return e },
}
const fakeCtx = { get: (name) => (name === 'fs' ? fakeFs : undefined) }
const installApi = await new Function('return (async () => {\n' + buildSource(textModsForInstall) + '\nreturn { resolveInstallSource };\n})()')()

const rDir = await installApi.resolveInstallSource(fakeCtx, '/work/my-plugin', 'auto', undefined)
eq(rDir.kind, 'local-dir', '已存在的文件夹 → local-dir')
eq(rDir.spec, '/work/my-plugin', '文件夹安装源原样交给 dsh plugin add')
eq(rDir.detail, 'my-plugin@1.2.3', '文件夹详情取 package.json 的 name@version')
const rPacked = await installApi.resolveInstallSource(fakeCtx, '/work/packed', 'auto', undefined)
ok(rPacked.detail.indexOf('我的插件') !== -1 && rPacked.detail.indexOf('crd-9') !== -1, '面板打包产物优先显示 packer2 的中文名与 pluginId')
const rChinese = await installApi.resolveInstallSource(fakeCtx, '/work/中文目录', 'auto', undefined).then(() => '', (e) => e.message)
ok(rChinese.indexOf('INVALID_DEPENDENCY_NAME') !== -1, '中文包名在安装前就被拦下（说明 INVALID_DEPENDENCY_NAME 的来源）')
const rNoManifest = await installApi.resolveInstallSource(fakeCtx, '/work/no-manifest', 'auto', undefined).then(() => '', (e) => e.message)
ok(rNoManifest.indexOf('package.json') !== -1, '没有 package.json 的文件夹给出明确报错')
const rNoName = await installApi.resolveInstallSource(fakeCtx, '/work/noname', 'auto', undefined).then(() => '', (e) => e.message)
ok(rNoName.indexOf('name') !== -1, '缺 name 的 package.json 报错指向 name')
const rGitShort = await installApi.resolveInstallSource(fakeCtx, 'owner/repo', 'auto', undefined)
eq(rGitShort.kind, 'git', 'owner/repo → git')
eq(rGitShort.spec, 'git+https://github.com/owner/repo', 'owner/repo 展开为 git+https')
const rGitUrl = await installApi.resolveInstallSource(fakeCtx, 'https://gitee.com/a/b.git', 'auto', undefined)
eq(rGitUrl.spec, 'git+https://gitee.com/a/b.git', 'https 仓库地址补 git+ 前缀')
const rGitCred = await installApi.resolveInstallSource(fakeCtx, 'https://user:token@gitee.com/a/b.git', 'auto', undefined)
ok(rGitCred.detail.indexOf('token') === -1 && rGitCred.detail.indexOf('***@') !== -1, 'git 安装源回显时凭据已打码')
const rNpm = await installApi.resolveInstallSource(fakeCtx, 'dsh-mycordis', 'auto', undefined)
eq(rNpm.kind, 'npm', '普通包名 → npm')
const rNpmVer = await installApi.resolveInstallSource(fakeCtx, 'dsh-mycordis@0.1.1', 'auto', undefined)
eq(rNpmVer.kind, 'npm', '带版本号的包名 → npm')
const rTarball = await installApi.resolveInstallSource(fakeCtx, 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', 'auto', undefined)
eq(rTarball.kind, 'npm', 'npm tarball URL 留给 npm（不能被补成 git+https，否则装不上）')
eq(rTarball.spec, 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', 'npm tarball URL 原样传递')
const rRawUrl = await installApi.resolveInstallSource(fakeCtx, 'https://raw.example.com/x.tgz', 'auto', undefined)
eq(rRawUrl.spec, 'https://raw.example.com/x.tgz', '非 git 托管的 https 地址原样传递')
const rGitHost = await installApi.resolveInstallSource(fakeCtx, 'https://gitee.com/LA7_F/dsh-MyCordis', 'auto', undefined)
eq(rGitHost.spec, 'git+https://gitee.com/LA7_F/dsh-MyCordis', '已知 git 托管站的 https 地址补 git+ 前缀')
const rGenericGit = await installApi.resolveInstallSource(fakeCtx, 'https://git.example.com/a/b.git', 'auto', undefined)
eq(rGenericGit.spec, 'git+https://git.example.com/a/b.git', '以 .git 结尾的自建仓库地址补 git+ 前缀')
const rFileExists = await installApi.resolveInstallSource(fakeCtx, '/work/x.tgz', 'auto', undefined)
eq(rFileExists.kind, 'local-file', '已存在的 .tgz 文件 → local-file')
eq(rFileExists.spec, '/work/x.tgz', '.tgz 原样交给 dsh plugin add')
const rDshplugin = await installApi.resolveInstallSource(fakeCtx, '/work/x.dshplugin', 'auto', undefined)
eq(rDshplugin.kind, 'local-file', '.dshplugin → local-file（后续改名成 .tgz 再装）')
const rGitHint = await installApi.resolveInstallSource(fakeCtx, 'somewhere/that-does-not-exist', 'git', undefined)
eq(rGitHint.kind, 'git', 'sourceKind=git 时按 git 处理')
const rDash = await installApi.resolveInstallSource(fakeCtx, '-x', 'auto', undefined).then(() => '', (e) => e.message)
ok(rDash.indexOf('- 开头') !== -1, '拒绝以 - 开头的安装源（防被当成 pnpm 参数）')

// ── install/profile：导出已安装插件（假 fs / 假 shell，不碰真磁盘，也不真跑 pnpm） ──
// 片段子集按清单顺序取：install/profile 依赖 base → runtime → cordis 的全部提供者。
const EXPORT_IDS = ['base/text', 'base/security', 'base/source-spec', 'runtime/workspace', 'runtime/shell', 'runtime/cli', 'cordis/portable', 'cordis/pack', 'install/profile']
const exportMods = modules.filter((m) => EXPORT_IDS.indexOf(m.id) !== -1)
const exportApi = await new Function('return (async () => {\n' + buildSource(exportMods) + '\nreturn { installedPluginDir, installedPortable, exportInstalledPlugin, exportInstalledBatch, tarballNameOf, listProfiles, createProfile, targetProfile };\n})()')()

const HOME = 'C:/dshhome'
const WS = 'C:/work'
const OUT_DIR = WS + '/packer2-out'
const PKG_DIR = HOME + '/profiles/web/node_modules/packr-5'
const PLAIN_DIR = HOME + '/profiles/web/node_modules/plain-plugin'
const PKG_MANIFEST = JSON.stringify({ name: 'packr-5', version: '0.1.0', description: '演示包', packer2: { format: 1, name: '演示插件', purpose: '演示用', pluginId: 'crd-5', packageId: 'p9' } })
const HOST_SRC = 'return { apply: function () {} }'
const CLIENT_SRC = 'exports.apply = function () {}'
const OUT_TGZ = OUT_DIR + '/packr-5-0.1.0.tgz'
const FILES = {}
FILES[PKG_DIR + '/package.json'] = PKG_MANIFEST
FILES[PKG_DIR + '/host.js'] = HOST_SRC
FILES[PKG_DIR + '/client.js'] = CLIENT_SRC
FILES[PLAIN_DIR + '/package.json'] = JSON.stringify({ name: 'plain-plugin', version: '2.0.0' })
FILES[PLAIN_DIR + '/lib/index.js'] = 'export default {}'
// DSH bundle 布局：代码放 lib/（本插件自身就是这种：lib/host.js + lib/client.js）。
const LIB_DIR = HOME + '/profiles/web/node_modules/lib-halves-plugin'
FILES[LIB_DIR + '/package.json'] = JSON.stringify({ name: 'lib-halves-plugin', version: '3.1.0' })
FILES[LIB_DIR + '/lib/host.js'] = HOST_SRC
FILES[LIB_DIR + '/lib/client.js'] = CLIENT_SRC
// 已存在的 profile：createProfile 应当只探测、不调 CLI（幂等）。
FILES[HOME + '/profiles/existing/package.json'] = JSON.stringify({ name: 'dsh-profile-existing', private: true })
FILES[OUT_TGZ] = 'FAKE-TGZ-BYTES'
// 桩：假装放置目录里有 pnpm 垫片（resolvePnpm 的候选之一），别让测试依赖机器上真有 pnpm。
const EXISTS_EXTRA = [OUT_DIR, OUT_DIR + '/node_modules/.bin/pnpm']
const WRITES = []
const expFs = {
  resolve: async (p) => p,
  processPath: (p) => p,
  stat: async (p) => { if (EXISTS_EXTRA.indexOf(p) !== -1) return { type: 'directory' }; throw new Error('ENOENT') },
  readText: async (p) => { if (typeof FILES[p] === 'string') return FILES[p]; throw new Error('ENOENT') },
  readBytes: async (p) => new TextEncoder().encode(String(FILES[p] === undefined ? 'x' : FILES[p])),
  writeText: async (p, text) => { WRITES.push({ path: p, text }); return {} },
}
function shellRespond(cmd) {
  const out = (t) => ({ exitCode: 0, stdout: { text: t }, stderr: { text: '' } })
  if (cmd.indexOf('DSH_HOME') !== -1) return out(HOME)
  // profiles 目录清单：混进 node_modules / 点目录 / 非法名字，用来验 listProfiles 的过滤
  if (cmd.indexOf('Get-ChildItem -LiteralPath') !== -1 && cmd.indexOf('-Directory') !== -1) {
    return out(['web', 'desktop', 'node_modules', '.cache', 'bad name', 'web'].join('\n'))
  }
  if (cmd.indexOf('EXISTS') !== -1) {
    const m = /(?:Test-Path -LiteralPath|test -e) '([^']+)'/.exec(cmd)
    const p = m ? m[1] : ''
    // /node_modules/.bin/pnpm 一律当存在：resolvePnpm 的 wsHint 是「放置目录」，
    // 整包导出时它是子文件夹，写死具体路径会让桩在第二种格式上忽然失效。
    const hit = FILES[p] !== undefined || EXISTS_EXTRA.indexOf(p) !== -1 || /\/node_modules\/\.bin\/pnpm$/.test(p) || /\.tgz$/.test(p)
    return out(hit ? 'EXISTS' : '')
  }
  if (cmd.indexOf('Get-Content -Raw') !== -1 || cmd.indexOf('cat ') !== -1) {
    const m = /(?:Get-Content -Raw -Encoding UTF8 -LiteralPath|cat) '([^']+)'/.exec(cmd)
    return out(m && typeof FILES[m[1]] === 'string' ? FILES[m[1]] : '')
  }
  // createProfile 会走 resolveDshCli → probeOnPath('dsh')：给个假垫片让创建路径可测。
  if (cmd.indexOf('Get-Command dsh') !== -1 || cmd.indexOf('command -v dsh') !== -1) return out('C:/fake/dsh.cmd')
  if (cmd.indexOf('Get-Command pnpm') !== -1 || cmd.indexOf('command -v pnpm') !== -1) return out('')
  if (cmd.indexOf(' pack ') !== -1) {
    // 产物落在 --pack-destination 指定的目录里（整包导出时是子文件夹）。
    const m = /--pack-destination '([^']+)'/.exec(cmd)
    return out((m ? m[1] : OUT_DIR) + '/packr-5-0.1.0.tgz')
  }
  return out('')
}
const shellCalls = []
const fakeShell = {
  resolve: (spec) => { shellCalls.push(spec); return spec },
  execute: async (spec) => ({ result: async () => shellRespond(spec.command) }),
}
const exportCtx = {
  get(name) {
    if (name === 'fs') return expFs
    if (name === 'shell') return fakeShell
    if (name === 'agents') return { currentInitiator: () => ({ id: 'sess-1', session: { header: { cwd: WS } } }) }
    return undefined
  },
}

// profile 清单：只认合法目录名；node_modules（profiles 是 pnpm workspace 根）/ 点目录 / 带空格
// 的名字都不是 profile，重复项要去掉。
const profs = await exportApi.listProfiles(exportCtx)
eq(profs.ok, true, 'listProfiles 返回 ok')
eq(JSON.stringify(profs.profiles), JSON.stringify(['desktop', 'web']), 'listProfiles 过滤 node_modules / 点目录 / 非法名并去重排序')
eq(profs.active, '', '本测试的 ctx 推断不出当前 profile 时返回空串（界面退回原默认值）')

// 新建 profile（面板「新增」）：已存在 → 幂等；不存在 → 用 dsh plugin --profile <新名> list 触发
// dsh 自己的首次初始化（CLI 帮助原文 initialized on first use；pnpm list 只读、不装包）。
const profExisted = await exportApi.createProfile(exportCtx, 'existing')
eq(profExisted.ok, true, 'createProfile 对已存在的 profile 返回 ok')
eq(profExisted.created, false, '已存在的 profile 幂等返回 created:false（重复点「创建」不报错）')
const profBad = await exportApi.createProfile(exportCtx, '../x').then(() => '', (e) => e.message)
ok(profBad.indexOf('profile') !== -1, 'createProfile 拦住非法名字（名字同时是路径段，要防目录穿越）')
const profEmpty = await exportApi.createProfile(exportCtx, '').then(() => '', (e) => e.message)
ok(profEmpty.indexOf('profile') !== -1, 'createProfile 拦住空名字')
shellCalls.length = 0
const profNew = await exportApi.createProfile(exportCtx, 'myprof')
eq(profNew.ok, true, 'createProfile 新建成功')
eq(profNew.created, true, '新建的 profile 标记 created:true')

// 面板把 profile 字段删掉之后，所有入口都必须走 targetProfile：不给就用「当前部署」。
// 这条是整件事的关键——旧默认值 'web' 会把桌面版（desktop）的插件装到别的 profile 去。
eq(await exportApi.targetProfile(exportCtx, 'plugtest'), 'plugtest', '显式给 profile 就照用（HTTP API 那条路径还在）')
const tpBad = await exportApi.targetProfile(exportCtx, '../x').then(() => '', (e) => e.message)
ok(tpBad.indexOf('profile') !== -1, 'targetProfile 拦住非法 profile 名字（防目录穿越）')
eq(await exportApi.targetProfile(exportCtx, ''), 'web', '没给 profile 且推断不出当前部署时，才退回 web')
eq(await exportApi.targetProfile(exportCtx, undefined), 'web', 'undefined 同样退回 web（不会把 undefined 当名字用）')
const inferCtx = { get(name) { if (name === 'sandboxPolicy') return { resolve: () => ({ workspaceRoot: HOME + '/profiles/plugtest' }) }; return exportCtx.get(name) } }
eq(await exportApi.targetProfile(inferCtx, ''), 'plugtest', '没给 profile 时用「当前部署」——桌面版就是 desktop')
const createCalls = shellCalls.filter((s) => String(s.command).indexOf('plugin --profile') !== -1)
eq(createCalls.length, 1, 'createProfile 只跑一次 dsh plugin --profile')
ok(String(createCalls[0].command).indexOf("plugin --profile 'myprof' list") !== -1, '新建 profile 用 pnpm list 当那个「首次使用」（只读，不装包）')
eq(createCalls[0].sandboxPolicy.mode, 'danger-full-access', '写 $DSH_HOME 的命令显式放宽策略（与安装 / 卸载同一条规矩）')

// 已装包目录：<DSH_HOME>/profiles/<profile>/node_modules/<name>
eq(await exportApi.installedPluginDir(exportCtx, 'web', 'packr-5'), PKG_DIR, '已装包目录按 profile 的 node_modules 定位')
const badProfile = await exportApi.installedPluginDir(exportCtx, '../x', 'packr-5').then(() => '', (e) => e.message)
ok(badProfile.indexOf('profile') !== -1, '导出非法 profile 名被拦下')
const badName = await exportApi.installedPluginDir(exportCtx, 'web', '../secret').then(() => '', (e) => e.message)
ok(badName.indexOf('包名') !== -1, '导出非法包名被拦下（防目录穿越）')
const ghostDir = await exportApi.installedPluginDir(exportCtx, 'web', 'ghost').then(() => '', (e) => e.message)
ok(ghostDir.indexOf('找不到') !== -1, '没装过的包 / 基础层包给出明确报错而不是猜路径')
eq(base.safeErrorMsg(ghostDir), ghostDir, '报错里的路径用形状（<DSH_HOME>/…）而不是绝对路径：过脱敏后整句仍完整')

// tarball 命名：scoped 包按 npm 规则去 @ 并把 / 换成 -
eq(exportApi.tarballNameOf('packr-5', '0.1.0'), 'packr-5-0.1.0.tgz', '普通包名拼出 tarball 名')
eq(exportApi.tarballNameOf('@scope/name', '2.3.4'), 'scope-name-2.3.4.tgz', 'scoped 包拼出 scope-name-版本.tgz')

// 便携导出：形状与 exportDynamicPlugin 一致（脱敏会话 id、带上两个半区）
const port = await exportApi.installedPortable(exportCtx, PKG_DIR, JSON.parse(PKG_MANIFEST), { mode: 'danger-full-access' })
eq(port.__dshDynamicPlugin, true, '导出便携包带 __dshDynamicPlugin 标记')
eq(port.pluginId, 'crd-5', 'packer2 元数据的 pluginId 优先')
eq(port.packageId, 'p9', 'packer2 元数据的 packageId 优先')
eq(port.name, '演示插件', 'packer2 元数据里的中文名优先')
ok(String(port.ownerSessionId).indexOf('session-00000000-') === 0, 'ownerSessionId 脱敏成假 id（不泄露会话标识）')
eq(port.code.host, HOST_SRC, 'host 半区原样带上')
eq(port.code.client, CLIENT_SRC, 'client 半区原样带上')
const portFallback = await exportApi.installedPortable(exportCtx, PKG_DIR, { name: 'packr-5', version: '0.1.0', description: '演示包' }, { mode: 'danger-full-access' })
eq(portFallback.pluginId, 'packr-5', '没有 packer2 元数据时 pluginId 退回包名')
eq(portFallback.packageId, '0.1.0', '没有 packer2 元数据时 packageId 退回版本号')
eq(portFallback.purpose, '演示包', '没有 packer2 元数据时用途退回 description')
const plainPort = await exportApi.installedPortable(exportCtx, PLAIN_DIR, { name: 'plain-plugin', version: '2.0.0' }, { mode: 'danger-full-access' }).then(() => '', (e) => e.message)
ok(plainPort.indexOf('host.js') !== -1, '非 host/client 半区布局的包装不进便携包，明确拒绝并说明原因')
ok(plainPort.indexOf('lib/') !== -1, '拒绝时把「包根与 lib/ 都找过」讲清楚（本插件自身就是 lib/ 布局）')
const libPort = await exportApi.installedPortable(exportCtx, LIB_DIR, { name: 'lib-halves-plugin', version: '3.1.0' }, { mode: 'danger-full-access' })
eq(libPort.code.host, HOST_SRC, '半区在 lib/ 下的包（DSH bundle 约定）也能导出便携包')
eq(libPort.code.client, CLIENT_SRC, 'lib/ 下的 client 半区一并带上')
eq(libPort.pluginId, 'lib-halves-plugin', 'lib/ 布局且无 packer2 元数据时 pluginId 退回包名')
eq(libPort.packageId, '3.1.0', 'lib/ 布局且无 packer2 元数据时 packageId 退回版本号')

// 单个导出：tgz / portable / whole 三种格式
const badFmt = await exportApi.exportInstalledPlugin(exportCtx, { name: 'packr-5', profile: 'web', format: 'zip', outDir: OUT_DIR }).then(() => '', (e) => e.message)
ok(badFmt.indexOf('格式') !== -1, '未知导出格式被拦下')
const single = await exportApi.exportInstalledPlugin(exportCtx, { name: 'packr-5', profile: 'web', format: 'portable', outDir: OUT_DIR })
eq(single.ok, true, '导出便携包成功')
eq(single.portablePath, OUT_DIR + '/crd-5-p9.dshplugin.json', '便携包命名 = <插件ID>-<packageId>.dshplugin.json')
ok(WRITES.some((w) => w.path === single.portablePath && JSON.parse(w.text).__dshDynamicPlugin === true), '便携定义以 JSON 形式落到放置目录')
shellCalls.length = 0
const tgz = await exportApi.exportInstalledPlugin(exportCtx, { name: 'packr-5', profile: 'web', format: 'tgz', outDir: OUT_DIR })
eq(tgz.tgzName, 'packr-5-0.1.0.tgz', 'tgz 导出按包内版本号命名')
ok(/^[0-9a-f]{64}$/.test(tgz.sha256), 'tgz 导出附带 SHA-256')
const packCalls = shellCalls.filter((s) => String(s.command).indexOf(' pack ') !== -1)
eq(packCalls.length, 1, 'tgz 导出跑了一次 pnpm pack')
ok(String(packCalls[0].command).indexOf('pack --reporter append-only --pack-destination') !== -1, 'tgz 导出用 pnpm pack --pack-destination')
eq(packCalls[0].workdir, PKG_DIR, 'pnpm pack 的 cwd = 已装包目录（导出的是装好的那一份）')
eq(packCalls[0].sandboxPolicy.mode, 'danger-full-access', '已装目录在工作区外的 $DSH_HOME 下：命令显式放宽策略')
const whole = await exportApi.exportInstalledPlugin(exportCtx, { name: 'packr-5', profile: 'web', format: 'whole', outDir: OUT_DIR })
eq(whole.dir, OUT_DIR + '/packr-5-0.1.0', '整包一插件一子文件夹')
eq(whole.tgzPath, OUT_DIR + '/packr-5-0.1.0/packr-5-0.1.0.tgz', '整包里的安装包落在子文件夹')
eq(whole.portablePath, OUT_DIR + '/packr-5-0.1.0/crd-5-p9.dshplugin.json', '整包里的便携包落在子文件夹')
// 整包遇上「没有 host/client 半区」的包（普通 Cordis 组合插件）：tgz 已经打好了，
// 不能因为便携半区做不出来就把整条判失败——那会让用户以为什么都没导出。
const wholePlain = await exportApi.exportInstalledPlugin(exportCtx, { name: 'plain-plugin', profile: 'web', format: 'whole', outDir: OUT_DIR })
eq(wholePlain.ok, true, '整包：便携半区做不出来时不把已打好的 .tgz 一起判死')
ok(String(wholePlain.tgzPath || '').indexOf('plain-plugin') !== -1, '整包仍然交出 .tgz 产物')
ok(String(wholePlain.portableError || '').indexOf('host.js') !== -1, '缺的那半记成 portableError（面板按警告渲染）')
eq(wholePlain.portablePath, undefined, '便携半区失败时不谎报 portablePath')
// 「只要便携包」仍然必须失败：它没有任何可交付的产物，不能悄悄成功。
const onlyPortable = await exportApi.exportInstalledPlugin(exportCtx, { name: 'plain-plugin', profile: 'web', format: 'portable', outDir: OUT_DIR }).then(() => '', (e) => e.message)
ok(onlyPortable.indexOf('host.js') !== -1, '只要便携包时依旧明确失败（没有 tgz 可退）')

// 批量：单个失败不影响其余；空清单明确报错
const batch = await exportApi.exportInstalledBatch(exportCtx, { profile: 'web', format: 'portable', outDir: OUT_DIR, plugins: [{ name: 'packr-5' }, { name: 'ghost' }] })
eq(batch.results.length, 2, '批量导出逐项收结果')
eq(batch.results[0].ok, true, '批量导出里成功的项标记 ok')
eq(batch.results[1].ok, false, '批量导出里失败的项不抛错、标记失败')
const batchEmpty = await exportApi.exportInstalledBatch(exportCtx, { plugins: [] }).then(() => '', (e) => e.message)
ok(batchEmpty.indexOf('未勾选') !== -1, '批量导出没给插件时明确报错')

// ── ui/page：生成出来的面板 JS 必须语法合法、且引用的元素 id 都存在 ─────────
// 面板整段是模板字符串：\d / \. / \\ 之类写错会生成非法 JS，整页 <script> 解析失败
// 后**静默白屏**（没有报错、没有日志）。这里把模板求值一次，把生成的 JS 再解析一次。
const pageMods = modules.filter((m) => m.id === 'ui/page')
ok(pageMods.length === 1, 'ui/page 片段存在')
const pageHtmlFn = await new Function('return (async () => {\n' + buildSource(pageMods) + '\nreturn pageHtml;\n})()')()
const panelHtml = pageHtmlFn(false)
const scriptOpen = panelHtml.indexOf('<script>')
const scriptClose = panelHtml.lastIndexOf('</script>')
ok(scriptOpen !== -1 && scriptClose > scriptOpen, '面板 HTML 含 <script> 块')
const panelJs = panelHtml.slice(scriptOpen + '<script>'.length, scriptClose)
let panelJsOk = true
try { new Function(panelJs) } catch (e) { panelJsOk = false }
ok(panelJsOk, '面板内联 JS 语法合法（模板转义没写坏）')
// 每个 $(\'id\') / getElementById(\'id\') 引用的 id 都要在 HTML 里真实存在。
const idRefs = []
const idRe = /\$\(\s*'([A-Za-z][\w-]*)'\s*\)/g
let m
while ((m = idRe.exec(panelJs)) !== null) if (idRefs.indexOf(m[1]) === -1) idRefs.push(m[1])
const missingIds = idRefs.filter((id) => panelHtml.indexOf('id="' + id + '"') === -1)
ok(missingIds.length === 0, '面板 JS 引用的元素 id 都存在（缺：' + missingIds.join(', ') + '）')
// 面板 JS 里的单引号字符串不能被模板吞掉：抽查关键字面量仍然存在。
ok(panelJs.indexOf("'/install'") !== -1, '面板 JS 保留 /install 请求路径')
ok(panelJs.indexOf('ipath') !== -1 && panelHtml.indexOf('id="ipath"') !== -1, '安装地址栏 ipath 在 HTML 与 JS 两侧都在')
// 面板不再有 profile 选择：目标 profile 固定是「当前部署」，由后端 targetProfile 解析。
ok(panelHtml.indexOf('id="iprofile"') === -1 && panelHtml.indexOf('id="mprofile"') === -1, '面板不再有 profile 输入框（选择功能已删）')
ok(panelHtml.indexOf('id="pfMenu"') === -1 && panelHtml.indexOf('<datalist') === -1, 'profile 下拉与 datalist 都已删除')
ok(panelJs.indexOf("'/profile-create'") === -1, '面板不再调用 /api/profile-create（下拉删除后已无入口）')
// ① 的格局也定死成一行：安装源框 → 选择文件 → 安装；文件夹 / 安装包两个入口收进「选择文件」的下拉。
const ipathAt = panelHtml.indexOf('id="ipath"')
const ibtnAt = panelHtml.indexOf('id="ibtn"')
ok(ipathAt !== -1 && ibtnAt > ipathAt, '安装源框与安装按钮都在面板里')
const rowStart = panelHtml.lastIndexOf('<div class="row" style="margin-top:0">', ipathAt)
ok(rowStart !== -1, '① 的安装行开头能定位到')
const installRow = panelHtml.slice(rowStart, panelHtml.indexOf('</div>', ibtnAt))
ok(installRow.indexOf('id="ibtn"') !== -1, '安装源框 / 选择文件 / 安装 同处一行（没被拆成两行）')
const rowOrder = ['id="ipath"', 'id="ipick"', 'id="ipathPick"', 'id="ifilebtn"', 'id="ibtn"'].map((t) => installRow.indexOf(t))
ok(rowOrder.every((v, i) => v !== -1 && (i === 0 || v > rowOrder[i - 1])), '行内顺序是 安装源框 → 选择文件 →（下拉：文件夹 / 安装包）→ 安装')
ok(panelHtml.indexOf('>选择文件夹…</button>') === -1 && panelHtml.indexOf('>选择 .tgz 文件…</button>') === -1, '「选择文件夹…」「选择 .tgz 文件…」两颗行内按钮已合并掉')
ok(panelHtml.indexOf('<button id="ipick"') !== -1 && panelHtml.indexOf('选择文件<span class="caret">') !== -1, '合并后的按钮字面就叫「选择文件」（带下拉箭头）')
const instBtns = (installRow.match(/<button[^>]*>/g) || []).map((t) => (/id="([^"]+)"/.exec(t) || [])[1]).filter(Boolean)
eq(instBtns.join(','), 'ipick,ipathPick,ifilebtn,ibtn', '① 行内按钮只有「选择文件」「安装」，两个选择入口都在下拉菜单里')
ok(installRow.indexOf('id="ipickMenu"') !== -1 && /<div id="ipickMenu" class="popmenu" hidden/.test(panelHtml), '下拉菜单默认收起（hidden）')
// 模板字符串里出现**单个**反斜杠就会被当转义序列吃掉（\h / \d 直接变 h / d，页面上少一个 \），
// 所以 page.js 里的每个反斜杠都必须是成对的 \\。用源码而不用产物判（产物已经解释过一次）。
const pageSrc = readFileSync(join(srcDir, 'packages', 'ui', 'page.js'), 'utf8')
const BS = String.fromCharCode(92)
const oddBackslash = pageSrc.split(/\r?\n/).filter((l) => l.replace(new RegExp(BS + BS, 'g'), '').indexOf(BS) !== -1)
ok(oddBackslash.length === 0, 'page.js 模板里没有落单的反斜杠（否则渲染时会吞字符）：' + oddBackslash.slice(0, 2).join(' | '))

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
