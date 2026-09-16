// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from '../src/rfc64/catalog-peers-v1.js';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from
  '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from
  '../src/rfc64/public-catalog-inventory-completeness-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
  Rfc64PublicCatalogTransportErrorV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_AUTHOR as AUTHOR,
  RFC64_ROLLOUT_AUTHOR_WALLET as AUTHOR_WALLET,
  RFC64_ROLLOUT_CONTEXT_GRAPH_ID as CONTEXT_GRAPH_ID,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
  rfc64RolloutActivation as activation,
} from './_helpers/rfc64-rollout-agent-harness.js';

interface Target {
  readonly id: string;
}

const CG = 'public-cg';
const POLICY = 'policy';
const FAILING_PEER = 'peer-unreachable';
const HEALTHY_PEER = 'peer-healthy';

const completed = (targets: readonly Target[] = []) => Object.freeze({
  status: 'completed' as const,
  targets: Object.freeze([...targets]),
});

function createRuntime(overrides: {
  readonly requestPeer?: (contextGraphId: string, peerId: string) => Promise<
    ReturnType<typeof completed>
  >;
  readonly whenReceiverIdle?: () => Promise<void>;
  readonly parityFailed?: () => Promise<boolean>;
} = {}) {
  const requestPeer = vi.fn(overrides.requestPeer ?? (async (_cg: string, peerId: string) => {
    if (peerId === FAILING_PEER) throw new Error('provider unreachable');
    return completed();
  }));
  const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
    requestPeer,
    whenReceiverIdle: overrides.whenReceiverIdle ?? (async () => undefined),
    targetIdentity: (target) => target.id,
    parityFailed: overrides.parityFailed ?? (async () => false),
  });
  return { runtime, requestPeer };
}

function fullRun(
  runtime: Rfc64CatalogReplayRecoveryRuntimeV1<Target>,
  connectedPeerIds: readonly string[],
) {
  return runtime.request({
    contextGraphId: CG,
    policyDigest: POLICY,
    kind: 'full-connected-peers',
    connectedPeerIds,
  });
}

function scopedRun(runtime: Rfc64CatalogReplayRecoveryRuntimeV1<Target>) {
  return runtime.request({ contextGraphId: CG, policyDigest: POLICY, kind: 'pending-recovery' });
}

function requestedPeers(requestPeer: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return requestPeer.mock.calls.map(([, peerId]) => peerId);
}

describe('RFC-64 catalog replay recovery: provider failure reporting', () => {
  it('reports one unreachable provider without failing the Context Graph and keeps retrying it', async () => {
    const { runtime, requestPeer } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 1,
    });

    // The retained provider is re-seeded by the next scoped request (two dial attempts).
    requestPeer.mockClear();
    await expect(scopedRun(runtime)).resolves.toEqual({ requested: 0, failed: 1 });
    expect(requestedPeers(requestPeer)).toEqual([FAILING_PEER, FAILING_PEER]);
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 1,
    });

    // Attribution clears only when a replay from that exact provider succeeds.
    requestPeer.mockImplementation(async () => completed());
    await expect(scopedRun(runtime)).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 0,
    });
  });

  it('still fails the Context Graph on a parity failure', async () => {
    const { runtime } = createRuntime({
      requestPeer: async () => completed([{ id: 'promised-head' }]),
      parityFailed: async () => true,
    });

    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: true,
      unresolvedPeerCount: 0,
    });
  });

  it('still fails the Context Graph when the bounded worklist overflows', async () => {
    const churnPeer = 'peer-reconnect-churn';
    let runtime!: Rfc64CatalogReplayRecoveryRuntimeV1<Target>;
    const created = createRuntime({
      requestPeer: async () => completed(),
      whenReceiverIdle: async () => {
        runtime.markPeerPending(CG, POLICY, churnPeer);
      },
    });
    runtime = created.runtime;

    await expect(fullRun(runtime, [churnPeer])).resolves.toEqual({
      requested: RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
      failed: 1,
    });
    expect(created.requestPeer).toHaveBeenCalledTimes(RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1);
    expect(runtime.status(CG, POLICY)).toMatchObject({
      failed: true,
      unresolvedPeerCount: 0,
    });
  });

  it('drops a retained provider once a connected-peer run shows it disconnected', async () => {
    const { runtime, requestPeer } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(1);

    // A scoped run carries no connectivity evidence: the provider is retried.
    requestPeer.mockClear();
    await expect(scopedRun(runtime)).resolves.toEqual({ requested: 0, failed: 1 });
    expect(requestedPeers(requestPeer)).toEqual([FAILING_PEER, FAILING_PEER]);
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(1);

    // A connected-peer run that no longer lists the provider drops it unrequested.
    requestPeer.mockClear();
    const before = runtime.revision;
    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestedPeers(requestPeer)).toEqual([HEALTHY_PEER]);
    expect(runtime.revision).toBeGreaterThan(before);
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 0,
    });
  });

  it('lets a clean connected-peer pass clear a parity witness despite a stale provider', async () => {
    let parityFails = true;
    const { runtime } = createRuntime({
      requestPeer: async (_cg, peerId) => {
        if (peerId === FAILING_PEER) throw new Error('provider unreachable');
        return completed([{ id: 'promised-head' }]);
      },
      parityFailed: async () => parityFails,
    });

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 2 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: true,
      unresolvedPeerCount: 1,
    });

    // While the stale provider is still listed as connected, its dial failure
    // keeps the full pass from being clean and the parity witness survives.
    parityFails = false;
    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: true,
      unresolvedPeerCount: 1,
    });

    // Once it is gone from the connected set, one clean full pass settles the CG.
    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 0,
    });
  });
});

