# Codex CLI 集成

Research IDE 使用经过验证的 Codex CLI 启动 `codex app-server --stdio`，而不是解析终端界面输出。`app-server` 是 Codex 为 IDE 和其他富客户端提供的双向 JSON-RPC 接口，可覆盖身份验证、持久对话、模型设置、审批和流式执行事件；`codex exec` 更适合一次性非交互任务，不适合作为桌面对话面板的长期协议层。

应用启动 app-server 后先执行 `initialize` / `initialized` 握手，再按当前 CLI 返回的能力决定是否启用会话列表、模型目录、思考强度和自动审查。Research IDE 不假定某个固定 Codex 版本必然拥有全部字段：缺少所需的只读/工作区权限配置时会拒绝进入智能体模式，缺少可选能力时则显示明确的降级状态。

## CLI 来源与更新

“工具箱 → Codex CLI”统一显示检测状态、来源、版本和规范路径。首次缺失或选择失效时，可以使用两种安装入口：

- **系统 PATH**：打开项目或工具箱时自动探测项目目录之外的可信 Codex；
- **手动导入**：系统文件选择器选定可执行文件后，主进程检查规范路径、可执行权限、`codex --version` 和 SHA-256，用户确认后才保存选择。文件改变后立即停用，必须重新确认；
- **Research IDE 管理**：从 `openai/codex` 的 GitHub Releases API 读取当前平台最新稳定版，只接受 OpenAI 仓库的精确平台资产、官方 GitHub SHA-256 digest 和受限大小。下载使用独立暂存目录，校验并运行版本探测成功后才原子切换到新的版本目录。

Codex CLI 是 latest-only 工具：已有可用版本后，界面只提供“检查更新”和“更新”；不会展示、选择或切换历史版本。非托管来源需要更新时，新版安装到 Research IDE 应用数据目录，不覆盖原系统或导入文件。

托管文件位于应用数据的 `codex-runtime/versions/<version>/`，不会覆盖系统 Codex、写入项目或移动 `CODEX_HOME`。更新会先保留旧版本并完整安装新版本，成功后才切换选择；切换运行时会停止 Research IDE 当前的 app-server，下一次启动或发送消息时使用新 CLI，持久对话不受影响。发行目录检查是显式网络操作，界面在用户点击“检查版本”前不会访问 GitHub。

当前下载器支持 OpenAI 正式发布的 macOS、Linux 和 Windows x64/arm64 原生资产；其他 CPU/平台会显示不支持而不是尝试执行不匹配的文件。Windows 的系统探测仍兼容标准 npm `codex.cmd` 布局，但托管安装始终使用独立原生 `codex.exe`。

## 项目工具链

Codex 启动前，主进程只把当前项目中用户已经选择且再次校验通过的 LaTeX、Python、R、Pandoc、编译器和 Julia 暴露为应用拥有的 PATH 包装器。托管工具的包装器同时注入由版本服务复核的最小激活环境，避免 R/Python 因缺少其隔离环境而不可运行；项目文件不能提供或替换这些包装器。

创建或恢复线程时，职责说明会列出实际可用的命令及版本，并明确这些命令只服务当前项目。安装、更新、移除和切换工具链仍是 Research IDE 的用户操作，不会暴露给 Codex。项目切换会停止旧 app-server；每次发送前还会复核选择和指纹，因此被替换的工具不会继续静默执行。

## 诊断

在系统终端中可以先运行：

```bash
codex --version
codex doctor --json --summary
```

`doctor` 会分别报告安装、认证、配置、app-server、网络和本地状态问题。网络不可达、账户未登录和 app-server 协议不兼容是不同问题，不应只显示为“连接失败”。开发阶段需要核对当前 CLI 的精确协议时，可以从同一个 Codex 可执行文件生成对应版本的 TypeScript 或 JSON Schema：

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

Research IDE 的自动化测试使用本地假 app-server 验证 stdio 消息合同；发布验证还应在各目标平台用真实 Codex CLI 运行登录、对话恢复、归档、取消归档、删除、模型切换和审批回退测试。

## 本地状态与安全边界

应用使用自己的 `CODEX_HOME`，不把令牌、API key 或线程数据库写进科研项目。官方登录凭据由操作系统凭据库管理；OpenAI-compatible API key 只在当前主进程和受控子进程内存中存在。线程归档与删除均调用 app-server 的 `thread/archive`、`thread/unarchive` 和 `thread/delete`，调用前由主进程重新检查线程是否属于当前项目。删除是不可恢复操作，Renderer 必须再次确认；归档只影响会话列表，不删除对话内容。
