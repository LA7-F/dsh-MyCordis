/**
 * dsh-mycordis — 由 我的Cordis 从会话级动态插件合成。
 * host 半区以 async 函数体求值；harness.handle 桥接到私有 connection.rpc channel。
 */
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const HOST_CODE = readFileSync(new URL('./host.js', import.meta.url), 'utf8')

export const name = manifest.name

// 组合插件环境不提供动态沙箱的 harness 全局，注入等价垫片。
// defineTool 透传（DSL 由 tools 服务校验），registerTool 落到 ctx.tools.register，
// handle 捕获 handler，由 apply 里的私有 connection.rpc channel 分发（等价 host.call）。
const handlers = new Map()
const harness = {
  defineTool(def) { return def },
  registerTool(ctx, tool) {
    const tools = (ctx && (ctx.tools || ctx.get('tools')))
    if (tools && typeof tools.register === 'function') return tools.register(tool)
    console.warn('[' + manifest.name + '] harness.registerTool: tools 服务不可用，工具未注册')
    return function () {}
  },
  handle(method, fn) {
    if (typeof method !== 'string' || method === '' || typeof fn !== 'function') throw new Error('harness.handle(method, fn) 需要方法名 + 处理函数')
    handlers.set(method, fn)
    return function () { if (handlers.get(method) === fn) handlers.delete(method) }
  },
}

export async function apply(ctx, config) {
  if (HOST_CODE.trim() === '') {
    console.warn('[' + manifest.name + '] 此包无 host 半区（client-only），在 Node 组合中无可执行逻辑')
    return
  }
  // 私有 RPC channel：客户端 host.call 经 connection.rpc.call 调到 harness.handle 注册的方法
  const conn = ctx.get('connection')
  if (conn && conn.rpc && typeof conn.rpc.handle === 'function') {
    const dispose = conn.rpc.handle('/' + manifest.name, async function (endpoint, payload) {
      const fn = handlers.get(endpoint)
      if (typeof fn !== 'function') return { ok: false, error: { code: 'method-not-found', message: 'no handler "' + endpoint + '"', details: {} } }
      try { return { ok: true, value: await fn(payload) } } catch (e) { return { ok: false, error: { code: 'handler-error', message: String(e && e.message ? e.message : e), details: {} } } }
    }, { authority: 'loopback' })
    ctx.effect(function () { return dispose }, manifest.name + ': rpc channel')
  }
  const factory = new Function('harness', 'return (async () => {\n' + HOST_CODE + '\n})()')
  const plugin = await factory(harness)
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
    throw new Error('host 代码未返回带 apply(ctx) 的 Cordis Plugin 对象')
  }
  await ctx.plugin(plugin, config)
}

export default { name, apply }
