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
