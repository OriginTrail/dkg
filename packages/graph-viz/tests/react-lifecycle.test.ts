// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ viz: null as any }));
vi.mock('../src/core/rdf-graph-viz.js', () => ({ RdfGraphViz: class {
  handlers = new Map<string, (value: any) => void>();
  clear = vi.fn(); loadTriples = vi.fn(); loadNTriples = vi.fn(async () => {});
  loadNQuads = vi.fn(async () => {}); loadTurtle = vi.fn(async () => {}); loadJsonLd = vi.fn(async () => {});
  model = { clear: this.clear };
  zoomToFit = vi.fn(); centerOnNode = vi.fn();
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

  it.each([
    ['nquads', 'loadNQuads'], ['turtle', 'loadTurtle'], ['jsonld', 'loadJsonLd'],
  ] as const)('forwards cancellation to %s loading and keeps style/view updates independent', async (format, method) => {
    const view = { name: 'current view' } as any;
    const colors = { 'urn:s': '#0088ff' };
    await act(async () => root.render(React.createElement(RdfGraph, {
      data: 'source document', format, viewConfig: view, options: { style: { nodeColors: colors } },
    })));
    expect(state.viz[method]).toHaveBeenCalledOnce();
    const signal = state.viz[method].mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(state.viz.styleEngine.setNodeColors).toHaveBeenCalledWith(colors);
    expect(state.viz.applyView).toHaveBeenCalledWith(view);
    act(() => root.unmount()); expect(signal.aborted).toBe(true);
  });

  it('uses current hover callbacks without retaining removed handlers', async () => {
    const old = vi.fn(); const hover = vi.fn(); const unhover = vi.fn();
    const data = [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }];
    await act(async () => root.render(React.createElement(RdfGraph, { data, onNodeHover: old })));
    await act(async () => root.render(React.createElement(RdfGraph, {
      data, onNodeHover: hover, onNodeUnhover: unhover,
    })));
    act(() => {
      state.viz.handlers.get('node:hover')({ id: 'urn:s' });
      state.viz.handlers.get('node:unhover')({ id: 'urn:s' });
      state.viz.handlers.get('background:click')({ x: 0, y: 0 });
    });
    expect(old).not.toHaveBeenCalled();
    expect(hover).toHaveBeenCalledOnce(); expect(unhover).toHaveBeenCalledOnce();
    expect(state.viz.loadTriples).toHaveBeenCalledOnce();
  });
});


describe('React camera and asynchronous error handling', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('fits only the first completed load and reschedules focus when the selected entity changes', async () => {
    await act(async () => root.render(React.createElement(RdfGraph, { data: 'first', initialFit: true, initialFocus: 'urn:first' })));
    await act(async () => vi.advanceTimersByTime(299)); expect(state.viz.zoomToFit).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1)); expect(state.viz.zoomToFit).toHaveBeenCalledOnce();
    await act(async () => root.render(React.createElement(RdfGraph, { data: 'second', initialFit: true, initialFocus: 'urn:second' })));
    await act(async () => vi.advanceTimersByTime(550)); expect(state.viz.zoomToFit).toHaveBeenCalledOnce(); expect(state.viz.centerOnNode).toHaveBeenCalledExactlyOnceWith('urn:second', { durationMs: 600, zoomLevel: 2 });
    state.viz.centerOnNode.mockImplementation(() => { throw new Error('removed node'); });
    await act(async () => root.render(React.createElement(RdfGraph, { data: 'second', initialFocus: 'urn:removed' })));
    await act(async () => vi.advanceTimersByTime(550)); expect(state.viz.centerOnNode).toHaveBeenCalledTimes(2);
  });
  it('cancels camera timers and suppresses late load failures after unmount', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => root.render(React.createElement(RdfGraph, { data: 'first', initialFit: true, initialFocus: 'urn:first' })));
    let reject!: (error: Error) => void;
    state.viz.loadNTriples.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await act(async () => root.render(React.createElement(RdfGraph, { data: 'pending', initialFit: true, initialFocus: 'urn:pending' })));
    act(() => root.unmount()); await act(async () => { reject(new Error('obsolete')); }); vi.advanceTimersByTime(1000);
    expect(state.viz.centerOnNode).not.toHaveBeenCalled(); expect(state.viz.zoomToFit).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it('reports a current load failure and falls back to N-Triples for string data with triples format', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => root.render(React.createElement(RdfGraph, {})));
    const failure = new Error('bad RDF'); state.viz.loadNTriples.mockRejectedValueOnce(failure);
    await act(async () => root.render(React.createElement(RdfGraph, { data: 'bad', format: 'triples' })));
    expect(state.viz.loadNTriples).toHaveBeenCalledWith('bad', expect.any(AbortSignal)); expect(error).toHaveBeenCalledWith('[RdfGraph] Error loading data:', failure);
  });
});

it('permits selection and hover state updates without application event callbacks', async () => {
  await act(async () => root.render(React.createElement(RdfGraph, { data: 'source' })));
  expect(() => act(() => {
    state.viz.handlers.get('node:click')({ id: 'urn:s' }); state.viz.handlers.get('node:hover')({ id: 'urn:s' }); state.viz.handlers.get('node:unhover')({ id: 'urn:s' });
  })).not.toThrow();
  expect(state.viz.loadNTriples).toHaveBeenCalledOnce();
});

it('does not apply a superseded parse result or schedule an initial fit after unmount', async () => {
  await act(async () => root.render(React.createElement(RdfGraph, {})));
  let resolve!: () => void; state.viz.loadNTriples.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  await act(async () => root.render(React.createElement(RdfGraph, { data: 'pending', initialFit: true, viewConfig: { name: 'old' } })));
  const applied = state.viz.applyView.mock.calls.length; act(() => root.unmount());
  await act(async () => { resolve(); });
  expect(state.viz.applyView).toHaveBeenCalledTimes(applied); expect(state.viz.zoomToFit).not.toHaveBeenCalled();
});
