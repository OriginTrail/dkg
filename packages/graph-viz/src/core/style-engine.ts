import type { GraphNode, GraphEdge, StyleConfig } from './types.js';
import type { ColorPalette } from './palette.js';
import { PALETTE_DARK } from './palette.js';
import { PrefixManager } from './prefix-manager.js';

/** Auto-assigned namespace colors for common vocabularies */
const NAMESPACE_COLORS: Record<string, string> = {
  'https://schema.org/': '#8b5cf6',          // Purple for schema.org
  'http://www.w3.org/ns/prov#': '#3b82f6',   // Blue for PROV-O
  'http://xmlns.com/foaf/0.1/': '#10b981',   // Emerald for FOAF
  'http://purl.org/dc/terms/': '#f59e0b',    // Amber for Dublin Core
};

/**
 * Resolves colors for nodes and edges based on configurable rules.
 *
 * When a ColorPalette is provided, it drives default colors:
 * - defaultNodeColor → palette.primary
 * - defaultEdgeColor → palette.edgeColor
 * - Label/text colors → palette.textPrimary/textSecondary
 *
 * Priority (highest first):
 * 1. Per-class color (matching rdf:type)
 * 2. Per-namespace color (matching namespace of first rdf:type)
 * 3. Default color (from palette or config)
 */
export class StyleEngine {
  private _config: Required<StyleConfig>;
  private _prefixManager: PrefixManager;
  private _palette: ColorPalette;

  constructor(config: StyleConfig | undefined, prefixManager: PrefixManager, palette?: ColorPalette) {
    this._prefixManager = prefixManager;
    this._palette = palette ?? PALETTE_DARK;
    this._config = {
      classColors: config?.classColors ?? {},
      namespaceColors: config?.namespaceColors ?? {},
      predicateColors: config?.predicateColors ?? {},
      gradient: config?.gradient ?? true,
      gradientIntensity: config?.gradientIntensity ?? 0.3,
      defaultNodeColor: config?.defaultNodeColor ?? this._palette.primary,
      defaultEdgeColor: config?.defaultEdgeColor ?? this._palette.edgeColor,
      edgeWidth: config?.edgeWidth ?? 1.5,
      edgeArrowSize: config?.edgeArrowSize ?? 4,
      borderWidth: config?.borderWidth ?? 1.5,
      fontFamily: config?.fontFamily ?? 'system-ui, -apple-system, sans-serif',
      fontSize: config?.fontSize ?? 11,
    };
  }

  /** The active color palette */
  get palette(): ColorPalette {
    return this._palette;
  }

  /** Update the active palette (recalculates defaults not explicitly set in config) */
  setPalette(palette: ColorPalette): void {
    this._palette = palette;
    // Only override defaults that weren't explicitly set by the user
    this._config = { ...this._config };
    this._config.defaultNodeColor = palette.primary;
    this._config.defaultEdgeColor = palette.edgeColor;
  }

  /** Merge additional class colors (from ViewConfig nodeTypes) into the style config */
  setClassColors(colors: Record<string, string>): void {
    this._config = {
      ...this._config,
      classColors: { ...this._config.classColors, ...colors },
    };
  }

  get config(): Readonly<Required<StyleConfig>> {
    return this._config;
  }

  /** Get the fill color for a node */
  getNodeColor(node: GraphNode): string {
    // 1. Check per-class colors (user-supplied, using compact or full URIs)
    for (const type of node.types) {
      const compact = this._prefixManager.compact(type);
      if (compact && this._config.classColors[compact]) {
        return this._config.classColors[compact];
      }
      if (this._config.classColors[type]) {
        return this._config.classColors[type];
      }
      // Also check short name (last segment after # or /) against classColors keys
      // that are full URIs — match by short name suffix
      const shortName = type.split('#').pop()?.split('/').pop() ?? '';
      if (shortName) {
        for (const [key, color] of Object.entries(this._config.classColors)) {
          const keyShort = key.split('#').pop()?.split('/').pop() ?? '';
          if (keyShort === shortName) {
            return color;
          }
        }
      }
    }

    // 2. Check per-namespace colors (user-supplied first, then built-in)
    for (const type of node.types) {
      for (const [ns, color] of Object.entries(this._config.namespaceColors)) {
        const fullNs = this._prefixManager.getNamespace(ns) ?? ns;
        if (type.startsWith(fullNs)) return color;
      }
      // Built-in namespace colors
      for (const [ns, color] of Object.entries(NAMESPACE_COLORS)) {
        if (type.startsWith(ns)) return color;
      }
    }

    // 3. Default
    return this._config.defaultNodeColor;
  }

  /** Get the color for an edge */
  getEdgeColor(edge: GraphEdge): string {
    const compact = this._prefixManager.compact(edge.predicate);
    if (compact && this._config.predicateColors[compact]) {
      return this._config.predicateColors[compact];
    }
    if (this._config.predicateColors[edge.predicate]) {
      return this._config.predicateColors[edge.predicate];
    }
    return this._config.defaultEdgeColor;
  }

  /** Get border color (slightly lighter than fill) */
  getBorderColor(fillColor: string): string {
    return lightenHex(fillColor, 0.3);
  }

  /** Get gradient center color (lighter) */
  getGradientCenter(fillColor: string): string {
    return lightenHex(fillColor, this._config.gradientIntensity);
  }
}

/** Lighten a hex color by a factor (0.0 = no change, 1.0 = white) */
function lightenHex(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const r = Math.round(rgb.r + (255 - rgb.r) * factor);
  const g = Math.round(rgb.g + (255 - rgb.g) * factor);
  const b = Math.round(rgb.b + (255 - rgb.b) * factor);

  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}
