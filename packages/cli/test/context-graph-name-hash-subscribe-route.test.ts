/**
 * `POST /api/context-graph/subscribe` for a Context Graph known only by its
 * on-chain name hash (Base-mainnet #33, 2026-09-23). Before this change the
 * job settled as "Retry once the network is healthier", which no amount of
 * retrying could satisfy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { daemonState } from '../src/daemon/state.js';
import { toCatchupStatusResponse } from '../src/daemon/types.js';
import { summarizeContextGraphIdentityStatus } from '../src/daemon/routes/status.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const NAME_HASH = '0x6de1d646b47ee4e0a97e330df174332739f6c1419885ebc559e9852be0e143f7';
const CLEARTEXT = 'acme-fun-facts';
const HASH_ONLY_MESSAGE = 'Context Graph 0x6de1d646…43f7 is known only by its on-chain name hash; '
  + 'waiting for a peer to reveal the cleartext id, or subscribe with the cleartext id.';
const RESOLVED_MESSAGE = `Context Graph 0x6de1d646…43f7 resolves to "${CLEARTEXT}" (verified against the on-chain name hash); it syncs under that id.`;

/** A round in which a peer answered but nothing completed: ordinarily "retry". */
function unproductiveRound() {
  return {
    connectedPeers: 1,
    syncCapablePeers: 1,
    peersTried: 1,
    peersResponded: 1,
    peersSucceeded: 0,
    dataSynced: 0,
    sharedMemorySynced: 0,
    denied: false,
    deniedPeers: 0,
    deferredBackpressure: 0,
    diagnostics: {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0, fetchedDataTriples: 0, insertedMetaTriples: 0, insertedDataTriples: 0,
        bytesReceived: 0, resumedPhases: 0, timedOutPhases: 1, completedPhases: 0, checkpointAdvances: 0,
        emptyResponses: 0, metaOnlyResponses: 0, dataRejectedMissingMeta: 0, rejectedKcs: 0, failedPeers: 0,
      },
      sharedMemory: {
        fetchedMetaTriples: 0, fetchedDataTriples: 0, insertedMetaTriples: 0, insertedDataTriples: 0,
        bytesReceived: 0, resumedPhases: 0, timedOutPhases: 0, completedPhases: 0, checkpointAdvances: 0,
        emptyResponses: 0, droppedDataTriples: 0, failedPeers: 0,
      },
    },
  };
}

interface NameHashAgentOptions {
  /** What the bounded pre-resolution returns. */
  resolveNow?: () => Promise<string | null>;
  /** Whether the hash already resolves (before or during the job). */
  isResolved?: () => boolean;
}

function nameHashAgent(options: NameHashAgentOptions = {}) {
  const isResolved = options.isResolved ?? (() => false);
  const calls = { authority: [] as string[], subscribe: [] as string[], markState: 0 };
  const agent = {
    calls,
    resolveContextGraphSubscriptionBootstrapAuthority: async (contextGraphId: string) => {
      calls.authority.push(contextGraphId);
      return {
        outcome: 'allowed' as const,
        source: 'registered-chain' as const,
        reason: 'test-public',
        onChainId: 33n,
        metadataBootstrap: 'eligible' as const,
      };
    },
    resolveContextGraphIdAlias: (id: string) => (id === NAME_HASH && isResolved() ? CLEARTEXT : null),
    contextGraphNameTargetFor: (id: string) => (
      id === NAME_HASH && !isResolved() ? { nameHash: NAME_HASH, onChainId: '33' } : null
    ),
    resolveContextGraphNameHashNow: options.resolveNow ?? (async () => null),
    describeContextGraphIdentity: (id: string) => {
      if (id !== NAME_HASH) return null;
      return isResolved()
        ? { state: 'resolved', nameHash: NAME_HASH, onChainId: '33', contextGraphId: CLEARTEXT, message: RESOLVED_MESSAGE }
        : { state: 'name-hash-only', nameHash: NAME_HASH, onChainId: '33', message: HASH_ONLY_MESSAGE };
    },
    getContextGraphAllowedAgents: async () => [],
    getSubscribedContextGraphs: () => new Map(),
    subscribeToContextGraph: (contextGraphId: string) => {
      calls.subscribe.push(contextGraphId);
      return { subscribed: true, synced: false, syncMode: 'always-on' as const };
    },
    contextGraphHasLocalContent: async () => false,
    hasConfirmedMetaState: async () => false,
    isPrivateContextGraph: async () => false,
    markContextGraphSubscriptionState: () => { calls.markState += 1; },
    reconcileRfc64CatalogResponsibilityV1: async () => undefined,
    resolveAgentByToken: () => undefined,
    getDefaultAgentAddress: () => '0x0000000000000000000000000000000000000001',
  };
  return agent;
}

