// tests/_harness.mjs —— 测试专用加载器 + 最小桩（零依赖）
// 按 src/manifest.mjs 的功能分包清单拼接加载；刻意不读 host.js（构建产物可能落后于 src）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve as resolvePath } from 'node:path'
import http from 'node:http'
import os from 'node:os'
import { preamble, modules } from '../src/manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src')
const moduleById = new Map(modules.map((m) => [m.id, m]))

/** 按 manifest 顺序读取所有功能片段（与 tools/build.mjs 完全一致的加载法）。 */
export function readParts() {
  return modules.map((m) => readFileSync(join(srcDir, m.file), 'utf8'))
}
/** 单个功能片段的原始文本；id 见 src/manifest.mjs（如 'base/security'）。 */
export function readModule(id) {
  const mod = moduleById.get(id)
  if (mod === undefined) throw new Error('manifest 里没有模块: ' + id)
  return readFileSync(join(srcDir, mod.file), 'utf8')
}
export function selfSource() {
  return preamble + readParts().join('')
}
export function hasFunction(name) {
  return new RegExp('function\\s+' + name + '\\s*\\(').test(selfSource())
}
export function tempDir(prefix = 'mycordis-test-') {
  return mkdtempSync(join(os.tmpdir(), prefix))
}

/** 加载插件：返回 { inject, apply }。 */
export async function loadPlugin() {
  const code = selfSource()
  return await new Function('return (async () => {\n' + code + '\n})()')()
}

/**
 * 单独求值「安全 + HTTP I/O」两个功能片段并取回内部函数。
 * 两个片段都只有声明、没有顶层 return，所以可以安全地追加一个 return。
 */
export async function loadCoreInternals() {
  const code = readModule('base/security') + readModule('base/http-io')
  const names = ['isTrustedRequest', 'parseOrigin', 'parseAuthority', 'isLoopbackHostname', 'defaultPort', 'MAX_BODY_BYTES']
  const pairs = names.map((n) => n + ": (typeof " + n + " !== 'undefined' ? " + n + ' : undefined)')
  const tail = '\nreturn { ' + pairs.join(', ') + ' }\n'
  return await new Function('return (async () => {\n' + code + tail + '})()')()
}
/** 静默插件里的 console；返回恢复函数。测试输出请用 process.stdout.write。 */
export function silenceConsole() {
  const saved = {}
  const noop = () => {}
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
    saved[k] = console[k]
    console[k] = noop
  }
  return () => { for (const k of Object.keys(saved)) console[k] = saved[k] }
}

// ── 服务桩 ────────────────────────────────────────────────────────────────
const MANIFEST_FIXTURE = JSON.stringify({
  name: 'desktop',
  dependencies: { 'dsh-mycordis': 'file:./dsh-mycordis', '@deepseek-ai/dsh-base': '^0.2.0-rc.2' },
  dsh: { profile: { bundles: ['dsh-mycordis'] } },
}, null, 2)

/** fs 桩：resolve/processPath/readText/writeText 落到真实文件系统（默认临时目录）。 */
export function makeFsStub(root) {
  const abs = (p) => resolvePath(String(p))
  return {
    root,
    resolve: async (p) => abs(p),
    processPath: (t) => String(t),
    readText: async (t) => readFileSync(abs(t), 'utf8'),
    writeText: async (t, content) => {
      const f = abs(t)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, String(content), 'utf8')
    },
  }
}

/**
 * shell 桩：记录每条命令，并按命令文本给出可预测输出。
 *  - Get-Content *package.json → 返回 profile manifest 夹具
 *  - Test-Path '<...>/apps/cli/lib/bin.js' → 依据该路径是否真实存在返回 True/False
 *  - DSH_HOME 探测 → 返回假 home
 */
