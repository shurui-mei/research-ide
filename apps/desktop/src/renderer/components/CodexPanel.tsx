import { useEffect, useMemo, useRef, useState } from 'react';
import { CODEX_CONTEXT_LIMITS } from '../../shared/types';
import { buildCodexContextBuffers } from '../lib/codex-context';
import { basename, relativePath } from '../lib/files';
import type {
  CodexAccountStatus,
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexChatMessage,
  CodexEvent,
  CodexModelOption,
  CodexStatus,
  CodexThreadSummary,
  CodexThreadView,
  EditorTab,
  ProjectSummary,
} from '../types';
import { Badge, EmptyState, Field, IconButton, Modal, Spinner } from './Common';
import { Icon } from './Icon';
import { semanticIcons } from './semantic-icons';

interface TimelineItem {
  id: string;
  label: string;
  detail?: string;
  state: 'running' | 'success' | 'error';
}

const initialStatus: CodexStatus = {
  server: 'stopped',
  account: { state: 'signedOut' },
};

function statusLabel(status: CodexStatus) {
  if (status.server === 'starting') return '正在启动';
  if (status.server === 'error') return '服务异常';
  if (status.server !== 'ready') return '服务未启动';
  if (status.account.state === 'signedIn') return '已就绪';
  if (status.account.state === 'connecting') return '正在登录';
  return '需要登录';
}

function approvalIcon(kind: CodexApprovalRequest['kind']): 'terminal' | 'edit' | 'globe' | 'tools' {
  if (kind === 'command') return 'terminal';
  if (kind === 'fileWrite') return 'edit';
  if (kind === 'network') return 'globe';
  return 'tools';
}