const servers: Server[] = [];
const previousCatchupRunner = daemonState.catchupRunner;
afterEach(async () => {
  daemonState.catchupRunner = previousCatchupRunner;
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

async function startRoute(agent: ReturnType<typeof nameHashAgent>) {
  const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    await handleContextGraphRoutes({
      req, res, agent,
      publisherControl: {}, publisherRuntime: null, config: {}, startedAt: Date.now(),
      dashDb: {}, opWallets: {}, network: {}, tracker: {}, memoryManager: {},
      bridgeAuthToken: undefined, nodeVersion: 'test', nodeCommit: 'test', catchupTracker,
      extractionRegistry: {}, fileStore: {}, extractionStatus: new Map(), assertionImportLocks: new Map(),
      vectorStore: {}, embeddingProvider: null, validTokens: new Set(), apiHost: '127.0.0.1',
      apiPortRef: { value: 0 }, routePlugins: [], url, path: url.pathname,
      requestAgentAddress: '0x0000000000000000000000000000000000000001',
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
    } as any);
    if (!res.writableEnded) {
      res.statusCode = 404;
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('route server did not bind');
  const subscribe = async (contextGraphId: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId, includeSharedMemory: true }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const settled = async (jobId: string) => {
    for (let i = 0; i < 100; i += 1) {
      if (catchupTracker.jobs.get(jobId)?.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return catchupTracker.jobs.get(jobId);
  };
  return { subscribe, settled, catchupTracker };
}

describe('subscribing a Context Graph by its on-chain name hash', () => {
  it('says what is missing instead of asking the operator to retry', async () => {
    const runs: string[] = [];
    daemonState.catchupRunner = {
      run: async ({ contextGraphId }: { contextGraphId: string }) => { runs.push(contextGraphId); return unproductiveRound(); },
      close: async () => undefined,
    } as any;
    const agent = nameHashAgent();
    const route = await startRoute(agent);

    const { status, body } = await route.subscribe(NAME_HASH);
    expect(status).toBe(200);
    expect(body.subscribed).toBe(NAME_HASH);
    expect(body.identity).toEqual({
      state: 'name-hash-only',
      nameHash: NAME_HASH,
      onChainId: '33',
      message: HASH_ONLY_MESSAGE,
    });

    const job = await route.settled(body.catchup.jobId);
    expect(job).toMatchObject({ status: 'unreachable', error: HASH_ONLY_MESSAGE });
    expect(job.error).not.toContain('Retry once the network is healthier');
    // Nothing a peer returned under the hash may change readiness state.
    expect(agent.calls.markState).toBe(0);
    expect(runs).toEqual([NAME_HASH]);
    expect(toCatchupStatusResponse(job, undefined, agent.describeContextGraphIdentity(NAME_HASH) as never))
      .toMatchObject({ jobStatus: 'unreachable', status: 'unreachable', identity: { state: 'name-hash-only' } });
  });

  it('subscribes the cleartext id when a peer reveals it within the bounded wait', async () => {
    let resolved = false;
    const runs: string[] = [];
    daemonState.catchupRunner = {
      run: async ({ contextGraphId }: { contextGraphId: string }) => { runs.push(contextGraphId); return unproductiveRound(); },
      close: async () => undefined,
    } as any;
    const agent = nameHashAgent({
      resolveNow: async () => { resolved = true; return CLEARTEXT; },
      isResolved: () => resolved,
    });
    const route = await startRoute(agent);

    const { body } = await route.subscribe(NAME_HASH);
    expect(body.subscribed).toBe(CLEARTEXT);
    expect(body.identity).toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT, message: RESOLVED_MESSAGE });
    expect(agent.calls.subscribe).toEqual([CLEARTEXT]);
    await route.settled(body.catchup.jobId);
    expect(runs).toEqual([CLEARTEXT]);
  });

  it('continues the same job under the cleartext id when the hash resolves mid-run', async () => {
    let resolved = false;
    const runs: string[] = [];
    daemonState.catchupRunner = {
      run: async ({ contextGraphId }: { contextGraphId: string }) => {
        runs.push(contextGraphId);
        resolved = true; // a peer revealed the cleartext while this round ran
        return unproductiveRound();
      },
      close: async () => undefined,
    } as any;
    const agent = nameHashAgent({ isResolved: () => resolved });
    const route = await startRoute(agent);

    const { body } = await route.subscribe(NAME_HASH);
    const job = await route.settled(body.catchup.jobId);
    expect(runs).toEqual([NAME_HASH, CLEARTEXT]);
    expect(job.resolvedContextGraphId).toBe(CLEARTEXT);
    expect(route.catchupTracker.latestByContextGraph.get(CLEARTEXT)).toBe(body.catchup.jobId);
    // The cleartext round is classified normally (this round was unproductive).
    expect(job.status).toBe('failed');
    expect(toCatchupStatusResponse(job)).toMatchObject({ resolvedContextGraphId: CLEARTEXT });
  });

  it('subscribes an already-resolved hash under its cleartext id', async () => {
    daemonState.catchupRunner = {
      run: async () => unproductiveRound(),
      close: async () => undefined,
    } as any;
    const agent = nameHashAgent({ isResolved: () => true });
    const route = await startRoute(agent);

    const { status, body } = await route.subscribe(NAME_HASH);
    expect(status).toBe(200);
    // The authority check runs for the graph that will actually be subscribed.
    expect(agent.calls.authority).toEqual([CLEARTEXT]);
    expect(agent.calls.subscribe).toEqual([CLEARTEXT]);
    expect(body).toMatchObject({ subscribed: CLEARTEXT, identity: { state: 'resolved' } });
  });
});

describe('public /api/status identity summary', () => {
  it('counts hash-only subscriptions without naming them', () => {
    const agent = {
      getSubscribedContextGraphs: () => new Map([
        [NAME_HASH, { subscribed: true }],
        ['0x' + '11'.repeat(32), { subscribed: true }],
        ['0x' + '22'.repeat(32), { subscribed: false }],
        [CLEARTEXT, { subscribed: true }],
      ]),
      describeContextGraphIdentity: (id: string) => (
        id === CLEARTEXT ? null : { state: id === NAME_HASH ? 'name-hash-only' : 'name-hash-only-private', message: 'x' }
      ),
    };
    const summary = summarizeContextGraphIdentityStatus(agent as never);
    expect(summary.nameHashOnly).toBe(2);
    expect(summary.message).toContain('2 subscribed Context Graphs are known only by the on-chain name hash');
    expect(summary.message).not.toContain('0x');
    expect(summarizeContextGraphIdentityStatus({
      getSubscribedContextGraphs: () => new Map([[CLEARTEXT, { subscribed: true }]]),
      describeContextGraphIdentity: () => null,
    } as never)).toEqual({ nameHashOnly: 0 });
  });
});
