# src/packages —— host 半区的功能分包

这里每个 `.js` 都是**功能片段**，不是 ES 模块：它们按 [../manifest.mjs](../manifest.mjs)
的顺序、无分隔符地拼成一个 async 函数体（`host.js`），再交给 `new Function` 求值。
所以：

- 不能出现 `import` / `export`；
- 顶层名字全局唯一（拼接后同处一个作用域）；
- 片段之间直接互相引用即可，无需 import。

| 功能包 | 职责 | 顶层名字 |
|---|---|---|
| `base/` | 与 DSH 无关的纯工具 | `esc` `sq` `rand`；`send` `sendDownload` `sendHtml` `MAX_BODY_BYTES` `readBody` `parsePath`；`parseAuthority` `isLoopbackHostname` `parseOrigin` `defaultPort` `isTrustedRequest` `validProfile` `normPath` `sanitizeFilename` `safeErrorMsg` |
| `runtime/` | DSH 运行时服务接入 | `resolveCurrentSessionId` `sessionTitleOf` `sessionCwdOf` `workspaceRoot`；`runShell` `probePathExists` `probeAsarExists` `probeOnPath`；`desktopQuitHint` `resolveDshCli` `resolvePnpm`；`pickDirNative` |
| `cordis/` | 会话级动态插件领域 | `pluginCurrentName` `listPlugins`；`FAKE_SESSION_ID` `isFakeSessionId` `sanitizePortable` `exportDynamicPlugin` `exportBatch` `snapshotPlugin`；`entrySource` `uploadBundle` `packSessionPlugin` `packBatch` `packWhole`；`importDynamicPlugin` `dedupePlugins`；`favQueue` `favSerialize` `favoritesPath` `legacyFavoritesPath` `readFavorites` `writeFavorites` `favoriteAdd` `favoriteRemove` `favoriteSetResident` `restoreOne` `restoreFavorites` `autoRestoreResident` |
| `install/profile.js` | profile 层真实安装/卸载 | `installBundle` `dshHome` `installedPlugins` `uninstallBundle` |
| `ui/` | 浏览器 UI | `buttonScript` `injectButton`；`pageHtml` |
| `http/router.js` | HTTP 路由表 | `handleRequest` |
| `plugin.js` | 入口（必须最后） | `return { inject, apply }` |

改动流程：改片段 → 对齐 `manifest.mjs` → `node tools/check.mjs`（只读）→ 协调者跑
`node tools/build.mjs` 生成 `host.js`。详见 [../../README.md](../../README.md)。
