// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 replica `_meta` bootstrap must never install a chain binding it did
 * not verify against the chain.
 *
 * Review repro: a connected NON-OWNER peer serves a public `_meta` for a
 * genuinely owner-signed, unregistered graph and adds `OnChainId="777"` (plus
 * `OnChainHash` and `registrationStatus "registered"`). Before the guard the
 * bootstrap installed the snapshot, `applyCuratorRegistrationBinding` bound
 * the replica to on-chain id 777, and that phantom binding fenced the
 * replica's RFC-64 authority and gossip. Now:
 *  - the relayed snapshot's chain-registration claims are stripped before the
 *    projection is installed and the subscription binding step is skipped
 *    (`ignoreRegistrationBinding`), so the declaration still lands and the
 *    binding stays `undefined`;
 *  - a snapshot whose `dkg:curator` is not the accepted owner is rejected
 *    outright (`expectedCuratorAddress`);
 *  - the authenticated curator/join-approval refreshes keep binding.
 *
 * Unit half: the refresh over a fake agent + in-memory store. Integration
 * half: two real agents (non-owner peer <-> replica) through the live
 * subscribe-after-connect activation path.
 */
import { multiaddr } from '@multiformats/multiaddr';
import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  DKG_ONTOLOGY,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import {
  runCuratorMetaRefreshFromPeer,
  stripRelayedRegistrationBindingQuads,
  type CuratorMetaRefreshOptions,
} from '../src/curator-meta-refresh.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { mintRfc64UnregisteredReplicaAuthoritySeedV1 } from
  '../src/rfc64/unregistered-replica-authority-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
} from './_helpers/rfc64-rollout-agent-harness.js';

const OWNER_WALLET = new ethers.Wallet(`0x${'71'.repeat(32)}`);
const OWNER = OWNER_WALLET.address.toLowerCase() as EvmAddressV1;
const ATTACKER_NODE_WALLET = new ethers.Wallet(`0x${'72'.repeat(32)}`);
const ATTACKER = ATTACKER_NODE_WALLET.address.toLowerCase() as EvmAddressV1;
const REPLICA_NODE_WALLET = new ethers.Wallet(`0x${'73'.repeat(32)}`);
const HUB = '0x3333333333333333333333333333333333333333';
const SERVING_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const FORGED_ON_CHAIN_ID = '777';
const FORGED_ON_CHAIN_HASH = `0x${'ab'.repeat(32)}`;
const ON_CHAIN_ID_PREDICATE = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;
const ON_CHAIN_HASH_PREDICATE = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`;

interface ServedMetaShape {
  readonly curatorAddress?: string;
  readonly registrationStatus?: 'unregistered' | 'pending' | 'registered';
  readonly binding?: boolean;
  readonly onChainId?: string;
}

/** A public root `_meta` declaration as a serving peer would hold it. */
function servedPublicMetaQuads(
  contextGraphId: string,
  servingPeerId: string,
  shape: ServedMetaShape = {},
): Quad[] {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const quads: Quad[] = [
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: metaGraph },
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${servingPeerId}`, graph: metaGraph },
  ];
  if (shape.curatorAddress !== undefined) {
    quads.push({
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CURATOR,
      object: `did:dkg:agent:${shape.curatorAddress}`,
      graph: metaGraph,
    });
  }
  if (shape.registrationStatus !== undefined) {
    quads.push({
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
      object: `"${shape.registrationStatus}"`,
      graph: metaGraph,
    });
  }
  if (shape.binding === true || shape.onChainId !== undefined) {
    quads.push(
      { subject: contextGraphUri, predicate: ON_CHAIN_ID_PREDICATE, object: `"${shape.onChainId ?? FORGED_ON_CHAIN_ID}"`, graph: metaGraph },
      { subject: contextGraphUri, predicate: ON_CHAIN_HASH_PREDICATE, object: `"${FORGED_ON_CHAIN_HASH}"`, graph: metaGraph },
    );
  }
  return quads;
}

async function rootMetaRows(store: TripleStore, contextGraphId: string): Promise<Array<{ p: string; o: string }>> {
  const result = await store.query(
    `SELECT ?p ?o WHERE { GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> { `
    + `<${contextGraphDataGraphUri(contextGraphId)}> ?p ?o } }`,
  );
  if (result.type !== 'bindings') throw new Error('expected _meta bindings');
  return result.bindings.map((row) => ({ p: row['p']!, o: row['o']! }));
}

