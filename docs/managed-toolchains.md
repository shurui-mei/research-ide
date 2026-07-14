# 本地工具链版本中心

Research IDE 的工具链面板同时显示系统版本、自定义可执行文件和应用管理的本地版本。受管版本保存在 Electron `userData/toolchains/`，不会写入项目、全局安装目录或系统 `PATH`；不同项目可选择不同版本，同一工具的多个版本可以并存。

## 当前目录与软件包

| 面板工具 | conda-forge 软件包 | 首选可执行文件 |
| --- | --- | --- |
| LaTeX | `tectonic` | `tectonic` |
| Python | `python` | `python3` / `python` |
| R | `r-base` | `R` / `Rscript` |
| Pandoc | `pandoc` | `pandoc` |
| C/C++ | `clangxx` | `clang++` / `clang` |
| Julia | `julia` | `julia` |

版本目录来自 conda-forge 的当前平台 `main` 标签，最多显示最近 30 个版本；网络不可用时回退到上次缓存和已经安装的版本。软件包在某个平台没有构建时，列表可以为空。支持的安装平台是 Linux x64/arm64、macOS x64/arm64 和 Windows x64；其他组合仍可使用系统或自定义工具，但本地安装会明确报不支持。

旧版 DOC 所需的 LibreOffice 从固定系统位置、预置的 `toolchains/libreoffice/` 目录，或用户在设置中明确确认且每次使用前复核 SHA-256 的可执行文件发现。自定义选择只是应用级信任记录，不属于此下载 provider。当前没有把来源与跨平台校验信息不足的 LibreOffice 构建接入下载服务；因此工具链中心暂不承诺安装 LibreOffice。

## 安装事务

1. 主进程从固定 HTTPS API 读取 conda-forge 版本目录；
2. 首次使用时从 `prefix-dev/pixi` 的 GitHub release 选择当前平台的精确资产，同时要求 release metadata 提供 SHA-256 digest 和可信大小；下载后逐字节摘要与大小必须完全一致；
3. 应用在 `toolchains/<tool>/<version>/` 写入只包含固定 `conda-forge` channel 和精确版本约束的 `pixi.toml`；
4. Pixi 使用独立的 home/cache、禁用用户配置并以参数数组运行，不经过 shell，也不修改系统 PATH；C/C++ 使用带真实 LLVM 版本号的 `clangxx`，而不是只显示自身版本的编译器元包；
5. 安装完成后，应用在版本目录内查找规范可执行文件，解析真实路径、拒绝目录逃逸并记录 SHA-256；`install.json` 最后原子写入；
6. 任一步失败都会删除未完成的版本目录。安装有总时限与停滞时限；应用关闭或项目切换会取消网络流、终止进程树、等待退出，再清理未完成目录；
7. 选择后，项目的 `.research_ide/project.toml` 只记录相对于 `userData/toolchains/` 的可执行路径。重新打开项目和每次运行前都会复核安装记录与文件摘要。

已经选择给当前项目的版本不能直接移除。已安装但未选择的版本可以从面板删除；这只影响 Research IDE 的本地目录，不会卸载系统软件。下载/安装与项目绑定是两个事务：安装开始时记录项目会话，最终绑定重新进入串行项目队列；若期间切换项目，已下载版本最多保留为全局可用版本，绝不会写入另一个项目。

运行受管工具时，主进程从已经复核的安装记录推导环境前缀，只加入该 Pixi 环境实际存在的 `bin`、`Scripts`、`Library/bin` 等目录，并设置 `CONDA_PREFIX` 等最小激活变量。项目、Renderer 和用户 shell 都不能注入这组路径；命令审查仍展示最终工具可执行文件和原始参数。

## 信任与许可证边界

下载器只接受固定 HTTPS 主机并限制重定向、响应大小、总时长和停滞时间，并以流式写入和增量 SHA-256 避免把整个管理器复制到主进程内存。Pixi 自身负责 conda repodata、依赖解析和软件包内容校验；Research IDE 不把网页下载链接或项目文件当作安装来源。GitHub manager digest、最终可执行文件 hash 或安装记录任一不匹配时，该版本不可绑定和运行。

`toolchains/`、工具名、版本、管理器、缓存和环境子目录在操作前后都复核 `lstat`、`realpath` 与目录身份；符号链接、父目录替换和安装/删除同版本竞态会被拒绝。桌面进程使用单实例锁，避免第二个 Research IDE 进程绕开进程内版本锁。

conda-forge 是分发渠道，不会把所有包改成同一种许可证。安装确认框会提示第三方许可证边界；正式发布和再分发必须从实际 lock/包元数据生成许可证与 notices。用户还应按研究环境要求自行审查包版本、许可证和出口/组织政策。

真实下载属于显式用户操作，需要网络连接和磁盘空间。单元测试使用完全离线的 fake provider 覆盖版本过滤、Pixi digest、隔离目录、安装记录、项目绑定和篡改拒绝；发布前仍需在三平台 CI 或人工矩阵执行至少一次真实安装、切换、运行和移除回归。
