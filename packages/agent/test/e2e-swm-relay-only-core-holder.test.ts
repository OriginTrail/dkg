// SPDX-License-Identifier: Apache-2.0

/**
 * E2E: a member's share into a public graph's named sub-graph, made while no
 * other node can be reached for it, still gets to the graph's other members and
 * to its owner.
 *
 * The scene right after a registered public graph is created, with Edges that
 * reach each other only through Cores:
 *  - the Core hosts the graph (it holds the owner's definition) but does not
 *    subscribe to the graph's shared-memory topic yet;
 *  - the owner and both members dial the Core only; none of them is connected
 *    to another, and each is reachable by the others only through a relay;
 *  - member 1 cannot find the owner: its lookup of the owner's peer comes back
 *    empty, as after a phonebook fetch that overloaded Cores answered in part.
 * Member 1's share then had no subscriber, no follower and no routed owner. It
 * went to nobody, without a word, and nothing sent it again.
 *
 * What is asserted:
 *  1. member 1 sends the share to the Core it is connected to, and the Core,
 *     which hosts the graph, keeps it;
 *  2. member 2, connected to the Core only, gets it from there (its periodic
 *     pull of a graph in use);
 *  3. once member 1 can find the owner, it sends the share again, now to the
 *     owner through the relay, and the owner holds it with member 1's author
 *     seal (a copy pulled from the Core carries none, and the owner needs the
 *     seal to publish the member's asset).
 * Without the fix none of it happens: see `SHARES_REACH_A_HOSTING_CORE`.
 *
 * White-box steps, each named where it is made: the Core is made host-only with
 * `unsubscribeFromContextGraph` and is kept out of member 1's followers (as a
 * Core that runs the catalog kill switch stays out), member 1's owner lookup
 * is stubbed, and the owner's circuit address is put into member 1's peer
 * store as the owner's phonebook profile would supply it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { contextGraphWorkspaceTopic } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../src/index.js';
import { holdsCoreHostedOwnerDefinition } from '../src/core-hosted-definition.js';
import { resolveDurableGraphScopedAuthorSealCandidateV1 } from '../src/durable-author-seal-resolver-v1.js';
import { sharedMemoryFollowersOf } from '../src/swm/shared-memory-followers.js';
import { RealChainAgents, connectWithIdentify, dialableAddress, pollUntil } from './_helpers/real-chain-agent.js';
import { RelayOnlyNetwork, expectRelayOnlyLink, linkConnections } from './_helpers/relay-only-network.js';
import {
  HARDHAT_KEYS,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

/**
 * THE SWITCH for the fix: the one line of this file the fix changes.
 *
 * `false` describes the code before the fix: member 1's share reaches neither
 * the Core nor, later, the owner, and the assertions pin exactly that over
 * their watch. With `true` they require the deliveries within their bounds.
 */
const SHARES_REACH_A_HOSTING_CORE = true;

/** The share goes to the Core when it is made. */
const CORE_BOUND_MS = 30_000;
/** Member 2 pulls a graph in use from its peers every minute. */
const MEMBER_PULL_BOUND_MS = 150_000;
/**
 * A share owed to the owner is sent again every 30 s, and the owner route asks
 * for the owner again a minute after it last found none.
 */
const OWNER_BOUND_MS = 150_000;
/** How long a delivery that must not happen is watched for. */
const ABSENCE_WATCH_MS = 20_000;
/** The background sync rounds that follow a connection or a subscribe end well within this. */
const BACKGROUND_SYNC_BOUND_MS = 90_000;

const NAME = 'http://schema.org/name';
/** A run of this file never collides with another run's graphs. */
const RUN = Date.now().toString(36);
const OWNER_KEY = HARDHAT_KEYS.EXTRA2;
const MEMBER_1_KEY = HARDHAT_KEYS.EXTRA1;
const MEMBER_2_KEY = HARDHAT_KEYS.EXTRA3;
const REPORTS = 'reports';

