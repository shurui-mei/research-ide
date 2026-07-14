import { useEffect, useRef, useState } from 'react';
import { basename, relativePath } from '../lib/files';
import type { ProjectSummary, SearchResult } from '../types';
import { EmptyState, Spinner } from './Common';
import { Icon } from './Icon';

export function SearchPanel({
  project,
  onSearch,
  onOpenResult,
}: {
  project: ProjectSummary;
  onSearch(query: string): Promise<SearchResult[]>;
  onOpenResult(result: SearchResult): void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const currentId = ++requestId.current;
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const next = await onSearch(normalized);
        if (currentId === requestId.current) setResults(next);
      } catch (nextError) {
        if (currentId === requestId.current) setError(nextError instanceof Error ? nextError.message : '搜索失败');
      } finally {
        if (currentId === requestId.current) setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [onSearch, query]);

  const groups = results.reduce<Record<string, SearchResult[]>>((accumulator, result) => {
    (accumulator[result.path] ??= []).push(result);
    return accumulator;
  }, {});

  return (
    <aside className="side-panel search-panel">
      <header className="side-panel-header"><div><span className="side-panel-kicker">项目</span><h2>搜索</h2></div></header>
      <div className="side-panel-search">
        <Icon name="search" size={15} />
        <input
          aria-label="搜索项目内容"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="在项目中搜索"
          value={query}
        />
        {query && <button aria-label="清空搜索" onClick={() => setQuery('')} type="button"><Icon name="close" size={13} /></button>}
      </div>
      <div className="search-options">
        <span>{loading ? '正在搜索…' : query.trim().length >= 2 ? `${results.length} 个结果` : '输入至少 2 个字符'}</span>
        {loading && <Spinner />}
      </div>
      <div className="search-results">
        {error ? (
          <EmptyState compact icon="error" title="搜索失败">{error}</EmptyState>
        ) : !query.trim() ? (
          <EmptyState compact icon="search" title="搜索当前项目">匹配文件名与文件内容。</EmptyState>
        ) : !loading && query.trim().length >= 2 && !results.length ? (
          <EmptyState compact icon="search" title="没有结果">尝试更短的关键词或不同拼写。</EmptyState>
        ) : (
          Object.entries(groups).map(([path, matches]) => (
            <section className="search-group" key={path}>
              <header title={path}><Icon name="file" size={14} /><strong>{basename(path)}</strong><small>{relativePath(path, project.path)}</small></header>
              {matches.map((match, index) => (
                <button className="search-match" key={`${path}-${match.line}-${index}`} onClick={() => onOpenResult(match)} type="button">
                  <span className="match-line">{match.line}</span>
                  <span className="match-preview">{match.preview}</span>
                </button>
              ))}
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
