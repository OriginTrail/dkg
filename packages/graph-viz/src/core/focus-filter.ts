import type { GraphNode, GraphEdge, FocusConfig } from './types.js';
import type { GraphModel } from './graph-model.js';

const DEFAULT_FOCUS: Required<FocusConfig> = {
  focalNode: null,
  hops: 2,
  maxNodes: 200,
  expandOnClick: true,
};

/**
 * Filters a large GraphModel down to a renderable subgraph
 * centered around a focal node with N-hop expansion.
 */
export class FocusFilter {
  private _config: Required<FocusConfig>;
  private _visibleNodes = new Set<string>();
  private _focalNode: string | null = null;
  private _enabled = false;

  constructor(config: FocusConfig | undefined) {
    this._config = { ...DEFAULT_FOCUS, ...config };
    this._focalNode = this._config.focalNode ?? null;
  }

  get focalNode(): string | null {
    return this._focalNode;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get visibleNodeIds(): ReadonlySet<string> {
    return this._visibleNodes;
  }

  /**
   * Compute the visible subgraph. Call this after data changes.
   * Automatically enables focus mode if the graph exceeds maxNodes.
   */
  compute(model: GraphModel): {
    nodes: Map<string, GraphNode>;
    edges: Map<string, GraphEdge>;
  } {
    // A refresh can replace every URI while keeping the same number of triples.
    // Reusing an absent focal node would otherwise produce an empty large graph.
    if (this._focalNode && !model.nodes.has(this._focalNode)) this._focalNode = null;
    // If graph is small enough, show everything
    if (model.nodes.size <= this._config.maxNodes) {
      this._enabled = false;
      this._visibleNodes.clear();
      // Mark all as non-boundary
      for (const node of model.nodes.values()) {
        node.isBoundary = false;
      }
      return { nodes: model.nodes, edges: model.edges };
    }

    this._enabled = true;

    // Pick focal node if not set
    if (!this._focalNode) {
      const best = model.getHighestDegreeNode();
      this._focalNode = best?.id ?? null;
    }

    if (!this._focalNode) {
      return { nodes: new Map(), edges: new Map() };
    }

    // BFS from focal node up to N hops
    this._visibleNodes.clear();
    const queue: Array<{ id: string; depth: number }> = [{ id: this._focalNode, depth: 0 }];
    this._visibleNodes.add(this._focalNode);

    while (queue.length > 0 && this._visibleNodes.size < this._config.maxNodes) {
      const current = queue.shift()!;

      if (current.depth >= this._config.hops) continue;

      const neighbors = model.getNeighborIds(current.id);
      for (const neighborId of neighbors) {
        if (this._visibleNodes.size >= this._config.maxNodes) break;

        if (!this._visibleNodes.has(neighborId)) {
          this._visibleNodes.add(neighborId);
          queue.push({ id: neighborId, depth: current.depth + 1 });
        }
      }
    }

    // Build filtered node/edge maps and mark boundary nodes
    const filteredNodes = new Map<string, GraphNode>();
    const filteredEdges = new Map<string, GraphEdge>();

    for (const id of this._visibleNodes) {
      const node = model.getNode(id);
      if (node) {
        // Check if this node has hidden neighbors (= boundary)
        const allNeighbors = model.getNeighborIds(id);
        node.isBoundary = false;
        for (const nid of allNeighbors) {
          if (!this._visibleNodes.has(nid)) {
            node.isBoundary = true;
            break;
          }
        }
        filteredNodes.set(id, node);
      }
    }

    for (const edge of model.edges.values()) {
      if (this._visibleNodes.has(edge.source) && this._visibleNodes.has(edge.target)) {
        filteredEdges.set(edge.id, edge);
      }
    }

    return { nodes: filteredNodes, edges: filteredEdges };
  }

  /** Change the focal node and recompute */
  setFocus(nodeId: string | null): void {
    this._focalNode = nodeId;
  }

  /** Expand a boundary node: add it as a secondary focus point */
  expandNode(nodeId: string, model: GraphModel): void {
    // Add the node's immediate neighbors to visible set
    const neighbors = model.getNeighborIds(nodeId);
    for (const nid of neighbors) {
      this._visibleNodes.add(nid);
    }
  }

  /** Disable focus filtering (show all) */
  disable(): void {
    this._enabled = false;
    this._visibleNodes.clear();
  }

  /** Re-enable with current or new config */
  enable(focalNode?: string): void {
    this._enabled = true;
    if (focalNode) this._focalNode = focalNode;
  }
}