function AuthDialog({
  status,
  onClose,
  onSignIn,
}: {
  status: CodexAccountStatus;
  onClose(): void;
  onSignIn(input: { method: 'chatgpt' | 'deviceCode' | 'apiKey' | 'openaiLike'; apiKey?: string; baseUrl?: string; model?: string }): Promise<CodexAccountStatus>;
}) {
  const [screen, setScreen] = useState<'choose' | 'apiKey' | 'openaiLike' | 'device'>('choose');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [deviceStatus, setDeviceStatus] = useState<CodexAccountStatus | null>(null);

  useEffect(() => {
    if (screen === 'device' && status.state === 'signedIn') {
      setApiKey('');
      onClose();
    }
  }, [onClose, screen, status.state]);

  function clearSecret() {
    setApiKey('');
  }

  function close() {
    clearSecret();
    onClose();
  }

  async function signIn(method: 'chatgpt' | 'deviceCode' | 'apiKey' | 'openaiLike') {
    setBusy(method);
    setError('');
    try {
      const next = await onSignIn({
        method,
        apiKey: method === 'apiKey' || method === 'openaiLike' ? apiKey : undefined,
        baseUrl: method === 'openaiLike' ? baseUrl.trim() : undefined,
        model: method === 'openaiLike' ? model.trim() : undefined,
      });
      clearSecret();
      if (method === 'deviceCode' && next.deviceCode) {
        setDeviceStatus(next);
        setScreen('device');
      } else if (next.state === 'signedIn' || method === 'chatgpt') {
        onClose();
      }
    } catch (nextError) {
      clearSecret();
      setError(nextError instanceof Error ? nextError.message : '登录失败');
    } finally {
      setBusy('');
    }
  }

  return (
    <Modal onClose={close} subtitle="选择账户或配置兼容接口。" title="连接 Codex" width="600px">
      {screen === 'choose' && (
        <div className="auth-methods">
          <button className="auth-method featured" disabled={!!busy} onClick={() => signIn('chatgpt')} type="button">
            <span className="auth-icon"><Icon name="chat" /></span>
            <span><strong>使用 ChatGPT 登录</strong><small>浏览器授权；登录令牌只允许写入系统凭据库</small></span>
            {busy === 'chatgpt' ? <Spinner /> : <Icon name="external" size={16} />}
          </button>
          <button className="auth-method" disabled={!!busy} onClick={() => signIn('deviceCode')} type="button">
            <span className="auth-icon"><Icon name="device" /></span>
            <span><strong>使用设备码</strong><small>适合远程环境或无法回调浏览器的设备</small></span>
            {busy === 'deviceCode' ? <Spinner /> : <Icon name="chevronRight" size={16} />}
          </button>
          <button className="auth-method" onClick={() => setScreen('apiKey')} type="button">
            <span className="auth-icon"><Icon name="key" /></span>
            <span><strong>OpenAI API Key</strong><small>使用 OpenAI API 凭据连接</small></span>
            <Icon name="chevronRight" size={16} />
          </button>
          <button className="auth-method" onClick={() => setScreen('openaiLike')} type="button">
            <span className="auth-icon"><Icon name="globe" /></span>
            <span><strong>OpenAI-like 服务</strong><small>配置 Responses API 兼容端点、模型与临时凭据</small></span>
            <Icon name="chevronRight" size={16} />
          </button>
          {status.detail && <div className="auth-current-detail"><Icon name="info" size={14} />{status.detail}</div>}
        </div>
      )}

      {(screen === 'apiKey' || screen === 'openaiLike') && (
        <form className="credential-form" onSubmit={(event) => { event.preventDefault(); void signIn(screen); }}>
          <button className="back-button" onClick={() => { clearSecret(); setScreen('choose'); }} type="button"><Icon name="previous" size={14} />返回登录方式</button>
          {screen === 'openaiLike' && <>
            <Field hint="必须为 HTTPS；本地回环地址除外。" label="Base URL">
              <input autoFocus className="text-input" onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required type="url" value={baseUrl} />
            </Field>
            <Field label="模型">
              <input className="text-input" onChange={(event) => setModel(event.target.value)} placeholder="模型标识" required value={model} />
            </Field>
          </>}
          <Field label={screen === 'apiKey' ? 'OpenAI API Key' : 'API Key（如需要）'}>
            <input autoComplete="off" autoFocus={screen === 'apiKey'} className="text-input secret-input" onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" required={screen === 'apiKey'} type="password" value={apiKey} />
          </Field>
          {error && <div className="form-error"><Icon name="error" size={15} />{error}</div>}
          <footer className="modal-actions"><button className="button ghost" onClick={close} type="button">取消</button><button className="button primary" disabled={!!busy || (screen === 'apiKey' && !apiKey)} type="submit">{busy ? <Spinner /> : <Icon name="link" size={15} />}连接</button></footer>
        </form>
      )}

      {screen === 'device' && deviceStatus && (
        <div className="device-code-flow">
          <div className="device-code-icon"><Icon name="device" size={27} /></div>
          <h3>在另一台设备上完成登录</h3>
          <p>打开验证页面并输入下方一次性代码。完成后 Codex 会自动更新账户状态。</p>
          <button className="device-code" onClick={() => navigator.clipboard.writeText(deviceStatus.deviceCode ?? '')} type="button"><code>{deviceStatus.deviceCode}</code><Icon name="copy" size={16} /></button>
          {deviceStatus.verificationUrl && <button className="button primary" onClick={() => window.researchIDE?.app.openExternal(deviceStatus.verificationUrl!)} type="button"><Icon name="external" size={15} />打开验证页面</button>}
          <footer className="modal-actions"><span className="waiting-label"><Spinner />等待授权…</span><button className="button ghost" onClick={close} type="button">取消</button></footer>
        </div>
      )}
      {error && screen === 'choose' && <div className="form-error auth-error"><Icon name="error" size={15} />{error}</div>}
    </Modal>
  );
}

function ApprovalCard({
  approval,
  busy,
  onDecision,
}: {
  approval: CodexApprovalRequest;
  busy: boolean;
  onDecision(decision: CodexApprovalDecision): void;
}) {
  const decisions = approval.availableDecisions ?? ['accept', 'decline', 'cancel'];
  return (
    <article className="approval-card">
      <header>
        <span className={`approval-kind approval-${approval.kind}`}><Icon name={approvalIcon(approval.kind)} size={16} /></span>
        <div><span>需要你的审批</span><strong>{approval.title}</strong></div>
        <Badge tone={approval.kind === 'network' || approval.kind === 'command' ? 'warning' : 'blue'}>
          {approval.kind === 'command' ? '命令' : approval.kind === 'fileWrite' ? '文件写入' : approval.kind === 'network' ? '网络' : '工具'}
        </Badge>
      </header>
      <div className="approval-body">
        {approval.command && <pre className="approval-command"><span>$</span><code>{approval.command}</code></pre>}
        {approval.paths && approval.paths.length > 0 && <div className="approval-files"><span>影响文件</span>{approval.paths.map((path) => <code key={path}>{path}</code>)}</div>}
        <dl className="approval-facts">
          {approval.cwd && <><dt>工作目录</dt><dd><code>{approval.cwd}</code></dd></>}
          {approval.reason && <><dt>原因</dt><dd>{approval.reason}</dd></>}
          {approval.networkDestination && <><dt>网络目标</dt><dd><code>{approval.networkDestination}</code></dd></>}
          {approval.detail && <><dt>详情</dt><dd>{approval.detail}</dd></>}
        </dl>
      </div>
      <footer>
        {decisions.includes('accept') && <button className="approval-button approve" disabled={busy} onClick={() => onDecision('accept')} type="button"><Icon name="check" size={14} />允许一次</button>}
        {decisions.includes('acceptForSession') && <button className="approval-button session" disabled={busy} onClick={() => onDecision('acceptForSession')} type="button"><Icon name="pin" size={14} />本会话允许</button>}
        {decisions.includes('decline') && <button className="approval-button decline" disabled={busy} onClick={() => onDecision('decline')} type="button">拒绝</button>}
        {decisions.includes('cancel') && <IconButton disabled={busy} icon="stop" label="取消本轮任务" onClick={() => onDecision('cancel')} />}
      </footer>
    </article>
  );
}

