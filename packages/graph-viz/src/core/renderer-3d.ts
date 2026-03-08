/* eslint-disable @typescript-eslint/no-explicit-any */
import type { GraphNode, GraphEdge, ForceNode, ForceLink } from './types.js';
import type { RendererBackend, RendererBackendConfig } from './renderer-backend.js';
import type { AnimationConfig } from './view-config.js';
import type { ColorPalette } from './palette.js';
import type { HexagonPainter } from './hexagon-painter.js';
import type { StyleEngine } from './style-engine.js';
import type { GraphEventEmitter } from './events.js';

/**
 * 3D WebGL renderer backend using 3d-force-graph (Three.js).
 *
 * Performance strategy:
 * - Default built-in sphere rendering for all plain nodes (instanced/batched
 *   internally by 3d-force-graph — 10-50x faster than custom nodeThreeObject).
 * - nodeColor/nodeVal callbacks drive color and size without custom geometry.
 * - Custom Three.js objects ONLY for the small subset of nodes with images
 *   (platform icons, avatars). Everything else gets `undefined` from
 *   nodeThreeObject, triggering the fast built-in path.
 * - No directional arrows on links (each arrow = separate mesh = expensive).
 * - Proximity-based labels: only closest ~8% of nodes within zoom range.
 */
export class WebGL3DRenderer implements RendererBackend {
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
  private _ForceGraph3D: any = null;
  private _THREE: any = null;

  /** Texture cache for image URLs (shared across renders) */
  private _textureCache = new Map<string, any>();
  private _textureLoader: any = null;

  /** Label sprites currently in the scene, keyed by node ID */
  private _labelSprites = new Map<string, any>();

  /** Timer for proximity label updates */
  private _labelTimer: ReturnType<typeof setInterval> | null = null;

  /** Timer for gentle drift reheat */
  private _driftTimer: ReturnType<typeof setInterval> | null = null;

  /** Fraction of nodes that get labels */
  private _labelFraction = 0.08;

  /** Squared distance threshold for label visibility */
  private _labelMaxDistSq = 250 * 250;

  /** Base scale for label sprites */
  private _labelBaseScale = 0.06;

