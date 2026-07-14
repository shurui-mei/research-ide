import type { BottomView, LogEntry, ProblemItem, ToolEvent } from '../types';
import { EmptyState, IconButton } from './Common';
import { Icon } from './Icon';

export function BottomPanel({
  visible,
  height,
  activeView,
  problems,
  output,
  logs,
  running,
  onViewChange,
  onToggle,
  onClearOutput,
  onClearLogs,
  onStop,
  onResizeStart,
  onOpenProblem,
}: {
  visible: boolean;
  height: number;
  activeView: BottomView;
  problems: ProblemItem[];
  output: ToolEvent[];
  logs: LogEntry[];
  running?: { runId: string; label: string };
  onViewChange(view: BottomView): void;
  onToggle(): void;
  onClearOutput(): void;
  onClearLogs(): void;
  onStop(): void;
  onResizeStart(event: React.PointerEvent): void;
  onOpenProblem(problem: ProblemItem): void;
}) {
  if (!visible) return null;
  const errorCount = problems.filter((problem) => problem.severity === 'error').length;
  const warningCount = problems.filter((problem) => problem.severity === 'warning').length;
  return (
    <section className="bottom-panel" style={{ height }}>
      <div aria-hidden="true" className="bottom-resizer" onPointerDown={onResizeStart} />
      <header className="bottom-panel-header">
        <div className="bottom-tabs" role="tablist">
          <button className={activeView === 'problems' ? 'active' : ''} onClick={() => onViewChange('problems')} role="tab" type="button">问题 <span>{problems.length}</span></button>
          <button className={activeView === 'output' ? 'active' : ''} onClick={() => onViewChange('output')} role="tab" type="button">输出{running && <i className="running-pulse" />}</button>
          <button className={activeView === 'logs' ? 'active' : ''} onClick={() => onViewChange('logs')} role="tab" type="button">日志</button>
        </div>
        <div className="bottom-actions">
          {activeView === 'problems' && <span className="problem-summary"><span><Icon name="error" size={12} />{errorCount}</span><span><Icon name="warning" size={12} />{warningCount}</span></span>}
          {running && <button className="running-command" onClick={onStop} type="button"><span className="spinner small" />{running.label}<Icon name="stop" size={12} /></button>}
          {activeView === 'output' && output.length > 0 && <IconButton icon="trash" label="清空输出" onClick={onClearOutput} />}
          {activeView === 'logs' && logs.length > 0 && <IconButton icon="trash" label="清空日志" onClick={onClearLogs} />}
          <IconButton icon="chevronDown" label="收起面板" onClick={onToggle} />
        </div>
      </header>
      <div className="bottom-panel-content">
        {activeView === 'problems' && (problems.length ? (
          <div className="problems-list">{problems.map((problem) => <button key={problem.id} onClick={() => onOpenProblem(problem)} type="button"><Icon className={`severity-${problem.severity}`} name={problem.severity === 'error' ? 'error' : problem.severity === 'warning' ? 'warning' : 'info'} size={13} /><span className="problem-message">{problem.message}</span>{problem.path && <span className="problem-location">{problem.path.split(/[\\/]/).at(-1)}{problem.line ? `:${problem.line}` : ''}</span>}<span className="problem-source">{problem.source}</span></button>)}</div>
        ) : <EmptyState compact icon="check" title="没有发现问题">编译器与语言服务的诊断会显示在这里。</EmptyState>)}
        {activeView === 'output' && (output.length ? (
          <pre className="output-console" aria-live="polite">{output.map((event, index) => <span className={`output-${event.type}`} key={`${event.runId}-${index}`}><i>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</i>{event.type === 'exit' ? `进程结束，退出码 ${event.exitCode ?? '—'}\n` : event.text}</span>)}</pre>
        ) : <EmptyState compact icon="terminal" title="还没有输出">编译与工具运行的 stdout / stderr 会实时显示在这里。</EmptyState>)}
        {activeView === 'logs' && (logs.length ? (
          <div className="log-list">{logs.map((entry) => <div className={`log-${entry.level}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time><span className="log-source">{entry.source || 'IDE'}</span><Icon name={entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : entry.level === 'success' ? 'check' : 'info'} size={12} /><span>{entry.message}</span></div>)}</div>
        ) : <EmptyState compact icon="info" title="日志为空">项目操作与安全事件会记录在这里。</EmptyState>)}
      </div>
    </section>
  );
}
