import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ManagedToolchainCatalog, ManagedToolchainEvent, ToolRunRequest, ToolchainInfo } from '../types';
import { Badge, EmptyState, IconButton, Spinner } from './Common';
import { Icon, type IconName } from './Icon';

function toolIcon(tool: ToolchainInfo): IconName {
  if (tool.kind === 'latex') return 'tex';
  if (tool.kind === 'python' || tool.kind === 'r') return 'code';
  if (tool.kind === 'pandoc') return 'doc';
  return 'terminal';
}

export function ToolchainsPanel({
  activeFile,
  onEnsure,
  onDetect,
  onSelectSystem,
  onSelectExecutable,
  onManagedCatalog,
  onInstallManaged,
  onSelectManaged,
  onRemoveManaged,
  onManagedEvent,
  onRun,
}: {
  activeFile?: string;
  onEnsure(): Promise<ToolchainInfo[]>;
  onDetect(): Promise<ToolchainInfo[]>;
  onSelectSystem(toolId: string): Promise<ToolchainInfo>;
  onSelectExecutable(toolId: string): Promise<ToolchainInfo>;
  onManagedCatalog(toolId: string): Promise<ManagedToolchainCatalog>;
  onInstallManaged(toolId: string, version: string): Promise<ToolchainInfo>;
  onSelectManaged(toolId: string, version: string): Promise<ToolchainInfo>;
  onRemoveManaged(toolId: string, version: string): Promise<void>;
  onManagedEvent(listener: (event: ManagedToolchainEvent) => void): () => void;
  onRun(request: ToolRunRequest): Promise<void>;
}) {
  const [tools, setTools] = useState<ToolchainInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [expandedId, setExpandedId] = useState('');
  const [args, setArgs] = useState('');
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [catalogs, setCatalogs] = useState<Record<string, ManagedToolchainCatalog>>({});
  const [catalogLoading, setCatalogLoading] = useState('');
  const [managedProgress, setManagedProgress] = useState<Record<string, ManagedToolchainEvent>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setTools(await onEnsure()); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : '无法读取工具链'); }
    finally { setLoading(false); }
  }, [onEnsure]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onManagedEvent((event) => {
    setManagedProgress((current) => ({ ...current, [event.toolId]: event }));
  }), [onManagedEvent]);

  const readyCount = useMemo(() => tools.filter((tool) => tool.status === 'ready').length, [tools]);

  async function detect() {
    setDetecting(true);
    setError('');
    try { setTools(await onDetect()); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : '检测失败'); }
    finally { setDetecting(false); }
  }

  async function selectExecutable(tool: ToolchainInfo) {
    setBusyId(tool.id);
    setError('');
    try {
      const next = await onSelectExecutable(tool.id);
      setTools((current) => current.map((item) => item.id === next.id ? next : item));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法选择可执行文件');
    } finally { setBusyId(''); }
  }

  async function selectSystem(tool: ToolchainInfo) {
    setBusyId(tool.id);
    setError('');
    try {
      const next = await onSelectSystem(tool.id);
      setTools((current) => current.map((item) => item.id === next.id ? next : item));
      await loadCatalog(tool.id, true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '系统路径中没有可用版本');
    } finally { setBusyId(''); }
  }

  async function loadCatalog(toolId: string, force = false) {
    if (!force && catalogs[toolId]) return;
    setCatalogLoading(toolId);
    setError('');
    try {
      const catalog = await onManagedCatalog(toolId);
      setCatalogs((current) => ({ ...current, [toolId]: catalog }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法读取可安装版本');
    } finally { setCatalogLoading(''); }
  }

  function toggle(toolId: string) {
    const next = expandedId === toolId ? '' : toolId;
    setExpandedId(next);
    if (next) void loadCatalog(next);
  }

  async function installManaged(tool: ToolchainInfo, version: string) {
    const key = `${tool.id}:${version}`;
    setBusyId(key);
    setError('');
    try {
      const next = await onInstallManaged(tool.id, version);
      setTools((current) => current.map((item) => item.id === next.id ? next : item));
      await loadCatalog(tool.id, true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '本地版本安装失败');
    } finally { setBusyId(''); }
  }

  async function selectManaged(tool: ToolchainInfo, version: string) {
    const key = `${tool.id}:${version}`;
    setBusyId(key);
    setError('');
    try {
      const next = await onSelectManaged(tool.id, version);
      setTools((current) => current.map((item) => item.id === next.id ? next : item));
      await loadCatalog(tool.id, true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法切换本地版本');
    } finally { setBusyId(''); }
  }

  async function removeManaged(tool: ToolchainInfo, version: string) {
    const key = `${tool.id}:${version}:remove`;
    setBusyId(key);
    setError('');
    try {
      await onRemoveManaged(tool.id, version);
      await loadCatalog(tool.id, true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法移除本地版本');
    } finally { setBusyId(''); }
  }

  async function run(tool: ToolchainInfo) {
    setBusyId(tool.id);
    try {
      const parsedArgs = args.match(/(?:[^\s"]+|"[^"]*")+/gu)?.map((part) => part.replace(/^"|"$/gu, '')) ?? [];
      await onRun({ toolId: tool.id, args: parsedArgs, cwd: undefined });
    } finally { setBusyId(''); }
  }

  return (
    <aside className="side-panel toolchains-panel">
      <header className="side-panel-header">
        <div><span className="side-panel-kicker">运行环境</span><h2>工具链</h2></div>
        <IconButton className={detecting ? 'rotating' : ''} disabled={detecting} icon="refresh" label="重新检测系统工具" onClick={detect} />
      </header>
      <div className="toolchain-overview">
        <div className="overview-ring"><span>{readyCount}</span><small>可用</small></div>
        <div><strong>项目运行环境</strong><p>可使用系统路径，也可在 Research IDE 的本地目录中并存、切换多个版本。</p></div>
      </div>
      {activeFile && <div className="active-runtime-file"><Icon name="file" size={13} /><span>当前文件</span><code>{activeFile.split(/[\\/]/u).at(-1)}</code></div>}
      {error && <div className="panel-inline-error"><Icon name="error" size={14} />{error}</div>}
      <div className="toolchain-list">
        {loading ? <div className="list-skeleton"><span /><span /><span /><span /></div> : tools.length ? tools.map((tool) => {
          const catalog = catalogs[tool.id];
          const progress = managedProgress[tool.id];
          return (
            <article className={`toolchain-card ${expandedId === tool.id ? 'expanded' : ''}`} key={tool.id}>
              <button aria-expanded={expandedId === tool.id} className="toolchain-card-main" onClick={() => toggle(tool.id)} type="button">
                <span className={`tool-glyph tool-${tool.kind}`}><Icon name={toolIcon(tool)} size={17} /></span>
                <span className="tool-copy">
                  <strong>{tool.name}{tool.selected && <Badge tone="accent">项目默认</Badge>}</strong>
                  <small>{tool.status === 'ready' ? [tool.version, tool.path].filter(Boolean).join(' · ') : tool.detail || '未在系统路径中发现'}</small>
                </span>
                <span className={`status-indicator status-${tool.status}`} title={tool.status} />
                <Icon name={expandedId === tool.id ? 'chevronDown' : 'chevronRight'} size={13} />
              </button>
              {expandedId === tool.id && (
                <div className="toolchain-details">
                  {tool.status === 'ready' ? (
                    <>
                      <div className="tool-path"><span>可执行文件</span><code title={tool.path}>{tool.path}</code></div>
                      <div className="tool-run-row">
                        <input aria-label={`${tool.name} 运行参数`} onChange={(event) => setArgs(event.target.value)} placeholder="运行参数（可选）" value={args} />
                        <button className="button primary small" disabled={busyId === tool.id} onClick={() => run(tool)} type="button">{busyId === tool.id ? <Spinner /> : <Icon name="play" size={13} />}运行</button>
                      </div>
                      {!tool.selected && <button className="text-button" disabled={busyId === tool.id} onClick={() => selectSystem(tool)} type="button"><Icon name="check" size={13} />设为项目默认（系统）</button>}
                      {tool.managed && <button className="text-button" disabled={busyId === tool.id} onClick={() => selectSystem(tool)} type="button"><Icon name="terminal" size={13} />改用系统版本</button>}
                      <button className="text-button" disabled={Boolean(busyId)} onClick={() => selectExecutable(tool)} type="button"><Icon name="folderOpen" size={13} />选择其他可执行文件</button>
                    </>
                  ) : (
                    <div className="missing-tool-actions">
                      {tool.status === 'error' && tool.systemPath && <>
                        <p>已检测到系统版本：{[tool.systemVersion, tool.systemPath].filter(Boolean).join(' · ')}</p>
                        <button className="button primary small" disabled={busyId === tool.id} onClick={() => selectSystem(tool)} type="button"><Icon name="check" size={13} />改用系统版本</button>
                      </>}
                      <button className="button secondary small" disabled={busyId === tool.id} onClick={() => selectExecutable(tool)} type="button"><Icon name="folderOpen" size={13} />选择系统路径</button>
                    </div>
                  )}
                  <section aria-label={`${tool.name} 本地版本`} className="managed-toolchain-section">
                    <div className="managed-toolchain-heading">
                      <div><strong>本地版本</strong><small>conda-forge · {catalog?.platform ?? '当前平台'}</small></div>
                      <IconButton className={catalogLoading === tool.id ? 'rotating' : ''} disabled={catalogLoading === tool.id} icon="refresh" label="刷新可安装版本" onClick={() => loadCatalog(tool.id, true)} />
                    </div>
                    {progress && !['completed', 'failed'].includes(progress.phase) && (
                      <div className="managed-install-progress" role="status">
                        <Spinner /><span>{progress.message}</span>
                        {progress.progress !== undefined && <progress max={1} value={progress.progress} />}
                      </div>
                    )}
                    {catalog?.warning && <p className="managed-catalog-warning"><Icon name="warning" size={13} />{catalog.warning}</p>}
                    {catalogLoading === tool.id && !catalog ? <div className="managed-catalog-loading"><Spinner />读取版本目录…</div> : (
                      <div className="managed-version-list">
                        {catalog?.versions.map((item) => (
                          <div className="managed-version-row" key={item.version}>
                            <div><code>{item.version}</code>{item.selected && <Badge tone="accent">项目默认</Badge>}<small>{item.installed ? '已安装' : '可安装'}</small></div>
                            <div className="managed-version-actions">
                              <button className={`button ${item.installed ? 'secondary' : 'primary'} small`} disabled={item.selected || busyId.startsWith(`${tool.id}:`)} onClick={() => item.installed ? selectManaged(tool, item.version) : installManaged(tool, item.version)} title={item.installed ? '设为当前项目版本' : '下载、安装并设为当前项目版本'} type="button">
                                {busyId === `${tool.id}:${item.version}` ? <Spinner /> : <Icon name={item.installed ? 'check' : 'download'} size={13} />}
                                {item.selected ? '使用中' : item.installed ? '使用' : '安装'}
                              </button>
                              {item.installed && <IconButton disabled={item.selected || busyId.startsWith(`${tool.id}:`)} icon="trash" label={`移除 ${item.version}`} onClick={() => removeManaged(tool, item.version)} />}
                            </div>
                          </div>
                        ))}
                        {catalog && !catalog.versions.length && <p>当前平台没有可用版本。</p>}
                      </div>
                    )}
                    <p className="managed-toolchain-note">版本保存在应用数据目录，不修改系统 PATH；安装前会确认并校验管理器摘要。</p>
                  </section>
                </div>
              )}
            </article>
          );
        }) : (
          <EmptyState action={<button className="button secondary small" onClick={detect} type="button"><Icon name="refresh" size={14} />开始检测</button>} compact icon="tools" title="尚未检测工具链">扫描 PATH 中的 LaTeX、Python、R 与常用编译器。</EmptyState>
        )}
      </div>
    </aside>
  );
}
