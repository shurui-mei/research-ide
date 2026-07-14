import { useEffect, useMemo, useRef, useState } from 'react';
import { basename, fileIconName, relativePath } from '../lib/files';
import type { FileNode, ProjectSummary } from '../types';
import { Icon, type IconName } from './Icon';

export interface PaletteCommand {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  icon: IconName;
  disabled?: boolean;
  run(): void;
}

export function CommandPalette({
  mode,
  project,
  files,
  commands,
  onOpenFile,
  onClose,
}: {
  mode: 'commands' | 'files';
  project: ProjectSummary | null;
  files: FileNode[];
  commands: PaletteCommand[];
  onOpenFile(file: FileNode): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState(mode === 'commands' ? '>' : '');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const commandMode = query.startsWith('>');
  const needle = (commandMode ? query.slice(1) : query).trim().toLowerCase();
  const results = useMemo(() => commandMode
    ? commands.filter((command) => `${command.label} ${command.detail ?? ''}`.toLowerCase().includes(needle))
    : files.filter((file) => `${file.name} ${file.path}`.toLowerCase().includes(needle)).slice(0, 80), [commandMode, commands, files, needle]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActiveIndex(0); }, [query]);

  function choose(index: number) {
    const item = results[index];
    if (!item) return;
    if (commandMode) {
      const command = item as PaletteCommand;
      if (command.disabled) return;
      command.run();
    } else onOpenFile(item as FileNode);
    onClose();
  }

  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-label="指令中心" aria-modal="true" className="command-palette" role="dialog">
        <div className="palette-input-row">
          <Icon name={commandMode ? 'command' : 'search'} size={17} />
          <input
            aria-label={commandMode ? '搜索指令' : '快速打开文件'}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((current) => Math.min(results.length - 1, current + 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((current) => Math.max(0, current - 1)); }
              if (event.key === 'Enter') { event.preventDefault(); choose(activeIndex); }
            }}
            placeholder={commandMode ? '按名称筛选指令' : project ? `在 ${project.name} 中按名称打开文件` : '键入 > 搜索指令'}
            ref={inputRef}
            spellCheck={false}
            value={query}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-mode-hint">
          <span>{commandMode ? '指令' : '文件'}</span>
          <button onClick={() => setQuery(commandMode ? '' : '>')} type="button">{commandMode ? '切换到文件' : '键入 > 切换到指令'}</button>
        </div>
        <div className="palette-results">
          {results.length ? results.map((item, index) => commandMode ? (
            <button className={index === activeIndex ? 'active' : ''} disabled={(item as PaletteCommand).disabled} key={(item as PaletteCommand).id} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(index)} type="button">
              <span className="palette-item-icon"><Icon name={(item as PaletteCommand).icon} size={15} /></span>
              <span><strong>{(item as PaletteCommand).label}</strong>{(item as PaletteCommand).detail && <small>{(item as PaletteCommand).detail}</small>}</span>
              {(item as PaletteCommand).shortcut && <kbd>{(item as PaletteCommand).shortcut}</kbd>}
            </button>
          ) : (
            <button className={index === activeIndex ? 'active' : ''} key={(item as FileNode).path} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(index)} type="button">
              <span className="palette-item-icon"><Icon className={`file-icon file-icon-${fileIconName((item as FileNode).path)}`} name={fileIconName((item as FileNode).path)} size={15} /></span>
              <span><strong>{basename((item as FileNode).path)}</strong><small>{relativePath((item as FileNode).path, project?.path ?? '')}</small></span>
            </button>
          )) : <div className="palette-empty"><Icon name={commandMode ? 'command' : 'file'} size={20} /><span>{commandMode ? '没有匹配的指令' : project ? '没有匹配的文件' : '请先打开一个项目'}</span></div>}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> 导航</span><span><kbd>↵</kbd> 选择</span><span><kbd>&gt;</kbd> 指令</span></footer>
      </section>
    </div>
  );
}
