# 旧版 DOC 支持

Research IDE 将项目中的 `.doc` 作为原文件直接打开并保存，用户不需要手工另存为 `.docx` 或应用专用格式。旧版 `.doc` 是封闭的 OLE 二进制格式，因此应用没有把纯 JavaScript 转换宣传为“完整原生解析”：实际转换引擎是固定系统位置、Research IDE 托管目录，或用户明确确认的便携版 LibreOffice。

## 工作流程

打开 `.doc` 时，主进程把源文件的字节复制到 `userData/legacy-doc-work/job-*` 隔离目录，调用 LibreOffice headless 转换为临时 `.docx`，再经过与直接打开 `.docx` 完全相同的 ZIP、XML、外部关系、大小限制及 HTML 白名单检查。项目源文件不会作为 LibreOffice 的直接输入路径，也不会创建伴随 `.docx`。

保存时执行以下事务：

1. 校验编辑树并生成受验证的临时 DOCX；
2. 确认项目中的 `.doc` 与打开时记录的 SHA-256 相同；
3. 使用 LibreOffice 生成 Word 97 `.doc`；
4. 把生成结果重新转为 DOCX，执行完整安全检查并比较往返前后的正文；
5. 再次检查源文件哈希，并在 `.research_ide/backups` 创建保存前快照；
6. 在源文件目录独占写入临时文件、`fsync`，最后以 rename 原子替换同一个 `.doc`。

转换、验证、快照或提交任一步失败，原文件都不会被替换。如果其他应用在编辑期间或保存期间修改源文件，Research IDE 会要求重新加载。

## LibreOffice 发现

应用首先复核用户在“设置 → 工具箱 → 旧版 Word 转换器”中明确选择的 `soffice`、`libreoffice` 或便携版可执行文件；没有自定义选择时，才检查固定系统安装位置，以及 `userData/toolchains/libreoffice/current` 和 `userData/toolchains/libreoffice/<version>` 中的托管安装。它不会执行当前项目或任意继承 PATH 中恰好同名的程序，也不会自动下载 LibreOffice。

自定义选择会经过一次显示规范路径与 SHA-256 的确认。记录只写入 `userData/legacy-doc/trusted-executable.json`，不写项目目录，内容只有 schema 版本、规范路径、SHA-256 与确认时间，不包含文档内容或凭据。应用启动时及每次转换前都会重新检查记录和完整文件哈希；路径位于当前项目内、路径任一部分经过符号链接、目标不是普通可执行文件，或者文件更新/被替换时，转换都会关闭失败并要求重新选择。移除选择只删除这份应用级记录，不删除 LibreOffice 本身。

没有可用 LibreOffice 时，打开 `.doc` 会显示可操作错误，引导用户安装后在设置中选择可执行文件，或重启后使用固定系统安装位置。只有在发布渠道提供经过验证的 LibreOffice 构建时，工具箱才应开放对应的托管安装；当前不会为凑齐功能而下载来源或校验信息不可靠的包。`.docx` 编辑不依赖 LibreOffice。

## 安全与兼容性边界

- 每次转换使用独立 LibreOffice profile、独立临时目录、最高宏安全级别和禁止自动更新文档链接的配置；网络代理被指向不可用的本地端点；
- LibreOffice 以参数数组启动，不经过 shell；输出有上限，转换有超时，退出或超限时清理整个进程树；
- 转换结果必须留在隔离目录，且输出 `.doc` 必须具有 OLE Compound Document 签名；
- 临时目录在成功、失败或取消后都会删除；关闭应用会终止仍在运行的转换进程；
- 生成的 DOCX 仍会剥离外部图片关系，拒绝宏、签名、嵌入对象、保护和其他阻断结构。

进程级配置不能等同于操作系统级网络/文件沙箱。恶意文档仍可能利用尚未修复的 LibreOffice 漏洞，因此应及时更新 LibreOffice；后续 Rust sidecar/平台沙箱可进一步缩小转换器权限。

旧 DOC 往返属于有损转换。宏、数字签名、修订历史、实时域、复杂绘图、精确分页及部分旧 Word 布局不能保证保留，首次保存前必须确认兼容性警告。需要完整保真的文档应继续使用 Word 或 LibreOffice。

LibreOffice [官方许可证页](https://www.libreoffice.org/licenses/) 说明主产品适用 MPL 2.0，贡献通常采用 MPL 2.0 / LGPLv3+。它可以用于商用应用，但如果未来随安装包再分发，发布流程必须保留许可证文本、notices，并履行适用的源代码及修改披露义务。
