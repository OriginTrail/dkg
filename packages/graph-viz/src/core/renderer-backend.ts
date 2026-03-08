import type { GraphNode, GraphEdge } from './types.js';
import type { HexagonPainter } from './hexagon-painter.js';
import type { StyleEngine } from './style-engine.js';
import type { GraphEventEmitter } from './events.js';
import type { AnimationConfig } from './view-config.js';
import type { ColorPalette } from './palette.js';

/**
 * Abstract rendering backend for the graph visualizer.
 *
 * Implementations wrap a specific rendering engine:
 * - Canvas2DRenderer: force-graph (HTML5 Canvas 2D)
 * - WebGL3DRenderer: 3d-force-graph (Three.js/WebGL)
 *
 * The backend is deliberately "dumb" — it only puts pixels on screen.
 * All intelligence (graph model, focus filtering, reification collapsing,
 * view config application) lives in the shared subsystems above the backend.
 *
 * Advanced users can implement custom renderers (WebXR, SVG, etc.)
 * by implementing this interface and passing it to RdfGraphViz.
 */
export interface RendererBackend {
  /** Initialize the rendering engine and attach to the container */
  init(): void;

  /**
   * Render the graph with the given nodes and edges.
   * Preserves positions of existing nodes for smooth transitions.
   *
   * @param nodes - Visible nodes (after focus filtering)
   * @param edges - Visible edges (after focus filtering)
   * @param collapsedNodeIds - Node IDs hidden by reification collapsing
   */
  render(
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>,
    collapsedNodeIds?: Set<string>
  ): void;

  /** Focus the camera on a specific node */
  centerOnNode(nodeId: string, durationMs?: number, zoomLevel?: number): void;

  /** Fit all visible nodes in view */
  zoomToFit(padding?: number, durationMs?: number): void;

  /** Repaint visuals without replacing graph data/layout state */
  refresh?(): void;

  /** Resize to fit container dimensions */
  resize(): void;

  /** Clean up all resources */
  destroy(): void;

  /**
   * Get the underlying rendering surface for export.
   * Returns HTMLCanvasElement for 2D, or the WebGL canvas for 3D.
   * Returns null if the renderer hasn't been initialized.
   */
  getCanvas(): HTMLCanvasElement | null;

  /** Apply animation configuration (particles, drift, etc.) */
  applyAnimation?(config: AnimationConfig): void;

  /** Apply a color palette (background, risk colors, etc.) */
  applyPalette?(palette: ColorPalette): void;

  /** Configure Knowledge Asset boundary groups (2D only initially) */
  setKaGroups?(groups: Map<string, Set<string>>, enabled: boolean, opacity?: number): void;
}

/**
 * Configuration needed to construct any renderer backend.
 * Passed by RdfGraphViz when creating the backend.
 */
export interface RendererBackendConfig {
  container: HTMLElement;
  hexPainter: HexagonPainter;
  styleEngine: StyleEngine;
  events: GraphEventEmitter;
}
