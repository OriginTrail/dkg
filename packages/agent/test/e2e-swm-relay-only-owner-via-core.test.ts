// SPDX-License-Identifier: Apache-2.0

/**
 * E2E: members that never find the graph's owner still get their signed
 * shares to it, through the Core that hosts the graph.
 *
 * The scene of `e2e-swm-relay-only-core-holder.test.ts`, with Edges that reach
 * each other only through Cores:
 *  - the Core hosts the public graph (it holds the owner's definition) and
 *    does not subscribe to the graph's shared-memory topic;
 *  - the owner and both members dial the Core only; none of them is connected
 *    to another, and each is reachable by the others only through a relay;
 *  - neither member can find the owner for the whole test: their lookups of
 *    the owner's peer stay empty, as after phonebook fetches that overloaded
 *    Cores answered in part, and the owner's relay address is never given to
 *    them.
 * A member's share then reaches the Core and, from there, the other members as
 * a pulled copy. A pulled copy carries no author seal, and the owner needs the
 * member's signed share to keep the seal and publish the member's asset to
 * Verified Memory. Before the fix the owner never got one.
 *
 * What is asserted:
 *  1. the Core passes member 1's signed share on to the owner, which holds it
 *     with member 1's author seal within {@link OWNER_VIA_CORE_BOUND_MS}, while
 *     member 1 and the owner were never connected;
 *  2. the Core passed it on once, and still once after member 1's next pass
 *     over the shares it owes the owner;
 *  3. member 2, the second member to share into the sub-graph, gets its seal
 *     to the owner the same way.
 * Without the fix the owner holds no seal: see `CORE_PASSES_SHARES_TO_THE_OWNER`.
 *
 * White-box steps, each named where it is made: the Core is made host-only with
 * `unsubscribeFromContextGraph` and is kept out of the members' followers (as a
 * Core that runs the catalog kill switch stays out), and the members' owner
 * lookups are stubbed empty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import type { DKGAgent } from '../src/index.js';
import { holdsCoreHostedOwnerDefinition } from '../src/core-hosted-definition.js';
import { resolveDurableGraphScopedAuthorSealCandidateV1 } from '../src/durable-author-seal-resolver-v1.js';
import { OWED_PUBLIC_SHARE_RETRY_MS } from '../src/swm/owed-public-shares.js';
import { sharedMemoryFollowersOf } from '../src/swm/shared-memory-followers.js';
import { RealChainAgents, connectWithIdentify, dialableAddress, pollUntil } from './_helpers/real-chain-agent.js';
import { RelayOnlyNetwork, linkConnections } from './_helpers/relay-only-network.js';
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
 * `false` describes the code before the fix: no member's share reaches the
 * owner, and the assertions pin exactly that over their watch. With `true`
 * they require the deliveries within their bounds.
 */
const CORE_PASSES_SHARES_TO_THE_OWNER = true;

/** The Core passes a share on right after it applies it; this leaves room for a loaded host. */
const OWNER_VIA_CORE_BOUND_MS = 30_000;
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
  peerSyncSession: { isSyncing(peerId: string): boolean };
  resolveCuratorPeerIdsForCg(contextGraphId: string): Promise<{ peerIds: string[]; curatorIsLocal: boolean; legacyTripleResolved: boolean }>;
  ensureAgentsInOnDemandPhonebook(wallets: readonly string[]): Promise<ReadonlySet<string>>;
  discovery: { findAgents(options: { agentAddress?: string }): Promise<Array<{ peerId: string }>> };
  swmChangeNoticeOwnersV1(): { ownerForwarder: { appliedCount(contextGraphId: string, shareOperationId: string): number } };
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

