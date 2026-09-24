/**
 * `GET /api/sync/catchup-status?contextGraphId=<name hash>` through the real
 * subscribe and query routes, a real agent, and a mock chain holding a
 * private Context Graph (on-chain accessPolicy 1) whose roster lists one of
 * the two agents this node hosts.
 *
 * Once this node resolves the graph's on-chain name hash to its cleartext id,
 * the job the name hash finds names that id. The node operator and an agent
 * the subscribe route would admit see the job; any other token gets the
 * answer for a name hash with no job.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import { daemonState } from '../src/daemon/state.js';
import type { CatchupTracker } from '../src/daemon/types.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CLEARTEXT = 'acme-private-notes';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();
/** A name hash this node has never seen. */
const UNKNOWN_HASH = ethers.keccak256(ethers.toUtf8Bytes('acme-unknown-graph')).toLowerCase();
/** An agent on this node that the graph's on-chain roster lists. */
const MEMBER = ethers.Wallet.createRandom().address;
/** An agent on this node that the roster does not list. */
const OUTSIDER = ethers.Wallet.createRandom().address;
const NO_JOB = { status: 404, text: '{"error":"No catch-up job found"}' };

const cleanups: Array<() => Promise<void>> = [];
const previousCatchupRunner = daemonState.catchupRunner;
afterEach(async () => {
  vi.restoreAllMocks();
  daemonState.catchupRunner = previousCatchupRunner;
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

/** A round in which no peer answered. */
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

/** The private graph, created before the node boots; its roster lists MEMBER. */
async function privateGraphChain(): Promise<{ chain: MockChainAdapter; onChainId: string }> {
  const chain = new MockChainAdapter();
  // A real RPC reports a head, so the live discovery lane seeds near it.
  (chain as unknown as { getBlockNumber: () => Promise<number> }).getBlockNumber =
    async () => (chain as unknown as { nextBlock: number }).nextBlock - 1;
  const created = await chain.createOnChainContextGraph({
    accessPolicy: 1,
    publishPolicy: 0,
    nameHash: NAME_HASH,
    participantAgents: [MEMBER],
  } as never);
  return { chain, onChainId: created.contextGraphId.toString() };
}

async function startNode(chain: MockChainAdapter): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'CatchupStatusEdge',
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false },
  });
  cleanups.push(() => agent.stop());
  await agent.start();
  await agent.awaitInitialChainPoll();
  // Chain discovery staged the graph under its name hash only.
  expect(agent.describeContextGraphIdentity(NAME_HASH)?.state).toBe('name-hash-only-private');
  return agent;
}

/**
 * The real subscribe and query routes over HTTP for one caller: the node
 * operator, or the agent `agentAddress` names. Callers of one node share its
 * catch-up tracker, as they share the daemon's.
 */