export function ConversationMenu({
  activeThreadId,
  activeThreads,
  archivedThreads,
  view,
  busyThreadId,
  disabled = false,
  conversationsUnavailable = false,
  onViewChange,
  onSelect,
  onArchive,
  onUnarchive,
  onDelete,
  onRefresh,
}: {
  activeThreadId?: string;
  activeThreads: CodexThreadSummary[];
  archivedThreads: CodexThreadSummary[];
  view: 'active' | 'archived';
  busyThreadId?: string;
  disabled?: boolean;
  conversationsUnavailable?: boolean;
  onViewChange(view: 'active' | 'archived'): void;
  onSelect(threadId: string): void;
  onArchive(threadId: string): void;
  onUnarchive(threadId: string): void;
  onDelete(threadId: string): void;
  onRefresh(): void;
}) {
  const visibleThreads = view === 'archived' ? archivedThreads : activeThreads;

  function confirmDelete(thread: CodexThreadSummary) {
    const confirmed = window.confirm(`永久删除对话“${thread.title}”？\n\n此操作只删除该对话，且无法撤销。`);
    if (confirmed) onDelete(thread.id);
  }

  return (
    <div className="codex-thread-menu">
      <header>
        <div aria-label="对话状态" className="codex-thread-tabs" role="tablist">
          <button aria-selected={view === 'active'} className={view === 'active' ? 'active' : ''} onClick={() => onViewChange('active')} role="tab" type="button">对话 <span>{activeThreads.length}</span></button>
          <button aria-selected={view === 'archived'} className={view === 'archived' ? 'active' : ''} onClick={() => onViewChange('archived')} role="tab" type="button">已归档 <span>{archivedThreads.length}</span></button>
        </div>
        <IconButton icon="refresh" label="刷新对话" onClick={onRefresh} />
      </header>
      <div className="codex-thread-list">
        {visibleThreads.length ? visibleThreads.map((thread) => (
          <div className={`codex-thread-row ${thread.id === activeThreadId ? 'active' : ''}`} key={thread.id}>
            <button className="codex-thread-select" disabled={disabled || !!busyThreadId || view === 'archived'} onClick={() => onSelect(thread.id)} type="button">
              <Icon name="chat" size={14} />
              <span><strong>{thread.title}</strong><small>{new Date(thread.updatedAt).toLocaleString('zh-CN')}</small></span>
              {busyThreadId === thread.id && <Spinner />}
            </button>
            <div className="codex-thread-actions">
              {view === 'active' ? (
                <IconButton disabled={disabled || !!busyThreadId} icon={semanticIcons.conversation.archive} label={`归档对话：${thread.title}`} onClick={() => onArchive(thread.id)} />
              ) : (
                <IconButton disabled={disabled || !!busyThreadId} icon={semanticIcons.conversation.unarchive} label={`取消归档：${thread.title}`} onClick={() => onUnarchive(thread.id)} />
              )}
              <IconButton disabled={disabled || !!busyThreadId} icon={semanticIcons.conversation.delete} label={`删除对话：${thread.title}`} onClick={() => confirmDelete(thread)} />
            </div>
          </div>
        )) : <span className="codex-thread-empty">{conversationsUnavailable ? '当前 Codex 版本不支持对话列表' : view === 'archived' ? '还没有已归档的对话' : '还没有已保存的对话'}</span>}
      </div>
    </div>
  );
}

