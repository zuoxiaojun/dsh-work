# AGENTS.md

> DSH Work 设计与代理指南（唯一信息源）。人看的概览见 [README.md](./README.md)；本文件是给 AI 代理的完整设计 + 操作说明。所有信息在这里单一维护，不要在别处复述。

## 1. 定位

DSH Work 是一个**轻量 Electron 壳**，在 DeepSeek Harness 官方 `dsh web` 之上提供桌面化体验。

**核心原则：**

- **纯壳**：不打包 dsh 及其依赖，运行时用内置或系统 Node.js + 受管安装的 `@deepseek-ai/dsh`，升级只跟 npm latest。
- **内置 Node 运行时**：构建时从 npmmirror 下载 Node LTS（~51MB），SHA256 校验后压缩进安装包（`resources/node-bundle-*`），首次启动直接解压使用，无需联网下载。
- **系统 Node 优先**：若系统已装 Node ≥18 则优先复用，内置 Node 仅在无系统 Node 时解压安装，闪屏全程显示进度。
- 功能与原生 `dsh web` 完全一致，桌面只加「入口」，不做功能增强。
- 只加一个 Electron 桌面入口：窗口管理 + 系统托盘 + 子进程管理 + 环境初始化。
- 一键打包流水线，支持 macOS / Windows / Linux，包体 ~176MB（内置 Node + 纯 Electron）。

## 2. 架构

### 2.1 四层架构

```
┌─────────────────────────────────────────────────────────┐
│  Layer 0: 环境初始化（仅首次 / 缺 Node / 缺 dsh 时）   │
│  ① 检测系统 Node ≥18 → 有则直接复用（managed: false）  │
│  ② 无系统 Node → 解压内置 node-bundle-* 到 userData/node │
│  ③ 内置包也不可用 → 从 npmmirror 下载 v24 LTS 兜底     │
│  均经 SHA256 校验 → 冒烟验证 → 受管安装 dsh             │
│  全程闪屏（boot-window）实时进度                        │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Electron 主进程                               │
│  窗口管理 | 系统托盘 | 子进程 spawn | 安全策略           │
│  resolveNode() → 系统 node 优先 → 内置 node → 网络兜底  │
├─────────────────────────────────────────────────────────┤
│  Layer 2: dsh web 子进程                                │
│  node --expose-internals <userData>/dsh/.../bin.js       │
│  监听 127.0.0.1:0，输出就绪 URL                         │
│  ─── 所有 Harness 核心逻辑在这里运行 ───                 │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Web 渲染器                                    │
│  Electron 窗口加载子进程的 URL                           │
│  contextBridge 暴露固定 API，沙箱化，无通用 IPC           │
└─────────────────────────────────────────────────────────┘
```

### 2.2 与 DSH 官方的关系

DSH 官方 npm 包 `@deepseek-ai/dsh` **不打包进客户端**。客户端启动时用解析出的 Node（系统/内置/网络兜底）执行受管安装：

```
node <npm-cli.js> install --prefix <userData>/dsh @deepseek-ai/dsh
```

首次联网安装到用户数据目录（走国内镜像 `registry.npmmirror.com`），之后幂等复用。**关键决策：为什么不用 npx/npm exec？**——dsh 的 HMR 依赖 `--expose-internals`，而 npx/npm exec 不会把该 flag 传给 bin 脚本，dsh 起不来。受管安装 + `node --expose-internals <入口> web` 直接启动，行为与官方完全一致。

**Node 解析优先级**：① 系统 Node ≥18 → ② 解压内置 node-bundle → ③ 网络下载兜底。内置包由 `scripts/prepare-node.ts` 在构建时下载压缩，经 `electron-builder` 的 `extraResources` 打进安装包，运行时通过 `bundledNodeArchive(desktopDir)` 定位。

### 2.3 数据流

```
用户操作
   ↓
 Electron 主进程              子进程 (dsh web)
 ┌───────────────┐           ┌──────────────────┐
 │ 窗口关闭 → 隐藏  │           │  dsh web          │
 │ 托盘点击 → 恢复  │  spawn +  │  监听随机端口      │
 │ 退出 → 停子进程  │  stdout   │  输出就绪 URL     │
 └───────────────┘  ────────► └──────────────────┘
       │                                  │
       │  contextBridge (固定方法)          │  HTTP
       ▼                                  ▼
 ┌──────────────────────────────────────────┐
 │  Web 渲染器 (BrowserWindow)               │
 │  加载 http://127.0.0.1:XXXXX              │
 │  完全相同的 dsh Web 前端                   │
 └──────────────────────────────────────────┘
```

## 3. 核心模块

### 3.1 main.ts — Electron 主进程

**职责：** 窗口创建、系统托盘、子进程 spawn、环境初始化编排、安全策略、退出流程。

**关键路径：**