function noop(): void {}

async function runDirectlyWithBackpressure<T>(
  _ctx: OperationContext,
  _contextGraphId: string,
  _lane: 'durable',
  _label: string,
  work: () => Promise<T>,
): Promise<T> {
  return work();
}

describe('curator-meta-refresh: relayed (unauthenticated-source) snapshot guard', () => {
  const contextGraphId = `${OWNER}/relayed-meta` as ContextGraphIdV1;

  function createRefreshAgent(store: OxigraphStore, served: readonly Quad[]) {
    const subscription: { onChainId?: string; onChainHash?: string } = {};
    const bindSubscriptionOnChainId = vi.fn(
      (_localCgId: string, sub: { onChainId?: string }, onChainId: string) => { sub.onChainId = onChainId; },
    );
    const recordCgWireId = vi.fn((_localCgId: string, onChainHash: string | null) => {
      subscription.onChainHash = onChainHash ?? undefined;
    });
    const persistContextGraphSubscription = vi.fn();
    const log = { warn: vi.fn(), info: vi.fn() };
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => SERVING_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async () => ({
        quads: [...served],
        checkpointKey: 'relayed-meta-checkpoint',
        resumedFromOffset: 0,
        completed: true,
      }),
      store,
      oversizeTombstoneLog: { record: noop },
      invalidateListContextGraphsCache: noop,
      contextGraphMetaProjection: { markDirty: noop },
      subscribedContextGraphs: new Map([[contextGraphId, subscription]]),
      bindSubscriptionOnChainId,
      recordCgWireId,
      persistContextGraphSubscription,
      syncCheckpoints: new Map<string, number>(),
      log,
    };
    return { agent, subscription, bindSubscriptionOnChainId, recordCgWireId, persistContextGraphSubscription, log };
  }

  const relayedOptions: CuratorMetaRefreshOptions = Object.freeze({
    force: true,
    requirePublicDefinition: true,
    ignoreRegistrationBinding: true,
    expectedCuratorAddress: OWNER,
  });

  it('installs the public declaration minus every chain-registration claim and never binds the subscription', async () => {
    const store = new OxigraphStore();
    try {
      const served = servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID, {
        curatorAddress: OWNER,
        registrationStatus: 'registered',
        binding: true,
      });
      const harness = createRefreshAgent(store, served);

      await expect(runCuratorMetaRefreshFromPeer(harness.agent, contextGraphId, SERVING_PEER_ID, relayedOptions))
        .resolves.toBe(true);

      const rows = await rootMetaRows(store, contextGraphId);
      expect(rows).toContainEqual({ p: DKG_ONTOLOGY.RDF_TYPE, o: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH });
      expect(rows).toContainEqual({ p: DKG_ONTOLOGY.DKG_ACCESS_POLICY, o: '"public"' });
      expect(rows).toContainEqual({ p: DKG_ONTOLOGY.DKG_CURATOR, o: `did:dkg:agent:${OWNER}` });
      expect(rows.some((row) => row.p === ON_CHAIN_ID_PREDICATE)).toBe(false);
      expect(rows.some((row) => row.p === ON_CHAIN_HASH_PREDICATE)).toBe(false);
      expect(rows.some((row) => row.p === DKG_ONTOLOGY.DKG_REGISTRATION_STATUS)).toBe(false);
      expect(harness.subscription).toEqual({});
      expect(harness.bindSubscriptionOnChainId).not.toHaveBeenCalled();
      expect(harness.recordCgWireId).not.toHaveBeenCalled();
      expect(harness.persistContextGraphSubscription).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it('keeps the unregistered placeholder (it only tightens confirmation) while dropping chain claims', () => {
    const served = servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID, {
      curatorAddress: OWNER,
      registrationStatus: 'unregistered',
      binding: true,
    });
    const kept = stripRelayedRegistrationBindingQuads(contextGraphId, served);
    expect(kept.map((quad) => quad.predicate)).toEqual([
      DKG_ONTOLOGY.RDF_TYPE,
      DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      DKG_ONTOLOGY.DKG_CREATOR,
      DKG_ONTOLOGY.DKG_CURATOR,
      DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
    ]);
    for (const status of ['pending', 'registered'] as const) {
      const claims = stripRelayedRegistrationBindingQuads(
        contextGraphId,
        servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID, { registrationStatus: status }),
      );
      expect(claims.some((quad) => quad.predicate === DKG_ONTOLOGY.DKG_REGISTRATION_STATUS)).toBe(false);
    }
    // Only the root subject is filtered; the declaration itself is untouched.
    expect(stripRelayedRegistrationBindingQuads(contextGraphId, served.slice(0, 3))).toEqual(served.slice(0, 3));
  });

  it('rejects a snapshot whose curator is not the accepted owner and installs nothing', async () => {
    const store = new OxigraphStore();
    try {
      const served = servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID, {
        curatorAddress: ATTACKER,
        registrationStatus: 'unregistered',
      });
      const harness = createRefreshAgent(store, served);

      await expect(runCuratorMetaRefreshFromPeer(harness.agent, contextGraphId, SERVING_PEER_ID, relayedOptions))
        .resolves.toBe(false);

      expect(await rootMetaRows(store, contextGraphId)).toEqual([]);
      expect(harness.subscription).toEqual({});
      expect(harness.bindSubscriptionOnChainId).not.toHaveBeenCalled();
      expect(harness.log.warn).toHaveBeenCalledOnce();
      expect(String(harness.log.warn.mock.calls[0]?.[1])).toContain('not the owner');
      // Mixed-case owner DIDs are the same owner; a snapshot without a curator passes.
      const upper = createRefreshAgent(store, servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID, {
        curatorAddress: ethers.getAddress(OWNER),
      }));
      await expect(runCuratorMetaRefreshFromPeer(upper.agent, contextGraphId, SERVING_PEER_ID, relayedOptions))
        .resolves.toBe(true);
      const anonymous = createRefreshAgent(store, servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID));
      await expect(runCuratorMetaRefreshFromPeer(anonymous.agent, contextGraphId, SERVING_PEER_ID, relayedOptions))
        .resolves.toBe(true);
    } finally {
      await store.close();
    }
  });

  it('leaves the authenticated curator refresh binding exactly as before', async () => {
    const store = new OxigraphStore();
    try {
      const served = servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID, {
        curatorAddress: OWNER,
        registrationStatus: 'registered',
        binding: true,
      });
      const harness = createRefreshAgent(store, served);

      await expect(runCuratorMetaRefreshFromPeer(harness.agent, contextGraphId, SERVING_PEER_ID, { force: true }))
        .resolves.toBe(true);

      const rows = await rootMetaRows(store, contextGraphId);
      expect(rows).toContainEqual({ p: ON_CHAIN_ID_PREDICATE, o: `"${FORGED_ON_CHAIN_ID}"` });
      expect(rows).toContainEqual({ p: ON_CHAIN_HASH_PREDICATE, o: `"${FORGED_ON_CHAIN_HASH}"` });
      expect(rows).toContainEqual({ p: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, o: '"registered"' });
      expect(harness.bindSubscriptionOnChainId).toHaveBeenCalledOnce();
      expect(harness.subscription).toEqual({
        onChainId: FORGED_ON_CHAIN_ID,
        onChainHash: FORGED_ON_CHAIN_HASH.toLowerCase(),
      });
      expect(harness.persistContextGraphSubscription).toHaveBeenCalledOnce();
    } finally {
      await store.close();
    }
  });

  it.each([
    ['padded', '007'],
    ['out-of-uint256', (1n << 256n).toString(10)],
  ] as const)('ignores an authenticated curator snapshot with a %s chain id', async (
    _case,
    onChainId,
  ) => {
    const store = new OxigraphStore();
    try {
      const harness = createRefreshAgent(
        store,
        servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID, {
          curatorAddress: OWNER,
          registrationStatus: 'registered',
          onChainId,
        }),
      );

      await expect(runCuratorMetaRefreshFromPeer(
        harness.agent,
        contextGraphId,
        SERVING_PEER_ID,
        { force: true },
      )).resolves.toBe(true);

      expect(harness.subscription).toEqual({});
      expect(harness.bindSubscriptionOnChainId).not.toHaveBeenCalled();
      expect(harness.recordCgWireId).not.toHaveBeenCalled();
      expect(harness.persistContextGraphSubscription).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  function createDurableMetaFlagAgent(store: OxigraphStore) {
    const subscription: Record<string, unknown> = {
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
    };
    const subscribedContextGraphs = new Map([[contextGraphId, subscription]]);
    const bindSubscriptionOnChainId = vi.fn(
      (_id: string, sub: Record<string, unknown>, onChainId: string) => {
        sub['onChainId'] = onChainId;
      },
    );
    const setContextGraphSubscription = vi.fn(
      (id: string, next: Record<string, unknown>) => {
        subscribedContextGraphs.set(id, next);
        return next;
      },
    );
    const agent = {
      subscribedContextGraphs,
      hasConfirmedMetaState: vi.fn(async () => true),
      store,
      bindSubscriptionOnChainId,
      setContextGraphSubscription,
      reconcileRfc64CatalogResponsibilityV1: vi.fn(async () => undefined),
      queueSharedMemoryGossipSubscription: vi.fn(),
    };
    return { agent, subscription, bindSubscriptionOnChainId, setContextGraphSubscription };
  }

  it.each([
    ['padded', '007'],
    ['out-of-uint256', (1n << 256n).toString(10)],
  ] as const)('ignores a %s chain id at the durable _meta readiness boundary', async (
    _case,
    onChainId,
  ) => {
    const store = new OxigraphStore();
    try {
      await store.insert(servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID, {
        curatorAddress: OWNER,
        registrationStatus: 'registered',
        onChainId,
      }));
      const harness = createDurableMetaFlagAgent(store);

      await expect(LifecycleSyncMethods.prototype.refreshMetaSyncedFlags.call(
        harness.agent as unknown as DKGAgent,
        [contextGraphId],
      )).resolves.toBeUndefined();

      expect(harness.subscription).not.toHaveProperty('onChainId');
      expect(harness.subscription).not.toHaveProperty('onChainHash');
      expect(harness.bindSubscriptionOnChainId).not.toHaveBeenCalled();
      expect(harness.setContextGraphSubscription).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it('retains canonical binding at the durable _meta readiness boundary', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert(servedPublicMetaQuads(contextGraphId, SERVING_PEER_ID, {
        curatorAddress: OWNER,
        registrationStatus: 'registered',
        binding: true,
      }));
      const harness = createDurableMetaFlagAgent(store);

      await LifecycleSyncMethods.prototype.refreshMetaSyncedFlags.call(
        harness.agent as unknown as DKGAgent,
        [contextGraphId],
      );

      expect(harness.bindSubscriptionOnChainId).toHaveBeenCalledWith(
        contextGraphId,
        harness.subscription,
        FORGED_ON_CHAIN_ID,
      );
      expect(harness.setContextGraphSubscription).toHaveBeenCalledOnce();
      expect(harness.agent.subscribedContextGraphs.get(contextGraphId)).toMatchObject({
        onChainId: FORGED_ON_CHAIN_ID,
        onChainHash: FORGED_ON_CHAIN_HASH.toLowerCase(),
      });
    } finally {
      await store.close();
    }
  });
});

