// dev/src/manifest.mjs —— host 半区分层清单（唯一事实源）。
//
// lib/host.js = preamble + modules[].file 依序拼接（无任何分隔符），整体作为一个 async
// 函数体交给 new Function 求值。因此每个片段必须满足三条硬约束：
//   1. 只含顶层声明（function / const / let / var），不得出现 import / export；
//   2. 顶层名字全插件唯一（拼接后同处一个作用域，重名会静默互相覆盖）；
//   3. 片段之间直接互相引用即可（函数声明提升），既不需要也不能 import。
//
// 改代码只改 dev/src/packages/**；改完把这里的 role / provides 对齐，然后跑：
//   node dev/tools/check.mjs          —— 只读门禁（并行改动时用这个）
//   node dev/tools/build.mjs          —— 重新生成 lib/host.js
//   node dev/tools/build.mjs --check  —— 校验 src 与 lib/host.js 是否同步（CI 用）

/** lib/host.js 的首行横幅（必须是产物第一个字节）。 */
export const preamble = "// ── 我的Cordis：会话级动态插件打包/安装/便携化（host 半区，零依赖沙箱能力） ──────────\r\n"

/** 分层职责（供文档与审阅使用，不参与拼接）。 */
export const layers = {
  "base/": "与 DSH 无关的纯工具：文本 / HTTP I/O / 信任栅栏与净化 / 安装源规格。可被任何层依赖，自己不依赖任何层。",
  "runtime/": "DSH 运行时服务接入：工作区与会话解析、shell 与目录助手、CLI/pnpm 定位、原生目录选择。",
  "cordis/": "会话级动态插件领域逻辑：清单、便携定义、打包、导入、收藏与常驻。",
  "install/": "profile 层真实安装 / 卸载（安装源归一 + 写 $DSH_HOME，风险最高，单独成层）。",
  "ui/": "浏览器侧呈现：悬浮入口按钮、面板页面模板。",
  "http/": "对外接口：路由表与统一错误处理，只调用上面各层。",
  "plugin": "入口：inject 声明与装配，必须排在最后（含顶层 return）。"
}

/**
 * 有序片段清单：**数组顺序即拼接顺序**，plugin 必须在最后。
 * - id       片段标识，等于产物的分节标记 `// [id] role`；
 * - file     相对 src/ 的路径；
 * - role     一句话职责（会写进产物的分节标记）；
 * - provides 该片段声明并对外提供的顶层名字（check 会逐一对账）。
 */