```
app.whenReady()
  → boot()
    → createBootWindow()            // 闪屏
    → resolveNode({desktopDir})     // ①系统 Node ≥18 → ②内置 node-bundle → ③网络下载兜底
    → ensureManagedDsh()            // 受管安装 @deepseek-ai/dsh（首次联网）
    → createHostSupervisor(spawnDshWeb)
    → hardenSession()               // 拒绝所有权限请求（仅首次，幂等）
    → startHostWithRecovery()       // 启动 Host；插件不兼容则停用并重启（见 §3.6）
    → DSH_VERSION = readManagedDshVersion()   // 运行时读取受管 dsh 版本
    → bootWindow.close()
    → createTray()
    → lifecycle.showWindow()        // 先剪枝过期 dsh-auth cookie 再加载 dsh URL（见 §3.8）
```

**Node 解析策略（node-manager.ts）：**

```
resolveNode()
  → ① detectSystemNode()
      1. which/where 找 node；再扫描 brew/nvm/volta/fnm 等常见位置（GUI .app 不继承 PATH）
      2. node --version 解析主版本 ≥18（config.minSystemNode）
      3. 定位 npm-cli.js（<node>/../lib/node_modules/npm/... 或 win 下 <node>/node_modules/npm/...）
      4. 全部满足 → 返回系统 Node（managed: false）
  → ② 否则 bundledNodeArchive(desktopDir) 查内置资源
      1. dev 模式：<desktopDir>/resources/node-bundle-<platform>-<arch>.<ext>
      2. 打包模式：process.resourcesPath/node-bundle-<platform>-<arch>.<ext>
      3. 找到 → SHA256 校验 → 解压到 userData/node/ → 冒烟 → npm-cli 定位
  → ③ 兜底 installManagedNode()
      1. npmmirror 下载 node-v{V}-{platform}-{arch}.{tar.gz|zip}（流式，字节进度）
      2. SHA256 校验（失败删除重下，≤2 次重试）
      3. 系统 tar / PowerShell 解压到 userData/node/（临时目录 + 原子 rename）
      4. node --version 冒烟 + npm-cli 定位
```

**内置 Node 构建脚本**（`scripts/prepare-node.ts`）：在 `pnpm run build` 之前自动运行，从 npmmirror 下载 Node LTS 归档，SHA256 校验后压缩存入 `resources/node-bundle-<platform>-<arch>.<ext>`（~51MB）。`electron-builder` 通过 `extraResources` 的 `node-bundle-*` 通配符将其打进安装包。**该产物不入库**（`.gitignore` 忽略 `apps/desktop/resources/node-bundle-*`）：它是按当前平台生成的构建产物，克隆后首次构建自行下载，仓库不背 51MB 二进制。

**闪屏（boot-window.ts + boot.html + boot-preload.ts）：** 无边框小窗，内联样式/脚本无外部资源；`contextBridge` 只暴露 `onProgress`/`onError`/`retry` 固定方法，IPC 通道 `dsh-boot:progress`/`dsh-boot:error`/`dsh-boot:retry`；错误态显示重试按钮（重试重新执行 boot，先清理已存在的 host）。

**版本策略（resources/node-versions.json）：** `version`（受管 Node 版本）、`minSystemNode`（系统 Node 下限）、`mirrorBase`（镜像根）、`checksums`（平台 → SHA256）。发布新 Node 版本时更新；checksum 从 `{mirrorBase}/v{version}/SHASUMS256.txt` 获取。

**窗口配置：** 标准 macOS 原生窗口（`frame: true` 默认）；`sandbox: false`（因 ESM preload）、`contextIsolation: true`、`nodeIntegration: false`；最小尺寸 960×640；关闭时隐藏到托盘而非退出。

### 3.2 host-supervisor.ts — 子进程生命周期管理

**代（Generation）管理模型：**

```
HostSupervisor
├── start()      → 启动一代 Host，等待就绪 URL
├── restart()    → 停止当前代，启动新的（递增 ID）
├── shutdown()   → 永久关闭
└── current      → 当前活跃的 HostGeneration
    ├── id: number     (单调递增)
    └── origin: string  (http://127.0.0.1:XXXXX)
```

**关键设计：**

- **ReadinessParser**：逐行解析 stdout，匹配 `dsh web:` 前缀提取 URL，拒绝非 loopback URL。
- **超时控制**：90s 启动超时，5s 关闭宽限期。
- **SIGTERM → SIGKILL**：优雅关闭，超时后强制终止。
- **意外退出处理**：子进程非预期退出时自动退出桌面应用。
- **输出缓冲**：保留最多 32KB 启动输出用于诊断。
- **spawnDshWeb**：`dshWebArgs(dshEntry, patchFile?)` 产出 `spawn(nodeExecutable, ["--expose-internals", "--max-http-header-size=65536", dshEntry, "--profile", "web", (--patch <file>)?, "--no-open", "--host", "127.0.0.1", "--port", "0"])`——不经 shell，Windows 无 `.cmd` 坑。**必须走 `--profile web` 而不是 `web` 别名**：`dsh web` 明确拒绝 launcher 级选项（`error: web takes none of parent --profile, --patch, ...`），而 `--patch` 是安全模式的入口。两种形式打印同一行就绪 URL。参数顺序是契约，由 `host-supervisor.args.test.ts` 锁住（含 Node 级 flag 必须在入口路径之前）。`--max-http-header-size=65536` 抬高的是 §3.8 里那个 16 KiB 请求头上限。**env 注入完整 PATH**（`hostPathFor`：受管 pnpm bin + node bin + `/usr/local/bin` `/opt/homebrew/bin` `/usr/bin` `/bin` `/usr/sbin` `/sbin` + 原 PATH）——打包后 .app 启动的宿主进程 PATH 只有系统最小集，而 dsh 插件 marketplace 会 `spawnSync("pnpm")`，不注入就 ENOENT。

