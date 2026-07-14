import { fileIconName, relativePath } from '../lib/files';
import type { EditorTab, ProjectSummary } from '../types';
import { EmptyState, IconButton, Spinner } from './Common';
import { DocxNotice } from './DocxNotice';
import { Icon } from './Icon';
import { PdfPreview } from './PdfPreview';
import { RichTextEditor } from './RichTextEditor';
import { TextEditor } from './TextEditor';

export function EditorArea({
  project,
  tabs,
  activeTabId,
  compiling,
  onActivateTab,
  onCloseTab,
  onTextChange,
  onDocumentChange,
  onCursorChange,
  onSave,
  onCompileLatex,
  onReveal,
  onOpenProjectFile,
}: {
  project: ProjectSummary;
  tabs: EditorTab[];
  activeTabId: string;
  compiling: boolean;
  onActivateTab(id: string): void;
  onCloseTab(id: string): void;
  onTextChange(id: string, value: string): void;
  onDocumentChange(id: string, value: Record<string, unknown>): void;
  onCursorChange(id: string, line: number, column: number): void;
  onSave(id: string): void;
  onCompileLatex(tab: EditorTab): void;
  onReveal(path: string): void;
  onOpenProjectFile(): void;
}) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const crumbs = activeTab ? relativePath(activeTab.path, project.path).split('/') : [];

  return (
    <section className="editor-area">
      <div className="editor-tabs-row">
        <div className="editor-tabs" role="tablist" aria-label="打开的编辑器">
          {tabs.map((tab) => (
            <div
              className={`editor-tab ${activeTabId === tab.id ? 'active' : ''}`}
              key={tab.id}
              onAuxClick={(event) => event.button === 1 && onCloseTab(tab.id)}
              title={tab.path}
            >
              <button aria-selected={activeTabId === tab.id} className="tab-activate" onClick={() => onActivateTab(tab.id)} role="tab" type="button">
                <Icon className={`file-icon file-icon-${fileIconName(tab.path)}`} name={fileIconName(tab.path)} size={14} />
                <span>{tab.name}</span>
                {tab.dirty && <i className="dirty-dot" title="未保存" />}
              </button>
              <button
                aria-label={`关闭 ${tab.name}`}
                className="tab-close"
                onClick={() => onCloseTab(tab.id)}
                type="button"
              ><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
      </div>

      {activeTab ? (
        <>
          <div className="editor-toolbar">
            <div className="breadcrumbs">
              <Icon name="folder" size={13} />
              {crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}>{index > 0 && <Icon name="chevronRight" size={10} />}<span>{crumb}</span></span>)}
              {activeTab.dirty && <em>已修改</em>}
            </div>
            <div className="file-actions">
              {activeTab.language === 'latex' && (
                <button className="button compile-button" disabled={compiling || activeTab.loading} onClick={() => onCompileLatex(activeTab)} title="编译 LaTeX 并将输出写入 Output 面板" type="button">
                  {compiling ? <Spinner /> : <Icon name="play" size={13} />} {compiling ? '编译中' : '编译 LaTeX'}
                </button>
              )}
              {activeTab.kind !== 'pdf' && (
                <IconButton disabled={!activeTab.dirty || activeTab.loading || Boolean(activeTab.docxReadOnly)} icon="save" label={activeTab.docxReadOnly ? '此 Word 文档为只读' : '保存文件'} onClick={() => onSave(activeTab.id)} />
              )}
              {!activeTab.virtual && <IconButton icon="external" label="在文件管理器中显示" onClick={() => onReveal(activeTab.path)} />}
            </div>
          </div>
          <div className="editor-content">
            {activeTab.loading ? (
              <div className="editor-state"><Spinner /><strong>正在打开 {activeTab.name}</strong></div>
            ) : activeTab.error ? (
              <EmptyState icon="error" title="无法打开文件">{activeTab.error}</EmptyState>
            ) : activeTab.kind === 'text' ? (
              <TextEditor
                language={activeTab.language ?? 'plaintext'}
                onChange={(value) => onTextChange(activeTab.id, value)}
                onCursorChange={(line, column) => onCursorChange(activeTab.id, line, column)}
                onSave={() => onSave(activeTab.id)}
                path={activeTab.path}
                reveal={activeTab.reveal}
                value={activeTab.content ?? ''}
              />
            ) : activeTab.kind === 'document' ? (
              <RichTextEditor content={activeTab.document ?? ''} key={activeTab.id} onChange={(value) => onDocumentChange(activeTab.id, value)} />
            ) : activeTab.kind === 'pdf' && activeTab.binary ? (
              <PdfPreview binary={activeTab.binary} onReveal={activeTab.virtual ? undefined : () => onReveal(activeTab.path)} path={activeTab.path} />
            ) : activeTab.kind === 'docx' ? (
              <div className="docx-editor-host">
                <DocxNotice onReveal={() => onReveal(activeTab.path)} path={activeTab.path} readOnly={Boolean(activeTab.docxReadOnly)} warnings={activeTab.docxWarnings ?? []} />
                <RichTextEditor content={activeTab.document ?? ''} editable={!activeTab.docxReadOnly} key={activeTab.id} onChange={(value) => onDocumentChange(activeTab.id, value)} />
              </div>
            ) : (
              <EmptyState icon="file" title="没有可用的预览器">可在文件管理器中打开此文件。</EmptyState>
            )}
          </div>
        </>
      ) : (
        <div className="editor-empty">
          <div className="editor-empty-mark"><Icon name="logo" size={42} /></div>
          <h2>{project.name}</h2>
          <p>从项目树打开文件，或用快速打开搜索项目。</p>
          <div className="editor-empty-actions">
            <button className="button secondary" onClick={onOpenProjectFile} type="button"><Icon name="search" size={15} />快速打开文件 <kbd>⌘P</kbd></button>
          </div>
          <div className="editor-capabilities"><span><Icon name="tex" />LaTeX & 代码</span><span><Icon name="doc" />DOC / DOCX 文档</span><span><Icon name="pdf" />PDF 预览</span></div>
        </div>
      )}
    </section>
  );
}
