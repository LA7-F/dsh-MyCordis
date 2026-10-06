// [base/text] 通用文本与标识工具：HTML 转义、跨平台 shell 引用、随机标识
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
// 宿主平台判定：DSH 桌面/Node 宿主一定给得出 process；拿不到时按 Windows 处理（保持旧行为）。
// 「便携包」以前写死了 pwsh 的 New-Item/Remove-Item/Get-FileHash，非 Windows 直接失败；
// 有了这个判据，打包相关命令可以按平台各写一份，才算通用。
function isWindowsHost() {
  const proc = typeof process === 'undefined' ? undefined : process
  if (proc === undefined || typeof proc.platform !== 'string') return true
  return proc.platform === 'win32'
}
// 跨平台单引号引用：pwsh 把内部的 ' 翻倍即可；POSIX sh 单引号内无法转义，需写成 '\'' 拼接。
function sq(p) {
  const s = String(p)
  if (isWindowsHost()) return "'" + s.replace(/'/g, "''") + "'"
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
function rand() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}
