import type {
  BackupSnapshot,
  CodexAccountStatus,
  CodexApprovalDecision,
  CodexEvent,
  CodexRuntimeCatalog,
  CodexRuntimeEvent,
  CodexRuntimeStatus,
  CodexModelOption,
  CodexSendInput,
  CodexStatus,
  CodexThreadSummary,
  CodexThreadListInput,
  CodexThreadView,
  DocxOpenResult,
  DocxSaveRequest,
  DocxSaveResult,
  FileNode,
  LiteratureItem,
  LiteratureStatus,
  LibreOfficeExecutableStatus,
  ManagedToolchainCatalog,
  ManagedToolchainEvent,
  ProblemItem,
  ProjectSummary,
  SearchResult,
  ToolEvent,
  ToolRunRequest,
  ToolRunResult,
  ToolchainInfo,
  WorkspaceChange,
} from './types';

export {};

declare global {
  interface Window {
    researchIDE?: {
      app: {
        platform: NodeJS.Platform;
        version: string;
        selectDirectory(): Promise<string | null>;
        openExternal(url: string): Promise<void>;
        revealPath(path: string): Promise<void>;
      };
      project: {
        listRecent(): Promise<ProjectSummary[]>;
        openDialog(): Promise<ProjectSummary | null>;
        open(path: string): Promise<ProjectSummary>;
        create(input: {
          name: string;
          parentPath: string;
          template: 'blank' | 'latex' | 'paper';
          initializeGit: boolean;
        }): Promise<ProjectSummary>;
        close(): Promise<void>;
        getTree(): Promise<FileNode[]>;
        onWorkspaceChange(listener: (event: WorkspaceChange) => void): () => void;
      };
      files: {
        readText(path: string): Promise<string>;
        writeText(path: string, content: string): Promise<void>;
        readBinary(path: string): Promise<ArrayBuffer | Uint8Array>;
        create(path: string, type: 'file' | 'directory'): Promise<void>;
        rename(path: string, nextName: string): Promise<void>;
        delete(path: string): Promise<void>;
        search(query: string): Promise<SearchResult[]>;
      };
      documents: {
        read(path: string): Promise<Record<string, unknown> | string>;
        write(path: string, content: Record<string, unknown> | string): Promise<void>;
        readDocx(path: string): Promise<DocxOpenResult>;
        writeDocx(request: DocxSaveRequest): Promise<DocxSaveResult>;
        readDoc(path: string): Promise<DocxOpenResult>;
        writeDoc(request: DocxSaveRequest): Promise<DocxSaveResult>;
        libreOfficeStatus(): Promise<LibreOfficeExecutableStatus>;
        selectLibreOffice(): Promise<LibreOfficeExecutableStatus>;
        clearLibreOffice(): Promise<LibreOfficeExecutableStatus>;
      };
      literature: {
        getStatus(): Promise<LiteratureStatus>;
        list(): Promise<LiteratureItem[]>;
        search(query: string): Promise<LiteratureItem[]>;
        importFile(): Promise<LiteratureItem | null>;
        openAttachment(id: string): Promise<string | null>;
        connectZotero(): Promise<LiteratureStatus>;
        launchZotero(): Promise<void>;
      };
      toolchains: {
        list(): Promise<ToolchainInfo[]>;
        ensureDetected(): Promise<ToolchainInfo[]>;
        detect(): Promise<ToolchainInfo[]>;
        selectSystem(toolId: string): Promise<ToolchainInfo>;
        selectExecutable(toolId: string): Promise<ToolchainInfo>;
        install(toolId: string): Promise<void>;
        managedCatalog(toolId: string): Promise<ManagedToolchainCatalog>;
        installManaged(toolId: string, version: string): Promise<ToolchainInfo>;
        selectManaged(toolId: string, version: string): Promise<ToolchainInfo>;
        removeManaged(toolId: string, version: string): Promise<void>;
        selectForProject(toolId: string, executablePath: string): Promise<void>;
        run(request: ToolRunRequest): Promise<ToolRunResult>;
        stop(runId: string): Promise<void>;
        onEvent(listener: (event: ToolEvent) => void): () => void;
        onManagedEvent(listener: (event: ManagedToolchainEvent) => void): () => void;
      };
      latex: {
        detect(): Promise<ToolchainInfo>;
        compile(path: string): Promise<ToolRunResult & { outputId: string; outputPdf: string }>;
        readOutput?(outputId: string): Promise<ArrayBuffer | Uint8Array>;
      };
      codex: {
        getStatus(): Promise<CodexStatus>;
        start(): Promise<CodexStatus>;
        signIn(input: {
          method: 'chatgpt' | 'deviceCode' | 'apiKey' | 'openaiLike';
          apiKey?: string;
          baseUrl?: string;
          model?: string;
        }): Promise<CodexAccountStatus>;
        signOut(): Promise<void>;
        send(input: CodexSendInput): Promise<{ threadId: string; messageId: string }>;
        decideApproval(input: {
          approvalId: string;
          decision: CodexApprovalDecision;
        }): Promise<void>;
        cancelTurn(threadId?: string): Promise<void>;
        newThread(input?: { model?: string; effort?: string }): Promise<string>;
        listThreads(input?: CodexThreadListInput): Promise<CodexThreadSummary[]>;
        readThread(threadId: string): Promise<CodexThreadView>;
        resumeThread(threadId: string): Promise<CodexThreadView>;
        archiveThread(threadId: string): Promise<void>;
        unarchiveThread(threadId: string): Promise<void>;
        deleteThread(threadId: string): Promise<void>;
        listModels(): Promise<CodexModelOption[]>;
        updateSettings(input: { threadId?: string; model?: string; effort?: string }): Promise<CodexStatus>;
        onEvent(listener: (event: CodexEvent) => void): () => void;
      };
      codexRuntime: {
        status(): Promise<CodexRuntimeStatus>;
        catalog(): Promise<CodexRuntimeCatalog>;
        selectExecutable(): Promise<CodexRuntimeStatus>;
        install(version: string): Promise<CodexRuntimeStatus>;
        update(): Promise<CodexRuntimeStatus>;
        clearSelection(): Promise<CodexRuntimeStatus>;
        onEvent(listener: (event: CodexRuntimeEvent) => void): () => void;
      };
      diagnostics: {
        listProblems(): Promise<ProblemItem[]>;
      };
      snapshots: {
        list(): Promise<BackupSnapshot[]>;
        create(paths: string[], label?: string): Promise<BackupSnapshot>;
        restore(snapshotId: string): Promise<void>;
        delete(snapshotId: string): Promise<void>;
      };
    };
  }
}

declare module '*?url' {
  const url: string;
  export default url;
}
