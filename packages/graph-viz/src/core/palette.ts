/**
 * Color palette system for the graph visualizer.
 *
 * A palette provides a complete, cohesive set of colors for the entire
 * visualization — surfaces, text, accents, semantic colors, and graph-specific
 * colors. Developers can use a built-in preset or supply a custom palette.
 */

export interface ColorPalette {
  name: string;

  // Surface
  background: string;
  surface: string;
  surfaceBorder: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;

  // Accent / brand
  primary: string;
  primaryMuted: string;

  // Semantic
  danger: string;
  warning: string;
  safe: string;
  info: string;

  // Graph-specific
  edgeColor: string;
  edgeLabel: string;
  particleColor: string;
  focalGlow: string;

  // Auto-assigned node type colors (cycled across uncolored types)
  nodeColors: string[];
}

// ── Built-in presets ──

export const PALETTE_DARK: ColorPalette = {
  name: 'dark',
  background: '#0a0a0f',
  surface: 'rgba(20, 20, 30, 0.95)',
  surfaceBorder: 'rgba(100, 100, 140, 0.3)',
  textPrimary: '#e2e8f0',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',
  primary: '#6366f1',
  primaryMuted: 'rgba(120, 120, 220, 0.5)',
  danger: '#e04040',
  warning: '#f59e0b',
  safe: '#10b981',
  info: '#3b82f6',
  edgeColor: '#1a1a3a',
  edgeLabel: '#94a3b8',
  particleColor: 'rgba(100, 160, 255, 0.5)',
  focalGlow: 'rgba(99, 102, 241, 0.3)',
  nodeColors: [
    '#6366f1', '#8b5cf6', '#a855f7', '#3b82f6',
    '#06b6d4', '#10b981', '#f59e0b', '#ef4444',
    '#ec4899', '#14b8a6', '#f97316', '#8b5cf6',
  ],
};

export const PALETTE_MIDNIGHT: ColorPalette = {
  name: 'midnight',
  background: '#050510',
  surface: 'rgba(10, 10, 25, 0.95)',
  surfaceBorder: 'rgba(60, 80, 160, 0.3)',
  textPrimary: '#c8d6e5',
  textSecondary: '#7f8fa6',
  textMuted: '#4a5568',
  primary: '#3b82f6',
  primaryMuted: 'rgba(59, 130, 246, 0.4)',
  danger: '#dc2626',
  warning: '#d97706',
  safe: '#059669',
  info: '#2563eb',
  edgeColor: '#0f1a3a',
  edgeLabel: '#7f8fa6',
  particleColor: 'rgba(59, 130, 246, 0.5)',
  focalGlow: 'rgba(59, 130, 246, 0.3)',
  nodeColors: [
    '#3b82f6', '#2563eb', '#1d4ed8', '#06b6d4',
    '#0891b2', '#0e7490', '#8b5cf6', '#7c3aed',
    '#6366f1', '#4f46e5', '#14b8a6', '#0d9488',
  ],
};

export const PALETTE_CYBERPUNK: ColorPalette = {
  name: 'cyberpunk',
  background: '#0a0a0a',
  surface: 'rgba(15, 15, 15, 0.95)',
  surfaceBorder: 'rgba(0, 255, 136, 0.2)',
  textPrimary: '#e0ffe0',
  textSecondary: '#80c080',
  textMuted: '#407040',
  primary: '#00ff88',
  primaryMuted: 'rgba(0, 255, 136, 0.3)',
  danger: '#ff2d6a',
  warning: '#ffaa00',
  safe: '#00ff88',
  info: '#00d4ff',
  edgeColor: '#0a1a0a',
  edgeLabel: '#80c080',
  particleColor: 'rgba(0, 255, 136, 0.5)',
  focalGlow: 'rgba(0, 255, 136, 0.3)',
  nodeColors: [
    '#00ff88', '#ff2d6a', '#00d4ff', '#ffaa00',
    '#ff6b35', '#a855f7', '#06ffd0', '#ff1493',
    '#39ff14', '#ff6ec7', '#00bfff', '#ffd700',
  ],
};

export const PALETTE_LIGHT: ColorPalette = {
  name: 'light',
  background: '#f8fafc',
  surface: 'rgba(255, 255, 255, 0.95)',
  surfaceBorder: 'rgba(148, 163, 184, 0.3)',
  textPrimary: '#1e293b',
  textSecondary: '#475569',
  textMuted: '#94a3b8',
  primary: '#4f46e5',
  primaryMuted: 'rgba(79, 70, 229, 0.3)',
  danger: '#dc2626',
  warning: '#d97706',
  safe: '#059669',
  info: '#2563eb',
  edgeColor: '#cbd5e1',
  edgeLabel: '#475569',
  particleColor: 'rgba(79, 70, 229, 0.4)',
  focalGlow: 'rgba(79, 70, 229, 0.2)',
  nodeColors: [
    '#4f46e5', '#7c3aed', '#9333ea', '#2563eb',
    '#0891b2', '#059669', '#d97706', '#dc2626',
    '#db2777', '#0d9488', '#ea580c', '#7c3aed',
  ],
};

/** All built-in palettes indexed by name */
export const PALETTES: Record<string, ColorPalette> = {
  dark: PALETTE_DARK,
  midnight: PALETTE_MIDNIGHT,
  cyberpunk: PALETTE_CYBERPUNK,
  light: PALETTE_LIGHT,
};

/**
 * Resolve a palette from a name string or custom object, with optional overrides.
 * Falls back to 'dark' if the name is not found.
 */
export function resolvePalette(
  palette?: string | ColorPalette,
  overrides?: Partial<ColorPalette>,
): ColorPalette {
  let base: ColorPalette;

  if (!palette) {
    base = PALETTE_DARK;
  } else if (typeof palette === 'string') {
    base = PALETTES[palette] ?? PALETTE_DARK;
  } else {
    base = palette;
  }

  if (!overrides) return base;

  return { ...base, ...overrides, name: overrides.name ?? base.name };
}

/**
 * Inject palette colors as CSS custom properties on a container element.
 * Demo UIs can reference these as var(--gv-primary), etc.
 */
export function injectPaletteCssVars(container: HTMLElement, palette: ColorPalette): void {
  const props: Record<string, string> = {
    '--gv-bg': palette.background,
    '--gv-surface': palette.surface,
    '--gv-surface-border': palette.surfaceBorder,
    '--gv-text': palette.textPrimary,
    '--gv-text-secondary': palette.textSecondary,
    '--gv-text-muted': palette.textMuted,
    '--gv-primary': palette.primary,
    '--gv-primary-muted': palette.primaryMuted,
    '--gv-danger': palette.danger,
    '--gv-warning': palette.warning,
    '--gv-safe': palette.safe,
    '--gv-info': palette.info,
    '--gv-edge': palette.edgeColor,
    '--gv-particle': palette.particleColor,
    '--gv-focal-glow': palette.focalGlow,
  };

  for (const [prop, value] of Object.entries(props)) {
    container.style.setProperty(prop, value);
  }
}