> **The Host（leading word）**：每一项任务都会碰到 Host——被监督的 `dsh web` 子进程。它绑定 `127.0.0.1:0`，就绪时打印唯一的 **readiness line**：
>
> ```
> dsh web: http://127.0.0.1:PORT
> ```
>
> `ReadinessParser` 断言该行为 loopback HTTP + 显式端口，否则拒绝。Host 在窗口显示前启动；Node 与 dsh 入口由 `resolveNode` + `ensureManagedDsh` 提供。

### 3.3 node-manager.ts — Node 解析与受管安装

纯逻辑模块，不 import electron（userData 由调用方注入），可单测。职责：

- `detectSystemNode(platform, minSystemNode)`：PATH 检测 + 常见安装位置扫描（brew/nvm/volta/fnm，见下）+ 版本判断 + npm-cli 定位。
- `installManagedNode({userDataDir, config, onProgress, signal})`：从网络下载（字节进度）→ SHA256 → 解压 → 冒烟 → 原子落位。兜底方案。
- `bundledNodeArchive(desktopDir)`：查找内置 Node 压缩包路径。dev 模式查 `<desktopDir>/resources/node-bundle-`，打包模式查 `process.resourcesPath/node-bundle-`。找不到返回空字符串。
- `installBundledNode({userDataDir, config, archivePath, onProgress})`：从内置资源安装 Node——SHA256 校验 → 解压 → 冒烟 → 原子落位。比 `installManagedNode` 少下载步骤，直接从本地归档解压。
- `ensureManagedDsh({node, userDataDir, ...})`：先引导 pnpm（`node npm-cli install --prefix <userData>/tools/pnpm --ignore-scripts pnpm@11`，一次性，走镜像；钉版本原因见 §3.7），再用 `node pnpm.cjs add @deepseek-ai/dsh --ignore-scripts --store-dir <userData>/pnpm-store --registry https://registry.npmmirror.com` 安装（cwd=`<userData>/dsh`，预写 package.json）；解析 pnpm 的 `Progress: resolved N, reused N, downloaded N, added N` 行实时更新闪屏进度；**dsh 已存在则直接复用，启动不安装、不联网阻塞**。另提供 `checkDshUpdate(userDataDir)`（非阻塞查 registry latest 并与已装版本比对）与 `installDshUpdate({node,userDataDir,...})`（手动 `pnpm add @deepseek-ai/dsh@latest` 更新，供应用菜单/托盘「检查 dsh 内核更新」动作调用）。注入 `npm_config_registry=https://registry.npmmirror.com` 与 `npm_config_cache=<userData>/npm-cache`。
- `resolveNode(options)`：编排入口，含 `desktopDir?` 参数供查找内置资源；返回 `NodeInfo { executable, version, managed, npmCli }`。优先级：系统 Node ≥18 → 内置 node-bundle → 网络下载。
- 进度模型 `NodeProgress { stage, percent?, receivedBytes?, totalBytes?, detail? }`，stage 含 detecting/using-system/downloading/verifying/installing/smoke/installing-dsh/ready。

**注意（实现细节）：**