interface Internals {
  subscribedContextGraphs: Map<string, { subscribed?: boolean; coreHosted?: boolean }>;
  gossip: { getSubscribers(topic: string): string[] };
  gossipWireIdFor(contextGraphId: string): string;
  peerSyncSession: { isSyncing(peerId: string): boolean };
  resolveCuratorPeerIdsForCg(contextGraphId: string): Promise<{ peerIds: string[]; curatorIsLocal: boolean; legacyTripleResolved: boolean }>;
  ensureAgentsInOnDemandPhonebook(wallets: readonly string[]): Promise<ReadonlySet<string>>;
}

function internals(agent: DKGAgent): Internals {
  return agent as unknown as Internals;
}

function isConnected(from: DKGAgent, to: DKGAgent): boolean {
  return from.node.libp2p.getConnections().some((connection) => connection.remotePeer.toString() === to.peerId);
}

/** A background pull is queued or running on `agent`. */
function isPulling(agent: DKGAgent): boolean {
  if (agent.getSyncOnConnectPeerScheduler().size > 0) return true;
  return agent.node.libp2p.getPeers().some((peer) => internals(agent).peerSyncSession.isSyncing(peer.toString()));
}

/** Until no agent pulls, three polls in a row: a share made after this is not fetched by a round already running. */
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

/** Whether `agent`'s store holds the share's triple, in any graph. */
async function holdsShare(agent: DKGAgent, subject: string, literal: string): Promise<boolean> {
  const result = await agent.store.query(`ASK { GRAPH ?g { <${subject}> <${NAME}> ${literal} } }`);
  return result.type === 'boolean' ? result.value : false;
}

function deliveredDirectly(author: DKGAgent, contextGraphId: string): number {
  return author.getSwmSubstrateFanoutStats().delivered[contextGraphId] ?? 0;
}

