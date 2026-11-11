/**
 * A node whose settings (`query.readGraphs`) build one context graph's
 * verifiable memory runs the read-graph builder with the node; the builder
 * backfills that read graph and makes it ready. This is the first thing a
 * `build` run checks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { MemoryLayer, createOperationContext, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { OxigraphStore, READ_GRAPH_PLANNED_METHODS, wrapReadGraphLayer } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { readGraphWorkloadOf } from '../src/read-graph-runtime.js';

const CG = 'read-graph-settings-build';
const VM = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });

let agent: DKGAgent | undefined;
afterEach(async () => {
  await agent?.stop().catch(() => undefined);
  agent = undefined;
});

describe('a node whose settings build one context graph\'s verifiable memory', () => {
  it('runs the builder with the node, which backfills that read graph and makes it ready', async () => {
    // An in-memory engine that declares every planned method, as a maintaining adapter does.
    const adapter = Object.assign(new OxigraphStore(), { readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true } });
    const store = wrapReadGraphLayer(adapter, {
      backend: 'oxigraph',
      readGraphs: { modes: { contextGraphs: { [CG]: { layers: { [MemoryLayer.VerifiableMemory]: 'build' } } } } },
    });
    agent = await DKGAgent.create({
      name: 'ReadGraphSettingsBuild', listenHost: '127.0.0.1', listenPort: 0, chainAdapter: new MockChainAdapter(), nodeRole: 'edge', store,
    });
    await agent.start();
    const workload = readGraphWorkloadOf(agent);
    // The settings keep a read graph, so the node runs its builder.
    expect(workload?.status()).toBeDefined();

    await agent.createContextGraph({ id: CG, name: CG, description: 'read-graph build test' });
    await agent.store.insert([
      { subject: 'urn:build:s', predicate: 'urn:build:p', object: '"v"', graph: `did:dkg:context-graph:${CG}/_verifiable_memory/0xaa/1` },
    ]);
    // The builder passes at start and then on its interval: start the node's workload again for a pass now, as the next start would.
    await workload!.close();
    workload!.start(createOperationContext('system'));
    await vi.waitFor(() => expect(store.runtime.mirror.get(VM)?.state).toBe('ready'), { timeout: 30_000, interval: 50 });
    const held = await adapter.query(`SELECT ?o WHERE { GRAPH <${VM}> { ?s ?p ?o } }`);
    expect(held.type === 'bindings' && held.bindings).toEqual([{ o: '"v"' }]);

    // Once a read graph has a row, every update must name the graphs it writes: registering the context graph persists
    // its registration status through such an update, and the read graph stays ready.
    await agent.registerContextGraph(CG);
    expect(store.runtime.mirror.get(VM)?.state).toBe('ready');
  }, 60_000);
});
