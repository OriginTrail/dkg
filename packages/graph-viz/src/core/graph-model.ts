import type {
  RdfTriple,
  RdfValue,
  GraphNode,
  GraphEdge,
  ChangeSet,
  PrefixMap,
} from './types.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Determine if an object value looks like a URI (named node) or blank node.
 * URIs are absolute IRIs (`scheme:`) or are wrapped in <>.
 * Blank nodes start with _: prefix.
 */
function isResourceObject(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('"')) return false;
  if (trimmed.startsWith('_:')) return true;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return true;
  if (/\s/.test(trimmed)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

/** Strip angle brackets from a URI if present */
function cleanUri(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Generate a deterministic edge ID */
function edgeId(subject: string, predicate: string, object: string): string {
  return `${subject}\0${predicate}\0${object}`;
}

/**
 * Subject-centric RDF graph model for visualization.
 *
 * - Literal objects → stored as properties on the subject node
 * - URI/blank node objects → stored as edges between nodes
 * - rdf:type → stored in node.types, not as an edge
 *
 * Supports incremental add/remove with stable node and edge IDs.
 *
 * Maintains adjacency indexes (_outEdges, _inEdges) for O(degree) edge
 * lookups instead of O(E) full scans. These are used by FocusFilter BFS,
 * ReificationCollapser, and ViewConfig application on the render hot path.
 */
export class GraphModel {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  prefixes: PrefixMap = {};

  /** All raw triples stored for reification processing and export */
  private _triples: RdfTriple[] = [];

  /** Set of predicate URIs treated as metadata (not rendered as edges) */
  private _metadataPredicates = new Set<string>();

  /** Adjacency index: nodeId → Set of edge IDs originating from this node */
  private _outEdges = new Map<string, Set<string>>();

  /** Adjacency index: nodeId → Set of edge IDs pointing to this node */
  private _inEdges = new Map<string, Set<string>>();

  /** Knowledge Asset groups: KA URI → Set of member node IDs */
  readonly kaGroups = new Map<string, Set<string>>();

  /** Predicate used for KA membership (set via setKaMembershipPredicate) */
  private _kaMembershipPredicate: string | null = null;

  constructor(metadataPredicates?: string[]) {
    if (metadataPredicates) {
      for (const p of metadataPredicates) {
        this._metadataPredicates.add(p);
      }
    }
  }

  /** Get all stored triples */
  get triples(): readonly RdfTriple[] {
    return this._triples;
  }

  /** Set the predicate used for Knowledge Asset membership grouping */
  setKaMembershipPredicate(predicate: string | null): void {
    this._kaMembershipPredicate = predicate;
  }

  /** Get or create a node */
  private ensureNode(id: string): GraphNode {
    let node = this.nodes.get(id);
    if (!node) {
      node = {
        id,
        types: [],
        label: id,
        properties: new Map(),
        imageUrl: null,
        metadata: new Map(),
        degree: 0,
        isBoundary: false,
      };
      this.nodes.set(id, node);
    }
    return node;
  }

  /** Ensure adjacency sets exist for a node */
  private ensureAdjacency(id: string): void {
    if (!this._outEdges.has(id)) this._outEdges.set(id, new Set());
    if (!this._inEdges.has(id)) this._inEdges.set(id, new Set());
  }

  /** Add a single triple to the model */
  addTriple(triple: RdfTriple): void {
    this._triples.push(triple);

    const subj = cleanUri(triple.subject);
    const pred = cleanUri(triple.predicate);
    const obj = cleanUri(triple.object);

    const subjectNode = this.ensureNode(subj);

    // rdf:type → add to node types, don't create edge
    if (pred === RDF_TYPE) {
      if (!subjectNode.types.includes(obj)) {
        subjectNode.types.push(obj);
      }
      return;
    }

    // Check if object is a resource (URI/bnode) or a literal
    const objectIsResource = isResourceObject(triple.object);

    if (objectIsResource) {
      // Metadata predicates → store as metadata properties, not edges
      if (this._metadataPredicates.has(pred)) {
        const val: RdfValue = {
          value: obj,
          datatype: triple.datatype,
          language: triple.language,
        };
        const existing = subjectNode.metadata.get(pred);
        if (existing) {
          existing.push(val);
        } else {
          subjectNode.metadata.set(pred, [val]);
        }
        return;
      }

      // Resource object → create edge + ensure target node
      const targetNode = this.ensureNode(obj);
      const eid = edgeId(subj, pred, obj);

      if (!this.edges.has(eid)) {
        this.edges.set(eid, {
          id: eid,
          source: subj,
          target: obj,
          predicate: pred,
          label: pred,
        });
        subjectNode.degree++;
        targetNode.degree++;

        // Maintain adjacency indexes
        this.ensureAdjacency(subj);
        this.ensureAdjacency(obj);
        this._outEdges.get(subj)!.add(eid);
        this._inEdges.get(obj)!.add(eid);
      }

      // Track KA membership
      if (this._kaMembershipPredicate && pred === this._kaMembershipPredicate) {
        let members = this.kaGroups.get(obj);
        if (!members) {
          members = new Set();
          this.kaGroups.set(obj, members);
        }
        members.add(subj);
      }
    } else {
      // Literal object → store as property or metadata
      const val: RdfValue = {
        value: triple.object,
        datatype: triple.datatype,
        language: triple.language,
      };

      if (this._metadataPredicates.has(pred)) {
        const existing = subjectNode.metadata.get(pred);
        if (existing) {
          existing.push(val);
        } else {
          subjectNode.metadata.set(pred, [val]);
        }
      } else {
        const existing = subjectNode.properties.get(pred);
        if (existing) {
          existing.push(val);
        } else {
          subjectNode.properties.set(pred, [val]);
        }
      }
    }
  }

  /** Add multiple triples and return the changeset */
  addTriples(triples: RdfTriple[]): ChangeSet {
    const nodesBefore = new Set(this.nodes.keys());
    const edgesBefore = new Set(this.edges.keys());

    for (const t of triples) {
      this.addTriple(t);
    }

    const addedNodes: string[] = [];
    const addedEdges: string[] = [];
    const modifiedNodes = new Set<string>();

    for (const id of this.nodes.keys()) {
      if (!nodesBefore.has(id)) {
        addedNodes.push(id);
      } else {
        modifiedNodes.add(id);
      }
    }

    for (const id of this.edges.keys()) {
      if (!edgesBefore.has(id)) {
        addedEdges.push(id);
      }
    }

    return {
      addedNodes,
      removedNodes: [],
      addedEdges,
      removedEdges: [],
      modifiedNodes: [...modifiedNodes],
    };
  }

  /** Remove triples matching the given criteria and return changeset */
  removeTriples(triples: RdfTriple[]): ChangeSet {
    const removedEdges: string[] = [];
    const modifiedNodes = new Set<string>();

    for (const triple of triples) {
      const subj = cleanUri(triple.subject);
      const pred = cleanUri(triple.predicate);
      const obj = cleanUri(triple.object);

      // Remove from raw triples
      const idx = this._triples.findIndex(
        (t) => t.subject === triple.subject && t.predicate === triple.predicate && t.object === triple.object
      );
      if (idx !== -1) this._triples.splice(idx, 1);

      if (pred === RDF_TYPE) {
        const node = this.nodes.get(subj);
        if (node) {
          node.types = node.types.filter((t) => t !== obj);
          modifiedNodes.add(subj);
        }
        continue;
      }

      const objectIsResource = isResourceObject(triple.object);

      if (objectIsResource && !this._metadataPredicates.has(pred)) {
        const eid = edgeId(subj, pred, obj);
        if (this.edges.has(eid)) {
          this.edges.delete(eid);
          removedEdges.push(eid);

          // Maintain adjacency indexes
          this._outEdges.get(subj)?.delete(eid);
          this._inEdges.get(obj)?.delete(eid);

          const srcNode = this.nodes.get(subj);
          const tgtNode = this.nodes.get(obj);
          if (srcNode) srcNode.degree--;
          if (tgtNode) tgtNode.degree--;

          modifiedNodes.add(subj);
          modifiedNodes.add(obj);
        }
      } else {
        const node = this.nodes.get(subj);
        if (node) {
          const store = this._metadataPredicates.has(pred) ? node.metadata : node.properties;
          const vals = store.get(pred);
          if (vals) {
            const filtered = vals.filter((v) => v.value !== triple.object);
            if (filtered.length === 0) {
              store.delete(pred);
            } else {
              store.set(pred, filtered);
            }
            modifiedNodes.add(subj);
          }
        }
      }
    }

    // Remove orphan nodes (no edges, no properties, no types)
    const removedNodes: string[] = [];
    for (const [id, node] of this.nodes) {
      if (
        node.degree === 0 &&
        node.types.length === 0 &&
        node.properties.size === 0 &&
        node.metadata.size === 0
      ) {
        this.nodes.delete(id);
        this._outEdges.delete(id);
        this._inEdges.delete(id);
        removedNodes.push(id);
      }
    }

    return {
      addedNodes: [],
      removedNodes,
      addedEdges: [],
      removedEdges,
      modifiedNodes: [...modifiedNodes],
    };
  }

  /** Get a node by ID */
  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Get all edges originating from a node — O(degree) via adjacency index */
  getEdgesFrom(id: string): GraphEdge[] {
    const edgeIds = this._outEdges.get(id);
    if (!edgeIds) return [];
    const result: GraphEdge[] = [];
    for (const eid of edgeIds) {
      const edge = this.edges.get(eid);
      if (edge) result.push(edge);
    }
    return result;
  }

  /** Get all edges pointing to a node — O(degree) via adjacency index */
  getEdgesTo(id: string): GraphEdge[] {
    const edgeIds = this._inEdges.get(id);
    if (!edgeIds) return [];
    const result: GraphEdge[] = [];
    for (const eid of edgeIds) {
      const edge = this.edges.get(eid);
      if (edge) result.push(edge);
    }
    return result;
  }

  /** Get all neighbor node IDs (both directions) — O(degree) via adjacency index */
  getNeighborIds(id: string): Set<string> {
    const neighbors = new Set<string>();
    const outIds = this._outEdges.get(id);
    if (outIds) {
      for (const eid of outIds) {
        const edge = this.edges.get(eid);
        if (edge) neighbors.add(edge.target);
      }
    }
    const inIds = this._inEdges.get(id);
    if (inIds) {
      for (const eid of inIds) {
        const edge = this.edges.get(eid);
        if (edge) neighbors.add(edge.source);
      }
    }
    return neighbors;
  }

  /** Get the node with the highest degree */
  getHighestDegreeNode(): GraphNode | null {
    let best: GraphNode | null = null;
    for (const node of this.nodes.values()) {
      if (!best || node.degree > best.degree) {
        best = node;
      }
    }
    return best;
  }

  /** Clear all data */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this._triples = [];
    this._outEdges.clear();
    this._inEdges.clear();
  }

  /** Total number of triples */
  get tripleCount(): number {
    return this._triples.length;
  }
}
