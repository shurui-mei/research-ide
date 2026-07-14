export type ActivityView =
  | 'explorer'
  | 'literature'
  | 'toolchains'
  | 'codex';

export type BottomView = 'problems' | 'output' | 'logs';

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  lastOpenedAt?: string;
  kind?: 'blank' | 'latex' | 'paper';
}

export interface FileNode {
  id?: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  gitStatus?: 'added' | 'modified' | 'deleted' | 'untracked' | 'ignored';
}

export interface SearchResult {
  path: string;
  line: number;
  column?: number;
  preview: string;
}

export type EditorKind = 'text' | 'document' | 'pdf' | 'docx';

export interface EditorTab {
  id: string;
  path: string;
  name: string;
  kind: EditorKind;
  language?: string;
  content?: string;
  document?: Record<string, unknown> | string;
  binary?: Uint8Array;
  dirty: boolean;
  loading?: boolean;
  error?: string;
  cursor?: { line: number; column: number };
  reveal?: { line: number; column: number; nonce: string };
  virtual?: boolean;
  docxWarnings?: DocxCompatibilityWarning[];
  docxSourceHash?: string;
  docxReadOnly?: boolean;
  docxCompatibilityAcknowledged?: boolean;
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

export type CodexAuthMethod = 'chatgpt' | 'deviceCode' | 'apiKey' | 'openaiLike';

export interface CodexAccountStatus {
  state: 'signedOut' | 'connecting' | 'signedIn' | 'error';
  method?: CodexAuthMethod;
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
  truncated: boolean;
  loadedTurns: number;
  maxTurns: number;
  truncationReason?: CodexHistoryTruncationReason;
}

export interface CodexThreadView {
  thread: CodexThreadSummary;
  messages: CodexChatMessage[];
  history: CodexThreadHistory;
  model?: string;
  effort?: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: Array<{ value: string; description?: string }>;
}

export interface CodexChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  pending?: boolean;
  error?: boolean;
}

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
  availableDecisions?: CodexApprovalDecision[];
}

export type CodexApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export type CodexEvent =
  | { type: 'status'; status: CodexStatus }
  | { type: 'message.started'; message: CodexChatMessage }
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

export interface LogEntry {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp: string;
  source?: string;
}

export interface WorkspaceChange {
  type: 'created' | 'changed' | 'deleted' | 'renamed';
  path: string;
  oldPath?: string;
}

export interface BackupSnapshot {
  id: string;
  label?: string;
  createdAt: string;
  paths: string[];
  fileCount?: number;
  totalBytes?: number;
  note?: string;
}