const { startAgent, cleanup } = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const GENESIS_ISSUED_AT = '1773900000000' as TimestampMsV1;
const DELEGATION_EFFECTIVE_AT = '1773899999000' as TimestampMsV1;
const DELEGATION_EXPIRES_AT = '1893456000000' as TimestampMsV1;

/** Give the edge one durable, self-consistent applied head for the rollout CG. */
async function applyConsistentGenesisHead(edge: Awaited<ReturnType<typeof startAgent>>) {
  const publication = await edge.publishOpenAuthorCatalogGenesisV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    author: Object.freeze({
      address: AUTHOR,
      signMessage: (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
    }),
    peers: [],
    issuedAt: GENESIS_ISSUED_AT,
    catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
    catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
  });
  const scope = Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  }) as AuthorCatalogScopeV1;
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const persistence = (edge as any).rfc64PersistenceV1;
  if (persistence === undefined) throw new Error('test edge has no RFC-64 persistence');
  persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
    catalogScopeDigest,
    authorAddress: AUTHOR,
    expectedCurrentCatalogHeadDigest: null,
    currentCatalogHeadDigest: publication.headObjectDigest,
    appliedInventoryDigest: computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest,
      rows: [],
    }),
    catalogVersion: publication.announcement.catalogVersion,
    inventoryRowCount: '0',
  });
  return publication;
}

/** Narrow view of the production catalog service used to stub provider replay. */
interface ReplayServiceV1 {
  requestCatalogHeadReplay(input: { remotePeerId: string }): Promise<unknown>;
}

function replayService(edge: Awaited<ReturnType<typeof startAgent>>): ReplayServiceV1 {
  return (edge as any).rfc64PublicCatalogServiceV1 as ReplayServiceV1;
}

async function readStatus(edge: Awaited<ReturnType<typeof startAgent>>) {
  const statuses = await edge.readRfc64CatalogOperationalStatusV1();
  const status = statuses.find((entry) => entry.contextGraphId === CONTEXT_GRAPH_ID);
  if (status === undefined) throw new Error('rollout CG missing from operational status');
  return status;
}

describe('RFC-64 operational status: provider failure reporting', () => {
  it('reports a converged Context Graph complete while one provider keeps failing replay', async () => {
    const edge = await startAgent({
      name: 'replay-peer-failure-parity-complete',
      activation: activation('catalog'),
    });
    await applyConsistentGenesisHead(edge);
    const failingPeer = '12D3KooWReplayPersistentlyUnreachable';
    const healthyPeer = '12D3KooWReplayHealthyProvider';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => failingPeer },
      { toString: () => healthyPeer },
    ] as never);
    const requestReplay = vi.spyOn(replayService(edge), 'requestCatalogHeadReplay')
      .mockImplementation(async ({ remotePeerId }) => {
        if (remotePeerId === failingPeer) {
          throw new Rfc64PublicCatalogTransportErrorV1(
            'catalog-transport-wire',
            'provider persistently unreachable',
          );
        }
        return Object.freeze({
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
          heads: Object.freeze([]),
        });
      });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 1 });

    const status = await readStatus(edge);
    expect(status).toMatchObject({
      phase: 'complete',
      stableReason: null,
      appliedRowCount: '0',
      expectedRowCount: '0',
      missingRowCount: '0',
      providerHealth: expect.objectContaining({
        candidateCount: 0,
        unresolvedReplayPeers: 1,
      }),
    });
    expect(status.expectedRowCount).toBe(status.appliedRowCount);
    expect(status.expectedCatalogHeadDigest).not.toBeNull();
    expect(status.expectedCatalogHeadDigest).toBe(status.appliedCatalogHeadDigest);
    expect(status.expectedInventoryDigest).not.toBeNull();
    expect(status.expectedInventoryDigest).toBe(status.appliedInventoryDigest);

    // The failing provider stays connected, so the next run retries it (two attempts).
    requestReplay.mockClear();
    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 1 });
    expect(requestReplay.mock.calls.filter(
      ([{ remotePeerId }]) => remotePeerId === failingPeer,
    )).toHaveLength(2);
    expect((await readStatus(edge)).providerHealth.unresolvedReplayPeers).toBe(1);
  });

  it('still blocks a Context Graph whose provider promises a head this node never applied', async () => {
    const edge = await startAgent({
      name: 'replay-peer-failure-parity-blocked',
      activation: activation('catalog'),
    });
    const publication = await applyConsistentGenesisHead(edge);
    const providerPeer = '12D3KooWReplayAheadProvider';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => providerPeer },
    ] as never);
    vi.spyOn(replayService(edge), 'requestCatalogHeadReplay').mockImplementation(async () => {
      const promisedSuccessor = Object.freeze({
        ...publication.announcement,
        kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
        catalogVersion: '1',
        catalogHeadObjectDigest: `0x${'a1'.repeat(32)}`,
        signatureVariantDigest: `0x${'a2'.repeat(32)}`,
      }) as Rfc64PublicCatalogHeadAnnouncementV1;
      return Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: Object.freeze([promisedSuccessor]),
      });
    });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 1 });
    expect(await readStatus(edge)).toMatchObject({
      phase: 'blocked',
      stableReason: 'catalog-replay-incomplete',
      expectedRowCount: null,
      missingRowCount: null,
      providerHealth: expect.objectContaining({
        candidateCount: null,
        unresolvedReplayPeers: 0,
      }),
    });
  });
});
