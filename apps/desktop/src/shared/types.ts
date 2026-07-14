export type ProjectKind = 'blank' | 'latex' | 'paper';

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  lastOpenedAt?: string;
  kind?: ProjectKind;
}

export interface FileNode {
  id?: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

export interface SearchResult {
  path: string;
  line: number;
  column?: number;
  preview: string;
}

export interface WorkspaceChange {
  type: 'created' | 'changed' | 'deleted' | 'renamed';
  path: string;
  oldPath?: string;
}

export interface ToolchainInfo {
  id: string;
  name: string;
  kind: 'latex' | 'python' | 'r' | 'pandoc' | 'compiler' | 'other';
  status: 'ready' | 'missing' | 'checking' | 'error';
  version?: string;
  path?: string;
  selected?: boolean;
  managed?: boolean;
  detail?: string;
  systemPath?: string;
  systemVersion?: string;
}

export interface ManagedToolchainVersion {
  version: string;
  installed: boolean;
  selected: boolean;
  executablePath?: string;
  installedAt?: string;
}

export interface ManagedToolchainCatalog {
  toolId: string;
  packageName: string;
  source: 'conda-forge';
  sourceUrl: string;
  platform: string;
  versions: ManagedToolchainVersion[];
  warning?: string;
}

export interface ManagedToolchainEvent {
  operationId: string;
  toolId: string;
  version: string;
  phase: 'preparing' | 'downloading-manager' | 'resolving' | 'installing' | 'validating' | 'completed' | 'failed';
  message: string;
  progress?: number;
}

export interface ToolRunRequest {
  toolId: string;
  args: string[];
  cwd?: string;
}

export interface ToolRunResult {
  runId: string;
  startedAt: string;
}

export interface ToolEvent {
  runId: string;
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  text?: string;
  exitCode?: number;
  timestamp?: string;
}

export interface LiteratureItem {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  citekey?: string;
  itemType?: 'article' | 'book' | 'thesis' | 'web' | 'other';
  tags?: string[];
  attachmentPath?: string;
  source?: 'local' | 'zotero';
}

export interface LiteratureStatus {
  zoteroAvailable: boolean;
  connected: boolean;
  detail?: string;
}

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CodexAccountStatus {
  state: 'signedOut' | 'connecting' | 'signedIn' | 'error';
  method?: 'chatgpt' | 'deviceCode' | 'apiKey' | 'openaiLike';
  label?: string;
  detail?: string;
  deviceCode?: string;
  verificationUrl?: string;
}

export interface CodexStatus {
  server: 'stopped' | 'starting' | 'ready' | 'error';
  account: CodexAccountStatus;
  threadId?: string;
  model?: string;
  effort?: string;
  capabilities?: CodexCapabilities;
  detail?: string;
}

export type CodexCapabilityState = 'checking' | 'available' | 'unavailable';

export interface CodexCapabilities {
  conversations: CodexCapabilityState;
  modelSelection: CodexCapabilityState;
  autoReview: 'checking' | 'available' | 'manualFallback';
  serverVersion?: string;
  detail?: string;
}

export interface CodexThreadSummary {
  id: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  modelProvider?: string;
  archived?: boolean;
}

export interface CodexThreadListInput {
  archived?: boolean;
}

export type CodexHistoryTruncationReason = 'turnLimit' | 'sizeLimit' | 'paginationGuard';

export interface CodexThreadHistory {
  /** True when older turns remain outside the local, bounded history window. */
  truncated: boolean;
  /** Number of app-server turns loaded into the returned history window. */
  loadedTurns: number;
  /** Hard local turn cap used while paging app-server history. */
  maxTurns: number;
  truncationReason?: CodexHistoryTruncationReason;
}

export interface CodexThreadView {
  thread: CodexThreadSummary;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;
  history: CodexThreadHistory;
  model?: string;
  effort?: string;
}

export const CODEX_THREAD_HISTORY_LIMITS = Object.freeze({
  pageTurns: 50,
  maxTurns: 500,
  maxBytes: 16 * 1024 * 1024,
  maxPages: 20,
});

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: Array<{ value: string; description?: string }>;
}

export type CodexContextBufferFormat = 'text' | 'prosemirror';

/**
 * A renderer editor buffer that has not been saved to disk yet.  The main
 * process treats this as untrusted project content and validates it again
 * before forwarding it to Codex.
 */
export interface CodexContextBuffer {
  path: string;
  format: CodexContextBufferFormat;
  content: string;
}

export interface CodexSendInput {
  threadId?: string;
  prompt: string;
  projectPath: string;
  /** The complete user-selected context set. */
  contextFiles: string[];
  /** Unsaved buffers; every path must also occur in contextFiles. */
  contextBuffers: CodexContextBuffer[];
  mode: 'ask' | 'agent';
}

export const CODEX_CONTEXT_LIMITS = Object.freeze({
  maxFiles: 50,
  maxBuffers: 20,
  maxBufferBytes: 512 * 1024,
  maxTotalBufferBytes: 2 * 1024 * 1024,
});

export interface CodexApprovalRequest {
  id: string;
  threadId?: string;
  kind: 'command' | 'fileWrite' | 'network' | 'tool';
  title: string;
  command?: string;
  paths?: string[];
  cwd?: string;
  reason?: string;
  networkDestination?: string;
  detail?: string;
  createdAt: string;
  availableDecisions: CodexApprovalDecision[];
}

export type CodexEvent =
  | { type: 'status'; status: CodexStatus }
  | { type: 'message.started'; message: { id: string; role: 'assistant'; content: string; createdAt: string; pending: boolean } }
  | { type: 'message.delta'; messageId: string; delta: string }
  | { type: 'message.completed'; messageId: string; content?: string }
  | { type: 'approval.requested'; approval: CodexApprovalRequest }
  | { type: 'approval.resolved'; approvalId: string; decision: CodexApprovalDecision }
  | { type: 'approval.autoReview.started'; reviewId: string; threadId?: string }
  | { type: 'approval.autoReview.completed'; reviewId: string; threadId?: string; status: string; riskLevel?: string; rationale?: string }
  | { type: 'tool.started'; label: string; detail?: string }
  | { type: 'tool.completed'; label: string; detail?: string; success: boolean }
  | { type: 'error'; message: string };

export interface ProblemItem {
  id: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  line?: number;
  source?: string;
}

export interface SnapshotInfo {
  id: string;
  label?: string;
  createdAt: string;
  paths: string[];
  fileCount: number;
  totalBytes: number;
}

export interface DocxCompatibilityWarning {
  code: string;
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'blocking';
  requiresAcknowledgement: boolean;
}

export interface DocxOpenResult {
  content: string;
  sourceHash: string;
  warnings: DocxCompatibilityWarning[];
  readOnly: boolean;
}

export interface DocxSaveRequest {
  path: string;
  content: Record<string, unknown>;
  expectedSourceHash: string;
  acknowledgeCompatibilityWarnings: boolean;
}

export interface DocxSaveResult {
  sourceHash: string;
  backupId: string;
}

/** Status of the optional, explicitly trusted LibreOffice executable. */
export interface LibreOfficeExecutableStatus {
  state: 'notConfigured' | 'ready' | 'invalid';
  source?: 'custom' | 'systemOrManaged';
  path?: string;
  sha256?: string;
  detail?: string;
}
