# MyCordis（我的Cordis）

English | [中文](README.md)

[![npm](https://img.shields.io/npm/v/dsh-mycordis.svg)](https://www.npmjs.com/package/dsh-mycordis)

MyCordis is itself an instance of dsh's "**everything is a plugin**" architecture: it loads as a session-level dynamic plugin, packs and installs itself to validate the toolchain, and has also been exercised against other demo plugins.

It reuses Harness services such as `webServer` / `dynamicCordisRunner` / `fs` / `shell` with zero external dependencies and zero database; the only persisted state (favorites / resident plugins) is stored in the workspace file `packer2-favorites.json`. Once started, it injects an entry button into the dsh Web UI and serves its own page.

## Preview

The Cordis **portable bundle** (`.dshplugin.json`) may currently be Windows-only; configuration support and removal of Windows dependencies are planned to make it a general-purpose tool.

## Background

Under dsh's "everything is a plugin" architecture, generation mode makes plugin creation more convenient — but packaging plugins into [dsh install bundles] or keeping plugins running / restorable still causes friction. This tool is a small contribution to the community — and a token saver. Everyone is welcome to share content packaged with this plugin.

## Features

- **Pack whole bundle**: for one plugin, produce both the dsh install bundle (`.tgz`) and the portable bundle (`.dshplugin.json`) into the same folder — one subfolder per plugin, supporting both single and batch one-click packing
- **dsh bundle** (`.tgz`): a real install bundle synthesized with `pnpm pack`, installable via `dsh plugin add`; takes effect after restarting dsh
- **Portable bundle** (`.dshplugin.json`): a host-only definition file; import it across sessions, or let an AI in a new session `read` it and rebuild via `cordis_define` (saves tokens)
- Batch / single packing, with three pack types switchable on the fly
- Install / uninstall dsh plugins (real, per-profile installs; a `.tgz` is actually a compressed archive of the complete files)
- Import portable bundles (register only, not run)
- Favorites (☆) / resident (★ auto-restored on restart) / restore (start) / copy cross-session locator info
- Dedupe same-name plugins (merge versions by name)
- Hardened: request trust fence, 10MB body limit (uniform 413), etc.

## Running

Repository: GitHub <https://github.com/LA7-F/dsh-MyCordis> ｜ Gitee mirror <https://gitee.com/LA7_F/dsh-MyCordis>

Assume the dsh root directory is **A**: `E:\harness\deepseek-harness`

### Method 1 (recommended): install from npm (real install; takes effect after restarting dsh)

```sh
pnpm dsh plugin --profile web add dsh-mycordis        # one-line install from the npm registry
pnpm dsh --profile web                                # restart dsh
```

Or install from git (source distribution; pin a branch/tag; the Gitee mirror is recommended in China — no proxy needed):

```sh
pnpm dsh plugin --profile web add git+https://gitee.com/LA7_F/dsh-MyCordis.git   # Gitee mirror (China)
pnpm dsh plugin --profile web add git+https://github.com/LA7-F/dsh-MyCordis.git  # GitHub (international)
pnpm dsh --profile web                                # restart dsh
```

### Method 2: clone first, then install (local install after git clone)

The plugin is cloned into folder **B**: `E:\harness\dsh-MyCordis`

```sh
git clone https://gitee.com/LA7_F/dsh-MyCordis.git          # Gitee mirror (China, no proxy)
# or git clone https://github.com/LA7-F/dsh-MyCordis.git    # GitHub (international)
pnpm dsh plugin --profile web add E:\harness\dsh-MyCordis   # recommended: run from dsh root A
pnpm dsh --profile web                                      # restart dsh
```

Relative paths and pnpm's `file:` / `link:` forms are also supported:

```sh
pnpm dsh plugin --profile web add ..\dsh-MyCordis        # relative path (dsh anchors it to the current directory)
pnpm dsh plugin --profile web add file:.\dsh-MyCordis    # copy install
pnpm dsh plugin --profile web add link:.\dsh-MyCordis    # link install (source edits take effect immediately; good for development)
```

### Method 3: local dsh install bundle (.tgz)

The plugin is cloned into folder **B**: `E:\harness\dsh-MyCordis`

```sh
cd E:\harness\dsh-MyCordis
pnpm pack
cd E:\harness\deepseek-harness
dsh plugin --profile web add E:\harness\deepseek-harness\your-plugin-0.1.0.tgz
pnpm dsh --profile web                                      # restart dsh
```

### Repository layout

```
<repo root>/
├── package.json        # name (valid npm name), main: index.js, dsh.bundle.patch: ./cordis.patch.yml
├── index.js            # entry: reads host.js, evaluates it as an async function body and mounts the plugin
├── host.js             # plugin host-half source
├── client.js           # client half (browser sandbox code, optional)
└── cordis.patch.yml    # composition patch (declares the inserted plugin row)
```

This plugin's "pack whole bundle" feature can synthesize exactly this layout for any session-level dynamic plugin (the `.tgz` contains this layout); generate it with one click and push it to a git repository for others to install.

## Usage

The page has three tabs: **Pack / Install / Manage & Uninstall**.

### Packing

1. Set the **output directory** (where artifacts go; defaults to the workspace `packer2-out`, browseable)
2. Choose the **pack type**:

   | Type | Artifact | Description |
   | --- | --- | --- |
   | `dsh bundle` | `.tgz` | real install bundle (`dsh plugin add`) |
   | `portable` | `.dshplugin.json` | host-only definition file |
   | `whole` | `.tgz` + `.dshplugin.json` | both at once (new in pkg-4) |

3. Check the plugins and click **Pack all** (batch), or click **Pack** on a single row

### Pack whole bundle (pkg-4)

With the "whole" type, the output directory gets one subfolder per plugin:

```
<output-dir>/
└── <pluginId>-<packageId>/
    ├── <plugin-name>-0.1.0.tgz               # dsh install bundle (with SHA-256)
    └── <pluginId>-<packageId>.dshplugin.json # portable bundle (host-only)
```

### Install / Manage & Uninstall

- **Install dsh bundle**: pick a `.tgz` file → auto-upload and run `dsh plugin add` (may require approving an elevated sandbox prompt; takes effect after restarting dsh). The plugin is permanently installed and can be removed via **Uninstall**.
- **Import portable bundle**: registered but not run; click **Restore** to start it; it becomes a Cordis plugin. Only import from trusted sources.
- **Manage & Uninstall**: list the plugins installed in a given profile and uninstall them; favorite cards, resident (auto-restore on restart), same-name dedupe, restore favorites.

## HTTP API

All endpoints live under the `/packer2` prefix and only accept loopback Host + same-origin requests:

| Route | Method | Description |
| --- | --- | --- |
| `/packer2` | GET | Web UI (`embed=1` for embedded mode) |
| `/api/plugins` | GET | session-level plugin inventory (with default output dir) |
| `/api/pack` | POST | pack a single dsh bundle (.tgz) |
| `/api/pack-batch` | POST | pack multiple dsh bundles |
| `/api/export-batch` | POST | export multiple portable bundles |
| `/api/pack-whole` | POST | **pack whole bundle** (.tgz + portable, one subfolder per plugin) |
| `/api/export` | GET | download a portable bundle (attachment) |
| `/api/import` | POST | import a portable bundle (register only) |
| `/api/upload` | POST | upload a .tgz / .dshplugin file |
| `/api/install` | POST | install a dsh bundle (real install) |
| `/api/uninstall` | POST | uninstall a dsh plugin |
| `/api/installed` | GET | plugins installed in a given profile |
| `/api/favorites` | GET | favorites list |
| `/api/favorite` | POST | favorite / unfavorite / set resident |
| `/api/restore-one` | POST | restore one (register and start) |
| `/api/restore-favorites` | POST | restore all favorites |
| `/api/dedupe` | POST | dedupe same-name plugins |
| `/api/snapshot` | POST | export a plugin snapshot to the workspace `packer2-snapshot/` |
| `/api/browse` | GET | directory-picker capability probe |
| `/api/browse/pick` | POST | native directory picker |
| `/api/browse/create` | POST | create a directory |

## Artifact formats

### dsh install bundle (`.tgz`)

npm package layout: `package.json` (declares the `dsh.bundle.patch` composition patch), `index.js` (entry: evaluates the host code as an async function body and mounts it), `host.js` (host-half source), `client.js` (client-half archive), `cordis.patch.yml` (composition patch).

### Portable bundle (`.dshplugin.json`)

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

## Security

- **Trust fence**: only accepts requests from a loopback Host + same-origin Origin (+ Fetch-Metadata); otherwise 403
- **Body limit** 10MB; over-limit requests uniformly return 413
- Install / uninstall / output outside the workspace require elevated sandbox permissions (approved via a prompt)
- Importing executes the package's code inside the dsh process — **only import portable bundles from trusted sources**

## Known limitations

- Session-level dynamic plugins are **process-scoped**: they must be re-imported after a DSH restart (the portable definition file is the durable artifact and can be rebuilt at any time)
- Real installs (`dsh plugin add`) write to `$DSH_HOME/profiles/<profile>` and take effect after restarting dsh
- The client half is browser-sandbox code; when synthesizing a `.tgz` it is archived but not executed (does not affect host functionality)
- The output directory defaults to inside the workspace; output outside the workspace triggers a sandbox elevation; consider a dedicated workspace for plugin authoring

## Open source

When open-sourcing plugins that are packaged with `dsh-MyCordis`, we encourage you to add the `dsh-mycordis` topic to your repository.

## References

- [Cordis](https://github.com/cordiverse/cordis) — the underlying plugin runtime

## License

[MIT](LICENSE)
