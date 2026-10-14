import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryStackView } from '../../src/ui/views/MemoryStackView.js';
import { AgentProfilePage } from '../../src/ui/components/AgentProfilePage.js';
import { useProjectsStore } from '../../src/ui/stores/projects.js';
import { RdfGraphViz } from '../../../graph-viz/src/core/rdf-graph-viz.js';
const cg = '0x1111111111111111111111111111111111111111/browser-preview';
useProjectsStore.setState({ contextGraphs: [{ id: cg, name: 'Browser preview' } as any] });
function Scene() {
  const container = useRef<HTMLDivElement>(null);
  const viz = useRef<RdfGraphViz | null>(null);
  useEffect(() => {
    const graph = new RdfGraphViz(container.current!, { renderer: '3d' }); viz.current = graph;
    graph.loadTriples([{ subject: 'urn:a', predicate: 'urn:p', object: 'urn:b' }]);
    graph.applyView({ name: 'icon', focal: { uri: 'urn:a', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } });
    (window as any).regressionViz = graph;
    return () => { graph.destroy(); delete (window as any).regressionViz; };
  }, []);
  return <><button onClick={() => viz.current?.refresh()}>Redraw scene</button><div ref={container} style={{ width: 700, height: 500 }} /></>;
}
const view = new URLSearchParams(location.search).get('view');
createRoot(document.getElementById('root')!).render(view === 'scene' ? <Scene /> : view === 'agent'
  ? <AgentProfilePage contextGraphId={cg} agentUri="urn:dkg:agent:late-author" /> : <MemoryStackView />);
