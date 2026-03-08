/* eslint-disable @typescript-eslint/no-explicit-any */
import ForceGraph from 'force-graph';
import type { GraphNode, GraphEdge, ForceNode, ForceLink } from './types.js';
import type { RendererBackend, RendererBackendConfig } from './renderer-backend.js';
import type { AnimationConfig } from './view-config.js';
import type { ColorPalette } from './palette.js';
import { HexagonPainter } from './hexagon-painter.js';
import { StyleEngine } from './style-engine.js';
import { GraphEventEmitter } from './events.js';

/**
 * 2D Canvas renderer backend using force-graph.
 *
 * Renders hexagonal nodes via HexagonPainter on an HTML5 Canvas 2D context.
 * Implements RendererBackend so it can be swapped with a 3D renderer.
 */
export class Canvas2DRenderer implements RendererBackend {
  private _container: HTMLElement;
  private _graph: any = null;
  private _hexPainter: HexagonPainter;
  private _styleEngine: StyleEngine;
  private _events: GraphEventEmitter;
  private _currentNodes = new Map<string, ForceNode>();
  private _positionCache = new Map<string, {
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
  }>();
  private _currentLinks: ForceLink[] = [];
  private _repaintPending = false;

  // Animation state
  private _riskPulseEnabled = false;
  private _hoverTraceEnabled = false;
  private _hoveredNodeId: string | null = null;
  private _fadeInEnabled = false;
  private _loadTime = 0;
  private _fadeInDuration = 1500;
  private _animFrameId: number | null = null;

  /** force-graph version compatibility guard */
  private _setAlphaTarget(value: number): void {
    const maybeFn = this._graph?.d3AlphaTarget;
    if (typeof maybeFn === 'function') {
      maybeFn.call(this._graph, value);
    }
  }

  // KA boundary state
  private _kaGroups: Map<string, Set<string>> = new Map();
  private _kaEnabled = false;
  private _kaBoundaryOpacity = 0.06;

  constructor(config: RendererBackendConfig) {
    this._container = config.container;
    this._hexPainter = config.hexPainter;
    this._styleEngine = config.styleEngine;
    this._events = config.events;
  }

