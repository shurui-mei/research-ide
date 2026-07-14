# 0.1 MVP 范围

MVP 的目标不是一次性替代 TeXstudio、Word、Zotero、Conda 和 VS Code，而是验证它们可以在一个项目模型和一个可审计的安全边界内协作。

## 本阶段范围

| 领域 | 0.1 目标 |
| --- | --- |
| 项目 | 创建/打开本地文件夹、文件树、最近项目、`.research_ide` 配置与本地状态 |
| 文本/LaTeX | Monaco 编辑、保存、系统 LaTeX 探测、受控编译、日志与 PDF 预览 |
| DOC/DOCX/富文本 | 直接打开和保存 `.docx`；通过受约束的本地 LibreOffice 兼容引擎打开/写回 `.doc`；支持常用科研排版、表格、链接与图片，并在可能丢失高级结构时提示或只读 |
| PDF | PDF.js 只读预览、页码/缩放等基础操作 |
| 工具箱 | 项目打开时自动探测系统工具；通过本地版本中心安装/并存/切换 LaTeX、Python、R、Pandoc、C/C++ 与 Julia，并以 latest-only 流程管理 Codex CLI；按 `.research_ide/project.toml` 绑定并结构化运行/停止 |
| Codex | app-server 生命周期、系统凭据库登录或会话型 OpenAI-compatible 配置、持久对话切换与有界分页恢复、动态模型/思考强度、问答/智能体、原生自动审查与人工回退、取消 |
| 文献 | 本地元数据/附件入口以及 Zotero adapter 的检测与连接边界 |
| 版本/备份 | 对用户选择的文件建立本地快照和可配置保留策略；不修改用户 Git 历史 |
| 质量 | Vitest、Playwright、三平台 CI、Forge makers、安全 fuse 与原生模块 rebuild |

部分能力会先以 provider/adapter 和明确的“尚未安装/尚未连接”状态出现。界面不得把不可用操作伪装成成功，也不得为了演示静默执行下载或命令。

## 明确不在本阶段

- 插件市场、第三方插件安装、签名和沙箱；
- 无损保留任意 Word 结构、修订/批注编辑、复杂分页和 Word 完整兼容；
- 内置完整 TeX Live/MiKTeX 镜像、离线 Python/R 镜像或任意来源的二进制安装器；
- Zotero 数据库的直接写入，以及对 Zotero 私有内部 schema 的绑定；
- 云同步、多人实时协作、托管备份；
- 自建 Git UI、远程 Git 凭据管理或替代 Git；
- 自动执行 Codex 命令的全局“永远允许”模式；
- 生产代码签名、公证、自动更新服务和遥测后端；
- Rust sidecar（仅保留接口迁移方向）。

## DOC/DOCX 说明

MVP 直接编辑原 `.docx`，无需先转换成应用专用文稿。Tiptap/ProseMirror 提供编辑模型，Mammoth 负责语义导入，`docx` 负责重新生成 OOXML，导入 HTML 由 `sanitize-html` 清理。当前支持文本及常用行内格式、字体/字号/颜色、行距、段前后、对齐、首行/左右缩进、标题、列表、表格、HTTP(S)/邮件链接，以及 PNG/JPEG/GIF/BMP 嵌入图片。旧版 `.doc` 对用户仍以同一源文件打开和保存，但底层需本机受信任的 LibreOffice 做隔离往返转换，边界见 [旧版 DOC 支持](legacy-doc-support.md)。

这条路径并不承诺 Word 完整保真。普通文件在首次保存前也会提示保存将重新生成版式；修订、批注、脚注/尾注、页眉页脚、公式、域、SmartArt 等会产生需要确认的兼容性警告，宏、数字签名、嵌入对象或 `altChunk` 等无法安全保留的结构会强制只读。每次保存先拒绝外部已修改的源文件，再创建保存前快照并原子替换同一个 `.docx`。完整规则见 [DOCX 支持范围](docx-support.md)。

## 下载说明

本地版本中心从 conda-forge 获取版本，由应用下载并校验带 GitHub SHA-256 摘要的 Pixi 管理器，再让 Pixi 在 Research IDE 用户数据目录的隔离 workspace 中解析和安装。安装不修改系统 PATH；`install.json` 最后写入，失败目录会清理，项目只保存经校验的相对可执行路径和版本选择。第三方包仍适用各自许可证，完整设计与平台边界见 [本地工具版本中心](managed-toolchains.md)。

## 验收底线

1. 未打开项目时，文件和命令能力不可调用；
2. Renderer 无法直接使用 Node.js 或任意 IPC；
3. 路径规范化、既有符号链接和元数据目录替换逃逸会被拒绝；对抗性并发目录替换的残余 TOCTOU 风险按安全文档明确披露；
4. Codex 智能体以 `on-request + auto_review` 自行审查越权请求并显示审查结果；不支持自动审查时回退到可读的人工审批界面，问答模式始终只读并 fail closed；
5. API key 不进入项目、SQLite、日志或备份；
6. 缺少 LaTeX/Python/R/Zotero/Codex 时应用保持可用并给出可操作诊断；
7. 用户文稿不依赖 SQLite 才能恢复；
8. DOCX 的兼容性警告不能被静默忽略；保存失败不能覆盖源文件，保存前快照必须可识别；
9. 同一项目会话自动检测工具一次，项目配置不能通过未确认路径授予执行权限；
10. 三个平台至少完成安装依赖、类型检查、单元测试和 unpacked package。
11. 受管版本的管理器摘要、安装记录和可执行文件哈希必须通过校验；失败安装不能成为可选择版本。
