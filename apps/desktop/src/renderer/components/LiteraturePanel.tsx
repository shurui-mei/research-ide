import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LiteratureItem, LiteratureStatus } from '../types';
import { Badge, EmptyState, IconButton, Spinner } from './Common';
import { Icon } from './Icon';

function initials(authors: string[]) {
  if (!authors.length) return '—';
  return authors.slice(0, 2).map((author) => author.trim().charAt(0).toUpperCase()).join('');
}

export function LiteraturePanel({
  onList,
  onSearch,
  onImport,
  onOpenAttachment,
  onConnectZotero,
  onLaunchZotero,
  onCopyCitation,
}: {
  onList(): Promise<{ items: LiteratureItem[]; status: LiteratureStatus }>;
  onSearch(query: string): Promise<LiteratureItem[]>;
  onImport(): Promise<LiteratureItem | null>;
  onOpenAttachment(item: LiteratureItem): void;
  onConnectZotero(): Promise<LiteratureStatus>;
  onLaunchZotero(): void;
  onCopyCitation(citekey: string): void;
}) {
  const [items, setItems] = useState<LiteratureItem[]>([]);
  const [status, setStatus] = useState<LiteratureStatus>({ zoteroAvailable: false, connected: false });
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'local' | 'zotero'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await onList();
      setItems(next.items);
      setStatus(next.status);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法读取文献库');
    } finally {
      setLoading(false);
    }
  }, [onList]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!query.trim()) return;
    let current = true;
    const timeout = window.setTimeout(async () => {
      try {
        const next = await onSearch(query.trim());
        if (current) setItems(next);
      } catch { /* The current list remains useful on transient search errors. */ }
    }, 250);
    return () => { current = false; window.clearTimeout(timeout); };
  }, [onSearch, query]);

  const selected = useMemo(() => items.find((item) => item.id === selectedId), [items, selectedId]);
  const visibleItems = useMemo(() => sourceFilter === 'all' ? items : items.filter((item) => item.source === sourceFilter), [items, sourceFilter]);

  async function importItem() {
    setBusy('import');
    try {
      const item = await onImport();
      if (item) {
        setItems((current) => [item, ...current.filter((candidate) => candidate.id !== item.id)]);
        setSelectedId(item.id);
      }
    } finally { setBusy(''); }
  }

  async function connect() {
    setBusy('connect');
    setError('');
    try {
      setStatus(await onConnectZotero());
    } catch (nextError) {
      setStatus({
        zoteroAvailable: false,
        connected: false,
        detail: nextError instanceof Error ? nextError.message : 'Zotero 连接检测失败，请重试。',
      });
    } finally { setBusy(''); }
  }

  return (
    <aside className="side-panel literature-panel">
      <header className="side-panel-header">
        <div><span className="side-panel-kicker">知识库</span><h2>文献</h2></div>
        <div className="panel-actions">
          <IconButton disabled={busy === 'import'} icon="upload" label="导入文献" onClick={importItem} />
          <IconButton icon="refresh" label="刷新文献库" onClick={load} />
        </div>
      </header>

      <div aria-live="polite" className={`zotero-banner ${status.connected ? 'connected' : ''}`} role="status">
        <span className="zotero-mark">Z</span>
        <div>
          <strong>{status.connected ? 'Zotero 已连接' : status.zoteroAvailable ? '发现 Zotero' : '连接 Zotero'}</strong>
          <small>{status.detail || (status.connected ? '本地库可用于当前项目' : '复用你的本地文献库与附件')}</small>
        </div>
        {status.connected ? (
          <IconButton icon="external" label="打开 Zotero" onClick={onLaunchZotero} />
        ) : (
          <button className="button secondary small" disabled={busy === 'connect'} onClick={connect} type="button">
            {busy === 'connect' ? <Spinner /> : status.zoteroAvailable ? '重试' : '连接'}
          </button>
        )}
      </div>

      <div className="side-panel-search">
        <Icon name="search" size={15} />
        <input aria-label="搜索文献" onChange={(event) => setQuery(event.target.value)} placeholder="题名、作者或引用键" value={query} />
        {query && <button aria-label="清空搜索" onClick={() => { setQuery(''); void load(); }} type="button"><Icon name="close" size={13} /></button>}
      </div>

      <div className="literature-summary">
        <span>{loading ? '正在同步…' : `${visibleItems.length} 篇文献`}</span>
        <button onClick={() => setSourceFilter((current) => current === 'all' ? 'local' : current === 'local' ? 'zotero' : 'all')} title="循环筛选来源" type="button"><Icon name="filter" size={13} />{sourceFilter === 'all' ? '全部' : sourceFilter === 'local' ? '本地' : 'Zotero'}</button>
      </div>

      <div className="literature-list">
        {loading ? <div className="list-skeleton"><span /><span /><span /></div> : error ? (
          <EmptyState compact icon="error" title="文献库不可用">{error}</EmptyState>
        ) : visibleItems.length ? visibleItems.map((item) => (
          <article className={`literature-item ${selectedId === item.id ? 'selected' : ''}`} key={item.id}>
            <button className="literature-item-main" onClick={() => setSelectedId(item.id === selectedId ? '' : item.id)} type="button">
              <span className="author-avatar">{initials(item.authors)}</span>
              <span className="literature-copy">
                <strong>{item.title}</strong>
                <small>{item.authors.join(', ') || '未知作者'}{item.year ? ` · ${item.year}` : ''}</small>
                <span>{item.venue && <em>{item.venue}</em>}{item.citekey && <code>@{item.citekey}</code>}</span>
              </span>
            </button>
            {selectedId === item.id && (
              <div className="literature-actions">
                {item.citekey && <button onClick={() => onCopyCitation(item.citekey!)} type="button"><Icon name="copy" size={13} />复制引用</button>}
                {item.attachmentPath && <button onClick={() => onOpenAttachment(item)} type="button"><Icon name="pdf" size={13} />打开附件</button>}
              </div>
            )}
          </article>
        )) : (
          <EmptyState
            compact
            action={<button className="button secondary small" onClick={importItem} type="button"><Icon name="upload" size={14} />导入本地附件或元数据文件</button>}
            icon="book"
            title={query ? '没有匹配文献' : sourceFilter !== 'all' ? '此来源没有文献' : '项目文献库为空'}
          >
            {query ? '尝试作者名或更短的关键词。' : sourceFilter !== 'all' ? '切换到全部来源，或导入新的文献。' : '0.1 会保存本地文件并建立基础条目；格式解析与 Zotero 同步由后续 adapter 提供。'}
          </EmptyState>
        )}
      </div>

      {selected && selected.tags && selected.tags.length > 0 && (
        <footer className="literature-tags">{selected.tags.slice(0, 5).map((tag) => <Badge key={tag}>{tag}</Badge>)}</footer>
      )}
    </aside>
  );
}