- Node 官方 Windows 归档平台名是 `win` 不是 `win32`（`node-v{V}-win-x64.zip`）。
- posix 下处理 Windows 路径要用 `node:path` 的 `win32` 变体（`resolveNpmCli`/`nodeCandidates`）。
- `installManagedNode` 在 rename 到 `userData/node/` 后需**重新计算** executable 路径（staging 路径已失效）。
- `mkdtempSync` 前先 `mkdirSync(userDataDir, { recursive: true })`。
- **dsh 用 pnpm 而非 npm 的原因**：npm 首次安装 dsh（193 依赖）实测 ~8 分钟，pnpm 硬链接 store 实测 ~60-90 秒（提速 ~5x）。`--ignore-scripts` 必须加：pnpm 10+ 对存在被忽略的构建脚本会以 `ERR_PNPM_IGNORED_BUILDS` 退出码 1 失败，而 dsh 依赖（node-pty/koffi/protobufjs 等）都有预编译二进制，不需要构建脚本（prepare-dsh 时代已用 `--ignore-scripts` 验证可用）。
- **受管安装目录布局**：`<userData>/dsh/`（dsh 根，node_modules 为 pnpm 符号链接，实际文件在 `dsh/node_modules/.pnpm/` 虚拟 store）+ `<userData>/pnpm-store/`（硬链接池）+ `<userData>/tools/pnpm/`（pnpm 本体）。
- `nodeCandidates`：扫描 PATH 之外的常见 node 安装位置（darwin: `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`~/.volta`、nvm/fnm 版本目录按版本降序；win32: `Program Files\nodejs`、`LocalAppData\Programs\nodejs`、`~/.volta`）——macOS 双击 .app 启动时 GUI 环境不继承 shell PATH，必须有此兜底才能找到用户已装的 node。

### 3.4 window-lifecycle.ts — 窗口生命周期

```
窗口关闭 → event.preventDefault() → 隐藏窗口
托盘点击 → 恢复窗口并聚焦
显式退出 → 停子进程 → 释放应用
```

**关键设计：** 窗口关闭不退出，托盘中常驻；多次退出请求合并（pendingQuit 共享）；窗口重建时等待 Host 就绪；安装器退出信号（`--dsh-installer-quit`）特殊处理；单实例锁 `app.requestSingleInstanceLock()`。

### 3.5 preload.ts — 沙箱桥接（主窗口）

```
sandbox: false 的渲染器
    ├── dshWork.platform              → 'darwin' | 'win32' | 'linux'
    ├── dshWork.versions              → { desktop, dsh }（dsh 运行时读取）
    └── dshWork.workspace.pickDirectory() → 目录选择器
```

**安全模型：** `contextIsolation: true` + `nodeIntegration: false` + `sandbox: false` 让渲染器无法访问 Node.js API；`contextBridge` 只暴露**固定方法**，没有通用 IPC 通道；所有权限请求被拒绝（`hardenSession()`）；导航限制只允许加载 Host 同源 URL，外部链接走系统浏览器。闪屏窗口（boot-preload）同样只暴露固定方法。

### 3.6 plugin-recovery.ts / plugin-updates.ts — 插件兼容安全模式

**背景：** dsh 是 fail-loud 的（`installFailLoud`）：profile 里任意一个插件 bundle import 失败，整个 plugin tree 加载失败，`dsh web` 直接退出。对普通用户就是闪屏上贴一坨 ESM stack——既没点名插件，也没给出路。内核一升级、第三方插件没跟上就会全废（真实案例：`@deepseek-ai/dsh-settings` 在 0.1.2-rc.1 去掉了 `settingsNamespace` 导出，而 dsh-better-sidebar / dsh-openviking 仍在 import 它）。

**机制（保持纯壳，不动用户的 profile 文件）：**

```
Host 启动失败（supervisor 已缓冲最多 32KB 输出，报错在尾部）
  → classifyHostFailure()   抽取每条 failed to import loader entry <id> (<pkg>): <reason>
  → writeSafeMode()         记 userData/plugin-safe-mode.json
                            并生成 plugin-safe-mode.patch.yml（- id: <id> / disabled: true）
  → host.restart()          带 --patch 重启；每轮必须新增至少一个可归因条目，否则终止
  → notifyRecoveredPlugins() 弹窗告知停用了哪些 + 中文原因
