import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import type { CodexApprovalDecision, CodexRuntimeEvent, CodexSendInput, CodexThreadListInput, DocxSaveRequest, LiteratureItem, ManagedToolchainEvent, ProjectKind, ToolEvent, ToolRunRequest, WorkspaceChange } from '../shared/types';
import { CodexService } from './codex-service';
import { CodexRuntimeService } from './codex-runtime-service';
import { DocxService } from './docx-service';
import { AppError, publicError } from './errors';
import { LiteratureService } from './literature-service';
import { LegacyDocService, LibreOfficeConverter } from './legacy-doc-service';
import { LibreOfficeExecutableStore } from './libreoffice-executable-store';
import { ProjectService } from './project-service';
import { SnapshotService } from './snapshot-service';
import { ToolchainService } from './toolchain-service';

interface CreateProjectInput { name: string; parentPath: string; template: ProjectKind; initializeGit: boolean }
interface CodexSignInInput { method: 'chatgpt' | 'deviceCode' | 'apiKey' | 'openaiLike'; apiKey?: string; baseUrl?: string; model?: string }

function assertSafeWebUrl(raw: string, officialOnly = false): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError('INVALID_URL', 'URL is invalid'); }
  const localhost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) throw new AppError('UNSAFE_URL', 'Only HTTPS URLs are allowed');
  if (url.username || url.password) throw new AppError('UNSAFE_URL', 'URLs containing credentials are not allowed');
  if (officialOnly) {
    const host = url.hostname.toLowerCase();
    const allowed = host === 'openai.com' || host.endsWith('.openai.com') || host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
    if (!allowed) throw new AppError('UNSAFE_AUTH_URL', 'Codex authentication URL is not an approved OpenAI domain');
  }
  return url;
}

function safeHandler(window: BrowserWindow, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>) {
  return async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new AppError('UNTRUSTED_SENDER', 'IPC request did not come from the application window');
    try { return await handler(event, ...args); }
    catch (error) {
      const safe = publicError(error);
      throw new Error(`[${(safe as AppError).code ?? 'INTERNAL_ERROR'}] ${safe.message}`);
    }
  };
}

export interface MainServices {
  projects: ProjectService;
  snapshots: SnapshotService;
  literature: LiteratureService;
  toolchains: ToolchainService;
  codex: CodexService;
  codexRuntime: CodexRuntimeService;
  docx: DocxService;
  legacyDoc: LegacyDocService;
  dispose(): Promise<void>;
}

