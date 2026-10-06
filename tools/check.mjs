// 只读校验：把 src/manifest.mjs 列出的功能分包在内存里拼成 host 半区并过结构门，不写任何文件。
// 并行改动期间请跑这个，不要跑 build.mjs（它会写 host.js，可能与其他 agent 竞争）。
import { buildSource, evaluatePlugin, modules, staticReport } from './lib/bundle.mjs'

const report = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); return ok }
let allOk = true
const verify = (ok, msg) => { allOk = report(ok, msg) && allOk }

// 门 0：静态结构
const { failures, declared } = staticReport()
verify(failures.length === 0, '功能分包静态结构（无顶层 import/export、顶层名唯一、provides 与代码一致）')
for (const f of failures) console.log('         - ' + f)
verify(modules.length > 0 && modules[modules.length - 1].id === 'plugin', 'plugin 入口排在最后：' + modules.map((m) => m.id).join(' → '))

const code = buildSource()

let plugin = null
try {
  plugin = await evaluatePlugin(code)
  verify(true, modules.length + ' 个功能分包拼接后可作为 async 函数体编译并求值')
} catch (error) {
  verify(false, '编译/求值失败: ' + (error && error.message))
}

if (plugin !== null) {
  verify(plugin !== null && typeof plugin === 'object', '返回对象')
  verify(typeof plugin.apply === 'function', '返回对象带 apply(ctx)')
  verify(Array.isArray(plugin.inject) && plugin.inject.indexOf('webServer') !== -1, 'inject 含 webServer（' + JSON.stringify(plugin.inject) + '）')
}

// 关键函数存在性（跨片段引用容易漏）
for (const name of ['esc', 'sq', 'send', 'parseOrigin', 'isTrustedRequest', 'buttonScript', 'pageHtml', 'pluginCurrentName', 'handleRequest', 'resolveDshCli', 'resolvePnpm']) {
  const present = new RegExp('function ' + name + '\\s*\\(').test(code)
  if (name === 'resolveDshCli' || name === 'resolvePnpm') {
    console.log((present ? '  ok   ' : '  note ') + '可选助手 ' + name + ' 存在: ' + present)
  } else {
    verify(present, 'function ' + name + ' 存在')
  }
}

console.log('')
console.log(allOk ? 'CHECK OK（' + code.length + ' code units，' + declared.length + ' 个顶层声明）' : 'CHECK FAILED')
process.exit(allOk ? 0 : 1)
