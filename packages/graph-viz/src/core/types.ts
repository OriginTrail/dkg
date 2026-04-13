// ============================================================
// @origintrail/dkg-graph-viz — Core Type Definitions
// ============================================================

// --- RDF Primitives ---

/** An RDF term: named node (URI), blank node, or literal */
export type RdfTerm =
  | { termType: 'NamedNode'; value: string }
  | { termType: 'BlankNode'; value: string }
  | { termType: 'Literal'; value: string; datatype?: string; language?: string };

/** A single RDF triple/quad */
export interface RdfTriple {
  subject: string;
  predicate: string;
  object: string;
  /** Optional: datatype URI for literal objects */
  datatype?: string;
  /** Optional: language tag for literal objects */
  language?: string;
  /** Optional: graph name for quads */
  graph?: string;
}

// --- Graph Model ---

/** An RDF value (literal) attached to a node as a property */
export interface RdfValue {
  value: string;
  datatype?: string;
  language?: string;
  /** Metadata annotations from collapsed reification statements */
  annotations?: PropertyAnnotation[];
}

/** Metadata from a collapsed reified statement attached to a property */
export interface PropertyAnnotation {
  predicate: string;
  value: string;
  datatype?: string;
}

/** A node in the visual graph (represents an RDF subject/object URI or blank node) */
export interface GraphNode {
  /** URI or blank node ID — stable across updates */
  id: string;
  /** rdf:type values (full URIs) */
  types: string[];
  /** Resolved display label (depends on label mode) */
  label: string;
  /** Literal properties: predicate URI → values */
  properties: Map<string, RdfValue[]>;
  /** Resolved image URL for avatar rendering (null if none found) */
  imageUrl: string | null;
  /** Extracted metadata properties (provenance, timestamps, etc.) */
  metadata: Map<string, RdfValue[]>;
  /** Number of edges connected to this node (in + out) */
  degree: number;
  /** Whether this is a boundary node (has hidden neighbors in focus mode) */
  isBoundary: boolean;
  /** Optional risk/threat score for visual emphasis (set by application code) */
  riskScore?: number;
  /** Whether this node is in the top-N risk tier (set by application code) */
  isHighRisk?: boolean;
  /** Optional size multiplier for featured/focal nodes (set by application code) */
  sizeMultiplier?: number;

  /** Resolved provenance info (set by ProvenanceResolver) */
  provenance?: ProvenanceInfo;
}

/** Provenance information for a graph node */
export interface ProvenanceInfo {
  /** Data source URIs that contributed to this node's data */
  sources: string[];
  /** Human-readable names for the data sources */
  sourceNames: string[];
  /** ISO timestamp of when this data was generated */
  generatedAt?: string;
  /** URI of the agent/model that generated this data */
  generatedBy?: string;
  /** Human-readable name of the generating agent */
  generatedByName?: string;
  /** Cryptographic content hash for data integrity */
  contentHash?: string;
  /** DKG Uniform Asset Locator */
  ual?: string;
  /** Blockchain anchoring info */
  blockchainAnchor?: {
    chain?: string;
    txHash?: string;
    blockNumber?: number;
  };
}

/** An edge in the visual graph (represents an RDF triple with URI/bnode object) */
export interface GraphEdge {
  /** Deterministic ID: `${subject}\0${predicate}\0${object}` */
  id: string;
  /** Source node URI */
  source: string;
  /** Target node URI */
  target: string;
  /** Predicate URI */
  predicate: string;
  /** Resolved display label (depends on label mode) */
  label: string;
}

/** Set of changes from an incremental update */
export interface ChangeSet {
  addedNodes: string[];
  removedNodes: string[];
  addedEdges: string[];
  removedEdges: string[];
  modifiedNodes: string[];
}

/** Prefix map: prefix string → namespace URI */
export type PrefixMap = Record<string, string>;

// --- Configuration ---

export type LabelMode = 'strict' | 'humanized';

export interface LabelConfig {
  /** Predicates to check for display labels, in priority order */
  predicates?: string[];
}

export interface HexagonConfig {
  /** Base hexagon radius in pixels */
  baseSize?: number;
  /** Minimum hexagon radius */
  minSize?: number;
  /** Maximum hexagon radius */
  maxSize?: number;
  /** Whether hexagon size scales with node degree */
  scaleWithDegree?: boolean;
  /** Predicates to check for image URLs (direct or via intermediate node) */
  imagePredicates?: string[];
  /** Predicate to follow on intermediate image nodes to get the actual URL */
  imageUrlPredicate?: string;
  /**
   * RDF type URIs (full or compact) that should render as simple filled circles
   * instead of hexagons. Much faster to draw — use for high-count, low-priority
   * node types like SentimentAnalysis, ImageObject, Keyword, etc.
   */
  circleTypes?: string[];
}