describe('E2E: a relay-only member\'s sub-graph share while no Core subscribes and the owner is not found', () => {
  const pool = new RealChainAgents();
  const tempDirs: string[] = [];
  let fileSnapshot: string;
  let network: RelayOnlyNetwork;

  async function dataDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `dkg-e2e-core-holder-${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    fileSnapshot = await takeSnapshot();
    // Registering a Context Graph pulls the registration deposit.
    const { hubAddress } = getSharedContext();
    const owner = new ethers.Wallet(OWNER_KEY);
    await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, owner.address, ethers.parseEther('50000000'));
    network = await RelayOnlyNetwork.start();
  }, 120_000);

  afterAll(async () => {
    await pool.stopAll();
    await network?.stop();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    await revertSnapshot(fileSnapshot);
  }, 120_000);

  /** An Edge behind the relay that dials the Core at start and nobody else. */
  async function startEdge(name: string, operationalKey: string, core: DKGAgent): Promise<DKGAgent> {
    const agent = await pool.create({
      name,
      operationalKey,
      listenHost: '127.0.0.1',
      dataDir: await dataDir(name),
      bootstrapPeers: [dialableAddress(core)],
      ...(await network.addressing()),
    });
    await agent.start();
    await connectWithIdentify(agent, core);
    return agent;
  }

  it('reaches the hosting Core at once, the other member from there, and the owner with its seal once the owner is found', async () => {
    const core = await pool.create({
      name: 'CoreHolderCore',
      operationalKey: HARDHAT_KEYS.CORE_OP,
      listenHost: '127.0.0.1',
      dataDir: await dataDir('core'),
      nodeRole: 'core',
    });
    await core.start();
    const owner = await startEdge('CoreHolderOwner', OWNER_KEY, core);
    const member1 = await startEdge('CoreHolderMember1', MEMBER_1_KEY, core);
    const member2 = await startEdge('CoreHolderMember2', MEMBER_2_KEY, core);
    const edges = [owner, member1, member2];
    const ownerAddress = owner.getDefaultAgentAddress()!.toLowerCase();
    const member1Address = member1.getDefaultAgentAddress()!.toLowerCase();

    // POST /api/context-graph/create (accessPolicy 0, publishPolicy 1,
    // register: true), then POST /api/sub-graph/create.
    const contextGraphId = `${ownerAddress}/core-holder-${RUN}`;
    await owner.createContextGraph({
      id: contextGraphId,
      name: 'Core holder E2E',
      description: '',
      accessPolicy: 0,
      callerAgentAddress: ownerAddress,
    });
    const registered = await owner.registerContextGraph(contextGraphId, {
      accessPolicy: 0,
      publishPolicy: 1,
      callerAgentAddress: ownerAddress,
    });
    const onChainId = String(registered.onChainId);
    await owner.createSubGraph(contextGraphId, REPORTS);

    // The Core comes to host the graph, as the StorageACK gate makes it host
    // one, and keeps the owner's definition.
    const recorded = await pollUntil(
      () => core.recordCoreHostedPublicCg(onChainId, contextGraphId, { durable: false, nudge: false }),
      (outcome) => outcome === 'recorded' || outcome === 'already-recorded',
      60_000,
      1_000,
    );
    expect(['recorded', 'already-recorded']).toContain(recorded);
    const held = await pollUntil(
      () => holdsCoreHostedOwnerDefinition(core.store, contextGraphId, ownerAddress),
      (outcome) => outcome,
      60_000,
      500,
    );
    expect(held, 'the Core holds the owner\'s definition').toBe(true);
    // White-box: a host-only Core, as one that has not joined the graph's topic yet.
    core.unsubscribeFromContextGraph(contextGraphId);

    // POST /api/context-graph/subscribe on both members.
    for (const member of [member1, member2]) {
      const admission = await member.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
        callerAgentAddress: member.getDefaultAgentAddress()!.toLowerCase(),
        allowSubscriptionFallback: false,
      });
      expect(admission).toMatchObject({ outcome: 'allowed' });
      member.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', onChainId });
      const fetched = await pollUntil(
        () => member.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(contextGraphId, undefined, { contextGraphId, onChainId })
          .catch(() => 'failed' as const),
        (outcome) => outcome === 'fetched' || outcome === 'already-confirmed',
        60_000,
        1_000,
      );
      expect(['fetched', 'already-confirmed'], 'how the member obtained the definition').toContain(fetched);
      expect((await member.listSubGraphs(contextGraphId)).map((subGraph) => subGraph.name)).toContain(REPORTS);
    }

    // White-box: member 1 cannot find the owner, as after a partial phonebook fetch.
    let ownerFound = false;
    const resolveCurator = internals(member1).resolveCuratorPeerIdsForCg.bind(member1);
    internals(member1).resolveCuratorPeerIdsForCg = async (graphId) => (graphId === contextGraphId
      ? { peerIds: ownerFound ? [owner.peerId] : [], curatorIsLocal: false, legacyTripleResolved: ownerFound }
      : resolveCurator(graphId));
    internals(member1).ensureAgentsInOnDemandPhonebook = async () => new Set<string>();
    // White-box: the Core does not follow the graph on member 1. A Core that
    // hosts a catalog-owned graph asks each member to replay the graph's
    // catalog heads, and that request makes it a follower there, which a share
    // is sent to. Cores that run the catalog kill switch ask nothing.
    const followers = sharedMemoryFollowersOf(member1);
    const followersOf = followers.followers.bind(followers);
    followers.followers = (graphId) => followersOf(graphId).filter((peerId) => peerId !== core.peerId);

    await whenNobodyPulls([core, ...edges]);

    // The scene of the share, checked before it is made.
    const coreRow = internals(core).subscribedContextGraphs.get(contextGraphId);
    expect(coreRow, 'the Core hosts the graph without subscribing').toMatchObject({ coreHosted: true, subscribed: false });
    for (const member of [member1, member2]) {
      const topic = contextGraphWorkspaceTopic(internals(member).gossipWireIdFor(contextGraphId));
      expect(internals(member).gossip.getSubscribers(topic), 'the Core is no subscriber of the graph\'s topic').not.toContain(core.peerId);
    }
    expect(sharedMemoryFollowersOf(member1).followers(contextGraphId), 'nobody follows the graph on member 1').toEqual([]);
    expect(isConnected(member1, member2) || isConnected(member2, member1), 'the members are not connected').toBe(false);
    expect(isConnected(member1, owner) || isConnected(owner, member1), 'member 1 is not connected to the owner').toBe(false);

    // POST /api/knowledge-assets naming the sub-graph, then its share.
    const scope = { subGraphName: REPORTS };
    const assertionName = `report-${RUN}`;
    const subject = `urn:e2e:core-holder:${RUN}`;
    const literal = '"a report"';
    const deliveredBefore = deliveredDirectly(member1, contextGraphId);
    await member1.assertion.create(contextGraphId, assertionName, scope);
    await member1.assertion.write(contextGraphId, assertionName, [{ subject, predicate: NAME, object: literal }], scope);
    const promoted = await member1.assertion.promote(contextGraphId, assertionName, scope);
    expect(promoted.promotedCount).toBeGreaterThan(0);

    // 1. The Core holds it.
    const atCore = await pollUntil(
      () => holdsShare(core, subject, literal),
      (holds) => holds,
      SHARES_REACH_A_HOSTING_CORE ? CORE_BOUND_MS : ABSENCE_WATCH_MS,
      500,
    );
    await member1.awaitInFlightSubstrateFanOuts();
    if (SHARES_REACH_A_HOSTING_CORE) {
      expect(atCore, 'the hosting Core holds member 1\'s share').toBe(true);
      expect(deliveredDirectly(member1, contextGraphId) - deliveredBefore, 'receivers that applied member 1\'s direct send').toBe(1);
    } else {
      expect(atCore, 'before the fix the share reaches no Core; if it does, set SHARES_REACH_A_HOSTING_CORE to true').toBe(false);
      expect(deliveredDirectly(member1, contextGraphId)).toBe(deliveredBefore);
    }

    // 2. Member 2, connected to the Core only, gets it from there.
    const atMember2 = await pollUntil(
      () => holdsShare(member2, subject, literal),
      (holds) => holds,
      SHARES_REACH_A_HOSTING_CORE ? MEMBER_PULL_BOUND_MS : ABSENCE_WATCH_MS,
      1_000,
    );
    expect(atMember2, 'member 2 holds member 1\'s share').toBe(SHARES_REACH_A_HOSTING_CORE);
    expect(linkConnections(network, member1, member2), 'the members were never connected').toEqual([]);

    // 3. Member 1 finds the owner now (white-box: the lookup, and the owner's
    // circuit address as its phonebook profile supplies it).
    await member1.node.libp2p.peerStore.merge(peerIdFromString(owner.peerId), {
      multiaddrs: [multiaddr(network.circuitAddressOf(owner))],
    });
    ownerFound = true;
    const deliveredBeforeOwner = deliveredDirectly(member1, contextGraphId);
    const sealAtOwner = () => resolveDurableGraphScopedAuthorSealCandidateV1({
      store: owner.store,
      contextGraphId: contextGraphId as never,
      agentAddress: member1Address,
      assertionCoordinate: assertionName,
      subGraphName: REPORTS,
      source: 'e2e.coreHolder.ownerSeal',
    }).catch(() => undefined);
    const seal = await pollUntil(
      sealAtOwner,
      (candidate) => candidate !== undefined,
      SHARES_REACH_A_HOSTING_CORE ? OWNER_BOUND_MS : ABSENCE_WATCH_MS,
      1_000,
    );
    if (SHARES_REACH_A_HOSTING_CORE) {
      expect(seal, 'the owner holds member 1\'s author seal').toBeDefined();
      expect(await holdsShare(owner, subject, literal), 'the owner holds member 1\'s share').toBe(true);
      await member1.awaitInFlightSubstrateFanOuts();
      expect(deliveredDirectly(member1, contextGraphId), 'member 1 delivered the share to the owner').toBeGreaterThan(deliveredBeforeOwner);
      expectRelayOnlyLink(network, member1, owner, 'after the share reached the owner');
    } else {
      expect(seal, 'before the fix nothing sends the share to the owner again').toBeUndefined();
    }
  }, 600_000);
});
