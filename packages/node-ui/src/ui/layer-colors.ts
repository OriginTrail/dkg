/**
 * Memory-layer colours — the single TS source for WM / SWM / VM.
 *
 * DOM code should use the CSS custom properties (`LAYER_VAR`), which follow
 * the theme automatically. Canvas code (graph-viz node and edge tints) cannot
 * read CSS variables, so it uses `layerHex()`, which returns the value for
 * the theme that is active when it is called. Keep `LAYER_HEX` in step with
 * the `--layer-*` tokens in styles/00-theme.css.
 *
 * Hue rule (shared with nOS): WM slate, SWM OriginTrail cyan, VM OriginTrail
 * purple. Amber, green and red are signals only and never mean a layer.
 */
export type LayerLevel = 'working' | 'shared' | 'verified';
export type LayerKey = 'wm' | 'swm' | 'vm';

export const LAYER_VAR: Record<LayerLevel, string> = {
  working: 'var(--layer-working)',
  shared: 'var(--layer-shared)',
  verified: 'var(--layer-verified)',
};

export const LAYER_TEXT_VAR: Record<LayerLevel, string> = {
  working: 'var(--layer-working-text)',
  shared: 'var(--layer-shared-text)',
  verified: 'var(--layer-verified-text)',
};

export const LAYER_HEX: Record<'dark' | 'light', Record<LayerLevel, string>> = {
  dark: { working: '#94a3b8', shared: '#1aded7', verified: '#8b85f4' },
  light: { working: '#526173', shared: '#0f9c96', verified: '#6344df' },
};

export const KEY_TO_LEVEL: Record<LayerKey, LayerLevel> = {
  wm: 'working',
  swm: 'shared',
  vm: 'verified',
};

function activeTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

/** Hex for canvas renderers, resolved against the theme active right now. */
export function layerHex(level: LayerLevel): string {
  return LAYER_HEX[activeTheme()][level];
}

/** Neutral greys for canvas fallbacks: untyped nodes, default subgraph,
 *  graph edges. Pure grey on purpose; slate is WM's colour now (C15). */
export const NEUTRAL_HEX: Record<'dark' | 'light', { node: string; edge: string }> = {
  dark: { node: '#9a9a9a', edge: '#4d4d4d' },
  light: { node: '#6b6b6b', edge: '#a3a3a3' },
};

export function neutralHex(kind: 'node' | 'edge'): string {
  return NEUTRAL_HEX[activeTheme()][kind];
}

/** C10: on-chain anchor nodes in the VM graph. A very deep indigo, drawn
 *  flat (no gradient), with a purple ring (pale lavender in dark mode, the
 *  soft VM violet in light), so the anchor reads as a clearly darker node
 *  than the VM-purple assets around it without a new hue. */
export const VM_ANCHOR_HEX: Record<'dark' | 'light', { fill: string; ring: string }> = {
  dark: { fill: '#2f1d8c', ring: '#d9d0ff' },
  light: { fill: '#24127a', ring: '#8b85f4' },
};
export const VM_ANCHOR_RING_WIDTH = 4;

export function vmAnchorHex(part: 'fill' | 'ring'): string {
  return VM_ANCHOR_HEX[activeTheme()][part];
}