```

**为什么是 --patch 覆盖层，而不是删依赖或改 bundles：**

- `dsh.profile.bundles` 是 `dsh plugin` 从 `dependencies` **派生**再回写的（`reconcilePlugins`），手改会在用户下次装插件时被静默还原。
- `disabled` 在 cordis loader 里于 **import 之前**短路（`if (this.disabled) return`），导入必炸的模块根本不会被 import。
- 零网络、可逆、不碰任何属于用户的文件；插件被卸载后残留的陌生 id 实测无害（不会 cannot resolve entry 砖化启动），因此无需剪枝。
- `dsh web` 别名会**拒绝**父级 launcher 选项（`error: web takes none of parent --profile, --patch`），故 Host 一律以 `--profile web` 启动；两者就绪行相同。

**用户侧出口：** 应用菜单与托盘都有「已停用插件 (N)」→ 每项含 `explainReason()` 的中文说明 + 「检查更新并启用…」/「直接重新启用」。`resolvePluginUpdate()` 找上游新修订：github 依赖优先 release tag（作者自己的支持声明）、否则默认分支 HEAD；registry 依赖取 latest。更新一律走 `dsh plugin --profile web add <spec>`，由 dsh 自己 reconcile，不在壳里重复实现。**候选版本只是猜测而非兼容性证明**——重新启用后若仍失败，会再次停用并如实告知。

**保守的分类：** 只有点名到具体 entry 才自动停用；端口冲突、Node 缺失等失败照原样抛出。能识别为插件树失败但归因不到条目时，给「dsh 插件加载失败，请更新或卸载最近安装的插件」而非 stack。循环不收敛时给「自动停用后仍无法启动」。

**可测性：** `startWithPluginRecovery()` 接受注入的 `startup/getDisabled/commit/report`，所以整条恢复链路（含用真实 0.1.2-rc.1 报错文本做的 fixture、跨轮保留、不收敛终止）无需 Electron 即可单测。

### 3.7 pnpm 安装器为何钉在 11.x

`ensurePnpm` 用 `npm install --prefix <userData>/tools/pnpm --ignore-scripts pnpm@11`。**不能去掉版本钉，也不能去掉 `--ignore-scripts`**：pnpm 12 起 npm 包内只有 `bin/pnpm.mjs` 存根，真实 CLI 由 preinstall/postinstall 的 install.js 现场下载；而 npm 11（Node 26 自带）默认不再执行这类脚本（轻则 install-scripts 警告、部分作用域直接 `EALLOWSCRIPTS` 退出）。两者叠加：npm 退出码 0 但 `bin/pnpm.cjs` 不存在 → `managedPnpmCli()` 找不到 → 新装用户首启即报 pnpm bootstrap failed。11.x 的 `bin/pnpm.cjs` 自包含、无需任何生命周期脚本。升级 pnpm 主版本前必须先确认 bin 布局与脚本策略。
### 3.8 auth-cookies.ts — 会话 cookie 剪枝（431 回归）

**背景（真实故障，2026-09-20）：** dsh 的 Web 会话凭证是**按 authority（`host:port`）命名**的签名 cookie（`dsh-auth-<base64url sha256(authority)>`，Max-Age 30 天），而本壳每次启动都给 Host 一个**新的随机端口**（`--port 0`）。Cookie 不区分端口，于是每次启动都在同一个 jar 里**新增**一个而不是替换 —— 数十次启动后 `127.0.0.1` 上堆了 60 个（`Cookie` 头 ~13.7 KB）。Chromium 把 jar 里所有 cookie 附到每个 loopback 请求上，而 dsh 客户端的**合并 plugin bundle** 请求又特别长（54 个 client 入口拼成 ~2.6 KB 的 request line）：两者相加越过 Node 默认 16 KiB 的 `maxHeaderSize` → Host 对**那一个**请求回 `431 Request Header Fields Too Large` → 前端拿不到 bundle，54 个入口全部 `import failed`，UI 显示 **Failed to load plugins**（假象：没有任何插件坏）。

**机制：**

```
每代 Host 就绪、加载页面前（main.ts loadHostPage）
  → pruneStaleAuthCookies(url)
       authority = new URL(url).host          // 127.0.0.1:PORT
       names     = session.cookies.get({url}).map(name)
       drop      = staleAuthCookieNames(names, authCookieNameForAuthority(authority))
       for name of drop: cookies.remove(page, name)
  → window.loadURL(desktopRendererUrl(url))   // 页面请求时再 mint 当前 authority 的 cookie
```

**设计要点：**

- **纯逻辑可测**：`authCookieNameForAuthority()` 复刻 dsh `cookieName()`（无填充 base64url），用真实 Host 抓到的向量钉死（`127.0.0.1:45998 → dsh-auth-cGnsTmKI7XhGEcE4EUwNO6IwMqUYGGrCrtvGFirYcB4`）；`staleAuthCookieNames()` 只挑 `dsh-auth-*` 里非当前 authority 的名字，jar 里其他 cookie 一律不动。
- **剪枝失败不阻塞启动**：catch 后只 `console.error`，页面照常加载 —— 卫生问题的代价应该是 jar 变大，不是打不开。
- **双重防线**：Host 同时以 `--max-http-header-size=65536` 启动（§3.2）。剪枝治本（jar 恒定 1 个 cookie），抬上限防的是 URL 继续变长（用户插件越多，bundle 请求行越长）。
- **不改用户的 profile、不动 dsh**：与 §3.6 同一原则 —— 壳只清自己那个 Electron 会话里的过期凭证。
- **根因仍在 dsh 侧**：authority 绑定的 cookie 名 + 临时端口 = 必然堆积；理想解是 dsh 复用稳定 cookie 名，或退出时清掉自己 mint 的 cookie。

## 4. 命令与开发工作流

```
pnpm install
pnpm run dev:desktop           # 构建（仅当指纹变化）+ 启动
pnpm run dev:desktop:rebuild   # 强制重建后启动
pnpm run test                  # vitest 单元测试（node-manager 纯逻辑）
pnpm run typecheck             # tsc --noEmit
pnpm run build                 # tsdown → lib/  (gitignored)
pnpm run package               # 构建 + electron-builder --dir（unpacked）
pnpm run dist:mac              # macOS DMG
pnpm run dist:win              # Windows NSIS
pnpm run dist:linux            # Linux AppImage
pnpm run dist:all              # 全平台
```

`scripts/dev-desktop.ts` 在 `lib/.dev-fingerprint` 缓存指纹（覆盖全部 src 源文件 + boot.html + node-versions.json），仅当变化时才重建。`lib/` 是 gitignored 构建产物——用 `build` 重新生成，不要直接编辑其内容。

## 5. 窗口与生命周期

- **关闭即隐藏，永不退出**：窗口隐藏到托盘（`window-lifecycle.ts`）；显式退出才先停 Host。
- **安全是硬约束**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`（Electron 沙箱渲染器的 preload 不能用 ESM `import`，而本项目的 preload 是 ESM `.mjs`，故主窗口与 boot 窗口改为 `sandbox: false`；仍保留 contextIsolation + 无 nodeIntegration + 固定桥，渲染器无法访问 Node）；`preload.ts`/`boot-preload.ts` 只暴露固定桥接方法，无通用 IPC。加能力就走固定桥，不要加 catch-all。

