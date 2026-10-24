import React from 'react';
import { LayerGraphPanel } from '../../src/ui/views/project/components/graph.js';
import { Canvas2DRenderer } from '../../../graph-viz/src/core/renderer.js';
import { WebGL3DRenderer } from '../../../graph-viz/src/core/renderer-3d.js';
import type { RendererBackend } from '../../../graph-viz/src/core/renderer-backend.js';
import '../../src/ui/styles.css';

// Observe the real backend handoff; text and mocked React props cannot prove
// that changing the cap rebuilt the mounted visualization.
for (const backend of [Canvas2DRenderer, WebGL3DRenderer] as Array<{ prototype: RendererBackend }>) {
  const render = backend.prototype.render;
  backend.prototype.render = function(nodes, edges, collapsed) {
    render.call(this, nodes, edges, collapsed);
    const engine = (this as unknown as { _graph?: { graphData(): { nodes: Array<{ id: string }> } } })._graph;
    (window as any).largeGraphRenderedIds = engine?.graphData().nodes.map(node => node.id) ?? [];
  };
}
const triples = [...Array.from({ length: 2998 }, (_, i) => ({
  subject: 'urn:large:root', predicate: 'urn:links', object: `urn:large:${i}`,
})), { subject: 'urn:disconnected:a', predicate: 'urn:links', object: 'urn:disconnected:b' }];
export function LargeGraph() {
  return <div style={{ width: 900, height: 600, display: 'flex' }}>
    <LayerGraphPanel layer="wm" triples={triples} />
  </div>;
}
