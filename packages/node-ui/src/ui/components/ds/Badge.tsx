/**
 * Badge and Count — the read-only pills of the node UI (see DESIGN.md).
 *
 * A pill states a fact about something: status, role, type, layer, count.
 * It is never the click target; things you can open use a chip with a mark
 * (AgentChip, context graph chip), things you can do use a Button.
 *
 * Sizes: `md` (22px, 11px text) by default; `sm` (18px, 10px) in dense rows
 * and tables. Text is sentence case; pass the words as they should read.
 */
import React from 'react';

export type BadgeTone =
  | 'neutral' | 'muted'
  | 'success' | 'warning' | 'danger'
  | 'wm' | 'swm' | 'vm'
  | 'role'
  | 'kind';

export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'color'> {
  tone?: BadgeTone;
  size?: 'sm' | 'md';
  /** Leading glyph (e.g. a layer symbol). */
  icon?: React.ReactNode;
  /** Leading dot in the text colour (status at a glance). */
  dot?: boolean;
  /** For tone="kind": the kind's colour, shown as a leading dot. */
  kindColor?: string;
}

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export const Badge: React.FC<BadgeProps> = ({ tone = 'neutral', size = 'md', icon, dot, kindColor, className, style, children, ...rest }) => (
  <span
    className={cx('ds-badge', `ds-tone-${tone}`, size === 'sm' && 'ds-sm', className)}
    style={kindColor ? { ...style, ['--badge-kind' as string]: kindColor } : style}
    {...rest}
  >
    {tone === 'kind' && kindColor ? <span className="ds-badge-kind-dot" aria-hidden="true" /> : null}
    {dot ? <span className="ds-badge-dot" aria-hidden="true" /> : null}
    {icon != null ? <span className="ds-badge-icon" aria-hidden="true">{icon}</span> : null}
    {children}
  </span>
);

export interface CountProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: React.ReactNode;
  /** `attention` = needs your action (amber). `quiet` = no chrome, e.g. inside a tab. */
  tone?: 'neutral' | 'attention' | 'quiet';
}

export const Count: React.FC<CountProps> = ({ value, tone = 'neutral', className, ...rest }) => (
  <span className={cx('ds-count', tone !== 'neutral' && `ds-tone-${tone}`, className)} {...rest}>{value}</span>
);

/** Layer badge presets: the one way to say which memory layer something is in. */
export const LAYER_BADGE: Record<'wm' | 'swm' | 'vm', { icon: string; label: string }> = {
  wm: { icon: '◇', label: 'Working' },
  swm: { icon: '◈', label: 'Shared' },
  vm: { icon: '◉', label: 'Verifiable' },
};

export const LayerBadge: React.FC<Omit<BadgeProps, 'tone' | 'icon'> & { layer: 'wm' | 'swm' | 'vm'; label?: React.ReactNode }> = ({ layer, label, ...rest }) => (
  <Badge tone={layer} icon={LAYER_BADGE[layer].icon} {...rest}>{label ?? LAYER_BADGE[layer].label}</Badge>
);
