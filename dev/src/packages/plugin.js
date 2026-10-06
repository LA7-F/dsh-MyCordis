// [plugin] 插件入口：inject 声明、路由注册、index 注入、常驻自恢复
return {
  inject: ['webServer', 'dynamicCordisRunner', 'fs'],
  apply(ctx) {
    // 桌面版（Electron）从 dsh-app:// 直接读盘提供 index.html，不走 webServer.renderIndex()，
    // 所以 tapIndex 在桌面版是静默失效的；结构化 index 行表才是两种模式通用的通道。
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'body', text: buttonScript() })
    })
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/packer2',
      handler: (req, res) => { void handleRequest(ctx, req, res) },
    })
    ctx.effect(() => dispose, 'packer2: ui route')
    autoRestoreResident(ctx).catch(function (err) {
      console.log('packer2 autoRestoreResident 失败: ' + safeErrorMsg(err))
    })
  },
}