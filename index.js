/**
 * dsh-mycordis — 由 我的Cordis 从会话级动态插件合成。
 * host 半区以 async 函数体求值；client 半区（浏览器沙箱代码）仅存档不运行。
 */
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const HOST_CODE = readFileSync(new URL('./host.js', import.meta.url), 'utf8')

export const name = manifest.name

export async function apply(ctx, config) {
  if (HOST_CODE.trim() === '') {
    console.warn('[' + manifest.name + '] 此包无 host 半区（client-only），在 Node 组合中无可执行逻辑')
    return
  }
  const factory = new Function('return (async () => {\n' + HOST_CODE + '\n})()')
  const plugin = await factory()
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
    throw new Error('host 代码未返回带 apply(ctx) 的 Cordis Plugin 对象')
  }
  await ctx.plugin(plugin, config)
}

export default { name, apply }
