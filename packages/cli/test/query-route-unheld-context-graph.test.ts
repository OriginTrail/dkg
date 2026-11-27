// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon's query routes, through a real agent on a mock chain, for an
 * agent-scoped caller: a private context graph the caller may not read and an
 * id the node holds nothing of get the same response — status, headers and
 * body, with the requested id written as `<id>` and timings left out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_ONTOLOGY, contextGraphDataGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import { handleBoundedQueryRoutes } from '../src/daemon/routes/bounded-query.js';
import { handleQueryCatalogRoutes } from '../src/daemon/routes/query-catalog.js';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const OUTSIDER = '0x00000000000000000000000000000000000000ff';
// Ids of one length, so a response that repeats the id keeps its length.
const CHAIN_PRIVATE_CG = `${OWNER}/route-pair-private-on-chain`;
const LOCAL_PRIVATE_CG = `${OWNER}/route-pair-private-on-local`;
const MISSING_CG = `${OWNER}/route-pair-never-created-id`;
const MARKER = 'urn:route-pair:marker';
const MARKER_CLASS = 'urn:route-pair:Class';
const ON_CHAIN_ID = 7n;
const SELECT = `SELECT ?s WHERE { ?s a <${MARKER_CLASS}> }`;

type Regime = 'local-fallback' | 'finalized-absence';

// One request per route, and per refusal shape on the general query route.
const REQUESTS: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ['a SELECT on /api/query', '/api/query', { sparql: SELECT }],
  ['a SERVICE clause on /api/query', '/api/query', { sparql: 'SELECT ?s WHERE { SERVICE <http://example.org/sparql> { ?s ?p ?o } }' }],
  ['a FROM clause on /api/query', '/api/query', { sparql: 'SELECT ?s FROM <urn:route-pair:other> WHERE { ?s ?p ?o }' }],
  ['a nested GRAPH variable on /api/query', '/api/query', { sparql: 'SELECT ?s WHERE { { SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } } }' }],
  ['a row without a pattern on /api/query', '/api/query', { sparql: 'SELECT (1 AS ?one) WHERE { }' }],
  ['a sub-graph on /api/query', '/api/query', { sparql: SELECT, subGraphName: 'tasks' }],
  ['the shared-memory view on /api/query', '/api/query', { sparql: SELECT, view: 'shared-working-memory' }],
  ['a SELECT on /api/query/bounded', '/api/query/bounded', { version: 1, maxRows: 10, sparql: SELECT }],
  ['a SERVICE clause on /api/query/bounded', '/api/query/bounded',
    { version: 1, maxRows: 10, sparql: 'SELECT ?s WHERE { SERVICE <http://example.org/sparql> { ?s ?p ?o } }' }],
  ['a catalog read', '/api/profile/query-catalog/read', {}],
  ['a generated view', '/api/genui/render', { entityUri: MARKER, libraryPrompt: 'components' }],
  ['a memory search', '/api/memory/search', { query: 'marker' }],
  // Reads outside the query engine behind the same gates; the id goes in the query string.
  ['a sub-graph listing', '/api/sub-graph/list', {}],
  ['a knowledge asset read', '/api/knowledge-assets/route-pair-asset', {}],
];
const GET_PATHS = new Set(['/api/sub-graph/list', '/api/knowledge-assets/route-pair-asset']);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

async function fixture(regime: Regime): Promise<DKGAgent> {
  const chain = new MockChainAdapter();
  const agent = await DKGAgent.create({ name: 'QueryRouteUnheldContextGraph', chainAdapter: chain, store: new OxigraphStore() });
  cleanups.push(async () => { await agent.stop(); await agent.store.close(); });
  // A host identity is enough for local create and query; no peer runs.
  vi.spyOn(agent, 'peerId', 'get').mockReturnValue('peer-query-route-unheld-context-graph');
  agent.gossip = {
    subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), publish: vi.fn(async () => undefined),
  } as unknown as DKGAgent['gossip'];
  vi.spyOn(agent as unknown as { rfc64PublicCatalogServiceV1: unknown }, 'rfc64PublicCatalogServiceV1', 'get')
    .mockReturnValue({ acceptedPolicySnapshot: () => null });

  // Only the chain registration is replaced, once the graphs exist. Authority and routes stay real.
  let registered = false;
  const resolveRegistration = agent.resolveContextGraphRegistrationBinding.bind(agent);
  vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockImplementation(async (id, options) => {
    if (!registered) return resolveRegistration(id, options);
    if (id === CHAIN_PRIVATE_CG) return { kind: 'registered' as const, onChainId: ON_CHAIN_ID, provenance: 'numeric-id' as const };
    if (regime === 'finalized-absence' && id !== LOCAL_PRIVATE_CG) {
      return { kind: 'unavailable' as const, reason: 'finalized-name-absence-unaccepted' as const,
        detail: 'finalized name absence has no accepted unregistered authority', detailCode: 'no-accepted-authority' as const };
    }
    return resolveRegistration(id, options);
  });
  vi.spyOn(chain, 'resolveContextGraphIdsByNameHashes').mockImplementation(async (names) => new Map(names.map((name) => [
    name, registered && name === agent.contextGraphNameCommitment(CHAIN_PRIVATE_CG) ? ON_CHAIN_ID : null,
  ])));
  vi.spyOn(chain, 'isContextGraphActiveOnChain').mockImplementation(async (id) => registered && id === ON_CHAIN_ID);
  vi.spyOn(chain, 'getContextGraphAccessPolicy').mockResolvedValue(1);
  vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([OWNER]);

  await agent.createContextGraph({ id: CHAIN_PRIVATE_CG, name: 'Chain private graph', accessPolicy: 1, callerAgentAddress: OWNER });
  await agent.createContextGraph({
    id: LOCAL_PRIVATE_CG, name: 'Local private graph', accessPolicy: 1, allowedAgents: [OWNER], callerAgentAddress: OWNER,
  });
  registered = true;
  await agent.store.insert([CHAIN_PRIVATE_CG, LOCAL_PRIVATE_CG].map((id) => ({
    subject: MARKER, predicate: DKG_ONTOLOGY.RDF_TYPE, object: MARKER_CLASS, graph: contextGraphDataGraphUri(id),
  })));
  return agent;
}

