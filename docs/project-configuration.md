# 项目配置

每个 Research IDE 项目可在根目录保存 `.research_ide/project.toml`。TOML 便于用户审阅和版本管理；读取后必须用随应用发布并复制到 `.research_ide/project.schema.json` 的 [规范 schema](project.schema.json) 做运行时校验。配置无效时应用拒绝打开该项目并显示具体字段错误；若已有项目正在使用，则保持原项目不变，不能猜测可执行路径或审批策略。

## 示例

```toml
schema_version = 1

[project]
id = "018f5f52-1c2b-7ca0-b57d-4c62cb142905"
name = "my-paper"
kind = "paper"

[paths]
include = ["manuscript/**", "analysis/**", "references/**"]
exclude = ["**/.git/**", "**/__pycache__/**", "**/node_modules/**"]

[toolchains.latex]
source = "system"

[toolchains.python]
source = "managed"
path = "python/3.13.7/.pixi/envs/default/bin/python3"

[toolchains.r]
source = "custom"
path = "/usr/local/bin/R"

[backup]
enabled = true
include = ["manuscript/**", "analysis/**/*.py", "references/*.bib"]
exclude = ["**/*.aux", "**/*.log", "**/.DS_Store"]
max_snapshots = 50

[codex]
approval_policy = "always"
```

Windows 自定义路径推荐使用 TOML literal string，例如 `path = 'C:\\R\\R-4.5.1\\bin\\R.exe'`。

## 规则

- `schema_version` 用于显式迁移；应用只写自己支持的版本，并在迁移前备份原文件；
- `project.id` 创建后稳定不变，移动目录不应改变项目身份；
- 相对 glob 都以项目根目录为基准；
- 打开项目后会在后台执行一次工具检测；本次项目会话首次打开工具链视图会等待同一个检测任务，不会重复扫描。工具链面板中的“重新检测”才会显式刷新缓存；
- `source = "system"` 只会从应用进程继承的 `PATH` 与少量固定系统目录候选中解析，并拒绝解析到项目目录内的程序；macOS 额外覆盖 Finder 启动时常缺失的 Homebrew、TeX 与 R Framework 位置；
- `source = "managed"` 的 `path` 由工具链面板写入，必须匹配 Research IDE 用户数据目录下 `toolchains/` 中已完成的 `install.json`、平台、软件包、版本与可执行文件 SHA-256；手写路径、越界路径、被替换的程序与指向目录外的符号链接都会被拒绝；
- `source = "custom"` 必须是绝对路径，并且只有规范路径与文件 SHA-256 都匹配用户通过系统文件选择器确认的记录时才会自动绑定；文件内容变化后必须重新选择。旧版字符串路径按 `custom` 处理，仍须重新确认；
- 用户可把当前 PATH 结果显式设为项目默认，也可通过工具链面板确认自定义程序；自定义选择会先把规范路径与 SHA-256 写入用户数据目录中的确认登记，再以临时文件和原子替换方式写回结构化 `project.toml`，写入前后都执行 schema 校验；
- `.research_ide/state.sqlite` 中的工具链表只是可重建缓存，不能单独授予程序执行权限；无效、越界或未经确认的配置一律阻止绑定，但系统 PATH 检测结果仍可供用户查看；
- `backup.include` 是用户明确选择的备份范围，不能默认把整个 home、`.git`、环境目录或机密纳入；
- `backup.include/exclude/max_snapshots` 在 0.1 是供后续保留策略使用的保留字段；当前快照以 UI 中的明确文件选择为准，不会根据未实现的自动策略静默删除历史；
- `codex.approval_policy` 在 0.1 中只允许 `always`，防止配置文件自行降低安全策略；
- 配置中禁止保存 API key、OAuth token、Zotero secret 或其他凭据。

## 本地状态

`.research_ide/state.sqlite` 是本地缓存和状态库，不是配置替代品。团队可以选择忽略它以及 `history/`、`backups/`；如果要共享项目配置，可只提交 `project.toml`。SQLite `quick_check` 发现损坏时，应用会把数据库及 WAL/SHM 隔离到 `history/database-corrupt-*` 后重建空状态库；正文仍以项目文件为准，并可直接由其他编辑器打开。

新初始化的项目还会生成 `.research_ide/codex-policy.md`，供项目所有者审阅应用默认安全边界。它只是审计副本，不是授权来源；修改或删除该文档不会改变 Electron 主进程、沙箱或 Codex app-server 实际执行的权限。