const { startAgent, cleanup } = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 _meta bootstrap from connected peers: chain-binding guard (two agents)', () => {
  it('review repro: a non-owner peer serving public _meta with OnChainId=777 installs the declaration but never a binding', async () => {
    const contextGraphId = `${OWNER}/binding-guard` as ContextGraphIdV1;
    const { peer, replica } = await startConnectedPair('bg-repro');
    await storeOf(peer).insert(servedPublicMetaQuads(contextGraphId, peer.peerId, {
      curatorAddress: OWNER,
      registrationStatus: 'registered',
      binding: true,
    }));
    const bind = vi.spyOn(replica, 'bindSubscriptionOnChainId');
    const { metaBootstrap } = await acceptSeedAndSubscribe(replica, contextGraphId);

    await vi.waitFor(() => {
      expect(metaBootstrap).toHaveBeenCalledWith(contextGraphId);
    }, { timeout: 10_000 });
    await expect(metaBootstrap.mock.results[0]!.value).resolves.toBe('fetched');

    // The declaration landed ...
    await expect(replica.getExplicitAccessPolicy(contextGraphId)).resolves.toBe('public');
    await expect(replica.hasConfirmedMetaState(contextGraphId)).resolves.toBe(true);
    expect(replica.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      metaSynced: true,
    });
    // ... without any chain claim: no binding on the row, no bind call, no
    // OnChainId / OnChainHash / "registered" rows in the local projection.
    const subscription = replica.getSubscribedContextGraphs().get(contextGraphId)!;
    expect(subscription.onChainId).toBeUndefined();
    expect(subscription.onChainHash).toBeUndefined();
    expect(bind).not.toHaveBeenCalled();
    const rows = await rootMetaRows(storeOf(replica), contextGraphId);
    expect(rows).toContainEqual({ p: DKG_ONTOLOGY.DKG_ACCESS_POLICY, o: '"public"' });
    expect(rows.some((row) => row.p === ON_CHAIN_ID_PREDICATE)).toBe(false);
    expect(rows.some((row) => row.p === ON_CHAIN_HASH_PREDICATE)).toBe(false);
    expect(rows.some((row) => row.p === DKG_ONTOLOGY.DKG_REGISTRATION_STATUS)).toBe(false);
    // RFC-64 authority stays on the accepted seed; the receiver lane and SWM
    // gossip authorization are exactly what they were before the pull.
    await replica.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({ contextGraphId, responsibilityReason: 'edge-subscription', active: true }),
    ]);
    expect(replica.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId)).toMatchObject({
      active: true,
      reconciliationLane: 'catalog-apply',
    });
    await expect(replica.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({ contextGraphId, authorityState: 'accepted' }),
    );
    await expect(replica.canUseSharedMemoryForContextGraph(contextGraphId)).resolves.toBe(true);
    expect(replica.getSubscribedContextGraphs().get(contextGraphId)?.onChainId).toBeUndefined();
    expect(bind).not.toHaveBeenCalled();
  }, 60_000);

  it('rejects a public _meta whose curator is not the owner the accepted seed names', async () => {
    const contextGraphId = `${OWNER}/binding-guard-curator` as ContextGraphIdV1;
    const { peer, replica } = await startConnectedPair('bg-curator');
    await storeOf(peer).insert(servedPublicMetaQuads(contextGraphId, peer.peerId, {
      curatorAddress: ATTACKER,
      registrationStatus: 'unregistered',
    }));
    const bind = vi.spyOn(replica, 'bindSubscriptionOnChainId');
    const { metaBootstrap } = await acceptSeedAndSubscribe(replica, contextGraphId);

    await vi.waitFor(() => {
      expect(metaBootstrap).toHaveBeenCalledWith(contextGraphId);
    }, { timeout: 10_000 });
    await expect(metaBootstrap.mock.results[0]!.value).resolves.toBe('not-found');

    expect(await rootMetaRows(storeOf(replica), contextGraphId)).toEqual([]);
    await expect(replica.getExplicitAccessPolicy(contextGraphId)).resolves.toBeNull();
    await expect(replica.hasConfirmedMetaState(contextGraphId)).resolves.toBe(false);
    expect(replica.getSubscribedContextGraphs().get(contextGraphId)?.onChainId).toBeUndefined();
    expect(bind).not.toHaveBeenCalled();
    await replica.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({ contextGraphId, responsibilityReason: 'edge-subscription', active: true }),
    ]);
  }, 60_000);

  it('still applies and confirms a legitimate public _meta that carries no binding', async () => {
    const contextGraphId = `${OWNER}/binding-guard-legit` as ContextGraphIdV1;
    const { peer, replica } = await startConnectedPair('bg-legit');
    await storeOf(peer).insert(servedPublicMetaQuads(contextGraphId, peer.peerId, {
      curatorAddress: OWNER,
      registrationStatus: 'unregistered',
    }));
    const bind = vi.spyOn(replica, 'bindSubscriptionOnChainId');
    const { metaBootstrap } = await acceptSeedAndSubscribe(replica, contextGraphId);

    await vi.waitFor(() => {
      expect(metaBootstrap).toHaveBeenCalledWith(contextGraphId);
    }, { timeout: 10_000 });
    await expect(metaBootstrap.mock.results[0]!.value).resolves.toBe('fetched');

    await expect(replica.getExplicitAccessPolicy(contextGraphId)).resolves.toBe('public');
    await expect(replica.hasConfirmedMetaState(contextGraphId)).resolves.toBe(true);
    expect((await replica.getCgMeta(contextGraphId)).declared).toBe(true);
    const rows = await rootMetaRows(storeOf(replica), contextGraphId);
    expect(rows).toContainEqual({ p: DKG_ONTOLOGY.DKG_CURATOR, o: `did:dkg:agent:${OWNER}` });
    expect(rows).toContainEqual({ p: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, o: '"unregistered"' });
    expect(replica.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      metaSynced: true,
    });
    expect(replica.getSubscribedContextGraphs().get(contextGraphId)?.onChainId).toBeUndefined();
    expect(bind).not.toHaveBeenCalled();
  }, 60_000);
});