  /** Initialize the force-graph instance */
  init(): void {
    if (this._graph) return;

    const styleConfig = this._styleEngine.config;

    const width = this._container.clientWidth || this._container.offsetWidth || 800;
    const height = this._container.clientHeight || this._container.offsetHeight || 600;

    // When an image finishes loading, nudge the graph to repaint
    this._hexPainter.setImageLoadCallback(() => {
      this._scheduleRepaint();
    });

    this._graph = (ForceGraph as any)()(this._container)
      .width(width)
      .height(height)
      .backgroundColor('transparent')
      .nodeCanvasObjectMode((node: any) => {
        // Featured nodes (sizeMultiplier) render in 'after' pass — always on top
        const fn = node as ForceNode;
        if (fn._graphNode?.sizeMultiplier && fn._graphNode.sizeMultiplier > 1) {
          return 'after';
        }
        return 'replace';
      })
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const fn = node as ForceNode;
        if (!fn._graphNode) return;
        const x = fn.x ?? 0;
        const y = fn.y ?? 0;

        // Fade-in on initial load
        if (this._fadeInEnabled && this._loadTime > 0) {
          const elapsed = performance.now() - this._loadTime;
          if (elapsed < this._fadeInDuration) {
            const t = elapsed / this._fadeInDuration;
            const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
            ctx.globalAlpha = ease;
          }
        }

        // Risk pulse: sin-modulated scale for high-risk nodes (wall-clock time)
        let pulseScale = 1.0;
        if (this._riskPulseEnabled && fn._graphNode.isHighRisk) {
          const t = performance.now() / 1000; // seconds
          const hash = simpleHash(fn._graphNode.id);
          pulseScale = 1 + 0.15 * Math.sin(t * 1.25 + hash);
        }

        this._hexPainter.paint(ctx, fn._graphNode, x, y, globalScale, pulseScale);
        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const fn = node as ForceNode;
        if (!fn._graphNode) return;
        const radius = this._hexPainter.getRadius(fn._graphNode);
        const x = fn.x ?? 0;
        const y = fn.y ?? 0;

        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI / 3) * i;
          const hx = x + radius * Math.cos(angle);
          const hy = y + radius * Math.sin(angle);
          if (i === 0) ctx.moveTo(hx, hy);
          else ctx.lineTo(hx, hy);
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      })
      .linkColor((link: any) => {
        const fl = link as ForceLink;
        if (fl._graphEdge) {
          return this._styleEngine.getEdgeColor(fl._graphEdge);
        }
        return styleConfig.defaultEdgeColor;
      })
      .linkWidth(styleConfig.edgeWidth)
      .linkDirectionalArrowLength(styleConfig.edgeArrowSize)
      .linkDirectionalArrowRelPos(1)
      .linkCanvasObjectMode(() => 'after')
      .linkCanvasObject((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        // Skip expensive label rendering entirely when not zoomed in enough
        if (globalScale < 3.0) return;

        const fl = link as ForceLink;
        if (!fl._graphEdge) return;

        const label = fl._graphEdge.label;
        if (!label) return;

        // Fade in between globalScale 3–4
        const fadeStart = 3.0;
        const fadeFull = 4.0;
        const opacity = Math.min(1, (globalScale - fadeStart) / (fadeFull - fadeStart));

        const fontSize = 12 / globalScale;

        const src = fl.source as any;
        const tgt = fl.target as any;
        if (!src.x || !tgt.x) return;

        const midX = (src.x + tgt.x) / 2;
        const midY = (src.y + tgt.y) / 2;

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.font = `${fontSize}px ${styleConfig.fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Background pill for readability
        const textWidth = ctx.measureText(label).width;
        const pad = 2 / globalScale;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.beginPath();
        ctx.roundRect(
          midX - textWidth / 2 - pad,
          midY - fontSize / 2 - pad,
          textWidth + pad * 2,
          fontSize + pad * 2,
          2 / globalScale
        );
        ctx.fill();

        ctx.fillStyle = '#94a3b8';
        ctx.fillText(label, midX, midY);
        ctx.restore();
      })
      .onRenderFramePre((ctx: CanvasRenderingContext2D, _globalScale: number) => {
        this._drawKaBoundaries(ctx);
      })
      .onNodeClick((node: any) => {
        const fn = node as ForceNode;
        if (fn._graphNode) {
          this._events.emit('node:click', fn._graphNode);
        }
      })
      .onNodeDrag((_node: any) => {
        try {
          this._graph.d3ReheatSimulation();
        } catch {
          /* noop */
        }
      })
      .onNodeDragEnd((_node: any) => {
        try {
          this._graph.d3ReheatSimulation();
        } catch {
          /* noop */
        }
      })
      .onNodeHover((node: any) => {
        const fn = node as ForceNode | null;
        if (fn?._graphNode) {
          this._hoveredNodeId = fn._graphNode.id;
          this._events.emit('node:hover', fn._graphNode);
          this._container.style.cursor = 'pointer';
        } else {
          this._hoveredNodeId = null;
          this._events.emit('node:unhover', null as unknown as GraphNode);
          this._container.style.cursor = 'default';
        }
      })
      .onLinkClick((link: any) => {
        const fl = link as ForceLink;
        if (fl._graphEdge) {
          this._events.emit('edge:click', fl._graphEdge);
        }
      })
      .onBackgroundClick((_event: any) => {
        this._events.emit('background:click', { x: 0, y: 0 });
      })
      .cooldownTicks(200)
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .warmupTicks(60);

    // Tune the default d3 forces for better spread with large graphs
    const charge = this._graph.d3Force('charge') as any;
    if (charge?.strength) { charge.strength(-150); charge.distanceMax?.(1000); }
    const link = this._graph.d3Force('link') as any;
    if (link?.distance) { link.distance(80).strength(0.2); }
    const center = this._graph.d3Force('center') as any;
    if (center?.strength) { center.strength(0.03); }
  }

  /**
   * Render the graph with the given nodes and edges.
   * Preserves positions of existing nodes for smooth transitions.
   */
  render(
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>,
    collapsedNodeIds?: Set<string>
  ): void {
    if (!this._graph) this.init();

    // Record load time for fade-in animation
    if (this._loadTime === 0) {
      this._loadTime = performance.now();
    }

    // Update max degree for hexagon scaling
    let maxDegree = 1;
    for (const node of nodes.values()) {
      if (node.degree > maxDegree) maxDegree = node.degree;
    }
    this._hexPainter.setMaxDegree(maxDegree);

    // Build force-graph node array, preserving positions for existing nodes
    // and assigning chronological x-positions for dated nodes
    const dateNs = ['http://schema.org/dateCreated', 'https://schema.org/dateCreated'];
    const nodeDates = new Map<string, number>();
    for (const [id, gn] of nodes) {
      for (const ns of dateNs) {
        const vals = gn.properties?.get(ns);
        if (vals && vals.length > 0) {
          const d = new Date(vals[0].value);
          if (!isNaN(d.getTime())) { nodeDates.set(id, d.getTime()); break; }
        }
      }
    }
    let xByDate: Map<string, number> | null = null;
    if (nodeDates.size >= 2) {
      const times = [...nodeDates.values()];
      const minT = Math.min(...times);
      const maxT = Math.max(...times);
      const range = maxT - minT || 1;
      const spread = Math.max(400, nodeDates.size * 120);
      xByDate = new Map();
      for (const [id, t] of nodeDates) {
        xByDate.set(id, ((t - minT) / range - 0.5) * spread);
      }
    }

    const newNodes = new Map<string, ForceNode>();
    for (const [id, gn] of nodes) {
      if (collapsedNodeIds?.has(id)) continue;

      const existing = this._currentNodes.get(id);
      const cached = this._positionCache.get(id);
      const chronoX = xByDate?.get(id);
      newNodes.set(id, {
        id,
        x: existing?.x ?? cached?.x ?? chronoX ?? (Math.random() - 0.5) * 800,
        y: existing?.y ?? cached?.y ?? (Math.random() - 0.5) * 400,
        vx: existing?.vx ?? cached?.vx,
        vy: existing?.vy ?? cached?.vy,
        fx: typeof existing?.fx === 'number'
          ? existing.fx
          : (typeof cached?.fx === 'number' ? cached.fx : undefined),
        fy: typeof existing?.fy === 'number'
          ? existing.fy
          : (typeof cached?.fy === 'number' ? cached.fy : undefined),
        _graphNode: gn,
      });
    }

    // Build force-graph link array
    const validNodeIds = new Set(newNodes.keys());
    const newLinks: ForceLink[] = [];
    for (const edge of edges.values()) {
      if (collapsedNodeIds?.has(edge.source) || collapsedNodeIds?.has(edge.target)) continue;
      if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) continue;

      newLinks.push({
        source: edge.source,
        target: edge.target,
        _graphEdge: edge,
      });
    }

    this._currentNodes = newNodes;
    this._currentLinks = newLinks;
    for (const [id, node] of newNodes) {
      this._positionCache.set(id, {
        x: node.x,
        y: node.y,
        vx: node.vx,
        vy: node.vy,
        fx: typeof node.fx === 'number' ? node.fx : undefined,
        fy: typeof node.fy === 'number' ? node.fy : undefined,
      });
    }

    // Sort nodes so featured/high-risk nodes are last (painted on top)
    const sortedNodes = [...newNodes.values()].sort((a, b) => {
      const aOrder = (a._graphNode?.sizeMultiplier && a._graphNode.sizeMultiplier > 1) ? 100
        : a._graphNode?.isHighRisk ? 10 : 0;
      const bOrder = (b._graphNode?.sizeMultiplier && b._graphNode.sizeMultiplier > 1) ? 100
        : b._graphNode?.isHighRisk ? 10 : 0;
      return aOrder - bOrder;
    });

    this._graph.graphData({
      nodes: sortedNodes,
      links: newLinks,
    });

    // Add a gentle x-force to maintain chronological left→right ordering
    if (xByDate && xByDate.size >= 2) {
      this._graph.d3Force('chronoX', (alpha: number) => {
        for (const fn of sortedNodes) {
          const targetX = xByDate!.get(fn.id);
          if (targetX !== undefined && fn.fx == null) {
            fn.vx = ((fn.vx ?? 0) + (targetX - (fn.x ?? 0)) * 0.05 * alpha);
          }
        }
      });
    } else {
      this._graph.d3Force('chronoX', null);
    }
  }

  /** Focus the camera on a specific node */
  centerOnNode(nodeId: string, durationMs = 350, zoomLevel?: number): void {
    const fn = this._currentNodes.get(nodeId);
    if (fn && this._graph) {
      this._graph.centerAt(fn.x, fn.y, durationMs);
      if (zoomLevel != null) {
        this._graph.zoom(zoomLevel, durationMs);
      }
    }
  }

  /** Fit all nodes in view */
  zoomToFit(padding = 40, durationMs = 500): void {
    this._graph?.zoomToFit(durationMs, padding);
  }

  /** Get the underlying canvas element for export */
  getCanvas(): HTMLCanvasElement | null {
    if (!this._graph) return null;
    const canvas = this._container.querySelector('canvas');
    return canvas ?? null;
  }

  /** Repaint node/edge visuals without rebuilding graph data. */
  refresh(): void {
    if (!this._graph) return;
    const maybeRefresh = this._graph.refresh;
    if (typeof maybeRefresh === 'function') {
      maybeRefresh.call(this._graph);
      return;
    }
    this._scheduleRepaint();
  }

  /**
   * Schedule a debounced repaint — used when images finish loading
   * after the simulation has cooled down. Briefly reheats the simulation
   * to force force-graph to repaint the canvas.
   */
  private _scheduleRepaint(): void {
    if (this._repaintPending) return;
    this._repaintPending = true;
    requestAnimationFrame(() => {
      this._repaintPending = false;
      if (this._graph) {
        // Reheat the simulation very briefly to trigger repaint frames
        this._graph.d3ReheatSimulation();
        // Only freeze if drift/pulse are not active (they need continuous ticks)
        if (!this._riskPulseEnabled) {
          setTimeout(() => {
            if (this._graph && !this._riskPulseEnabled) {
              this._graph.cooldownTicks(0);
              this._setAlphaTarget(0);
            }
          }, 100);
        }
      }
    });
  }

  /** Stop the animation loop */
  private _stopAnimLoop(): void {
    if (this._animFrameId !== null) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
  }

  /** Configure Knowledge Asset boundary rendering */
  setKaGroups(groups: Map<string, Set<string>>, enabled: boolean, opacity = 0.06): void {
    this._kaGroups = groups;
    this._kaEnabled = enabled;
    this._kaBoundaryOpacity = opacity;
  }

  /** Draw convex hulls around KA groups */
  private _drawKaBoundaries(ctx: CanvasRenderingContext2D): void {
    if (!this._kaEnabled || this._kaGroups.size === 0) return;

    const palette = this._styleEngine.palette;
    let colorIdx = 0;

    for (const [_kaUri, memberIds] of this._kaGroups) {
      const points: [number, number][] = [];
      for (const nodeId of memberIds) {
        const fn = this._currentNodes.get(nodeId);
        if (fn && fn.x !== undefined && fn.y !== undefined) {
          points.push([fn.x, fn.y]);
        }
      }
      if (points.length < 3) continue;

      const hull = convexHull(points);
      if (hull.length < 3) continue;

      const color = palette.nodeColors[colorIdx % palette.nodeColors.length];
      colorIdx++;

      ctx.save();
      ctx.beginPath();
      // Expand hull slightly with padding
      const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
      const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
      for (let i = 0; i < hull.length; i++) {
        const dx = hull[i][0] - cx;
        const dy = hull[i][1] - cy;
        const len = Math.sqrt(dx * dx + dy * dy);
        const pad = 30;
        const px = hull[i][0] + (len > 0 ? (dx / len) * pad : 0);
        const py = hull[i][1] + (len > 0 ? (dy / len) * pad : 0);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = this._kaBoundaryOpacity;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.globalAlpha = this._kaBoundaryOpacity * 2.5;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Resize to fit container */
  resize(): void {
    if (this._graph) {
      this._graph.width(this._container.clientWidth);
      this._graph.height(this._container.clientHeight);
    }
  }

  /** Clean up */
  destroy(): void {
    this._stopAnimLoop();
    if (this._graph) {
      this._graph._destructor();
      this._graph = null;
    }
    this._currentNodes.clear();
    this._positionCache.clear();
    this._currentLinks = [];
  }

  /** Apply animation configuration: link particles, drift, pulse, hover trace, fade-in */
  applyAnimation(config: AnimationConfig): void {
    if (!this._graph) return;

    // Risk pulse
    this._riskPulseEnabled = config.riskPulse ?? false;
    // Fade-in
    this._fadeInEnabled = config.fadeIn ?? false;
    // Hover trace
    this._hoverTraceEnabled = config.hoverTrace ?? false;

    const baseSpeed = config.linkParticleSpeed ?? 0.005;
    const baseColor = config.linkParticleColor ?? 'rgba(100,150,255,0.6)';
    const baseWidth = config.linkParticleWidth ?? 1.5;

    if (config.linkParticles || config.hoverTrace) {
      const particleCount = config.linkParticleCount ?? 1;

      if (this._hoverTraceEnabled) {
        // Per-link callbacks for hover trace
        this._graph
          .linkDirectionalParticles((link: any) => {
            if (!this._hoveredNodeId) return config.linkParticles ? particleCount : 0;
            const fl = link as ForceLink;
            const src = typeof fl.source === 'object' ? (fl.source as any).id : fl.source;
            const tgt = typeof fl.target === 'object' ? (fl.target as any).id : fl.target;
            const isHovered = src === this._hoveredNodeId || tgt === this._hoveredNodeId;
            return isHovered ? 4 : (config.linkParticles ? particleCount : 0);
          })
          .linkDirectionalParticleSpeed((link: any) => {
            if (!this._hoveredNodeId) return baseSpeed;
            const fl = link as ForceLink;
            const src = typeof fl.source === 'object' ? (fl.source as any).id : fl.source;
            const tgt = typeof fl.target === 'object' ? (fl.target as any).id : fl.target;
            return (src === this._hoveredNodeId || tgt === this._hoveredNodeId) ? 0.02 : baseSpeed;
          })
          .linkDirectionalParticleWidth((link: any) => {
            if (!this._hoveredNodeId) return baseWidth;
            const fl = link as ForceLink;
            const src = typeof fl.source === 'object' ? (fl.source as any).id : fl.source;
            const tgt = typeof fl.target === 'object' ? (fl.target as any).id : fl.target;
            return (src === this._hoveredNodeId || tgt === this._hoveredNodeId) ? 3 : baseWidth;
          })
          .linkDirectionalParticleColor((link: any) => {
            if (!this._hoveredNodeId) return baseColor;
            const fl = link as ForceLink;
            const src = typeof fl.source === 'object' ? (fl.source as any).id : fl.source;
            const tgt = typeof fl.target === 'object' ? (fl.target as any).id : fl.target;
            return (src === this._hoveredNodeId || tgt === this._hoveredNodeId) ? '#60a0ff' : baseColor;
          });
      } else {
        this._graph
          .linkDirectionalParticles(particleCount)
          .linkDirectionalParticleSpeed(baseSpeed)
          .linkDirectionalParticleWidth(baseWidth)
          .linkDirectionalParticleColor(() => baseColor);
      }
    } else {
      this._graph.linkDirectionalParticles(0);
    }

    // When drift or pulse is active, the simulation must run indefinitely
    const needsContinuousRender = config.drift || this._riskPulseEnabled;

    if (needsContinuousRender) {
      // Prevent the simulation from ever stopping on its own
      this._graph.cooldownTicks(Infinity);
      this._setAlphaTarget(config.driftAlpha ?? 0.008);
    } else {
      this._graph.cooldownTicks(120);
      this._setAlphaTarget(0);
    }

    // Stop any previous animation loop before potentially starting a new one
    this._stopAnimLoop();

    // For risk pulse, we need force-graph to keep calling nodeCanvasObject.
    // Drift keeps the simulation warm, which triggers continuous redraws.
    // If pulse is on but drift is off, reheat periodically to force redraws.
    if (this._riskPulseEnabled && !config.drift) {
      const loop = () => {
        if (!this._riskPulseEnabled || !this._graph) {
          this._animFrameId = null;
          return;
        }
        try { this._graph.d3ReheatSimulation(); } catch { /* noop */ }
        this._animFrameId = requestAnimationFrame(loop);
      };
      this._animFrameId = requestAnimationFrame(loop);
    }
  }

  /** Apply palette: update background color */
  applyPalette(palette: ColorPalette): void {
    if (!this._graph) return;
    this._graph.backgroundColor(palette.background === '#0a0a0f' ? 'transparent' : palette.background);
  }
}

/** Simple numeric hash of a string (for phase-offsetting pulse animations) */
function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Graham scan convex hull algorithm */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }

  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * @deprecated Use Canvas2DRenderer instead. This alias exists for backward compatibility.
 */
export const ForceGraphRenderer = Canvas2DRenderer;
