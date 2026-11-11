import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { MemoryLayer, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  READ_GRAPH_PLANNED_METHODS,
  workingMemoryIdentityRule,
  wrapReadGraphLayer,
  type ReadGraphStoreConfig,
} from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { viewReadGraphsOf } from '../src/read-graph-view-source.js';

const AGENT = `0x${'ab'.repeat(20)}`;
const vm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory });
const swm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.SharedWorkingMemory });

/** A read-graph layer over an in-memory engine that declares every planned method, as a maintaining adapter does. */
function layered(readGraphs: ReadGraphStoreConfig) {
  const adapter = Object.assign(new OxigraphStore(), {
    readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true },
  });
  return wrapReadGraphLayer(adapter, { backend: 'oxigraph', readGraphs });
}

describe('the read-graph source of merged view queries', () => {
  it('keeps only the read graphs the node serves, and reads state, identity and defaults from the runtime', () => {
    const store = layered({
      modes: { default: 'build', contextGraphs: { served: { layers: { [MemoryLayer.VerifiableMemory]: 'serve' } } } },
      viewSemantics: { contextGraphs: { served: 'merged' } },
    });
    const source = viewReadGraphsOf(store)!;
    expect(source.keeps(vm('served'))).toBe(true);
    expect(source.keeps(swm('served'))).toBe(false);
    expect(source.keeps(vm('other'))).toBe(false);
    expect(source.defaultSemantics?.('served')).toBe('merged');
    expect(source.defaultSemantics?.('other')).toBe('per-asset');

    const readGraph = readGraphIri(vm('served'));
    expect(source.state(readGraph)).toBeUndefined();
    const row = { readGraph, state: 'ready' as const, generation: 1, ruleVersion: 1, builderVersion: 1 };
    store.runtime.mirror.set(row);
    expect(source.state(readGraph)).toEqual(row);

    const rule = workingMemoryIdentityRule({ defaultAgentAddress: AGENT });
    store.runtime.workingMemoryIdentity = rule;
    expect(source.identity).toBe(rule);
  });

  it('is absent for a store without a read-graph layer', () => {
    expect(viewReadGraphsOf(new OxigraphStore())).toBeUndefined();
    expect(viewReadGraphsOf(undefined)).toBeUndefined();
  });
});

describe('the agent', () => {
  let agent: DKGAgent | undefined;
  afterEach(async () => {
    await agent?.stop().catch(() => undefined);
    agent = undefined;
  });

  it('plans merged view queries from its store\'s read graphs', async () => {
    const store = layered({ modes: { contextGraphs: { served: { default: 'serve' }, built: { default: 'build' } } } });
    agent = await DKGAgent.create({ name: 'ReadGraphSource', chainAdapter: new MockChainAdapter(), store });
    const merged = (contextGraphId: string) => agent!.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId, view: 'verifiable-memory', semantics: 'merged',
    });
    // Served, but not built yet: the answer is "not ready", which only the node's read graphs can give.
    await expect(merged('served')).rejects.toMatchObject({ code: 'VIEW_NOT_READY' });
    // Built but not served, as with no read graphs at all: merged does not apply.
    await expect(merged('built')).rejects.toMatchObject({ code: 'SEMANTICS_UNSUPPORTED' });
  });
});
