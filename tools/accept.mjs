/**
 * 一键验收：结构门 → 构建 → 回归测试 → 实测探针。
 *   node mycordis-v2/tools/accept.mjs [--live]
 * 无 --live 时跳过对 127.0.0.1:19387 的实测（需要 DSH 正在跑）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const run = (label, args) => {
  console.log('\n=== ' + label + ' ===')
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  return r.status === 0
}

const steps = []
steps.push(['结构门 check.mjs', ['tools/check.mjs']])
steps.push(['构建 host.js', ['tools/build.mjs']])

const routerTest = join(root, 'tests', 'host-router.test.mjs')
if (existsSync(routerTest)) steps.push(['回归测试', ['tests/host-router.test.mjs']])
else console.log('\n(跳过回归测试：tests/host-router.test.mjs 不存在)')

if (process.argv.includes('--live')) {
  const live = join(root, 'tests', 'live-e2e.mjs')
  if (existsSync(live)) steps.push(['实测探针 127.0.0.1:19387', ['tests/live-e2e.mjs']])
  else console.log('(跳过实测：tests/live-e2e.mjs 不存在)')
}

let failed = []
for (const [label, args] of steps) if (!run(label, args)) failed.push(label)

console.log('')
if (failed.length === 0) console.log('ACCEPT OK —— 全部步骤通过')
else { console.log('ACCEPT FAILED —— ' + failed.join(' / ')); process.exitCode = 1 }
