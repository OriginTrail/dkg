/**
 * `dkg subscribe <hash>` through the real subscribe route and a real agent, on
 * the state of a Base-mainnet edge that synced the `ontology` system graph
 * (phase-0 run, 2026-09-23). That graph is shared by every network and holds
 * each creator's `ContextGraphOnChainId` claim; three definitions claimed #33.
 *
 * Live, the route answered with no `identity` (the CLI printed no note), kept
 * a row keyed by the hash string, and RFC-64 rejected that row as an "invalid
 * identity". The hash must subscribe the one graph this chain proves #33 is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { daemonState } from '../src/daemon/state.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const keccak = (id: string) => ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();

const REAL_ID = '0x64529c023d853371228923B4FdA5FB22F929bf51/bb-open-20260923-9c3f0';
const NAME_HASH = '0x69a1d4a3500548577083af0be5c4376dcf171907ab7da012d25dc778ced894e3';
const RESOLVED_MESSAGE = `Context Graph 0x69a1d4a3…94e3 resolves to "${REAL_ID}" `
  + '(verified against the on-chain name hash); it syncs under that id.';
const CLAIMS_33 = [
  { id: 'pr68-open-test', name: 'PR68 Open Test' },
  { id: REAL_ID, name: 'open run open-20260923-9c3f0' },
  { id: 'baseball', name: 'baseball' },
];

/** More blocks than the live `contextGraphDiscovery` lane looks back on a cold start. */
const BEYOND_LIVE_LOOKBACK_BLOCKS = 600;

const cleanups: Array<() => Promise<void>> = [];
const previousCatchupRunner = daemonState.catchupRunner;
afterEach(async () => {
  vi.restoreAllMocks();
  daemonState.catchupRunner = previousCatchupRunner;
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

/** Base as of 2026-09-23: #1..#32 are other graphs; #33 predates the live tail. */
async function baseShapedChain(): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter();
  (chain as unknown as { getBlockNumber: () => Promise<number> }).getBlockNumber =
    async () => (chain as unknown as { nextBlock: number }).nextBlock - 1;
  for (let id = 1; id <= 32; id++) {
    await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash: keccak(`other-graph-${id}`),
    } as never);
  }
  const created = await chain.createOnChainContextGraph({
    accessPolicy: 0,
    publishPolicy: 0,
    nameHash: NAME_HASH,
  } as never);
  expect(created.contextGraphId).toBe(33n);
  for (let i = 0; i < BEYOND_LIVE_LOOKBACK_BLOCKS; i++) chain.advanceBlock();
  return chain;
}

/** An edge that synced the ontology on connect and ran both discovery lanes. */
async function startEdge(): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'OntologyClaimsEdge',
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    chainAdapter: await baseShapedChain(),
    rfc64CatalogActivation: { enabled: false },
  });
  cleanups.push(() => agent.stop());
  await agent.start();
  await agent.awaitInitialChainPoll();
  const graph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  await agent.store.insert(CLAIMS_33.flatMap(({ id, name }) => {
    const subject = contextGraphDataGraphUri(id);
    return [
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph },
      { subject, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: JSON.stringify(name), graph },
      { subject, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: '"33"', graph },
    ];
  }));
  await agent.discoverContextGraphsFromStore();
  await agent.discoverContextGraphsFromStorage();
  return agent;
}

async function startRoute(agent: DKGAgent) {
  const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const routeContext = {
      req, res, agent,
      publisherControl: {}, publisherRuntime: null, config: {}, startedAt: Date.now(),
      dashDb: {}, opWallets: {}, network: {}, tracker: {}, memoryManager: {},
      bridgeAuthToken: undefined, nodeVersion: 'test', nodeCommit: 'test', catchupTracker,
      extractionRegistry: {}, fileStore: {}, extractionStatus: new Map(), assertionImportLocks: new Map(),
      vectorStore: {}, embeddingProvider: null, validTokens: new Set(), apiHost: '127.0.0.1',
      apiPortRef: { value: 0 }, routePlugins: [], url, path: url.pathname,
      requestAgentAddress: agent.getDefaultAgentAddress(),
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
    } as any;
    await handleContextGraphRoutes(routeContext);
    if (!res.writableEnded) {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('route server did not bind');
  const subscribe = async (contextGraphId: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId, syncMode: 'always-on' }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { subscribe };
}

describe('subscribing by name hash on a node that synced the ontology graph', () => {
  it('subscribes the graph this chain proves the hash names, with the identity note', async () => {
    daemonState.catchupRunner = {
      run: async () => ({
        connectedPeers: 0, syncCapablePeers: 0, peersTried: 0, peersResponded: 0, peersSucceeded: 0,
        dataSynced: 0, sharedMemorySynced: 0, denied: false, deniedPeers: 0, deferredBackpressure: 0,
      }),
      close: async () => undefined,
    } as any;
    const agent = await startEdge();
    const route = await startRoute(agent);

    const { status, body } = await route.subscribe(NAME_HASH);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      subscribed: REAL_ID,
      identity: { state: 'resolved', nameHash: NAME_HASH, onChainId: '33', contextGraphId: REAL_ID, message: RESOLVED_MESSAGE },
    });
    const rows = agent.getSubscribedContextGraphs();
    expect(rows.has(NAME_HASH)).toBe(false);
    expect(rows.get(REAL_ID)).toMatchObject({ subscribed: true, onChainId: '33', onChainHash: NAME_HASH });
    // The other definitions that claimed #33 are catalogued, never bound.
    expect(rows.get('baseball')?.onChainId).toBeUndefined();
    expect(rows.get('pr68-open-test')?.onChainId).toBeUndefined();
  });
});