async function startRoute(
  agent: DKGAgent,
  catchupTracker: CatchupTracker,
  caller: { agentAddress?: string } = {},
) {
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
      requestAgentAddress: caller.agentAddress ?? agent.getDefaultAgentAddress(),
      authentication: caller.agentAddress
        ? requestAuthentication({ kind: 'agent', agentAddress: caller.agentAddress })
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
  const subscribe = async (contextGraphId: string) => {
    const response = await fetch(`${base}/api/context-graph/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId, syncMode: 'on-demand' }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  /** The response as a client receives it: status, headers (all but `Date`) and raw body. */
  const catchupStatus = async (contextGraphId: string) => {
    const response = await fetch(
      `${base}/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`,
    );
    return {
      status: response.status,
      headers: [...response.headers].filter(([name]) => name !== 'date'),
      text: await response.text(),
    };
  };
  return { subscribe, catchupStatus };
}

/**
 * A node hosting MEMBER and OUTSIDER, where MEMBER subscribed to the graph by
 * its name hash. With `resolveDuringCatchup` the node resolves the hash while
 * the catch-up job runs, so the job continues under the cleartext id;
 * otherwise the job settles under the name hash and `adopt()` resolves it
 * later.
 */
async function nodeWithNameHashJob(options: { resolveDuringCatchup: boolean }) {
  const { chain, onChainId } = await privateGraphChain();
  const agent = await startNode(chain);
  const adopt = () => agent.adoptVerifiedContextGraphCleartext({ nameHash: NAME_HASH, onChainId }, CLEARTEXT, 'local');
  daemonState.catchupRunner = {
    run: async ({ contextGraphId }: { contextGraphId: string }) => {
      if (options.resolveDuringCatchup && contextGraphId === NAME_HASH) await adopt();
      return emptyRound();
    },
    close: async () => undefined,
  } as any;
  const catchupTracker: CatchupTracker = { jobs: new Map(), latestByContextGraph: new Map() };
  const operator = await startRoute(agent, catchupTracker);
  const member = await startRoute(agent, catchupTracker, { agentAddress: MEMBER });
  const outsider = await startRoute(agent, catchupTracker, { agentAddress: OUTSIDER });

  const subscribed = await member.subscribe(NAME_HASH);
  expect(subscribed.status).toBe(200);
  expect(subscribed.body.subscribed).toBe(NAME_HASH);
  const jobId: string = subscribed.body.catchup.jobId;
  await vi.waitFor(() => expect(catchupTracker.jobs.get(jobId)?.finishedAt).toBeDefined(), { timeout: 10_000 });
  return { agent, adopt, catchupTracker, jobId, operator, member, outsider };
}

describe('catch-up status looked up by a resolved name hash', () => {
  it('shows a job that continued under the cleartext id to the operator and an admitted agent only', async () => {
    const node = await nodeWithNameHashJob({ resolveDuringCatchup: true });
    expect(node.catchupTracker.jobs.get(node.jobId)).toMatchObject({
      contextGraphId: NAME_HASH,
      resolvedContextGraphId: CLEARTEXT,
    });
    const admission = vi.spyOn(node.agent, 'resolveContextGraphSubscriptionBootstrapAuthority');

    const shown = await node.operator.catchupStatus(NAME_HASH);
    expect(shown.status).toBe(200);
    expect(JSON.parse(shown.text)).toMatchObject({
      jobId: node.jobId,
      contextGraphId: NAME_HASH,
      resolvedContextGraphId: CLEARTEXT,
      identity: { state: 'resolved', nameHash: NAME_HASH, contextGraphId: CLEARTEXT },
    });
    // The node operator can list every subscription, so it needs no admission read.
    expect(admission).not.toHaveBeenCalled();

    // An agent the subscribe route would not admit gets the answer for a name
    // hash with no job (a lookup that finds no job reads no admission).
    const refused = await node.outsider.catchupStatus(NAME_HASH);
    expect(refused).toEqual(await node.outsider.catchupStatus(UNKNOWN_HASH));
    expect(refused).toMatchObject(NO_JOB);
    expect(admission).toHaveBeenLastCalledWith(CLEARTEXT, {
      callerAgentAddress: OUTSIDER,
      allowSubscriptionFallback: false,
    });

    // An agent the subscribe route admits sees exactly what the operator sees.
    expect(await node.member.catchupStatus(NAME_HASH)).toEqual(shown);
    expect(admission).toHaveBeenLastCalledWith(CLEARTEXT, {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    });
  }, 60_000);

  it('applies the same rule when the hash resolves after the job settled under it', async () => {
    const node = await nodeWithNameHashJob({ resolveDuringCatchup: false });

    // Unresolved, the job names nothing beyond the hash, so every caller sees it.
    const unresolved = await node.outsider.catchupStatus(NAME_HASH);
    expect(unresolved.status).toBe(200);
    expect(JSON.parse(unresolved.text)).toMatchObject({
      jobId: node.jobId,
      contextGraphId: NAME_HASH,
      identity: { state: 'name-hash-only-private', nameHash: NAME_HASH },
    });

    // Resolved, only the identity note names the cleartext id.
    expect(await node.adopt()).toBe(true);
    const shown = await node.operator.catchupStatus(NAME_HASH);
    expect(shown.status).toBe(200);
    const body = JSON.parse(shown.text);
    expect(body).not.toHaveProperty('resolvedContextGraphId');
    expect(body.identity).toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT });
    expect(await node.member.catchupStatus(NAME_HASH)).toEqual(shown);

    const refused = await node.outsider.catchupStatus(NAME_HASH);
    expect(refused).toEqual(await node.outsider.catchupStatus(UNKNOWN_HASH));
    expect(refused).toMatchObject(NO_JOB);
  }, 60_000);

  it('answers a lookup by the cleartext id as before, with no admission read', async () => {
    const node = await nodeWithNameHashJob({ resolveDuringCatchup: true });
    const admission = vi.spyOn(node.agent, 'resolveContextGraphSubscriptionBootstrapAuthority');

    // The job continued under the cleartext id, so that id finds it too; a
    // caller who gives the cleartext id follows nothing.
    const byCleartext = await node.outsider.catchupStatus(CLEARTEXT);
    expect(byCleartext.status).toBe(200);
    expect(JSON.parse(byCleartext.text)).toMatchObject({ jobId: node.jobId, resolvedContextGraphId: CLEARTEXT });
    expect(await node.operator.catchupStatus(CLEARTEXT)).toEqual(byCleartext);
    expect(admission).not.toHaveBeenCalled();
  }, 60_000);

  it('answers as for a name hash with no job when the admission read cannot complete', async () => {
    const node = await nodeWithNameHashJob({ resolveDuringCatchup: true });
    const noJob = await node.member.catchupStatus(UNKNOWN_HASH);
    expect(noJob).toMatchObject(NO_JOB);
    const admission = vi.spyOn(node.agent, 'resolveContextGraphSubscriptionBootstrapAuthority');

    admission.mockResolvedValueOnce({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'chain-name-binding-unavailable',
      metadataBootstrap: 'eligible',
    });
    expect(await node.member.catchupStatus(NAME_HASH)).toEqual(noJob);
    admission.mockRejectedValueOnce(new Error('authority read failed'));
    expect(await node.member.catchupStatus(NAME_HASH)).toEqual(noJob);

    // The operator reads nothing, so an outage does not change its answer.
    admission.mockRejectedValue(new Error('authority read failed'));
    expect((await node.operator.catchupStatus(NAME_HASH)).status).toBe(200);

    // Once the read completes again, the admitted agent sees the job again.
    admission.mockRestore();
    expect((await node.member.catchupStatus(NAME_HASH)).status).toBe(200);
  }, 60_000);
});
