// tools/lib/bundle.mjs —— 功能分包的唯一加载/门禁实现（build 与 check 共用）。
// 片段清单来自 src/manifest.mjs；这里只负责读、拼、静态门。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { preamble, modules } from '../../src/manifest.mjs'

export { preamble, modules }

const here = dirname(fileURLToPath(import.meta.url))
/** mycordis-v2 根目录。 */
export const v2Root = join(here, '..', '..')
const srcDir = join(v2Root, 'src')

/** 读取单个功能片段的原始文本（保留 CRLF 与缩进）。 */
export function readModule(mod) {
  return readFileSync(join(srcDir, mod.file), 'utf8')
}

/** 按 manifest 顺序拼出 host 半区源码：preamble + 各片段，无任何分隔符。 */
export function buildSource(mods = modules) {
  return preamble + mods.map(readModule).join('')
}

/** 顶层声明识别：只认行首无缩进的 function/const/let/var。 */
export const DECL_RE = /^(?:async\s+function|function|const|let|var)\s+([A-Za-z_$][\w$]*)/

export function declaredNames(fragment) {
  return fragment.split('\n').map((line) => DECL_RE.exec(line)).filter(Boolean).map((m) => m[1])
}

/**
 * 共享静态门（不执行代码，纯文本检查）。返回 { failures, declared }。
 *   A 片段不得含顶层 import/export（拼进函数体后非法）；
 *   B 顶层名字全局唯一（同处一个作用域，重名会互相覆盖）；
 *   C 每个片段的 provides 与代码里的顶层声明精确一致；
 *   D plugin 片段必须排在最后（它含顶层 return）。
 */
export function staticReport(mods = modules) {
  const failures = []
  const declared = []
  const seen = new Map()
  mods.forEach((mod, i) => {
    const frag = readModule(mod)
    frag.split('\n').forEach((line, n) => {
      if (/^(import|export)\b/.test(line)) {
        failures.push(mod.id + ' 第 ' + (n + 1) + ' 行含顶层 import/export：' + line.trim().slice(0, 60))
      }
    })
    const decls = declaredNames(frag)
    for (const name of decls) {
      if (seen.has(name)) failures.push('顶层名字重复：' + name + '（' + seen.get(name) + ' 与 ' + mod.id + '）')
      else seen.set(name, mod.id)
      declared.push(name)
    }
    const expect = [...(mod.provides || [])].sort()
    const actual = [...decls].sort()
    if (JSON.stringify(expect) !== JSON.stringify(actual)) {
      failures.push(mod.id + ' 的 provides 与代码不一致：清单 ' + JSON.stringify(expect) + '，代码 ' + JSON.stringify(actual))
    }
    if (mod.file === 'packages/plugin.js' && i !== mods.length - 1) failures.push('plugin 片段必须排在最后')
  })
  return { failures, declared }
}

/** 运行期结构门：能把 code 求值成带 apply 的 Cordis 插件对象。 */
export async function evaluatePlugin(code) {
  const plugin = await new Function('return (async () => {\n' + code + '\n})()')()
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
    throw new Error('host 半区未返回 { apply }')
  }
  return plugin
}
