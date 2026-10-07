// [base/source-spec] 安装源规格（与 DSH 无关）：npm 包名校验、git 地址归一、凭据打码、类型名
// 安装源可以是未压缩文件夹 / git 仓库 / .tgz 文件 / npm 包名。这里只做**与 DSH 无关**的文本归一，
// 「这个路径在磁盘上是什么」由 install/source 问文件系统。
// 合法 npm 包名：首字符不能是 . 或 _，只允许小写字母/数字与 - . _（与 npm 自己的校验一致）。
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const PACKAGE_NAME_MAX = 214
function validPackageName(name) {
  const s = String(name === undefined || name === null ? '' : name).trim()
  return s.length > 0 && s.length <= PACKAGE_NAME_MAX && PACKAGE_NAME_RE.test(s)
}
// 回显用：带账号密码的 git URL（https://user:token@host/repo）把凭据打码。
function redactUrl(url) {
  const s = String(url === undefined || url === null ? '' : url)
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i.exec(s)
  return m === null ? s : m[1] + '***@' + s.slice(m[0].length)
}
/**
 * 归一 npm 的 git 写法：git+ 只是协议前缀（保留以表明是 git 源），git: 后面可能只有 owner/repo。
 *   owner/repo           -> git+https://github.com/owner/repo
 *   https://github.com/x -> git+https://github.com/x
 *   git+https://…        -> git+https://…（原样）
 *   git@host:x/y.git     -> git+git@host:x/y.git
 */
function normalizeGitSpec(rest) {
  let body = String(rest === undefined || rest === null ? '' : rest).trim()
  if (body === '') throw new Error('git 安装源缺仓库地址（可写 owner/repo、https://github.com/owner/repo 或 git+https://…）')
  const plus = /^git\+/i.test(body)
  const colon = /^git:/i.test(body)
  if (plus || colon) body = body.replace(/^git[:+]+/i, '')
  if (body === '') throw new Error('无法识别 git 安装源（git+ 后面是空的）')
  if (plus) return 'git+' + body
  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(body)
  if (m !== null) return 'git+https://github.com/' + m[1] + '/' + m[2]
  if (/^git@/.test(body)) return 'git+' + body
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(body)) return 'git+' + body
  if (colon) throw new Error('无法识别 git 安装源：' + body + '（可写 owner/repo、https://github.com/owner/repo 或 git+https://…）')
  return body
}
// 只认「明确的 git 写法」与 owner/repo 简写。http(s) 地址由调用方归到 git（见 resolveInstallSource），
// 这里刻意不认，免得把 npm 的 tarball URL（https://…/x-1.0.0.tgz）也当成 git 源。
function isGitSource(s) {
  return /^git[+:]|^git@/i.test(s) || /^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(s)
}
// 安装源类型的中文名（面板回显用）。
function kindTextOf(kind) {
  if (kind === 'local-dir') return '未压缩文件夹'
  if (kind === 'git') return 'git 仓库'
  if (kind === 'npm') return 'npm 包'
  return '本地安装包'
}
