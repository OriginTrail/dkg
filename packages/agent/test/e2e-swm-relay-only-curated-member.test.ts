/**
 * E2E (#3421): a member's write in a public context graph registered on chain
 * with a curated publish policy reaches another member through the graph's
 * owner, between agents whose only route to each other is a relay, when the
 * owner's change notice misses that member.
 *
 * Real agents over real libp2p and a relay, on the shared Hardhat chain. The
 * owner registers the graph and admits both members' agents to its allowlist,
 * as its approver does; each member learns the allowlist from the owner's
 * metadata, as a member's metadata refresh after its approval does. Then:
 *   1. the members reach the owner through the relay only, follow the graph and
 *      hold its allowlist;
 *   2. member 1's write into a sub-graph is stored on the owner, the owner's
 *      change notice to member 2 fails on every attempt (it is sent again
 *      twice, and the owner logs member 2 as not reached), and member 2 holds
 *      the write within a bounded time all the same.
 *
 * Member 2 runs as a member that subscribed long ago: its subscribe no longer
 * keeps the graph in use (a short activity window), and its safety-net pull
 * runs on a short interval so that the bound fits a test. Membership keeps
 * the graph in use, and the pull fetches the write from the owner. Before
 * #3421 nothing pulled the graph again until the peer reconciler, minutes
 * later, and the write was not there within the bound.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { PROTOCOL_SWM_CHANGE_NOTICE } from '@origintrail-official/dkg-core';
import { RealChainAgents, pollUntil } from './_helpers/real-chain-agent.js';
import {
  RelayOnlyNetwork,
  connectThroughRelay,
  expectRelayOnlyLink,
  linkConnections,
} from './_helpers/relay-only-network.js';
import type { DKGAgent } from '../src/index.js';
import { startRecentSharedMemoryPulls } from '../src/recent-shared-memory-pull-runtime.js';
import {
  HARDHAT_KEYS,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const NAME = 'http://schema.org/name';
/** Same on every node: a run of this file never collides with another run's graphs. */
const RUN = Date.now().toString(36);
const NOTES = 'notes';
/** Member 2's safety net in this test: a pull of the graph every interval, ticks between. */
const SAFETY_NET_INTERVAL_MS = 5_000;
const SAFETY_NET_TICK_MS = 1_000;
/** Shorter than the interval: what the subscribe marked as in use has run out before the first pull. */
const SAFETY_NET_ACTIVITY_WINDOW_MS = 2_000;
/** One interval and a tick, plus a pull over a relayed link with its dial detours (`relay-only-network.ts`). */
const DELIVERY_BOUND_MS = 60_000;
/** The background sync rounds that follow a connection end well within this. */
const BACKGROUND_SYNC_BOUND_MS = 90_000;

let fileSnapshot: string;
beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
  // Registering a Context Graph pulls the registration deposit when one is set.
  const { hubAddress } = getSharedContext();
  const registrar = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, registrar.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

interface Shared {
  readonly name: string;
  readonly subject: string;
}

async function readNames(reader: DKGAgent, contextGraphId: string, shared: Shared): Promise<string[]> {
  try {
    const result = await reader.query(
      `SELECT ?name WHERE { <${shared.subject}> <${NAME}> ?name }`,
      { contextGraphId, graphSuffix: '_shared_memory', subGraphName: NOTES },
    );
    return result.bindings.map((row) => String(row['name']));
  } catch {
    return [];
  }
}

/** POST /api/knowledge-assets (create + write), then swm/share, into the sub-graph. */
async function share(author: DKGAgent, contextGraphId: string, name: string): Promise<Shared> {
  const scope = { subGraphName: NOTES };
  const subject = `urn:dkg:e2e-3421:${RUN}:${name}`;
  await author.assertion.create(contextGraphId, name, scope);
  await author.assertion.write(contextGraphId, name, [{ subject, predicate: NAME, object: `"${name}"` }], scope);
  const promoted = await author.assertion.promote(contextGraphId, name, scope);
  expect(promoted.sealed, `${name} was sealed and shared`).toBe(true);
  return { name, subject };
}

/** A background pull of `agent` is queued or running: a sync-on-connect job, or a sync round holding a peer's lease. */
function isPulling(agent: DKGAgent): boolean {
  if (agent.getSyncOnConnectPeerScheduler().size > 0) return true;
  const { peerSyncSession } = agent as unknown as { peerSyncSession: { isSyncing(peerId: string): boolean } };
  return agent.node.libp2p.getPeers().some((peer) => peerSyncSession.isSyncing(peer.toString()));
}

