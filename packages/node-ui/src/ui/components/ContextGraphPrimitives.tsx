import React from 'react';
import type { ReactNode } from 'react';

type ContextGraphLayer = 'wm' | 'swm' | 'vm';

export type EmptyStateTone = 'neutral' | ContextGraphLayer | 'danger' | 'query';

type EmptyStateAction = {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
};

const EMPTY_STATE_ACCENTS: Record<EmptyStateTone, string> = {
  neutral: 'var(--border-strong)',
  wm: 'var(--layer-working, #64748b)',
  swm: 'var(--layer-shared, #f59e0b)',
  vm: 'var(--layer-verified, #22c55e)',
  danger: 'var(--text-danger)',
  query: '#38bdf8',
};

export function toneForLayer(layer: ContextGraphLayer): EmptyStateTone {
  return layer;
}

export function EmptyState({
  icon,
  title,
  description,
  actions = [],
  tone = 'neutral',
  compact = false,
  inline = false,
  className = '',
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: EmptyStateAction[];
  tone?: EmptyStateTone;
  compact?: boolean;
  inline?: boolean;
  className?: string;
}) {
  const style = {
    '--v10-empty-accent': EMPTY_STATE_ACCENTS[tone],
  } as React.CSSProperties;

  return (
    <div
      className={[
        'v10-empty-state',
        compact ? 'compact' : '',
        inline ? 'inline' : '',
        className,
      ].filter(Boolean).join(' ')}
      data-tone={tone}
      style={style}
    >
      {icon && <div className="v10-empty-state-icon" aria-hidden="true">{icon}</div>}
      <div className="v10-empty-state-copy">
        <div className="v10-empty-state-title">{title}</div>
        {description && <div className="v10-empty-state-desc">{description}</div>}
        {actions.length > 0 && (
          <div className="v10-empty-state-actions">
            {actions.map(action => (
              <button
                key={action.label}
                type="button"
                className={`v10-empty-state-action ${action.variant ?? 'secondary'}`}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export type StatStripItem = {
  id?: string;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
};

export function StatStrip({
  items,
  layer,
  compact = false,
  className = '',
}: {
  items: StatStripItem[];
  layer?: ContextGraphLayer;
  compact?: boolean;
  className?: string;
}) {
  const style = layer
    ? ({ '--v10-stat-accent': EMPTY_STATE_ACCENTS[layer] } as React.CSSProperties)
    : undefined;

  return (
    <div
      className={['v10-stat-strip', compact ? 'compact' : '', className].filter(Boolean).join(' ')}
      data-layer={layer}
      style={style}
    >
      {items.map((item, index) => (
        <div key={item.id ?? index} className="v10-stat-strip-cell">
          <span className="v10-stat-strip-label">{item.label}</span>
          <span className="v10-stat-strip-value">{item.value}</span>
          {item.hint && <span className="v10-stat-strip-hint">{item.hint}</span>}
        </div>
      ))}
    </div>
  );
}