export interface StyleConfig {
  /** Per-node colors keyed by node URI — highest priority, wins over all other rules */
  nodeColors?: Record<string, string>;
  /** Per rdf:type class colors */
  classColors?: Record<string, string>;
  /** Per namespace prefix colors (applies to nodes whose types fall in that namespace) */
  namespaceColors?: Record<string, string>;
  /** Per predicate edge colors */
  predicateColors?: Record<string, string>;
  /** Enable subtle radial gradient on nodes */
  gradient?: boolean;
  /** Gradient intensity (0.0 = flat, 1.0 = strong gradient). Default: 0.3 */
  gradientIntensity?: number;
  /** Default node color */
  defaultNodeColor?: string;
  /** Default edge color */
  defaultEdgeColor?: string;
  /** Edge width */
  edgeWidth?: number;
  /** Edge arrow size (0 = no arrows) */
  edgeArrowSize?: number;
  /** Node border width */
  borderWidth?: number;
  /** Font family for labels */
  fontFamily?: string;
  /** Font size for labels */
  fontSize?: number;
}

export interface FocusConfig {
  /** URI of the initial focal node. If null, auto-selects highest-degree node. */
  focalNode?: string | null;
  /** Number of hops from focal node to include. Default: 2 */
  hops?: number;
  /** Maximum number of nodes to render. Default: 200 */
  maxNodes?: number;
  /** Whether clicking a boundary node expands its neighborhood. Default: true */
  expandOnClick?: boolean;
}

export interface ReificationPattern {
  /** rdf:type of the reification statement node */
  statementType: string;
  /** Predicate linking statement to the reified subject */
  subjectPredicate: string;
  /** Predicate linking statement to the reified predicate */
  predicatePredicate: string;
  /** Predicate linking statement to the reified object/value */
  objectPredicate: string;
}

export interface ReificationConfig {
  /** Enable reification collapsing. Default: false */
  enabled?: boolean;
  /** Patterns to detect. Ships with standard rdf:Statement pattern. */
  patterns?: ReificationPattern[];
}

export interface MetadataConfig {
  /** Predicates whose values are treated as metadata (shown in panel, not as edges) */
  predicates?: string[];
}

/** Full configuration for the visualization */
export interface RdfGraphVizConfig {
  /** Label display mode */
  labelMode?: LabelMode;
  /** Label resolution config */
  labels?: LabelConfig;
  /** Hexagon rendering config */
  hexagon?: HexagonConfig;
  /** Style/color config */
  style?: StyleConfig;
  /** Focus/filter config for large graphs */
  focus?: FocusConfig;
  /** Reification collapsing config */
  reification?: ReificationConfig;
  /** Metadata extraction config */
  metadata?: MetadataConfig;
  /** Known namespace prefixes */
  prefixes?: PrefixMap;
  /**
   * Rendering backend: '2d' (Canvas, default) or '3d' (WebGL/Three.js).
   * 3D mode requires `3d-force-graph` and `three` as peer dependencies.
   */
  renderer?: '2d' | '3d';
  /** Disable automatic zoomToFit when the force simulation settles. */
  autoFitDisabled?: boolean;
}

// --- Events ---

export type GraphEventType =
  | 'node:click'
  | 'node:hover'
  | 'node:unhover'
  | 'edge:click'
  | 'edge:hover'
  | 'edge:unhover'
  | 'background:click'
  | 'focus:change'
  | 'data:change'
  | 'temporal:change';

export interface GraphEventMap {
  'node:click': GraphNode;
  'node:hover': GraphNode;
  'node:unhover': GraphNode;
  'edge:click': GraphEdge;
  'edge:hover': GraphEdge;
  'edge:unhover': GraphEdge;
  'background:click': { x: number; y: number };
  'focus:change': { focalNode: string | null; visibleNodes: number };
  'data:change': ChangeSet;
  'temporal:change': { cursor: Date; visibleCount: number; totalDated: number };
}

export type GraphEventHandler<T extends GraphEventType> = (data: GraphEventMap[T]) => void;

// --- Renderer internals (used by force-graph integration) ---

export interface ForceNode {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  /** Reference to the GraphNode data */
  _graphNode: GraphNode;
}

export interface ForceLink {
  source: string | ForceNode;
  target: string | ForceNode;
  /** Reference to the GraphEdge data */
  _graphEdge: GraphEdge;
}