/** A non-owner serving peer and a cold replica, connected before any graph exists. */
async function startConnectedPair(label: string): Promise<{ peer: DKGAgent; replica: DKGAgent }> {
  const resolveFinalized = vi.fn(async () => new Map());
  const peer = await startAgent({
    name: `${label}-peer`,
    config: {
      rfc64CatalogDeploymentProfile: DEPLOYMENT,
      chainAdapter: new NoChainAdapter(),
      chainConfig: nodeChainConfig(ATTACKER_NODE_WALLET),
    },
  });
  const replica = await startAgent({
    name: `${label}-replica`,
    config: {
      rfc64CatalogDeploymentProfile: DEPLOYMENT,
      chainAdapter: coldReplicaChainAdapter(resolveFinalized),
      chainConfig: nodeChainConfig(REPLICA_NODE_WALLET),
    },
  });
  allowAllNetworkAdmissionForTest(peer);
  allowAllNetworkAdmissionForTest(replica);
  await connectBothWays(replica, peer);
  // The peer answers every sync request for the graph it does not own.
  vi.spyOn(peer, 'authorizeSyncRequest').mockResolvedValue(true);
  vi.spyOn(replica, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
  return { peer, replica };
}

/**
 * The replica holds the genuine owner-signed PUBLIC seed, its subscription
 * bootstrap authority is allowed, and the subscription is recorded, which
 * activates the receiver lane and fires the `_meta` bootstrap.
 */
async function acceptSeedAndSubscribe(replica: DKGAgent, contextGraphId: ContextGraphIdV1) {
  const seed = await mintRfc64UnregisteredReplicaAuthoritySeedV1({
    networkId: NETWORK_ID,
    contextGraphId,
    ownerAddress: OWNER,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthorityAccountId: '0',
    memberAddresses: [],
    rosterVersion: '0',
    signer: {
      issuer: OWNER,
      signDigest: (digest) => OWNER_WALLET.signMessage(digest),
    },
  });
  await replica.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
    networkId: NETWORK_ID,
    contextGraphId,
    canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
  });
  await expect(replica.resolveContextGraphSubscriptionBootstrapAuthority(
    contextGraphId,
    { allowSubscriptionFallback: false },
  )).resolves.toMatchObject({ outcome: 'allowed', source: 'rfc64-public' });
  expect(replica.readAcceptedRfc64CatalogAccessPolicyV1(contextGraphId)).toBe('public');
  const metaBootstrap = vi.spyOn(replica, 'bootstrapRfc64CatalogContextGraphMetadataFromPeersV1');
  replica.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
  await replica.whenRfc64CatalogResponsibilitiesIdleV1();
  expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([
    expect.objectContaining({ contextGraphId, responsibilityReason: 'edge-subscription', active: true }),
  ]);
  return { metaBootstrap };
}

