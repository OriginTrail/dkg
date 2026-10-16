// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3294 — a curator publishes a member's shared knowledge asset from a named
 * sub-graph of a context graph registered on chain with a curated publish
 * policy.
 *
 * Two real agents on the shared Hardhat chain, linked over libp2p:
 *   - the curator owns the graph; only its wallet may publish into it;
 *   - the member creates a knowledge asset in the graph's `reports` sub-graph
 *     through the knowledge-asset API (`POST /api/knowledge-assets`), and
 *     shares it with `POST /api/knowledge-assets/:name/swm/share-async`, which
 *     the async share worker carries out.
 *
 * The curator then promotes the member's asset from shared memory to Verified
 * Memory with `POST /api/knowledge-assets/:name/vm/publish`, naming the
 * sub-graph and the member as the author. The asset must be published as the
 * member's: under the member's seal, in the member's KA namespace.
 *
 * The member's seal is written on the member's node only, so it must reach the
 * curator with the share. Before the fix the publish answered 409
 * `ASSERTION_AUTHOR_NOT_RESIDENT`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ethers } from 'ethers';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { daemonState } from '../src/daemon/state.js';
import {
  createPromoteWorkerSupervisor,
  type PromoteWorkerSupervisor,
} from '../src/daemon/worker/async-promote-worker.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { installHardhatACKProvider } from '../../agent/test/_helpers/v10-acks.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const CG = 'curated-reports-3294';
const SUB_GRAPH = 'reports';
const NAME = 'report-1';
const SUBJECT = 'urn:dkg:test-3294:report-1';
const TITLE = '"Site inspection report"';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(250);
    value = await read();
  }
  return value;
}

interface RouteServer {
  readonly server: Server;
  post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }>;
  get(path: string): Promise<{ status: number; body: any }>;
}

/** The knowledge-asset routes of one agent, as its daemon serves them, for one agent token. */
async function serveKnowledgeAssetRoutes(agent: DKGAgent, agentAddress: string): Promise<RouteServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ctx = {
      req, res, url, path: url.pathname, agent,
      requestAgentAddress: agentAddress,
      authentication: requestAuthentication({ kind: 'agent', agentAddress }),
      extractionStatus: new Map(), assertionImportLocks: new Map(),
      emitMemoryGraphChanged: () => {}, publisherControl: {},
    } as unknown as RequestContext;
    try {
      await handleKnowledgeAssetsRoutes(ctx);
      if (!res.writableEnded) { res.writeHead(404); res.end('{}'); }
    } catch (error) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('route server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-agent-token' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return {
    server,
    post: (path, body) => call('POST', path, body),
    get: (path) => call('GET', path),
  };
}