export function CodexPanel({
  project,
  activeFile,
  openTabs,
  projectFiles,
  onAttentionChange,
  onReadyChange,
  onLog,
}: {
  project: ProjectSummary;
  activeFile?: string;
  openTabs: EditorTab[];
  projectFiles: string[];
  onAttentionChange(count: number): void;
  onReadyChange(ready: boolean): void;
  onLog(message: string, level?: 'info' | 'success' | 'warning' | 'error'): void;
}) {
  const [status, setStatus] = useState<CodexStatus>(initialStatus);
  const [messages, setMessages] = useState<CodexChatMessage[]>([]);
  const [threadHistory, setThreadHistory] = useState<CodexThreadView['history']>();
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<CodexThreadSummary[]>([]);
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threadView, setThreadView] = useState<'active' | 'archived'>('active');
  const [loadingThread, setLoadingThread] = useState('');
  const [managingThread, setManagingThread] = useState('');
  const [approvals, setApprovals] = useState<CodexApprovalRequest[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'ask' | 'agent'>('agent');
  const [contextFiles, setContextFiles] = useState<string[]>(activeFile ? [activeFile] : []);
  const [contextQuery, setContextQuery] = useState('');
  const [sending, setSending] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [busyApproval, setBusyApproval] = useState('');
  const [error, setError] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const handleEventRef = useRef<(event: CodexEvent) => void>(() => undefined);
  const hydrateCodexRef = useRef<(status: CodexStatus, resumeLatest: boolean) => Promise<void>>(async () => undefined);
  const api = window.researchIDE;

  handleEventRef.current = handleEvent;
  hydrateCodexRef.current = hydrateCodex;

  useEffect(() => {
    if (!api) return;
    void api.codex.getStatus().then(async (next) => {
      setStatus(next);
      if (next.server === 'ready') await hydrateCodexRef.current(next, true);
    }).catch((nextError) => setError(nextError instanceof Error ? nextError.message : 'Codex 状态不可用'));
    return api.codex.onEvent((event) => handleEventRef.current(event));
  }, [api]);

  useEffect(() => { onAttentionChange(approvals.length); }, [approvals.length, onAttentionChange]);
  useEffect(() => { onReadyChange(status.server === 'ready' && status.account.state === 'signedIn'); }, [onReadyChange, status.account.state, status.server]);
  useEffect(() => {
    if (activeFile && contextFiles.length === 0) setContextFiles([activeFile]);
  }, [activeFile, contextFiles.length]);
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, timeline]);

  function handleEvent(event: CodexEvent) {
    if (event.type === 'status') setStatus(event.status);
    if (event.type === 'message.started') {
      setMessages((current) => current.some((message) => message.id === event.message.id) ? current : [...current, event.message]);
    }
    if (event.type === 'message.delta') {
      setMessages((current) => current.map((message) => message.id === event.messageId ? { ...message, content: message.content + event.delta, pending: true } : message));
    }
    if (event.type === 'message.completed') {
      setMessages((current) => current.map((message) => message.id === event.messageId ? { ...message, content: event.content ?? message.content, pending: false } : message));
      setSending(false);
      void refreshThreads().catch(() => undefined);
    }
    if (event.type === 'approval.requested') {
      setApprovals((current) => [...current.filter((item) => item.id !== event.approval.id), event.approval]);
      onLog(`Codex 请求审批：${event.approval.title}`, 'warning');
    }
    if (event.type === 'approval.resolved') setApprovals((current) => current.filter((item) => item.id !== event.approvalId));
    if (event.type === 'approval.autoReview.started') {
      setTimeline((current) => [...current.filter((item) => item.id !== event.reviewId), { id: event.reviewId, label: '自动安全审查', detail: '正在评估权限请求', state: 'running' }]);
    }
    if (event.type === 'approval.autoReview.completed') {
      const approved = event.status === 'approved';
      const detail = [event.riskLevel ? `风险：${event.riskLevel}` : '', event.rationale ?? ''].filter(Boolean).join(' · ');
      setTimeline((current) => current.some((item) => item.id === event.reviewId)
        ? current.map((item) => item.id === event.reviewId ? { ...item, detail, state: approved ? 'success' : 'error' } : item)
        : [...current, { id: event.reviewId, label: '自动安全审查', detail, state: approved ? 'success' : 'error' }]);
      onLog(`Codex 自动审查：${event.status}${event.riskLevel ? `（${event.riskLevel}）` : ''}`, approved ? 'success' : 'warning');
    }
    if (event.type === 'tool.started') setTimeline((current) => [...current, { id: crypto.randomUUID(), label: event.label, detail: event.detail, state: 'running' }]);
    if (event.type === 'tool.completed') {
      setTimeline((current) => {
        const index = [...current].reverse().findIndex((item) => item.label === event.label && item.state === 'running');
        if (index < 0) return [...current, { id: crypto.randomUUID(), label: event.label, detail: event.detail, state: event.success ? 'success' : 'error' }];
        const actual = current.length - 1 - index;
        return current.map((item, itemIndex) => itemIndex === actual ? { ...item, detail: event.detail ?? item.detail, state: event.success ? 'success' : 'error' } : item);
      });
    }
    if (event.type === 'error') {
      setError(event.message);
      setSending(false);
      setMessages((current) => current.map((message) => message.pending ? { ...message, pending: false, error: true } : message));
      onLog(`Codex：${event.message}`, 'error');
    }
  }

  async function startServer() {
    if (!api) return;
    setStatus((current) => ({ ...current, server: 'starting' }));
    setError('');
    try {
      const next = await api.codex.start();
      setStatus(next);
      await hydrateCodex(next, true);
      if (next.account.state !== 'signedIn') setAuthOpen(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Codex 启动失败');
      setStatus((current) => ({ ...current, server: 'error' }));
    }
  }

  async function signIn(input: Parameters<NonNullable<typeof api>['codex']['signIn']>[0]) {
    if (!api) throw new Error('桌面桥不可用');
    const account = await api.codex.signIn(input);
    const next = { ...status, account };
    setStatus(next);
    await hydrateCodex(next, true);
    return account;
  }

  async function hydrateCodex(nextStatus: CodexStatus, resumeLatest: boolean) {
    if (!api) return;
    const [nextModels, nextThreads, nextArchivedThreads] = await Promise.all([
      api.codex.listModels().catch(() => []),
      api.codex.listThreads().catch(() => []),
      api.codex.listThreads({ archived: true }).catch(() => []),
    ]);
    setModels(nextModels);
    setThreads(nextThreads);
    setArchivedThreads(nextArchivedThreads);
    const selected = nextStatus.threadId ?? (resumeLatest ? nextThreads[0]?.id : undefined);
    if (!selected) return;
    try {
      const view = nextStatus.threadId ? await api.codex.readThread(selected) : await api.codex.resumeThread(selected);
      applyThreadView(view);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法恢复对话');
    }
  }

  function applyThreadView(view: CodexThreadView) {
    setMessages(view.messages);
    setThreadHistory(view.history);
    setTimeline([]);
    setApprovals([]);
    setSending(false);
    setStatus((current) => ({ ...current, threadId: view.thread.id, model: view.model ?? current.model, effort: view.effort ?? current.effort }));
  }

  async function refreshThreads(): Promise<{ active: CodexThreadSummary[]; archived: CodexThreadSummary[] }> {
    if (!api) return { active: [], archived: [] };
    const [active, archived] = await Promise.all([
      api.codex.listThreads(),
      api.codex.listThreads({ archived: true }),
    ]);
    setThreads(active);
    setArchivedThreads(archived);
    return { active, archived };
  }

  async function selectThread(threadId: string) {
    if (!api || sending || loadingThread) return;
    setLoadingThread(threadId);
    setError('');
    try {
      const view = await api.codex.resumeThread(threadId);
      applyThreadView(view);
      setThreadsOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '切换对话失败');
    } finally {
      setLoadingThread('');
    }
  }

  async function send() {
    const content = prompt.trim();
    if (!api || !content || sending || status.account.state !== 'signedIn') return;
    const localMessage: CodexChatMessage = { id: crypto.randomUUID(), role: 'user', content, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, localMessage]);
    setPrompt('');
    setSending(true);
    setError('');
    try {
      const result = await api.codex.send({
        threadId: status.threadId,
        prompt: content,
        projectPath: project.path,
        contextFiles,
        contextBuffers: buildCodexContextBuffers(contextFiles, openTabs),
        mode,
      });
      setStatus((current) => ({ ...current, threadId: result.threadId }));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : '消息发送失败';
      setMessages((current) => current.map((item) => item.id === localMessage.id ? { ...item, error: true } : item));
      setError(message);
      setSending(false);
    }
  }

  async function decide(approval: CodexApprovalRequest, decision: CodexApprovalDecision) {
    if (!api) return;
    setBusyApproval(approval.id);
    try {
      await api.codex.decideApproval({ approvalId: approval.id, decision });
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
      if (decision === 'cancel') await cancelCurrentTurn(approval.threadId || status.threadId);
      onLog(`Codex 审批：${approval.title} → ${decision}`, decision === 'decline' || decision === 'cancel' ? 'warning' : 'success');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '提交审批失败');
    } finally { setBusyApproval(''); }
  }

  async function cancelCurrentTurn(threadId = status.threadId) {
    if (!api) return;
    try {
      await api.codex.cancelTurn(threadId);
      onLog('已取消当前 Codex 任务', 'warning');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '取消任务失败');
    } finally {
      setSending(false);
      setMessages((current) => current.map((message) => message.pending ? { ...message, pending: false } : message));
      setTimeline((current) => current.map((item) => item.state === 'running' ? { ...item, state: 'error', detail: item.detail || '已取消' } : item));
    }
  }

  async function newThread() {
    if (!api) return;
    try {
      const threadId = await api.codex.newThread({ model: status.model, effort: status.effort });
      setStatus((current) => ({ ...current, threadId }));
      setMessages([]);
      setThreadHistory(undefined);
      setTimeline([]);
      setApprovals([]);
      setSending(false);
      setThreadsOpen(false);
      setThreadView('active');
      await refreshThreads();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '新建对话失败');
    }
  }

  function clearThreadView() {
    setMessages([]);
    setThreadHistory(undefined);
    setTimeline([]);
    setApprovals([]);
    setSending(false);
    setStatus((current) => ({ ...current, threadId: undefined }));
  }

  async function restoreFallbackThread(activeThreads: CodexThreadSummary[]) {
    clearThreadView();
    const fallback = activeThreads[0];
    if (!api || !fallback) return;
    const view = await api.codex.resumeThread(fallback.id);
    applyThreadView(view);
  }

  async function archiveThread(threadId: string) {
    if (!api || sending || managingThread) return;
    setManagingThread(threadId);
    setError('');
    try {
      await api.codex.archiveThread(threadId);
      const next = await refreshThreads();
      if (status.threadId === threadId) await restoreFallbackThread(next.active);
      onLog('对话已归档', 'success');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '归档对话失败');
    } finally {
      setManagingThread('');
    }
  }

  async function unarchiveThread(threadId: string) {
    if (!api || sending || managingThread) return;
    setManagingThread(threadId);
    setError('');
    try {
      await api.codex.unarchiveThread(threadId);
      await refreshThreads();
      setThreadView('active');
      onLog('对话已恢复到项目对话', 'success');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '取消归档失败');
    } finally {
      setManagingThread('');
    }
  }

  async function deleteThread(threadId: string) {
    if (!api || sending || managingThread) return;
    setManagingThread(threadId);
    setError('');
    try {
      await api.codex.deleteThread(threadId);
      const next = await refreshThreads();
      if (status.threadId === threadId) await restoreFallbackThread(next.active);
      onLog('指定对话已永久删除', 'warning');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '删除对话失败');
    } finally {
      setManagingThread('');
    }
  }

  async function changeModel(model: string) {
    if (!api) return;
    const option = models.find((item) => item.model === model);
    const supported = option?.supportedReasoningEfforts ?? [];
    const effort = supported.some((item) => item.value === status.effort)
      ? status.effort
      : option?.defaultReasoningEffort ?? supported[0]?.value;
    try {
      const next = await api.codex.updateSettings({ threadId: status.threadId, model, effort });
      setStatus(next);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '模型切换失败');
    }
  }

  async function changeEffort(effort: string) {
    if (!api) return;
    try {
      const next = await api.codex.updateSettings({ threadId: status.threadId, model: status.model, effort });
      setStatus(next);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '思考强度切换失败');
    }
  }

  async function signOut() {
    if (!api) return;
    await api.codex.signOut();
    setStatus((current) => ({ ...current, account: { state: 'signedOut' }, threadId: undefined }));
    setMessages([]);
    setThreadHistory(undefined);
    setSending(false);
  }

  const dirtyContext = useMemo(() => new Set(openTabs.filter((tab) => tab.dirty && !tab.virtual).map((tab) => tab.path)), [openTabs]);
  const availableContext = useMemo(() => Array.from(new Set(projectFiles)).sort((left, right) => left.localeCompare(right)), [projectFiles]);
  const availableContextMatches = useMemo(() => {
    const query = contextQuery.trim().toLocaleLowerCase();
    return availableContext
      .filter((pathname) => !contextFiles.includes(pathname))
      .filter((pathname) => !query || pathname.toLocaleLowerCase().includes(query) || basename(pathname).toLocaleLowerCase().includes(query))
      .slice(0, 200);
  }, [availableContext, contextFiles, contextQuery]);
  const ready = status.server === 'ready' && status.account.state === 'signedIn';
  const selectedModel = models.find((model) => model.model === status.model) ?? models[0];
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];

  return (
    <aside className="side-panel codex-panel">
      <header className="codex-header">
        <div className="codex-title"><span className="codex-glyph"><Icon name="sparkles" size={18} /></span><div><span>研究智能体</span><h2>Codex</h2></div></div>
        <div className="codex-header-actions">
          {ready && <IconButton icon="history" label="切换对话" onClick={() => setThreadsOpen((open) => !open)} />}
          {ready && <IconButton disabled={sending} icon="plus" label={sending ? '任务进行中，暂不能新建对话' : '新建对话'} onClick={newThread} />}
          <IconButton icon="more" label="Codex 设置" onClick={() => setAuthOpen(true)} />
        </div>
      </header>

      {threadsOpen && ready && (
        <ConversationMenu
          activeThreadId={status.threadId}
          activeThreads={threads}
          archivedThreads={archivedThreads}
          busyThreadId={managingThread || loadingThread}
          conversationsUnavailable={status.capabilities?.conversations === 'unavailable'}
          disabled={sending}
          onArchive={(threadId) => void archiveThread(threadId)}
          onDelete={(threadId) => void deleteThread(threadId)}
          onRefresh={() => void refreshThreads().catch((nextError) => setError(nextError instanceof Error ? nextError.message : '刷新对话失败'))}
          onSelect={(threadId) => void selectThread(threadId)}
          onUnarchive={(threadId) => void unarchiveThread(threadId)}
          onViewChange={setThreadView}
          view={threadView}
        />
      )}

      <div className={`codex-account codex-${status.server} account-${status.account.state}`}>
        <span className="account-status-dot" />
        <div><strong>{statusLabel(status)}</strong><small>{status.account.label || status.model || status.detail || 'codex app-server · 本地进程'}</small></div>
        {status.server !== 'ready' ? (
          <button className="button primary small" disabled={status.server === 'starting'} onClick={startServer} type="button">{status.server === 'starting' ? <Spinner /> : <Icon name="play" size={13} />}启动</button>
        ) : status.account.state !== 'signedIn' ? (
          <button className="button primary small" onClick={() => setAuthOpen(true)} type="button">登录</button>
        ) : (
          <IconButton icon="logout" label="退出 Codex 账户" onClick={signOut} />
        )}
      </div>

      {approvals.length > 0 && <div className="approval-queue-label"><span><Icon name="bell" size={13} />待审批</span><Badge tone="warning">{approvals.length}</Badge></div>}
      <div className="codex-feed" ref={feedRef}>
        {threadHistory?.truncated && (
          <div className="codex-history-notice" role="status">
            <Icon name="info" size={14} />
            <span><strong>更早的对话未加载</strong><small>{threadHistory.truncationReason === 'paginationGuard' ? `Codex 分页未安全结束；已显示最近 ${threadHistory.loadedTurns} 轮。` : threadHistory.truncationReason === 'sizeLimit' ? `历史内容达到本地大小上限；已显示最近 ${threadHistory.loadedTurns} 轮。` : `本地最多恢复最近 ${threadHistory.maxTurns} 轮；当前已显示 ${threadHistory.loadedTurns} 轮。`}</small></span>
          </div>
        )}
        {approvals.map((approval) => <ApprovalCard approval={approval} busy={busyApproval === approval.id} key={approval.id} onDecision={(decision) => decide(approval, decision)} />)}
        {!messages.length && !approvals.length ? (
          <EmptyState compact icon="sparkles" title={ready ? '从当前研究问题开始' : '连接后开始使用 Codex'}>
            {ready ? '描述问题，或让 Codex 帮你处理当前项目。' : '启动 Codex 并选择账户连接方式。'}
          </EmptyState>
        ) : (
          messages.map((message) => (
            <article className={`chat-message message-${message.role} ${message.error ? 'message-error' : ''}`} key={message.id}>
              <div className="message-avatar">{message.role === 'assistant' ? <Icon name="sparkles" size={14} /> : <Icon name="user" size={14} />}</div>
              <div className="message-body"><header><strong>{message.role === 'assistant' ? 'Codex' : '你'}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header><div className="message-content">{message.content || (message.pending ? <span className="typing-dots"><i /><i /><i /></span> : '')}</div></div>
            </article>
          ))
        )}
        {timeline.length > 0 && <div className="codex-timeline">{timeline.slice(-6).map((item) => <div key={item.id}><span className={`timeline-state ${item.state}`}>{item.state === 'running' ? <Spinner /> : <Icon name={item.state === 'success' ? 'check' : 'error'} size={11} />}</span><span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span></div>)}</div>}
      </div>

      {error && <div className="codex-error"><Icon name="error" size={13} /><span>{error}</span><button onClick={() => setError('')} type="button"><Icon name="close" size={12} /></button></div>}
      <div className="codex-composer-area">
        {ready && (
          <div className="codex-runtime-controls">
            <label title={selectedModel?.description}><span>模型</span><select aria-label="Codex 模型" disabled={!models.length || sending} onChange={(event) => void changeModel(event.target.value)} value={selectedModel?.model ?? ''}>{!models.length && <option value="">当前版本不可用</option>}{models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}</select></label>
            <label><span>思考强度</span><select aria-label="Codex 思考强度" disabled={!efforts.length || sending} onChange={(event) => void changeEffort(event.target.value)} value={status.effort ?? selectedModel?.defaultReasoningEffort ?? ''}>{!efforts.length && <option value="">当前模型不可用</option>}{efforts.map((effort) => <option key={effort.value} title={effort.description} value={effort.value}>{effort.value}</option>)}</select></label>
            <span className={`codex-review-state ${status.capabilities?.autoReview === 'available' ? 'available' : 'fallback'}`} title={status.capabilities?.detail || 'Codex app-server 能力状态'}><Icon name="shield" size={12} />{status.capabilities?.autoReview === 'available' ? '自动审查' : '人工审批回退'}</span>
          </div>
        )}
        <div className="context-strip">
          <span><Icon name="paperclip" size={12} />上下文</span>
          <div className="context-files">
            {contextFiles.map((pathname) => <button className={dirtyContext.has(pathname) ? 'dirty-buffer' : ''} key={pathname} onClick={() => setContextFiles((current) => current.filter((item) => item !== pathname))} title={`${pathname}${dirtyContext.has(pathname) ? '（将发送未保存缓冲区）' : ''}`} type="button"><Icon name="file" size={11} /><span>{basename(pathname)}{dirtyContext.has(pathname) && <small>未保存缓冲区</small>}</span><Icon name="close" size={9} /></button>)}
            <details className="context-picker"><summary aria-label="从项目文件中添加上下文" title="从项目文件中添加上下文"><Icon name="plus" size={12} /></summary><div><input aria-label="搜索项目上下文文件" onChange={(event) => setContextQuery(event.target.value)} placeholder="搜索项目文件…" value={contextQuery} />{contextFiles.length >= CODEX_CONTEXT_LIMITS.maxFiles ? <span>一次最多选择 {CODEX_CONTEXT_LIMITS.maxFiles} 个文件</span> : availableContextMatches.length ? availableContextMatches.map((pathname) => <button key={pathname} onClick={() => setContextFiles((current) => current.includes(pathname) || current.length >= CODEX_CONTEXT_LIMITS.maxFiles ? current : [...current, pathname])} type="button"><Icon name="file" size={12} /><span>{basename(pathname)}<small>{relativePath(pathname, project.path)}{dirtyContext.has(pathname) ? ' · 未保存缓冲区' : ''}</small></span></button>) : <span>{contextQuery ? '没有匹配的项目文件' : '没有更多项目文件'}</span>}</div></details>
          </div>
        </div>
        <div className={`codex-composer ${!ready ? 'disabled' : ''}`}>
          <textarea
            aria-label="发送消息给 Codex"
            disabled={!ready}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
            placeholder={ready ? '描述问题，或让 Codex 在项目范围内工作…' : '连接 Codex 后即可输入'}
            rows={3}
            value={prompt}
          />
          <div className="composer-footer">
            <div className="mode-switch" role="group" aria-label="Codex 模式"><button className={mode === 'ask' ? 'active' : ''} onClick={() => setMode('ask')} type="button">问答</button><button className={mode === 'agent' ? 'active' : ''} onClick={() => setMode('agent')} type="button">智能体</button></div>
            {sending ? <button className="send-button stop-send" onClick={() => void cancelCurrentTurn()} title="停止" type="button"><Icon name="stop" size={14} /></button> : <button className="send-button" disabled={!prompt.trim() || !ready} onClick={send} title="发送" type="button"><Icon name="send" size={15} /></button>}
          </div>
        </div>
      </div>
      {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onSignIn={signIn} status={status.account} />}
    </aside>
  );
}
