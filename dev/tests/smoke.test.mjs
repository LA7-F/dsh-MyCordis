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
