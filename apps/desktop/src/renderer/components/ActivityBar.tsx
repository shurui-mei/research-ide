import type { ActivityView } from '../types';
import { Icon, type IconName } from './Icon';

const activities: Array<{ id: ActivityView; icon: IconName; label: string }> = [
  { id: 'explorer', icon: 'files', label: '项目' },
  { id: 'literature', icon: 'book', label: '文献' },
  { id: 'toolchains', icon: 'tools', label: '工具链' },
  { id: 'codex', icon: 'sparkles', label: 'Codex' },
];

export function ActivityBar({
  active,
  onChange,
  codexAttention = false,
  onSettings,
}: {
  active: ActivityView;
  onChange(view: ActivityView): void;
  codexAttention?: boolean;
  onSettings(): void;
}) {
  return (
    <nav aria-label="工作台活动" className="activity-bar">
      <div className="activity-primary">
        {activities.map((activity) => (
          <button
            aria-current={active === activity.id ? 'page' : undefined}
            className={`activity-button ${active === activity.id ? 'active' : ''}`}
            key={activity.id}
            onClick={() => onChange(activity.id)}
            title={activity.label}
            type="button"
          >
            <Icon name={activity.icon} size={21} />
            <span className="sr-only">{activity.label}</span>
            {activity.id === 'codex' && codexAttention && <span className="activity-attention" />}
          </button>
        ))}
      </div>
      <div className="activity-secondary">
        <button className="activity-button" onClick={onSettings} title="设置" type="button">
          <Icon name="settings" size={20} />
          <span className="sr-only">设置</span>
        </button>
      </div>
    </nav>
  );
}
