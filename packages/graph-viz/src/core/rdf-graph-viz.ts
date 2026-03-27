import type {
  RdfGraphVizConfig,
  RdfTriple,
  GraphNode,
  GraphEdge,
  GraphEventType,
  GraphEventHandler,
  LabelMode,
  ChangeSet,
} from './types.js';
import type { GraphDataSource } from '../data-sources/types.js';
import type { ViewConfig } from './view-config.js';
import type { RendererBackend } from './renderer-backend.js';
import { applyViewConfig } from './view-config.js';
import { resolvePalette, injectPaletteCssVars } from './palette.js';
import { ProvenanceResolver } from './provenance-resolver.js';
import { TemporalFilter } from './temporal-filter.js';
import { TimelineOverlay } from '../overlays/timeline-overlay.js';
import { GraphModel } from './graph-model.js';
import { PrefixManager } from './prefix-manager.js';
import { LabelResolver } from './label-resolver.js';
import { StyleEngine } from './style-engine.js';
import { HexagonPainter } from './hexagon-painter.js';
import { FocusFilter } from './focus-filter.js';
import { ReificationCollapser } from './reification-collapser.js';
import { MetadataExtractor } from './metadata-extractor.js';
import { GraphEventEmitter } from './events.js';
import { Canvas2DRenderer } from './renderer.js';

/**
 * Main entry point for the RDF Graph Visualization library.
 *
 * @example
 * ```typescript
 * const viz = new RdfGraphViz(document.getElementById('graph')!, {
 *   labelMode: 'humanized',
 *   style: { classColors: { 'schema:Person': '#7C3AED' } },
 *   focus: { hops: 2, maxNodes: 200 },
 * });
 *
 * await viz.loadNTriples(ntriplesString);
 * viz.on('node:click', (node) => console.log(node));
 * ```
 */
export class RdfGraphViz {
  private _model: GraphModel;
  private _prefixManager: PrefixManager;
  private _labelResolver: LabelResolver;
  private _styleEngine: StyleEngine;
  private _hexPainter: HexagonPainter;
  private _focusFilter: FocusFilter;
  private _reificationCollapser: ReificationCollapser;
  private _metadataExtractor: MetadataExtractor;
  private _events: GraphEventEmitter;
  private _renderer: RendererBackend;
  private _config: RdfGraphVizConfig;
  private _collapsedNodeIds = new Set<string>();
  private _rendererReady: Promise<void>;
  private _container: HTMLElement;
  private _temporalFilter: TemporalFilter;
  private _timelineOverlay: TimelineOverlay | null = null;
  private _renderQueued = false;
  private _autoFitDisabled = false;

