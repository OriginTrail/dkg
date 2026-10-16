// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayerView } from '../src/ui/views/MemoryLayerView.js';

const api = vi.hoisted(() => ({ executeQuery: vi.fn(async () => ({ result: { type: 'bindings', bindings: [] } })) }));
vi.mock('../src/ui/api.js', async original => ({
  ...await original<typeof import('../src/ui/api.js')>(),
  executeQuery: api.executeQuery,
  fetchStatus: vi.fn(async () => ({})),
  listAssertions: vi.fn(async () => []),
}));
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useMemoryGraphEvents: () => {} }));
vi.mock('@origintrail-official/dkg-graph-viz/react', () => ({ RdfGraph: () => null, NodePanel: () => null }));
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  api.executeQuery.mockClear(); container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('interactive memory query policy', () => {
  it.each(['wm', 'swm', 'vm'] as const)('preserves interactive budgets and graph scope in the %s tab', async layer => {
    await act(async () => root.render(React.createElement(MemoryLayerView, { layer, contextGraphId: 'cg' })));
    expect(api.executeQuery).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), {});
    const query = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 7000';
    await act(async () => root.render(React.createElement(MemoryLayerView, { layer, contextGraphId: 'cg', externalQuery: query })));
    expect(api.executeQuery).toHaveBeenLastCalledWith(query, expect.objectContaining({
      contextGraphId: 'cg', includeContextGraphPartitions: false,
    }), { timeoutMs: null, maxResponseBytes: null });
    await act(async () => root.render(React.createElement(MemoryLayerView, { layer, contextGraphId: 'cg', externalQuery: '' })));
    expect(api.executeQuery).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), {});
  });
});
