# 桌面启动、安装包与卸载

## Linux 图形启动

Linux 文件管理器不一定把任意 ELF 文件当作可双击启动的应用。本次检查中，`research-ide` 本身是 `0755` 的有效 ELF，命令行启动和 Electron 原生 smoke test均可工作，但桌面会话对 `application/x-executable` 没有默认 handler。因此，Forge 生成的 raw unpacked 目录不是面向最终用户的“安装结果”。

推荐使用 `.deb` 或 `.rpm`。两种安装包都会安装 Freedesktop desktop entry 和 `/usr/bin/research-ide`，该入口指向包内的 `research-ide-launcher`。启动器会：

- 解析自己的绝对安装路径，不依赖文件管理器的工作目录；
- 移除会改变 Electron 启动语义的 `ELECTRON_RUN_AS_NODE` 和 `NODE_OPTIONS`；
- 保持 Chromium/Electron 沙箱开启，绝不添加 `--no-sandbox`；
- 把启动器自身的标准输出写入 `${XDG_STATE_HOME:-~/.local/state}/research-ide/launcher.log`。
- 在同一目录创建固定 `launcher-state` 所有权标记，使卸载器能够验证后清理该日志，而不触碰其它应用状态。

Linux ZIP 是免安装分发，解压后运行同目录的 `research-ide-launcher`。不要只复制其中的 ELF；Electron 的 shared libraries、resources 和 ASAR 必须保持在同一目录树中。

应用主进程还会把有界、脱敏的启动阶段事件写入应用数据目录的 `logs/startup.log`。窗口资源加载失败、renderer 崩溃、窗口无响应或主进程初始化失败时会显示原生错误框，不再无限保持隐藏窗口。

### 陈旧单实例锁

被强制终止的 Electron 进程可能在 user data 中留下 `SingletonLock`、`SingletonCookie` 和 `SingletonSocket`。旧实现拿不到单实例锁后静默退出，表现为双击无响应。

Research IDE 现在只在 Linux 上自动恢复可严格证明为陈旧的锁：`SingletonLock` 必须是以本机 hostname 和数字 PID 命名的符号链接，该 PID 必须在两次检查中都不存在，三个候选必须仍是最初检查到的同一符号链接。恢复只 unlink 这些链接本身，从不跟随或删除 socket 目标。活跃 PID、格式异常、普通文件、目录或检查期间变化都会关闭失败并保留原文件。

## 分发矩阵

| 平台 | Forge maker | 产物 |
| --- | --- | --- |
| Windows | Squirrel.Windows | `ResearchIDE-Setup.exe`、NuGet 包与 `RELEASES` |
| Linux | Debian、RPM、ZIP | `.deb`、`.rpm`、免安装 `.zip` |
| macOS | DMG、ZIP | `.dmg`、`.zip` 中的 `.app` |

Windows 主入口在载入 SQLite 和完整 IDE 服务前处理 Squirrel 的 install、updated、uninstall 和 obsolete 参数，并使用与 `name = research_ide` 一致的 `com.squirrel.research_ide.research-ide` AppUserModelId。macOS DMG 和 Windows Squirrel 正式发布前仍须分别配置 Developer ID/公证与 Authenticode；证书只从 CI secret 注入。

Electron/Forge 不保证任意跨平台交叉构建：

- DMG 必须在 macOS 上制作；
- Squirrel Windows 应在 Windows runner 制作（Linux 需要额外 Wine/Mono，当前不作为受支持发布路径）；
- DEB 需要 `fakeroot`/`dpkg-deb`，RPM 需要 `rpmbuild`；
- 当前主机只应把本机产物的真实构建成功视为验证，其他平台由对应 GitHub Actions runner 验证。

## 安全卸载

仓库根目录提供：

- Linux 图形入口：双击 `Uninstall Research IDE.desktop`（部分文件管理器首次会要求选择“允许启动”）；
- Linux 图形包装器：`./uninstall-research-ide-gui`，用于终端启动或没有 `.desktop` 支持的环境；
- Linux/macOS：`./uninstall-research-ide.sh`
- Windows PowerShell：`.\uninstall-research-ide.ps1`

