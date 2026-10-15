// SPDX-License-Identifier: Apache-2.0

/**
 * A node asks whether it may use a graph's shared memory before it subscribes
 * to the graph's shared-memory gossip, and before it plans an SWM sync of the
 * graph. For a catalog-owned graph the answer comes from the RFC-64 policy
 * the node has accepted for it. Until one is accepted the check says "no",
 * and that "no" only waits for the policy: the node says at info what it
 * waits for, and says once that the wait is over when it subscribes. A "no"
 * from an accepted policy, or from a legacy check, is a refusal and stays a
 * warning.
 *
 * These run the production reconcile, sync planning, shared-memory check and
 * accepted-authority resolution on a default edge, where every application
 * graph's shared memory is catalog-owned. Only the graph's RFC-64 state is
 * scripted (whether its catalog authority governs transport, the policy the
 * catalog service has accepted, the last refresh failure), with the gossip
 * manager, which is a recorder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeNetworkId,
  createOperationContext,
  type GossipSubManager,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';

const NETWORK_ID = 'otp:20430';
const CG = '0x0000000000000000000000000000000000000001/swm-gossip-authority-wait';
const OTHER_MEMBER = '0x2222222222222222222222222222222222222222';

type Transport = 'catalog-blocked' | 'catalog-active';
type Accepted = 'none' | 'public' | 'private-without-this-node';

interface Internals {
  config: DKGAgent['config'];
  log: Pick<DKGAgent['log'], 'info' | 'debug' | 'warn'>;
  gossip: GossipSubManager;
  sharedMemoryGossipRegistered: Set<string>;
  subscribedContextGraphs: Map<string, Record<string, unknown>>;
  resolveRfc64CatalogReceiverAuthorityV1(contextGraphId: string): unknown;
  rfc64CatalogAuthorityRefreshFailureReasonV1(contextGraphId: string): string | null;
  rfc64PrivateRootSwmOnLegacyLaneV1(contextGraphId: string): Promise<boolean>;
  hasConfirmedSharedMemoryMetaState(contextGraphId: string): Promise<boolean>;
  canReadContextGraph(contextGraphId: string, options: unknown): Promise<boolean>;
  canUseSharedMemoryForContextGraph(
    contextGraphId: string,
    options?: { onAuthorityWait?: (wait: unknown) => void },
  ): Promise<boolean>;
  reconcileSwmHostModeSubscription(contextGraphId: string): Promise<void>;
  reconcileSharedMemoryGossipSubscription(contextGraphId: string): Promise<void>;
  planSharedMemorySyncContextGraphs(
    remotePeerId: string | undefined,
    contextGraphIds: readonly string[],
    ctx: ReturnType<typeof createOperationContext>,
  ): Promise<{ targets: ReadonlyArray<{ contextGraphId: string }> }>;
}

/** The receiver policy of a catalog-owned graph, as the agent resolves it. */
function receiverAuthority(transport: Transport) {
  return {
    contextGraphId: CG,
    selected: false,
    eligible: true,
    active: transport === 'catalog-active',
    mode: 'catalog',
    killSwitchActive: false,
    legacySyncAllowed: false,
    track2Enabled: true,
    authoringAllowed: true,
    reconciliationLane: 'catalog-apply',
  };
}

const WAITING_FOR = 'the graph\'s RFC-64 authority';
const NOT_ACCEPTED = 'not accepted on this node yet';
const waits = (detail: string, meanwhile: string) => (
  `SWM gossip subscription for "${CG}" waits for ${WAITING_FOR} (${detail}); ${meanwhile}`
);
const made = `SWM gossip subscription for "${CG}" made after waiting for ${WAITING_FOR}`;
const denied = `SWM gossip subscription denied for "${CG}": local node is not authorized`;

