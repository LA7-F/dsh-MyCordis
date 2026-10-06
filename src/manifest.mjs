// src/manifest.mjs —— host 半区源码清单（唯一事实源）。
//
// host.js = preamble + modules[].file 顺序拼接（无分隔符），整体作为一个 async 函数体交给
// new Function 求值。因此每个片段必须满足三条硬约束：
//   1. 只含顶层声明（function / const / let / var），不得出现 import / export；
//   2. 顶层名字在本插件内全局唯一（拼接后同处一个作用域，重名会互相覆盖）；
//   3. 片段之间直接互相引用即可（函数声明提升），既不需要也不能 import。
//
// 调整拆分时只改本文件：tools/build.mjs、tools/check.mjs、tests/_harness.mjs 都从这里读，
// build/check 会校验「provides 与代码里的顶层声明一一对应且无重名」。

/** 产物首行横幅（与历史 host.js 逐字节一致）。 */
export const preamble = "// ── 我的Cordis：会话级动态插件打包/安装/便携化（host 半区，零依赖沙箱能力） ──────────\r\n"

/**
 * 有序模块清单：数组顺序即拼接顺序。
 * - id：供工具/测试按功能定位模块（例如 tests 只加载 base/security）；
 * - file：相对 src/ 的路径；
 * - role：一句话职责；
 * - provides：该模块声明并对外提供的顶层名字。
 *
 * 分层约定：base（与 DSH 无关的纯工具）→ runtime（DSH 运行时服务接入）→ cordis（会话级
 * 动态插件领域）→ install（profile 层真实安装）→ ui / http（对外接口）→ plugin（入口，含
 * 顶层 return，必须最后）。
 */
export const modules = [
  { id: "base/text"          , file: "packages/base/text.js"               , role: "通用文本与标识工具：HTML 转义、宿主平台判定、跨平台 shell 引用、随机标识",
    provides: ["esc", "isWindowsHost", "sq", "rand"] },
  { id: "base/http-io"       , file: "packages/base/http-io.js"            , role: "HTTP 底层 I/O：回包助手、请求体读取与上限、URL 拆分",
    provides: ["send", "sendDownload", "sendHtml", "MAX_BODY_BYTES", "readBody", "parsePath"] },
  { id: "base/security"      , file: "packages/base/security.js"           , role: "信任栅栏（loopback Host + 同源 Origin + 无 Origin 放行）与路径/文件名/错误净化",
    provides: ["parseAuthority", "isLoopbackHostname", "parseOrigin", "defaultPort", "isTrustedRequest", "validProfile", "normPath", "sanitizeFilename", "safeErrorMsg"] },
  { id: "runtime/workspace"  , file: "packages/runtime/workspace.js"       , role: "工作区与会话解析：当前会话 id、存活会话清单（含历史对话标题）、工作区根目录（B9 解析链）",
    provides: ["resolveCurrentSessionId", "sessionTitleOf", "sessionCwdOf", "workspaceRoot", "listSessions"] },
  { id: "runtime/shell"      , file: "packages/runtime/shell.js"           , role: "shell 服务封装、跨平台目录助手（ensureDir/removeTree）与存在性探测",
    provides: ["runShell", "ensureDir", "removeTree", "probePathExists", "probeAsarExists", "probeOnPath"] },
  { id: "runtime/cli"        , file: "packages/runtime/cli.js"             , role: "dsh CLI 与 pnpm 的可执行入口定位（桌面版 resources / 工作区 / PATH，跨平台）",
    provides: ["desktopQuitHint", "shellCallPrefix", "electronRunAsNodePrefix", "resolveDshCli", "resolvePnpm"] },
  { id: "runtime/picker"     , file: "packages/runtime/picker.js"          , role: "原生目录选择器：直接调用 DSH 的 directoryPicker.pick（native 能力）",
    provides: ["pickDirNative"] },
  { id: "cordis/inventory"   , file: "packages/cordis/inventory.js"        , role: "会话级动态插件清单：当前包名、runner.inventory 归一化",
    provides: ["pluginCurrentName", "listPlugins"] },
  { id: "cordis/portable"    , file: "packages/cordis/portable.js"         , role: "便携包定义与导出：脱敏标识、单/批量导出、快照导出",
    provides: ["FAKE_SESSION_ID", "isFakeSessionId", "sanitizePortable", "exportDynamicPlugin", "exportBatch", "snapshotPlugin"] },
  { id: "cordis/pack"        , file: "packages/cordis/pack.js"             , role: "打包：包入口源码生成、上传解包、单插件/批量/整包（dsh + 便携）",
    provides: ["entrySource", "uploadBundle", "fileSha256AndSize", "packSessionPlugin", "packBatch", "packWhole"] },
  { id: "cordis/import"      , file: "packages/cordis/import.js"           , role: "导入定义（define/run）、手动运行与同名去重",
    provides: ["tryRun", "importDynamicPlugin", "runDynamicPlugin", "dedupePlugins"] },
  { id: "cordis/favorites"   , file: "packages/cordis/favorites.js"        , role: "收藏持久化（串行写入 + 旧位置迁移兜底）、恢复、常驻自动拉起",
    provides: ["favQueue", "favSerialize", "favoritesPath", "legacyFavoritesPath", "readFavorites", "writeFavorites", "writePolicyFor", "favoriteAdd", "favoriteRemove", "favoriteSetResident", "restoreOne", "restoreFavorites", "autoRestoreResident"] },
  { id: "install/profile"    , file: "packages/install/profile.js"         , role: "profile 层真实安装/卸载：dsh plugin add/remove、已装清单、当前 profile 推断",
    provides: ["PROFILE_BASE_BUNDLES", "SELF_PLUGIN_NAME", "installBundle", "dshHome", "profileNameOfDir", "activeProfile", "installedPlugins", "uninstallBundle"] },
  { id: "ui/button"          , file: "packages/ui/button.js"               , role: "页面右下角悬浮入口按钮与其 index 注入脚本",
    provides: ["buttonScript", "injectButton"] },
  { id: "ui/page"            , file: "packages/ui/page.js"                 , role: "「我的Cordis」面板页面（HTML/CSS/前端 JS 模板）",
    provides: ["pageHtml"] },
  { id: "http/router"        , file: "packages/http/router.js"             , role: "HTTP 路由表：请求分发、统一错误处理、各 API 端点",
    provides: ["handleRequest"] },
  { id: "plugin"             , file: "packages/plugin.js"                  , role: "插件入口：inject 声明、路由注册、index 注入、常驻自恢复",
    provides: [] },
]
