import type { GraphNode, GraphEdge, HexagonConfig } from './types.js';
import { StyleEngine } from './style-engine.js';
import { PrefixManager } from './prefix-manager.js';

const DEFAULT_HEXAGON: Required<HexagonConfig> = {
  baseSize: 24,
  minSize: 16,
  maxSize: 48,
  scaleWithDegree: true,
  imagePredicates: [
    'https://schema.org/image',
    'http://xmlns.com/foaf/0.1/img',
    'http://xmlns.com/foaf/0.1/depiction',
  ],
  imageUrlPredicate: 'https://schema.org/url',
  circleTypes: [],
};

/** Cache for loaded images */
const imageCache = new Map<string, HTMLImageElement | null>();

/**
 * Draws hexagonal nodes on a Canvas 2D context.
 * Called by force-graph's nodeCanvasObject callback.
 *
 * Nodes whose rdf:type matches a `circleTypes` entry are drawn as simple
 * filled circles (much cheaper — no gradient, no border, no image, no label).
 */
export class HexagonPainter {
  private _config: Required<HexagonConfig>;
  private _styleEngine: StyleEngine;
  private _maxDegree = 1;
  /** Expanded circleTypes — full URIs resolved from compact forms */
  private _circleTypeSet: Set<string>;
  /** Callback to trigger graph repaint when an image finishes loading */
  private _onImageLoad: (() => void) | null = null;
  /** Trust visualization style */
  private _trustStyle: 'opacity' | 'border' | 'glow' | 'none' = 'none';
  /** Whether to show provenance badges */
  private _showBadges = true;

  constructor(
    config: HexagonConfig | undefined,
    styleEngine: StyleEngine,
    prefixManager?: PrefixManager
  ) {
    this._config = { ...DEFAULT_HEXAGON, ...config };
    this._styleEngine = styleEngine;

    // Build a set of full URIs for circle types (expand compact forms)
    this._circleTypeSet = new Set<string>();
    for (const t of this._config.circleTypes) {
      this._circleTypeSet.add(t);
      if (prefixManager) {
        this._circleTypeSet.add(prefixManager.expand(t));
      }
    }
  }

  /** Check if a node should render as a simple circle */
  isCircleNode(node: GraphNode): boolean {
    if (this._circleTypeSet.size === 0) return false;
    return node.types.some((t) => this._circleTypeSet.has(t));
  }

  /** Set callback to trigger repaint when images load */
  setImageLoadCallback(cb: () => void): void {
    this._onImageLoad = cb;
  }

  /** Update the max degree for scaling calculations */
  setMaxDegree(maxDegree: number): void {
    this._maxDegree = Math.max(1, maxDegree);
  }

  /** Set the trust visualization style */
  setTrustStyle(style: 'opacity' | 'border' | 'glow' | 'none'): void {
    this._trustStyle = style;
  }

  /** Enable/disable provenance badges */
  setShowBadges(show: boolean): void {
    this._showBadges = show;
  }

  /** Get the radius for a node (optionally scaled by degree, boosted if has image) */
  getRadius(node: GraphNode): number {
    // Circle nodes get a slightly smaller base
    if (this.isCircleNode(node)) {
      if (!this._config.scaleWithDegree) return this._config.minSize * 0.7;
      const ratio = node.degree / this._maxDegree;
      const range = this._config.maxSize * 0.6 - this._config.minSize * 0.7;
      return this._config.minSize * 0.7 + ratio * range;
    }

    // Size multipliers: explicit sizeMultiplier > isHighRisk > default
    const multiplier = node.sizeMultiplier ?? (node.isHighRisk ? 2.0 : 1.0);

    // Nodes with images get a minimum size so the image is visible
    const imageMinSize = node.imageUrl ? Math.max(this._config.maxSize * 0.6, 8) : 0;

    if (!this._config.scaleWithDegree) return Math.max(this._config.baseSize, imageMinSize) * multiplier;

    const ratio = node.degree / this._maxDegree;
    const range = this._config.maxSize - this._config.minSize;
    const degreeSize = this._config.minSize + ratio * range;
    return Math.max(degreeSize, imageMinSize) * multiplier;
  }

