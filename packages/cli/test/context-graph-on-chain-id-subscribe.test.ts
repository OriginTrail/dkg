/**
 * `dkg subscribe 32` (and `#32`) through the real subscribe route, a real agent
 * and a mock chain shaped like Gnosis mainnet on 2026-09-23: Context Graph #32
 * is public, publish policy 0, and was created long before this node booted.
 *
 * Live, 10.0.18 answered "Subscribed to context graph: 32", kept a row keyed
 * "32", and the catch-up job ended "failed ... Retry once the network is
 * healthier". The number must resolve to the graph it names instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import { daemonState } from '../src/daemon/state.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CLEARTEXT = 'gnosis-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();
const SHORT_HASH = `${NAME_HASH.slice(0, 10)}…${NAME_HASH.slice(-4)}`;
const HASH_ONLY_MESSAGE = `Context Graph ${SHORT_HASH} is known only by its on-chain name hash; `
  + 'waiting for a peer to reveal the cleartext id, or subscribe with the cleartext id.';
const PRIVATE_MESSAGE = 'Context Graph #32 is private (curated access): only its members can subscribe. '
  + 'Ask its curator for an invitation and the Context Graph id, then subscribe with that id.';

const cleanups: Array<() => Promise<void>> = [];
const previousCatchupRunner = daemonState.catchupRunner;
afterEach(async () => {
  vi.restoreAllMocks();
  daemonState.catchupRunner = previousCatchupRunner;
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

/** A round in which no peer answered: on its own, "retry" territory. */
function emptyRound() {
  return {
    connectedPeers: 0,
    syncCapablePeers: 0,
    peersTried: 0,
    peersResponded: 0,
    peersSucceeded: 0,
    dataSynced: 0,
    sharedMemorySynced: 0,
    denied: false,
    deniedPeers: 0,
    deferredBackpressure: 0,
  };
}

interface Graph32 {
  accessPolicy?: 0 | 1;
  nameHash?: string | null;
  active?: boolean;
}

/** More blocks than the live `contextGraphDiscovery` lane looks back on a cold start. */
const BEYOND_LIVE_LOOKBACK_BLOCKS = 600;

/**
 * Context Graphs #1..#31 belong to others; #32 is the graph the user wants.
 * All of them predate the node's live event tail, as on mainnet.
 */
async function gnosisShapedChain(graph: Graph32 = {}): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter();
  // A real RPC reports a head, so the live lane seeds near it instead of
  // replaying from genesis.
  (chain as unknown as { getBlockNumber: () => Promise<number> }).getBlockNumber =
    async () => (chain as unknown as { nextBlock: number }).nextBlock - 1;
  for (let id = 1; id < 32; id++) {
    await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(`other-graph-${id}`)),
    } as never);
  }
  const nameHash = graph.nameHash === undefined ? NAME_HASH : graph.nameHash;
  const created = await chain.createOnChainContextGraph({
    accessPolicy: graph.accessPolicy ?? 0,
    publishPolicy: 0,
    ...(nameHash === null ? {} : { nameHash }),
  } as never);
  expect(created.contextGraphId).toBe(32n);
  if (graph.active === false) chain.getContextGraph(32n)!.active = false;
  for (let i = 0; i < BEYOND_LIVE_LOOKBACK_BLOCKS; i++) chain.advanceBlock();
  return chain;
}

async function startNode(chain: MockChainAdapter): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'GnosisEdge',
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false },
  });
  cleanups.push(() => agent.stop());
  await agent.start();
  await agent.awaitInitialChainPoll();
  return agent;
}

