import { useState } from 'react';
import type { ProjectSummary } from '../types';
import { EmptyState, IconButton, Spinner } from './Common';
import { Icon } from './Icon';

export function Welcome({
  recentProjects,
  loading,
  bridgeAvailable,
  onOpenProject,
  onOpenRecent,
  onNewProject,
  onRemoveRecent,
}: {
  recentProjects: ProjectSummary[];
  loading: boolean;
  bridgeAvailable: boolean;
  onOpenProject(): void;
  onOpenRecent(project: ProjectSummary): void;
  onNewProject(): void;
  onRemoveRecent?(project: ProjectSummary): void;
}) {
  const [filter, setFilter] = useState('');
  const visibleProjects = recentProjects.filter((project) =>
    `${project.name} ${project.path}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <main className="welcome-shell">
      <section className="welcome-hero">
        <div className="welcome-orbit" aria-hidden="true">
          <span className="orbit-ring orbit-one" />
          <span className="orbit-ring orbit-two" />
          <span className="orbit-core"><Icon name="logo" size={36} /></span>
          <span className="orbit-node node-one" />
          <span className="orbit-node node-two" />
        </div>
        <p className="eyebrow">LOCAL-FIRST RESEARCH WORKSPACE</p>
        <h1>把研究工作，放回一个清晰的上下文里。</h1>
        <p className="welcome-lead">
          写作、文献、运行环境与 Codex 都围绕项目组织。
        </p>
        <div className="welcome-actions">
          <button className="button primary large" disabled={!bridgeAvailable} onClick={onNewProject} type="button">
            <Icon name="plus" /> 新建项目
          </button>
          <button className="button secondary large" disabled={!bridgeAvailable} onClick={onOpenProject} type="button">
            <Icon name="folderOpen" /> 打开项目
          </button>
        </div>
        {!bridgeAvailable && (
          <div className="bridge-warning" role="status">
            <Icon name="warning" size={16} />
            桌面桥尚未连接。请通过 Electron 启动应用以访问本地项目。
          </div>
        )}
      </section>

      <aside className="recent-card">
        <div className="recent-card-header">
          <div>
            <span className="section-kicker">继续研究</span>
            <h2>最近项目</h2>
          </div>
          {recentProjects.length > 4 && (
            <label className="compact-search">
              <Icon name="search" size={14} />
              <input
                aria-label="筛选最近项目"
                onChange={(event) => setFilter(event.target.value)}
                placeholder="筛选"
                value={filter}
              />
            </label>
          )}
        </div>
        <div className="recent-list">
          {loading ? (
            <div className="welcome-loading"><Spinner /><span>正在读取本地项目…</span></div>
          ) : visibleProjects.length ? (
            visibleProjects.map((project) => (
              <div className="recent-project" key={project.id || project.path}>
                <button className="recent-project-main" onClick={() => onOpenRecent(project)} type="button">
                  <span className={`project-glyph project-${project.kind ?? 'blank'}`}>
                    <Icon name={project.kind === 'latex' || project.kind === 'paper' ? 'tex' : 'folder'} size={19} />
                  </span>
                  <span className="recent-project-copy">
                    <strong>{project.name}</strong>
                    <small>{project.path}</small>
                  </span>
                  <Icon className="recent-arrow" name="arrowRight" size={17} />
                </button>
                {onRemoveRecent && (
                  <IconButton icon="close" label={`从最近项目移除 ${project.name}`} onClick={() => onRemoveRecent(project)} />
                )}
              </div>
            ))
          ) : (
            <EmptyState compact icon="clock" title={filter ? '没有匹配的项目' : '还没有最近项目'}>
              {filter ? '尝试另一个关键词。' : '创建或打开一个本地文件夹后，它会出现在这里。'}
            </EmptyState>
          )}
        </div>
      </aside>
    </main>
  );
}
