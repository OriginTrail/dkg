/**
 * Canvas palette for the graph views, resolved from an explicit theme.
 *
 * graph-viz draws on a canvas and can't read CSS variables, so graph options
 * need hex values. Instead of colour records that read the DOM on property
 * access, option builders take a plain `GraphPalette` for a named theme.
 * Components get it with `useGraphPalette()` (hooks/useGraphPalette.ts, the
 * theme from the layout store), so graphs rebuild their options when the
 * theme changes. This module stays free of DOM and store access.
 *
 * The values mirror the tokens in styles/00-theme.css; graph-palette.test.ts
 * keeps them in step.
 */
import { LAYER_HEX, NEUTRAL_HEX, VM_ANCHOR_HEX, type LayerLevel } from './layer-colors.js';
import { DATA_HEX } from './op-type-colors.js';

export type Theme = 'dark' | 'light';

export interface GraphPalette {
  readonly theme: Theme;
  /** Memory layer hues (node / edge tints). */
  readonly layer: Readonly<Record<LayerLevel, string>>;
  /** Neutral greys for untyped nodes and edges. */
  readonly neutral: Readonly<{ node: string; edge: string }>;
  /** VM on-chain anchor fill and ring. */
  readonly anchor: Readonly<{ fill: string; ring: string }>;
  /** The data palette, slot 1 at index 0. */
  readonly data: readonly string[];
}

const PALETTES: Record<Theme, GraphPalette> = {
  dark: build('dark'),
  light: build('light'),
};

function build(theme: Theme): GraphPalette {
  return Object.freeze({
    theme,
    layer: Object.freeze({ ...LAYER_HEX[theme] }),
    neutral: Object.freeze({ ...NEUTRAL_HEX[theme] }),
    anchor: Object.freeze({ ...VM_ANCHOR_HEX[theme] }),
    data: Object.freeze([...DATA_HEX[theme]]),
  });
}

/** The palette for a theme. Same object for the same theme (safe as a memo dependency). */
export function graphPalette(theme: Theme): GraphPalette {
  return PALETTES[theme] ?? PALETTES.dark;
}

/** Data colour for a 1-based slot, wrapping like the CSS palette. */
export function dataSlotHex(palette: GraphPalette, slot: number): string {
  const n = palette.data.length;
  return palette.data[((slot - 1) % n + n) % n]!;
}