async function startRoute(agent: DKGAgent, options: { callerAgentAddress?: string } = {}) {
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
      requestAgentAddress: options.callerAgentAddress ?? agent.getDefaultAgentAddress(),
      authentication: options.callerAgentAddress
        ? requestAuthentication({ kind: 'agent', agentAddress: options.callerAgentAddress })
        : requestAuthentication({ kind: 'nodeOperator' }),
    } as any;
    await handleContextGraphRoutes(routeContext);
    if (!res.writableEnded) await handleQueryRoutes(routeContext);
    if (!res.writableEnded) {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('route server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  const subscribe = async (contextGraphId: unknown) => {
    const response = await fetch(`${base}/api/context-graph/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId, syncMode: 'on-demand' }),
    });
    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      body: await response.json() as any,
    };
  };
  const catchupStatus = async (contextGraphId: string) => {
    const response = await fetch(
      `${base}/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`,
    );
    return { status: response.status, body: await response.json() as any };
  };
  const settled = async (jobId: string) => {
    for (let i = 0; i < 300; i += 1) {
      if (catchupTracker.jobs.get(jobId)?.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return catchupTracker.jobs.get(jobId);
  };
  return { subscribe, catchupStatus, settled, catchupTracker };
}

function useEmptyCatchupRunner(): string[] {
  const runs: string[] = [];
  daemonState.catchupRunner = {
    run: async ({ contextGraphId }: { contextGraphId: string }) => {
      runs.push(contextGraphId);
      return emptyRound();
    },
    close: async () => undefined,
  } as any;
  return runs;
}

describe('subscribing a Context Graph by its on-chain numeric id', () => {
  it('subscribes the graph #32 names, reads it on demand, and never keeps a row keyed "32"', async () => {
    const runs = useEmptyCatchupRunner();
    const agent = await startNode(await gnosisShapedChain());
    const route = await startRoute(agent);

    const { status, body } = await route.subscribe('32');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      subscribed: NAME_HASH,
      syncMode: 'on-demand',
      onChainReference: {
        onChainId: '32',
        nameHash: NAME_HASH,
        contextGraphId: NAME_HASH,
        message: `On-chain Context Graph #32 is Context Graph ${SHORT_HASH} (its on-chain name hash).`,
      },
      identity: { state: 'name-hash-only', nameHash: NAME_HASH, onChainId: '32', message: HASH_ONLY_MESSAGE },
    });
    const rows = agent.getSubscribedContextGraphs();
    expect(rows.has('32')).toBe(false);
    expect(rows.get(NAME_HASH)).toMatchObject({ subscribed: true, onChainId: '32', onChainHash: NAME_HASH });

    // The job says what is missing (a peer to reveal the id), not "retry".
    const job = await route.settled(body.catchup.jobId);
    expect(runs).toEqual([NAME_HASH]);
    expect(job).toMatchObject({ contextGraphId: NAME_HASH, status: 'unreachable', error: HASH_ONLY_MESSAGE });
    expect(job.error).not.toMatch(/Retry once the network is healthier/);

    // Catch-up status takes the on-chain id too.
    for (const reference of ['32', '#32', NAME_HASH]) {
      const polled = await route.catchupStatus(reference);
      expect(polled.status, reference).toBe(200);
      expect(polled.body).toMatchObject({ jobId: body.catchup.jobId, contextGraphId: NAME_HASH });
    }
    expect((await route.catchupStatus('#31')).status).toBe(404);
  }, 60_000);

  it('uses the row discovery staged for #32 and for the JSON number 32', async () => {
    useEmptyCatchupRunner();
    const chain = await gnosisShapedChain();
    const agent = await startNode(chain);
    await agent.discoverContextGraphsFromStorage();
    const read = vi.spyOn(chain, 'readContextGraphStorageRange');
    const route = await startRoute(agent);

    for (const reference of ['#32', 32]) {
      const { status, body } = await route.subscribe(reference);
      expect(status).toBe(200);
      expect(body).toMatchObject({ subscribed: NAME_HASH, onChainReference: { onChainId: '32' } });
    }
    expect(read).not.toHaveBeenCalled();
    expect(agent.getSubscribedContextGraphs().has('32')).toBe(false);
  }, 60_000);

  it('subscribes the verified cleartext id when the node already knows it', async () => {
    useEmptyCatchupRunner();
    const agent = await startNode(await gnosisShapedChain());
    await agent.discoverContextGraphsFromStorage();
    await agent.adoptVerifiedContextGraphCleartext({ nameHash: NAME_HASH, onChainId: '32' }, CLEARTEXT, 'local');
    const route = await startRoute(agent);

    const { status, body } = await route.subscribe('#32');
    expect(status).toBe(200);
    expect(body.subscribed).toBe(CLEARTEXT);
    expect(body.onChainReference).toEqual({
      onChainId: '32',
      nameHash: NAME_HASH,
      contextGraphId: CLEARTEXT,
      message: 'On-chain Context Graph #32 is "gnosis-fun-facts" (verified against its on-chain name hash).',
    });
    expect(body).not.toHaveProperty('identity');
  }, 60_000);

  it('retires the row an earlier `dkg subscribe 32` left and subscribes the graph instead', async () => {
    useEmptyCatchupRunner();
    const agent = await startNode(await gnosisShapedChain());
    // What 10.0.18's route did with `dkg subscribe 32`.
    agent.subscribeToContextGraph('32', { syncMode: 'on-demand', onChainId: '32' });
    const route = await startRoute(agent);

    const { status, body } = await route.subscribe('32');
    expect(status).toBe(200);
    expect(body.subscribed).toBe(NAME_HASH);
    expect(body.onChainReference.message).toContain('Retired the subscription keyed "32", which could never sync.');
    expect(agent.getSubscribedContextGraphs().has('32')).toBe(false);
  }, 60_000);

  it('keeps a real graph literally named "32" when "32" is written', async () => {
    useEmptyCatchupRunner();
    const agent = await startNode(await gnosisShapedChain());
    await agent.createContextGraph({ id: '32', name: 'thirty-two' });
    const route = await startRoute(agent);

    const { status, body } = await route.subscribe('32');
    expect(status).toBe(200);
    expect(body.subscribed).toBe('32');
    expect(body).not.toHaveProperty('onChainReference');
    expect(agent.getSubscribedContextGraphs().get('32')?.onChainId).toBeUndefined();
  }, 60_000);

  it('explains an id it cannot subscribe, subscribing nothing and starting no job', async () => {
    useEmptyCatchupRunner();
    const cases: Array<{ graph: Graph32; reference: string; status: number; code: string; error: RegExp }> = [
      {
        graph: {},
        reference: '#99',
        status: 404,
        code: 'CONTEXT_GRAPH_ON_CHAIN_ID_NOT_FOUND',
        error: /^Context Graph #99 does not exist on chain: the latest Context Graph id is 32\./,
      },
      {
        graph: { active: false },
        reference: '32',
        status: 409,
        code: 'CONTEXT_GRAPH_INACTIVE',
        error: /^Context Graph #32 is deactivated on chain/,
      },
      {
        graph: { nameHash: null },
        reference: '#32',
        status: 422,
        code: 'CONTEXT_GRAPH_NO_NAME_HASH',
        error: /^Context Graph #32 has no on-chain name hash/,
      },
      { graph: { accessPolicy: 1 }, reference: '32', status: 403, code: 'CONTEXT_GRAPH_PRIVATE', error: /^Context Graph #32 is private/ },
    ];
    for (const testCase of cases) {
      const agent = await startNode(await gnosisShapedChain(testCase.graph));
      const route = await startRoute(agent);
      const { status, body } = await route.subscribe(testCase.reference);
      expect(status, testCase.code).toBe(testCase.status);
      expect(body.code).toBe(testCase.code);
      expect(body.error).toMatch(testCase.error);
      expect(body.error).not.toMatch(/retry/i);
      expect(body).not.toHaveProperty('retryable');
      expect(route.catchupTracker.jobs.size).toBe(0);
      const subscribed = [...agent.getSubscribedContextGraphs()].filter(([, row]) => row.subscribed === true);
      expect(subscribed.map(([id]) => id).sort()).toEqual(['agents', 'ontology']);
      if (testCase.status === 404) expect(body.latestOnChainId).toBe('32');
    }
  }, 120_000);

  it('asks for a retry only when the chain could not be read', async () => {
    useEmptyCatchupRunner();
    const chain = await gnosisShapedChain();
    vi.spyOn(chain, 'readContextGraphStorageRange').mockRejectedValue(new Error('RPC timed out'));
    const agent = await startNode(chain);
    const route = await startRoute(agent);

    const { status, retryAfter, body } = await route.subscribe('#32');
    expect(status).toBe(503);
    expect(retryAfter).toBe('3');
    expect(body).toEqual({
      error: 'Could not read Context Graph #32 from ContextGraphStorage (RPC timed out); retry once the chain RPC responds.',
      code: 'CONTEXT_GRAPH_ON_CHAIN_ID_UNAVAILABLE',
      retryable: true,
    });
    expect(agent.getSubscribedContextGraphs().has('32')).toBe(false);

    // A resolver that fails outright fails closed as well.
    vi.spyOn(agent, 'resolveContextGraphOnChainIdReference').mockRejectedValue(new Error('boom'));
    const failed = await route.subscribe('32');
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE');
    expect(agent.getSubscribedContextGraphs().has('32')).toBe(false);
    expect(route.catchupTracker.jobs.size).toBe(0);
  }, 60_000);

  it('refuses a private graph alike whether or not this node holds its cleartext id', async () => {
    useEmptyCatchupRunner();
    const outsider = ethers.Wallet.createRandom().address;
    const hashOnly = await startNode(await gnosisShapedChain({ accessPolicy: 1 }));
    const member = await startNode(await gnosisShapedChain({ accessPolicy: 1 }));
    await member.discoverContextGraphsFromStorage();
    await member.adoptVerifiedContextGraphCleartext({ nameHash: NAME_HASH, onChainId: '32' }, CLEARTEXT, 'local');

    const answers = [];
    for (const agent of [hashOnly, member]) {
      const route = await startRoute(agent, { callerAgentAddress: outsider });
      answers.push(await route.subscribe('#32'));
    }
    for (const answer of answers) {
      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({ error: PRIVATE_MESSAGE, code: 'CONTEXT_GRAPH_PRIVATE' });
    }
    expect(JSON.stringify(answers)).not.toContain(CLEARTEXT);
    expect(member.getSubscribedContextGraphs().get(CLEARTEXT)?.subscribed).not.toBe(true);
  }, 60_000);
});
