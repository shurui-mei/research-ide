import type { BottomView, EditorTab, ProjectSummary } from '../types';
import { Icon } from './Icon';

export function StatusBar({
  project,
  activeTab,
  problemCount,
  warningCount,
  bottomVisible,
  codexReady,
  snapshotCount,
  onToggleBottom,
  onOpenBackups,
}: {
  project: ProjectSummary | null;
  activeTab?: EditorTab;
  problemCount: number;
  warningCount: number;
  bottomVisible: boolean;
  codexReady: boolean;
  snapshotCount?: number;
  onToggleBottom(view?: BottomView): void;
  onOpenBackups(): void;
}) {
  return (
    <footer className="statusbar">
      <div className="status-left">
        {project ? <>
          <button onClick={() => onToggleBottom('problems')} title="打开问题面板" type="button"><Icon name="error" size={11} />{problemCount}<Icon name="warning" size={11} />{warningCount}</button>
          <button onClick={onOpenBackups} title="项目快照" type="button"><Icon name="history" size={12} /><span>{snapshotCount == null ? '快照' : snapshotCount}</span></button>
        </> : null}
      </div>
      <div className="status-right">
        {activeTab?.kind === 'text' && <>
          <span>行 {activeTab.cursor?.line ?? 1}, 列 {activeTab.cursor?.column ?? 1}</span>
          <span>UTF-8</span>
          <span>{activeTab.language ?? 'Plain Text'}</span>
        </>}
        <span className={`codex-mini-status ${codexReady ? 'ready' : ''}`}><Icon name="sparkles" size={11} />Codex {codexReady ? '就绪' : '待连接'}</span>
        <button aria-pressed={bottomVisible} onClick={() => onToggleBottom()} title="切换底部面板" type="button"><Icon name="panel" size={12} /></button>
      </div>
    </footer>
  );
}
