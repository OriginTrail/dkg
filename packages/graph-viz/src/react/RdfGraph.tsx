import { useRef, useEffect, useState, useCallback, type ReactNode } from 'react';
import { RdfGraphViz } from '../core/rdf-graph-viz.js';
import type { RdfGraphVizConfig, GraphNode } from '../core/types.js';
import type { ViewConfig } from '../core/view-config.js';
import { RdfGraphContext } from './context.js';

/** Supported data formats for the `data` prop */
export type DataFormat = 'ntriples' | 'nquads' | 'turtle' | 'jsonld' | 'triples';

export interface RdfGraphProps {
  /** RDF data string (N-Triples, Turtle, etc.) or triple array */
  data?: string | Array<{ subject: string; predicate: string; object: string }>;
  /** Format of the data prop */
  format?: DataFormat;
  /** Visualization configuration */
  options?: RdfGraphVizConfig;
  /** Declarative view configuration (focal entity, highlights, icons) */
  viewConfig?: ViewConfig;
  /** Called when a node is clicked */
  onNodeClick?: (node: GraphNode) => void;
  /** Called when a node is hovered */
  onNodeHover?: (node: GraphNode) => void;
  /** Called when a node hover ends */
  onNodeUnhover?: (node: GraphNode) => void;
  /** CSS class name for the container div */
  className?: string;
  /** Inline styles for the container div */
  style?: React.CSSProperties;
  /** Run a single zoomToFit after the first data load (does not affect autoFitDisabled) */
  initialFit?: boolean;
  /** Child components (can use useRdfGraph hook to access viz instance) */
  children?: ReactNode;
}

/**
 * React wrapper for the RDF Graph Visualization.
 *
 * Manages the RdfGraphViz lifecycle: creates on mount, destroys on unmount.
 * Loads data when the `data` prop changes, applies view config reactively.
 *
 * @example
 * ```tsx
 * <RdfGraph
 *   data={ntriplesString}
 *   format="ntriples"
 *   options={{ labelMode: 'humanized', renderer: '2d' }}
 *   viewConfig={threatViewConfig}
 *   onNodeClick={(node) => console.log(node)}
 * />
 * ```
 */
export function RdfGraph({
  data,
  format = 'ntriples',
  options = {},
  viewConfig,
  initialFit,
  onNodeClick,
  onNodeHover,
  onNodeUnhover,
  className,
  style,
  children,
}: RdfGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const vizRef = useRef<RdfGraphViz | null>(null);
  const initialFitDoneRef = useRef(false);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  // Create/destroy viz instance
  useEffect(() => {
    if (!containerRef.current) return;

    const viz = new RdfGraphViz(containerRef.current, options);
    vizRef.current = viz;

    // Wire events
    const unsubs: Array<() => void> = [];

    unsubs.push(viz.on('node:click', (node) => {
      setSelectedNode(node);
      onNodeClick?.(node);
    }));

    unsubs.push(viz.on('node:hover', (node) => {
      setHoveredNode(node);
      onNodeHover?.(node);
    }));

    unsubs.push(viz.on('node:unhover', (node) => {
      setHoveredNode(null);
      onNodeUnhover?.(node);
    }));

    unsubs.push(viz.on('background:click', () => {
      setSelectedNode(null);
    }));

    return () => {
      unsubs.forEach((fn) => fn());
      viz.destroy();
      vizRef.current = null;
    };
    // Intentionally only run on mount/unmount — options changes require remount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load data when it changes
  useEffect(() => {
    const viz = vizRef.current;
    if (!viz || !data) return;

    // Clear previous data
    viz.model.clear();

    const loadData = async () => {
      if (typeof data === 'string') {
        switch (format) {
          case 'ntriples':
            await viz.loadNTriples(data);
            break;
          case 'nquads':
            await viz.loadNQuads(data);
            break;
          case 'turtle':
            await viz.loadTurtle(data);
            break;
          case 'jsonld':
            await viz.loadJsonLd(data);
            break;
          default:
            await viz.loadNTriples(data);
        }
      } else if (Array.isArray(data)) {
        viz.loadTriples(data);
      }

      // Apply per-node color overrides (e.g. trust-level coloring)
      if (options.style?.nodeColors) {
        viz.styleEngine.setNodeColors(options.style.nodeColors);
      }

      // Apply view config after loading data
      if (viewConfig) {
        viz.applyView(viewConfig);
      }
    };

    let cancelled = false;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    loadData().then(() => {
      if (cancelled) return;
      if (viz && initialFit && !initialFitDoneRef.current) {
        fitTimer = setTimeout(() => {
          if (!cancelled) {
            initialFitDoneRef.current = true;
            viz.zoomToFit();
          }
        }, 300);
      }
    }).catch((err) => {
      if (!cancelled) console.error('[RdfGraph] Error loading data:', err);
    });

    return () => { cancelled = true; if (fitTimer) clearTimeout(fitTimer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, format, viewConfig]);

  // Apply view config changes independently (when data hasn't changed)
  const prevViewConfigRef = useRef(viewConfig);
  useEffect(() => {
    const viz = vizRef.current;
    if (!viz || !viewConfig || viewConfig === prevViewConfigRef.current) return;
    prevViewConfigRef.current = viewConfig;

    viz.applyView(viewConfig);
    viz.refresh();
  }, [viewConfig]);

  // Memoized context value
  const contextValue = useCallback(() => ({
    viz: vizRef.current,
    selectedNode,
    hoveredNode,
  }), [selectedNode, hoveredNode]);

  return (
    <RdfGraphContext.Provider value={contextValue()}>
      <div
        ref={containerRef}
        className={className}
        style={{ width: '100%', height: '100%', ...style }}
      />
      {children}
    </RdfGraphContext.Provider>
  );
}