export function makeShellStub(record) {
  return {
    resolve(spec) {
      record.push({ command: String((spec && spec.command) || ''), workdir: spec && spec.workdir, sandboxPolicy: spec && spec.sandboxPolicy })
      return { ...spec }
    },
    execute(spec) {
      const command = String((spec && spec.command) || '')
      let text = ''
      if (/Get-Content/.test(command) && /package\.json/.test(command)) text = MANIFEST_FIXTURE
      else if (/\$env:DSH_HOME/.test(command)) text = 'C:\\Users\\test\\.dsh'
      else if (/Test-Path/.test(command)) {
        const quoted = [...command.matchAll(/(['"])(.*?)\1/g)].map((m) => m[2])
        text = quoted.some((p) => { try { return existsSync(p) } catch (e) { return false } }) ? 'True' : 'False'
      }
      return Promise.resolve({ result: async () => ({ exitCode: 0, stdout: { text }, stderr: { text: '' } }) })
    },
  }
}

/** dynamicCordisRunner 桩。 */
export function makeRunnerStub(rows = []) {
  const list = rows.slice()
  return {
    inventory: () => list,
    inspectPackage: (owner, pluginId) => {
      const row = list.find((r) => String(r.pluginId) === String(pluginId)) || {}
      return { pluginId: String(pluginId), name: row.name || String(pluginId), purpose: 'test-purpose', code: { host: '// host half\n', client: '' } }
    },
    define: () => ({ pluginId: 'p-new', packageId: 'pk-new' }),
    run: async () => ({}),
    undefine: async () => ({ ok: true }),
  }
}

/**
 * 最小 ctx 桩。
 * overrides:
 *   workspaceRoot? —— 兜底工作区（临时目录）
 *   runnerRows?    —— dynamicCordisRunner 桩数据
 *   agents?        —— B9：整个 agents 服务桩（传 null 表示该服务缺失 -> get('agents') === undefined）
 *   sandboxPolicy? —— B9：整个 sandboxPolicy 服务桩（默认带官方形状的 resolve()）
 *   services?      —— 其他同名服务整体覆盖（最后展开，优先级最高）
 */
export function makeCtx(overrides = {}) {
  const ws = overrides.workspaceRoot || tempDir('mycordis-ws-')
  const shellCommands = []
  const listeners = new Map()
  const disposers = []
  const registeredRoutes = []
  const hasAgents = Object.prototype.hasOwnProperty.call(overrides, 'agents')
  const services = {
    sandboxPolicy: overrides.sandboxPolicy || { workspaceRoot: ws, resolve: () => ({ mode: 'workspace-write', workspaceRoot: ws }) },
    fs: makeFsStub(ws),
    shell: makeShellStub(shellCommands),
    directoryPicker: { capability: () => ({ kind: 'native', pick: async () => null }) },
    // B9：官方 agents 服务有 currentInitiator()/roots()；默认桩给出的 agent 不带 session.header.cwd，
    // 所以默认仍是「退回 sandboxPolicy」。用例可注入带 cwd 的 agent 桩来验证新解析链。
    agents: overrides.agents === null ? undefined : (hasAgents ? overrides.agents : { currentInitiator: () => ({ id: 'session-test' }), roots: () => [{ id: 'session-test' }] }),
    dynamicCordisRunner: makeRunnerStub(overrides.runnerRows || []),
    ...(overrides.services || {}),
  }
  const ctx = {
    workspaceRoot: ws,
    shellCommands,
    registeredRoutes,
    handler: undefined,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, fn) {
      const arr = listeners.get(name) || []
      arr.push(fn)
      listeners.set(name, arr)
      return () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1) }
    },
    effect(fn, label) {
      const d = typeof fn === 'function' ? fn() : undefined
      if (typeof d === 'function') disposers.push(d)
      return () => { if (typeof d === 'function') { try { d() } catch (e) { /* ignore */ } } }
    },
    webServer: {
      register(route) {
        registeredRoutes.push(route)
        ctx.handler = route.handler
        return () => {}
      },
    },
    get(name) { return services[name] },
    emit(name, payload) {
      const arr = listeners.get(name) || []
      for (const fn of arr) fn(payload)
      return arr.length
    },
    services,
    disposers,
  }
  return ctx
}

// ── HTTP 工具 ─────────────────────────────────────────────────────────────
/** 用 node:http 起临时服务器，把 (req,res) 交给 handler。 */
export function startServer(handler) {
  return new Promise((resolvePromise, reject) => {
    const server = http.createServer((req, res) => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch(() => { try { if (!res.headersSent) res.writeHead(500); res.end() } catch (e) { try { res.destroy() } catch (e2) { /* ignore */ } } })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolvePromise({
        server,
        port,
        url: 'http://127.0.0.1:' + port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

/** 原始 http 请求：完全控制请求头（fetch 会自动带 Host、且不便剔除 Origin）。 */
export function rawRequest(base, path, options = {}) {
  const method = options.method || 'GET'
  const headers = { ...(options.headers || {}) }
  const u = new URL(base + path)
  return new Promise((resolvePromise) => {
    let payload = null
    if (options.body !== undefined) {
      payload = Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
      if (!headers['content-type']) headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch (e) { json = null }
        resolvePromise({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', (e) => resolvePromise({ status: 0, headers: {}, text: '', json: null, error: String((e && e.message) || e) }))
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * 发一个超过 MAX_BODY_BYTES 的 POST，只要服务器响应就立刻返回（不等上传完）。
 * 用于验证「超大 body → 413」。
 */
export function postOversized(port, path, headers, bytes) {
  return new Promise((resolvePromise) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolvePromise(v) } }
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { ...headers, 'content-length': String(bytes) } }, (res) => {
      done({ status: res.statusCode, text: '' })
      try { res.resume() } catch (e) { /* ignore */ }
      req.destroy()
    })
    req.on('error', (e) => done({ status: 0, error: String((e && e.message) || e) }))
    const chunk = Buffer.alloc(1024 * 1024, 0x61)
    let sent = 0
    const pump = () => {
      while (sent < bytes) {
        const n = Math.min(chunk.length, bytes - sent)
        sent += n
        if (sent >= bytes) { req.end(chunk.subarray(0, n)); return }
        if (!req.write(chunk.subarray(0, n))) { req.once('drain', pump); return }
      }
    }
    pump()
  })
}
