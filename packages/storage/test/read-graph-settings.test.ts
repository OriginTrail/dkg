import { describe, expect, it } from 'vitest';
import { MemoryLayer, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  READ_GRAPH_PLANNED_METHODS,
  ReadGraphsUnsupportedError,
  keepsAnyReadGraph,
  readGraphModeOf,
  viewSemanticsOf,
  wrapReadGraphLayer,
  type ReadGraphModes,
  type TripleStore,
} from '../src/index.js';

/** An adapter that declares every planned method, as one that maintains read graphs does. */
const capableAdapter = () => Object.assign(new OxigraphStore(), {
  readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true },
});

const AGENT = '0x' + 'ab'.repeat(20);
const vm = (contextGraphId: string, subGraphName?: string): ReadGraphKey =>
  ({ scope: readScope(contextGraphId, subGraphName), layer: MemoryLayer.VerifiableMemory });
const swm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.SharedWorkingMemory });
const wm = (contextGraphId: string): ReadGraphKey =>
  ({ scope: readScope(contextGraphId), layer: MemoryLayer.WorkingMemory, agentAddress: AGENT });

describe('read-graph modes', () => {
  const modes: ReadGraphModes = {
    default: 'build',
    layers: { [MemoryLayer.WorkingMemory]: 'off' },
    contextGraphs: {
      served: { default: 'serve' },
      mixed: { layers: { [MemoryLayer.SharedWorkingMemory]: 'serve', [MemoryLayer.WorkingMemory]: 'build' } },
    },
  };

  it('takes the most specific setting: the context graph and layer, the context graph, the layer, the node', () => {
    expect(readGraphModeOf(modes, vm('other'))).toBe('build');
    expect(readGraphModeOf(modes, wm('other'))).toBe('off');
    expect(readGraphModeOf(modes, vm('served'))).toBe('serve');
    expect(readGraphModeOf(modes, wm('served'))).toBe('serve');
    expect(readGraphModeOf(modes, swm('mixed'))).toBe('serve');
    expect(readGraphModeOf(modes, wm('mixed'))).toBe('build');
    expect(readGraphModeOf(modes, vm('mixed'))).toBe('build');
  });

  it('gives a sub-graph its context graph mode, and every read graph off without settings', () => {
    expect(readGraphModeOf(modes, vm('served', 'notes'))).toBe('serve');
    expect(readGraphModeOf(undefined, vm('served'))).toBe('off');
    expect(readGraphModeOf({}, wm('served'))).toBe('off');
  });

  it('names nothing inherited by a context graph ID such as __proto__ or constructor', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(readGraphModeOf({ default: 'off', contextGraphs: { served: { default: 'serve' } } }, vm(id))).toBe('off');
      expect(viewSemanticsOf({ contextGraphs: { served: 'merged' } }, id)).toBe('per-asset');
    }
  });

  it('keeps a read graph when any mode is other than off', () => {
    expect(keepsAnyReadGraph(undefined)).toBe(false);
    expect(keepsAnyReadGraph({ default: 'off', layers: { [MemoryLayer.VerifiableMemory]: 'off' } })).toBe(false);
    expect(keepsAnyReadGraph({ default: 'off', contextGraphs: { a: { default: 'off' } } })).toBe(false);
    expect(keepsAnyReadGraph({ default: 'off', contextGraphs: { a: { layers: { [MemoryLayer.WorkingMemory]: 'build' } } } })).toBe(true);
    expect(keepsAnyReadGraph({ layers: { [MemoryLayer.VerifiableMemory]: 'serve' } })).toBe(true);
    expect(keepsAnyReadGraph({ default: 'build' })).toBe(true);
  });
});

describe('view semantics', () => {
  it('gives a context graph its own setting, then the node default, then per-asset', () => {
    const settings = { default: 'merged' as const, contextGraphs: { kept: 'per-asset' as const } };
    expect(viewSemanticsOf(settings, 'kept')).toBe('per-asset');
    expect(viewSemanticsOf(settings, 'other')).toBe('merged');
    expect(viewSemanticsOf(undefined, 'other')).toBe('per-asset');
  });
});

describe('read-graph settings on the backend runtime', () => {
  it('reach every store object over the backend through any one store configuration', () => {
    const config = { backend: 'blazegraph', options: { url: `http://127.0.0.1:1/${Math.random()}` } };
    const earlier = wrapReadGraphLayer(new OxigraphStore(), config);
    expect(earlier.runtime.modes).toEqual({});
    expect(earlier.runtime.viewSemantics).toEqual({});
    const modes: ReadGraphModes = { default: 'build' };
    const viewSemantics = { default: 'merged' as const };
    wrapReadGraphLayer(capableAdapter(), { ...config, readGraphs: { modes, viewSemantics } });
    expect(earlier.runtime.modes).toBe(modes);
    expect(earlier.runtime.viewSemantics).toBe(viewSemantics);
    // A configuration without settings leaves them as they are.
    wrapReadGraphLayer(new OxigraphStore(), { ...config });
    expect(earlier.runtime.modes).toBe(modes);
  });
});

describe('read-graph settings on an adapter that cannot keep read graphs', () => {
  it('are refused, naming the methods its adapter does not maintain, before they reach the runtime', async () => {
    const config = { backend: 'oxigraph-worker', options: { path: `/tmp/read-graph-settings-${Math.random()}` } };
    // An adapter that implements a planned write and declares no read-graph capabilities.
    let closed = false;
    const adapter = { delete: async () => undefined, close: async () => { closed = true; } } as unknown as TripleStore;
    const attempt = () => wrapReadGraphLayer(adapter, { ...config, readGraphs: { modes: { contextGraphs: { notes: { default: 'build' } } } } });
    expect(attempt).toThrow(ReadGraphsUnsupportedError);
    try {
      attempt();
    } catch (error) {
      expect((error as ReadGraphsUnsupportedError).code).toBe('READ_GRAPHS_UNSUPPORTED');
      expect((error as ReadGraphsUnsupportedError).missingMethods).toContain('delete');
    }
    expect(closed).toBe(true);
    // Settings that keep none are accepted, and the same adapter with every method declared keeps them.
    const off = wrapReadGraphLayer(new OxigraphStore(), { ...config, readGraphs: { modes: { default: 'off' }, viewSemantics: { default: 'merged' } } });
    expect(off.runtime.modes).toEqual({ default: 'off' });
    expect(() => wrapReadGraphLayer(capableAdapter(), { ...config, readGraphs: { modes: { default: 'serve' } } })).not.toThrow();
  });
});
