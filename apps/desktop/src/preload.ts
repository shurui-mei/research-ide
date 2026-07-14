import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './shared/ipc';
import type { CodexEvent, CodexSendInput, CodexStatus, CodexThreadListInput, DocxSaveRequest, DocxSaveResult, LibreOfficeExecutableStatus, ManagedToolchainEvent, ToolEvent, WorkspaceChange } from './shared/types';

function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  app: {
    platform: process.platform,
    version: process.env.npm_package_version ?? '0.1.0',
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.app.selectDirectory),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.app.openExternal, url),
    revealPath: (path: string): Promise<void> => ipcRenderer.invoke(IPC.app.revealPath, path),
  },
  project: {
    listRecent: () => ipcRenderer.invoke(IPC.project.listRecent),
    openDialog: () => ipcRenderer.invoke(IPC.project.openDialog),
    open: (path: string) => ipcRenderer.invoke(IPC.project.open, path),
    create: (input: { name: string; parentPath: string; template: 'blank' | 'latex' | 'paper'; initializeGit: boolean }) => ipcRenderer.invoke(IPC.project.create, input),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.project.close),
    getTree: () => ipcRenderer.invoke(IPC.project.tree),
    onWorkspaceChange: (listener: (event: WorkspaceChange) => void) => subscribe(IPC.project.changed, listener),
  },
  files: {
    readText: (path: string): Promise<string> => ipcRenderer.invoke(IPC.files.readText, path),
    writeText: (path: string, content: string): Promise<void> => ipcRenderer.invoke(IPC.files.writeText, path, content),
    readBinary: (path: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.files.readBinary, path),
    create: (path: string, type: 'file' | 'directory'): Promise<void> => ipcRenderer.invoke(IPC.files.create, path, type),
    rename: (path: string, nextName: string): Promise<void> => ipcRenderer.invoke(IPC.files.rename, path, nextName),
    delete: (path: string): Promise<void> => ipcRenderer.invoke(IPC.files.delete, path),
    search: (query: string) => ipcRenderer.invoke(IPC.files.search, query),
  },
  documents: {
    read: (path: string) => ipcRenderer.invoke(IPC.documents.read, path),
    write: (path: string, content: Record<string, unknown> | string): Promise<void> => ipcRenderer.invoke(IPC.documents.write, path, content),
    readDocx: (path: string) => ipcRenderer.invoke(IPC.documents.readDocx, path),
    writeDocx: (request: DocxSaveRequest): Promise<DocxSaveResult> => ipcRenderer.invoke(IPC.documents.writeDocx, request),
    readDoc: (path: string) => ipcRenderer.invoke(IPC.documents.readDoc, path),
    writeDoc: (request: DocxSaveRequest): Promise<DocxSaveResult> => ipcRenderer.invoke(IPC.documents.writeDoc, request),
    libreOfficeStatus: (): Promise<LibreOfficeExecutableStatus> => ipcRenderer.invoke(IPC.documents.libreOfficeStatus),
    selectLibreOffice: (): Promise<LibreOfficeExecutableStatus> => ipcRenderer.invoke(IPC.documents.selectLibreOffice),
    clearLibreOffice: (): Promise<LibreOfficeExecutableStatus> => ipcRenderer.invoke(IPC.documents.clearLibreOffice),
  },
  literature: {
    getStatus: () => ipcRenderer.invoke(IPC.literature.status),
    list: () => ipcRenderer.invoke(IPC.literature.list),
    search: (query: string) => ipcRenderer.invoke(IPC.literature.search, query),
    create: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.literature.create, input),
    update: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke(IPC.literature.update, id, patch),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.literature.delete, id),
    importFile: () => ipcRenderer.invoke(IPC.literature.importFile),
    openAttachment: (id: string) => ipcRenderer.invoke(IPC.literature.openAttachment, id),
    connectZotero: () => ipcRenderer.invoke(IPC.literature.connectZotero),
    launchZotero: (): Promise<void> => ipcRenderer.invoke(IPC.literature.launchZotero),
  },
  toolchains: {
    list: () => ipcRenderer.invoke(IPC.toolchains.list),
    ensureDetected: () => ipcRenderer.invoke(IPC.toolchains.ensureDetected),
    detect: () => ipcRenderer.invoke(IPC.toolchains.detect),
    selectSystem: (toolId: string) => ipcRenderer.invoke(IPC.toolchains.selectSystem, toolId),
    selectExecutable: (toolId: string) => ipcRenderer.invoke(IPC.toolchains.selectExecutable, toolId),
    install: (toolId: string): Promise<void> => ipcRenderer.invoke(IPC.toolchains.install, toolId),
    managedCatalog: (toolId: string) => ipcRenderer.invoke(IPC.toolchains.managedCatalog, toolId),
    installManaged: (toolId: string, version: string) => ipcRenderer.invoke(IPC.toolchains.installManaged, toolId, version),
    selectManaged: (toolId: string, version: string) => ipcRenderer.invoke(IPC.toolchains.selectManaged, toolId, version),
    removeManaged: (toolId: string, version: string): Promise<void> => ipcRenderer.invoke(IPC.toolchains.removeManaged, toolId, version),
    selectForProject: (toolId: string, executablePath: string): Promise<void> => ipcRenderer.invoke(IPC.toolchains.selectForProject, toolId, executablePath),
    run: (request: { toolId: string; args: string[]; cwd?: string }) => ipcRenderer.invoke(IPC.toolchains.run, request),
    stop: (runId: string): Promise<void> => ipcRenderer.invoke(IPC.toolchains.stop, runId),
    onEvent: (listener: (event: ToolEvent) => void) => subscribe(IPC.toolchains.event, listener),
    onManagedEvent: (listener: (event: ManagedToolchainEvent) => void) => subscribe(IPC.toolchains.managedEvent, listener),
  },
  latex: {
    detect: () => ipcRenderer.invoke(IPC.latex.detect),
    compile: (path: string) => ipcRenderer.invoke(IPC.latex.compile, path),
    readOutput: (outputId: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.latex.readOutput, outputId),
  },
  snapshots: {
    list: () => ipcRenderer.invoke(IPC.snapshots.list),
    create: (paths: string[], label?: string) => ipcRenderer.invoke(IPC.snapshots.create, paths, label),
    restore: (id: string): Promise<void> => ipcRenderer.invoke(IPC.snapshots.restore, id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.snapshots.delete, id),
  },
  codex: {
    getStatus: () => ipcRenderer.invoke(IPC.codex.status),
    start: () => ipcRenderer.invoke(IPC.codex.start),
    signIn: (input: { method: 'chatgpt' | 'deviceCode' | 'apiKey' | 'openaiLike'; apiKey?: string; baseUrl?: string; model?: string }) => ipcRenderer.invoke(IPC.codex.signIn, input),
    signOut: (): Promise<void> => ipcRenderer.invoke(IPC.codex.signOut),
    send: (input: CodexSendInput) => ipcRenderer.invoke(IPC.codex.send, input),
    decideApproval: (input: { approvalId: string; decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' }): Promise<void> => ipcRenderer.invoke(IPC.codex.decideApproval, input),
    cancelTurn: (threadId?: string): Promise<void> => ipcRenderer.invoke(IPC.codex.cancelTurn, threadId),
    newThread: (input?: { model?: string; effort?: string }): Promise<string> => ipcRenderer.invoke(IPC.codex.newThread, input),
    listThreads: (input?: CodexThreadListInput) => ipcRenderer.invoke(IPC.codex.listThreads, input),
    readThread: (threadId: string) => ipcRenderer.invoke(IPC.codex.readThread, threadId),
    resumeThread: (threadId: string) => ipcRenderer.invoke(IPC.codex.resumeThread, threadId),
    archiveThread: (threadId: string): Promise<void> => ipcRenderer.invoke(IPC.codex.archiveThread, threadId),
    unarchiveThread: (threadId: string): Promise<void> => ipcRenderer.invoke(IPC.codex.unarchiveThread, threadId),
    deleteThread: (threadId: string): Promise<void> => ipcRenderer.invoke(IPC.codex.deleteThread, threadId),
    listModels: () => ipcRenderer.invoke(IPC.codex.listModels),
    updateSettings: (input: { threadId?: string; model?: string; effort?: string }): Promise<CodexStatus> => ipcRenderer.invoke(IPC.codex.updateSettings, input),
    onEvent: (listener: (event: CodexEvent) => void) => subscribe(IPC.codex.event, listener),
  },
  diagnostics: { listProblems: () => ipcRenderer.invoke(IPC.diagnostics.list) },
};

contextBridge.exposeInMainWorld('researchIDE', Object.freeze(api));