  // Animation state
  private _riskPulseEnabled = false;
  private _hoverTraceEnabled = false;
  private _hoveredNodeId: string | null = null;
  private _fadeInEnabled = false;
  private _loadTime = 0;
  private _animTime = 0;
  private _pulseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RendererBackendConfig) {
    this._container = config.container;
    this._hexPainter = config.hexPainter;
    this._styleEngine = config.styleEngine;
    this._events = config.events;
  }

  async init(): Promise<void> {
    if (this._graph) return;

    const [ForceGraph3DModule, THREE] = await Promise.all([
      import('3d-force-graph'),
      import('three'),
    ]);

    this._ForceGraph3D = ForceGraph3DModule.default ?? ForceGraph3DModule;
    this._THREE = THREE;
    this._textureLoader = new THREE.TextureLoader();

    const width = this._container.clientWidth || this._container.offsetWidth || 800;
    const height = this._container.clientHeight || this._container.offsetHeight || 600;

    this._graph = this._ForceGraph3D()(this._container)
      .width(width)
      .height(height)
      .backgroundColor('#0a0a0f')
      // ── Fast built-in rendering: color + size via callbacks ──
      .nodeColor((node: any) => {
        const fn = node as ForceNode;
        if (!fn._graphNode) return '#334';
        if (fn._graphNode.isHighRisk) return '#e04040';
        return this._styleEngine.getNodeColor(fn._graphNode);
      })
      .nodeVal((node: any) => {
        const fn = node as ForceNode;
        if (!fn._graphNode) return 1;
        const radius = this._hexPainter.getRadius(fn._graphNode);
        let val = radius * radius * radius * 0.05;
        // Risk pulse animation
        if (this._riskPulseEnabled && fn._graphNode.isHighRisk) {
          const hash = simpleHash3d(fn._graphNode.id);
          const pulse = 1 + 0.25 * Math.sin(this._animTime * 2 + hash);
          val *= pulse;
        }
        return val;
      })
      .nodeOpacity(0.85)
      .nodeResolution(6) // low-poly spheres for speed
      // ── Custom objects ONLY for nodes with images ──
      .nodeThreeObject((node: any) => {
        const fn = node as ForceNode;
        if (!fn._graphNode?.imageUrl) return undefined; // fast path
        return this._createIconSprite(fn._graphNode);
      })
      .nodeThreeObjectExtend(false)
      // ── Links: minimal rendering ──
      .linkColor('#1a1a3a')
      .linkWidth(0)         // hairline links (0 = single-pixel line)
      .linkOpacity(0.15)
      // No directional arrows — each arrow is an extra mesh per link
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
      .onBackgroundClick(() => {
        this._events.emit('background:click', { x: 0, y: 0 });
      })
      .cooldownTicks(80)
      .d3AlphaDecay(0.05)
      .d3VelocityDecay(0.5)
      .warmupTicks(30);

    // Start proximity label update loop
    this._labelTimer = setInterval(() => this._updateProximityLabels(), 500);
  }

  render(
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>,
    collapsedNodeIds?: Set<string>
  ): void {
    if (!this._graph) {
      this.init().then(() => this.render(nodes, edges, collapsedNodeIds));
      return;
    }

    // Record load time for fade-in animation
    if (this._loadTime === 0) {
      this._loadTime = performance.now();
      if (this._fadeInEnabled) {
        this._graph.nodeOpacity(0.05);
        // Animate fade-in
        const fadeIn = () => {
          const elapsed = performance.now() - this._loadTime;
          if (elapsed < 1500) {
            const t = elapsed / 1500;
            const ease = 1 - Math.pow(1 - t, 3);
            this._graph.nodeOpacity(ease * 0.85);
            requestAnimationFrame(fadeIn);
          } else {
            this._graph.nodeOpacity(0.85);
          }
        };
        requestAnimationFrame(fadeIn);
      }
    }

    let maxDegree = 1;
    for (const node of nodes.values()) {
      if (node.degree > maxDegree) maxDegree = node.degree;
    }
    this._hexPainter.setMaxDegree(maxDegree);

    const newNodes = new Map<string, ForceNode>();
    for (const [id, gn] of nodes) {
      if (collapsedNodeIds?.has(id)) continue;
      const existing = this._currentNodes.get(id);
      const cached = this._positionCache.get(id);
      newNodes.set(id, {
        id,
        x: existing?.x ?? cached?.x ?? (Math.random() - 0.5) * 300,
        y: existing?.y ?? cached?.y ?? (Math.random() - 0.5) * 300,
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
    this._labelSprites.clear();

    this._graph.graphData({
      nodes: [...newNodes.values()],
      links: newLinks,
    });
  }

  centerOnNode(nodeId: string, durationMs = 350, zoomLevel?: number): void {
    const fn = this._currentNodes.get(nodeId);
    if (fn && this._graph) {
      const pos = { x: fn.x ?? 0, y: fn.y ?? 0, z: 0 };
      const zoomFactor = zoomLevel != null && Number.isFinite(zoomLevel) && zoomLevel > 0
        ? zoomLevel
        : 1;
      const distance = Math.max(60, 200 / zoomFactor);
      this._graph.cameraPosition(
        { x: pos.x, y: pos.y, z: distance },
        pos,
        durationMs
      );
    }
  }

  zoomToFit(padding = 40, durationMs = 500): void {
    this._graph?.zoomToFit(durationMs, padding);
  }

  getCanvas(): HTMLCanvasElement | null {
    if (!this._graph) return null;
    return this._container.querySelector('canvas') ?? null;
  }

  refresh(): void {
    if (!this._graph) return;
    const maybeRefresh = this._graph.refresh;
    if (typeof maybeRefresh === 'function') {
      maybeRefresh.call(this._graph);
    }
  }

  resize(): void {
    if (this._graph) {
      this._graph.width(this._container.clientWidth);
      this._graph.height(this._container.clientHeight);
    }
  }

  destroy(): void {
    if (this._labelTimer) {
      clearInterval(this._labelTimer);
      this._labelTimer = null;
    }
    if (this._driftTimer) {
      clearInterval(this._driftTimer);
      this._driftTimer = null;
    }
    if (this._pulseTimer) {
      clearInterval(this._pulseTimer);
      this._pulseTimer = null;
    }
    if (this._graph) {
      this._graph._destructor?.();
      this._graph = null;
    }
    this._currentNodes.clear();
    this._positionCache.clear();
    this._labelSprites.clear();
    this._textureCache.clear();
  }

  // ──────────────────────────────────────────
  // Icon sprites — only created for nodes with imageUrl
  // ──────────────────────────────────────────

  private _createIconSprite(node: GraphNode): any {
    const THREE = this._THREE;
    if (!THREE || !node.imageUrl) return undefined;

    const radius = this._hexPainter.getRadius(node);
    const size = Math.max(radius * 2.5, 6);
    const url = node.imageUrl;

    if (url.startsWith('data:image/svg+xml')) {
      return this._createSvgSprite(url, size, node);
    }

    let texture = this._textureCache.get(url);
    if (!texture) {
      texture = this._textureLoader.load(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      this._textureCache.set(url, texture);
    }

    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.9 });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(size, size, 1);
    return sprite;
  }

  private _createSvgSprite(dataUri: string, size: number, node: GraphNode): any {
    const THREE = this._THREE;

    let texture = this._textureCache.get(dataUri);
    if (texture) {
      const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(size, size, 1);
      return sprite;
    }

    const canvas = document.createElement('canvas');
    const res = 64;
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext('2d')!;

    const color = this._styleEngine.getNodeColor(node);
    ctx.beginPath();
    ctx.arc(res / 2, res / 2, res / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    const img = new Image();
    img.onload = () => {
      const pad = res * 0.2;
      ctx.drawImage(img, pad, pad, res - pad * 2, res - pad * 2);
      texture.needsUpdate = true;
    };
    img.src = dataUri;

    texture = new THREE.CanvasTexture(canvas);
    this._textureCache.set(dataUri, texture);

    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(size, size, 1);
    return sprite;
  }

  // ──────────────────────────────────────────
  // Proximity-based labels (updated every 500ms)
  // ──────────────────────────────────────────

  private _updateProximityLabels(): void {
    const THREE = this._THREE;
    if (!this._graph || !THREE) return;

    const camera = this._graph.camera();
    if (!camera) return;

    const camPos = camera.position;
    const nodeCount = this._currentNodes.size;
    if (nodeCount === 0) return;

    const maxLabels = Math.max(3, Math.ceil(nodeCount * this._labelFraction));

    const candidates: Array<{ id: string; distSq: number }> = [];
    for (const [id, fn] of this._currentNodes) {
      if (!fn._graphNode?.label || fn._graphNode.label === fn._graphNode.id) continue;

      const dx = camPos.x - ((fn as any).x ?? 0);
      const dy = camPos.y - ((fn as any).y ?? 0);
      const dz = camPos.z - ((fn as any).z ?? 0);
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > this._labelMaxDistSq) continue;
      candidates.push({ id, distSq });
    }

    candidates.sort((a, b) => a.distSq - b.distSq);
    const showSet = new Map<string, number>();
    for (const c of candidates.slice(0, maxLabels)) {
      showSet.set(c.id, c.distSq);
    }

    // Focal/risk nodes: visible at 2x range
    const focalThreshSq = this._labelMaxDistSq * 4;
    for (const [id, fn] of this._currentNodes) {
      const gn = fn._graphNode;
      if (!gn?.label || gn.label === gn.id) continue;
      if (!(gn.sizeMultiplier && gn.sizeMultiplier > 1) && !gn.isHighRisk) continue;

      const dx = camPos.x - ((fn as any).x ?? 0);
      const dy = camPos.y - ((fn as any).y ?? 0);
      const dz = camPos.z - ((fn as any).z ?? 0);
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= focalThreshSq) showSet.set(id, distSq);
    }

    // Remove labels no longer visible
    for (const [id, sprite] of this._labelSprites) {
      if (!showSet.has(id)) {
        sprite.parent?.remove(sprite);
        sprite.material.map?.dispose();
        sprite.material.dispose();
        this._labelSprites.delete(id);
      }
    }

    // Add/update labels
    for (const [id, distSq] of showSet) {
      const fn = this._currentNodes.get(id);
      if (!fn?._graphNode?.label) continue;

      const radius = this._hexPainter.getRadius(fn._graphNode);
      const dist = Math.sqrt(distSq);
      const distFactor = Math.max(0.3, Math.min(1.0, 120 / Math.max(dist, 1)));

      const existing = this._labelSprites.get(id);
      if (existing) {
        const bw = existing.userData?.baseW ?? 1;
        const bh = existing.userData?.baseH ?? 1;
        existing.scale.set(bw * distFactor, bh * distFactor, 1);
        existing.material.opacity = 0.3 + distFactor * 0.6;
        continue;
      }

      const sprite = this._createLabelSprite(fn._graphNode.label);
      if (!sprite) continue;

      sprite.userData = { baseW: sprite.scale.x, baseH: sprite.scale.y };
      sprite.scale.set(sprite.scale.x * distFactor, sprite.scale.y * distFactor, 1);
      sprite.material.opacity = 0.3 + distFactor * 0.6;

      const nodeObj = (fn as any).__threeObj;
      if (nodeObj) {
        sprite.position.set(0, -radius - 2, 0);
        nodeObj.add(sprite);
        this._labelSprites.set(id, sprite);
      }
    }
  }

  private _createLabelSprite(text: string): any {
    const THREE = this._THREE;
    if (!THREE) return null;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const fontSize = 28;
    const truncated = text.length > 22 ? text.slice(0, 21) + '\u2026' : text;

    ctx.font = `500 ${fontSize}px system-ui, -apple-system, sans-serif`;
    const textWidth = ctx.measureText(truncated).width;

    canvas.width = textWidth + 12;
    canvas.height = fontSize + 8;

    ctx.fillStyle = 'rgba(10, 10, 20, 0.6)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 4);
    ctx.fill();

    ctx.font = `500 ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = '#d0d4dc';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncated, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(
      canvas.width * this._labelBaseScale,
      canvas.height * this._labelBaseScale,
      1
    );
    return sprite;
  }

  /**
   * Apply animation configuration: link particles and gentle drift.
   *
   * Note: 3d-force-graph doesn't expose d3AlphaTarget, so drift is achieved
   * by periodically reheating the simulation with a very low alpha decay.
   */
  applyAnimation(config: AnimationConfig): void {
    if (!this._graph) return;

    // Animation flags
    this._riskPulseEnabled = config.riskPulse ?? false;
    this._hoverTraceEnabled = config.hoverTrace ?? false;
    this._fadeInEnabled = config.fadeIn ?? false;

    // Risk pulse: periodically update nodeVal for high-risk nodes
    if (this._pulseTimer) {
      clearInterval(this._pulseTimer);
      this._pulseTimer = null;
    }
    if (this._riskPulseEnabled) {
      this._pulseTimer = setInterval(() => {
        this._animTime += 0.05;
        // Force a graph refresh to update nodeVal
        if (this._graph) this._graph.nodeVal(this._graph.nodeVal());
      }, 50);
    }

    const baseSpeed = config.linkParticleSpeed ?? 0.003;
    const baseColor = config.linkParticleColor ?? 'rgba(100,150,255,0.6)';
    const baseWidth = config.linkParticleWidth ?? 0.8;

    // Link particles (with optional hover trace)
    if (config.linkParticles || config.hoverTrace) {
      try {
        const particleCount = config.linkParticleCount ?? 1;
        if (this._hoverTraceEnabled) {
          this._graph
            .linkDirectionalParticles((link: any) => {
              if (!this._hoveredNodeId) return config.linkParticles ? particleCount : 0;
              const fl = link as ForceLink;
              const src = typeof fl.source === 'object' ? (fl.source as any).id : fl.source;
              const tgt = typeof fl.target === 'object' ? (fl.target as any).id : fl.target;
              return (src === this._hoveredNodeId || tgt === this._hoveredNodeId) ? 4 : (config.linkParticles ? particleCount : 0);
            })
            .linkDirectionalParticleSpeed((link: any) => {
              if (!this._hoveredNodeId) return baseSpeed;
              const fl = link as ForceLink;
              const src = typeof fl.source === 'object' ? (fl.source as any).id : fl.source;
              const tgt = typeof fl.target === 'object' ? (fl.target as any).id : fl.target;
              return (src === this._hoveredNodeId || tgt === this._hoveredNodeId) ? 0.015 : baseSpeed;
            })
            .linkDirectionalParticleWidth((link: any) => {
              if (!this._hoveredNodeId) return baseWidth;
              const fl = link as ForceLink;
              const src = typeof fl.source === 'object' ? (fl.source as any).id : fl.source;
              const tgt = typeof fl.target === 'object' ? (fl.target as any).id : fl.target;
              return (src === this._hoveredNodeId || tgt === this._hoveredNodeId) ? 2 : baseWidth;
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
      } catch {
        // Silently ignore if particle API is unavailable
      }
    } else {
      try { this._graph.linkDirectionalParticles(0); } catch { /* noop */ }
    }

    // Gentle drift: periodically reheat the simulation
    if (this._driftTimer) {
      clearInterval(this._driftTimer);
      this._driftTimer = null;
    }

    if (config.drift) {
      // Set very slow alpha decay so each reheat creates prolonged gentle motion
      this._graph.d3AlphaDecay(0.005);

      // Reheat every 8 seconds to keep the graph gently alive
      this._driftTimer = setInterval(() => {
        if (this._graph) {
          try { this._graph.d3ReheatSimulation(); } catch { /* noop */ }
        }
      }, 8000);

      // Initial reheat
      try { this._graph.d3ReheatSimulation(); } catch { /* noop */ }
    } else {
      // Restore normal alpha decay
      this._graph.d3AlphaDecay(0.05);
    }
  }

  /** Apply palette: update background color */
  applyPalette(palette: ColorPalette): void {
    if (!this._graph) return;
    this._graph.backgroundColor(palette.background);
  }
}

/** Simple numeric hash of a string (for phase-offsetting pulse animations) */
function simpleHash3d(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}