## 6. 打包与分发

**纯壳，只内置 Node 运行时，不内嵌 dsh：**

```
pnpm run build
  → prepare-node.ts（构建时下载 Node 归档到 resources/node-bundle-*）
  → tsdown 产出 lib/（main.mjs、preload.mjs、boot-preload.mjs）
  → electron-builder 打包
```

**electron-builder 核心配置：**

```cjs
files: ["lib/**", "package.json", "resources/icon.svg",
        "resources/boot.html", "resources/*.json",   // node-versions/version
        "build/icon.png"]
extraResources: [
  { from: "apps/desktop/resources/", to: ".", filter: ["node-bundle-*"] }
]
```

`extraResources` 将构建时预下载的 Node 压缩包（`node-bundle-<platform>-<arch>.<ext>`，~51MB）打进安装包。dsh 仍然在**首次运行时**联网安装到用户数据目录。

**macOS 特殊处理：** electron-builder 的 DMG 目标因 `@electron/get` 兼容性问题不可用，改由手写 `scripts/package-dmg.sh`（`hdiutil`）制作。它在打 DMG 前用**自签名证书**（`DSH Work Developer`，写入 login keychain）对 bundle 做 `codesign --force --deep` 深度签名——避免 ad-hoc 签名被较新 macOS 判为「已损坏」。自签名签出的包 Gatekeeper 显示「无法验证开发者/安全性阻止」，**右键 → 打开**可运行；配置 Apple Developer ID + 公证后才可双击直达。

**`dist:*` 步骤顺序**（顺序很重要）：`build` → `electron-builder --dir` → `verify-app.sh` → `package-dmg.sh`。

**产物清理：** `package-dmg.sh` 打完 DMG 后会删除中间产物（`dist/mac`、`dist/mac-arm64`、`builder-debug.yml`、`builder-effective-config.yaml`、`.DS_Store`），`dist/` 里最终只保留 `.dmg`。

**产物：**

| 平台 | 产物 | 大小 |
| ------ | ------ | ------ |
| macOS | `DSH Work-{version}-arm64.dmg` | ~176MB（内置 Node ~49MB + 纯 Electron） |
| Windows | `DSH Work-{version}-setup-x64.exe` | TBD |
| Linux | `DSH Work-{version}-x64.AppImage` | TBD |


### 6.1 发版流程（GitHub Release + 本机 mac）

CI（`.github/workflows/build.yml`）先跑 `verify`（`pnpm run typecheck` + `pnpm run test`），通过后才负责 **Win + Linux + 创建 Release**；**mac 由本机构建后上传**。标准三步（每步都阻塞在前一步成功上）：

```bash
# 1) 升版本：必须同时改这两个文件（electron-builder 读 package.json，运行时读 version.json）
#    apps/desktop/package.json        "version": "x.y.z"
#    apps/desktop/resources/version.json  "version": "x.y.z"
git add -A && git commit -m "..." && git push github main

# 2) 打 tag 推送 → 触发 CI（build.yml 监听 tags: ['v*']）构建 Win + Linux 并自动创建 Release
git tag -a vX.Y.Z -m "vX.Y.Z" && git push github vX.Y.Z

# 3) 本机构建 mac DMG + 直连上传到 Release（代理形态见下，勿加 HTTPS_PROXY）
pnpm run dist:mac
gh release upload vX.Y.Z "dist/DSH Work-X.Y.Z-arm64.dmg" --repo zuoxiaojun/dsh-work --clobber
```

**上传直连即可，不要加 `HTTPS_PROXY`（2026-10-15 更正）。** 本机 Pangolin 现在是 **TUN 透明接管**形态（`pgrep -fl 'sing-box|Pangolin'` 可见 `/var/run/pangolin-tun.*/sing-box run -c config.json`），**没有任何应用层代理端口**：10809/7890/7897/1087/12700/8118 全部未监听，`scutil --proxy` 的 `HTTPEnable`/`HTTPSEnable`/`SOCKSEnable` 全为 0，shell 配置里也没有 proxy 变量。四域名直连实测均可达：`github.com` 200/5.7s、`api.github.com` 200/2.1s、`uploads.github.com` 302/4.1s、`raw.githubusercontent.com` 301/1.8s。同理，**不要给 git remote 写死 `http.proxy`**——那会把本来能走的 TUN 路径换成一个没人监听的端口。