`.deb`/`.rpm` 安装后，可以在桌面环境中右键 Research IDE 应用入口并选择“卸载 Research IDE”；该标准 Desktop Action 使用固定的 `/usr/lib/research-ide/uninstall-research-ide-gui`。Linux ZIP 解压目录顶层同样包含 `Uninstall Research IDE.desktop` 和相邻包装器。`.desktop` 通过自身 `%k` 位置和 `/usr/bin/find -execdir` 找到相邻包装器，不依赖文件管理器碰巧设置的当前目录，也不把路径插入 shell 命令。

图形卸载流程先让用户选择“仅卸载应用并保留设置、工具链和会话”或“同时删除本地数据”，随后调用 CLI dry-run 展示经过标记与路径校验的完整计划。只有第二次明确确认后才执行，并始终显示成功、失败或取消结果。系统 DEB/RPM 的包管理阶段通过 PolicyKit 显示授权窗口；`apt-get`、`dnf`、`rpm` 与 `pkexec` 只从 `/usr/bin`、`/bin`、`/usr/sbin`、`/sbin` 的固定系统目录解析，永不信任桌面会话或用户提供的 `PATH`。没有 Zenity/KDialog/Xmessage 时会回退到终端，并要求精确输入 `UNINSTALL`。

安装包内部也携带同一平台 CLI 脚本：Linux/macOS 位于应用 `resources/uninstall/`，Windows 位于版本目录的 `resources\uninstall\`。脚本只使用系统自带的 POSIX shell 或 PowerShell，不依赖 Node，也不依赖被 fuse 禁用的 Electron RunAsNode。

不要把 `uninstall-research-ide.sh` 当作双击入口：不同文件管理器可能显示文本、静默退出或完全禁止执行 `.sh`。这个名称保留给可审计的 CLI dry-run/自动化流程；需要图形确认和结果反馈时，应使用名称明确的 `Uninstall Research IDE.desktop`。

卸载器默认只做 dry run。默认计划删除经验证的 Research IDE 安装和应用数据，但永远保留研究项目：

```bash
./uninstall-research-ide.sh \
  --install-dir "/path/to/research-ide" \
  --data-dir "$HOME/.config/Research IDE"
```

检查计划后显式执行：

```bash
./uninstall-research-ide.sh --execute \
  --install-dir "/path/to/research-ide" \
  --data-dir "$HOME/.config/Research IDE"
```

`.deb`/`.rpm` 的系统安装由 apt/dpkg 或 dnf/rpm 保持所有权；脚本验证 `/usr/lib/research-ide` 后调用系统包管理器，不直接递归删除 `/usr` 下的目录。Windows Squirrel 安装则调用相邻且非 reparse point 的 `Update.exe --uninstall`。macOS app bundle和用户拥有的 ZIP/portable 目录可以在验证后直接移除。

项目删除必须同时给出项目 opt-in 和每个项目的规范化精确路径确认：

```bash
./uninstall-research-ide.sh --execute \
  --keep-installation --keep-data \
  --project "/absolute/path/to/paper" \
  --delete-projects \
  --confirm-project "/absolute/path/to/paper"
```

没有 `--confirm-project` 的交互执行会要求手工输入完整规范路径；非交互执行直接拒绝。PowerShell 使用对应的 `-Execute`、`-Project`、`-DeleteProjects` 和 `-ConfirmProject` 参数。

### 删除边界

安装目录必须含有固定 `org.researchide.desktop` 的 `application-installation` JSON manifest和正确可执行文件；应用数据必须含同一 install id 的 `application-data` marker；Linux 启动日志目录必须含独立的 `launcher-state` marker。项目必须同时有合法 `.research_ide/project.toml`、项目 id 和官方 schema `$id`。删除前会再次验证目录身份或所有权标记。

以下目标一律拒绝：

- 文件系统根、盘符根、用户 home 或 home 的祖先；
- 符号链接、Windows reparse point、逸出候选目录的 marker；
- 名称/布局不属于 Research IDE，或 JSON/TOML/schema 标记不匹配的目录；
- 含换行或内部计划分隔符的路径；
- 未逐路径确认的项目。

这些脚本不会搜索磁盘并“猜测”安装或项目位置，也不会删除其他应用共享的目录。
