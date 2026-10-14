// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ viz: null as any }));
vi.mock('../src/core/rdf-graph-viz.js', () => ({ RdfGraphViz: class {
  handlers = new Map<string, (value: any) => void>();
  clear = vi.fn(); loadTriples = vi.fn(); loadNTriples = vi.fn(async () => {});
  model = { clear: this.clear };
  applyView = vi.fn(); refresh = vi.fn(); destroy = vi.fn();
  styleEngine = { setNodeColors: vi.fn() };
  constructor() { state.viz = this; }
  on(name: string, callback: (value: any) => void) {
    this.handlers.set(name, callback); return () => this.handlers.delete(name);
  }
} }));
import { RdfGraph } from '../src/react/RdfGraph.js';

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('React graph updates', () => {
  it('uses the latest click handler without rebuilding data on a view-only update', async () => {
    const data = [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }];
    const first = vi.fn(); const latest = vi.fn();
    await act(async () => root.render(React.createElement(RdfGraph, { data, format: 'triples', onNodeClick: first })));
    await act(async () => root.render(React.createElement(RdfGraph, { data, format: 'triples', onNodeClick: latest, viewConfig: { name: 'new view' } as any })));
    act(() => state.viz.handlers.get('node:click')({ id: 'urn:s' }));
    expect(latest).toHaveBeenCalledWith({ id: 'urn:s' });
    expect(first).not.toHaveBeenCalled();
    expect(state.viz.loadTriples).toHaveBeenCalledOnce();
    expect(state.viz.clear).toHaveBeenCalledOnce();
  });
  it('aborts an old parse and unsubscribes all events on unmount', async () => {
    await act(async () => root.render(React.createElement(RdfGraph, { data: '<urn:one> <urn:p> <urn:o> .' })));
    const oldSignal = state.viz.loadNTriples.mock.calls[0][1] as AbortSignal;
    await act(async () => root.render(React.createElement(RdfGraph, { data: '<urn:two> <urn:p> <urn:o> .' })));
    expect(oldSignal.aborted).toBe(true);
    const signal = state.viz.loadNTriples.mock.calls[1][1] as AbortSignal;
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
    expect(state.viz.handlers.size).toBe(0);
    expect(state.viz.destroy).toHaveBeenCalledOnce();
  });
});