> 历史（已过期，别再照抄）：早期 Pangolin 走本地 HTTP 代理时，`uploads.github.com` 直连会**无输出、挂到超时**，当时的绕法是 `HTTPS_PROXY=http://127.0.0.1:10809 gh release upload ...`。代理形态换成 TUN 后这条指令变成有害的：显式指定死端口会自己复现出同一个卡死症状。若将来上传真的挂住，先重新探测形态（`pgrep -fl 'sing-box|Pangolin|mihomo|clash'` + 逐端口 `/dev/tcp/127.0.0.1/<p>` 探听 + `scutil --proxy`），确认存在可用代理口之后再带 `HTTPS_PROXY`。
>
> 注：本节结论来自端口探测与四域名可达性实测，**尚未用一次真实 DMG 上传做端到端验证**。

上传成功为 `exit 0`（无 stdout 属正常）；可用 `gh release view vX.Y.Z --repo ...`（含 `asset:` 行）或 `gh api repos/.../releases/tags/vX.Y.Z --jq '.assets[]|{name,size}'` 核对三个平台安装包都在。

**本机 mac DMG 自检（可选）：**

```bash
MNT=$(mktemp -d) && hdiutil attach -nobrowse -mountpoint "$MNT" "dist/DSH Work-X.Y.Z-arm64.dmg"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$MNT/DSH Work.app/Contents/Info.plist"  # 应为 X.Y.Z
codesign --verify --deep --strict "$MNT/DSH Work.app"   # 自签名下应 VALID（非 adhoc）
hdiutil detach "$MNT"
```

**注意：** verify-app.sh 里的「`desktop version: 1.0.0 (embedded in asar)`」是**正常回退输出**——`resources/version.json` 被打进 `app.asar`（不是松散文件），运行时从 asar 内读取实际版本，不代表打包成 1.0.0。

**产物清理：** `package-dmg.sh` 打完 DMG 会删掉 `dist/mac-arm64/DSH Work.app`（中间产物），`dist/` 只留 `.dmg`；残留的旧版 `DSH Work-{旧version}-arm64.dmg` 需手动清（`rm -f`）。`dist/` 与 `lib/` 均在 `.gitignore`，不影响仓库。
## 7. 项目结构

```
dsh-work/
├── apps/desktop/              # Electron 桌面应用（唯一入口）
│   ├── src/
│   │   ├── main.ts            # 主进程入口（含启动编排）
│   │   ├── preload.ts         # 主窗口沙箱桥接
│   │   ├── boot-preload.ts    # 闪屏沙箱桥接
│   │   ├── boot-window.ts     # 闪屏窗口
│   │   ├── node-manager.ts    # Node 解析/下载/校验/安装 + 受管 dsh
│   │   ├── host-supervisor.ts # 子进程生命周期管理
│   │   ├── auth-cookies.ts    # dsh 会话 cookie 剪枝（431 回归，见 §3.8）
│   │   ├── window-lifecycle.ts # 窗口生命周期
│   │   ├── plugin-recovery.ts # 插件不兼容分类 + 安全模式（纯逻辑 + userData 状态）
│   │   ├── plugin-updates.ts  # 为被停用插件找上游新版本并经 dsh plugin 应用
│   │   └── *.test.ts          # vitest 单元测试
│   ├── scripts/
│   │   ├── dev-desktop.ts     # 开发启动器（指纹缓存 + 增量构建）
│   │   ├── prepare-node.ts    # 构建时：下载 Node + SHA256 校验 + 压缩到 resources/
│   │   ├── verify-app.sh      # 打包后验证（纯壳结构检查）
│   │   └── package-dmg.sh     # macOS DMG 打包
│   ├── resources/             # boot.html、icon、版本号、node-versions
│   ├── build/                 # 构建图标（icns/png）
│   ├── vitest.config.ts
│   ├── electron-builder.config.cjs
│   ├── tsdown.config.ts
│   ├── tsconfig.json
│   └── package.json
├── docs/
│   └── spec-node-runtime.md   # 纯壳架构 spec（决策记录）
├── README.md                  # 面向人的概览
├── LICENSE
├── AGENTS.md                  # 本文件
└── package.json               # workspace 根配置
```

## 8. 运行时依赖与兼容性