describe('E2E: relay-only members that never find the owner share into a public graph\'s sub-graph', () => {
  const pool = new RealChainAgents();
  const tempDirs: string[] = [];
  let fileSnapshot: string;
  let network: RelayOnlyNetwork;

  async function dataDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `dkg-e2e-owner-via-core-${prefix}-`));
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

  it('gets each member\'s signed share to the owner through the hosting Core', async () => {
    const core = await pool.create({
      name: 'OwnerViaCoreCore',
      operationalKey: HARDHAT_KEYS.CORE_OP,
      listenHost: '127.0.0.1',
      dataDir: await dataDir('core'),
      nodeRole: 'core',
    });
    await core.start();
    const owner = await startEdge('OwnerViaCoreOwner', OWNER_KEY, core);
    const member1 = await startEdge('OwnerViaCoreMember1', MEMBER_1_KEY, core);
    const member2 = await startEdge('OwnerViaCoreMember2', MEMBER_2_KEY, core);
    const members = [member1, member2];
    const ownerAddress = owner.getDefaultAgentAddress()!.toLowerCase();

    // POST /api/context-graph/create (accessPolicy 0, publishPolicy 1,
    // register: true), then POST /api/sub-graph/create.
    const contextGraphId = `${ownerAddress}/owner-via-core-${RUN}`;
    await owner.createContextGraph({
      id: contextGraphId,
      name: 'Owner via Core E2E',
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
    for (const member of members) {
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

    for (const member of members) {
      // White-box: the member never finds the owner, as after partial phonebook fetches.
      const resolveCurator = internals(member).resolveCuratorPeerIdsForCg.bind(member);
      internals(member).resolveCuratorPeerIdsForCg = async (graphId) => (graphId === contextGraphId
        ? { peerIds: [], curatorIsLocal: false, legacyTripleResolved: false }
        : resolveCurator(graphId));
      internals(member).ensureAgentsInOnDemandPhonebook = async () => new Set<string>();
      // White-box: the Core does not follow the graph on the member (see the core-holder suite).
      const followers = sharedMemoryFollowersOf(member);
      const followersOf = followers.followers.bind(followers);
      followers.followers = (graphId) => followersOf(graphId).filter((peerId) => peerId !== core.peerId);
    }

    await whenNobodyPulls([core, owner, ...members]);

    // The scene of the shares, checked before they are made.
    expect(internals(core).subscribedContextGraphs.get(contextGraphId), 'the Core hosts the graph without subscribing')
      .toMatchObject({ coreHosted: true, subscribed: false });
    for (const member of members) {
      expect(await internals(member).discovery.findAgents({ agentAddress: ownerAddress }), 'the member\'s phonebook has no owner').toEqual([]);
      expect(isConnected(member, owner) || isConnected(owner, member), 'the member is not connected to the owner').toBe(false);
    }
    expect(isConnected(owner, core), 'the owner is connected to the Core').toBe(true);

    /** Member `member` writes and promotes one report into the sub-graph; resolves with what the owner must hold. */
    const share = async (member: DKGAgent, label: string) => {
      const scope = { subGraphName: REPORTS };
      const assertionName = `report-${label}-${RUN}`;
      const subject = `urn:e2e:owner-via-core:${label}:${RUN}`;
      const literal = `"a report by ${label}"`;
      await member.assertion.create(contextGraphId, assertionName, scope);
      await member.assertion.write(contextGraphId, assertionName, [{ subject, predicate: NAME, object: literal }], scope);
      const promoted = await member.assertion.promote(contextGraphId, assertionName, scope);
      expect(promoted.promotedCount).toBeGreaterThan(0);
      const sealAtOwner = () => resolveDurableGraphScopedAuthorSealCandidateV1({
        store: owner.store,
        contextGraphId: contextGraphId as never,
        agentAddress: member.getDefaultAgentAddress()!.toLowerCase(),
        assertionCoordinate: assertionName,
        subGraphName: REPORTS,
        source: 'e2e.ownerViaCore.ownerSeal',
      }).catch(() => undefined);
      const seal = await pollUntil(
        sealAtOwner,
        (candidate) => candidate !== undefined,
        CORE_PASSES_SHARES_TO_THE_OWNER ? OWNER_VIA_CORE_BOUND_MS : ABSENCE_WATCH_MS,
        500,
      );
      return { seal, subject, literal, shareOperationId: promoted.shareOperationId };
    };

    // 1. Member 1's share reaches the owner through the Core, with its seal.
    const first = await share(member1, 'member1');
    if (!CORE_PASSES_SHARES_TO_THE_OWNER) {
      expect(first.seal, 'before the fix no member\'s share reaches the owner; if one does, set CORE_PASSES_SHARES_TO_THE_OWNER to true').toBeUndefined();
      return;
    }
    expect(first.seal, 'the owner holds member 1\'s author seal').toBeDefined();
    expect(await holdsShare(owner, first.subject, first.literal), 'the owner holds member 1\'s share').toBe(true);
    expect(linkConnections(network, member1, owner), 'member 1 and the owner were never connected').toEqual([]);
    expect(linkConnections(network, owner, member1)).toEqual([]);

    // 2. The Core passed it on once, and still once after member 1's next pass
    // over the shares it owes the owner.
    expect(first.shareOperationId, 'the promote names its share operation').toBeDefined();
    const forwards = () => internals(core).swmChangeNoticeOwnersV1().ownerForwarder.appliedCount(contextGraphId, first.shareOperationId!);
    expect(forwards(), 'the Core\'s forwards of member 1\'s share').toBe(1);
    await new Promise<void>((resolve) => setTimeout(resolve, OWED_PUBLIC_SHARE_RETRY_MS + 5_000));
    expect(forwards(), 'the Core\'s forwards of member 1\'s share after an owed-share pass').toBe(1);

    // 3. Member 2, the second member to share, reaches the owner the same way.
    const second = await share(member2, 'member2');
    expect(second.seal, 'the owner holds member 2\'s author seal').toBeDefined();
    expect(await holdsShare(owner, second.subject, second.literal), 'the owner holds member 2\'s share').toBe(true);
    expect(linkConnections(network, member2, owner), 'member 2 and the owner were never connected').toEqual([]);
  }, 600_000);
});
