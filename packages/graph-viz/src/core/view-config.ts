import type { GraphNode } from './types.js';
import type { GraphModel } from './graph-model.js';
import type { ColorPalette } from './palette.js';
import type { TemporalConfig } from './temporal-filter.js';

// --- Namespace resolution helpers ---

const KNOWN_NAMESPACES = [
  'https://guardiankg.org/vocab/',
  'https://umanitek.ai/dkg/vocab/',
  'http://umanitek.ai/dkg/vocab/',
  'https://schema.org/',
  'http://schema.org/',
];

/** Get a property value checking all known namespace variants */
function getAnyNS(node: GraphNode, shortName: string): string | null {
  for (const ns of KNOWN_NAMESPACES) {
    const vals = node.properties?.get(ns + shortName);
    if (vals && vals.length > 0) return vals[0].value;
  }
  return null;
}

// --- ViewConfig Type ---

/** Visual configuration for a single node type */
export interface NodeTypeConfig {
  color?: string;
  shape?: 'hexagon' | 'circle';
  /** Icon URL or data URI — assigned as imageUrl on matching nodes */
  icon?: string;
  /** Static size multiplier for all nodes of this type */
  sizeMultiplier?: number;
}

/** Focal entity configuration */
export interface FocalConfig {
  /** URI of the focal entity (checked across namespace variants) */
  uri: string;
  /** Image URL for the focal entity */
  image?: string;
  /** Size multiplier (default 1.5) */
  sizeMultiplier?: number;
}

/** Highlight / risk rule configuration */
export interface HighlightConfig {
  /** Property short name that drives visual emphasis (checked across namespaces) */
  property: string;
  /** Where to find the property: on the node itself, or on a linked entity */
  source?: 'self' | 'linked';
  /** Predicate short name to follow when source='linked' (e.g., 'hasSentiment') */
  linkedVia?: string;
  /** Absolute value above this threshold = highlighted */
  threshold: number;
  /** Border color for highlighted nodes */
  color: string;
  /** How many top-scoring nodes get the size boost (default 100) */
  topN?: number;
  /**
   * Size multiplier for top-N nodes.
   * If sizeMin/sizeMax are set, this is ignored (continuous scaling is used).
   * Otherwise this is a flat multiplier applied to all top-N nodes (default 2).
   */
  sizeMultiplier?: number;
  /** Minimum sizeMultiplier for continuous scaling (lowest-risk in top N). Default: 1.0 */
  sizeMin?: number;
  /** Maximum sizeMultiplier for continuous scaling (highest-risk in top N). Default: 3.0 */
  sizeMax?: number;
  /**
   * Invert the scoring: treat LOW values as high risk.
   * Useful when the property represents a "safety" signal (e.g., sentimentScore)
   * where 0.0 = dangerous and 1.0 = safe.
   * Default: false
   */
  invert?: boolean;
}

/** Size-by rule: scale node size based on a property */
export interface SizeByConfig {
  /** Property short name (e.g., 'totalInteractions') */
  property: string;
  /** Scale function (default 'log') */
  scale?: 'linear' | 'log';
}

/** Icon mapping: assign icons to posts by platform edge */
export interface PlatformIconConfig {
  /** Map of platform ID (last path segment of platform URI) to icon URL/data URI */
  icons: Record<string, string>;
  /** URL fallback patterns: map of URL substring to platform key */
  urlFallbacks?: Record<string, string>;
}

/** Configuration for a single tooltip field */
export interface TooltipFieldConfig {
  /** Display label in the tooltip */
  label: string;
  /** Property short name to display (checked across known namespaces) */
  property: string;
  /** Where to find the property: directly on the node ('self') or on a linked entity */
  source?: 'self' | 'linked';
  /** Predicate short name to follow when source='linked' */
  linkedVia?: string;
  /** Display format: 'text' (default), 'number', 'date' */
  format?: 'text' | 'number' | 'date';
}

/** Tooltip configuration */
export interface TooltipConfig {
  /**
   * Properties to try for the tooltip title, in priority order.
   * Each entry is a short name checked across known namespaces.
   * Falls back to the node's resolved label if none match.
   *
   * @example ["text", "name", "title"]
   */
  titleProperties?: string[];

