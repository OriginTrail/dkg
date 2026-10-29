// @origintrail/dkg-graph-viz — Main entry point

// Primary API
export { RdfGraphViz } from './core/rdf-graph-viz.js';

// View Config — declarative visual rules
export type { ViewConfig, NodeTypeConfig, FocalConfig, HighlightConfig, SizeByConfig, PlatformIconConfig, TooltipConfig, TooltipFieldConfig, AnimationConfig, TrustConfig, KnowledgeAssetConfig } from './core/view-config.js';
export { applyViewConfig } from './core/view-config.js';

// Temporal timeline
export type { TemporalConfig } from './core/temporal-filter.js';
export { TemporalFilter } from './core/temporal-filter.js';
export { TimelineOverlay } from './overlays/timeline-overlay.js';

// Color Palette
export type { ColorPalette } from './core/palette.js';
export { resolvePalette, injectPaletteCssVars, PALETTES, PALETTE_DARK, PALETTE_MIDNIGHT, PALETTE_CYBERPUNK, PALETTE_LIGHT } from './core/palette.js';

// Data Sources — connect to knowledge graphs
export { OxigraphSource } from './data-sources/oxigraph-source.js';
export { RemoteSparqlSource } from './data-sources/remote-sparql-source.js';
export type { GraphDataSource, SparqlSelectResult, SparqlConstructResult, SparqlBinding } from './data-sources/types.js';
export type { RemoteSparqlConfig } from './data-sources/remote-sparql-source.js';

// Renderer backends
export type { RendererBackend, RendererBackendConfig } from './core/renderer-backend.js';
export { Canvas2DRenderer } from './core/renderer.js';

// Core classes (for advanced usage)
export { GraphModel } from './core/graph-model.js';
export { PrefixManager } from './core/prefix-manager.js';
export { LabelResolver } from './core/label-resolver.js';
export { StyleEngine } from './core/style-engine.js';
export { HexagonPainter } from './core/hexagon-painter.js';
export { FocusFilter } from './core/focus-filter.js';
export { ReificationCollapser } from './core/reification-collapser.js';
export { MetadataExtractor } from './core/metadata-extractor.js';
export { ProvenanceResolver } from './core/provenance-resolver.js';
export { GraphEventEmitter } from './core/events.js';

// Types
export type {
  // RDF primitives
  RdfTerm,
  RdfTriple,
  RdfValue,
  PropertyAnnotation,
  // Graph model
  GraphNode,
  NodeDecorations,
  GraphEdge,
  ProvenanceInfo,
  ChangeSet,
  PrefixMap,
  // Configuration
  RdfGraphVizConfig,
  LabelMode,
  LabelConfig,
  HexagonConfig,
  StyleConfig,
  FocusConfig,
  ReificationConfig,
  ReificationPattern,
  MetadataConfig,
  // Events
  GraphEventType,
  GraphEventMap,
  GraphEventHandler,
} from './core/types.js';
