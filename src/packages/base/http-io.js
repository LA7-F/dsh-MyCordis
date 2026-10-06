// [base/http-io] HTTP 底层 I/O：回包助手、请求体读取与上限、URL 拆分
function send(res, status, obj) {
  const body = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(body).length
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes, 'cache-control': 'no-store' })
  res.end(body)
}
function sendDownload(res, filename, obj) {
  const body = JSON.stringify(obj, null, 2)
  const bytes = new TextEncoder().encode(body).length
  const safeName = sanitizeFilename(filename)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes, 'content-disposition': 'attachment; filename="' + safeName + '"', 'cache-control': 'no-store' })
  res.end(body)
}
function sendHtml(res, html) {
  const bytes = new TextEncoder().encode(html).length
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': bytes, 'cache-control': 'no-store' })
  res.end(html)
}
// 请求体上限：防止超大 body 耗尽内存（DoS）
// 注意：README 里写的「10MB 请求体上限」与实际不符——此处以代码为准（80MB）。
// 它与页面 50MB 文件上限、uploadBundle 的 70MB base64 上限自洽：
// 50MB 原始数据 → base64≈66.7MB < 70MB < 80MB。
// 已决定不改这个常量；待同步的是 README 文案（不在本文件职责内）。
const MAX_BODY_BYTES = 80 * 1024 * 1024
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let total = 0
    let overflow = false
    let text = ''
    const td = new TextDecoder('utf-8')
    req.on('data', (c) => {
      if (overflow) return
      total += c.length
      if (total > MAX_BODY_BYTES) { overflow = true; reject(new Error('body-too-large')); return }
      try { text += td.decode(c, { stream: true }) } catch (e) { try { text += String(c) } catch (e2) { text += '' } }
    })
    req.on('end', () => {
      if (overflow) return
      try { text += td.decode() } catch (e) { /* ignore */ }
      resolvePromise(text)
    })
    req.on('error', reject)
  })
}
function parsePath(reqUrl) {
  const raw = String(reqUrl || '/')
  const q = raw.indexOf('?')
  return { path: q === -1 ? raw : raw.slice(0, q), query: q === -1 ? '' : raw.slice(q + 1) }
}
