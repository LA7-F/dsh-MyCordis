// dev/tools/build.mjs —— 由 dev/src/packages/** 合成 lib/host.js，并先过三道门。
//
// 用法:
//   node dev/tools/build.mjs          重新生成 lib/host.js（写盘）
//   node dev/tools/build.mjs --check  只校验 src 与 lib/host.js 是否同步（不写盘，CI 友好）
//
// 门 0  静态结构（无顶层 import/export、顶层名唯一、provides 对账、分节标记、plugin 在最后）
// 门 0b 分层方向（不得引用上层）
// 门 1  拼接结果能被 new Function 编译并求值成 { apply }
// 门 2  inject 声明里含 webServer
import { readFileSync, writeFileSync } from 'node:fs'
import { buildSource, evaluatePlugin, staticReport, layerReport, hostPath, modules } from './lib/bundle.mjs'

const die = (msg) => { console.error('✘ ' + msg); process.exit(1) }

const { failures } = staticReport()
if (failures.length) {
  console.error('✘ 静态结构门未过：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

const { violations } = layerReport()
if (violations.length) {
  console.error('✘ 分层方向门未过：')
  for (const v of violations) console.error('  - ' + v)
  process.exit(1)
}

const code = buildSource()

let plugin
try {
  plugin = await evaluatePlugin(code)
} catch (error) {
  die('host 半区无法编译/求值：' + (error && error.message))
}

if (!Array.isArray(plugin.inject) || plugin.inject.indexOf('webServer') === -1) {
  die('inject 声明异常：' + JSON.stringify(plugin.inject))
}

const check = process.argv.includes('--check')
const summary = modules.length + ' 个片段 / ' + code.length + ' code units'

if (check) {
  let prev = null
  try { prev = readFileSync(hostPath, 'utf8') } catch { /* 尚无产物 */ }
  if (prev === null) die('--check：lib/host.js 不存在，请先跑 node dev/tools/build.mjs')
  if (prev !== code) die('--check：src 与 lib/host.js 不同步（产物 ' + prev.length + ' code units），请跑 node dev/tools/build.mjs')
  console.log('✓ --check：src 与 lib/host.js 同步（' + summary + '）')
} else {
  writeFileSync(hostPath, code, 'utf8')
  console.log('✓ 已生成 lib/host.js（' + summary + '，inject=' + JSON.stringify(plugin.inject) + '）')
}
