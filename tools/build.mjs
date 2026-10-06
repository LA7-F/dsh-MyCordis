// 由 src/manifest.mjs 列出的功能分包合成单文件 host.js（一个 async 函数体），并做结构门。
// 用法: node tools/build.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSource, evaluatePlugin, staticReport, v2Root } from './lib/bundle.mjs'

// 门 0：功能分包的静态结构（片段无 import/export、顶层名唯一、provides 与代码一致）
const { failures, declared } = staticReport()
if (failures.length) {
  console.error('✘ 功能分包结构门未过：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

const code = buildSource()

// 门 1：能被 new Function 编译/求值
let plugin
try {
  plugin = await evaluatePlugin(code)
} catch (error) {
  console.error('✘ host 半区无法编译/求值: ' + (error && error.message))
  process.exit(1)
}
// 门 2：inject 声明
const inject = plugin.inject
if (!Array.isArray(inject) || inject.indexOf('webServer') === -1) {
  console.error('✘ inject 声明异常: ' + JSON.stringify(inject))
  process.exit(1)
}

const target = join(v2Root, 'host.js')
const check = process.argv.includes('--check')
if (check) {
  let prev = null
  try { prev = readFileSync(target, 'utf8') } catch { /* 无既有产物 */ }
  if (prev !== null && prev !== code) {
    console.error('✘ --check：src 与 host.js 不同步，请运行 node tools/build.mjs')
    process.exit(2)
  }
  console.log('✓ --check：src 与 host.js 同步（' + code.length + ' code units，' + declared.length + ' 个顶层声明）')
} else {
  writeFileSync(target, code, 'utf8')
  console.log('✓ 已生成 host.js（' + code.length + ' code units，inject=' + JSON.stringify(inject) + '）')
}
