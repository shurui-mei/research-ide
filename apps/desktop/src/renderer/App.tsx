import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityBar } from './components/ActivityBar';
import { BackupDialog } from './components/BackupDialog';
import { BottomPanel } from './components/BottomPanel';
import { CodexPanel } from './components/CodexPanel';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { EditorArea } from './components/EditorArea';
import { ExplorerPanel } from './components/ExplorerPanel';
import { Icon } from './components/Icon';
import { LiteraturePanel } from './components/LiteraturePanel';
import { NewProjectDialog } from './components/NewProjectDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { ToolchainsPanel } from './components/ToolchainsPanel';
import { Welcome } from './components/Welcome';
import { basename, dirname, flattenFiles, joinPath, kindForPath, languageForPath } from './lib/files';
import type {
  ActivityView,
  BottomView,
  EditorTab,
  FileNode,
  LiteratureItem,
  LogEntry,
  ProblemItem,
  ProjectSummary,
  ToolEvent,
  ToolRunRequest,
} from './types';

interface ToastItem {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'warning' | 'error';
}

function App() {
  const api = window.researchIDE;
  const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(Boolean(api));
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [activity, setActivity] = useState<ActivityView>('explorer');
  const [bottomView, setBottomView] = useState<BottomView>('output');
  const [bottomVisible, setBottomVisible] = useState(false);
  const [bottomHeight, setBottomHeight] = useState(190);
  const [problems, setProblems] = useState<ProblemItem[]>([]);
  const [output, setOutput] = useState<ToolEvent[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState<{ runId: string; label: string }>();
  const [compiling, setCompiling] = useState(false);
  const [codexAttention, setCodexAttention] = useState(0);
  const [codexReady, setCodexReady] = useState(false);
  const [snapshotCount, setSnapshotCount] = useState<number>();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'commands' | 'files' | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const refreshTimer = useRef<number>();
  const runningRef = useRef<typeof running>();
  const tabsRef = useRef<EditorTab[]>(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const completedRunsRef = useRef(new Map<string, ToolEvent>());
  const latexRunsRef = useRef(new Map<string, { outputId: string; outputPdf: string }>());
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  const commitTabs = useCallback((update: (current: EditorTab[]) => EditorTab[]) => {
    setTabs((current) => {
      const next = update(current);
      tabsRef.current = next;
      return next;
    });
  }, []);

  const selectTab = useCallback((id: string) => {
    activeTabIdRef.current = id;
    setActiveTabId(id);
  }, []);

  const addToast = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, []);

  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info', source = 'IDE') => {
    setLogs((current) => [...current.slice(-499), { id: crypto.randomUUID(), level, message, timestamp: new Date().toISOString(), source }]);
  }, []);

  const loadTree = useCallback(async () => {
    if (!api) return;
    setTreeLoading(true);
    try { setTree(await api.project.getTree()); }
    catch (error) { addLog(error instanceof Error ? error.message : '无法读取项目文件', 'error', 'Project'); }
    finally { setTreeLoading(false); }
  }, [addLog, api]);

  const loadDiagnostics = useCallback(async () => {
    if (!api) return;
    try { setProblems(await api.diagnostics.listProblems()); } catch { setProblems([]); }
  }, [api]);

  const loadSnapshotCount = useCallback(async () => {
    if (!api) return;
    try { setSnapshotCount((await api.snapshots.list()).length); } catch { setSnapshotCount(undefined); }
  }, [api]);

  const previewLatexOutput = useCallback(async (runId: string) => {
    if (!api) return;
    const build = latexRunsRef.current.get(runId);
    latexRunsRef.current.delete(runId);
    if (!build) return;
    const virtualPath = `Build/${build.outputId}/${build.outputPdf}`;
    if (api.latex.readOutput) {
      try {
        const raw = await api.latex.readOutput(build.outputId);
        const binary = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const path = virtualPath;
        const existing = tabsRef.current.find((tab) => tab.path === path);
        if (existing) {
          commitTabs((current) => current.map((tab) => tab.id === existing.id ? { ...tab, binary, loading: false, error: undefined } : tab));
          selectTab(existing.id);
        } else {
          const tab: EditorTab = { id: crypto.randomUUID(), path, name: `构建 · ${build.outputPdf}`, kind: 'pdf', binary, dirty: false, virtual: true };
          commitTabs((current) => [...current, tab]);
          selectTab(tab.id);
        }
        addToast('LaTeX 编译完成，已打开构建 PDF', 'success');
        return;
      } catch (error) {
        addLog(error instanceof Error ? error.message : '构建 PDF 无法读取', 'warning', 'LaTeX');
      }
    }
    addToast('LaTeX 编译完成；构建结果位于 .research_ide/build', 'success');
    addLog(`已生成 ${build.outputPdf}；当前主进程未提供内存预览输出`, 'info', 'LaTeX');
  }, [addLog, addToast, api, commitTabs, selectTab]);

  const completeRun = useCallback((event: ToolEvent, currentRun: { runId: string; label: string }) => {
    const succeeded = event.type === 'exit' && event.exitCode === 0;
    addLog(`${currentRun.label}${succeeded ? '已完成' : '执行失败'}${event.type === 'exit' ? `（退出码 ${event.exitCode ?? '—'}）` : ''}`, succeeded ? 'success' : 'error', 'Runner');
    if (currentRun.label.includes('LaTeX')) {
      setCompiling(false);
      if (succeeded) void previewLatexOutput(event.runId);
      else latexRunsRef.current.delete(event.runId);
    }
    if (runningRef.current?.runId === event.runId) {
      runningRef.current = undefined;
      setRunning(undefined);
    }
    void loadDiagnostics();
    void loadTree();
  }, [addLog, loadDiagnostics, loadTree, previewLatexOutput]);

  useEffect(() => {
    if (!api) { setRecentsLoading(false); return; }
    void api.project.listRecent()
      .then(setRecentProjects)
      .catch((error) => addLog(error instanceof Error ? error.message : '无法读取最近项目', 'warning'))
      .finally(() => setRecentsLoading(false));
  }, [addLog, api]);

  useEffect(() => {
    if (!api || !project) return;
    const unwatch = api.project.onWorkspaceChange((event) => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void loadTree(), 180);
      if (event.type !== 'changed') addLog(`文件${event.type === 'created' ? '已创建' : event.type === 'deleted' ? '已删除' : '已重命名'}：${event.path}`, 'info', 'Workspace');
    });
    const unsubscribeTools = api.toolchains.onEvent((event) => {
      setOutput((current) => [...current.slice(-1999), event]);
      if (event.type === 'exit' || event.type === 'error') {
        const currentRun = runningRef.current;
        if (currentRun?.runId === event.runId) {
          completeRun(event, currentRun);
        } else completedRunsRef.current.set(event.runId, event);
      }
    });
    return () => {
      unwatch();
      unsubscribeTools();
      window.clearTimeout(refreshTimer.current);
    };
  }, [addLog, api, completeRun, loadTree, project]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!tabs.some((tab) => tab.dirty)) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [tabs]);

  const confirmProjectSwitch = useCallback(() => !tabsRef.current.some((tab) => tab.dirty)
    || window.confirm('当前项目中有未保存的编辑。切换项目将放弃这些更改，是否继续？'), []);

  async function activateProject(summary: ProjectSummary) {
    setProject(summary);
    setRecentProjects((current) => [summary, ...current.filter((item) => item.path !== summary.path)].slice(0, 20));
    tabsRef.current = [];
    setTabs([]);
    selectTab('');
    setSelectedPath('');
    setActivity('explorer');
    setOutput([]);
    setProblems([]);
    addLog(`已打开项目 ${summary.name}`, 'success', 'Project');
    await Promise.all([loadTree(), loadDiagnostics(), loadSnapshotCount()]);
  }

  async function openProjectDialog() {
    if (!api || !confirmProjectSwitch()) return;
    try {
      const summary = await api.project.openDialog();
      if (summary) await activateProject(summary);
    } catch (error) { addToast(error instanceof Error ? error.message : '项目打开失败', 'error'); }
  }

  async function openRecent(summary: ProjectSummary) {
    if (!api || !confirmProjectSwitch()) return;
    try { await activateProject(await api.project.open(summary.path)); }
    catch (error) { addToast(error instanceof Error ? error.message : '项目已移动或无法访问', 'error'); }
  }

  async function createProject(input: { name: string; parentPath: string; template: 'blank' | 'latex' | 'paper'; initializeGit: boolean }) {
    if (!api) throw new Error('桌面桥不可用');
    if (!confirmProjectSwitch()) throw new Error('已取消项目切换；当前编辑仍未保存');
    const summary = await api.project.create(input);
    setNewProjectOpen(false);
    await activateProject(summary);
    addToast('项目已创建', 'success');
  }

  async function closeProject() {
    if (!api || !project) return;
    if (tabsRef.current.some((tab) => tab.dirty) && !window.confirm('项目中有未保存的编辑。仍要关闭项目吗？')) return;
    await api.project.close();
    setProject(null);
    tabsRef.current = [];
    setTabs([]);
    selectTab('');
    setTree([]);
    setBottomVisible(false);
    setCodexAttention(0);
    setCodexReady(false);
  }

  const openFile = useCallback(async (node: FileNode) => {
    if (!api || node.type !== 'file') return;
    const existing = tabsRef.current.find((tab) => tab.path === node.path);
    if (existing) { selectTab(existing.id); return; }
    const kind = kindForPath(node.path);
    const id = crypto.randomUUID();
    const pending: EditorTab = { id, path: node.path, name: node.name || basename(node.path), kind, dirty: false, loading: true };
    commitTabs((current) => [...current, pending]);
    selectTab(id);
    setSelectedPath(node.path);
    try {
      if (kind === 'text') {
        const content = await api.files.readText(node.path);
        commitTabs((current) => current.map((tab) => tab.id === id ? { ...tab, content, language: languageForPath(node.path), loading: false } : tab));
      } else if (kind === 'document') {
        const document = await api.documents.read(node.path);
        commitTabs((current) => current.map((tab) => tab.id === id ? { ...tab, document, loading: false } : tab));
      } else if (kind === 'docx') {
        const opened = node.path.toLowerCase().endsWith('.doc')
          ? await api.documents.readDoc(node.path)
          : await api.documents.readDocx(node.path);
        commitTabs((current) => current.map((tab) => tab.id === id ? {
          ...tab,
          document: opened.content,
          docxWarnings: opened.warnings,
          docxSourceHash: opened.sourceHash,
          docxReadOnly: opened.readOnly,
          loading: false,
        } : tab));
      } else {
        const raw = await api.files.readBinary(node.path);
        const binary = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        commitTabs((current) => current.map((tab) => tab.id === id ? { ...tab, binary, loading: false } : tab));
      }
    } catch (error) {
      commitTabs((current) => current.map((tab) => tab.id === id ? { ...tab, loading: false, error: error instanceof Error ? error.message : '文件打开失败' } : tab));
    }
  }, [api, commitTabs, selectTab]);

  const saveTab = useCallback(async (id: string) => {
    if (!api) return;
    const tab = tabsRef.current.find((item) => item.id === id);
    if (!tab || tab.loading || tab.kind === 'pdf' || !tab.dirty) return;
    if (tab.kind === 'docx' && tab.docxReadOnly) {
      addToast('此 Word 文档包含无法安全保留的功能，已按只读方式打开', 'warning');
      return;
    }
    const savedValue = tab.kind === 'text' ? tab.content ?? '' : JSON.stringify(tab.document ?? '');
    try {
      if (tab.kind === 'text') await api.files.writeText(tab.path, tab.content ?? '');
      else if (tab.kind === 'docx') {
        const legacyDoc = tab.path.toLowerCase().endsWith('.doc');
        const format = legacyDoc ? 'DOC' : 'DOCX';
        if (!tab.docxSourceHash || !tab.document || typeof tab.document === 'string') throw new Error(`${format} 编辑状态无效，请重新打开文件`);
        let acknowledged = Boolean(tab.docxCompatibilityAcknowledged);
        const warnings = (tab.docxWarnings ?? []).filter((item) => item.requiresAcknowledgement);
        if (!acknowledged && warnings.length) {
          const summary = warnings.slice(0, 6).map((item) => `• ${item.title}`).join('\n');
          acknowledged = window.confirm(`保存将重新生成 ${format}。原文件会先自动备份。\n\n${summary}\n\n是否继续保存？`);
          if (!acknowledged) return;
        }
        const saveRequest = {
          path: tab.path,
          content: tab.document,
          expectedSourceHash: tab.docxSourceHash,
          acknowledgeCompatibilityWarnings: acknowledged,
        };
        const result = legacyDoc
          ? await api.documents.writeDoc(saveRequest)
          : await api.documents.writeDocx(saveRequest);
        commitTabs((current) => current.map((item) => item.id === id ? {
          ...item,
          docxCompatibilityAcknowledged: acknowledged,
          docxSourceHash: result.sourceHash,
        } : item));
        addToast(`${format} 已保存；原文件备份 ${result.backupId.slice(0, 8)}`, 'success');
      } else await api.documents.write(tab.path, tab.document ?? '');
      commitTabs((current) => current.map((item) => {
        if (item.id !== id) return item;
        const currentValue = item.kind === 'text' ? item.content ?? '' : JSON.stringify(item.document ?? '');
        return currentValue === savedValue ? { ...item, dirty: false } : item;
      }));
      addLog(`已保存 ${tab.path}`, 'success', 'Editor');
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败';
      addToast(message, 'error');
      addLog(message, 'error', 'Editor');
      throw error;
    }
  }, [addLog, addToast, api, commitTabs]);

  const closeTab = useCallback((id: string) => {
    const currentTabs = tabsRef.current;
    const tab = currentTabs.find((item) => item.id === id);
    if (!tab) return;
    if (tab.dirty && !window.confirm(`“${tab.name}”有未保存的更改。放弃这些更改吗？`)) return;
    const index = currentTabs.findIndex((item) => item.id === id);
    const remaining = currentTabs.filter((item) => item.id !== id);
    tabsRef.current = remaining;
    setTabs(remaining);
    if (activeTabIdRef.current === id) selectTab(remaining[Math.min(index, remaining.length - 1)]?.id ?? '');
  }, [selectTab]);

  async function createEntry(path: string, type: 'file' | 'directory') {
    if (!api) return;
    await api.files.create(path, type);
    await loadTree();
    if (type === 'file') await openFile({ name: basename(path), path, type: 'file' });
  }

  async function renameEntry(path: string, nextName: string) {
    if (!api) return;
    await api.files.rename(path, nextName);
    const parent = dirname(path);
    const nextPath = joinPath(parent, nextName);
    commitTabs((current) => current.map((tab) => {
      if (tab.path === path) return { ...tab, path: nextPath, name: nextName };
      if (tab.path.startsWith(`${path}/`)) return { ...tab, path: `${nextPath}${tab.path.slice(path.length)}` };
      return tab;
    }));
    setSelectedPath(nextPath);
    await loadTree();
  }

  async function deleteEntry(path: string) {
    if (!api) return;
    await api.files.delete(path);
    const selectedTab = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
    const removedActiveTab = selectedTab?.path === path || selectedTab?.path.startsWith(`${path}/`);
    commitTabs((current) => current.filter((tab) => tab.path !== path && !tab.path.startsWith(`${path}/`)));
    if (removedActiveTab) selectTab('');
    setSelectedPath('');
    await loadTree();
  }

  async function compileLatex(tab: EditorTab) {
    if (!api) return;
    try {
      if (tab.dirty) await saveTab(tab.id);
      setBottomView('output');
      setBottomVisible(true);
      setCompiling(true);
      const result = await api.latex.compile(tab.path);
      const nextRun = { runId: result.runId, label: `LaTeX · ${basename(tab.path)}` };
      latexRunsRef.current.set(result.runId, { outputId: result.outputId, outputPdf: result.outputPdf });
      runningRef.current = nextRun;
      setRunning(nextRun);
      addLog(`开始编译 ${tab.path}`, 'info', 'LaTeX');
      const completed = completedRunsRef.current.get(result.runId);
      if (completed) { completedRunsRef.current.delete(result.runId); completeRun(completed, nextRun); }
    } catch (error) {
      setCompiling(false);
      const message = error instanceof Error ? error.message : '无法启动 LaTeX 编译';
      addToast(message, 'error');
      addLog(message, 'error', 'LaTeX');
    }
  }

  async function runTool(request: ToolRunRequest) {
    if (!api) return;
    setBottomView('output');
    setBottomVisible(true);
    const result = await api.toolchains.run({ ...request, cwd: request.cwd || undefined });
    const nextRun = { runId: result.runId, label: request.toolId };
    runningRef.current = nextRun;
    setRunning(nextRun);
    addLog(`已启动 ${request.toolId}`, 'info', 'Runner');
    const completed = completedRunsRef.current.get(result.runId);
    if (completed) { completedRunsRef.current.delete(result.runId); completeRun(completed, nextRun); }
  }

  async function stopRun() {
    if (!api || !running) return;
    await api.toolchains.stop(running.runId);
    addLog(`已请求停止 ${running.label}`, 'warning', 'Runner');
  }

  const toggleBottom = useCallback((view?: BottomView) => {
    if (view) setBottomView(view);
    setBottomVisible((current) => view ? true : !current);
  }, []);

  function beginResize(event: React.PointerEvent) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = bottomHeight;
    const move = (next: PointerEvent) => setBottomHeight(Math.max(110, Math.min(460, startHeight + startY - next.clientY)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); if (activeTabId) void saveTab(activeTabId).catch(() => undefined); }
      if (modifier && event.key.toLowerCase() === 'p' && !event.shiftKey) { event.preventDefault(); setPaletteMode('files'); }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); setPaletteMode('commands'); }
      if (modifier && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteMode('commands'); }
      if (modifier && event.key === '`') { event.preventDefault(); toggleBottom(); }
      if (event.key === 'Escape') setPaletteMode(null);
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [activeTabId, saveTab, toggleBottom]);

  const paletteFiles = useMemo(() => flattenFiles(tree), [tree]);
  const listLiterature = useCallback(async () => {
    if (!api) return { items: [], status: { zoteroAvailable: false, connected: false } };
    const [items, status] = await Promise.all([api.literature.list(), api.literature.getStatus()]);
    return { items, status };
  }, [api]);
  const searchLiterature = useCallback((query: string) => api ? api.literature.search(query) : Promise.resolve([]), [api]);
  const ensureToolchains = useCallback(() => api ? api.toolchains.ensureDetected() : Promise.resolve([]), [api]);
  const commands: PaletteCommand[] = [
    { id: 'project.new', label: '项目：新建项目', detail: '创建本地研究工作区', icon: 'plus', shortcut: '⇧⌘N', run: () => setNewProjectOpen(true) },
    { id: 'project.open', label: '项目：打开项目', detail: '选择本地文件夹', icon: 'folderOpen', shortcut: '⌘O', run: () => void openProjectDialog() },
    { id: 'file.save', label: '文件：保存当前文件', icon: 'save', shortcut: '⌘S', disabled: !activeTab?.dirty, run: () => { if (activeTab) void saveTab(activeTab.id).catch(() => undefined); } },
    { id: 'latex.compile', label: 'LaTeX：编译当前文档', detail: '输出将显示在底部面板', icon: 'play', disabled: activeTab?.language !== 'latex', run: () => activeTab && void compileLatex(activeTab) },
    { id: 'view.codex', label: '视图：打开 Codex', detail: '查看对话与审批队列', icon: 'sparkles', run: () => setActivity('codex') },
    { id: 'view.literature', label: '视图：打开文献管理', icon: 'book', run: () => setActivity('literature') },
    { id: 'view.tools', label: '视图：打开工具链', icon: 'tools', run: () => setActivity('toolchains') },
    { id: 'project.snapshot', label: '项目：创建或恢复快照', icon: 'history', disabled: !project, run: () => setBackupsOpen(true) },
    { id: 'panel.toggle', label: '视图：切换底部面板', icon: 'panel', shortcut: '⌘`', run: () => toggleBottom() },
    { id: 'project.close', label: '项目：关闭当前项目', icon: 'close', disabled: !project, run: () => void closeProject() },
  ];

  function sidePanel() {
    if (!project) return null;
    if (activity === 'explorer') return <ExplorerPanel loading={treeLoading} onCreate={createEntry} onDelete={deleteEntry} onOpenBackups={() => setBackupsOpen(true)} onOpenFile={openFile} onRefresh={loadTree} onRename={renameEntry} onReveal={(path) => api?.app.revealPath(path)} onSelectedPathChange={setSelectedPath} project={project} selectedPath={selectedPath} tree={tree} />;
    if (activity === 'literature') return <LiteraturePanel
      onConnectZotero={() => api!.literature.connectZotero()}
      onCopyCitation={(citekey) => { void navigator.clipboard.writeText(`\\cite{${citekey}}`); addToast(`已复制 \\cite{${citekey}}`, 'success'); }}
      onImport={() => api!.literature.importFile()}
      onLaunchZotero={() => api?.literature.launchZotero()}
      onList={listLiterature}
      onOpenAttachment={async (item: LiteratureItem) => { const path = await api?.literature.openAttachment(item.id); if (path) await openFile({ name: basename(path), path, type: 'file' }); }}
      onSearch={searchLiterature}
    />;
    if (activity === 'toolchains') return <ToolchainsPanel
      activeFile={activeTab?.path}
      onDetect={() => api!.toolchains.detect()}
      onEnsure={ensureToolchains}
      onInstallManaged={(id, version) => api!.toolchains.installManaged(id, version)}
      onManagedCatalog={(id) => api!.toolchains.managedCatalog(id)}
      onManagedEvent={(listener) => api!.toolchains.onManagedEvent(listener)}
      onRemoveManaged={(id, version) => api!.toolchains.removeManaged(id, version)}
      onSelectManaged={(id, version) => api!.toolchains.selectManaged(id, version)}
      onRun={runTool}
      onSelectSystem={(id) => api!.toolchains.selectSystem(id)}
      onSelectExecutable={(id) => api!.toolchains.selectExecutable(id)}
    />;
    return null;
  }

  return (
    <div className="app-shell">
      <TitleBar onCommandPalette={() => setPaletteMode('commands')} onNewProject={() => setNewProjectOpen(true)} onOpenProject={openProjectDialog} onSave={() => { if (activeTab) void saveTab(activeTab.id).catch(() => undefined); }} project={project} />
      {project ? (
        <div className={`workbench ${activity === 'codex' ? 'codex-view' : ''}`}>
          <ActivityBar active={activity} codexAttention={codexAttention > 0} onChange={setActivity} onSettings={() => setSettingsOpen(true)} />
          <div className="side-panel-host">
            {sidePanel()}
            <div className={activity === 'codex' ? 'persistent-codex active' : 'persistent-codex'}>
              <CodexPanel activeFile={activeTab?.virtual ? undefined : activeTab?.path} key={project.id || project.path} onAttentionChange={setCodexAttention} onLog={(message, level) => addLog(message, level, 'Codex')} onReadyChange={setCodexReady} openTabs={tabs} project={project} projectFiles={paletteFiles.map((file) => file.path)} />
            </div>
          </div>
          <div className="editor-stack">
            <EditorArea
              activeTabId={activeTabId}
              compiling={compiling}
              onActivateTab={selectTab}
              onCloseTab={closeTab}
              onCompileLatex={compileLatex}
              onCursorChange={(id, line, column) => commitTabs((current) => current.map((tab) => tab.id === id ? { ...tab, cursor: { line, column } } : tab))}
              onDocumentChange={(id, document) => commitTabs((current) => current.map((tab) => tab.id === id ? { ...tab, document, dirty: true } : tab))}
              onOpenProjectFile={() => setPaletteMode('files')}
              onReveal={(path) => api?.app.revealPath(path)}
              onSave={(id) => { void saveTab(id).catch(() => undefined); }}
              onTextChange={(id, content) => commitTabs((current) => current.map((tab) => tab.id === id ? { ...tab, content, dirty: true } : tab))}
              project={project}
              tabs={tabs}
            />
            <BottomPanel
              activeView={bottomView}
              height={bottomHeight}
              logs={logs}
              onClearLogs={() => setLogs([])}
              onClearOutput={() => setOutput([])}
              onOpenProblem={(problem) => { if (!problem.path) return; void openFile({ name: basename(problem.path), path: problem.path, type: 'file' }).then(() => commitTabs((current) => current.map((tab) => tab.path === problem.path ? { ...tab, reveal: { line: problem.line ?? 1, column: 1, nonce: crypto.randomUUID() } } : tab))); }}
              onResizeStart={beginResize}
              onStop={stopRun}
              onToggle={() => setBottomVisible(false)}
              onViewChange={setBottomView}
              output={output}
              problems={problems}
              running={running}
              visible={bottomVisible}
            />
          </div>
        </div>
      ) : (
        <Welcome bridgeAvailable={Boolean(api)} loading={recentsLoading} onNewProject={() => setNewProjectOpen(true)} onOpenProject={openProjectDialog} onOpenRecent={openRecent} recentProjects={recentProjects} />
      )}
      <StatusBar activeTab={activeTab} bottomVisible={bottomVisible} codexReady={codexReady} onOpenBackups={() => project && setBackupsOpen(true)} onToggleBottom={toggleBottom} problemCount={problems.filter((item) => item.severity === 'error').length} project={project} snapshotCount={snapshotCount} warningCount={problems.filter((item) => item.severity === 'warning').length} />

      {newProjectOpen && <NewProjectDialog onClose={() => setNewProjectOpen(false)} onCreate={createProject} onSelectDirectory={() => api?.app.selectDirectory() ?? Promise.resolve(null)} />}
      {backupsOpen && project && <BackupDialog onBeforeRestore={() => !tabsRef.current.some((tab) => tab.dirty) || window.confirm('恢复会覆盖磁盘内容，且当前编辑器有未保存更改。放弃这些编辑并继续吗？')} onChanged={() => { tabsRef.current = []; setTabs([]); selectTab(''); setSelectedPath(''); void loadTree(); void loadSnapshotCount(); addToast('快照恢复完成；已关闭旧编辑器以避免内容冲突', 'success'); }} onClose={() => { setBackupsOpen(false); void loadSnapshotCount(); }} project={project} selectedPath={selectedPath} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onReveal={(path) => api?.app.revealPath(path)} project={project} />}
      {paletteMode && <CommandPalette commands={commands} files={paletteFiles} mode={paletteMode} onClose={() => setPaletteMode(null)} onOpenFile={openFile} project={project} />}
      <div aria-live="polite" className="toast-region">{toasts.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}><Icon name={toast.tone === 'error' ? 'error' : toast.tone === 'warning' ? 'warning' : toast.tone === 'success' ? 'check' : 'info'} size={15} /><span>{toast.message}</span><button aria-label="关闭通知" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} type="button"><Icon name="close" size={12} /></button></div>)}</div>
    </div>
  );
}

export default App;
