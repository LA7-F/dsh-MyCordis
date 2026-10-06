// dev/tools/lib/bundle.mjs —— 分层片段的唯一加载与门禁实现（build / check 共用）。
//
// 本文件不写盘：读 dev/src/manifest.mjs → 依序拼接 → 过静态门；写盘只发生在 build.mjs。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { preamble, layers, modules } from '../../src/manifest.mjs'

export { preamble, layers, modules }

const here = dirname(fileURLToPath(import.meta.url))

/** 仓库根目录（dev/tools/lib/ 往上三级）。 */
export const repoRoot = join(here, '..', '..', '..')
/** 分层源码目录（dev/src）。 */
export const srcDir = join(repoRoot, 'dev', 'src')
/** 构建产物：随包分发的 host 半区。 */
export const hostPath = join(repoRoot, 'lib', 'host.js')

/** 读取单个片段的原始文本（不改换行、不改缩进）。 */
export function readModule(mod) {
  return readFileSync(join(srcDir, mod.file), 'utf8')
}

/** 依序拼出 host 半区源码：preamble + 各片段，无任何分隔符。 */
export function buildSource(mods = modules) {
  return preamble + mods.map(readModule).join('')
}

/** 顶层声明识别：只认行首无缩进的 function / const / let / var。 */
export const DECL_RE = /^(?:async\s+function|function|const|let|var)\s+([A-Za-z_$][\w$]*)/

export function declaredNames(fragment) {
  return fragment
    .split('\n')
    .map((line) => DECL_RE.exec(line))
    .filter(Boolean)
    .map((m) => m[1])
}

/**
 * 静态门（纯文本，不执行代码）。返回 { failures, declared }：
 *   A 片段不得含顶层 import / export（拼进函数体后非法）；
 *   B 顶层名字全插件唯一（同处一个作用域，重名会静默互相覆盖）；
 *   C 每个片段的 provides 与代码里的顶层声明精确一致；
 *   D 首行必须是自己的分节标记 `// [id] role`（产物可自解释，切分可复现）；
 *   E plugin 必须排在最后（它含顶层 return）。
 */
export function staticReport(mods = modules) {
  const failures = []
  const declared = []
  const seen = new Map()

  mods.forEach((mod, i) => {
    const frag = readModule(mod)
    const lines = frag.split('\n')

    lines.forEach((line, n) => {
      if (/^(import|export)\b/.test(line)) {
        failures.push(mod.id + ' 第 ' + (n + 1) + ' 行含顶层 import/export：' + line.trim().slice(0, 60))
      }
    })

    const expectedMarker = '// [' + mod.id + '] ' + mod.role
    if (lines[0].replace(/\r$/, '') !== expectedMarker) {
      failures.push(mod.id + ' 首行不是分节标记，期望：' + expectedMarker)
    }

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

    if (mod.id === 'plugin' && i !== mods.length - 1) failures.push('plugin 片段必须排在最后')
  })

  return { failures, declared }
}

/** 层序：拼接顺序即层序。同层内不论先后，跨层只能向下引用。 */
export const LAYER_ORDER = ['base', 'runtime', 'cordis', 'install', 'ui', 'http', 'plugin']

export function layerOf(id) {
  const at = LAYER_ORDER.indexOf(String(id).split('/')[0])
  return at === -1 ? LAYER_ORDER.length : at
}

/** 去掉行注释与块注释：注释里提到上层函数名不算依赖。 */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * 分层方向门：片段只能引用**同层或更早层**提供的顶层名字。
 *   · 同层内的先后顺序不算违规——拼接后同处一个作用域，函数声明会提升；
 *   · 跨层反向引用（底层调上层）即使语法合法，运行期也一定拿不到，必须拦下。
 */
export function layerReport(mods = modules) {
  const owner = new Map()
  mods.forEach((mod) => (mod.provides || []).forEach((name) => owner.set(name, mod.id)))
  const violations = []
  for (const mod of mods) {
    const code = stripComments(readModule(mod))
    const mine = new Set(mod.provides || [])
    for (const [name, ownerId] of owner) {
      if (mine.has(name)) continue
      if (layerOf(ownerId) <= layerOf(mod.id)) continue
      if (new RegExp('\\b' + name + '\\b').test(code)) {
        violations.push(mod.id + ' 引用了更上层的 ' + ownerId + ' 的 ' + name + '（层序：' + LAYER_ORDER.join(' → ') + '）')
      }
    }
  }
  return { violations }
}

/** 运行期结构门：能把 code 求值成带 apply 的 Cordis 插件对象。 */
export async function evaluatePlugin(code) {
  const plugin = await new Function('return (async () => {\n' + code + '\n})()')()
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
    throw new Error('host 半区未返回 { apply }')
  }
  return plugin
}
