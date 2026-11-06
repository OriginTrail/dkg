/**
 * Operation-type colours (Observability, Transactions, node log).
 *
 * Labels say which layer an operation writes to, nothing more:
 *   - writes to Verified Memory (publish family)  → VM purple
 *   - writes to Shared Working Memory              → SWM cyan
 *   - everything else (reads, network, system)     → neutral
 * The name is always spelled out, so colour doesn't have to tell the
 * 15 types apart.
 *
 * Charts are different: series need telling apart, so they take the
 * data palette (--data-1 … --data-8) in the order the types appear,
 * the same order in every chart on the page.
 */
export type OpTone = 'vm' | 'swm' | 'neutral';

const OP_TONE: Record<string, OpTone> = {
  publish: 'vm',
  publishFromSWM: 'vm',
  update: 'vm',
  'ka-update': 'vm',
  workspace: 'swm',
  share: 'swm',
};

export function opTone(name: string | undefined): OpTone {
  return (name && OP_TONE[name]) || 'neutral';
}

const TEXT: Record<OpTone, string> = {
  vm: 'var(--layer-verified-text)',
  swm: 'var(--layer-shared-text)',
  neutral: 'var(--text-secondary)',
};
const BG: Record<OpTone, string> = {
  vm: 'var(--layer-verified-bg)',
  swm: 'var(--layer-shared-bg)',
  neutral: 'var(--bg-elevated)',
};
const RULE: Record<OpTone, string> = {
  vm: 'var(--layer-verified)',
  swm: 'var(--layer-shared)',
  neutral: 'var(--border-strong)',
};

/** Text colour for an operation name. */
export const opTypeText = (name: string | undefined) => TEXT[opTone(name)];
/** Badge fill behind an operation name. */
export const opTypeBg = (name: string | undefined) => BG[opTone(name)];
/** Accent rule (e.g. the left edge of a per-type card). */
export const opTypeRule = (name: string | undefined) => RULE[opTone(name)];

/** --data-1 … --data-8 per theme; matches 00-theme.css (graph-palette.test.ts
 *  checks). Canvas code reads these through graph-palette; DOM and SVG use
 *  the CSS variables. */
export const DATA_HEX: Record<'dark' | 'light', readonly string[]> = {
  dark: ['#1a81ff', '#a69300', '#ec2890', '#c98500', '#e200d0', '#ac6800', '#00a1df', '#00a309'],
  light: ['#1f6fd1', '#8a7a00', '#a3195b', '#c28a00', '#b5179e', '#9a5b1e', '#0284c7', '#008300'],
};

/** Chart series colour: the type's position in `types`, as a data slot.
 *  SVG presentation attributes resolve CSS variables, so this follows the theme. */
export function opChartColor(type: string, types: readonly string[]): string {
  const idx = types.indexOf(type);
  return `var(--data-${((idx < 0 ? 0 : idx) % 8) + 1})`;
}
