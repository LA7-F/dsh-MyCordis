# 开源引导：给插件仓库添加 `dsh-mycordis` 话题

使用 **我的Cordis（dsh-mycordis）** 生成/打包的插件，在开源发布时，请给你的仓库添加 **`dsh-mycordis`** 话题（Topics）。

## 为什么要添加？

- 让用本工具打包的插件**聚合在同一个话题**下，彼此可见、互相借鉴，形成生态；
- 别人在 GitHub / Gitee 搜索 `dsh-mycordis`，就能找到所有用本工具产出的插件；
- 反过来也让「我的Cordis」被更多插件作者发现——每个带话题的仓库都是它的入口。

## 怎么添加？

### GitHub

1. 打开你的插件仓库主页；
2. 右侧 **About** 区域 → 点击 **Topics 旁的齿轮图标**（Edit topics）；
3. 输入 `dsh-mycordis`，回车；
4. 建议一并添加：`dsh-plugin`、`dsh`、`deepseek-harness`、`ai`、`plugin`；
5. 点 **Save changes**。

### Gitee

1. 打开你的插件仓库 → 右上 **管理**；
2. 左侧 **基本信息** → 找到 **标签（Tags）**；
3. 输入 `dsh-mycordis` 等标签 → 保存。

## 建议配套

- **README**：说明插件是什么、怎么安装使用；并在开头注明：
  > 本插件由 我的Cordis（[dsh-mycordis](https://github.com/LA7-F/dsh-MyCordis)）打包生成。
- **LICENSE**：附上开源协议（如 MIT），别人才能放心使用；
- **开源放源码而非产物**：推荐用本工具「**打包整包**」一键生成源码骨架（`package.json` + `index.js` + `host.js` + `client.js` + `cordis.patch.yml`）推送到仓库；便携包（`.dshplugin.json`）和 dsh 安装包（`.tgz`）作为发布产物放在 Release 里即可。

## 话题对照表

| 话题 | 用途 |
| --- | --- |
| `dsh-mycordis` | 用本工具打包的插件（**必加**） |
| `dsh-plugin` | DeepSeek Harness 插件（官方推荐） |
| `deepseek-harness` | Harness 生态 |
| `dsh` | dsh 相关 |
| `ai` / `plugin` | 通用搜索词 |

## 快速上手（在你的插件仓库执行）

```sh
# 1. 用本工具「打包整包」生成源码骨架并推送
git init -b main
git add .
git commit -m "Initial commit: my plugin"
git remote add origin <你的仓库地址>
git push -u origin main

# 2. 到 GitHub / Gitee 仓库页添加 topics：dsh-mycordis
```

让每一个用 我的Cordis 打包的插件都带上 `dsh-mycordis` 话题——生态靠大家。
