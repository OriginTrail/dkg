import React from 'react';
import { LayerGraphPanel } from '../../src/ui/views/project/components/graph.js';
import '../../src/ui/styles.css';

const triples = Array.from({ length: 3000 }, (_, i) => ({
  subject: 'urn:large:root', predicate: 'urn:links', object: `urn:large:${i}`,
}));
export function LargeGraph() {
  return <div style={{ width: 900, height: 600, display: 'flex' }}>
    <LayerGraphPanel layer="wm" triples={triples} />
  </div>;
}