  constructor(container: HTMLElement, config: RdfGraphVizConfig = {}) {
    this._config = config;
    this._container = container;

    // Initialize subsystems
    this._metadataExtractor = new MetadataExtractor(config.metadata);
    this._model = new GraphModel(this._metadataExtractor.predicates);
    this._prefixManager = new PrefixManager(config.prefixes);
    this._labelResolver = new LabelResolver(
      config.labelMode ?? 'humanized',
      this._prefixManager,
      config.labels
    );
    this._styleEngine = new StyleEngine(config.style, this._prefixManager);
    this._hexPainter = new HexagonPainter(config.hexagon, this._styleEngine, this._prefixManager);
    this._focusFilter = new FocusFilter(config.focus);
    this._reificationCollapser = new ReificationCollapser(config.reification);
    this._temporalFilter = new TemporalFilter();
    this._events = new GraphEventEmitter();

    const backendConfig = {
      container,
      hexPainter: this._hexPainter,
      styleEngine: this._styleEngine,
      events: this._events,
    };

    // Create renderer backend based on config (default: 2D canvas)
    if (config.renderer === '3d') {
      // Dynamic import for tree-shaking: 3d-force-graph only loaded when needed
      let resolveReady: () => void;
      this._rendererReady = new Promise((r) => { resolveReady = r; });

      // Temporary placeholder until async import resolves
      this._renderer = null as unknown as RendererBackend;

      import('./renderer-3d.js').then(({ WebGL3DRenderer }) => {
        this._renderer = new WebGL3DRenderer(backendConfig);
        resolveReady();
      }).catch((err) => {
        console.warn('[dkg-graph-viz] 3D renderer not available, falling back to 2D:', err.message);
        this._renderer = new Canvas2DRenderer(backendConfig);
        resolveReady();
      });
    } else {
      this._renderer = new Canvas2DRenderer(backendConfig);
      this._rendererReady = Promise.resolve();
    }

    if (config.autoFitDisabled) {
      this._autoFitDisabled = true;
      if (this._renderer) {
        this._renderer.autoFitDisabled = true;
      } else {
        this._rendererReady.then(() => {
          if (this._renderer) this._renderer.autoFitDisabled = true;
        });
      }
    }

    // Auto-resize on container resize
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this._renderer?.resize());
      observer.observe(container);
    }
  }

  // --- Data Loading ---

  /** Load N-Triples or N-Quads string */
  async loadNTriples(input: string): Promise<void> {
    const { parseNTriples } = await import('../parsers/ntriples.js');
    const triples = parseNTriples(input);
    this._ingest(triples);
  }

  /** Load N-Quads string */
  async loadNQuads(input: string): Promise<void> {
    const { parseNQuads } = await import('../parsers/ntriples.js');
    const triples = parseNQuads(input);
    this._ingest(triples);
  }

  /** Load Turtle string */
  async loadTurtle(input: string): Promise<void> {
    const { parseTurtle } = await import('../parsers/turtle.js');
    const { triples, prefixes } = parseTurtle(input);
    this._prefixManager.addPrefixes(prefixes);
    this._ingest(triples);
  }

  /** Load JSON-LD (object or string) */
  async loadJsonLd(input: Record<string, unknown> | string): Promise<void> {
    const { parseJsonLd } = await import('../parsers/jsonld.js');
    const triples = await parseJsonLd(input);
    this._ingest(triples);
  }

  /** Load raw triple array (synchronous — no parsing needed) */
  loadTriples(
    input: Array<RdfTriple | { s: string; p: string; o: string } | [string, string, string]>
  ): void {
    const triples: RdfTriple[] = input.map((item) => {
      if (Array.isArray(item)) {
        return { subject: item[0], predicate: item[1], object: item[2] };
      }
      if ('s' in item && 'p' in item && 'o' in item) {
        const spo = item as { s: string; p: string; o: string };
        return { subject: spo.s, predicate: spo.p, object: spo.o };
      }
      return item as RdfTriple;
    });
    this._ingest(triples);
  }

  // --- Data Source Loading ---

  /**
   * Load data from a GraphDataSource using a SPARQL CONSTRUCT query.
   *
   * This is the recommended way to load data from a knowledge graph.
   * The source can be an in-browser Oxigraph store or a remote SPARQL endpoint.
   *
   * @param source - A GraphDataSource (OxigraphSource, RemoteSparqlSource, etc.)
   * @param sparql - SPARQL CONSTRUCT query that returns the triples to visualize
   *
   * @example
   * ```typescript
   * const source = new OxigraphSource();
   * await source.init();
   * await source.loadNTriples(ntData);
   *
   * await viz.loadFromSource(source, `
   *   CONSTRUCT { ?s ?p ?o }
   *   WHERE {
   *     ?s a <https://schema.org/Person> ;
   *        ?p ?o .
   *   } LIMIT 5000
   * `);
   * ```
   */
  async loadFromSource(source: GraphDataSource, sparql: string): Promise<void> {
    const result = await source.construct(sparql);
    this._ingest(result.triples);
  }

  /**
   * Execute a SPARQL SELECT query against a data source.
   * Returns raw bindings — useful for analytics, counts, and lookups
   * without loading triples into the graph model.
   */
  async querySource(source: GraphDataSource, sparql: string) {
    return source.select(sparql);
  }

  // --- Incremental Updates ---

  /** Add triples to the existing graph */
  addTriples(triples: RdfTriple[]): ChangeSet {
    const changes = this._model.addTriples(triples);
    this._postIngest();
    this._events.emit('data:change', changes);
    return changes;
  }

  /** Remove triples from the graph */
  removeTriples(triples: RdfTriple[]): ChangeSet {
    const changes = this._model.removeTriples(triples);
    this._postIngest();
    this._events.emit('data:change', changes);
    return changes;
  }

  // --- Navigation ---

  /** Focus on a specific node with N-hop expansion */
  focus(nodeId: string, hops?: number): void {
    this._focusFilter.setFocus(nodeId);
    if (hops !== undefined) {
      this._focusFilter = new FocusFilter({
        ...this._config.focus,
        focalNode: nodeId,
        hops,
      });
    }
    this._renderCurrent();
    this._renderer?.centerOnNode(nodeId, 500, 2);
    this._events.emit('focus:change', {
      focalNode: nodeId,
      visibleNodes: this._focusFilter.visibleNodeIds.size,
    });
  }

  /** Recenter camera on a node without changing focus filter state. */
  centerOnNode(nodeId: string, opts?: { durationMs?: number; zoomLevel?: number }): void {
    this._renderer?.centerOnNode(nodeId, opts?.durationMs, opts?.zoomLevel);
  }

  /** Expand a boundary node's neighborhood */
  expandNode(nodeId: string): void {
    this._focusFilter.expandNode(nodeId, this._model);
    this._renderCurrent();
  }

  /** Show all nodes (disable focus filter) */
  showAll(): void {
    this._focusFilter.disable();
    this._renderCurrent();
  }

  // --- Timeline ---

  /** Get the temporal filter (for advanced usage) */
  get temporalFilter(): TemporalFilter {
    return this._temporalFilter;
  }

  /** Get the timeline overlay (for advanced usage, null if not enabled) */
  get timelineOverlay(): TimelineOverlay | null {
    return this._timelineOverlay;
  }

  /** Set the temporal cursor: only show nodes with dates up to this point */
  setTimeCursor(date: Date): void {
    this._temporalFilter.setCursor(date);
    this._renderCurrent();
    this._events.emit('temporal:change', {
      cursor: date,
      visibleCount: this._lastVisibleCount(),
      totalDated: this._temporalFilter.datedNodeCount,
    });
  }

  /** Get the date range of nodes in the graph */
  getDateRange(): [Date, Date] | null {
    return this._temporalFilter.dateRange;
  }

  /** Start timeline playback */
  playTimeline(): void {
    this._timelineOverlay?.play();
  }

  /** Pause timeline playback */
  pauseTimeline(): void {
    this._timelineOverlay?.pause();
  }

  /** Count visible nodes after last render (for event payloads) */
  private _lastVisibleCount(): number {
    const { nodes } = this._focusFilter.compute(this._model);
    const temporalVisible = this._temporalFilter.getVisibleNodeIds(nodes.keys());
    return temporalVisible ? temporalVisible.size : nodes.size;
  }

  /** Fit all visible nodes in view */
  zoomToFit(padding?: number): void {
    this._renderer?.zoomToFit(padding);
  }

  /** Prevent the renderer from automatically calling zoomToFit when the simulation settles. */
  set autoFitDisabled(value: boolean) {
    this._autoFitDisabled = value;
    if (this._renderer) {
      this._renderer.autoFitDisabled = value;
    } else {
      this._rendererReady.then(() => {
        if (this._renderer) this._renderer.autoFitDisabled = value;
      });
    }
  }

  // --- Label Mode ---

  /** Get current label mode */
  get labelMode(): LabelMode {
    return this._labelResolver.mode;
  }

  /** Set label mode and re-render */
  setLabelMode(mode: LabelMode): void {
    this._labelResolver.mode = mode;
    this._labelResolver.updateLabels(this._model.nodes, this._model.edges);
    this._renderCurrent();
  }

  // --- Events ---

  /** Subscribe to a graph event */
  on<T extends GraphEventType>(event: T, handler: GraphEventHandler<T>): () => void {
    return this._events.on(event, handler);
  }

  /** Unsubscribe from a graph event */
  off<T extends GraphEventType>(event: T, handler: GraphEventHandler<T>): void {
    this._events.off(event, handler);
  }

  // --- Accessors ---

  /** Get a node by ID */
  getNode(id: string): GraphNode | undefined {
    return this._model.getNode(id);
  }

  /** Get all edges from a node */
  getEdgesFrom(id: string): GraphEdge[] {
    return this._model.getEdgesFrom(id);
  }

  /** Get all edges to a node */
  getEdgesTo(id: string): GraphEdge[] {
    return this._model.getEdgesTo(id);
  }

  /** Get the underlying graph model (for advanced usage) */
  get model(): GraphModel {
    return this._model;
  }

  /** Get the prefix manager (for compact/expand operations) */
  get prefixes(): PrefixManager {
    return this._prefixManager;
  }

  // --- Highlight ---

  /** Saved visual state for highlighted nodes, used by clearHighlight() to revert */
  private _highlightState = new Map<string, {
    riskScore?: number;
    isHighRisk?: boolean;
    sizeMultiplier?: number;
  }>();

  /**
   * Visually emphasize a set of nodes without modifying underlying data.
   * Typically used to highlight SPARQL query results in the current view.
   *
   * @example
   * ```typescript
   * const result = await viz.querySource(kg, `
   *   SELECT ?post WHERE {
   *     ?post <https://schema.org/interactionCount> ?risk .
   *     FILTER(?risk > 50)
   *   }
   * `);
   * viz.highlightNodes(result.bindings.map(b => b.post));
   * ```
   */
  highlightNodes(nodeIds: string[]): void {
    // Revert any previous highlight first
    this.clearHighlight();

    const idSet = new Set(nodeIds);

    for (const [id, node] of this._model.nodes) {
      if (idSet.has(id)) {
        // Save current state for revert
        this._highlightState.set(id, {
          riskScore: node.riskScore,
          isHighRisk: node.isHighRisk,
          sizeMultiplier: node.sizeMultiplier,
        });

        // Apply highlight emphasis
        node.isHighRisk = true;
        if (!node.sizeMultiplier || node.sizeMultiplier < 2.0) {
          node.sizeMultiplier = 2.0;
        }
      }
    }

    if (this._renderer?.refresh) this._renderer.refresh();
    else this._renderCurrent();
  }

  /** Revert all highlighted nodes to their original visual state */
  clearHighlight(): void {
    if (this._highlightState.size === 0) return;

    for (const [id, saved] of this._highlightState) {
      const node = this._model.nodes.get(id);
      if (node) {
        node.riskScore = saved.riskScore;
        node.isHighRisk = saved.isHighRisk;
        node.sizeMultiplier = saved.sizeMultiplier;
      }
    }

    this._highlightState.clear();
    if (this._renderer?.refresh) this._renderer.refresh();
    else this._renderCurrent();
  }

  // --- Export ---

  /**
   * Export the current visualization as a PNG image.
   * Captures the canvas content from the active renderer backend.
   */
  async exportImage(): Promise<Blob> {
    const canvas = this._renderer.getCanvas();
    if (!canvas) {
      throw new Error('Cannot export: renderer not initialized or no canvas available');
    }

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob returned null'));
      }, 'image/png');
    });
  }

  /**
   * Export the current graph model as N-Triples string.
   * Serializes all triples currently loaded in the visualization.
   */
  exportTriples(): string {
    const lines: string[] = [];

    for (const triple of this._model.triples) {
      const subj = formatNTerm(triple.subject);
      const pred = formatNTerm(triple.predicate);

      if (triple.datatype || triple.language || !isUri(triple.object)) {
        // Literal
        let obj = `"${escapeNTriples(triple.object)}"`;
        if (triple.language) {
          obj += `@${triple.language}`;
        } else if (triple.datatype) {
          obj += `^^<${triple.datatype}>`;
        }
        lines.push(`${subj} ${pred} ${obj} .`);
      } else {
        lines.push(`${subj} ${pred} ${formatNTerm(triple.object)} .`);
      }
    }

    return lines.join('\n');
  }

  // --- Lifecycle ---

  /**
   * Apply a ViewConfig to the current graph.
   *
   * Sets focal entity styling, platform icons, risk/highlight scores,
   * and node type icons based on the declarative config.
   * Automatically calls refresh() to re-render.
   *
   * @example
   * ```typescript
   * await viz.loadFromSource(kg, sparql);
   * viz.applyViewConfig(config);
   * ```
   */
  applyView(config: ViewConfig): void {
    // Reset view-specific state to prevent previous view's styles from bleeding through
    this._styleEngine.resetClassColors();
    this._hexPainter.setCircleTypes([]);

    // Resolve and apply palette
    const palette = resolvePalette(config.palette, config.paletteOverrides);
    this._styleEngine.setPalette(palette);

    // Inject CSS custom properties for demo/app UIs
    injectPaletteCssVars(this._container, palette);

    // Bridge nodeTypes colors → StyleEngine classColors
    if (config.nodeTypes) {
      const classColors: Record<string, string> = {};
      for (const [typeUri, typeConfig] of Object.entries(config.nodeTypes)) {
        if (typeConfig.color) {
          classColors[typeUri] = typeConfig.color;
        }
      }
      this._styleEngine.setClassColors(classColors);
    }

    // Bridge circleTypes → HexagonPainter
    if (config.circleTypes) {
      this._hexPainter.setCircleTypes(config.circleTypes);
    }

    // Configure trust visualization
    if (config.trust?.enabled) {
      this._hexPainter.setTrustStyle(config.trust.style ?? 'border');
      this._hexPainter.setShowBadges(config.trust.showBadge !== false);
    } else {
      this._hexPainter.setTrustStyle('none');
    }

    applyViewConfig(config, this._model);

    // Resolve provenance for all nodes
    const provenanceResolver = new ProvenanceResolver();
    provenanceResolver.resolve(this._model);

    // Configure temporal filter
    if (config.temporal?.enabled) {
      this._temporalFilter = new TemporalFilter(config.temporal);
      this._temporalFilter.scan(this._model);

      // Mount timeline overlay if dates were found
      if (this._temporalFilter.dateRange) {
        // Unmount previous overlay if any
        this._timelineOverlay?.unmount();

        this._timelineOverlay = new TimelineOverlay(
          this._container,
          this._temporalFilter,
          config.temporal,
        );
        this._timelineOverlay.onChange((cursor) => {
          this._renderCurrent();
          this._events.emit('temporal:change', {
            cursor,
            visibleCount: this._lastVisibleCount(),
            totalDated: this._temporalFilter.datedNodeCount,
          });
        });
        this._timelineOverlay.mount();
      }
    } else {
      // Disable timeline if previously enabled
      this._timelineOverlay?.unmount();
      this._timelineOverlay = null;
    }

    this._renderCurrent();

    // Configure KA membership grouping
    if (config.knowledgeAssets?.enabled) {
      const kaPred = config.knowledgeAssets.membershipPredicate ?? 'dkg:partOfAsset';
      this._model.setKaMembershipPredicate(kaPred);
    }

    // Apply animation after renderer is fully ready (3D init is async)
    this._rendererReady.then(() => {
      if (config.animation && this._renderer?.applyAnimation) {
        this._renderer.applyAnimation(config.animation);
      }
      // Apply palette to renderer (background, etc.)
      if (this._renderer?.applyPalette) {
        this._renderer.applyPalette(palette);
      }
      // Apply KA boundaries
      if (config.knowledgeAssets?.enabled && this._renderer?.setKaGroups) {
        this._renderer.setKaGroups(
          this._model.kaGroups,
          config.knowledgeAssets.showBoundaries !== false,
          config.knowledgeAssets.boundaryOpacity ?? 0.06
        );
      }
    });
  }

  /** Force a visual re-render (call after modifying node properties externally) */
  refresh(): void {
    this._renderCurrent();
  }

  /** Destroy the visualization and clean up resources */
  destroy(): void {
    this._timelineOverlay?.unmount();
    this._timelineOverlay = null;
    this._renderer?.destroy();
    this._events.removeAll();
    this._model.clear();
    this._highlightState.clear();
  }

  // --- Internal ---

  /** Ingest triples, resolve labels/images, and render */
  private _ingest(triples: RdfTriple[]): void {
    this._model.addTriples(triples);
    this._postIngest();
  }

  /** Post-ingestion processing: resolve images, labels, collapse, render */
  private _postIngest(): void {
    // Resolve image URLs for all nodes (direct and indirect)
    for (const node of this._model.nodes.values()) {
      if (!node.imageUrl) {
        node.imageUrl = this._hexPainter.resolveImageUrl(
          node,
          (id) => this._model.getNode(id),
          (id) => this._model.getEdgesFrom(id)
        );
      }
    }

    // Resolve labels
    this._labelResolver.updateLabels(this._model.nodes, this._model.edges);

    // Collapse reified statements
    this._collapsedNodeIds = this._reificationCollapser.collapse(this._model);

    this._renderCurrent();
  }

  /** Render with current focus filter + temporal filter state */
  private _renderCurrent(): void {
    // In 3D mode, renderer module loads asynchronously.
    // Queue one deferred render instead of throwing on early data loads.
    if (!this._renderer) {
      if (!this._renderQueued) {
        this._renderQueued = true;
        this._rendererReady.then(() => {
          this._renderQueued = false;
          this._renderCurrent();
        });
      }
      return;
    }

    let { nodes, edges } = this._focusFilter.compute(this._model);

    // Apply temporal filter: hide nodes outside the current time window
    const temporalVisible = this._temporalFilter.getVisibleNodeIds(nodes.keys());
    if (temporalVisible) {
      const filteredNodes = new Map<string, GraphNode>();
      const filteredEdges = new Map<string, GraphEdge>();

      for (const [id, node] of nodes) {
        if (temporalVisible.has(id)) {
          filteredNodes.set(id, node);
        }
      }
      for (const [id, edge] of edges) {
        if (filteredNodes.has(edge.source) && filteredNodes.has(edge.target)) {
          filteredEdges.set(id, edge);
        }
      }

      nodes = filteredNodes;
      edges = filteredEdges;
    }

    this._renderer.render(nodes, edges, this._collapsedNodeIds);

    // Update timeline overlay count badge
    if (this._timelineOverlay?.mounted) {
      this._timelineOverlay.updateCount(nodes.size);
    }
  }
}

// --- N-Triples serialization helpers ---

function isUri(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') ||
         value.startsWith('urn:') || value.startsWith('_:');
}

function formatNTerm(uri: string): string {
  if (uri.startsWith('_:')) return uri;
  return `<${uri}>`;
}

function escapeNTriples(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
