import type { ProjectSummary } from '../types';
import { Icon } from './Icon';
import { semanticIcons } from './semantic-icons';

export function TitleBar({
  project,
  onCommandPalette,
  onOpenProject,
  onNewProject,
  onSave,
}: {
  project: ProjectSummary | null;
  onCommandPalette(): void;
  onOpenProject(): void;
  onNewProject(): void;
  onSave(): void;
}) {
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <span className="brand-mark"><Icon name="logo" size={17} /></span>
        <span className="brand-name">Research IDE</span>
      </div>
      <nav aria-label="应用菜单" className="app-menu">
        <details>
          <summary>文件</summary>
          <div className="menu-popover">
            <button onClick={onNewProject} type="button"><span>新建项目…</span><kbd>⇧⌘N</kbd></button>
            <button onClick={onOpenProject} type="button"><span>打开项目…</span><kbd>⌘O</kbd></button>
            <div className="menu-separator" />
            <button disabled={!project} onClick={onSave} type="button"><span>保存</span><kbd>⌘S</kbd></button>
          </div>
        </details>
      </nav>
      <button aria-haspopup="dialog" aria-label={project ? `打开 ${project.name} 的指令中心` : '打开指令中心'} className="command-center" onClick={onCommandPalette} title="打开指令中心" type="button">
        <Icon name={semanticIcons.navigation.commandCenter} size={14} />
        <span>指令中心</span>
        <Icon className="command-center-chevron" name="chevronDown" size={12} />
        <kbd>⌘ K</kbd>
      </button>
    </header>
  );
}
