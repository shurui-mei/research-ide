# 安全模型

Research IDE 会打开不受信任的论文、代码、PDF 和项目配置，也会运行本地工具并连接模型服务。安全边界必须把“展示内容”“访问项目”“执行命令”“访问网络”和“读取机密”视为不同能力。

## 信任假设

- 用户选择的项目内容不可信，可能包含恶意 HTML、LaTeX、Python 或符号链接；
- renderer 与其加载的文档内容不可信；
- LaTeX 编译器、解释器、Zotero 和 `codex app-server` 是外部进程，输出必须视为不可信数据；
- 主进程代码和经过验证的 preload 是可信计算基；
- 用户的一次授权只适用于界面中清楚描述的能力，不应默认为永久授权。

## Electron 基线

生产窗口必须保持以下不变量：

- `contextIsolation: true`；
- `nodeIntegration: false`；
- `sandbox: true`（除非某个平台存在被记录、被测试的必要例外）；
- 禁止 renderer 导航到任意远程页面，外链由主进程校验后交给系统浏览器；
- preload 只暴露结构化、有限的 capability API；
- 使用严格 CSP，生产包只加载应用自身资源；
- 打包启用 ASAR、原生模块定向 unpack，并关闭 Electron `RunAsNode`、`NODE_OPTIONS` 和 CLI inspect 等 fuse；
- 权限请求、窗口创建和下载默认拒绝，按功能逐项放行。

## 文件系统

主进程在每次文件操作时都应：

1. 解析项目根目录和候选路径的绝对、规范化形式；
2. 检查路径确实位于项目根内，不能仅比较字符串前缀；
3. 对既有路径解析符号链接并防止逃逸；
4. 对新文件验证其最近存在父目录，写入后再次检查；
5. 拒绝设备文件、命名管道和非预期协议；
6. 使用大小上限、超时和取消，避免搜索或二进制读取拖垮主进程。

0.1 在 Node.js 层使用 `realpath`、`lstat`、父目录复核和元数据目录持续校验，并对普通符号链接逃逸 fail closed；它无法把多步文件操作变成内核级 `openat/O_NOFOLLOW` 事务。若另一个恶意进程在校验与写入之间持续竞态替换目录，仍存在 TOCTOU 残余风险。不要在对抗性共享目录中运行高影响操作；后续 Rust sidecar 应以目录句柄完成这一硬化。

删除、覆盖和恢复是高影响操作。UI 需要显示完整相对路径，备份/回收策略应先于不可逆删除；Codex 发起、且超出当前沙箱直接许可范围的文件操作还需要经过原生自动审查或人工回退审批。

## DOCX 内容与保存

DOCX 是不可信 ZIP/OOXML 输入。主进程在转换前检查包结构、重复/越界条目、加密、压缩方式、条目数量、展开体积和压缩比，并限制 XML、文档树、单张图片及图片总量。Mammoth 产生的 HTML 必须经过标签、属性、协议和 data URI 白名单清理后才可进入 renderer；外部媒体不会自动获取。

保存不是对任意原 OOXML 的无损修改。宏、数字签名、嵌入对象和 `altChunk` 等阻断结构只读打开；可能丢失的高级 Word 功能必须在保存前由用户确认。主进程还会比较打开时和保存前的源文件 SHA-256，外部变化一律要求重新加载。新包需在内存中完成结构校验和转换回读，随后为原文件创建 `.research_ide/backups/` 快照，最后使用同目录独占临时文件、`fsync` 和 rename 提交；提交失败时不应触碰原文件。

旧版 DOC 的自定义 LibreOffice 选择是应用级信任，不是项目配置：规范路径、SHA-256 和确认时间只保存在 `userData/legacy-doc/`。选择和每次转换前都拒绝项目内路径、符号链接路径、非普通文件及非可执行文件，并以稳定文件句柄计算完整哈希；二进制更新或被替换后关闭失败，不能静默沿用旧确认。LibreOffice 仍只接触应用数据中的隔离副本，不直接获得项目 DOC 路径。

## 命令和工具链

- 可执行文件必须来自已探测、用户选择或经过校验的托管 provider；
- 自定义可执行文件的自动绑定同时校验文件选择器确认的规范路径与 SHA-256，并在实际运行前复核；同路径文件被替换后必须重新确认；
- 使用参数数组和 `shell: false`，禁止把用户文本拼成命令行；
- `cwd` 必须在 active project 内；
- 默认清理继承环境，只传递执行所需变量；
- 输出设字节上限并去除终端控制序列；
- 每次运行有 run id、超时、取消入口和退出状态；
- 长任务与版本探测使用 POSIX process group 或 Windows task-tree 终止，stdin 在无交互终端能力时立即关闭；
- 下载内容必须使用 HTTPS、固定发布来源、校验 checksum，并在执行前展示版本、体积和许可证。

LaTeX 的 `--shell-escape`、Python/R 脚本以及任何可执行构建钩子都可能运行任意代码，应被视为命令执行而不是普通“预览”。

## Codex 稳定调用流程

Codex 集成只通过主进程托管的 `codex app-server` stdio JSON-RPC 工作。Renderer 不能直接启动 Codex 或持有登录凭据。

每个会话按以下状态机运行：