describe('shared-memory gossip and sync of a graph whose RFC-64 authority is not in place', () => {
  let agent: DKGAgent;
  let internals: Internals;
  let defaultPlan: DKGAgent['config']['rfc64CatalogExecutionPlan'];
  /** The graph's scripted RFC-64 state. */
  const rfc64 = {
    transport: 'catalog-blocked' as Transport,
    accepted: 'none' as Accepted,
    refreshFailure: null as string | null,
  };
  /** Accept the graph's public policy, as the authority refresh does. */
  const acceptPublicPolicy = (): void => {
    rfc64.transport = 'catalog-active';
    rfc64.accepted = 'public';
    rfc64.refreshFailure = null;
  };
  const catalogService = {
    acceptedPolicySnapshot: (networkId: string, contextGraphId: string) => {
      if (networkId !== NETWORK_ID || contextGraphId !== CG) return null;
      if (rfc64.accepted === 'none') return null;
      return rfc64.accepted === 'public'
        ? { policy: { accessPolicy: 0 }, roster: null }
        : { policy: { accessPolicy: 1 }, roster: { members: [{ agentAddress: OTHER_MEMBER }] } };
    },
  };
  let manager: {
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    onMessage: ReturnType<typeof vi.fn>;
    offMessage: ReturnType<typeof vi.fn>;
  };
  let spies: Record<'info' | 'debug' | 'warn', ReturnType<typeof vi.spyOn>>;
  const logged = (level: 'info' | 'debug' | 'warn', prefix: string): string[] => spies[level].mock.calls
    .map(([, message]) => String(message))
    .filter((message) => message.startsWith(prefix));
  const gossipLines = (level: 'info' | 'debug' | 'warn') => logged(level, 'SWM gossip');
  const subscribed = (): boolean => internals.sharedMemoryGossipRegistered.has(CG);
  /** What a subscription, metadata or authority event does to the graph. */
  const reconcile = () => internals.reconcileSharedMemoryGossipSubscription(CG);

  beforeAll(async () => {
    agent = await DKGAgent.create({
      name: 'SwmGossipAuthorityWait',
      chainAdapter: new MockChainAdapter(NETWORK_ID),
      networkIdentity: { networkId: await computeNetworkId(), chainId: NETWORK_ID },
    });
    internals = agent as unknown as Internals;
    defaultPlan = internals.config.rfc64CatalogExecutionPlan;
  });

  afterAll(async () => {
    try { await agent.stop(); } catch { /* never started */ }
  });

  beforeEach(() => {
    rfc64.transport = 'catalog-blocked';
    rfc64.accepted = 'none';
    rfc64.refreshFailure = null;
    // A default edge: an application graph's shared memory is catalog-owned.
    internals.config.rfc64CatalogExecutionPlan = { ...defaultPlan, responsibilityDefaultMode: 'catalog' };
    internals.subscribedContextGraphs.set(CG, { subscribed: true, synced: false, syncMode: 'always-on' });
    vi.spyOn(internals, 'resolveRfc64CatalogReceiverAuthorityV1')
      .mockImplementation(() => receiverAuthority(rfc64.transport));
    vi.spyOn(internals, 'rfc64CatalogAuthorityRefreshFailureReasonV1')
      .mockImplementation(() => rfc64.refreshFailure);
    Object.defineProperty(agent, 'rfc64PublicCatalogServiceV1', {
      configurable: true,
      get: () => catalogService,
    });
    // Host mode is a core's business; this edge only records that it was asked.
    vi.spyOn(internals, 'reconcileSwmHostModeSubscription').mockResolvedValue(undefined);
    manager = { subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn() };
    // A fresh gossip session per case, as after a start.
    internals.gossip = manager as unknown as GossipSubManager;
    spies = {
      info: vi.spyOn(internals.log, 'info'),
      debug: vi.spyOn(internals.log, 'debug'),
      warn: vi.spyOn(internals.log, 'warn'),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (agent as unknown as Record<string, unknown>).rfc64PublicCatalogServiceV1;
    internals.config.rfc64CatalogExecutionPlan = defaultPlan;
    internals.subscribedContextGraphs.delete(CG);
  });

  it('says what the subscription waits for, and once that it is made when the policy is accepted', async () => {
    await reconcile();
    expect(subscribed()).toBe(false);
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(gossipLines('warn')).toEqual([]);
    expect(gossipLines('info')).toEqual([waits(NOT_ACCEPTED, 'not subscribed yet')]);

    // Another event before the policy is accepted: said again only at debug.
    await reconcile();
    expect(gossipLines('info')).toHaveLength(1);
    expect(gossipLines('debug')).toContain(waits(NOT_ACCEPTED, 'not subscribed yet'));

    // The refresh accepts the graph's policy and reconciles the graph again.
    acceptPublicPolicy();
    await reconcile();
    expect(subscribed()).toBe(true);
    expect(manager.subscribe).toHaveBeenCalled();
    expect(gossipLines('info')).toEqual([waits(NOT_ACCEPTED, 'not subscribed yet'), made]);

    // Nothing more to say for a subscription that holds.
    await reconcile();
    expect(gossipLines('info')).toHaveLength(2);
    expect(gossipLines('warn')).toEqual([]);
  });

  it('names the last failed refresh, and says again at info when that changes', async () => {
    rfc64.refreshFailure = 'unregistered-owner-unresolved';
    await reconcile();
    await reconcile();
    rfc64.refreshFailure = 'registered-authority-unfinalized';
    await reconcile();
    expect(gossipLines('info')).toEqual([
      waits('last refresh: unregistered-owner-unresolved', 'not subscribed yet'),
      waits('last refresh: registered-authority-unfinalized', 'not subscribed yet'),
    ]);
    expect(gossipLines('debug')).toContain(
      waits('last refresh: unregistered-owner-unresolved', 'not subscribed yet'),
    );
    expect(gossipLines('warn')).toEqual([]);
  });

  it('waits the same way when the transport is governed but no policy is accepted yet', async () => {
    rfc64.transport = 'catalog-active';
    await reconcile();
    expect(subscribed()).toBe(false);
    expect(gossipLines('info')).toEqual([waits(NOT_ACCEPTED, 'not subscribed yet')]);
    expect(gossipLines('warn')).toEqual([]);
  });

  it('keeps an accepted policy that does not admit this node a refusal at warn', async () => {
    await reconcile();
    expect(gossipLines('info')).toEqual([waits(NOT_ACCEPTED, 'not subscribed yet')]);

    rfc64.transport = 'catalog-active';
    rfc64.accepted = 'private-without-this-node';
    await reconcile();
    expect(subscribed()).toBe(false);
    expect(gossipLines('warn')).toEqual([denied]);
    expect(internals.reconcileSwmHostModeSubscription).toHaveBeenCalledWith(CG);

    // The refusal ended the wait: a later subscription is not "after waiting".
    acceptPublicPolicy();
    await reconcile();
    expect(subscribed()).toBe(true);
    expect(gossipLines('info')).toEqual([waits(NOT_ACCEPTED, 'not subscribed yet')]);
  });

  it('drops a held subscription while the authority is not in place again, and says why at info', async () => {
    acceptPublicPolicy();
    await reconcile();
    expect(subscribed()).toBe(true);
    expect(gossipLines('info')).toEqual([]);

    // A replica's refresh failed: its authority stops governing transport.
    rfc64.transport = 'catalog-blocked';
    rfc64.refreshFailure = 'registered-authority-unfinalized';
    await reconcile();
    expect(subscribed()).toBe(false);
    expect(manager.unsubscribe).toHaveBeenCalledTimes(1);
    expect(gossipLines('warn')).toEqual([]);
    expect(gossipLines('info')).toEqual([
      waits('last refresh: registered-authority-unfinalized', 'unsubscribed until then'),
    ]);

    acceptPublicPolicy();
    await reconcile();
    expect(subscribed()).toBe(true);
    expect(gossipLines('info')).toHaveLength(2);
    expect(gossipLines('info')[1]).toBe(made);
  });

  it('takes a "no" given before the policy was accepted as a wait, though it is accepted before the check ends', async () => {
    // The check's member-lane read is out when the refresh accepts the graph's
    // policy: the "no" was given without one.
    let resolveLane!: (onLane: boolean) => void;
    const lane = vi.spyOn(internals, 'rfc64PrivateRootSwmOnLegacyLaneV1')
      .mockReturnValueOnce(new Promise((resolve) => { resolveLane = resolve; }));
    const pass = reconcile();
    await vi.waitFor(() => expect(lane).toHaveBeenCalledTimes(1));
    acceptPublicPolicy();
    resolveLane(false);
    await pass;
    expect(subscribed()).toBe(false);
    expect(gossipLines('warn')).toEqual([]);
    expect(gossipLines('info')).toEqual([waits(NOT_ACCEPTED, 'not subscribed yet')]);

    // The acceptance's own reconcile.
    await reconcile();
    expect(subscribed()).toBe(true);
    expect(gossipLines('info')).toEqual([waits(NOT_ACCEPTED, 'not subscribed yet'), made]);
  });

  it('says the subscription is in place when another pass made it during the wait', async () => {
    let resolveLane!: (onLane: boolean) => void;
    vi.spyOn(internals, 'rfc64PrivateRootSwmOnLegacyLaneV1')
      .mockReturnValueOnce(new Promise((resolve) => { resolveLane = resolve; }));
    const waiting = reconcile();
    await vi.waitFor(() => expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1).toHaveBeenCalledTimes(1));
    // A second event reconciles the graph after the policy is accepted.
    acceptPublicPolicy();
    await reconcile();
    expect(subscribed()).toBe(true);
    resolveLane(false);
    await waiting;
    expect(gossipLines('info')).toEqual([waits(NOT_ACCEPTED, 'not subscribed yet')]);

    await reconcile();
    expect(subscribed()).toBe(true);
    expect(gossipLines('info')).toEqual([
      waits(NOT_ACCEPTED, 'not subscribed yet'),
      `SWM gossip subscription for "${CG}" is in place after waiting for ${WAITING_FOR}`,
    ]);
  });

  it('tells the check\'s option only what a wait waits for, and answers the same without it', async () => {
    const heard: unknown[] = [];
    const onAuthorityWait = (wait: unknown): void => { heard.push(wait); };
    const refreshReads = vi.mocked(internals.rfc64CatalogAuthorityRefreshFailureReasonV1);

    await expect(internals.canUseSharedMemoryForContextGraph(CG, { onAuthorityWait })).resolves.toBe(false);
    expect(heard).toEqual([{ waitingFor: WAITING_FOR, detail: NOT_ACCEPTED }]);
    // A caller without the option gets the same answer, and the wait is not
    // worked out for it.
    refreshReads.mockClear();
    await expect(internals.canUseSharedMemoryForContextGraph(CG)).resolves.toBe(false);
    expect(refreshReads).not.toHaveBeenCalled();

    // A refusal and a "yes" tell the option nothing.
    rfc64.transport = 'catalog-active';
    rfc64.accepted = 'private-without-this-node';
    await expect(internals.canUseSharedMemoryForContextGraph(CG, { onAuthorityWait })).resolves.toBe(false);
    acceptPublicPolicy();
    await expect(internals.canUseSharedMemoryForContextGraph(CG, { onAuthorityWait })).resolves.toBe(true);
    expect(heard).toHaveLength(1);
  });

  it('keeps a refusal by the legacy checks a warning while the RFC-64 authority is not in place', async () => {
    // A private member by the graph's own metadata keeps the legacy member
    // lane (#2858); there the legacy read check refuses.
    vi.spyOn(internals, 'rfc64PrivateRootSwmOnLegacyLaneV1').mockResolvedValue(true);
    vi.spyOn(internals, 'hasConfirmedSharedMemoryMetaState').mockResolvedValue(true);
    const canRead = vi.spyOn(internals, 'canReadContextGraph').mockResolvedValue(false);
    await reconcile();
    expect(canRead).toHaveBeenCalledTimes(1);
    expect(subscribed()).toBe(false);
    expect(gossipLines('info')).toEqual([]);
    expect(gossipLines('warn')).toEqual([denied]);
  });

  describe('SWM sync planning', () => {
    const syncWaits = (detail: string) => (
      `Skipping SWM sync for "${CG}" for now: it waits for ${WAITING_FOR} (${detail})`
    );
    const syncRefused = `Skipping SWM sync for unauthorized or unconfirmed context graph "${CG}"`;
    const plan = async (peer: string) => (
      await internals.planSharedMemorySyncContextGraphs(peer, [CG], createOperationContext('sync'))
    ).targets.map(({ contextGraphId }) => contextGraphId);
    const syncLines = (level: 'info' | 'debug' | 'warn') => logged(level, 'Skipping SWM sync');

    it('skips the graph at info once per wait, plans it once the policy is accepted', async () => {
      // Every connected peer plans the graph.
      expect(await plan('12D3KooWAuthorityWaitPeerA')).toEqual([]);
      expect(await plan('12D3KooWAuthorityWaitPeerB')).toEqual([]);
      expect(syncLines('info')).toEqual([syncWaits(NOT_ACCEPTED)]);
      expect(syncLines('debug')).toEqual([syncWaits(NOT_ACCEPTED)]);
      expect(syncLines('warn')).toEqual([]);

      acceptPublicPolicy();
      expect(await plan('12D3KooWAuthorityWaitPeerA')).toEqual([CG]);

      // A later wait is a new one, said at info again.
      rfc64.transport = 'catalog-blocked';
      rfc64.accepted = 'none';
      expect(await plan('12D3KooWAuthorityWaitPeerA')).toEqual([]);
      expect(syncLines('info')).toEqual([syncWaits(NOT_ACCEPTED), syncWaits(NOT_ACCEPTED)]);
    });

    it('keeps the warning for a refusal', async () => {
      rfc64.transport = 'catalog-active';
      rfc64.accepted = 'private-without-this-node';
      expect(await plan('12D3KooWAuthorityWaitPeerA')).toEqual([]);
      expect(syncLines('warn')).toEqual([syncRefused]);
      expect(syncLines('info')).toEqual([]);
    });
  });
});
