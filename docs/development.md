# 开发、测试与打包

## 环境要求

- Node.js `>=22.13 <25`，推荐 Node 22 LTS；
- pnpm `>=9.15 <10`（仓库固定 `pnpm@9.15.4`）；
- Git；
- 用于 `better-sqlite3` 的本机编译环境；
- 制作 Linux 安装包时需要 `fakeroot`/`dpkg-deb` 与提供 `rpmbuild` 的 RPM 工具；
- 运行 Linux Electron E2E 时需要 Xvfb。

启用 pnpm 并安装：

```bash
corepack enable
pnpm install
```

仓库使用 `node-linker=hoisted`，这是 Electron Forge 收集运行时依赖和重编译原生模块所需的兼容配置，不应在单个开发机上随意改成不同 linker。首次解析依赖后应审阅并提交 `pnpm-lock.yaml`。

## 工作区

```text
apps/desktop/
├── forge.config.ts
├── vite.main.config.ts
├── vite.preload.config.ts
├── vite.renderer.config.ts
└── src/
    ├── main/
    ├── preload.ts
    └── renderer/
```

Forge 的 renderer 名称固定为 `main_window`。主进程可使用插件注入的 `MAIN_WINDOW_VITE_DEV_SERVER_URL` 和 `MAIN_WINDOW_VITE_NAME` 在开发/生产环境加载同一窗口。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动 Vite dev server 与 Electron Forge |
| `pnpm lint` | ESLint 静态检查 |
| `pnpm typecheck` | 严格 TypeScript 检查，不输出文件 |
| `pnpm test` | 运行 Vitest 单元测试 |
| `pnpm e2e` | 运行 Playwright Electron 测试 |
| `pnpm build` | Forge package，生成当前平台 unpacked 应用 |
| `pnpm package` | 与 Forge package 语义一致的显式命令 |
| `pnpm make` | 调用平台 maker 生成安装包 |
| `pnpm rebuild:native` | 按当前 Electron ABI 重编译 `better-sqlite3` |
| `pnpm verify:release` | 校验三份版本、安装升级身份以及 release tag 一致性 |
| `pnpm format` | 使用 Prettier 格式化 |

`build` 和 `package` 当前都调用 Forge package；保留两个名称是为了让通用 CI 语义和 Electron Forge 语义都清楚，不代表执行两套不同打包器。

## 三个 Vite 目标

- `vite.main.config.ts` 构建主进程，并 externalize `electron` 与 `better-sqlite3`；
- `vite.preload.config.ts` 构建 context bridge，并 externalize `electron`；
- `vite.renderer.config.ts` 构建 React 页面和 worker，使用相对资源基址以支持 `file://` 包。

Forge 在 `.vite/` 生成临时构建，并以 `.vite/build/index.js` 为应用入口。不要在 renderer bundle 中 import Node-only 包或原生模块。

## 原生模块

Electron 使用的 Node ABI 与系统 Node 可能不同。Forge package/make 会按 `rebuildConfig` 只重编译 `better-sqlite3`，`AutoUnpackNativesPlugin` 则把 `.node` 二进制放在 ASAR 外。若开发启动出现 `NODE_MODULE_VERSION` 不匹配：

```bash
pnpm rebuild:native
pnpm dev
```

不要把某台开发机生成的 `.node` 文件提交到 Git，也不要通过关闭 ASAR 或 Electron fuse 来绕开问题。

## 测试策略

- 当前单元测试覆盖跨平台路径边界、符号链接逃逸、DOC/DOCX 转换事务与结构化文档磁盘事实来源、项目 TOML/schema 拒绝、快照校验/恢复、项目会话工具检测去重/绑定、受管版本目录/摘要/防篡改及 renderer 文件类型辅助逻辑；
- Playwright 通过 Electron launcher 验证生产窗口可启动、欢迎页与关键工作区导航；
- Codex 单元测试覆盖本地假 app-server 的完整 stdio 启动/握手链路、持久线程/模型响应映射、有界历史分页与去重、审批路由、上下文集合及未保存 buffer 的双端校验；受管工具链测试覆盖版本目录、摘要、防篡改、安装/删除互斥、取消和项目切换拒绑。真实已认证 Codex CLI 的版本矩阵、受管工具链三平台真实安装、IPC 合同和更多 renderer 交互仍是发布前应继续扩充的重点；
- 下载、真实登录、Zotero 等网络能力必须使用 adapter contract test；真实服务测试单独且显式启用，不能成为普通 CI 的隐式外部依赖。