function nodeChainConfig(wallet: ethers.Wallet) {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: HUB,
    operationalKeys: [wallet.privateKey],
  };
}

/** Finalized index proves absence; every legacy or point read is a test failure. */
function coldReplicaChainAdapter(resolveFinalized: () => Promise<Map<never, never>>) {
  return Object.assign(new NoChainAdapter(), {
    getContextGraphAuthoritySnapshot: vi.fn(async () => { throw new Error('must not point-read'); }),
    resolveContextGraphIdByNameHash: vi.fn(async () => { throw new Error('must not legacy scalar-read'); }),
    resolveContextGraphIdsByNameHashes: vi.fn(async () => { throw new Error('must not legacy batch-read'); }),
    contextGraphAuthorityIndexRevisionReader: {
      resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle: vi.fn(async () => undefined),
    },
  });
}

function storeOf(agent: DKGAgent): TripleStore {
  return (agent as unknown as { store: TripleStore }).store;
}

function tcpMultiaddr(agent: DKGAgent): string {
  const address = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('agent has no TCP multiaddr');
  return address;
}

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  await a.node.libp2p.dial(multiaddr(tcpMultiaddr(b)));
  await b.node.libp2p.dial(multiaddr(tcpMultiaddr(a)));
}

function allowAllNetworkAdmissionForTest(agent: DKGAgent): void {
  const coordinator = (agent as any).networkAdmissionCoordinator;
  coordinator.isAcceptedPeer = () => true;
  coordinator.isRejectedPeer = () => false;
  coordinator.ensureAdmitted = async () => true;
}
