import type { DocxCompatibilityWarning } from '../types';
import { Icon } from './Icon';

export function DocxNotice({
  path,
  warnings,
  readOnly,
  onReveal,
}: {
  path: string;
  warnings: DocxCompatibilityWarning[];
  readOnly: boolean;
  onReveal(): void;
}) {
  const format = path.toLowerCase().endsWith('.doc') ? 'DOC' : 'DOCX';
  const significant = warnings.filter((item) => item.severity !== 'info');
  const summary = readOnly
    ? '此文件包含无法安全保留的 Word 功能，当前为只读。'
    : significant.length
      ? `发现 ${significant.length} 项兼容性提醒；保存前会自动备份原文件。`
      : format === 'DOC'
        ? '正在编辑 DOC；保存时由本地兼容引擎写回，并自动备份原文件。'
        : '正在直接编辑 DOCX；保存前会自动备份原文件。';

  return (
    <details className={`docx-compatibility ${readOnly ? 'blocking' : significant.length ? 'warning' : 'info'}`}>
      <summary>
        <Icon name={readOnly || significant.length ? 'warning' : 'info'} size={14} />
        <span><strong>{path.split(/[\\/]/u).at(-1)}</strong> · {summary}</span>
        <span className="docx-compatibility-expand">详情</span>
      </summary>
      <div className="docx-compatibility-details">
        <ul>
          {warnings.map((item) => (
            <li className={item.severity} key={item.code}>
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </li>
          ))}
        </ul>
        <button className="button secondary" onClick={onReveal} type="button"><Icon name="external" size={14} />在文件管理器中显示</button>
      </div>
    </details>
  );
}