describe('a curator publishes a member\'s sub-graph share from shared memory (GH#3294)', () => {
  let snapshotId: string;
  let curator: DKGAgent;
  let member: DKGAgent;
  let curatorAddress: string;
  let memberAddress: string;
  let curatorRoutes: RouteServer;
  let memberRoutes: RouteServer;
  let shareWorker: PromoteWorkerSupervisor;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    await mintTokens(
      createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER,
      new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address, ethers.parseEther('50000000'),
    );

    curator = await DKGAgent.create({
      name: 'Curator3294', listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'core',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      kaNumberAllocator: makeTestKaNumberAllocator(),
      syncReconcilerEnabled: false, agentProfileHeartbeatMs: 0,
    });
    member = await DKGAgent.create({
      name: 'Member3294', listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'edge',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      kaNumberAllocator: makeTestKaNumberAllocator(),
      syncReconcilerEnabled: false, agentProfileHeartbeatMs: 0,
    });
    await curator.start();
    await member.start();
    curatorAddress = curator.getDefaultAgentAddress()!;
    memberAddress = member.getDefaultAgentAddress()!;
    expect(memberAddress.toLowerCase()).not.toBe(curatorAddress.toLowerCase());

    const curatorDial = curator.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await member.connectTo(curatorDial);

    // The curator owns the graph and its curated publish policy (0): the
    // member's wallet is not an authorized publisher.
    await curator.createContextGraph({ id: CG, name: 'Curated reports' });
    await curator.registerContextGraph(CG, { publishPolicy: 0 });
    curator.subscribeToContextGraph(CG);
    await curator.createSubGraph(CG, SUB_GRAPH);

    // The member follows the graph and obtains its definition from the curator.
    await member.syncFromPeer(curator.peerId, [SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]);
    expect(await pollUntil(() => member.contextGraphExists(CG), (exists) => exists, 15_000)).toBe(true);
    member.subscribeToContextGraph(CG);
    await Promise.all([
      curator.whenRfc64CatalogResponsibilitiesIdleV1(),
      member.whenRfc64CatalogResponsibilitiesIdleV1(),
    ]);
    const subscription = await pollUntil(
      async () => member.getSubscribedContextGraphs().get(CG),
      (record) => record?.metaSynced === true,
      30_000,
    );
    expect(subscription?.metaSynced, 'the member holds the graph definition').toBe(true);
    // Readiness for the member's own writes is not what this test is about: a
    // catch-up of a graph that holds nothing yet never marks it synced (GH#3296),
    // and a first write into a sub-graph needs the sub-graph registered locally
    // (GH#3293). Mark both, as a client's retries and remedy would.
    member.markContextGraphSubscriptionState(CG, { synced: true });
    await member.createSubGraph(CG, SUB_GRAPH);

    curatorRoutes = await serveKnowledgeAssetRoutes(curator, curatorAddress);
    memberRoutes = await serveKnowledgeAssetRoutes(member, memberAddress);
    // `swm/share-async` answers only while the daemon's share worker runs.
    shareWorker = createPromoteWorkerSupervisor({
      agent: member as any,
      workerConcurrency: 1,
      pollIntervalMs: 25,
      heartbeatIntervalMs: 0,
      shutdownTimeoutMs: 1_000,
      log: () => {},
      emitMemoryGraphChanged: () => {},
      workerIdPrefix: 'member-3294',
    });
    await shareWorker.start();
    daemonState.promoteWorkerAvailable = true;
    daemonState.promoteWorkerUnavailableReason = null;
  }, 180_000);

  afterAll(async () => {
    daemonState.promoteWorkerAvailable = false;
    await shareWorker?.stop();
    for (const routes of [curatorRoutes, memberRoutes]) {
      if (routes) await new Promise<void>((resolve) => routes.server.close(() => resolve()));
    }
    await member?.stop().catch(() => {});
    await curator?.stop().catch(() => {});
    if (snapshotId) await revertSnapshot(snapshotId);
  });

  it('publishes the member\'s asset as the member\'s, from the curator\'s shared memory', async () => {
    // 1. The member creates and seals the asset in the sub-graph ...
    const created = await memberRoutes.post('/api/knowledge-assets', {
      contextGraphId: CG,
      name: NAME,
      subGraphName: SUB_GRAPH,
      quads: [{ subject: SUBJECT, predicate: 'http://schema.org/name', object: TITLE }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // 2. ... and shares it through the async share queue.
    const enqueued = await memberRoutes.post(
      `/api/knowledge-assets/${NAME}/swm/share-async`,
      { contextGraphId: CG, subGraphName: SUB_GRAPH },
    );
    expect(enqueued.status, JSON.stringify(enqueued.body)).toBe(200);
    const job = await pollUntil(
      () => memberRoutes.get(`/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(enqueued.body.jobId)}`),
      (answer) => answer.body?.state === 'succeeded' || answer.body?.state === 'failed',
      60_000,
    );
    expect(job.body?.state, JSON.stringify(job.body)).toBe('succeeded');

    // 3. The share reaches the curator's shared memory of the sub-graph.
    const inCuratorSwm = await pollUntil(
      () => curator.query(
        `SELECT ?name WHERE { <${SUBJECT}> <http://schema.org/name> ?name }`,
        { contextGraphId: CG, subGraphName: SUB_GRAPH, graphSuffix: '_shared_memory' },
      ),
      (result) => result.bindings.length > 0,
      30_000,
    );
    expect(inCuratorSwm.bindings).toEqual([{ name: TITLE }]);

    // 4. The curator promotes it to Verified Memory, naming the member as author.
    await installHardhatACKProvider(curator as any);
    const published = await curatorRoutes.post(`/api/knowledge-assets/${NAME}/vm/publish`, {
      contextGraphId: CG,
      subGraphName: SUB_GRAPH,
      selectedAuthorAgentAddress: memberAddress,
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.status).toBe('confirmed');
    // Published under the member's seal and in the member's KA namespace.
    expect(published.body.authorAddress.toLowerCase()).toBe(memberAddress.toLowerCase());
    expect(BigInt(published.body.kaId) >> 96n).toBe(BigInt(memberAddress));

    // 5. The curator now holds it in Verified Memory and no longer in shared memory.
    const inCuratorVm = await curator.query(
      `SELECT ?name WHERE { <${SUBJECT}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG, subGraphName: SUB_GRAPH },
    );
    expect(inCuratorVm.bindings).toEqual([{ name: TITLE }]);
    const leftInCuratorSwm = await curator.query(
      `SELECT ?name WHERE { <${SUBJECT}> <http://schema.org/name> ?name }`,
      { contextGraphId: CG, subGraphName: SUB_GRAPH, graphSuffix: '_shared_memory' },
    );
    expect(leftInCuratorSwm.bindings).toEqual([]);

    // 6. The member, the author, follows the publication like every other node.
    const inMemberVm = await pollUntil(
      () => member.query(
        `SELECT ?name WHERE { <${SUBJECT}> <http://schema.org/name> ?name }`,
        { contextGraphId: CG, subGraphName: SUB_GRAPH },
      ),
      (result) => result.bindings.length > 0,
      30_000,
    );
    expect(inMemberVm.bindings).toEqual([{ name: TITLE }]);
    const leftInMemberSwm = await pollUntil(
      () => member.query(
        `SELECT ?name WHERE { <${SUBJECT}> <http://schema.org/name> ?name }`,
        { contextGraphId: CG, subGraphName: SUB_GRAPH, graphSuffix: '_shared_memory' },
      ),
      (result) => result.bindings.length === 0,
      30_000,
    );
    expect(leftInMemberSwm.bindings).toEqual([]);
  }, 180_000);

  it('keeps author seals on the curator only: a member keeps none of the curator\'s', async () => {
    // The curator's own asset in the sub-graph reaches the member's shared memory ...
    const curatorReport = 'curator-report-1';
    const curatorSubject = 'urn:dkg:test-3294:curator-report-1';
    await curator.assertion.create(CG, curatorReport, { subGraphName: SUB_GRAPH });
    await curator.assertion.write(CG, curatorReport, [
      { subject: curatorSubject, predicate: 'http://schema.org/name', object: '"Curator report"' },
    ], { subGraphName: SUB_GRAPH });
    await curator.assertion.promote(CG, curatorReport, { subGraphName: SUB_GRAPH });
    const inMemberSwm = await pollUntil(
      () => member.query(
        `SELECT ?name WHERE { <${curatorSubject}> <http://schema.org/name> ?name }`,
        { contextGraphId: CG, subGraphName: SUB_GRAPH, graphSuffix: '_shared_memory' },
      ),
      (result) => result.bindings.length > 0,
      30_000,
    );
    expect(inMemberSwm.bindings).toEqual([{ name: '"Curator report"' }]);

    // ... but its seal stays out of the member's `_meta`: the member does not
    // curate the graph, so it has no use for another author's seal.
    expect(await member.resolveAssertionAuthor(CG, curatorReport, {
      subGraphName: SUB_GRAPH,
      callerAgentAddress: memberAddress,
    })).toBeUndefined();
    // The curator resolves its own seal, as before.
    expect((await curator.resolveAssertionAuthor(CG, curatorReport, {
      subGraphName: SUB_GRAPH,
      callerAgentAddress: curatorAddress,
    }))?.toLowerCase()).toBe(curatorAddress.toLowerCase());
  }, 120_000);
});
