# Codex CLI 集成

Research IDE 使用系统中受信任的 Codex CLI 启动 `codex app-server --stdio`，而不是解析终端界面输出。`app-server` 是 Codex 为 IDE 和其他富客户端提供的双向 JSON-RPC 接口，可覆盖身份验证、持久对话、模型设置、审批和流式执行事件；`codex exec` 更适合一次性非交互任务，不适合作为桌面对话面板的长期协议层。

应用启动 app-server 后先执行 `initialize` / `initialized` 握手，再按当前 CLI 返回的能力决定是否启用会话列表、模型目录、思考强度和自动审查。Research IDE 不假定某个固定 Codex 版本必然拥有全部字段：缺少所需的只读/工作区权限配置时会拒绝进入智能体模式，缺少可选能力时则显示明确的降级状态。

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

