# dev/ —— 开发资产（不进 npm 包）

> 这里的东西**运行期一个字节都不会读**，但**必须进版本库**：它们是把 `lib/host.js` 变成
> 「可以安全修改的代码」而不是「一个没人敢动的 130K 单体」的全部依据。

| 目录 | 定位 | 少了会怎样 |
|---|---|---|
| [src/](src) | host 半区的分层源码（地图见 [src/README.md](src/README.md)） | `lib/host.js` 没有任何可读来源，改了无法回溯 |
| [tools/](tools) | 构建与门禁：`build.mjs` 生成 `lib/host.js`，`check.mjs` 只读校验 | 没有门禁，分层拼接的硬约束（顶层名唯一、无 import、分层单向）会静默失守 |
| [tests/](tests) | 回归门禁：`smoke.test.mjs` | 改片段后没有行为兜底 |

## 为什么不在 `缓存/` 里

`缓存/` 被 [.gitignore](../.gitignore) 整目录忽略——那是给「跑起来才会产生、删掉也能再生」的东西的。
开发资产一旦放进去，一次 `git clean -xfd` 就没了，而且版本库里找不回来（本项目已经因此丢过一次全部源码）。

## 为什么不在 npm 包里

[package.json](../package.json) 的 `files` 是白名单，只有 `lib/**` 与三个声明文件。
`dev/` 不在其中，所以 `npm pack` 不会带上它——**分发物干净**与**开发资产可追溯**是两件事，用两个开关分别控制。

## 常用命令（在仓库根执行）

```sh
node dev/tools/check.mjs          # 只读门禁（并行改动时用这个）
node dev/tools/build.mjs          # 由 dev/src/packages/** 生成 lib/host.js
node dev/tools/build.mjs --check  # 只校验 src 与 lib/host.js 是否同步，不写盘
node dev/tests/smoke.test.mjs     # 回归门禁
```
