import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE,
  createTripleStore,
  parseReadGraphStateRows,
  readGraphStateCompareAndSet,
  readGraphStateRowsQuery,
  type ReadGraphStateRow,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
// The same module instance as the CLI's own storage import: the write below the partition guard.
import { readGraphPartitionMaintenanceStore } from '@origintrail-official/dkg-storage/dist/read-graph-partition-store.js';
import { readGraphRegistryRecordUpdate } from '@origintrail-official/dkg-storage/dist/read-graph/registry-record.js';
import type { DkgConfig } from '../src/config.js';
import { createPublisherStore, publisherStoreConfig } from '../src/publisher-store.js';
import { readGraphSettingsOutsideDaemon } from '../src/read-graph-settings-start.js';
import { QueryConfigError } from '../src/read-graphs-config.js';

const DATA_DIR = '/tmp/dkg-publisher-store-test';

function config(overrides: Partial<DkgConfig>): DkgConfig {
  return { name: 'test', apiPort: 0, listenPort: 0, nodeRole: 'edge', ...overrides } as DkgConfig;
}

/** The store configuration that `createPublisherStore` builds. */
async function built(dkgConfig: DkgConfig, readOnly = false) {
  return publisherStoreConfig(DATA_DIR, dkgConfig, readOnly, await readGraphSettingsOutsideDaemon(DATA_DIR, dkgConfig));
}

describe('the store of a publisher runtime outside the daemon', () => {
  it('carries the read-graph settings and keeps the change log off for a configured store', async () => {
    const store = await built(config({
      store: { backend: 'sparql-http', options: { queryEndpoint: 'http://127.0.0.1:7878/query' }, changelog: true },
      query: { readGraphs: { layers: { 'verifiable-memory': 'build' } }, viewSemantics: 'merged' },
    }));
    expect(store.backend).toBe('sparql-http');
    expect(store.changelog).toBe(false);
    expect(store.largeLiteralStorage).toBeUndefined();
    expect(store.readGraphs).toEqual({
      modes: { layers: { VM: 'build' } },
      viewSemantics: { default: 'merged' },
      whenUnsupported: 'refuse',
    });
  });

  it('carries them for the default embedded store too, read-only when asked', async () => {
    expect(await built(config({ query: { viewSemantics: 'merged' } }), true)).toMatchObject({
      backend: 'oxigraph-worker',
      options: { path: join(DATA_DIR, 'store.nq'), readOnly: true },
      readGraphs: { modes: { default: 'off' }, viewSemantics: { default: 'merged' }, whenUnsupported: 'off' },
    });
  });

  it('carries no settings without a query section or a settings table, so it never resets those of the backend', async () => {
    expect((await built(config({}))).readGraphs).toBeUndefined();
    expect((await built(config({ store: { backend: 'sparql-http' } }))).readGraphs).toBeUndefined();
  });

  it('refuses a query section with an offending key', async () => {
    await expect(built(config({ query: { readGraphs: 'on' as never } }))).rejects.toThrow(QueryConfigError);
  });
});

const READY: ReadGraphStateRow = {
  readGraph: readGraphIri({ scope: readScope('ledger'), layer: MemoryLayer.VerifiableMemory }),
  state: 'ready', generation: 1,
  ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion, builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion,
};

async function stateRows(store: TripleStore): Promise<ReadGraphStateRow[]> {
  const result = await readGraphPartitionMaintenanceStore(store).query(readGraphStateRowsQuery());
  return parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows;
}

describe('a publisher store opened while the daemon is down', () => {
  it('leaves no read graph ready across its writes; a read-only one marks nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-publisher-store-'));
    try {
      // The daemon left a read graph ready in the default embedded store.
      const daemonStore = await createTripleStore({ backend: 'oxigraph-worker', options: { path: join(dir, 'store.nq') } });
      await readGraphPartitionMaintenanceStore(daemonStore).update!(readGraphStateCompareAndSet(undefined, READY));
      await daemonStore.close();

      const inspector = await createPublisherStore(dir, config({}), true);
      try {
        expect((await stateRows(inspector)).map((row) => row.state)).toEqual(['ready']);
      } finally {
        await inspector.close();
      }

      const writer = await createPublisherStore(dir, config({}));
      try {
        expect((await stateRows(writer)).map((row) => row.state)).toEqual(['dirty']);
        await writer.insert([{ subject: 'urn:asset', predicate: 'urn:p', object: '"changed"', graph: 'did:dkg:context-graph:ledger' }]);
        const [after] = await stateRows(writer);
        expect(after).toMatchObject({ readGraph: READY.readGraph, state: 'dirty' });
        expect(after!.generation).toBeGreaterThan(READY.generation);
      } finally {
        await writer.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the read graphs its settings keep under the identity the daemon recorded, and maintains its writes to them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-publisher-store-'));
    const contextGraphId = 'publisher-working-memory';
    const defaultAgent = `0x${'ab'.repeat(20)}`;
    const peerId = '12D3KooWPublisherStorePeer';
    const wm = readGraphIri({ scope: readScope(contextGraphId), layer: MemoryLayer.WorkingMemory, agentAddress: defaultAgent });
    try {
      // The daemon left the default agent's working-memory read graph ready, with the registry and the identity it was built under.
      const daemonStore = await createTripleStore({ backend: 'oxigraph-worker', options: { path: join(dir, 'store.nq') } });
      await readGraphPartitionMaintenanceStore(daemonStore).update!([
        readGraphStateCompareAndSet(undefined, { readGraph: wm, state: 'ready', generation: 2, ...CURRENT_READ_GRAPH_VERSIONS }),
        readGraphRegistryRecordUpdate({ contextGraphId, subGraphNames: [], childContextGraphRoots: [] }),
      ].join(';\n'));
      await daemonStore.close();
      writeFileSync(join(dir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE), JSON.stringify({ defaultAgentAddress: defaultAgent, peerId }));

      const writer = await createPublisherStore(dir, config({ query: { readGraphs: { layers: { 'working-memory': 'build' } } } }));
      try {
        expect((await stateRows(writer)).map((row) => row.state)).toEqual(['ready']);
        // A draft written under the node's peer ID is the default agent's: its read graph takes the write, and stays ready.
        await writer.insert([{
          subject: 'urn:draft', predicate: 'urn:p', object: '"peer"', graph: `did:dkg:context-graph:${contextGraphId}/_working_memory/${peerId}/1`,
        }]);
        expect((await stateRows(writer)).map((row) => row.state)).toEqual(['ready']);
        const held = await readGraphPartitionMaintenanceStore(writer).query(`SELECT ?o WHERE { GRAPH <${wm}> { ?s ?p ?o } }`);
        expect(held.type === 'bindings' && held.bindings).toEqual([{ o: '"peer"' }]);
      } finally {
        await writer.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
