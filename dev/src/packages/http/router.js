// [http/router] HTTP 路由表：请求分发、统一错误处理、各 API 端点
async function handleRequest(ctx, req, res) {
  try {
    if (!isTrustedRequest(req)) {
      send(res, 403, { ok: false, message: '请求被拒绝（Host 非 loopback 或 Origin 跨源）' })
      return
    }
    const u = parsePath(req.url)
    let path = u.path.replace(/^\/packer2/, '') || '/'
    if (path === '/') {
      if (req.method !== 'GET') { send(res, 405, { message: 'method not allowed' }); return }
      const embed = u.query.split('&').indexOf('embed=1') !== -1
      sendHtml(res, pageHtml(embed))
      return
    }
    if (path === '/api/plugins' && req.method === 'GET') {
      const d = listPlugins(ctx)
      send(res, 200, { ...d, defaultOutDir: (await workspaceRoot(ctx)) + '/packer2-out', activeProfile: await activeProfile(ctx) })
      return
    }
    if (path === '/api/sessions' && req.method === 'GET') {
      // D2：HTTP 请求没有 initiator；多会话并存时把存活会话摊给面板显式选择。
      // resolved = 服务端自动解析链当前的结果（非空说明本次请求其实不必手填）。
      const d = listSessions(ctx)
      send(res, 200, { ...d, resolved: await resolveCurrentSessionId(ctx) })
      return
    }
    if (path === '/api/snapshot' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await snapshotPlugin(ctx, String(body && body.pluginId || ''))) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/export' && req.method === 'GET') {
      const p = u.query
      const qs = {}
      try {
        p.split('&').forEach(function (kv) { const i = kv.indexOf('='); if (i > 0) qs[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)) })
      } catch (e) { send(res, 400, { ok: false, message: '查询参数不是合法编码' }); return }
      // 默认完整定义（host + client）；?pureHost=1 退回只导 host 半区（与 /api/export-batch 的 pureHost 对齐）。
      try { const data = sanitizePortable(exportDynamicPlugin(ctx, qs.pluginId, qs.packageId, qs.pureHost === '1' || qs.pureHost === 'true')); sendDownload(res, data.pluginId + '-' + data.packageId + '.dshplugin.json', data) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/export-batch' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await exportBatch(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/pack-batch' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await packBatch(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/pack-whole' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await packWhole(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/import' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      // 默认导入即运行（autoRun:false 可关）：旧行为「只注册不运行」正是「导入后不能运行」的来源。
      try { send(res, 200, await importDynamicPlugin(ctx, body, body === null || body.autoRun !== false)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/run' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await runDynamicPlugin(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/install' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await installBundle(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/upload' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await uploadBundle(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/installed' && req.method === 'GET') {
      const qs = {}
      try {
        u.query.split('&').forEach(function (kv) { const i = kv.indexOf('='); if (i > 0) qs[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)) })
      } catch (e) { send(res, 400, { ok: false, message: '查询参数不是合法编码' }); return }
      const profile = String(qs.profile || 'web')
      try { send(res, 200, await installedPlugins(ctx, profile)) } catch (e) { send(res, 200, { profile, error: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/uninstall' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await uninstallBundle(ctx, body)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/dedupe' && req.method === 'POST') {
      try { send(res, 200, await dedupePlugins(ctx)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/favorites' && req.method === 'GET') {
      try { send(res, 200, { ok: true, favorites: (await readFavorites(ctx)).favorites.map(function (f) { return { pluginId: f.pluginId, packageId: f.packageId, name: f.name, resident: f.resident === true } }) }) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/favorite' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try {
        if (body && body.action === 'remove') send(res, 200, await favoriteRemove(ctx, String(body.pluginId || '')))
        else if (body && body.action === 'resident') send(res, 200, await favoriteSetResident(ctx, String(body.pluginId || ''), String(body.packageId || ''), body.resident === true))
        else send(res, 200, await favoriteAdd(ctx, String(body.pluginId || ''), String(body.packageId || '')))
      } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/restore-one' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await restoreOne(ctx, String(body && body.pluginId || ''))) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/restore-favorites' && req.method === 'POST') {
      try { send(res, 200, await restoreFavorites(ctx)) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/browse' && req.method === 'GET') {
      const svc = ctx.get('directoryPicker')
      if (svc === undefined || typeof svc.capability !== 'function') { send(res, 200, { kind: 'none', reason: 'directoryPicker 服务不可用' }); return }
      const cap = svc.capability()
      if (cap.kind === 'native') { send(res, 200, { kind: 'native' }); return }
      if (cap.kind === 'browse') {
        let target
        try { target = u.query.startsWith('path=') ? decodeURIComponent(u.query.slice(5)) : undefined } catch (e) { target = undefined }
        if (target !== undefined && target !== '') {
          const ws = (await workspaceRoot(ctx)) || ''
          const tNorm = normPath(String(target)).toLowerCase()
          const wNorm = normPath(ws).toLowerCase()
          if (tNorm !== wNorm && !tNorm.startsWith(wNorm + '/')) { send(res, 200, { kind: 'browse', error: '路径超出工作区范围' }); return }
        }
        try { const listing = await cap.list(target === '' ? undefined : target); send(res, 200, { kind: 'browse', ...listing }); return } catch (e) { send(res, 200, { kind: 'browse', error: safeErrorMsg(e) }); return }
      }
      send(res, 200, { kind: 'none', reason: '未知 directoryPicker 后端: ' + cap.kind })
      return
    }
    if (path === '/api/browse/pick' && req.method === 'POST') {
      // 目录选择交给 DSH 自己的原生选择器（runtime/picker 调 directoryPicker.pick），本插件不再自跑 PowerShell。
      try { await readBody(req) } catch (e) {
        if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return }
      }
      const svc = ctx.get('directoryPicker')
      const cap = (svc !== undefined && typeof svc.capability === 'function') ? svc.capability() : undefined
      if (cap === undefined || cap.kind !== 'native') { send(res, 200, { picked: null, error: '原生目录选择不可用' }); return }
      try { const picked = await pickDirNative(cap); send(res, 200, { picked }) } catch (e) { send(res, 200, { picked: null, error: safeErrorMsg(e) }) }
      return
    }
    if (path === '/api/browse/create' && req.method === 'POST') {
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      const svc = ctx.get('directoryPicker')
      if (svc === undefined || typeof svc.capability !== 'function') { send(res, 200, { ok: false, message: 'directoryPicker 服务不可用' }); return }
      const cap = svc.capability()
      if (cap.kind !== 'browse') { send(res, 200, { ok: false, message: '当前后端不支持新建目录' }); return }
      try {
        const base = String((body && body.path) || '')
        const ws = (await workspaceRoot(ctx)) || ''
        const bNorm = normPath(base).toLowerCase()
        const wNorm = normPath(ws).toLowerCase()
        if (bNorm !== wNorm && !bNorm.startsWith(wNorm + '/')) { send(res, 200, { ok: false, message: '路径超出工作区范围' }); return }
        const created = await cap.createDirectory(base, String((body && body.name) || '')); send(res, 200, { ok: true, created }); return
      } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }); return }
    }
    if (path === '/api/pack' && req.method === 'POST') {
      let payload
      try { payload = JSON.parse(await readBody(req)) } catch (e) { if (String(e && e.message) === 'body-too-large') { send(res, 413, { ok: false, message: '请求体过大' }); return } send(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      try { send(res, 200, await packSessionPlugin(ctx, payload || {})) } catch (e) { send(res, 200, { ok: false, message: safeErrorMsg(e) }) }
      return
    }
    send(res, 404, { message: 'not found: ' + path })
  } catch (error) {
    const msg = String(error && error.message ? error.message : error)
    const status = msg === 'body-too-large' ? 413 : 500
    try { send(res, status, { ok: false, message: msg === 'body-too-large' ? '请求体过大' : safeErrorMsg(msg) }) } catch (e) { res.destroy() }
  }
}
