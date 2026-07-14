import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackupSnapshot, ProjectSummary } from '../types';
import { Badge, EmptyState, Field, IconButton, Modal, Spinner } from './Common';
import { Icon } from './Icon';

function formatBytes(bytes?: number) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BackupDialog({
  project,
  selectedPath,
  onClose,
  onChanged,
  onBeforeRestore,
}: {
  project: ProjectSummary;
  selectedPath?: string;
  onClose(): void;
  onChanged(): void;
  onBeforeRestore(): boolean;
}) {
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<'project' | 'selected'>(selectedPath ? 'selected' : 'project');
  const [error, setError] = useState('');
  const api = window.researchIDE;

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError('');
    try {
      setSnapshots(await api.snapshots.list());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法读取快照');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const defaultLabel = useMemo(() => {
    const formatter = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `手动快照 ${formatter.format(new Date())}`;
  }, []);

  async function createSnapshot() {
    if (!api) return;
    setBusyId('create');
    setError('');
    try {
      const snapshot = await api.snapshots.create(
        scope === 'selected' && selectedPath ? [selectedPath] : [''],
        label.trim() || defaultLabel,
      );
      setSnapshots((current) => [snapshot, ...current]);
      setLabel('');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '创建快照失败');
    } finally {
      setBusyId('');
    }
  }

  async function restore(snapshot: BackupSnapshot) {
    if (!api || !window.confirm(`恢复“${snapshot.label || '未命名快照'}”会覆盖当前范围内的文件。继续吗？`) || !onBeforeRestore()) return;
    setBusyId(snapshot.id);
    setError('');
    try {
      await api.snapshots.restore(snapshot.id);
      onChanged();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '恢复快照失败');
    } finally {
      setBusyId('');
    }
  }

  async function remove(snapshot: BackupSnapshot) {
    if (!api || !window.confirm(`删除快照“${snapshot.label || '未命名快照'}”？此操作无法撤销。`)) return;
    setBusyId(snapshot.id);
    try {
      await api.snapshots.delete(snapshot.id);
      setSnapshots((current) => current.filter((item) => item.id !== snapshot.id));
    } finally {
      setBusyId('');
    }
  }

  return (
    <Modal onClose={onClose} subtitle={`快照保存在 ${project.name}/.research_ide 中，可独立于 Git 使用。`} title="项目快照与备份" width="720px">
      <div className="backup-layout">
        <section className="snapshot-create-card">
          <div className="snapshot-create-icon"><Icon name="history" size={23} /></div>
          <div className="snapshot-create-content">
            <h3>创建本地快照</h3>
            <p>记录写作与配置的当前状态，恢复前仍会由你确认。</p>
            <Field label="快照名称（可选）">
              <input className="text-input" onChange={(event) => setLabel(event.target.value)} placeholder={defaultLabel} value={label} />
            </Field>
            <div className="scope-options">
              <label><input checked={scope === 'project'} name="snapshot-scope" onChange={() => setScope('project')} type="radio" />整个项目</label>
              <label className={!selectedPath ? 'disabled' : ''}><input checked={scope === 'selected'} disabled={!selectedPath} name="snapshot-scope" onChange={() => setScope('selected')} type="radio" />仅所选路径</label>
            </div>
            {scope === 'selected' && selectedPath && <code className="scope-path">{selectedPath}</code>}
            <button className="button primary" disabled={busyId === 'create'} onClick={createSnapshot} type="button">
              {busyId === 'create' ? <Spinner /> : <Icon name="save" size={16} />} 创建快照
            </button>
          </div>
        </section>

        <section className="snapshot-history">
          <header><div><span className="section-kicker">恢复点</span><h3>快照历史</h3></div><IconButton icon="refresh" label="刷新快照" onClick={load} /></header>
          {error && <div className="form-error"><Icon name="error" size={15} />{error}</div>}
          <div className="snapshot-list">
            {loading ? <div className="center-loading"><Spinner /><span>正在读取快照…</span></div> : snapshots.length ? snapshots.map((snapshot) => (
              <article className="snapshot-row" key={snapshot.id}>
                <div className="snapshot-dot"><Icon name="history" size={15} /></div>
                <div className="snapshot-copy">
                  <strong>{snapshot.label || '未命名快照'}</strong>
                  <span>{new Date(snapshot.createdAt).toLocaleString('zh-CN')} {snapshot.totalBytes != null && `· ${formatBytes(snapshot.totalBytes)}`} {snapshot.fileCount != null && `· ${snapshot.fileCount} 个文件`}</span>
                  <div>{snapshot.paths.length ? snapshot.paths.map((path) => <Badge key={path}>{path === '' ? '整个项目' : path.split(/[\\/]/).at(-1)}</Badge>) : <Badge>整个项目</Badge>}</div>
                </div>
                <div className="snapshot-actions">
                  <button className="button secondary small" disabled={!!busyId} onClick={() => restore(snapshot)} type="button">{busyId === snapshot.id ? <Spinner /> : <Icon name="undo" size={14} />}恢复</button>
                  <IconButton className="danger-hover" disabled={!!busyId} icon="trash" label="删除快照" onClick={() => remove(snapshot)} />
                </div>
              </article>
            )) : <EmptyState compact icon="history" title="还没有快照">创建第一个恢复点，之后可从这里回到它。</EmptyState>}
          </div>
        </section>
      </div>
      <footer className="modal-actions"><button className="button secondary" onClick={onClose} type="button">完成</button></footer>
    </Modal>
  );
}