/** Wait until no agent pulls, three polls in a row: a write made after this is not fetched by a running round. */
async function whenNobodyPulls(agents: readonly DKGAgent[]): Promise<void> {
  let quietPolls = 0;
  const reached = await pollUntil(
    () => {
      quietPolls = agents.some(isPulling) ? 0 : quietPolls + 1;
      return quietPolls;
    },
    (count) => count >= 3,
    BACKGROUND_SYNC_BOUND_MS,
    500,
  );
  expect(reached, `the background sync rounds ended within ${BACKGROUND_SYNC_BOUND_MS} ms`).toBeGreaterThanOrEqual(3);
}

describe('E2E: a member\'s write reaches another member of a registered curated graph through a relay-only owner (#3421)', () => {
  const pool = new RealChainAgents();
  const tempDirs: string[] = [];
  let network: RelayOnlyNetwork;
  let owner: DKGAgent;
  let member1: DKGAgent;
  let member2: DKGAgent;
  let everyone: readonly DKGAgent[];
  let contextGraphId: string;
  let onChainId: string;
  const MEMBERS = 'the members follow the graph and hold its allowlist';
  const completed = new Set<string>();

  /** An edge agent as a daemon runs it, behind the relay, with a data directory (the catalog path). */
  async function createAgent(name: string, operationalKey: string): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-curated-relay-only-'));
    tempDirs.push(dataDir);
    return pool.create({
      name,
      operationalKey,
      listenHost: '127.0.0.1',
      dataDir,
      ...(await network.addressing()),
    });
  }

  /**
   * POST /api/context-graph/subscribe for a registered graph (the chain admits
   * it, the subscription carries the on-chain id, the catch-up job fetches the
   * definition), then the curator's metadata with the allowlist, and a first
   * request for the graph's shared memory, which makes the member one of the
   * owner's followers.
   */
  async function follow(member: DKGAgent): Promise<void> {
    const address = member.getDefaultAgentAddress()!.toLowerCase();
    const admission = await pollUntil(
      () => member.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
        callerAgentAddress: address,
        allowSubscriptionFallback: false,
      }),
      (decision) => decision.outcome === 'allowed',
      30_000,
      1_000,
    );
    expect(admission).toMatchObject({ outcome: 'allowed', source: 'registered-chain' });
    member.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', onChainId });
    const definition = await pollUntil(
      () => member.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(
        contextGraphId,
        undefined,
        { contextGraphId, onChainId },
      ).catch(() => 'failed' as const),
      (outcome) => outcome === 'fetched' || outcome === 'already-confirmed',
      30_000,
      1_000,
    );
    expect(['fetched', 'already-confirmed'], 'the member holds the graph\'s definition').toContain(definition);
    const allowed = await pollUntil(
      async () => {
        await member.refreshMetaFromCurator(contextGraphId).catch(() => undefined);
        return (await member.getCgMeta(contextGraphId)).allowedAgents.map((agent) => agent.toLowerCase());
      },
      (agents) => agents.includes(address),
      60_000,
      2_000,
    );
    expect(allowed, 'the member holds the allowlist with its own agent').toContain(address);
    const answered = await pollUntil(
      () => member.syncSharedMemoryFromPeerDetailed(owner.peerId, [contextGraphId]).then(
        (result) => result.completedPhases > 0 && result.deniedPhases === 0,
        () => false,
      ),
      (ok) => ok,
      30_000,
      1_000,
    );
    expect(answered, 'the member asked the owner for the graph\'s shared memory and was answered').toBe(true);
  }

  beforeAll(async () => {
    network = await RelayOnlyNetwork.start();
    owner = await createAgent('CuratedRelayOnlyOwner', HARDHAT_KEYS.CORE_OP);
    member1 = await createAgent('CuratedRelayOnlyMember1', HARDHAT_KEYS.EXTRA1);
    member2 = await createAgent('CuratedRelayOnlyMember2', HARDHAT_KEYS.EXTRA2);
    everyone = [owner, member1, member2];
    for (const agent of everyone) await agent.start();

    // POST /api/context-graph/create with accessPolicy 0, publishPolicy 1 and register: true.
    const ownerAddress = owner.getDefaultAgentAddress()!.toLowerCase();
    contextGraphId = `${ownerAddress}/curated-relay-only-${RUN}`;
    await owner.createContextGraph({
      id: contextGraphId,
      name: 'Curated relay-only E2E',
      description: '',
      accessPolicy: 0,
      callerAgentAddress: ownerAddress,
    });
    const registered = await owner.registerContextGraph(contextGraphId, {
      accessPolicy: 0,
      publishPolicy: 1,
      callerAgentAddress: ownerAddress,
    });
    onChainId = String(registered.onChainId);
    expect(Number(onChainId)).toBeGreaterThan(0);
    await owner.createSubGraph(contextGraphId, NOTES);
    // What the owner's approver does for each member's join request.
    for (const member of [member1, member2]) {
      await owner.inviteAgentToContextGraph(contextGraphId, member.getDefaultAgentAddress()!, ownerAddress);
    }
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await pool.stopAll();
    await network?.stop();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  }, 60_000);

  it('1. the members reach the owner through the relay only, follow the graph and hold its allowlist', async () => {
    await connectThroughRelay(network, member1, owner);
    await connectThroughRelay(network, member2, owner);
    for (const member of [member1, member2]) expectRelayOnlyLink(network, member, owner, 'before any write');
    expect(linkConnections(network, member1, member2), 'the members are not connected to each other').toEqual([]);

    for (const member of [member1, member2]) await follow(member);
    completed.add(MEMBERS);
  }, 300_000);

  it('2. a member\'s write stored on the owner reaches the other member within the bound when the notice misses it', async () => {
    expect(completed.has(MEMBERS), `not evaluated: the step "${MEMBERS}" failed`).toBe(true);
    await whenNobodyPulls(everyone);

    // Member 2 as a member that subscribed long ago, on a short interval.
    const member2Internals = member2 as unknown as {
      recentSharedMemoryPulls: { close(): Promise<void> } | null;
      log: { debug(...args: unknown[]): void };
    };
    await member2Internals.recentSharedMemoryPulls?.close();
    const safetyNet = startRecentSharedMemoryPulls(member2, {
      intervalMs: SAFETY_NET_INTERVAL_MS,
      tickMs: SAFETY_NET_TICK_MS,
      activityWindowMs: SAFETY_NET_ACTIVITY_WINDOW_MS,
    });
    member2Internals.recentSharedMemoryPulls = safetyNet;
    const member2Debug = vi.spyOn(member2Internals.log, 'debug');

    // The owner's notice to member 2 fails as a stream over a short-lived relayed connection does.
    const ownerInternals = owner as unknown as {
      messenger: { sendToPeer(peerId: string, protocolId: string, bytes: Uint8Array, options?: unknown): Promise<Uint8Array> };
      log: { info(...args: unknown[]): void };
    };
    const sendToPeer = ownerInternals.messenger.sendToPeer.bind(ownerInternals.messenger);
    const missedNotices: number[] = [];
    ownerInternals.messenger.sendToPeer = async (peerId, protocolId, bytes, options) => {
      if (protocolId === PROTOCOL_SWM_CHANGE_NOTICE && peerId === member2.peerId) {
        missedNotices.push(Date.now());
        throw new Error('The stream has been reset');
      }
      return sendToPeer(peerId, protocolId, bytes, options);
    };
    const ownerInfo = vi.spyOn(ownerInternals.log, 'info');

    const shared = await share(member1, contextGraphId, 'member-1-note');
    const atOwner = await pollUntil(() => readNames(owner, contextGraphId, shared), (names) => names.length > 0, DELIVERY_BOUND_MS, 500);
    expect(atOwner, 'member 1\'s write is stored on the owner').toEqual([`"${shared.name}"`]);
    const storedAt = Date.now();

    const atMember2 = await pollUntil(() => readNames(member2, contextGraphId, shared), (names) => names.length > 0, DELIVERY_BOUND_MS, 500);
    const arrivedAfterMs = Date.now() - storedAt;
    expect(atMember2, `member 1's write at member 2, ${arrivedAfterMs} ms after the owner stored it`).toEqual([`"${shared.name}"`]);
    console.log(`[#3421] a member's write at the other member ${arrivedAfterMs} ms after the owner stored it, the notice missed`);

    // It came by the safety net from the owner, not by a notice. The pull
    // reports once it has also replayed the graph's catalog heads.
    const pulledFromOwner = `Safety-net shared-memory pull of "${contextGraphId}" from ${owner.peerId.slice(-8)}: `;
    const safetyNetLine = await pollUntil(
      () => member2Debug.mock.calls.map(([, message]) => String(message))
        .find((message) => message.startsWith(pulledFromOwner) && !message.startsWith(`${pulledFromOwner}0 `)),
      (line) => line !== undefined,
      DELIVERY_BOUND_MS,
      250,
    );
    expect(safetyNetLine, 'member 2\'s safety net stored the write from the owner').toMatch(/: [1-9]\d* data triple\(s\) stored$/);

    // The owner sent the notice to member 2 three times, and logged it as not reached.
    const noticeLine = await pollUntil(
      () => ownerInfo.mock.calls.map(([, message]) => String(message))
        .find((message) => message.startsWith(`SWM change notice for "${contextGraphId}" sub-graph "${NOTES}"`)),
      (line) => line !== undefined,
      DELIVERY_BOUND_MS,
      500,
    );
    expect(missedNotices, 'the owner\'s notices to member 2').toHaveLength(3);
    expect(noticeLine, 'the owner\'s change notice line').toContain(`not reached: ${member2.peerId.slice(-8)}=reset`);
    for (const member of [member1, member2]) expectRelayOnlyLink(network, member, owner, 'after the write');
    expect(linkConnections(network, member1, member2), 'the members were still not connected').toEqual([]);
    await safetyNet.close();
  }, 300_000);
});
