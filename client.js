/**
 * dsh-mycordis —— client 半区：把「host 半已起、client 半还没装进页面」的临时插件自动装入本页。
 *
 * 为什么必须有这一半：host 半只能在 Node 沙箱里静默求值 host 代码；client 半的源码只经页面侧
 * getClientCode 取回、并且只能在页面里求值（官方面板那一行「运行」做的事）。所以「运行彻底自动」
 * 必须有一个页面侧的东西替用户点那一下。
 *
 * 走的通道：startUserRun（无 requestId）→ runHostHalf(requestId=null) → getClientCode → load
 *   → settleUserRun → injectUserRunOutcome → agent.inject。**不唤醒任何会话轮次**，但会往归属会话
 *   注入一条 user 上下文消息（DSH 的设计，不是本插件加的）。
 * 绝不走 runner.run()（模型请求通道）：那条通道无论批准还是拒绝都以 agent.steer 收尾，会唤醒一轮。
 *
 * ★ 刻意 **不声明任何 inject**，package.json 的 dsh.client 也 **不写 inject**：
 *   2026-10-05 那版声明了 dynamicCordisRunner / remote.dynamicCordisRunner：缺服务时 Cordis 会让这个
 *   entry 停在 inactive，web boot 就判定「1 entry did not activate」并弹出致命错误框（应用无法启动）。
 *   现在改成运行时 ctx.get(...) 惰性取服务：取不到就跳过本轮，entry 立刻 ACTIVE，最坏情况只是
 *   「自动装入不生效」，绝不会把页面拖崩。同理不写 dsh.client.inject：依赖包里任何一个装载失败都会
 *   连带本 entry 失败。
 */
window.__ModuleLoader__.load({
  id: "dsh-mycordis",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    function apply(ctx) {
      const inFlight = Object.create(null)
      const attempts = Object.create(null)
      const MAX_ATTEMPTS = 3
      let disposed = false
      let eventsBound = false

      // 惰性取服务：没有 inject 依赖，所以这里可能一开始是 undefined，跳过、下一轮再试。
      function services() {
        try {
          const runner = ctx.get("dynamicCordisRunner")
          const remoteSvc = ctx.get("remote")
          const remote = remoteSvc === undefined ? undefined : remoteSvc.dynamicCordisRunner
          if (runner === undefined || typeof runner.startUserRun !== "function") return undefined
          if (remote === undefined || typeof remote.inventory !== "function") return undefined
          return { runner: runner, remote: remote, remoteSvc: remoteSvc }
        } catch (e) { return undefined }
      }

      async function sweep() {
        if (disposed === true) return
        const svc = services()
        if (svc === undefined) return
        if (eventsBound !== true) {
          eventsBound = true
          try {
            svc.remoteSvc.$on("cordis/dynamic-package", () => { void sweep() })
            svc.remoteSvc.$on("cordis/request-run-resolved", () => { void sweep() })
          } catch (e) { /* 事件总线不可用，低频兜底轮询仍在 */ }
        }
        let rows = []
        try {
          const answered = await svc.remote.inventory()
          if (answered === undefined || answered.ok !== true) return
          rows = Array.isArray(answered.value) ? answered.value : []
        } catch (e) { return }
        for (let i = 0; i < rows.length; i += 1) {
          try {
            const row = rows[i]
            if (!row || !row.pluginId || !row.agentId) continue
            const latest = row.latestRun
            // 只处理「host 半已起、client 半待装入」这一种状态。
            if (!latest || latest.status !== "client-pending") continue
            const packageId = latest.packageId || (row.activeRun && row.activeRun.packageId) || row.currentPackageId
            if (!packageId) continue
            const pkgs = row.packages || []
            let hasClient = false
            for (let j = 0; j < pkgs.length; j += 1) {
              if (pkgs[j] && pkgs[j].packageId === packageId && pkgs[j].hasClientHalf === true) hasClient = true
            }
            if (hasClient !== true) continue
            if (typeof svc.runner.isLoaded === "function" && svc.runner.isLoaded(row.pluginId) === true) continue
            const key = String(row.pluginId) + "/" + String(packageId)
            if (inFlight[key] === true) continue
            const tried = attempts[key] === undefined ? 0 : attempts[key]
            if (tried >= MAX_ATTEMPTS) continue
            attempts[key] = tried + 1
            inFlight[key] = true
            // 与官方面板「client-pending → 运行」完全同一个入参形状。
            Promise.resolve()
              .then(() => svc.runner.startUserRun({
                agentId: row.agentId,
                pluginId: row.pluginId,
                packageId: packageId,
                mode: "run",
                hasClientHalf: true,
              }))
              .catch(() => {})
              .then(() => { delete inFlight[key] })
          } catch (e) { /* 单行失败不影响其它行 */ }
        }
      }

      const timer = setInterval(() => { void sweep() }, 3000)
      const onVisible = () => { try { if (document.visibilityState === "visible") void sweep() } catch (e) { /* ignore */ } }
      try { document.addEventListener("visibilitychange", onVisible) } catch (e) { /* 无 document */ }
      ctx.effect(() => () => {
        disposed = true
        clearInterval(timer)
        try { document.removeEventListener("visibilitychange", onVisible) } catch (e) { /* ignore */ }
      }, "mycordis: auto-load client halves")
      void sweep()
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
