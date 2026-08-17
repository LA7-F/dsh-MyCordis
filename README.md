# 我的Cordis（MyCordis）

[English](README.en.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-mycordis.svg)](https://www.npmjs.com/package/dsh-mycordis)

我的Cordis 本身就是 dsh「**一切皆插件**」架构的一个实例：它作为会话级动态插件加载，将自身打包并安装自身实现验证，同时进行了其他demo插件测试

复用 Harness 的 `webServer` / `dynamicCordisRunner` / `fs` / `shell` 等服务，零外部依赖、零数据库；唯一持久化状态（收藏 / 常驻）以工作区文件 `packer2-favorites.json` 保存。启动后自动在 dsh Web 界面注入入口按钮，并提供独立页面。

## 预览版：

Cordis「**便携包**」目前可能只支持Windows端使用，后续考虑会去 Windows 依赖以变更为通用型工具

## 背景：

在 dsh「**一切皆插件**」架构的背景下，用创造模式来插件生成更便捷，但是将其打包成[dsh安装包]或启动保留的插件仍会困扰我们，所以开发此功能为后续社区繁荣做出一点贡献，省点token，欢迎大家上传自己通过此插件打包的内容。

## 使用

- **打包整包**：一个插件同时产出 dsh 安装包（`.tgz`）与便携包（`.dshplugin.json`）到同一文件夹，每插件一个子文件夹，支持单个与批量一键打包
- **dsh 包**（`.tgz`）：`pnpm pack` 合成的真实安装包，可用 `dsh plugin add` 安装，重启 dsh 生效
- **便携包**（`.dshplugin.json`）：纯 host 定义文件，跨会话导入，或由新会话 AI 直接 `read` 后 `cordis_define` 重建（省 token）
- 批量 / 单个打包，三种打包类型即时切换
- 安装 / 卸载 dsh 插件（profile 级真实安装，.tgz实际为完整文件的压缩包）
- 导入便携包（仅注册不运行）
- 收藏（☆）/ 常驻（★ 重启自动恢复）/ 恢复（启动）/ 复制跨会话定位信息
- 同名插件去重（按名称合并版本）
- 安全加固：请求信任栅栏、10MB 请求体上限（统一 413）等

## 运行

仓库：GitHub <https://github.com/LA7-F/dsh-MyCordis> ｜ Gitee 镜像 <https://gitee.com/LA7_F/dsh-MyCordis>

假设dsh根目录为A：E:\harness\deepseek-harness

### 方式一（推荐）：npm 安装（真实安装，重启 dsh 生效）

```sh
pnpm dsh plugin --profile web add dsh-mycordis        # 从 npm 注册表安装（一行命令）
pnpm dsh --profile web								  #重启 dsh
```

或从 git 安装（源码分发，可指定分支/tag；国内建议用 Gitee 镜像，免代理）：

```sh
pnpm dsh plugin --profile web add git+https://gitee.com/LA7_F/dsh-MyCordis.git   # Gitee 镜像（国内）
pnpm dsh plugin --profile web add git+https://github.com/LA7-F/dsh-MyCordis.git  # GitHub（国际）
pnpm dsh --profile web								  #重启 dsh
```

### 方式二：先拉取再安装（git clone 后本地安装）

插件被拉取到文件夹B：E:\harness\dsh-MyCordis

```sh
git clone https://gitee.com/LA7_F/dsh-MyCordis.git          # Gitee 镜像（国内，免代理）
# 或 git clone https://github.com/LA7-F/dsh-MyCordis.git    # GitHub（国际）
pnpm dsh plugin --profile web add E:\harness\dsh-MyCordis   #建议在dsh项目根目录A中执行
pnpm dsh --profile web								        #重启 dsh
```

也支持相对路径 / pnpm 的 `file:`、`link:` 写法：

```sh
pnpm dsh plugin --profile web add ..\dsh-MyCordis        # 相对路径（dsh 会自动锚定到当前目录）
pnpm dsh plugin --profile web add file:.\dsh-MyCordis    # 拷贝安装
pnpm dsh plugin --profile web add link:.\dsh-MyCordis    # 链接安装（改源码即时生效，适合开发调试）
```

### 方式三：本地 dsh 安装包（.tgz）

插件被拉取到文件夹B：E:\harness\dsh-MyCordis

在 tgz 所在目录执行（**必须带 `./` 前缀**）：

```sh
cd E:\harness\dsh-MyCordis
pnpm pack 
cd E:\harness\deepseek-harness
dsh plugin --profile web add E:\harness\deepseek-harness\your-plugin-0.1.0.tgz
pnpm dsh --profile web								     #重启 dsh
```



### 仓库结构

```
<仓库根>/
├── package.json        # name（npm 合法名）、main: index.js、dsh.bundle.patch: ./cordis.patch.yml
├── index.js            # 入口：读取 host.js 以 async 函数体求值并挂载插件
├── host.js             # 插件 host 半区源码
├── client.js           # client 半区（浏览器沙箱代码，可选）
└── cordis.patch.yml    # 组合补丁（声明插入的插件行）
```

本插件的「打包整包」功能可直接为任意会话级动态插件合成此结构的骨架（`.tgz` 内即该布局），一键生成后可推送到 git 仓库供他人安装。

## 使用

页面包含三个页签：**打包 / 安装 / 管理与卸载**。

### 打包

1. 设置**放置目录**（产物输出目录，默认工作区 `packer2-out`，可浏览选择）
2. 选择**打包类型**：

   | 类型 | 产物 | 说明 |
   | --- | --- | --- |
   | `dsh 包` | `.tgz` | 真实安装包（`dsh plugin add`） |
   | `便携包` | `.dshplugin.json` | 纯 host 定义文件 |
   | `整包` | `.tgz` + `.dshplugin.json` | 同时产出两者（pkg-4 新增） |

3. 勾选插件后点「一键打包」（批量），或点每行「打包」单打

### 打包整包（pkg-4）

选择「整包」类型打包后，放置目录下按插件生成独立子文件夹：

```
放置目录/
└── <插件ID>-<包ID>/
    ├── <插件名>-0.1.0.tgz               # dsh 安装包（含 SHA-256）
    └── <插件ID>-<包ID>.dshplugin.json   # 便携包（纯 host）
```

### 安装 / 管理与卸载

- **安装 dsh 包**：选择 `.tgz` 文件 → 自动上传并执行 `dsh plugin add`（可能要批准提升沙箱权限，需重启 dsh 生效），导入后为永久安装插件，可通过「卸载」进行卸载
- **导入便携包**：仅注册不运行，点「恢复」才启动，导入后为Cordis插件；建议只导入可信来源
- **管理与卸载**：列出指定 profile 已安装插件并可卸载；收藏卡片、常驻（重启自动恢复）、同名去重、恢复收藏

## HTTP API

均挂在 `/packer2` 前缀下，仅接受 loopback Host + 同源 Origin 请求：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/packer2` | GET | Web 界面（`embed=1` 为嵌入模式） |
| `/api/plugins` | GET | 会话级插件清单（含默认输出目录） |
| `/api/pack` | POST | 单个 dsh 包打包（.tgz） |
| `/api/pack-batch` | POST | 批量 dsh 包打包 |
| `/api/export-batch` | POST | 批量导出便携包 |
| `/api/pack-whole` | POST | **打包整包**（.tgz + 便携包，一插件一子目录） |
| `/api/export` | GET | 下载便携包（attachment） |
| `/api/import` | POST | 导入便携包（注册不运行） |
| `/api/upload` | POST | 上传 .tgz / .dshplugin 文件 |
| `/api/install` | POST | 安装 dsh 包（真实安装） |
| `/api/uninstall` | POST | 卸载 dsh 插件 |
| `/api/installed` | GET | 指定 profile 已安装插件 |
| `/api/favorites` | GET | 收藏列表 |
| `/api/favorite` | POST | 收藏 / 取消 / 设常驻 |
| `/api/restore-one` | POST | 恢复单个（注册并启动） |
| `/api/restore-favorites` | POST | 恢复全部收藏 |
| `/api/dedupe` | POST | 同名插件去重 |
| `/api/snapshot` | POST | 导出插件快照到工作区 `packer2-snapshot/` |
| `/api/browse` | GET | 目录选择能力探测 |
| `/api/browse/pick` | POST | 原生目录选择 |
| `/api/browse/create` | POST | 新建目录 |

## 产物格式

### dsh 安装包（`.tgz`）

npm 包结构：`package.json`（含 `dsh.bundle.patch` 组合补丁声明）、`index.js`（入口：以 async 函数体求值 host 代码并挂载）、`host.js`（host 半区源码）、`client.js`（client 半区存档）、`cordis.patch.yml`（组合补丁）。

### 便携包（`.dshplugin.json`）

```json
{
  "__dshDynamicPlugin": true,
  "format": 1,
  "pluginId": "mycrd-1",
  "packageId": "pkg-4",
  "ownerSessionId": "session-...",
  "name": "我的Cordis",
  "purpose": "…",
  "code": {
    "host": "…"
  }
}
```

## 安全

- **信任栅栏**：仅接受 loopback Host + 同源 Origin（+ Fetch-Metadata）的请求，否则 403
- **请求体上限** 10MB，超限统一返回 413
- 安装 / 卸载 / 工作区外输出需要提升沙箱权限（弹窗批准）
- 导入会在 dsh 进程内执行包内代码，**只导入可信来源的便携包**

## 已知限制

- 会话级动态插件为**进程级**状态：DSH 重启后需重新导入（便携定义文件是持久产物，可随时重建）
- 真实安装（`dsh plugin add`）写入 `$DSH_HOME/profiles/<profile>`，需重启 dsh 生效
- client 半区为浏览器沙箱代码，合成 `.tgz` 时仅存档不执行（不影响 host 功能）
- 输出目录默认在工作区内；工作区外输出会触发沙箱提升，建议建一个专属工作区进行插件创作

## 开源

使用 我的Cordis 打包的插件，开源时欢迎添加 `dsh-mycordis` 话题。

## 参考

- [Cordis](https://github.com/cordiverse/cordis) —— 底层插件运行时

## 许可证

[MIT](LICENSE)
