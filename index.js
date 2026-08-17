/**
 * dsh-mycordis — 由 我的Cordis 从会话级动态插件合成。
 * host 半区以 async 函数体求值；client 半区（浏览器沙箱代码）仅存档不运行。
 */
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const HOST_CODE = readFileSync(new URL('./host.js', import.meta.url), 'utf8')

export const name = manifest.name

// 组合插件环境不提供动态沙箱的 harness 全局，注入等价垫片：
// defineTool 原样透传（DSL 由 tools 服务校验），registerTool 落到 ctx.tools.register，
// handle（包私有 Client→Host RPC）在组合环境无对应通道，降级 no-op 并告警。
const harness = {
  defineTool(def) { return def },
  registerTool(ctx, tool) {
    const tools = (ctx && (ctx.tools || ctx.get('tools')))
    if (tools && typeof tools.register === 'function') return tools.register(tool)
    console.warn('[' + manifest.name + '] harness.registerTool: tools 服务不可用，工具未注册')
    return function () {}
  },
  handle(method) {
    console.warn('[' + manifest.name + '] harness.handle("' + method + '") 在组合插件环境不可用（无包私有 RPC），已降级为 no-op')
    return function () {}
  },
}

export async function apply(ctx, config) {
  if (HOST_CODE.trim() === '') {
    console.warn('[' + manifest.name + '] 此包无 host 半区（client-only），在 Node 组合中无可执行逻辑')
    return
  }
  const factory = new Function('harness', 'return (async () => {\n' + HOST_CODE + '\n})()')
  const plugin = await factory(harness)
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
    throw new Error('host 代码未返回带 apply(ctx) 的 Cordis Plugin 对象')
  }
  await ctx.plugin(plugin, config)
}

export default { name, apply }