export function registerIpc(window: BrowserWindow, userDataPath: string): MainServices {
  let operationQueue: Promise<void> = Promise.resolve();
  const selectedDirectories = new Map<string, number>();
  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };
  const projects = new ProjectService(userDataPath, (event: WorkspaceChange) => send(IPC.project.changed, event));
  const openWeb = async (raw: string): Promise<void> => { await shell.openExternal(assertSafeWebUrl(raw).toString(), { activate: true }); };
  const toolchains = new ToolchainService(projects, (event: ToolEvent) => send(IPC.toolchains.event, event), openWeb, async (preview) => {
    const result = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Review tool execution', message: `Allow Research IDE to run ${path.basename(preview.executable)}?`,
      detail: `Executable: ${preview.executable}\nWorking directory: ${preview.cwd}\nArguments:\n${preview.args.map((arg) => JSON.stringify(arg)).join(' ').slice(0, 12_000)}`,
      buttons: ['Cancel', 'Run once'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  }, userDataPath, (event: ManagedToolchainEvent) => send(IPC.toolchains.managedEvent, event));
  const snapshots = new SnapshotService(projects);
  const docx = new DocxService(projects, snapshots);
  const libreOfficeExecutables = new LibreOfficeExecutableStore(userDataPath, () => projects.current?.path);
  // Eagerly audit a persisted choice at startup. Conversion still performs the
  // same full path/fingerprint validation immediately before every invocation.
  void libreOfficeExecutables.initialize().catch(() => undefined);
  const libreOfficeConverter = new LibreOfficeConverter(userDataPath, { resolveExecutable: () => libreOfficeExecutables.resolveExecutable() });
  const libreOfficeStatus = async () => {
    const configured = await libreOfficeExecutables.status();
    if (configured.state !== 'notConfigured') return configured;
    const detected = await libreOfficeConverter.availableExecutable();
    return detected
      ? { state: 'ready' as const, source: 'systemOrManaged' as const, path: detected, detail: '已自动发现系统或 Research IDE 托管的 LibreOffice。' }
      : { state: 'notConfigured' as const, detail: '本机未找到 LibreOffice；打开旧版 DOC 前需要先安装或手动选择可执行文件。' };
  };
  const legacyDoc = new LegacyDocService(
    projects,
    snapshots,
    userDataPath,
    libreOfficeConverter,
  );
  const literature = new LiteratureService(projects, async () => { await shell.openExternal('zotero://select/library'); });
  const codexRuntime = new CodexRuntimeService(
    userDataPath,
    (event: CodexRuntimeEvent) => send(IPC.codexRuntime.event, event),
    { currentProjectRoot: () => projects.current?.path },
  );
  const codex = new CodexService(
    projects,
    userDataPath,
    (event) => send(IPC.codex.event, event),
    async (url) => { await shell.openExternal(assertSafeWebUrl(url, true).toString(), { activate: true }); },
    {
      resolveCommand: async (projectRoot) => {
        const runtime = await codexRuntime.resolveCommand(projectRoot);
        return { executable: runtime.path, prefixArgs: runtime.prefixArgs, environment: runtime.environment };
      },
      prepareToolchainBridge: () => toolchains.prepareCodexBridge(),
      clientVersion: app.getVersion(),
    },
  );
  const enqueueMutation = <T>(callback: () => T | Promise<T>): Promise<T> => {
    const operation = operationQueue.then(callback, callback);
    operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const handle = <T extends unknown[]>(channel: string, callback: (event: IpcMainInvokeEvent, ...args: T) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, safeHandler(window, (event, ...args) => {
      const typedArgs = args as T;
      return enqueueMutation(() => callback(event, ...typedArgs));
    }));
  };
  const handleConcurrent = <T extends unknown[]>(channel: string, callback: (event: IpcMainInvokeEvent, ...args: T) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, safeHandler(window, (event, ...args) => callback(event, ...(args as T))));
  };
  const prepareProjectTransition = async (): Promise<void> => {
    legacyDoc.clearSession();
    toolchains.endProjectSession();
    await codex.stop();
    await toolchains.stopAll();
  };
  const startProjectToolchains = <T extends { id: string; path: string }>(summary: T): T => {
    toolchains.beginProjectSession();
    // Detection intentionally continues in the background. The toolchain panel
    // calls ensureDetected(), which joins this exact promise instead of scanning
    // a second time during the same project session.
    void toolchains.ensureDetected().catch(() => undefined);
    return summary;
  };

  handle(IPC.app.selectDirectory, async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = await realpath(result.filePaths[0]);
    selectedDirectories.set(selected, Date.now() + 10 * 60_000);
    return selected;
  });
  handle(IPC.app.openExternal, async (_event, url: string) => { await openWeb(url); });
  handle(IPC.app.revealPath, async (_event, requestedPath: string) => {
    const target = path.isAbsolute(requestedPath)
      ? await projects.guard.existing(projects.guard.relative(path.resolve(requestedPath)))
      : await projects.guard.existing(requestedPath);
    shell.showItemInFolder(target);
  });

  handle(IPC.project.listRecent, () => projects.listRecent());
  handle(IPC.project.openDialog, async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return startProjectToolchains(await projects.open(result.filePaths[0], prepareProjectTransition));
  });
  handle(IPC.project.open, async (_event, projectPath: string) => {
    if (typeof projectPath !== 'string' || projectPath.length > 8_192) throw new AppError('INVALID_PATH', 'Project path is invalid');
    const candidate = await realpath(projectPath);
    const recent = await projects.listRecent();
    let authorized = false;
    for (const item of recent) {
      try { if (await realpath(item.path) === candidate) { authorized = true; break; } } catch { /* stale recent */ }
    }
    if (!authorized) throw new AppError('PROJECT_NOT_AUTHORIZED', 'Choose this project with the system directory picker first');
    return startProjectToolchains(await projects.open(candidate, prepareProjectTransition));
  });
  handle(IPC.project.create, async (_event, input: CreateProjectInput) => {
    if (!input || typeof input !== 'object' || typeof input.parentPath !== 'string' || typeof input.name !== 'string' || typeof input.initializeGit !== 'boolean' || !['blank', 'latex', 'paper'].includes(input.template)) throw new AppError('INVALID_PROJECT', 'Project creation details are invalid');
    const parent = await realpath(input.parentPath);
    const expiresAt = selectedDirectories.get(parent);
    selectedDirectories.delete(parent);
    if (!expiresAt || expiresAt < Date.now()) throw new AppError('PROJECT_NOT_AUTHORIZED', 'Choose the parent directory with the system picker again');
    return startProjectToolchains(await projects.create({ ...input, parentPath: parent }, prepareProjectTransition));
  });
  handle(IPC.project.close, async () => { await prepareProjectTransition(); await projects.close(); });
  handle(IPC.project.tree, () => projects.tree());

  handle(IPC.files.readText, (_event, filePath: string) => projects.readText(filePath));
  handle(IPC.files.writeText, (_event, filePath: string, content: string) => projects.writeText(filePath, content));
  handle(IPC.files.readBinary, (_event, filePath: string) => projects.readBinary(filePath));
  handle(IPC.files.create, (_event, filePath: string, type: 'file' | 'directory') => projects.createEntry(filePath, type));
  handle(IPC.files.rename, (_event, filePath: string, nextName: string) => projects.renameEntry(filePath, nextName));
  handle(IPC.files.delete, (_event, filePath: string) => projects.deleteEntry(filePath));
  handle(IPC.files.search, (_event, query: string) => projects.search(query));
  handle(IPC.documents.read, (_event, filePath: string) => projects.readDocument(filePath));
  handle(IPC.documents.write, (_event, filePath: string, content: Record<string, unknown> | string) => projects.writeDocument(filePath, content));
  handle(IPC.documents.readDocx, (_event, filePath: string) => docx.open(filePath));
  handle(IPC.documents.writeDocx, (_event, request: DocxSaveRequest) => docx.save(request));
  handle(IPC.documents.readDoc, (_event, filePath: string) => legacyDoc.open(filePath));
  handle(IPC.documents.writeDoc, (_event, request: DocxSaveRequest) => legacyDoc.save(request));
  handleConcurrent(IPC.documents.libreOfficeStatus, libreOfficeStatus);
  handle(IPC.documents.selectLibreOffice, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择 LibreOffice 可执行文件',
      buttonLabel: '检查可执行文件',
      properties: process.platform === 'darwin' ? ['openFile', 'treatPackageAsDirectory'] : ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'LibreOffice executable', extensions: ['exe', 'com'] }]
        : [{ name: 'LibreOffice executable', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return libreOfficeStatus();
    const prepared = await libreOfficeExecutables.prepareSelection(result.filePaths[0]);
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning',
      title: '信任此 LibreOffice 可执行文件？',
      message: 'Research IDE 将允许此程序转换旧版 Word 文档。',
      detail: `规范路径：${prepared.path}\nSHA-256：${prepared.sha256}\n\n文件更新或被替换后会自动停用，届时需要重新选择。`,
      buttons: ['取消', '信任并使用'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return confirmation.response === 1
      ? libreOfficeExecutables.confirmSelection(prepared)
      : libreOfficeStatus();
  });
  handle(IPC.documents.clearLibreOffice, async () => { await libreOfficeExecutables.clear(); return libreOfficeStatus(); });

  handle(IPC.literature.status, () => literature.status());
  handle(IPC.literature.list, () => literature.list());
  handle(IPC.literature.search, (_event, query: string) => literature.search(query));
  handle(IPC.literature.create, (_event, input: Omit<LiteratureItem, 'id'>) => literature.create(input));
  handle(IPC.literature.update, (_event, id: string, patch: Partial<LiteratureItem>) => literature.update(id, patch));
  handle(IPC.literature.delete, (_event, id: string) => literature.delete(id));
  handle(IPC.literature.importFile, async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Research references', extensions: ['pdf', 'bib', 'ris', 'enw', 'txt'] }] });
    return result.canceled || !result.filePaths[0] ? null : literature.importAttachment(result.filePaths[0]);
  });
  handle(IPC.literature.openAttachment, (_event, id: string) => literature.openAttachment(id));
  handle(IPC.literature.connectZotero, () => literature.connectZotero());
  handle(IPC.literature.launchZotero, () => literature.launchZotero());

  handle(IPC.toolchains.list, () => toolchains.list());
  // Probes can take several seconds. Session tokens inside ToolchainService
  // reject stale results after a project switch, so these read/detect calls can
  // run outside the mutation queue without blocking file saves and snapshots.
  handleConcurrent(IPC.toolchains.ensureDetected, () => toolchains.ensureDetected());
  handleConcurrent(IPC.toolchains.detect, () => toolchains.detect());
  handle(IPC.toolchains.selectSystem, (_event, toolId: string) => toolchains.selectSystem(toolId));
  handle(IPC.toolchains.selectExecutable, async (_event, toolId: string) => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) {
      const existing = (await toolchains.list()).find((item) => item.id === toolId);
      if (!existing) throw new AppError('UNKNOWN_TOOL', 'Unknown toolchain');
      return existing;
    }
    return toolchains.selectExecutable(toolId, result.filePaths[0]);
  });
  handle(IPC.toolchains.install, (_event, toolId: string) => toolchains.install(toolId));
  handleConcurrent(IPC.toolchains.managedCatalog, (_event, toolId: string) => toolchains.managedCatalog(toolId));
  handleConcurrent(IPC.toolchains.installManaged, async (_event, toolId: string, version: string) => {
    const validated = toolchains.validateManagedRequest(toolId, version);
    const result = await dialog.showMessageBox(window, {
      type: 'info', title: '安装本地工具版本',
      message: `在 Research IDE 工作目录中安装 ${validated.toolId} ${validated.version}？`,
      detail: '软件包来自 conda-forge，由内置的已校验 Pixi 管理器下载。安装不会修改系统 PATH。第三方包适用各自许可证。',
      buttons: ['取消', '安装并设为项目版本'], defaultId: 1, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) throw new AppError('INSTALL_CANCELLED', 'Managed toolchain installation was cancelled');
    const prepared = await toolchains.prepareManagedInstallation(validated.toolId, validated.version);
    return enqueueMutation(() => toolchains.selectPreparedManaged(prepared));
  });
  handleConcurrent(IPC.toolchains.selectManaged, async (_event, toolId: string, version: string) => {
    const validated = toolchains.validateManagedRequest(toolId, version);
    const prepared = await toolchains.prepareInstalledManagedSelection(validated.toolId, validated.version);
    return enqueueMutation(() => toolchains.selectPreparedManaged(prepared));
  });
  handleConcurrent(IPC.toolchains.removeManaged, async (_event, toolId: string, version: string) => {
    const validated = toolchains.validateManagedRequest(toolId, version);
    const result = await dialog.showMessageBox(window, {
      type: 'warning', title: '移除本地工具版本', message: `移除 ${validated.toolId} ${validated.version}？`,
      detail: '此操作只删除 Research IDE 工作目录中的该版本，不会修改系统工具。',
      buttons: ['取消', '移除'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return;
    await enqueueMutation(() => toolchains.removeManaged(validated.toolId, validated.version));
  });
  handle(IPC.toolchains.selectForProject, async (_event, toolId: string) => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return;
    await toolchains.selectForProject(toolId, result.filePaths[0]);
  });
  handle(IPC.toolchains.run, (_event, request: ToolRunRequest) => toolchains.run(request));
  handle(IPC.toolchains.stop, (_event, runId: string) => toolchains.stop(runId));
  handle(IPC.latex.detect, async () => (await toolchains.ensureDetected()).find((item) => item.id === 'latex'));
  handle(IPC.latex.compile, (_event, filePath: string) => toolchains.compileLatex(filePath));
  handle(IPC.latex.readOutput, (_event, outputId: string) => toolchains.readLatexOutput(outputId));

  handle(IPC.snapshots.list, () => snapshots.list());
  handle(IPC.snapshots.create, (_event, paths: string[], label?: string) => snapshots.create(paths, label));
  handle(IPC.snapshots.restore, (_event, id: string) => snapshots.restore(id));
  handle(IPC.snapshots.delete, (_event, id: string) => snapshots.delete(id));

  handleConcurrent(IPC.codex.status, () => codex.getStatus());
  handle(IPC.codex.start, () => codex.start());
  handle(IPC.codex.signIn, (_event, input: CodexSignInInput) => codex.signIn(input));
  handle(IPC.codex.signOut, () => codex.signOut());
  handle(IPC.codex.send, (_event, input: CodexSendInput) => codex.send(input));
  handle(IPC.codex.decideApproval, (_event, input: { approvalId: string; decision: CodexApprovalDecision }) => codex.decideApproval(input));
  handle(IPC.codex.cancelTurn, (_event, threadId?: string) => codex.cancelTurn(threadId));
  handle(IPC.codex.newThread, (_event, input?: { model?: string; effort?: string }) => codex.newThread(input));
  handleConcurrent(IPC.codex.listThreads, (_event, input?: CodexThreadListInput) => codex.listThreads(input));
  handleConcurrent(IPC.codex.readThread, (_event, threadId: string) => codex.readThread(threadId));
  handle(IPC.codex.resumeThread, (_event, threadId: string) => codex.resumeThread(threadId));
  handle(IPC.codex.archiveThread, (_event, threadId: string) => codex.archiveThread(threadId));
  handle(IPC.codex.unarchiveThread, (_event, threadId: string) => codex.unarchiveThread(threadId));
  handle(IPC.codex.deleteThread, (_event, threadId: string) => codex.deleteThread(threadId));
  handleConcurrent(IPC.codex.listModels, () => codex.listModels());
  handle(IPC.codex.updateSettings, (_event, input: { threadId?: string; model?: string; effort?: string }) => codex.updateSettings(input));
  handleConcurrent(IPC.codexRuntime.status, () => codexRuntime.status());
  handleConcurrent(IPC.codexRuntime.catalog, async () => {
    const catalog = await codexRuntime.catalog(true);
    return { ...catalog, releases: catalog.releases.slice(0, 1) };
  });
  handle(IPC.codexRuntime.selectExecutable, async () => {
    const current = await codexRuntime.status();
    if (current.state === 'ready') throw new AppError('CODEX_RUNTIME_ALREADY_CONFIGURED', 'Codex CLI is already available; use Check for updates instead of switching runtimes');
    const result = await dialog.showOpenDialog(window, {
      title: '选择 Codex CLI 可执行文件',
      buttonLabel: '检查可执行文件',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Codex CLI executable', extensions: ['exe'] }] : [{ name: 'Codex CLI executable', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return codexRuntime.status();
    const prepared = await codexRuntime.prepareSelection(result.filePaths[0]);
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning', title: '信任此 Codex CLI？', message: `允许 Research IDE 使用 Codex ${prepared.version}？`,
      detail: `规范路径：${prepared.path}\nSHA-256：${prepared.sha256}\n\n应用会在每次解析时重新验证此文件；文件改变后会停止使用。CODEX_HOME 不会被移动或覆盖。`,
      buttons: ['取消', '信任并使用'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (confirmation.response !== 1) return codexRuntime.status();
    const status = await codexRuntime.confirmSelection(prepared);
    await codex.stop();
    return status;
  });
  handleConcurrent(IPC.codexRuntime.install, async (_event, version: string) => {
    if (typeof version !== 'string') throw new AppError('CODEX_RUNTIME_INVALID_VERSION', 'Codex runtime version is invalid');
    const catalog = await codexRuntime.catalog(true);
    const release = catalog.releases[0];
    if (!release || release.version !== version) throw new AppError('CODEX_RUNTIME_LATEST_ONLY', 'Codex CLI can only install the latest verified stable release');
    const confirmation = await dialog.showMessageBox(window, {
      type: 'info', title: '安装 Codex CLI', message: `安装官方 Codex ${release.version}？`,
      detail: `来源：GitHub openai/codex\n文件：${release.assetName}\n大小：${Math.ceil(release.size / 1024 / 1024)} MB\nSHA-256：${release.sha256}\n\n安装位于 Research IDE 应用数据目录，不会覆盖系统 Codex 或 CODEX_HOME。`,
      buttons: ['取消', '下载、验证并安装'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (confirmation.response !== 1) throw new AppError('CODEX_RUNTIME_INSTALL_CANCELLED', 'Codex runtime installation was cancelled');
    const status = await codexRuntime.install(version);
    await codex.stop();
    return status;
  });
  handleConcurrent(IPC.codexRuntime.update, async () => {
    const status = await codexRuntime.status();
    if (status.active?.source !== 'managed') throw new AppError('CODEX_RUNTIME_NOT_MANAGED', 'Install a managed Codex runtime before using managed update');
    const catalog = await codexRuntime.catalog(true);
    const latest = catalog.releases[0];
    if (!latest || !status.active || latest.version === status.active.version) return status;
    const confirmation = await dialog.showMessageBox(window, {
      type: 'info', title: '更新 Codex CLI', message: `将托管 Codex 更新到 ${latest.version}？`,
      detail: '新版本会安装到独立版本目录并完整验证，成功后才原子切换；系统 Codex 和 CODEX_HOME 不会改变。',
      buttons: ['取消', '更新'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (confirmation.response !== 1) return status;
    const updated = await codexRuntime.update();
    await codex.stop();
    return updated;
  });
  handle(IPC.codexRuntime.clearSelection, async () => {
    const status = await codexRuntime.clearSelection();
    await codex.stop();
    return status;
  });
  handle(IPC.diagnostics.list, () => []);

  return {
    projects, snapshots, literature, toolchains, codex, codexRuntime, docx, legacyDoc,
    async dispose() { await codexRuntime.dispose(); legacyDoc.dispose(); await operationQueue.catch(() => undefined); toolchains.endProjectSession(); await codex.stop(); await toolchains.stopAll(); await projects.close(); },
  };
}
