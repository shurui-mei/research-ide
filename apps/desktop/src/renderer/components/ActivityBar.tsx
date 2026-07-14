import type { ActivityView } from '../types';
import { Icon, type IconName } from './Icon';

const activities: Array<{ id: ActivityView; icon: IconName; label: string }> = [
  { id: 'explorer', icon: 'files', label: '文件管理器' },
  { id: 'literature', icon: 'book', label: '文献管理' },
  { id: 'toolchains', icon: 'tools', label: '工具箱' },
  { id: 'codex', icon: 'sparkles', label: 'Codex' },
];

export function ActivityBar({
  active,
  onChange,
  codexAttention = false,
  codexOpen = false,
  onSettings,
}: {
  active: ActivityView;
  onChange(view: ActivityView): void;
  codexAttention?: boolean;
  codexOpen?: boolean;
  onSettings(): void;
}) {
  return (
    <nav aria-label="主要功能" className="activity-bar">
      <div className="activity-primary">
        {activities.map((activity) => {
          const isCodex = activity.id === 'codex';
          const isActive = isCodex ? codexOpen : active === activity.id;
          return (
            <button
              aria-controls={isCodex ? 'codex-right-panel' : undefined}
              aria-current={!isCodex && isActive ? 'page' : undefined}
              aria-expanded={isCodex ? codexOpen : undefined}
              aria-label={isCodex && codexOpen ? '收起 Codex' : activity.label}
              aria-pressed={isCodex ? codexOpen : undefined}
              className={`activity-button ${isActive ? 'active' : ''}`}
              key={activity.id}
              onClick={() => onChange(activity.id)}
              title={isCodex && codexOpen ? '收起 Codex' : activity.label}
              type="button"
            >
              <Icon name={activity.icon} size={21} />
              <span className="activity-label">{activity.label}</span>
              {isCodex && codexAttention && <span className="activity-attention" />}
            </button>
          );
        })}
      </div>
      <div className="activity-secondary">
        <button aria-label="设置" className="activity-button" onClick={onSettings} title="设置" type="button">
          <Icon name="settings" size={20} />
          <span className="activity-label">设置</span>
        </button>
      </div>
    </nav>
  );
}
