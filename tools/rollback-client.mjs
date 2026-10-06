/**
 * 一键把 profile 里的 dsh-mycordis 还原成「纯 host」——client 半区把 web boot 弄挂时的救援脚本。
 *
 *   node mycordis-v2/tools/rollback-client.mjs [--profile desktop] [--dry]
 *
 * 幂等、不依赖 .bak 文件：
 *   - client.js 非空 → 重命名为 client.js.disabled-<UTC 时间戳>（先备份再清空）；
 *   - package.json 删除 exports 与 dsh.client，保留 dsh.bundle 等其它字段。
 * 跑完必须完全退出并重启 DeepSeek Harness。
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? fallback : v
}

const dry = process.argv.includes('--dry')
const profile = arg('--profile', 'desktop')
if (!/^[a-zA-Z0-9_-]{1,32}$/.test(profile)) { console.error('非法 profile: ' + profile); process.exit(2) }

const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
const pkgDir = join(home, 'profiles', profile, 'node_modules', 'dsh-mycordis')
if (!existsSync(pkgDir)) { console.error('目标包目录不存在：' + pkgDir); process.exit(3) }

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const changes = []

// 1) client.js
const clientPath = join(pkgDir, 'client.js')
if (existsSync(clientPath) && readFileSync(clientPath, 'utf8').trim() !== '') {
  const parked = clientPath + '.disabled-' + stamp
  changes.push({ label: 'client.js → ' + parked, apply: () => { renameSync(clientPath, parked); writeFileSync(clientPath, '', 'utf8') } })
} else console.log('  = client.js 已经是空的，跳过')

// 2) package.json
const pkgPath = join(pkgDir, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (pkg.exports !== undefined || (pkg.dsh && pkg.dsh.client !== undefined)) {
    const next = { ...pkg }
    delete next.exports
    if (next.dsh !== undefined) {
      next.dsh = { ...next.dsh }
      delete next.dsh.client
    }
    const text = JSON.stringify(next, null, 2) + '\n'
    changes.push({ label: 'package.json 去掉 exports / dsh.client', apply: () => writeFileSync(pkgPath, text, 'utf8') })
  } else console.log('  = package.json 已经是纯 host 形态，跳过')
}

console.log('profile   ' + profile)
console.log('target    ' + pkgDir)
if (changes.length === 0) { console.log('\n没有需要回滚的内容。'); process.exit(0) }
console.log('')
for (const c of changes) console.log('  将执行 ' + c.label)
if (dry) { console.log('\n[--dry] 磁盘未改动。'); process.exit(0) }
for (const c of changes) c.apply()
console.log('')
console.log('已回滚。下一步：完全退出并重启 DeepSeek Harness。')
