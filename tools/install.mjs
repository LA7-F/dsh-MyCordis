/**
 * 把仓库里的 host.js / client.js / package.json(dsh.client) 安装进 profile 的 dsh-mycordis 包目录。
 *
 *   node mycordis-v2/tools/install.mjs [--profile desktop] [--src <host.js>] [--dry] [--with-client]
 *
 * - 默认**只装 host.js**（安全：client 半区一旦激活失败，web boot 会直接弹「应用无法启动」）；
 * - --with-client 才额外安装 client.js 与 package.json 的 exports/dsh.client 声明；
 * - 幂等：每个文件内容相同就跳过；
 * - 覆盖前逐个备份为 <name>.bak-<UTC 时间戳>；
 * - package.json 只合并 exports 与 dsh.client（保留 profile 里其它字段，例如 dsh.bundle）；
 * - 目标目录在会话工作区之外，写入通常需要提升沙箱权限。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
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
const withClient = process.argv.includes('--with-client')
const profile = arg('--profile', 'desktop')
const srcPath = resolve(arg('--src', join(root, 'host.js')))
if (!/^[a-zA-Z0-9_-]{1,32}$/.test(profile)) { console.error('非法 profile: ' + profile); process.exit(2) }
if (!existsSync(srcPath)) { console.error('找不到构建产物 ' + srcPath + '，先跑 node mycordis-v2/tools/build.mjs'); process.exit(2) }

const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
const pkgDir = join(home, 'profiles', profile, 'node_modules', 'dsh-mycordis')

console.log('profile   ' + profile)
console.log('source    ' + srcPath)
console.log('target    ' + pkgDir)

if (!existsSync(pkgDir)) { console.error('目标包目录不存在：' + pkgDir + '（该 profile 未安装 dsh-mycordis？）'); process.exit(3) }

/** 待安装清单：内容与磁盘相同的不入列（幂等）。 */
const plan = []
function stage(name, dstPath, content, srcLabel) {
  let prev = null
  if (existsSync(dstPath)) prev = readFileSync(dstPath, 'utf8')
  if (prev === content) { console.log('  = ' + name + '（已是同一份内容，跳过）'); return }
  plan.push({ name, dstPath, content, prev, src: srcLabel })
}

// 1) host.js：host 半区构建产物
stage('host.js', join(pkgDir, 'host.js'), readFileSync(srcPath, 'utf8'), srcPath)

// 2) client.js：client 半区（页面侧自动装入 client-pending 的临时插件）
// 默认不装：client 半区激活失败会让整个 web boot 致命失败，回归前不要随手带上去。
const clientSrcPath = join(root, 'client.js')
if (!withClient) console.log('  - client.js（未加 --with-client，跳过）')
else if (!existsSync(clientSrcPath)) console.log('  - client.js（仓库里没有，跳过）')
else {
  const clientCode = readFileSync(clientSrcPath, 'utf8')
  if (clientCode.trim() === '') console.log('  - client.js（仓库版本为空，跳过）')
  else {
    if (!clientCode.includes('__ModuleLoader__')) console.warn('  ! client.js 里没有 __ModuleLoader__ —— 它可能不会被页面加载')
    stage('client.js', join(pkgDir, 'client.js'), clientCode, clientSrcPath)
  }
}

// 3) package.json：合并 exports 与 dsh.client，保留 profile 其它字段
const repoPkgPath = join(root, 'package.json')
const profilePkgPath = join(pkgDir, 'package.json')
if (!withClient) console.log('  - package.json（未加 --with-client，跳过 dsh.client 合并）')
else if (existsSync(repoPkgPath) && existsSync(profilePkgPath)) {
  const repoPkg = JSON.parse(readFileSync(repoPkgPath, 'utf8'))
  const curPkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  const merged = {
    ...curPkg,
    ...repoPkg.exports === undefined ? {} : { exports: repoPkg.exports },
    dsh: { ...(curPkg.dsh || {}), ...(repoPkg.dsh || {}) },
  }
  stage('package.json', profilePkgPath, JSON.stringify(merged, null, 2) + '\n', repoPkgPath)
}

if (plan.length === 0) { console.log('\n全部文件已是同一份内容，无需改动（幂等）。'); process.exit(0) }

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
console.log('')
for (const item of plan) {
  console.log('  将更新 ' + item.name + '  ← ' + item.src)
  if (item.prev !== null) console.log('        备份 → ' + item.dstPath + '.bak-' + stamp)
}

if (dry) { console.log('\n[--dry] 磁盘未改动。'); process.exit(0) }

for (const item of plan) {
  if (item.prev !== null) copyFileSync(item.dstPath, item.dstPath + '.bak-' + stamp)
  else mkdirSync(dirname(item.dstPath), { recursive: true })
  writeFileSync(item.dstPath, item.content, 'utf8')
  console.log('已写入 → ' + item.dstPath)
}
console.log('')
console.log('下一步（必须）：完全退出并重启 DeepSeek Harness —— host.js / client.js 都是启动期装载，改文件不热生效。')
console.log('回滚：把 <name>.bak-' + stamp + ' 复制回原名即可。')