1. **启动与握手**：启动固定/用户确认的 app-server 路径，协商协议能力，设置请求超时和消息大小上限；非 JSON 输出进入脱敏诊断流。
2. **职责声明**：创建或恢复线程时发送 project root、只读/智能体模式、允许的工具、网络策略和审批策略。Codex 必须知道它只能操作当前项目及用户选择的上下文文件。
3. **计划与请求**：Codex 可以解释、检索和提出工具调用，但不能把自然语言消息当作授权。
4. **审批**：问答模式固定为 `read-only + never`，越权动作直接失败；智能体模式使用 Codex 原生 `approval_policy="on-request"` 与 `approvals_reviewer="auto_review"`。主进程同时提供应用控制的本地 auto-review policy，要求拒绝项目外访问、凭据探测、安全弱化、不可逆破坏以及未经明确授权的数据外发；项目文件不能改写该 policy。自动审查只更换审批者，不扩大持久沙箱配置。自动审查不可用、被组织策略禁止或协议版本不支持时，主进程回退到 `approvals_reviewer="user"` 并显示人工审批卡片，Renderer 不得自行批准。
5. **执行**：自动审查的批准/拒绝由 app-server 完成；人工回退时，仅主进程可把用户针对当前 approval id 作出的决定回复 app-server。Computer Use 等仍要求应用级提示的操作不会被 Renderer 静默批准；本版本同时保持 Apps、Computer Use 和任意动态工具关闭。
6. **审计与撤销**：`item/autoApprovalReview/started|completed` 的状态、风险等级和理由显示在执行时间线；人工允许、拒绝、取消和超时也作为事件记录。用户可取消 turn、停止子进程或结束线程。

“本次允许”只能授权完全相同且规范化后的能力范围；不得把一次 `git status` 扩大为所有 `git` 命令，也不得把某个文件的写入扩大为整个磁盘。拒绝、超时、协议断开均按 deny 处理。

对话由 app-server 在 Research IDE 专用的应用数据 `CODEX_HOME` 中持久化，不写入项目目录。主进程通过 `thread/list` 的 cwd 过滤列出当前项目对话，并在 `thread/read` 后再次核对 cwd 与响应中的精确 thread id，随后才允许 `thread/resume`；猜测其他项目的 thread id 不能读取或恢复其内容。归档和取消归档直接调用 app-server 的持久化接口；永久删除必须先由 Renderer 显示目标对话名称并取得明确确认，主进程随后再次校验精确 id、当前项目归属和无活动任务，最终只把该 id 交给 `thread/delete`。恢复历史使用 `thread/turns/list` 的不透明 `nextCursor` 分页，每页最多 50 轮；主进程按 turn id 去重、反转为时间正序，并设置 500 轮、16 MiB 与 20 页的本地硬上限，重复 cursor 或未安全结束的分页也会立即停止。达到任一上限时 Renderer 明确提示更早内容未加载，不会把“最近一页”静默伪装成完整对话。模型和思考强度来自实时 `model/list`，写入线程设置时仍由主进程校验。若当前 CLI 缺少这些方法，面板显示能力降级而不是伪造列表或模型。

上下文选择器可搜索当前项目树，而不只列出已打开文件。已经保存的文件使用 app-server mention；如果用户明确选择了尚未保存的编辑页签，Renderer 会先去除内嵌图片 base64，再把当前文本或 ProseMirror JSON 作为有单项/总量上限的 buffer 交给主进程。主进程重新验证该路径确实是同一项目中的已选文件，并把 buffer 标注为不可信项目内容；同一路径不会再同时发送旧磁盘 mention，避免 Codex 在两个版本之间产生歧义。未被用户选中的未保存页签不会进入上下文。

Codex 面板不持续显示项目边界和审批原理等说明文字，只保留真正需要用户决策的审批卡片与执行状态。这只是界面降噪，不是安全策略迁移：主进程校验、Electron 沙箱、app-server 启动参数和审批状态机仍是实际约束。新初始化项目中的 `.research_ide/codex-policy.md` 是供项目所有者审阅的默认策略副本；它不是 prompt 注入点或授权文件，修改、删除或把它加入版本控制都不能改变运行时权限。

## 登录与机密

优先复用 Codex 官方支持的浏览器/设备登录流程，让凭据由官方客户端和系统保护机制管理。API key 与 OpenAI-compatible endpoint 是显式的高级配置：

- API key 输入框不回显，只在 React 受控表单内短暂存在，提交后立即清空且不写入 Web Storage 或日志；
- 官方 ChatGPT/API Key 登录由 `codex app-server` 管理，并强制设置 `cli_auth_credentials_store="keyring"`；系统凭据库不可用时登录失败关闭，不回退到明文 `auth.json`；
- OpenAI-compatible endpoint 的 key 可留空，以连接明确配置的无鉴权本地/HTTPS 兼容服务；留空时不生成 `env_key` 或密钥环境变量。有 key 时只保留在主进程内存及受控 app-server 子进程环境中，退出应用或断开连接后丢弃；
- 自定义 base URL 只接受 HTTPS，localhost 开发例外必须明确开启；
- 日志过滤 `Authorization`、API key、device code、URL 查询参数和用户主目录；
- 登出需要通知 app-server、清除内存副本并删除持久凭据。

任何机密都不得放入项目 TOML/SQLite、本地版本快照、Codex prompt 上下文或 Git。

## SQLite 与 IPC

SQLite 查询使用参数绑定，迁移在事务中完成；数据库只保存元数据，不保存唯一一份正文。打开时执行 `quick_check`，损坏库先隔离到项目历史目录再重建。IPC 执行 sender/window 校验，并对路径、字符串、数组和大小边界做主进程运行时验证；项目 TOML 使用 Ajv/JSON Schema 校验。后续新增 IPC 必须同步补齐请求/响应 schema，TypeScript 类型本身不能代替运行时验证。

## 发布供应链

CI 使用精确顶层依赖并提交 lockfile，GitHub Actions 权限最小化。正式版本应在各平台完成代码签名、公证、生成 SHA-256 清单和 SBOM；在这些工作完成前，构建产物应标为开发预览，不鼓励绕过操作系统安全提示。