  /**
   * Paint a node onto the canvas.
   * Circle-type nodes get a minimal filled circle (fast path).
   * All others get the full hexagon treatment.
   *
   * @param pulseScale - Optional multiplier for risk pulse animation (1.0 = no pulse)
   * @returns the bounding radius for hit detection.
   */
  paint(
    ctx: CanvasRenderingContext2D,
    node: GraphNode,
    x: number,
    y: number,
    globalScale: number,
    pulseScale = 1.0
  ): number {
    // Fast path: simple circle for low-priority node types
    if (this.isCircleNode(node)) {
      return this.paintCircle(ctx, node, x, y, globalScale);
    }

    const baseRadius = this.getRadius(node);
    const radius = baseRadius * pulseScale;
    const color = this._styleEngine.getNodeColor(node);
    const palette = this._styleEngine.palette;
    const styleConfig = this._styleEngine.config;

    ctx.save();

    // Risk pulse glow (larger translucent hexagon behind)
    if (pulseScale > 1.03 && node.isHighRisk) {
      const glowRadius = radius * 1.25;
      const glowAlpha = (pulseScale - 1) * 2.5; // 0–0.45
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        const hx = x + glowRadius * Math.cos(angle);
        const hy = y + glowRadius * Math.sin(angle);
        if (i === 0) ctx.moveTo(hx, hy);
        else ctx.lineTo(hx, hy);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(220, 50, 50, ${Math.min(0.4, glowAlpha)})`;
      ctx.fill();
    }

    // Draw hexagon path (flat-top orientation)
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      const hx = x + radius * Math.cos(angle);
      const hy = y + radius * Math.sin(angle);
      if (i === 0) ctx.moveTo(hx, hy);
      else ctx.lineTo(hx, hy);
    }
    ctx.closePath();

    // Fill with gradient or flat color
    if (styleConfig.gradient) {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, this._styleEngine.getGradientCenter(color));
      gradient.addColorStop(1, color);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = color;
    }
    ctx.fill();

    // Trust glow (multi-source nodes get a colored glow behind)
    const sourceCount = node.provenance?.sources?.length ?? 0;
    if (sourceCount >= 2 && this._trustStyle === 'glow') {
      ctx.shadowColor = palette.info;
      ctx.shadowBlur = Math.min(12, sourceCount * 3) / globalScale;
      ctx.fill(); // re-fill with shadow
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }

    // Border — risk, trust, or normal
    if (node.riskScore && node.riskScore > 0) {
      const riskIntensity = Math.min(1, node.riskScore);
      ctx.strokeStyle = `rgba(220, 50, 50, ${0.5 + riskIntensity * 0.5})`;
      ctx.lineWidth = (styleConfig.borderWidth + (node.isHighRisk ? 1.5 : 0.5)) / globalScale;
    } else if (sourceCount >= 2 && this._trustStyle === 'border') {
      // Multi-source trust: thicker, brighter border
      ctx.strokeStyle = palette.info;
      ctx.lineWidth = (styleConfig.borderWidth + Math.min(3, sourceCount)) / globalScale;
    } else {
      ctx.strokeStyle = this._styleEngine.getBorderColor(color);
      ctx.lineWidth = styleConfig.borderWidth / globalScale;
    }

    // Boundary node indicator (subtle lighter border, no dashes)
    if (node.isBoundary && !(node.riskScore && node.riskScore > 0)) {
      ctx.strokeStyle = lightenColor(color, 0.5);
      ctx.lineWidth = (styleConfig.borderWidth + 1) / globalScale;
    }

    ctx.stroke();
    ctx.setLineDash([]);

    // Trust opacity adjustment
    if (sourceCount < 2 && this._trustStyle === 'opacity') {
      ctx.globalAlpha = 0.7;
    }

    // Avatar image (clipped to hexagon)
    if (node.imageUrl) {
      this.paintAvatar(ctx, node.imageUrl, x, y, radius);
    }

    ctx.globalAlpha = 1;

    // Badges (source count + verified indicator)
    if (globalScale > 3.0) {
      this._paintBadges(ctx, node, x, y, radius, globalScale);
    }

    // Label below hexagon — fade in/out with zoom
    const fadeStart = 1.5;
    const fadeFull = 2.5;
    if (globalScale > fadeStart) {
      const opacity = Math.min(1, (globalScale - fadeStart) / (fadeFull - fadeStart));
      const fontSize = styleConfig.fontSize / globalScale;
      ctx.font = `${fontSize}px ${styleConfig.fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.globalAlpha = opacity;
      ctx.fillStyle = palette.textPrimary;
      ctx.fillText(
        truncateLabel(node.label, 40),
        x,
        y + radius + 2 / globalScale
      );
      ctx.globalAlpha = 1;
    }

    ctx.restore();
    return radius;
  }

  /** Paint provenance badges on a node */
  private _paintBadges(
    ctx: CanvasRenderingContext2D,
    node: GraphNode,
    x: number,
    y: number,
    radius: number,
    globalScale: number
  ): void {
    if (!this._showBadges) return;

    const prov = node.provenance;
    if (!prov) return;

    const palette = this._styleEngine.palette;
    const badgeSize = Math.max(4, 8 / globalScale);

    // Source count badge (bottom-right)
    if (prov.sources.length > 0) {
      const bx = x + radius * 0.7;
      const by = y + radius * 0.6;
      const count = prov.sources.length;

      // Badge circle
      ctx.beginPath();
      ctx.arc(bx, by, badgeSize, 0, 2 * Math.PI);
      const intensity = Math.min(1, count / 3);
      ctx.fillStyle = count >= 2 ? palette.info : palette.textMuted;
      ctx.globalAlpha = 0.4 + intensity * 0.6;
      ctx.fill();

      // Badge number
      if (badgeSize > 3) {
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 1;
        ctx.font = `bold ${badgeSize * 1.2}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(count), bx, by);
      }
    }

    // Verified badge (top-right) — checkmark for content hash
    if (prov.contentHash || prov.blockchainAnchor) {
      const bx = x + radius * 0.7;
      const by = y - radius * 0.6;

      ctx.beginPath();
      ctx.arc(bx, by, badgeSize, 0, 2 * Math.PI);
      ctx.fillStyle = prov.blockchainAnchor ? palette.safe : palette.info;
      ctx.globalAlpha = 0.85;
      ctx.fill();

      // Checkmark
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = badgeSize * 0.3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const s = badgeSize * 0.5;
      ctx.moveTo(bx - s * 0.5, by);
      ctx.lineTo(bx - s * 0.1, by + s * 0.4);
      ctx.lineTo(bx + s * 0.5, by - s * 0.3);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  /**
   * Fast path: paint a minimal filled circle.
   * No gradient, no border, no image, no label — just a flat arc.
   */
  private paintCircle(
    ctx: CanvasRenderingContext2D,
    node: GraphNode,
    x: number,
    y: number,
    _globalScale: number
  ): number {
    const radius = this.getRadius(node);
    const color = this._styleEngine.getNodeColor(node);

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    return radius;
  }

  /** Paint an avatar image clipped to the hexagon shape */
  private paintAvatar(
    ctx: CanvasRenderingContext2D,
    url: string,
    x: number,
    y: number,
    radius: number
  ): void {
    let img = imageCache.get(url);

    if (img === undefined) {
      // Start loading
      const newImg = new Image();
      // Only set crossOrigin for remote URLs — data URIs break with CORS attributes
      if (!url.startsWith('data:')) {
        newImg.crossOrigin = 'anonymous';
      }
      imageCache.set(url, null); // Mark as loading
      newImg.src = url;

      newImg.onload = () => {
        imageCache.set(url, newImg);
        // Trigger graph repaint so the image appears
        this._onImageLoad?.();
      };
      newImg.onerror = () => {
        // Don't permanently cache failures — allow retry
        imageCache.delete(url);
      };
      return;
    }

    if (!img) return; // Still loading

    ctx.save();

    // Clip to hexagon
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      const hx = x + radius * Math.cos(angle);
      const hy = y + radius * Math.sin(angle);
      if (i === 0) ctx.moveTo(hx, hy);
      else ctx.lineTo(hx, hy);
    }
    ctx.closePath();
    ctx.clip();

    // Draw image centered in the hexagon, cropped by hexagon clip path
    const imgAspect = img.naturalWidth / img.naturalHeight;
    // Full photos (http/https URLs) fill the hexagon; small SVG icons stay compact
    const isIcon = url.startsWith('data:');
    const scale = isIcon ? 0.5 : 1.0;
    let drawW: number, drawH: number;
    const size = radius * 2 * scale;
    if (imgAspect > 1) {
      drawH = size;
      drawW = size * imgAspect;
    } else {
      drawW = size;
      drawH = size / imgAspect;
    }
    ctx.globalAlpha = 0.95;
    ctx.drawImage(img, x - drawW / 2, y - drawH / 2, drawW, drawH);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  /**
   * Resolve image URL for a node from its properties,
   * following indirect links if needed.
   *
   * Two resolution strategies:
   * 1. Direct: node has a literal property (schema:image → "https://...jpg")
   * 2. Indirect: node links to an image node which has the URL
   *    (node → schema:image → ImageObject → schema:url → "https://...jpg")
   */
  resolveImageUrl(
    node: GraphNode,
    getNode: (id: string) => GraphNode | undefined,
    getEdgesFrom?: (id: string) => GraphEdge[]
  ): string | null {
    // Strategy 1: Direct literal image URL on the node
    for (const pred of this._config.imagePredicates) {
      const literalVals = node.properties.get(pred);
      if (literalVals && literalVals.length > 0) {
        const url = literalVals[0].value;
        if (url.startsWith('http://') || url.startsWith('https://')) {
          return url;
        }
      }
    }

    // Strategy 2: Indirect — follow edge to an intermediate image node
    if (getEdgesFrom) {
      const edges = getEdgesFrom(node.id);
      for (const pred of this._config.imagePredicates) {
        for (const edge of edges) {
          if (edge.predicate !== pred) continue;

          const imageNode = getNode(edge.target);
          if (!imageNode) continue;

          // Check the intermediate node for the actual URL
          const urlVals = imageNode.properties.get(this._config.imageUrlPredicate);
          if (urlVals && urlVals.length > 0) {
            const url = urlVals[0].value;
            if (url.startsWith('http://') || url.startsWith('https://')) {
              return url;
            }
          }

          // Also check if the intermediate node has a direct image literal
          for (const imgPred of this._config.imagePredicates) {
            const vals = imageNode.properties.get(imgPred);
            if (vals && vals.length > 0) {
              const url = vals[0].value;
              if (url.startsWith('http://') || url.startsWith('https://')) {
                return url;
              }
            }
          }
        }
      }
    }

    return null;
  }
}

function truncateLabel(label: string, maxLen: number): string {
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 1) + '\u2026';
}

function lightenColor(hex: string, factor: number): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return hex;
  const r = Math.round(parseInt(match[1], 16) + (255 - parseInt(match[1], 16)) * factor);
  const g = Math.round(parseInt(match[2], 16) + (255 - parseInt(match[2], 16)) * factor);
  const b = Math.round(parseInt(match[3], 16) + (255 - parseInt(match[3], 16)) * factor);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
