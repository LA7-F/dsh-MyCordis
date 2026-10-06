// dev/tools/check.mjs —— 只读门禁：把 dev/src 的分层片段在内存里拼成 host 半区并过全部结构门。
//
// 与 build.mjs 的区别：**绝不写盘**。多人/多 agent 同时改不同片段时跑这个。
import { buildSource, evaluatePlugin, staticReport, layerReport, modules } from './lib/bundle.mjs'

let allOk = true
const ok = (pass, msg) => { console.log((pass ? '  ok   ' : '  FAIL ') + msg); if (!pass) allOk = false }

const { failures, declared } = staticReport()
ok(failures.length === 0, '静态结构门（无顶层 import/export、顶层名唯一、provides 对账、分节标记、plugin 在最后）')
for (const f of failures) console.log('         - ' + f)

const { violations } = layerReport()
ok(violations.length === 0, '分层方向门（片段只引用自己或更早的层）')
for (const v of violations) console.log('         - ' + v)

ok(modules.length > 0 && modules[modules.length - 1].id === 'plugin', 'plugin 排在最后：' + modules.map((m) => m.id).join(' → '))

const code = buildSource()

let plugin = null
try {
  plugin = await evaluatePlugin(code)
  ok(true, modules.length + ' 个片段拼接后可作为 async 函数体编译并求值')
} catch (error) {
  ok(false, '编译/求值失败：' + (error && error.message))
}

if (plugin !== null) {
  ok(typeof plugin.apply === 'function', '返回对象带 apply(ctx)')
  ok(Array.isArray(plugin.inject) && plugin.inject.indexOf('webServer') !== -1, 'inject 含 webServer（' + JSON.stringify(plugin.inject) + '）')
}

// 跨片段引用最容易漏：逐层抽查每个片段对外承诺的名字都真的在产物里
for (const name of ['esc', 'sq', 'send', 'parseOrigin', 'isTrustedRequest', 'normPath', 'sanitizeFilename', 'safeErrorMsg', 'workspaceRoot', 'workspaceWritePolicy', 'runShell', 'ensureDir', 'resolveDshCli', 'resolvePnpm', 'handleRequest', 'buttonScript', 'pageHtml', 'pluginCurrentName', 'readPluginFromTgz', 'packWhole', 'importDynamicPlugin', 'installBundle']) {
  ok(new RegExp('function ' + name + '\\s*\\(').test(code), 'function ' + name + ' 存在')
}

console.log('')
console.log(allOk
  ? 'CHECK OK（' + modules.length + ' 个片段，' + code.length + ' code units，' + declared.length + ' 个顶层声明）'
  : 'CHECK FAILED')
process.exit(allOk ? 0 : 1)