/** The real query routes over HTTP for one agent-scoped caller. */
async function startRoutes(agent: DKGAgent, callerAgentAddress: string) {
  const inert = new Proxy({}, { get: () => () => undefined });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ctx = {
      req, res, agent, url, path: url.pathname, config: {}, tracker: inert, startedAt: Date.now(),
      vectorStore: { search: async () => [] }, embeddingProvider: null, fileStore: {}, extractionStatus: new Map(),
      requestAgentAddress: callerAgentAddress,
      authentication: requestAuthentication({ kind: 'agent', agentAddress: callerAgentAddress }),
    } as any;
    try {
      for (const route of [handleBoundedQueryRoutes, handleQueryCatalogRoutes, handleMemoryRoutes, handleContextGraphRoutes,
        handleKnowledgeAssetsRoutes, handleQueryRoutes]) {
        if (res.writableEnded) break;
        await route(ctx);
      }
      if (!res.writableEnded) { res.statusCode = 404; res.end('{}'); }
    } catch (error) {
      if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ thrown: (error as Error).message })); }
    }
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('route server did not bind');
  /** Status, headers but `Date` and `Content-Length`, and the body with timings and the requested id masked. */
  return async (path: string, contextGraphId: string, body: Record<string, unknown>) => {
    const base = `http://127.0.0.1:${address.port}${path}`;
    const response = GET_PATHS.has(path)
      ? await fetch(`${base}?contextGraphId=${encodeURIComponent(contextGraphId)}`)
      : await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, contextGraphId }),
      });
    const text = (await response.text()).split(contextGraphId).join('<id>');
    return {
      status: response.status,
      headers: [...response.headers].filter(([name]) => name !== 'date' && name !== 'content-length'),
      body: text.replace(/"phases":\{[^}]*\}/, '"phases":"<timings>"'),
    };
  };
}

describe.each(['local-fallback', 'finalized-absence'] as const)('query routes when the node finds an id it holds nothing of by %s', (regime) => {
  it.each(REQUESTS)('answer %s as for a private context graph the caller may not read', async (_label, path, body) => {
    const agent = await fixture(regime);
    const post = await startRoutes(agent, OUTSIDER);
    for (const denied of [CHAIN_PRIVATE_CG, LOCAL_PRIVATE_CG]) {
      expect(await post(path, MISSING_CG, body), `against ${denied}`).toEqual(await post(path, denied, body));
    }
  });
});

it('keeps the routes answering a caller who may read the context graph', async () => {
  const agent = await fixture('local-fallback');
  const post = await startRoutes(agent, OWNER);
  const read = await post('/api/query', LOCAL_PRIVATE_CG, { sparql: SELECT });
  expect(read.status, read.body).toBe(200);
  expect(JSON.parse(read.body).result.bindings).toEqual([{ s: MARKER }]);
  const refused = await post('/api/query', LOCAL_PRIVATE_CG, { sparql: REQUESTS[1][2].sparql });
  expect(refused.status).toBe(400);
  expect(JSON.parse(refused.body).error).toBe('SPARQL rejected: SERVICE clauses are not allowed');
  const bounded = await post('/api/query/bounded', LOCAL_PRIVATE_CG, REQUESTS[7][2]);
  expect(bounded.status, bounded.body).toBe(200);
  expect(JSON.parse(bounded.body).result.bindings).toEqual([{ s: MARKER }]);
  expect((await post('/api/profile/query-catalog/read', LOCAL_PRIVATE_CG, {})).status).toBe(200);
});
