# Research IDE （开发中）

Research IDE 是一个跨平台、local-first 的科研桌面工作台。它以“项目”为基本单元，把 LaTeX/代码写作、直接 `.doc`/`.docx` 论文编辑、PDF 阅读、文献管理、可并存版本的科研工具链和 Codex 协作放在同一个 Electron 应用中。

当前仓库是 `0.1.x` MVP：已提供受约束的 DOC/DOCX 编辑、项目级工具自动检测与本地版本中心、Codex 持久对话/模型控制/原生自动审查，以及较精简的工作区 UI；插件市场和 Word 完整保真不在本阶段交付范围内。详细边界见 [MVP 范围](docs/mvp-scope.md)。

`.docx` 可直接使用；旧版 `.doc` 会保持原文件路径和扩展名，但转换需要本机 LibreOffice。标准安装会被自动发现，非标准或便携版可在“设置 → 工具箱 → 旧版 Word 转换器”中选择并确认。

## 技术栈

- Electron + Electron Forge
- React 18 + TypeScript + Vite
- Monaco Editor、Tiptap OSS / ProseMirror、PDF.js
- SQLite、TOML + JSON Schema
- `codex app-server`（stdio JSON-RPC）
- Vitest + Playwright
- pnpm workspace

## 快速开始

需要 Node.js `22.13+`（推荐 22 LTS）和 pnpm `9.15+`。`better-sqlite3` 是原生模块，因此 Windows 可能需要 Visual Studio Build Tools，macOS 需要 Xcode Command Line Tools，Linux 需要常用 C/C++ 构建工具。

```bash
corepack enable
pnpm install
pnpm dev
```

常用命令：

```bash
pnpm build          # 生成当前平台的 unpacked 应用
pnpm package        # Electron Forge package
pnpm make           # 生成当前平台安装包
pnpm check          # lint + typecheck + unit tests
pnpm e2e            # Electron 端到端测试
pnpm rebuild:native # 为当前 Electron ABI 重编译 better-sqlite3
pnpm verify:release # 校验版本、安装升级身份与 release tag
```

## 打开已打包应用

Linux 最终用户应安装 `pnpm make` 生成的 `.deb`/`.rpm`，然后从应用菜单打开 Research IDE；免安装 ZIP 解压后运行 `research-ide-launcher`。不要依赖文件管理器直接双击 raw Forge ELF，因为桌面环境可能没有 `application/x-executable` handler。Windows 使用 `ResearchIDE-Setup.exe`，macOS 使用 DMG 中的 `Research IDE.app`。启动失败时可查看应用数据目录下的 `logs/startup.log`；Linux 启动器另写 `${XDG_STATE_HOME:-~/.local/state}/research-ide/launcher.log`。完整说明见 [桌面启动、安装包与卸载](docs/distribution.md)。

Linux 图形卸载请双击仓库或 ZIP 顶层名称明确的 `Uninstall Research IDE.desktop`，或从已安装应用的 Desktop Action 选择“卸载 Research IDE”。`.sh` 文件是默认 dry-run 的 CLI 入口，不作为文件管理器双击入口。

仓库根目录的 `uninstall-research-ide.sh` 与 `uninstall-research-ide.ps1` 提供严格标记校验的卸载入口。默认只预览计划且永不删除项目；项目删除必须单独 opt-in 并逐路径精确确认。

首次安装依赖后请提交生成的 `pnpm-lock.yaml`；CI 在初始引导阶段允许在缺少 lockfile 时解析精确的顶层版本，正式发布应始终使用已审阅的 lockfile。

## 项目模型

Research IDE 只在用户明确打开的项目根目录内工作。每个项目可包含 `.research_ide/`，保存项目配置、索引、版本快照和备份元数据；用户文稿仍是事实来源，数据库损坏不应导致正文丢失。访问令牌和 API key 永不写入项目目录。

```text
paper-project/
├── manuscript/
├── references/
├── analysis/
└── .research_ide/
    ├── project.toml
    ├── project.schema.json
    ├── codex-policy.md
    ├── state.sqlite
    ├── history/
    ├── backups/
    ├── build/
    └── trash/
```

配置格式见 [项目配置](docs/project-configuration.md)，系统设计见 [架构](docs/architecture.md) 与 [安全模型](docs/security.md)。

## 文档

- [架构与进程边界](docs/architecture.md)
- [安全模型与 Codex 审批](docs/security.md)
- [Codex 集成、会话与自动审查](docs/codex-integration.md)
- [开发、测试与打包](docs/development.md)
- [MVP 范围](docs/mvp-scope.md)
- [DOCX 支持范围](docs/docx-support.md)
- [旧版 DOC 支持](docs/legacy-doc-support.md)
- [本地工具版本中心](docs/managed-toolchains.md)
- [Codex CLI 与 app-server 集成](docs/codex-integration.md)
- [桌面启动、安装包与卸载](docs/distribution.md)
- [项目配置与目录约定](docs/project-configuration.md)

## 许可证

本项目使用 [MIT License](LICENSE)。第三方组件仍分别遵循其自身许可证；DOCX 路径使用 Tiptap/ProseMirror、`docx` 与 `sanitize-html`（MIT）以及 Mammoth（BSD-2-Clause）。Monaco Editor、PDF.js 和其他依赖也需按各自开源许可证分发，发布前仍应以 lockfile 生成完整许可证清单。