  /**
   * Template for the tooltip subtitle line.
   * Supports {property} placeholders (short names).
   * Special tokens: {platform}, {author}, {date}, {type}
   *
   * @example "{platform} · {author} · {date}"
   */
  subtitleTemplate?: string;

  /** Max characters for the title before truncation. Default: 60 */
  titleMaxLength?: number;

  /** Additional fields to show in the tooltip */
  fields?: TooltipFieldConfig[];
}

/** Animation configuration for visual liveliness */
export interface AnimationConfig {
  /** Enable link particles flowing along edges. Default: false */
  linkParticles?: boolean;
  /** Number of particles per link. Default: 1 */
  linkParticleCount?: number;
  /** Particle speed (0-1 range, fraction of link length per frame). Default: 0.005 */
  linkParticleSpeed?: number;
  /** Particle color. Default: 'rgba(100,150,255,0.6)' */
  linkParticleColor?: string;
  /** Particle width in pixels. Default: 1.5 */
  linkParticleWidth?: number;
  /** Keep the force simulation slightly warm so nodes gently drift. Default: false */
  drift?: boolean;
  /** Alpha target for the warm simulation (0-0.1 range). Default: 0.008 */
  driftAlpha?: number;
  /** Enable breathing/pulse animation on high-risk nodes. Default: false */
  riskPulse?: boolean;
  /** Highlight edges of hovered node with faster, brighter particles. Default: false */
  hoverTrace?: boolean;
  /** Fade-in nodes/edges on initial load. Default: false */
  fadeIn?: boolean;
}

/** Trust visualization configuration */
export interface TrustConfig {
  /** Enable trust indicators. Default: false */
  enabled: boolean;
  /** Minimum distinct sources for "verified" visual treatment. Default: 2 */
  minSources?: number;
  /** Show source count badge on nodes. Default: true */
  showBadge?: boolean;
  /** Visual style for multi-source trust: 'border' | 'opacity' | 'glow'. Default: 'border' */
  style?: 'opacity' | 'border' | 'glow';
}

/** Knowledge Asset boundary visualization configuration */
export interface KnowledgeAssetConfig {
  /** Enable KA boundary rendering. Default: false */
  enabled: boolean;
  /** Predicate linking a node to its Knowledge Asset. Default: 'dkg:partOfAsset' */
  membershipPredicate?: string;
  /** Show convex hull boundaries around KA groups. Default: true */
  showBoundaries?: boolean;
  /** Boundary fill opacity (0-1). Default: 0.06 */
  boundaryOpacity?: number;
}

/**
 * Declarative view configuration for the graph visualizer.
 *
 * Controls what nodes look like, which are important, and how they're sized —
 * all without writing code. The same graph data can be visualized differently
 * by swapping view configs.
 */
export interface ViewConfig {
  /** Human-readable name for this view */
  name: string;

  /** Visual rules per RDF type (compact or full URI) */
  nodeTypes?: Record<string, NodeTypeConfig>;

  /** Optional focal entity (rendered large, always on top) */
  focal?: FocalConfig;

  /** Highlight rule: which property drives risk/importance coloring */
  highlight?: HighlightConfig;

  /** Size-by rule: scale nodes by a numeric property */
  sizeBy?: SizeByConfig;

  /** RDF type short names rendered as circles instead of hexagons */
  circleTypes?: string[];

  /** Platform icon mapping for SocialMediaPosting nodes */
  platformIcons?: PlatformIconConfig;

  /** Tooltip configuration for hover cards */
  tooltip?: TooltipConfig;

  /** Animation configuration for visual liveliness */
  animation?: AnimationConfig;

  /** Color palette: preset name ('dark', 'midnight', 'cyberpunk', 'light') or custom palette object */
  palette?: string | ColorPalette;
  /** Overrides for individual palette colors (merged on top of base) */
  paletteOverrides?: Partial<ColorPalette>;

