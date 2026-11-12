// SPDX-License-Identifier: Apache-2.0
/**
 * The boot steps that run before the agent write to an external store
 * directly, past the read-graph layer: the chain-reset wipe and the store
 * identity check. A direct writer must leave no read graph whose state row
 * still says `ready` for member graphs it changed.
 *
 * - **The wipe** meets this by removing every read-graph partition, its state
 *   graph included, in the same request as the graphs read graphs are built
 *   from. The scoped delete covers every `did:dkg:context-graph:` graph, and
 *   `DROP ALL` covers everything. These tests run both requests on a real engine.
 * - **The identity check** writes only its tag graph, which is no context
 *   graph's, so no read graph covers it. The reachability probe only reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLayer, isReadGraphPartitionIri, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  OxigraphStore,
  parseReadGraphStateRows,
  readGraphStateReset,
  readGraphStateRowsQuery,
} from '@origintrail-official/dkg-storage';
import { chainResetWipe } from '../src/daemon/chain-reset-wipe.js';
import { checkExternalStoreReachable, checkOrSetStoreIdentity } from '../src/daemon/store-health-check.js';

const CONTEXT_GRAPH = 'chain-reset-read-graphs';
const ROOT = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const READ_GRAPH = readGraphIri({ scope: readScope(CONTEXT_GRAPH), layer: MemoryLayer.VerifiableMemory });
const OUTSIDE = 'urn:test:not-a-context-graph';
const ENDPOINT = { queryEndpoint: 'http://store.test/query', updateEndpoint: 'http://store.test/update' };

interface Recorded { url: string; field: 'query' | 'update'; text: string }

/** A fetch that runs each SPARQL request on `store`, the way an HTTP endpoint over it would. */
function endpointOver(store: OxigraphStore): { fetch: typeof globalThis.fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    const update = form.get('update');
    const query = form.get('query');
    if (update !== null) {
      requests.push({ url: String(url), field: 'update', text: update });
      await store.update(update);
      return new Response('', { status: 200 });
    }
    if (query !== null) {
      requests.push({ url: String(url), field: 'query', text: query });
      const result = await store.query(query);
      const body = result.type === 'boolean'
        ? { head: {}, boolean: result.value }
        : { head: {}, results: { bindings: result.type === 'bindings'
          ? result.bindings.map((row) => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, { type: 'literal', value }])))
          : [] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/sparql-results+json' } });
    }
    return new Response('no query or update', { status: 400 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

async function storedGraphs(store: OxigraphStore): Promise<string[]> {
  const result = await store.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
  return result.type === 'bindings' ? result.bindings.map((row) => row['g']!).sort() : [];
}

async function stateRows(store: OxigraphStore) {
  const result = await store.query(readGraphStateRowsQuery());
  return parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []);
}

/** A context graph's member graph, its verifiable-memory read graph with a `ready` row, and a graph outside every context graph. */
async function seed(store: OxigraphStore): Promise<void> {
  await store.insert([
    { graph: ROOT, subject: 'urn:test:asset', predicate: 'http://schema.org/name', object: '"Asset"' },
    { graph: READ_GRAPH, subject: 'urn:test:asset', predicate: 'http://schema.org/name', object: '"Asset"' },
    { graph: OUTSIDE, subject: 'urn:test:other', predicate: 'http://schema.org/name', object: '"Other"' },
  ]);
  await store.update(readGraphStateReset({
    readGraph: READ_GRAPH,
    state: 'ready',
    generation: 1,
    ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion,
    builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion,
  }));
  // The seeded row is visible, so an empty answer after the wipe means the wipe removed it.
  expect((await stateRows(store)).rows).toEqual([expect.objectContaining({ readGraph: READ_GRAPH, state: 'ready' })]);
}

describe('direct store writers before the agent starts', () => {
  let dataDir: string;
  let store: OxigraphStore;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'dkg-direct-writers-'));
    store = new OxigraphStore();
  });
  afterEach(async () => {
    await store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([
    ['an operator-provided endpoint (scoped delete)', false, [OUTSIDE]],
    ['a DKG-managed namespace (DROP ALL)', true, []],
  ])('the chain-reset wipe on %s leaves no read graph and no state row', async (_case, managedByDkg, remaining) => {
    await seed(store);
    const { fetch, requests } = endpointOver(store);

    const result = await chainResetWipe({
      dataDir,
      currentMarker: 'chain-reset-read-graphs-marker',
      storeConfig: { backend: 'sparql-http', options: { ...ENDPOINT, managedByDkg } },
      fetch,
      log: () => {},
    });

    expect(result.status).toBe('completed');
    expect(requests.map((request) => request.field)).toEqual(['update']);
    expect(await stateRows(store)).toEqual({ rows: [], damaged: [] });
    const graphs = await storedGraphs(store);
    expect(graphs.filter(isReadGraphPartitionIri)).toEqual([]);
    expect(graphs).toEqual(remaining);
  });

  it('the identity check writes only its tag graph, which no context graph holds', async () => {
    const { fetch, requests } = endpointOver(store);

    const result = await checkOrSetStoreIdentity({ storeConfig: { backend: 'sparql-http', options: ENDPOINT }, nodeName: 'node-a', fetch });

    expect(result).toEqual({ ok: true, action: 'tagged', nodeName: 'node-a' });
    const updates = requests.filter((request) => request.field === 'update');
    expect(updates).toHaveLength(1);
    const written = [...updates[0]!.text.matchAll(/GRAPH <([^>]+)>/g)].map((match) => match[1]!);
    expect(written).toEqual(['urn:dkg:store-meta']);
    expect(written.some((graph) => graph.startsWith('did:dkg:context-graph:'))).toBe(false);
    expect(await storedGraphs(store)).toEqual(['urn:dkg:store-meta']);
  });

  it('the reachability probe only reads', async () => {
    const { fetch, requests } = endpointOver(store);

    const health = await checkExternalStoreReachable({ storeConfig: { backend: 'sparql-http', options: ENDPOINT }, fetch });

    expect(health.ok).toBe(true);
    expect(requests.map((request) => request.field)).toEqual(['query']);
  });
});
