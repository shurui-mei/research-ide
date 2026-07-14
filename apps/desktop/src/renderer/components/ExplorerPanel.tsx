import { useEffect, useMemo, useRef, useState } from 'react';
import { basename, dirname, fileIconName, joinPath, relativePath } from '../lib/files';
import type { FileNode, ProjectSummary } from '../types';
import { EmptyState, IconButton } from './Common';
import { Icon } from './Icon';

interface PendingEntry {
  parentPath: string;
  type: 'file' | 'directory';
}

function TreeNode({
  node,
  depth,
  expanded,
  selectedPath,
  onToggle,
  onOpen,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  selectedPath?: string;
  onToggle(path: string): void;
  onOpen(node: FileNode): void;
  onSelect(path: string): void;
}) {
  const directory = node.type === 'directory';
  const isExpanded = expanded.has(node.path);
  const icon = directory
    ? isExpanded ? 'folderOpen' : 'folder'
    : fileIconName(node.path);

  return (
    <div className="tree-branch">
      <button
        aria-expanded={directory ? isExpanded : undefined}
        className={`tree-row ${selectedPath === node.path ? 'selected' : ''}`}
        onClick={() => {
          onSelect(node.path);
          if (directory) onToggle(node.path);
          else onOpen(node);
        }}
        onDoubleClick={() => !directory && onOpen(node)}
        role="treeitem"
        style={{ '--tree-depth': depth } as React.CSSProperties}
        title={node.path}
        type="button"
      >
        <span className="tree-indent" />
        <span className={`tree-chevron ${directory ? '' : 'hidden'}`}>
          <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={12} />
        </span>
        <Icon className={`file-icon file-icon-${icon}`} name={icon} size={15} />
        <span className="tree-label">{node.name}</span>
        {node.gitStatus && node.gitStatus !== 'ignored' && (
          <span className={`git-decoration git-${node.gitStatus}`}>
            {node.gitStatus === 'modified' ? 'M' : node.gitStatus === 'added' ? 'A' : node.gitStatus === 'deleted' ? 'D' : 'U'}
          </span>
        )}
      </button>
      {directory && isExpanded && node.children?.map((child) => (
        <TreeNode
          depth={depth + 1}
          expanded={expanded}
          key={child.path}
          node={child}
          onOpen={onOpen}
          onSelect={onSelect}
          onToggle={onToggle}
          selectedPath={selectedPath}
        />
      ))}
    </div>
  );
}

