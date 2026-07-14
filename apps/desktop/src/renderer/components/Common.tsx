import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function IconButton({
  icon,
  label,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      aria-label={label}
      className={`icon-button ${className}`}
      title={label}
      type="button"
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  compact = false,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      <div className="empty-state-icon"><Icon name={icon} size={compact ? 20 : 25} /></div>
      <strong>{title}</strong>
      {children && <div className="empty-state-copy">{children}</div>}
      {action}
    </div>
  );
}

export function Spinner({ label = '正在加载' }: { label?: string }) {
  return <span aria-label={label} className="spinner" role="status" />;
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  width = '520px',
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose(): void;
  width?: string;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        aria-labelledby="modal-title"
        aria-modal="true"
        className="modal-card"
        role="dialog"
        style={{ '--modal-width': width } as React.CSSProperties}
      >
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton icon="close" label="关闭" onClick={onClose} />
        </header>
        {children}
      </section>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'blue';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
