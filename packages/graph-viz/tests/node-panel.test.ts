// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodePanel, type NodePanelProps } from '../src/react/NodePanel.js';
import { RdfGraphContext } from '../src/react/context.js';
import { useRdfGraph } from '../src/react/useRdfGraph.js';
import type { GraphNode } from '../src/core/types.js';
import { GraphModelNode } from '../src/core/graph-node.js';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function node() {
  const value = new GraphModelNode('https://example.test/alice');
  value.label = 'Alice'; value.degree = 7;
  value.types = ['https://schema.org/Person', 'http://example.test/vocab#Researcher'];
  value.properties.set('https://schema.org/givenName', [{ value: 'Alice' }]);
  value.properties.set('urn:display/URLValue', [{ value: 'abcdefghijk' }, { value: 'short' }]);
  value.metadata.set('http://example.test/vocab#source_name', [{ value: 'private metadata' }]);
  return value;
}
function render(selectedNode: GraphModelNode | null, props: NodePanelProps = {}) {
  act(() => root.render(React.createElement(RdfGraphContext.Provider, { value: { viz: null, selectedNode, hoveredNode: null } },
    React.createElement(NodePanel, props))));
}

describe('selected node detail panel', () => {
  it('renders labels, local type names, humanized predicates and independently truncated values', () => {
    const selected = node();
    render(selected, { className: 'details', style: { color: 'red' }, maxValueLength: 8 });
    expect(container.querySelector('h3')?.textContent).toBe('Alice');
    expect(container.textContent).toContain(selected.id);
    expect(container.textContent).toContain('Person, Researcher');
    expect(container.textContent).toContain('Connections: 7');
    expect(container.textContent).toContain('Given Name: Alice');
    expect(container.textContent).toContain('URL Value: abcdefg…, short');
    expect(container.querySelector<HTMLElement>('.details')?.style.color).toBe('red');
    expect(container.textContent).not.toContain('private metadata');
    expect(selected.properties.get('urn:display/URLValue')?.[0].value).toBe('abcdefghijk');
  });

  it('honors field visibility independently and keeps metadata opt-in', () => {
    const selected = node();
    render(selected, { showUri: false, showTypes: false, showProperties: false, showMetadata: true });
    expect(container.textContent).toBe('AliceConnections: 7MetadataSource name: private metadata');
    render(selected, { showUri: true, showTypes: true, showProperties: true, showMetadata: false });
    expect(container.textContent).toContain('Properties');
    expect(container.textContent).not.toContain('Metadata');
  });

  it('escapes RDF text instead of treating values and labels as markup', () => {
    const selected = node(); selected.label = '<img src=x onerror=alert(1)>';
    selected.properties.set('urn:content', [{ value: '<script>window.bad = true</script>' }]);
    render(selected);
    expect(container.querySelectorAll('img, script')).toHaveLength(0);
    expect(container.textContent).toContain('<script>window.bad = true</script>');
    expect(container.querySelector('h3')?.textContent).toBe(selected.label);
  });

  it('replaces selected-node details and removes the panel when selection clears', () => {
    render(node());
    const next = new GraphModelNode('urn:bob'); next.label = 'Bob';
    render(next, { showMetadata: true });
    expect(container.textContent).toBe('Boburn:bobConnections: 0');
    expect(container.querySelector('h4')).toBeNull();
    render(null); expect(container.childNodes).toHaveLength(0);
  });

  it('gives custom renderers the selected node and permits a custom empty state', () => {
    const custom = vi.fn((selected: GraphNode | null) => React.createElement('output', null, selected?.id ?? 'Choose a node'));
    render(null, { renderNode: custom });
    expect(container.textContent).toBe('Choose a node');
    expect(custom).toHaveBeenLastCalledWith(null);
    const selected = node(); render(selected, { renderNode: custom });
    expect(custom).toHaveBeenLastCalledWith(selected);
    expect(container.textContent).toBe(selected.id); expect(container.querySelector('h3')).toBeNull();
  });

  it('exposes updated selection and hover references through the public hook', () => {
    const selected = node(); const hovered = new GraphModelNode('urn:hovered');
    let observed: ReturnType<typeof useRdfGraph>;
    function Probe() { observed = useRdfGraph(); return null; }
    act(() => root.render(React.createElement(Probe)));
    expect(observed!).toEqual({ viz: null, selectedNode: null, hoveredNode: null });
    act(() => root.render(React.createElement(RdfGraphContext.Provider, { value: { viz: null, selectedNode: selected, hoveredNode: hovered } }, React.createElement(Probe))));
    expect(observed!.selectedNode).toBe(selected); expect(observed!.hoveredNode).toBe(hovered);
  });
});