export const modules = [
  {
    id: "base/text",
    file: "packages/base/text.js",
    role: "通用文本与标识工具：HTML 转义、跨平台 shell 引用、随机标识",
    provides: ["esc", "isWindowsHost", "sq", "rand"],
  },
  {
    id: "base/http-io",
    file: "packages/base/http-io.js",
    role: "HTTP 底层 I/O：回包助手、请求体读取与上限、URL 拆分",
    provides: ["send", "sendDownload", "sendHtml", "MAX_BODY_BYTES", "readBody", "parsePath"],
  },
  {
    id: "base/security",
    file: "packages/base/security.js",
    role: "信任栅栏（loopback Host + 同源 Origin + 无 Origin 放行）与路径/文件名/错误净化",
    provides: ["parseAuthority", "isLoopbackHostname", "parseOrigin", "defaultPort", "isTrustedRequest", "validProfile", "normPath", "sanitizeFilename", "safeErrorMsg"],
  },
  {
    id: "base/source-spec",
    file: "packages/base/source-spec.js",
    role: "安装源规格（与 DSH 无关）：npm 包名校验、git 地址归一、凭据打码、类型名",
    provides: ["PACKAGE_NAME_RE", "PACKAGE_NAME_MAX", "validPackageName", "redactUrl", "normalizeGitSpec", "isGitSource", "kindTextOf"],
  },
  {
    id: "runtime/workspace",
    file: "packages/runtime/workspace.js",
    role: "工作区与会话解析：当前会话 id、工作区根目录（B9 解析链）",
    provides: ["resolveCurrentSessionId", "sessionTitleOf", "listSessions", "workspaceWritePolicy", "sessionCwdOf", "workspaceRoot"],
  },
  {
    id: "runtime/shell",
    file: "packages/runtime/shell.js",
    role: "shell 服务封装、跨平台目录助手与存在性探测",
    provides: ["runShell", "ensureDir", "removeTree", "probePathExists", "probeAsarExists", "probeOnPath"],
  },
  {
    id: "runtime/cli",
    file: "packages/runtime/cli.js",
    role: "dsh CLI 与 pnpm 的可执行入口定位（桌面版 resources / 工作区 / PATH，跨平台）",
    provides: ["desktopQuitHint", "shellCallPrefix", "electronRunAsNodePrefix", "resolveDshCli", "resolvePnpm"],
  },
  {
    id: "runtime/picker",
    file: "packages/runtime/picker.js",
    role: "原生目录选择器：直接调用 DSH 自己的 directoryPicker（native 能力）",
    provides: ["pickDirNative"],
  },
  {
    id: "cordis/inventory",
    file: "packages/cordis/inventory.js",
    role: "会话级动态插件清单：当前包名、runner.inventory 归一化",
    provides: ["pluginCurrentName", "listPlugins"],
  },
  {
    id: "cordis/portable",
    file: "packages/cordis/portable.js",
    role: "便携包定义与导出：脱敏标识、单/批量导出、快照导出",
    provides: ["FAKE_SESSION_ID", "isFakeSessionId", "sanitizePortable", "exportDynamicPlugin", "exportBatch", "snapshotPlugin", "readPluginFromTgz"],
  },
  {
    id: "cordis/pack",
    file: "packages/cordis/pack.js",
    role: "打包：包入口源码生成、上传解包、单插件/批量/整包（dsh + 便携）",
    provides: ["entrySource", "uploadBundle", "fileSha256AndSize", "packSessionPlugin", "packBatch", "packWhole"],
  },
  {
    id: "cordis/import",
    file: "packages/cordis/import.js",
    role: "导入定义（define/run）、手动运行与同名去重",
    provides: ["tryRun", "importDynamicPlugin", "runDynamicPlugin", "dedupePlugins"],
  },
  {
    id: "cordis/favorites",
    file: "packages/cordis/favorites.js",
    role: "收藏持久化（串行写入 + 旧位置迁移兜底）、恢复、常驻自动拉起",
    provides: ["favQueue", "favSerialize", "favoritesPath", "legacyFavoritesPath", "readFavorites", "writePolicyFor", "writeFavorites", "favoriteAdd", "favoriteRemove", "favoriteSetResident", "restoreOne", "restoreFavorites", "autoRestoreResident"],
  },
  {
    id: "install/source",
    file: "packages/install/source.js",
    role: "安装源识别（文件夹 package.json 预检 / 已存在路径归类，需要 fs 与 shell）",
    provides: ["readInstallManifest", "installPathKind", "localDirSource", "resolveInstallSource"],
  },
  {
    id: "install/profile",
    file: "packages/install/profile.js",
    role: "profile 层真实安装/卸载：dsh plugin add/remove、已装清单",
    provides: ["PROFILE_BASE_BUNDLES", "SELF_PLUGIN_NAME", "installNoteFor", "installErrorHint", "installBundle", "dshHome", "profileNameOfDir", "activeProfile", "installedPlugins", "uninstallBundle"],
  },
  {
    id: "ui/button",
    file: "packages/ui/button.js",
    role: "页面右下角悬浮入口按钮与其 index 注入脚本",
    provides: ["buttonScript", "injectButton"],
  },
  {
    id: "ui/page",
    file: "packages/ui/page.js",
    role: "「我的Cordis」面板页面（HTML/CSS/前端 JS 模板）",
    provides: ["pageHtml"],
  },
  {
    id: "http/router",
    file: "packages/http/router.js",
    role: "HTTP 路由表：请求分发、统一错误处理、各 API 端点",
    provides: ["handleRequest"],
  },
  {
    id: "plugin",
    file: "packages/plugin.js",
    role: "插件入口：inject 声明、路由注册、index 注入、常驻自恢复",
    provides: [],
  },
];

export default { preamble, layers, modules };
