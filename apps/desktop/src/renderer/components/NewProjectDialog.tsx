import { useMemo, useState } from 'react';
import { Field, Modal } from './Common';
import { Icon } from './Icon';

type Template = 'blank' | 'latex' | 'paper';

const templates: Array<{
  id: Template;
  title: string;
  description: string;
  icon: 'folder' | 'tex' | 'book';
}> = [
  { id: 'blank', title: '空白项目', description: '从一个干净的项目目录开始', icon: 'folder' },
  { id: 'latex', title: 'LaTeX 项目', description: '包含 main.tex 与基础构建配置', icon: 'tex' },
  { id: 'paper', title: '论文工作区', description: '写作、文献目录与数据目录', icon: 'book' },
];

export function NewProjectDialog({
  onClose,
  onSelectDirectory,
  onCreate,
}: {
  onClose(): void;
  onSelectDirectory(): Promise<string | null>;
  onCreate(input: {
    name: string;
    parentPath: string;
    template: Template;
    initializeGit: boolean;
  }): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [template, setTemplate] = useState<Template>('paper');
  const [initializeGit, setInitializeGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const targetPath = useMemo(() => {
    if (!parentPath || !name.trim()) return '';
    const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/';
    return `${parentPath.replace(/[\\/]$/, '')}${separator}${name.trim()}`;
  }, [name, parentPath]);

  async function chooseDirectory() {
    const selected = await onSelectDirectory();
    if (selected) setParentPath(selected);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !parentPath) return;
    setBusy(true);
    setError('');
    try {
      await onCreate({ name: name.trim(), parentPath, template, initializeGit });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '项目创建失败');
      setBusy(false);
    }
  }

  return (
    <Modal
      onClose={busy ? () => undefined : onClose}
      subtitle="Research IDE 会在所选位置创建独立项目目录与 .research_ide 配置。"
      title="新建研究项目"
      width="620px"
    >
      <form className="new-project-form" onSubmit={submit}>
        <Field label="项目名称">
          <input
            autoFocus
            className="text-input"
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：graph-neural-networks"
            spellCheck={false}
            value={name}
          />
        </Field>

        <fieldset className="template-fieldset">
          <legend>项目模板</legend>
          <div className="template-grid">
            {templates.map((item) => (
              <label className={`template-option ${template === item.id ? 'selected' : ''}`} key={item.id}>
                <input
                  checked={template === item.id}
                  name="project-template"
                  onChange={() => setTemplate(item.id)}
                  type="radio"
                />
                <span className="template-icon"><Icon name={item.icon} /></span>
                <span><strong>{item.title}</strong><small>{item.description}</small></span>
                <span className="radio-mark" />
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="保存位置">
          <div className="path-picker">
            <input
              className="text-input"
              onChange={(event) => setParentPath(event.target.value)}
              placeholder="选择父文件夹"
              spellCheck={false}
              value={parentPath}
            />
            <button className="button secondary" onClick={chooseDirectory} type="button">
              <Icon name="folderOpen" size={16} /> 浏览…
            </button>
          </div>
          {targetPath && <span className="target-path">将创建：{targetPath}</span>}
        </Field>

        <label className="check-row">
          <input checked={initializeGit} onChange={(event) => setInitializeGit(event.target.checked)} type="checkbox" />
          <span><strong>初始化 Git 仓库</strong><small>用于本地版本历史；备份快照仍由 .research_ide 独立管理。</small></span>
        </label>

        {error && <div className="form-error"><Icon name="error" size={15} />{error}</div>}
        <footer className="modal-actions">
          <button className="button ghost" disabled={busy} onClick={onClose} type="button">取消</button>
          <button className="button primary" disabled={busy || !name.trim() || !parentPath} type="submit">
            {busy ? <span className="spinner small" /> : <Icon name="plus" size={16} />} 创建项目
          </button>
        </footer>
      </form>
    </Modal>
  );
}