export function ExplorerPanel({
  project,
  tree,
  loading,
  selectedPath,
  onSelectedPathChange,
  onOpenFile,
  onRefresh,
  onCreate,
  onReveal,
  onRename,
  onDelete,
  onOpenBackups,
}: {
  project: ProjectSummary;
  tree: FileNode[];
  loading: boolean;
  selectedPath?: string;
  onSelectedPathChange(path: string): void;
  onOpenFile(node: FileNode): void;
  onRefresh(): void;
  onCreate(path: string, type: 'file' | 'directory'): Promise<void>;
  onReveal(path: string): void;
  onRename(path: string, name: string): Promise<void>;
  onDelete(path: string): Promise<void>;
  onOpenBackups(): void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingEntry, setPendingEntry] = useState<PendingEntry | null>(null);
  const [entryName, setEntryName] = useState('');
  const [entryError, setEntryError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pendingEntry) requestAnimationFrame(() => inputRef.current?.focus());
  }, [pendingEntry]);

  const selectedNode = useMemo(() => {
    function find(nodes: FileNode[]): FileNode | undefined {
      for (const node of nodes) {
        if (node.path === selectedPath) return node;
        const nested = node.children && find(node.children);
        if (nested) return nested;
      }
      return undefined;
    }
    return find(tree);
  }, [selectedPath, tree]);

  function beginCreate(type: 'file' | 'directory') {
    const parentPath = selectedNode?.type === 'directory'
      ? selectedNode.path
      : selectedNode
        ? dirname(selectedNode.path)
        : '';
    setExpanded((current) => new Set(current).add(parentPath));
    setEntryName('');
    setEntryError('');
    setPendingEntry({ parentPath, type });
  }

  async function commitCreate() {
    if (!pendingEntry || !entryName.trim()) {
      setPendingEntry(null);
      return;
    }
    if (/[\\/]/.test(entryName.trim())) {
      setEntryError('名称不能包含路径分隔符');
      return;
    }
    try {
      await onCreate(joinPath(pendingEntry.parentPath, entryName.trim()), pendingEntry.type);
      setPendingEntry(null);
    } catch (error) {
      setEntryError(error instanceof Error ? error.message : '创建失败');
    }
  }

  async function renameSelected() {
    if (!selectedNode) return;
    const next = window.prompt('输入新名称', basename(selectedNode.path));
    if (next?.trim() && !/[\\/]/.test(next.trim())) await onRename(selectedNode.path, next.trim());
  }

  async function deleteSelected() {
    if (!selectedNode) return;
    const confirmed = window.confirm(`确定要删除“${selectedNode.name}”吗？此操作会移入系统废纸篓（如平台支持）。`);
    if (confirmed) await onDelete(selectedNode.path);
  }

  return (
    <aside className="side-panel explorer-panel">
      <header className="side-panel-header">
        <div>
          <span className="side-panel-kicker">项目</span>
          <h2 title={project.path}>{project.name}</h2>
        </div>
        <div className="panel-actions">
          <IconButton icon="history" label="快照与备份" onClick={onOpenBackups} />
          <IconButton icon="filePlus" label="新建文件" onClick={() => beginCreate('file')} />
          <IconButton icon="folderPlus" label="新建文件夹" onClick={() => beginCreate('directory')} />
          <IconButton icon="refresh" label="刷新项目树" onClick={onRefresh} />
        </div>
      </header>

      <div className="project-root-row">
        <span><Icon name="chevronDown" size={12} /><strong>{project.name.toUpperCase()}</strong></span>
      </div>

      <div className="file-tree" role="tree">
        {pendingEntry && (
          <div className="new-tree-entry" style={{ '--tree-depth': 0 } as React.CSSProperties}>
            <span className="tree-indent" /><span className="tree-chevron hidden" />
            <Icon name={pendingEntry.type === 'directory' ? 'folder' : fileIconName(entryName)} size={15} />
            <input
              aria-label={pendingEntry.type === 'directory' ? '新文件夹名称' : '新文件名称'}
              onBlur={commitCreate}
              onChange={(event) => { setEntryName(event.target.value); setEntryError(''); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitCreate();
                if (event.key === 'Escape') setPendingEntry(null);
              }}
              ref={inputRef}
              value={entryName}
            />
            {pendingEntry.parentPath && <span className="new-entry-parent" title={pendingEntry.parentPath}>in {basename(pendingEntry.parentPath)}</span>}
          </div>
        )}
        {entryError && <div className="tree-inline-error">{entryError}</div>}
        {loading ? (
          <div className="tree-skeleton" aria-label="正在加载项目文件">
            <span /><span /><span /><span /><span />
          </div>
        ) : tree.length ? (
          tree.map((node) => (
            <TreeNode
              depth={0}
              expanded={expanded}
              key={node.path}
              node={node}
              onOpen={onOpenFile}
              onSelect={onSelectedPathChange}
              onToggle={(path) => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path); else next.add(path);
                return next;
              })}
              selectedPath={selectedPath}
            />
          ))
        ) : (
          <EmptyState compact icon="folder" title="项目为空">
            使用上方的新建按钮添加第一个文件。
          </EmptyState>
        )}
      </div>

      {selectedNode && (
        <div className="explorer-selection-actions">
          <span title={selectedNode.path}>{relativePath(selectedNode.path, project.path)}</span>
          <div>
            <IconButton icon="edit" label="重命名" onClick={renameSelected} />
            <IconButton icon="external" label="在文件管理器中显示" onClick={() => onReveal(selectedNode.path)} />
            <IconButton className="danger-hover" icon="trash" label="删除" onClick={deleteSelected} />
          </div>
        </div>
      )}
    </aside>
  );
}