| 组件 | 策略 |
| ---------- | ------------- |
| Node.js | 系统 Node ≥18 直接复用；否则解压内置 `node-bundle-*`（构建时从 npmmirror 下载）；两者皆不可用时网络下载兜底。版本由 `node-versions.json` 配置，构建脚本 `scripts/prepare-node.ts` 负责下载与打包 |
| dsh | 首次启动受管安装 npm latest（国内镜像）；**已装复用；启动异步检查 latest（仅记录，不装）；用户点应用菜单/托盘「检查 dsh 内核更新」才手动安装并提示重启生效**；版本运行时读取显示 |
| pnpm 安装器 | **钉 `pnpm@11` + `--ignore-scripts`**，原因见 §3.7；升级主版本前须确认 bin 布局 |
| 第三方 profile 插件 | 由 dsh profile（`~/.dsh/profiles/web`）自行管理，桌面不装不删；与内核不兼容时由 §3.6 安全模式停用并提示，可一键更新或恢复 |

- **npm 镜像**：`npm_config_registry=https://registry.npmmirror.com`、`npm_config_cache=<userData>/npm-cache`（不依赖用户全局 `~/.npm`）。
- **Node 下载/构建镜像**：`mirrorBase` 可配，默认 `https://registry.npmmirror.com/-/binary/node`。构建时 `prepare-node.ts` 从此镜像下载 Node，运行时下载兜底也用同一镜像。
- **内置 Node 压缩包**：构建时下载后存为 `resources/node-bundle-<platform>-<arch>.<ext>`（如 `node-bundle-darwin-arm64.tar.gz`，~51MB），由 `electron-builder` 的 `extraResources` 打进安装包。该压缩包**不入库**——`prepare-node.ts` 每次构建按当前平台生成并校验 SHA256。运行时 `bundledNodeArchive(desktopDir)` 先在 dev 目录查找，再查 `process.resourcesPath`。
- 只要 `dsh web` 的启动接口（`--no-open --host 127.0.0.1 --port 0`）与就绪协议（`dsh web: http://127.0.0.1:PORT`）不破坏性变更，桌面端就不需要改。

## 9. 已知问题

- **代码签名/公证**：未配置 Apple Developer 证书，包用**自签名证书**（`DSH Work Developer`）签名（`codesign --verify` 通过、`spctl` rejected、`Authority=DSH Work Developer`）。从网上下载会被 Gatekeeper 视为「无法验证开发者 / 安全性阻止」，**右键 → 打开**即可运行；或终端移除下载带来的 quarantine 隔离属性解除校验：`xattr -d com.apple.quarantine "/Applications/DSH Work.app"`（或 `xattr -cr "/Applications/DSH Work.app"` 清除全部扩展属性，app 不在该路径则换成实际 `.app` 路径）；ad-hoc 签名（旧方案）会被判「已损坏」且无法绕过。要「双击直达」需 Apple Developer 证书 + 公证。原「移除安全验证.command」脚本在新 macOS 下无效，已移除不再打包。
- **pnpm 12 与 npm 11（Node 26）**：不能再用 `npm install pnpm` 装带脚本的最新版——见 §3.7。
- **插件与内核版本错配**：桌面无法预防（profile 插件由用户与 dsh 生态各自升级），只能事后恢复——见 §3.6 安全模式。保留内核「检查更新」，因为不更新就拿不到官方修复；风险由安全模式兜住。
- **首次启动需联网（仅 dsh）**：dsh 内核（~270MB）需联网安装（pnpm 安装 ~60-90 秒）。Node 运行时已内置在安装包中，无需联网下载。离线会失败，闪屏给重试按钮。
- **宿主进程 PATH**：打包后 .app 启动的 Electron 主进程 PATH 只有系统最小集（`/usr/bin:/bin:/usr/sbin:/sbin`），dsh 宿主继承后其插件 marketplace `spawnSync("pnpm")` 会 ENOENT。修复：spawn dsh 时注入 `hostPathFor` 构造的完整 PATH（受管 pnpm bin 优先 + node bin + 系统常见路径 + 原 PATH），实测最小 PATH 环境下 `pnpm --version` 可正常解析。
- **自动更新**：`electron-updater` 未集成，后续版本可通过 GitHub Releases 实现静默更新。
- **版本信息**：不再向 Web 注入右下角角标（移除 `injectVersionBadge`/`refreshDshUpdateBadge`），改用原生 macOS「关于」对话框（`app.setAboutPanelOptions` + `app.showAboutPanel()`）与应用菜单（`buildApplicationMenu`，含「关于」「检查 dsh 内核更新」「检查桌面版更新」）+ 托盘展示版本与更新入口。`DSH_VERSION` 为**运行时**读取受管 dsh 的 package.json（构建时不可知），在 host 就绪后设置并刷新 About 面板。
- **受管 Node 校验和**：`node-versions.json` 的 checksums 为空时，受管安装会直接报「no SHA256 checksum」——发布前必须从 SHASUMS256.txt 填入，防止静默安装损坏/被篡改的二进制。

## 完成前检查

- `pnpm run typecheck`、`pnpm run build`、`pnpm run test` 均通过。
- 测试套件：vitest，`apps/desktop/src/*.test.ts`；`node-manager.ts` 纯逻辑为主要测试对象（版本解析/归档映射/URL/校验和/npm-cli 定位/下载进度/SHA256/解压/检测）。