  /** Trust visualization based on multi-source provenance */
  trust?: TrustConfig;

  /** Knowledge Asset boundary visualization */
  knowledgeAssets?: KnowledgeAssetConfig;

  /** Temporal timeline configuration */
  temporal?: TemporalConfig;

  /** Default SPARQL CONSTRUCT query for this view */
  defaultSparql?: string;
}

// --- ViewConfig Applicator ---

/**
 * Apply a ViewConfig to a loaded graph model.
 *
 * Sets riskScore, isHighRisk, sizeMultiplier, and imageUrl on nodes
 * based on the declarative rules in the config.
 *
 * Call this AFTER loading triples into the model, BEFORE refresh().
 */
export function applyViewConfig(config: ViewConfig, model: GraphModel): void {
  // 1. Focal entity
  if (config.focal) {
    const focalNode = findNodeAcrossNamespaces(model, config.focal.uri);
    if (focalNode) {
      focalNode.sizeMultiplier = config.focal.sizeMultiplier ?? 1.5;
      if (config.focal.image) {
        focalNode.imageUrl = config.focal.image;
      }
    }
  }

  // 2. Platform icons
  if (config.platformIcons) {
    for (const node of model.nodes.values()) {
      if (node.imageUrl) continue;
      if (!node.types.some(t => t.includes('SocialMediaPosting'))) continue;

      // Check platform edges
      const platformEdges = model.getEdgesFrom(node.id).filter(e => e.predicate.includes('platform'));
      for (const edge of platformEdges) {
        const platformId = edge.target.split('/').pop() ?? '';
        if (config.platformIcons.icons[platformId]) {
          node.imageUrl = config.platformIcons.icons[platformId];
          break;
        }
      }

      // URL fallback
      if (!node.imageUrl && config.platformIcons.urlFallbacks) {
        for (const [substr, platformKey] of Object.entries(config.platformIcons.urlFallbacks)) {
          if (node.id.includes(substr) && config.platformIcons.icons[platformKey]) {
            node.imageUrl = config.platformIcons.icons[platformKey];
            break;
          }
        }
      }
    }
  }

  // 3. Highlight / risk scoring — continuous size scaling
  if (config.highlight) {
    const hl = config.highlight;
    const scores: Array<{ id: string; score: number }> = [];
    const invert = hl.invert === true;

    for (const [id, node] of model.nodes) {
      let value: number | null = null;

      if (hl.source === 'linked' && hl.linkedVia) {
        const edges = model.getEdgesFrom(id).filter(e => e.predicate.includes(hl.linkedVia!));
        if (edges.length > 0) {
          const linked = model.nodes.get(edges[0].target);
          if (linked) {
            const raw = getAnyNS(linked, hl.property);
            if (raw !== null) value = parseFloat(raw);
          }
        }
      } else {
        const raw = getAnyNS(node, hl.property);
        if (raw !== null) value = parseFloat(raw);
      }

      if (value !== null && !isNaN(value)) {
        const threshold = hl.threshold;
        let score: number;
        let include = false;
        if (value < 0) {
          // Negative values: magnitude = risk (e.g. negative sentiment)
          const riskMagnitude = Math.abs(value);
          node.riskScore = riskMagnitude;
          score = riskMagnitude;
          include = invert ? (riskMagnitude <= threshold && riskMagnitude > 0) : (riskMagnitude >= threshold);
        } else {
          // Positive values: normal = high is risky, invert = low is risky
          node.riskScore = value;
          if (invert) {
            include = value <= threshold;
            score = include ? threshold - value : 0; // lower value → higher score (riskier)
          } else {
            include = value >= threshold;
            score = value;
          }
        }
        if (include) {
          scores.push({ id, score });
        }
      }
    }

    // Mark top N as high-risk with CONTINUOUS size scaling
    const topN = hl.topN ?? 100;
    // Both modes: sort descending so highest risk score is first and gets largest size.
    // (Invert uses score = threshold - value, so low value → high score.)
    scores.sort((a, b) => b.score - a.score);
    const topScores = scores.slice(0, topN);

    if (topScores.length > 0) {
      const minSize = hl.sizeMin ?? 1.0;
      const maxSize = hl.sizeMax ?? (hl.sizeMultiplier ?? 3.0);
      const rawFirst = topScores[0].score;
      const rawLast = topScores[topScores.length - 1].score;

      for (const { id, score } of topScores) {
        const node = model.nodes.get(id);
        if (!node) continue;

        node.isHighRisk = true;

        // Don't override focal entity's sizeMultiplier
        if (node.sizeMultiplier) continue;

        // Log-scale normalization: highest risk (first in topScores) gets normalized 1 → maxSize
        let normalized: number;
        const scoreRange = Math.abs(rawFirst - rawLast);
        if (scoreRange > 0) {
          const logMin = Math.log1p(Math.min(rawFirst, rawLast));
          const logMax = Math.log1p(Math.max(rawFirst, rawLast));
          const logRange = logMax - logMin;
          const logScore = Math.log1p(score);
          const logNorm = logRange > 0 ? (logScore - logMin) / logRange : 0.5;
          normalized = logNorm;
        } else {
          normalized = 1.0;
        }

        node.sizeMultiplier = minSize + normalized * (maxSize - minSize);
      }
    }
  }

  // 4. Size-by rule: scale nodes by a numeric property
  if (config.sizeBy) {
    const sb = config.sizeBy;
    const values: Array<{ id: string; value: number }> = [];

    for (const [id, node] of model.nodes) {
      // Skip nodes that already have explicit sizeMultiplier (focal, highlight)
      if (node.sizeMultiplier) continue;

      const raw = getAnyNS(node, sb.property);
      if (raw !== null) {
        const v = parseFloat(raw);
        if (!isNaN(v) && v > 0) {
          values.push({ id, value: v });
        }
      }
    }

    if (values.length > 0) {
      const maxVal = Math.max(...values.map(v => v.value));
      const minVal = Math.min(...values.map(v => v.value));

      for (const { id, value } of values) {
        const node = model.nodes.get(id);
        if (!node || node.sizeMultiplier) continue;

        let normalized: number;
        if (sb.scale === 'log') {
          // Log scale: handles power-law distributions (social media metrics)
          const logMin = Math.log1p(minVal);
          const logMax = Math.log1p(maxVal);
          const logRange = logMax - logMin;
          normalized = logRange > 0 ? (Math.log1p(value) - logMin) / logRange : 0.5;
        } else {
          // Linear scale
          const range = maxVal - minVal;
          normalized = range > 0 ? (value - minVal) / range : 0.5;
        }

        // Map to sizeMultiplier range: 0.5x (min) to 3x (max)
        node.sizeMultiplier = 0.5 + normalized * 2.5;
      }
    }
  }

  // 5. Node type icons (for types that specify an icon but aren't platform-based)
  if (config.nodeTypes) {
    for (const node of model.nodes.values()) {
      if (node.imageUrl) continue;
      for (const type of node.types) {
        const shortType = type.split('/').pop()?.split('#').pop() ?? '';
        // Check both full URI and short forms
        const typeConfig = config.nodeTypes[type]
          || config.nodeTypes[`schema:${shortType}`]
          || config.nodeTypes[`vocab:${shortType}`]
          || config.nodeTypes[shortType];
        if (typeConfig?.icon) {
          node.imageUrl = typeConfig.icon;
          break;
        }
      }
    }
  }
}

/** Find a node trying multiple namespace variants of a URI */
function findNodeAcrossNamespaces(model: GraphModel, uri: string): GraphNode | null {
  // Try exact match first
  const exact = model.nodes.get(uri);
  if (exact) return exact;

  // Extract the path part after the last known namespace prefix
  const pathPart = uri.replace(/^https?:\/\/[^\/]+\//, '');

  // Try common namespace bases
  const bases = [
    'https://guardiankg.org/',
    'https://umanitek.ai/dkg/',
    'http://umanitek.ai/dkg/',
  ];

  for (const base of bases) {
    const candidate = model.nodes.get(base + pathPart);
    if (candidate) return candidate;
  }

  return null;
}