CI 在 Ubuntu、Windows 和 macOS 上执行 lint、typecheck、unit test 和 package。Linux E2E 通过 Xvfb 运行。发布 workflow 只在 tag 或手动触发时执行 maker，并上传各平台产物。

CI 会在编译前运行 `pnpm verify:release`。根 `package.json`、`apps/desktop/package.json` 和安装 manifest 必须使用同一严格 SemVer；tag 构建还必须精确使用 `v<version>`。升级版本时应一次更新这三处。固定的 Squirrel package、Windows AppUserModelId、macOS bundle id 和 Linux package name 也由同一门禁复核，防止新安装器意外创建另一个应用或覆盖无关程序。

## 平台打包

在目标平台执行：

```bash
pnpm make
```

默认 maker：Windows 使用 Squirrel installer；macOS 同时生成 DMG 与 ZIP；Linux 同时生成 DEB、RPM 与 ZIP。Linux 包安装 Freedesktop desktop entry，并让 `/usr/bin/research-ide` 指向包内的绝对路径启动器。主入口最早处理 Squirrel install/update/uninstall/obsolete 事件，避免安装器启动完整 IDE 或加载原生 SQLite。

安装升级回归至少覆盖：首次运行、相同版本再次运行、SemVer prerelease→stable、升级、降级、损坏/非普通版本状态文件，以及科研项目哨兵文件保持逐字节不变。Windows 还需区分 `--squirrel-install` 和 `--squirrel-updated`，并确认两种事件均不会 import 完整 application。DMG 和 DEB/RPM 的“替换/升级”提示由操作系统提供；ZIP 不得通过扫描磁盘猜测旧安装位置。

Electron Forge 不支持可靠的任意跨平台交叉构建，因此 CI 使用对应操作系统 runner。DMG 只能在 macOS 制作；Windows Squirrel 的受支持发布路径是 Windows runner；DEB 需要 `fakeroot`/`dpkg-deb`，RPM 需要 `rpmbuild`。具体启动、产物和卸载边界见 [桌面启动、安装包与卸载](distribution.md)。

本仓库尚未携带生产证书：macOS Developer ID/公证、Windows Authenticode 和自动更新签名应通过 CI secret 注入，绝不能写入仓库。未签名产物仅用于开发和内部评估。

## DOC/DOCX 回归要求

DOCX 变更至少应覆盖：安全 ZIP 包检查与解压上限、导入 HTML 清理、受支持节点/标记白名单、兼容性告警和只读判定、源文件外部变更拒绝、生成包回读校验、保存前快照，以及临时文件提交失败时源文件保持不变。DOC 还应覆盖隔离 LibreOffice profile、超时/进程树清理、DOCX→DOC→DOCX 回读、OLE 签名、正文一致性和同源原子写回。自定义 LibreOffice 路径还必须测试应用级记录、规范路径与 SHA-256 复核、确认期间替换、项目内可执行文件、符号链接、非可执行文件以及清除记录。人工回归应分别用简单论文、表格、链接、多种嵌入图片和包含修订/批注/公式/宏等高级结构的样本验证，并用 Word 与 LibreOffice 各打开一次生成结果；这项检查验证可读性，不代表像素级版式相同。

## 依赖与许可证

顶层版本使用精确版本，升级时一次只升级一个相关版本组（Electron/Forge、React/Vite、Tiptap、测试工具），运行三平台 CI 并检查原生 ABI。当前 DOCX 路径的主要开源组件为 Tiptap/ProseMirror、`docx`、`sanitize-html`（MIT）和 Mammoth（BSD-2-Clause）；发布材料应从实际 lockfile 生成完整第三方许可证与 notices，不能用这份高层列表替代。

增加新的下载 provider 或插件运行时前仍必须审查许可证、维护状态、二进制来源和商用分发条款。现有 conda-forge/Pixi provider 的来源固定、摘要和失败清理不能被新 provider 绕过；发布时还必须从实际解析结果汇总第三方软件包许可证。
