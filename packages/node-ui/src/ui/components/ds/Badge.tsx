/**
 * Badge and Count — the read-only pills of the node UI (see DESIGN.md).
 *
 * A pill states a fact about something: role, type, layer, count. A status
 * (success, warning, danger) is an icon and text with no box, as in nOS, so it
 * never reads as a layer.
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

const LAYER_TONES = ['wm', 'swm', 'vm'] as const;
type LayerTone = (typeof LAYER_TONES)[number];
const isLayerTone = (tone: BadgeTone): tone is LayerTone => (LAYER_TONES as readonly string[]).includes(tone);

/** The memory-layer glyphs, the same shapes nOS draws: open circle, two circles, filled hexagon. */
export const LayerGlyph: React.FC<{ layer: LayerTone; className?: string }> = ({ layer, className }) => (
  <svg className={cx('ds-layer-glyph', className)} viewBox="0 0 14 14" fill="none" aria-hidden="true">
    {layer === 'wm' ? <circle cx="7" cy="7" r="5" stroke="var(--layer-working)" strokeWidth="1.5" /> : null}
    {layer === 'swm' ? (
      <>
        <circle cx="5.4" cy="7" r="4.2" stroke="var(--layer-shared)" strokeWidth="1.4" />
        <circle cx="8.6" cy="7" r="4.2" stroke="var(--layer-shared)" strokeWidth="1.4" />
      </>
    ) : null}
    {layer === 'vm' ? <path d="M7 1.2l5 2.9v5.8l-5 2.9-5-2.9V4.1l5-2.9z" fill="var(--layer-verified)" /> : null}
  </svg>
);

export const Badge: React.FC<BadgeProps> = ({ tone = 'neutral', size = 'md', icon, dot, kindColor, className, style, children, ...rest }) => (
  <span
    className={cx('ds-badge', `ds-tone-${tone}`, size === 'sm' && 'ds-sm', className)}
    style={kindColor ? { ...style, ['--badge-kind' as string]: kindColor } : style}
    {...rest}
  >
    {tone === 'kind' && kindColor ? <span className="ds-badge-kind-dot" aria-hidden="true" /> : null}
    {dot ? <span className="ds-badge-dot" aria-hidden="true" /> : null}
    {icon != null ? <span className="ds-badge-icon" aria-hidden="true">{icon}</span> : null}
    {icon == null && isLayerTone(tone) ? <LayerGlyph layer={tone} /> : null}
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

/** Layer badge labels: the one way to say which memory layer something is in. */
export const LAYER_BADGE: Record<'wm' | 'swm' | 'vm', { label: string }> = {
  wm: { label: 'Working' },
  swm: { label: 'Shared' },
  vm: { label: 'Verifiable' },
};

export const LayerBadge: React.FC<Omit<BadgeProps, 'tone' | 'icon'> & { layer: 'wm' | 'swm' | 'vm'; label?: React.ReactNode }> = ({ layer, label, ...rest }) => (
  <Badge tone={layer} {...rest}>{label ?? LAYER_BADGE[layer].label}</Badge>
);
