import { useCallback, useEffect, useState } from 'react';
import type { LibreOfficeExecutableStatus } from '../../shared/types';
import type { ProjectSummary } from '../types';
import { Badge, Modal } from './Common';
import { Icon } from './Icon';

type SettingsView = 'general' | 'tools';

export function SettingsDialog({ project, onClose, onReveal }: { project: ProjectSummary | null; onClose(): void; onReveal(path: string): void }) {
  const [view, setView] = useState<SettingsView>('general');
  const [libreOffice, setLibreOffice] = useState<LibreOfficeExecutableStatus>();
  const [libreOfficeBusy, setLibreOfficeBusy] = useState(false);
  const [libreOfficeError, setLibreOfficeError] = useState('');
  const api = window.researchIDE;

  const refreshLibreOffice = useCallback(async () => {
    if (!api) return;
    try { setLibreOffice(await api.documents.libreOfficeStatus()); }
    catch (error) { setLibreOfficeError(error instanceof Error ? error.message : '无法读取 LibreOffice 设置'); }
  }, [api]);

  useEffect(() => { void refreshLibreOffice(); }, [refreshLibreOffice]);

  async function chooseLibreOffice() {
    if (!api || libreOfficeBusy) return;
    setLibreOfficeBusy(true);
    setLibreOfficeError('');
    try { setLibreOffice(await api.documents.selectLibreOffice()); }
    catch (error) { setLibreOfficeError(error instanceof Error ? error.message : '无法保存 LibreOffice 选择'); }
    finally { setLibreOfficeBusy(false); }
  }

  async function clearLibreOffice() {
    if (!api || libreOfficeBusy) return;
    setLibreOfficeBusy(true);
    setLibreOfficeError('');
    try { setLibreOffice(await api.documents.clearLibreOffice()); }
    catch (error) { setLibreOfficeError(error instanceof Error ? error.message : '无法移除 LibreOffice 选择'); }
    finally { setLibreOfficeBusy(false); }
  }

  const libreOfficeDescription = libreOffice?.state === 'ready'
    ? libreOffice.source === 'custom' && libreOffice.sha256
      ? `${libreOffice.path} · SHA-256 ${libreOffice.sha256.slice(0, 12)}…`
      : `${libreOffice.path} · 已自动发现`
    : libreOffice?.state === 'invalid'
      ? libreOffice.detail ?? '已保存的可执行文件未通过复核，请重新选择。'
      : libreOffice?.detail ?? '正在检查 LibreOffice…';
  return (
    <Modal onClose={onClose} subtitle="管理当前项目与工具链。" title="Research IDE 设置" width="650px">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <button className={view === 'general' ? 'active' : ''} onClick={() => setView('general')} type="button"><Icon name="settings" size={15} />常规</button>
          <button className={view === 'tools' ? 'active' : ''} onClick={() => setView('tools')} type="button"><Icon name="tools" size={15} />工具链</button>
        </nav>
        <div className="settings-content">
          {view === 'general' && <>
            <section><header><h3>项目数据</h3><Badge tone="success">本地</Badge></header><p>项目配置、索引和版本快照保存在当前设备。</p><div className="setting-row"><span className="setting-icon"><Icon name="database" /></span><div><strong>项目元数据</strong><small>{project ? `${project.path}/.research_ide` : '打开项目后创建 .research_ide'}</small></div>{project && <button className="button secondary small" onClick={() => onReveal('')} type="button">显示项目</button>}</div></section>
            <section><header><h3>配置格式</h3></header><p>项目配置使用 TOML，并通过 JSON Schema 校验；无效配置不会静默应用。</p><code className="settings-code">.research_ide/project.toml<br />.research_ide/project.schema.json</code></section>
          </>}
          {view === 'tools' && <section>
            <header><h3>系统工具与项目选择</h3><Badge tone="blue">项目级</Badge></header>
            <p>Research IDE 会检测 PATH 中的 LaTeX、Python、R、Pandoc 和编译器，也可在工具链面板选择项目使用的版本。</p>
            <div className="setting-row"><span className="setting-icon"><Icon name="cpu" /></span><div><strong>运行环境管理</strong><small>从左侧活动栏打开“工具链”。</small></div></div>
            <div className={`setting-row libreoffice-setting ${libreOffice?.state === 'invalid' ? 'invalid' : ''}`}>
              <span className="setting-icon"><Icon name="doc" /></span>
              <div>
                <strong>旧版 Word 转换器</strong>
                <small title={libreOfficeDescription}>{libreOfficeDescription}</small>
              </div>
              <span className="setting-actions">
                <button className="button secondary small" disabled={libreOfficeBusy} onClick={() => void chooseLibreOffice()} type="button">{libreOfficeBusy ? '检查中…' : '选择…'}</button>
                {libreOffice?.source === 'custom' && <button className="button ghost small" disabled={libreOfficeBusy} onClick={() => void clearLibreOffice()} type="button">移除</button>}
              </span>
            </div>
            {libreOfficeError && <p className="setting-error" role="alert">{libreOfficeError}</p>}
            <p>只选择可信的 soffice、libreoffice 或便携版可执行文件。确认记录仅保存在应用数据目录；文件更新后必须重新确认。</p>
          </section>}
        </div>
      </div>
      <footer className="modal-actions"><button className="button primary" onClick={onClose} type="button">完成</button></footer>
    </Modal>
  );
}
