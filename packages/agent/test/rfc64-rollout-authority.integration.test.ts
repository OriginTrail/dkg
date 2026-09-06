// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  createOperationContext,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  SYSTEM_CONTEXT_GRAPHS,
  type AssertionSeal,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type Digest32V1,
  type EvmAddressV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import {
  NoChainAdapter,
  type ChainAdapter,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import { Rfc64PublicCatalogSuccessorProducerV1 } from
  '../src/rfc64/public-catalog-successor-producer-v1.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  '../src/rfc64/catalog-authority-config-v1.js';
import type { Rfc64CatalogRuntimeV1 } from '../src/rfc64/catalog-runtime-v1.js';
import { deriveRfc64PublicSwmGraphV1 } from
  '../src/rfc64/catalog-semantic-authority-transition-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from
  '../src/rfc64/public-catalog-inventory-completeness-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
  Rfc64PublicCatalogTransportErrorV1,
  parseRfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadReplayRequestV1,
} from '../src/rfc64/public-catalog-transport-v1.js';
import { composeRfc64UnregisteredCatalogAuthorityV1 } from
  '../src/rfc64/release-native-catalog-authority-v1.js';
import {
  commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1,
  prepareRfc64AppliedCatalogAuthorityDeactivationV1,
} from '../src/rfc64/applied-catalog-authority-transition-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_AUTHOR as AUTHOR,
  RFC64_ROLLOUT_AUTHOR_WALLET as AUTHOR_WALLET,
  RFC64_ROLLOUT_CONTEXT_GRAPH_ID as CONTEXT_GRAPH_ID,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_KAV10 as KAV10,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
  rfc64RolloutActivation as activation,
  rfc64RolloutPolicyEnvelope as policyEnvelope,
} from './_helpers/rfc64-rollout-agent-harness.js';

const MEMBER = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const NONMEMBER = '0x3333333333333333333333333333333333333333' as EvmAddressV1;

const PROJECTION_QUADS: readonly Quad[] = Object.freeze([
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/age',
    object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
    graph: '',
  }),
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/name',
    object: '"Alice"',
    graph: '',
  }),
]);
const {
  createDataDir,
  startAgent,
  restartAgent,
  cleanup,
} = createRfc64RolloutAgentHarness();

function finalizedAuthoritySnapshot(
  contextGraphId: string,
  participantAgents: readonly string[],
  rosterVersion: string,
): ContextGraphAuthoritySnapshot {
  return Object.freeze({
    chainId: '20430',
    governanceContract: '0x3333333333333333333333333333333333333333',
    contextGraphId: '9',
    owner: AUTHOR,
    active: true,
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: AUTHOR,
    publishAuthorityAccountId: '0',
    participantAgents: Object.freeze([...participantAgents]),
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
    ownershipEra: '0',
    policyVersion: '0',
    rosterVersion,
    sourceBlockNumber: '42',
    sourceBlockHash: `0x${'44'.repeat(32)}`,
  });
}

function chainWithFinalizedAuthority(
  snapshot: ContextGraphAuthoritySnapshot,
): ChainAdapter {
  return Object.assign(new NoChainAdapter(), {
    getContextGraphAuthoritySnapshot: vi.fn(async () => snapshot),
  });
}

function replaySuccess(
  request: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>,
): Readonly<{
  announced: number;
  failed: number;
  manifest: readonly Rfc64PublicCatalogHeadAnnouncementV1[];
}> {
  const head = Object.freeze({
    kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
    networkId: request.networkId,
    contextGraphId: request.contextGraphId,
    subGraphName: null,
    authorAddress: AUTHOR,
    catalogEra: '0',
    catalogVersion: '0',
    policyDigest: request.policyDigest,
    catalogHeadObjectDigest: `0x${'a1'.repeat(32)}`,
    signatureVariantDigest: `0x${'a2'.repeat(32)}`,
  }) as Rfc64PublicCatalogHeadAnnouncementV1;
  return Object.freeze({
    announced: 1,
    failed: 0,
    manifest: Object.freeze([head]),
  });
}

async function startAppliedOpenReplayProvider(name: string) {
  const provider = await startAgent({
    name,
    config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
  });
  const signer = Object.freeze({
    address: AUTHOR,
    signMessage: (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
  });
  const publication = await provider.publishOpenAuthorCatalogGenesisV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    author: signer,
    peers: [],
    issuedAt: '1773900000000' as TimestampMsV1,
    catalogIssuerDelegationEffectiveAt: '1773899999000' as TimestampMsV1,
    catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
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
  const persistence = (provider as any).rfc64PersistenceV1;
  if (persistence === undefined) throw new Error('test provider has no RFC-64 persistence');
  const applied = persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
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
  }).snapshot;
  return Object.freeze({ provider, persistence, publication, scope, applied });
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 rollout authority integration', () => {
  it('coalesces duplicate inbound catalog replay requests behind a bounded queue', async () => {
    const edge = await startAgent({ name: 'bounded-replay-queue' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const replay = vi.spyOn(edge, 'reannounceRfc64CatalogHeadsToPeerV1')
      .mockImplementation(async (_peerId, requestedScope) => {
        entered();
        await gate;
        if (requestedScope === undefined) throw new Error('missing replay scope');
        return replaySuccess(requestedScope);
      });
    const request = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      policyDigest: `0x${'11'.repeat(32)}` as Digest32V1,
    });

    const admissions = Array.from({ length: 32 }, () => (
      edge.tryQueueRfc64CatalogHeadReplayV1('12D3KooWReplayFloodPeer', request)
    ));
    expect(admissions.map((admission) => (
      admission.status === 'admitted' && admission.newlyQueued
    ))).toEqual([true, ...Array.from({ length: 31 }, () => false)]);
    const attempts = admissions.map((admission) => {
      if (admission.status === 'busy') throw new Error('duplicate replay was not coalesced');
      return admission.completion;
    });
    await started;
    expect(replay).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all(attempts)).resolves.toEqual(
      Array.from({ length: 32 }, () => replaySuccess(request)),
    );
  });

  it('bounds replay work per peer and restores full capacity after success and failure', async () => {
    const edge = await startAgent({ name: 'bounded-replay-per-peer' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const replay = vi.spyOn(edge, 'reannounceRfc64CatalogHeadsToPeerV1')
      .mockImplementation(async (_peerId, requestedScope) => {
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
        }
        if (requestedScope === undefined) throw new Error('missing replay scope');
        return replaySuccess(requestedScope);
      });
    const peerId = '12D3KooWReplayPerPeerLimit';
    const request = (ordinal: number) => Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      policyDigest: `0x${ordinal.toString(16).padStart(64, '0')}` as Digest32V1,
    });

    const admitted = Array.from({ length: 4 }, (_, index) => (
      edge.queueRfc64CatalogHeadReplayV1(peerId, request(index + 1))
    ));
    await started;
    const overflow = edge.queueRfc64CatalogHeadReplayV1(peerId, request(5));
    release();
    await expect(overflow).rejects.toThrow(/replay queue is full/u);
    await expect(Promise.all(admitted)).resolves.toHaveLength(4);

    replay.mockRejectedValueOnce(new Error('injected replay failure'));
    await expect(edge.queueRfc64CatalogHeadReplayV1(peerId, request(6)))
      .rejects.toThrow(/injected replay failure/u);
    let releaseAfterFailure!: () => void;
    let enteredAfterFailure!: () => void;
    const gateAfterFailure = new Promise<void>((resolve) => { releaseAfterFailure = resolve; });
    const startedAfterFailure = new Promise<void>((resolve) => { enteredAfterFailure = resolve; });
    let postFailureCalls = 0;
    replay.mockImplementation(async (_peerId, requestedScope) => {
      postFailureCalls += 1;
      if (postFailureCalls === 1) {
        enteredAfterFailure();
        await gateAfterFailure;
      }
      if (requestedScope === undefined) throw new Error('missing replay scope');
      return replaySuccess(requestedScope);
    });
    const readmitted = Array.from({ length: 4 }, (_, index) => (
      edge.queueRfc64CatalogHeadReplayV1(peerId, request(index + 7))
    ));
    await startedAfterFailure;
    const overflowAfterFailure = edge.queueRfc64CatalogHeadReplayV1(peerId, request(11));
    releaseAfterFailure();
    await expect(overflowAfterFailure).rejects.toThrow(/replay queue is full/u);
    await expect(Promise.all(readmitted)).resolves.toHaveLength(4);
  });

  it('bounds replay work globally and restores full capacity after success and failure', async () => {
    const edge = await startAgent({ name: 'bounded-replay-global' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const replay = vi.spyOn(edge, 'reannounceRfc64CatalogHeadsToPeerV1')
      .mockImplementation(async (_peerId, requestedScope) => {
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
        }
        if (requestedScope === undefined) throw new Error('missing replay scope');
        return replaySuccess(requestedScope);
      });
    const request = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      policyDigest: `0x${'22'.repeat(32)}` as Digest32V1,
    });

    const admitted = Array.from({ length: 64 }, (_, index) => (
      edge.queueRfc64CatalogHeadReplayV1(`12D3KooWReplayGlobal${index}`, request)
    ));
    await started;
    const overflow = edge.queueRfc64CatalogHeadReplayV1(
      '12D3KooWReplayGlobalOverflow',
      request,
    );
    release();
    await expect(overflow).rejects.toThrow(/replay queue is full/u);
    await expect(Promise.all(admitted)).resolves.toHaveLength(64);
    replay.mockRejectedValueOnce(new Error('injected global replay failure'));
    await expect(edge.queueRfc64CatalogHeadReplayV1(
      '12D3KooWReplayGlobalFailure',
      request,
    )).rejects.toThrow(/injected global replay failure/u);

    let releaseAfterFailure!: () => void;
    let enteredAfterFailure!: () => void;
    const gateAfterFailure = new Promise<void>((resolve) => { releaseAfterFailure = resolve; });
    const startedAfterFailure = new Promise<void>((resolve) => { enteredAfterFailure = resolve; });
    let postFailureCalls = 0;
    replay.mockImplementation(async (_peerId, requestedScope) => {
      postFailureCalls += 1;
      if (postFailureCalls === 1) {
        enteredAfterFailure();
        await gateAfterFailure;
      }
      if (requestedScope === undefined) throw new Error('missing replay scope');
      return replaySuccess(requestedScope);
    });
    const readmitted = Array.from({ length: 64 }, (_, index) => (
      edge.queueRfc64CatalogHeadReplayV1(
        `12D3KooWReplayGlobalAfterFailure${index}`,
        request,
      )
    ));
    await startedAfterFailure;
    const overflowAfterFailure = edge.queueRfc64CatalogHeadReplayV1(
      '12D3KooWReplayGlobalOverflowAfterFailure',
      request,
    );
    releaseAfterFailure();
    await expect(overflowAfterFailure).rejects.toThrow(/replay queue is full/u);
    await expect(Promise.all(readmitted)).resolves.toHaveLength(64);
  });

  it('returns replay busy across the production transport until real queue capacity recovers', async () => {
    const provider = await startAgent({
      name: 'replay-wire-capacity-provider',
      activation: activation('catalog'),
    });
    const requester = await startAgent({
      name: 'replay-wire-capacity-requester',
      activation: activation('catalog'),
    });
    await connectBothWays(provider, requester);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    vi.spyOn(provider, 'reannounceRfc64CatalogHeadsToPeerV1')
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
        }
        return Object.freeze({
          announced: 0,
          failed: 0,
          manifest: Object.freeze([]),
        });
      });
    const queued = Array.from({ length: 4 }, (_, index) => (
      provider.queueRfc64CatalogHeadReplayV1(requester.peerId, Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        policyDigest: `0x${(index + 1).toString(16).padStart(64, '0')}` as Digest32V1,
      }))
    ));
    await started;
    const tryQueue = vi.spyOn(provider, 'tryQueueRfc64CatalogHeadReplayV1');
    const replayRequest = (requester as any).rfc64PublicCatalogServiceV1
      .requestCatalogHeadReplay({
        remotePeerId: provider.peerId,
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
      });
    await vi.waitFor(() => {
      expect(tryQueue.mock.results.some(
        ({ value }) => value?.status === 'busy',
      )).toBe(true);
    });
    release();

    await expect(replayRequest).resolves.toEqual({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
      heads: [],
    });
    await expect(Promise.all(queued)).resolves.toHaveLength(4);
    expect(tryQueue.mock.results.some(
      ({ value }) => value?.status === 'admitted',
    )).toBe(true);
  }, 30_000);

  it('observes one completion for concurrently admitted production replay requests', async () => {
    const provider = await startAgent({
      name: 'replay-wire-coalesced-provider',
      activation: activation('catalog'),
    });
    const requester = await startAgent({
      name: 'replay-wire-coalesced-requester',
      activation: activation('catalog'),
    });
    await connectBothWays(provider, requester);
    // Drain the connection-triggered replays before observing the explicit
    // production-wire batch below. Otherwise scheduler speed can make that
    // unrelated lifecycle request appear in this test's admission count.
    await Promise.all([
      provider.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(CONTEXT_GRAPH_ID),
      requester.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(CONTEXT_GRAPH_ID),
    ]);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const replay = vi.spyOn(provider, 'reannounceRfc64CatalogHeadsToPeerV1')
      .mockImplementation(async (_peerId, requestedScope) => {
        entered();
        await gate;
        if (requestedScope === undefined) throw new Error('missing replay scope');
        return replaySuccess(requestedScope);
      });
    const tryQueue = vi.spyOn(provider, 'tryQueueRfc64CatalogHeadReplayV1');
    const info = vi.spyOn((provider as any).log, 'info');
    const service = (requester as any).rfc64PublicCatalogServiceV1;
    const requests = Array.from({ length: 4 }, () => service.requestCatalogHeadReplay({
      remotePeerId: provider.peerId,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    }));

    await started;
    let completed = false;
    void Promise.all(requests).then(() => { completed = true; });
    await vi.waitFor(() => {
      expect(tryQueue).toHaveBeenCalledTimes(requests.length);
    });
    expect(tryQueue.mock.results.filter(
      ({ value }) => value?.status === 'admitted' && value.newlyQueued,
    )).toHaveLength(1);
    expect(tryQueue.mock.results.filter(
      ({ value }) => value?.status === 'admitted' && !value.newlyQueued,
    )).toHaveLength(requests.length - 1);
    expect(completed).toBe(false);
    release();
    await expect(Promise.all(requests)).resolves.toHaveLength(requests.length);
    expect(replay).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(info.mock.calls.filter(([, message]: unknown[]) => (
        typeof message === 'string'
        && message.includes('Replayed 1 RFC-64 catalog head(s)')
      ))).toHaveLength(1);
    });
  }, 30_000);

  it('reruns a coalesced receiver replay for demand added while an earlier peer is in flight', async () => {
    const edge = await startAgent({
      name: 'replay-dirty-peer-fence',
      activation: activation('catalog'),
    });
    const peerA = '12D3KooWReplayDirtyPeerA';
    const peerB = '12D3KooWReplayDirtyPeerB';
    let connectedPeers = [peerA];
    vi.spyOn(edge.node.libp2p, 'getPeers').mockImplementation(() => (
      connectedPeers.map((peerId) => ({ toString: () => peerId })) as never
    ));
    let releaseA!: () => void;
    let releaseB!: () => void;
    let enteredA!: () => void;
    let enteredB!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    const startedA = new Promise<void>((resolve) => { enteredA = resolve; });
    const startedB = new Promise<void>((resolve) => { enteredB = resolve; });
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockImplementation(async ({ remotePeerId }: { remotePeerId: string }) => {
        if (remotePeerId === peerA) {
          enteredA();
          await gateA;
        } else if (remotePeerId === peerB) {
          enteredB();
          await gateB;
        }
        return Object.freeze({
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
          heads: Object.freeze([]),
        });
      });

    const replay = edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    );
    let settled = false;
    void replay.then(() => { settled = true; });
    await startedA;
    await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({ contextGraphId: CONTEXT_GRAPH_ID, phase: 'applying' }),
    );

    connectedPeers = [peerA, peerB];
    edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peerB);
    releaseA();
    await startedB;
    expect(settled).toBe(false);
    await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({ contextGraphId: CONTEXT_GRAPH_ID, phase: 'applying' }),
    );

    releaseB();
    await expect(replay).resolves.toEqual({ requested: 2, failed: 0 });
    expect(requestReplay.mock.calls.map(([{ remotePeerId }]: [{ remotePeerId: string }]) => (
      remotePeerId
    ))).toEqual([peerA, peerB]);
  });

  it('treats replay policy denial as negative provider discovery without hiding wire failure', async () => {
    const edge = await startAgent({
      name: 'replay-provider-discovery-boundary',
      activation: activation('catalog'),
    });
    const deniedPeer = '12D3KooWReplayDeniedNonProvider';
    const providerPeer = '12D3KooWReplayCompletionProvider';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => deniedPeer },
      { toString: () => providerPeer },
    ] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockImplementation(async ({ remotePeerId }: { remotePeerId: string }) => {
        if (remotePeerId === deniedPeer) {
          throw new Rfc64PublicCatalogTransportErrorV1(
            'catalog-transport-policy-denied',
            'peer does not hold this Context Graph',
          );
        }
        return Object.freeze({
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
          heads: Object.freeze([]),
        });
      });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestReplay.mock.calls.filter(
      ([{ remotePeerId }]: [{ remotePeerId: string }]) => remotePeerId === deniedPeer,
    )).toHaveLength(1);
    const [discoveryStatus] = await edge.readRfc64CatalogOperationalStatusV1();
    expect(discoveryStatus).toMatchObject({
      contextGraphId: CONTEXT_GRAPH_ID,
      phase: 'bootstrapping',
    });
    expect(discoveryStatus?.stableReason).not.toBe('catalog-replay-incomplete');

    requestReplay.mockImplementation(async () => {
      throw new Rfc64PublicCatalogTransportErrorV1(
        'catalog-transport-wire',
        'legacy admission-only acknowledgement',
      );
    });
    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 0, failed: 2 });
    await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({
        contextGraphId: CONTEXT_GRAPH_ID,
        phase: 'blocked',
        stableReason: 'catalog-replay-incomplete',
      }),
    );
  });

  it('marks then clears the synchronous connection replay fence when admission denies the peer', async () => {
    const peer = await startAgent({ name: 'replay-denied-connection-peer' });
    const edge = await startAgent({
      name: 'replay-denied-connection-edge',
      activation: activation('catalog'),
    });
    const admission = vi.spyOn(
      (edge as any).networkAdmissionCoordinator,
      'ensureAdmitted',
    ).mockImplementation(async (peerId: string) => peerId !== peer.peerId);
    const markPending = vi.spyOn(edge, 'markRfc64CatalogReplayPeerPendingV1');
    const clearPending = vi.spyOn(edge, 'clearRfc64CatalogReplayPeerPendingV1');
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay');
    edge.node.libp2p.dispatchEvent(new CustomEvent('connection:open', {
      detail: {
        remotePeer: peer.node.libp2p.peerId,
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1' },
        direction: 'inbound',
        timeline: { open: Date.now() },
      },
    } as any));
    expect(markPending).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, peer.peerId);
    await vi.waitFor(() => {
      expect(clearPending).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, peer.peerId);
    });
    expect(markPending.mock.invocationCallOrder[0]).toBeLessThan(
      admission.mock.invocationCallOrder[0]!,
    );
    expect(admission.mock.invocationCallOrder[0]).toBeLessThan(
      clearPending.mock.invocationCallOrder[0]!,
    );
    await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({ contextGraphId: CONTEXT_GRAPH_ID, phase: 'bootstrapping' }),
    );
    expect(requestReplay).not.toHaveBeenCalled();
  }, 15_000);

  it('connection replay sends public and authorized private heads without disclosing private metadata to a nonmember', async () => {
    const privateContextGraphId = `${AUTHOR}/private-connection-replay` as ContextGraphIdV1;
    const memberPeerId = '12D3KooWConnectionReplayMember';
    const nonmemberPeerId = '12D3KooWConnectionReplayNonmember';
    const remoteAgents = new Map<string, EvmAddressV1>([
      [memberPeerId, MEMBER],
      [nonmemberPeerId, NONMEMBER],
    ]);
    const author = await startAgent({
      name: 'connection-replay-access-boundary',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          resolveRemoteAgentAddress: async (peerId) => remoteAgents.get(peerId) ?? null,
        },
      },
    });
    const signer = Object.freeze({
      address: AUTHOR,
      signMessage: (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
    });
    const issuedAt = '1773900000000' as TimestampMsV1;
    const delegationEffectiveAt = '1773899999000' as TimestampMsV1;
    const delegationExpiresAt = '1893456000000' as TimestampMsV1;

    const publicGenesis = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: signer,
      peers: [],
      issuedAt,
      catalogIssuerDelegationEffectiveAt: delegationEffectiveAt,
      catalogIssuerDelegationExpiresAt: delegationExpiresAt,
    });
    const privateAuthority = composeRfc64UnregisteredCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: privateContextGraphId,
      ownerAddress: AUTHOR,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthorityAccountId: '0',
      memberAddresses: [AUTHOR, MEMBER],
      rosterVersion: '0',
    });
    author.acceptRfc64CatalogAccessSnapshotV1({
      policy: privateAuthority.policy,
      policyDigest: privateAuthority.policyDigest,
      roster: privateAuthority.roster,
    });
    const privateScope = Object.freeze({
      networkId: NETWORK_ID,
      contextGraphId: privateContextGraphId,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    }) as AuthorCatalogScopeV1;
    const privateGenesis = await author.publishAuthorCatalogGenesisV1({
      scope: privateScope,
      author: signer,
      peers: [],
      issuedAt,
      catalogIssuerDelegationEffectiveAt: delegationEffectiveAt,
      catalogIssuerDelegationExpiresAt: delegationExpiresAt,
    });

    const persistence = (author as any).rfc64PersistenceV1;
    expect(persistence).toBeDefined();
    for (const [scope, publication] of [
      [{
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: null,
        authorAddress: AUTHOR,
        era: '0',
        bucketCount: '1',
      } as AuthorCatalogScopeV1, publicGenesis],
      [privateScope, privateGenesis],
    ] as const) {
      const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
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
    }

    const send = vi.spyOn((author as any).router, 'send')
      .mockResolvedValue(Uint8Array.of(1));
    const announcementContextGraphs = () => send.mock.calls
      .filter(([, protocolId]) => (
        protocolId === RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1
      ))
      .map(([, , data]) => (
        parseRfc64PublicCatalogHeadAnnouncementV1(data).contextGraphId
      ));

    const nonmemberReplay = await author.reannounceRfc64CatalogHeadsToPeerV1(nonmemberPeerId);
    expect(nonmemberReplay).toMatchObject({ announced: 1, failed: 1 });
    expect(nonmemberReplay.manifest.map(({ contextGraphId }) => contextGraphId))
      .toEqual([CONTEXT_GRAPH_ID]);
    expect(announcementContextGraphs()).toEqual([CONTEXT_GRAPH_ID]);

    send.mockClear();
    const memberReplay = await author.reannounceRfc64CatalogHeadsToPeerV1(memberPeerId);
    expect(memberReplay).toMatchObject({ announced: 2, failed: 0 });
    expect(memberReplay.manifest.map(({ contextGraphId }) => contextGraphId).sort())
      .toEqual([CONTEXT_GRAPH_ID, privateContextGraphId].sort());
    expect(announcementContextGraphs().sort())
      .toEqual([CONTEXT_GRAPH_ID, privateContextGraphId].sort());
  });

  it('fails replay when an applied inventory row points at a missing durable head', async () => {
    const { provider, persistence, applied } = await startAppliedOpenReplayProvider(
      'replay-missing-durable-head',
    );
    persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
      ...applied,
      expectedCurrentCatalogHeadDigest: applied.currentCatalogHeadDigest,
      currentCatalogHeadDigest: `0x${'ab'.repeat(32)}`,
      catalogVersion: '1',
    });

    await expect(provider.reannounceRfc64CatalogHeadsToPeerV1(
      '12D3KooWReplayMissingHeadPeer',
    )).rejects.toThrow(/durable catalog head is missing or unverifiable/u);
  });

  it('rejects a replay snapshot when the durable inventory changes during head loading', async () => {
    const { provider, persistence, scope, applied } =
      await startAppliedOpenReplayProvider('replay-inventory-race');
    vi.spyOn((provider as any).router, 'send').mockResolvedValue(Uint8Array.of(1));
    await provider.reannounceRfc64CatalogHeadsToPeerV1(
      '12D3KooWReplayInventoryWarmupPeer',
    );
    let releaseMutation!: () => void;
    let markMutationEntered!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutationEntered = new Promise<void>((resolve) => { markMutationEntered = resolve; });
    const heldMutation = (provider as any).rfc64CatalogMutationCoordinatorV1.run(
      scope,
      async () => {
        markMutationEntered();
        await mutationGate;
      },
    );
    await mutationEntered;

    const replay = provider.reannounceRfc64CatalogHeadsToPeerV1(
      '12D3KooWReplayInventoryRacePeer',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
      ...applied,
      expectedCurrentCatalogHeadDigest: applied.currentCatalogHeadDigest,
      currentCatalogHeadDigest: `0x${'cd'.repeat(32)}`,
      catalogVersion: '1',
    });
    releaseMutation();
    await heldMutation;

    await expect(replay).rejects.toThrow(/inventory changed before replay snapshot/u);
  });

  it('keeps system control graphs on durable sync under default catalog responsibility', async () => {
    const edge = await startAgent({ name: 'default-system-sync' });

    for (const contextGraphId of Object.values(SYSTEM_CONTEXT_GRAPHS)) {
      expect(edge.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId)).toMatchObject({
        active: true,
        mode: 'legacy',
        legacySyncAllowed: true,
        track2Enabled: false,
        reconciliationLane: 'legacy',
      });
    }

    await edge.createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Default application catalog',
      callerAgentAddress: AUTHOR,
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID))
      .toMatchObject({ legacySyncAllowed: false, reconciliationLane: 'catalog-apply' });
  });

  it('fails closed when an unregistered graph has no authenticated owner', async () => {
    const contextGraphId = `${AUTHOR}/unresolved-owner` as ContextGraphIdV1;
    const edge = await startAgent({ name: 'unresolved-unregistered-owner' });
    (edge as any).defaultAgentAddress = AUTHOR;
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue(null);
    vi.spyOn(edge, 'getContextGraphOwner').mockResolvedValue(null);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('public');

    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId))
      .rejects.toThrow(/no canonical owner address/u);
    expect((edge as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      contextGraphId,
    )).toBeNull();
  });

  it('classifies missing finalized authority capability consistently for registered graphs', async () => {
    const edge = await startAgent({ name: 'registered-authority-unsupported' });
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue('9');

    await expect(edge.readRfc64CurrentCuratorAuthorityBindingV1(CONTEXT_GRAPH_ID))
      .rejects.toMatchObject({
        name: 'Rfc64CatalogAuthorityResolutionErrorV1',
        code: 'registered-authority-adapter-unsupported',
      });
    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID))
      .rejects.toMatchObject({
        name: 'Rfc64CatalogAuthorityResolutionErrorV1',
        code: 'registered-authority-adapter-unsupported',
      });
  });

  it('rejects a curator binding returned for a different registered Context Graph ID', async () => {
    const mismatchedSnapshot = Object.freeze({
      ...finalizedAuthoritySnapshot(CONTEXT_GRAPH_ID, [AUTHOR], '0'),
      contextGraphId: '10',
    });
    const edge = await startAgent({
      name: 'registered-curator-binding-mismatch',
      config: { chainAdapter: chainWithFinalizedAuthority(mismatchedSnapshot) },
    });
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue('9');

    await expect(edge.readRfc64CurrentCuratorAuthorityBindingV1(CONTEXT_GRAPH_ID))
      .rejects.toThrow(/does not match the requested ID/u);
  });

  it('derives clean-config responsibility from normal create and unsubscribe', async () => {
    const edge = await startAgent({ name: 'default-responsibility' });
    const requestReplays = vi.spyOn(
      edge,
      'requestRfc64CatalogHeadReplaysFromConnectedPeersV1',
    ).mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));

    await edge.createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Default RFC-64 responsibility',
      callerAgentAddress: AUTHOR,
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([{
      contextGraphId: CONTEXT_GRAPH_ID,
      responsible: true,
      responsibilityReason: 'edge-subscription',
      active: true,
      mode: 'catalog',
      selectionSource: 'default',
    }]);
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID)).toMatchObject({
      eligible: true,
      active: true,
      mode: 'catalog',
      legacySyncAllowed: false,
      track2Enabled: true,
      reconciliationLane: 'catalog-apply',
    });
    expect(edge.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    requestReplays.mockClear();
    expect(await edge.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID))
      .toMatchObject({ source: 'owner-signed-unregistered' });
    expect(requestReplays).toHaveBeenCalledOnce();
    expect(requestReplays).toHaveBeenCalledWith(CONTEXT_GRAPH_ID);

    edge.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID)).toMatchObject({
      active: false,
      legacySyncAllowed: false,
      track2Enabled: false,
      reconciliationLane: 'disabled',
    });
  });

  async function prepareAuthorityRefreshLifecycle() {
    const legacyContextGraphId = `${AUTHOR}/authority-refresh-legacy` as ContextGraphIdV1;
    const inactiveContextGraphId = `${AUTHOR}/authority-refresh-inactive` as ContextGraphIdV1;
    const authoritySnapshot = finalizedAuthoritySnapshot(CONTEXT_GRAPH_ID, [AUTHOR], '0');
    const chainAdapter = chainWithFinalizedAuthority(authoritySnapshot);
    const edge = await startAgent({
      name: 'authority-refresh-lifecycle',
      config: {
        chainAdapter,
        rfc64CatalogActivation: {
          deploymentProfile: DEPLOYMENT,
          rollout: { contextGraphModes: { [legacyContextGraphId]: 'legacy' } },
        },
      },
    });
    const runtime = (edge as unknown as {
      rfc64CatalogRuntimeV1: Rfc64CatalogRuntimeV1;
    }).rfc64CatalogRuntimeV1;
    await edge.createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Authority refresh timer lifecycle',
      callerAgentAddress: AUTHOR,
    });
    await edge.createContextGraph({
      id: legacyContextGraphId,
      name: 'Authority refresh legacy exclusion',
      callerAgentAddress: AUTHOR,
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    const responsibilities = edge.readRfc64CatalogResponsibilitiesV1();
    expect(responsibilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ contextGraphId: CONTEXT_GRAPH_ID, active: true, mode: 'catalog' }),
      expect.objectContaining({
        contextGraphId: legacyContextGraphId,
        active: true,
        mode: 'legacy',
      }),
    ]));
    await runtime.close();
    vi.spyOn(edge, 'readRfc64CatalogResponsibilitiesV1').mockReturnValue(Object.freeze([
      ...responsibilities,
      Object.freeze({
        contextGraphId: inactiveContextGraphId,
        responsible: true,
        responsibilityReason: 'edge-subscription' as const,
        active: false,
        mode: 'catalog' as const,
        selectionSource: 'kill-switch' as const,
      }),
    ]));
    return { authoritySnapshot, chainAdapter, edge, runtime };
  }

  it('wires refresh cadence only for active catalog responsibilities', async () => {
    const { edge, runtime } = await prepareAuthorityRefreshLifecycle();
    const reconcile = vi.spyOn(edge, 'reconcileRfc64CatalogAccessAuthorityV1')
      .mockResolvedValue(null);
    vi.useFakeTimers();
    try {
      runtime.start(createOperationContext('system'));
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, expect.any(AbortSignal));
      reconcile.mockClear();

      await vi.advanceTimersByTimeAsync(
        RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs,
      );
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, expect.any(AbortSignal));
      await runtime.close();
      reconcile.mockClear();
      await vi.advanceTimersByTimeAsync(
        RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs,
      );
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  it('waits for a stalled authority read during public agent shutdown', async () => {
    const { authoritySnapshot, chainAdapter, edge, runtime } =
      await prepareAuthorityRefreshLifecycle();
    let releaseAuthorityRead = () => undefined;
    let stopping: Promise<void> | undefined;
    try {
      vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue('9');
      let markAuthorityReadStarted!: () => void;
      const authorityReadStarted = new Promise<void>((resolve) => {
        markAuthorityReadStarted = resolve;
      });
      const authorityReadGate = new Promise<void>((resolve) => {
        releaseAuthorityRead = resolve;
      });
      vi.mocked(chainAdapter.getContextGraphAuthoritySnapshot!)
        .mockImplementation(async () => {
          markAuthorityReadStarted();
          await authorityReadGate;
          return authoritySnapshot;
        });

      runtime.start(createOperationContext('system'));
      await authorityReadStarted;
      let idleSettled = false;
      const idle = edge.whenRfc64CatalogSupervisorsIdleV1()
        .then(() => { idleSettled = true; });
      let stopSettled = false;
      stopping = edge.stop().then(() => { stopSettled = true; });
      await Promise.resolve();
      expect(idleSettled).toBe(false);
      expect(stopSettled).toBe(false);

      releaseAuthorityRead();
      await Promise.all([stopping, idle]);
      expect(stopSettled).toBe(true);
      expect(idleSettled).toBe(true);
    } finally {
      releaseAuthorityRead();
      await stopping?.catch(() => undefined);
    }
  });

  it('keeps a durable create successful when post-commit responsibility resolution transiently fails', async () => {
    const contextGraphId = `${AUTHOR}/post-commit-responsibility-failure` as ContextGraphIdV1;
    const edge = await startAgent({ name: 'post-commit-responsibility-failure' });
    const store = (edge as unknown as { store: OxigraphStore }).store;
    const flush = vi.spyOn(store, 'flush');
    const readPolicy = edge.getExplicitAccessPolicy.bind(edge);
    let failNextPolicyRead = false;
    let observedPostCommitFailure = false;
    vi.spyOn((edge as any).gossip, 'publish').mockImplementation(async () => {
      // Public definition gossip is the last awaited step before the explicit
      // post-commit responsibility reconciliation. Arm only that policy read;
      // earlier subscription-owned attempts remain real and cannot consume it.
      failNextPolicyRead = true;
    });
    const policyRead = vi.spyOn(edge, 'getExplicitAccessPolicy')
      .mockImplementation(async (id) => {
        if (failNextPolicyRead) {
          failNextPolicyRead = false;
          observedPostCommitFailure = true;
          throw new Error('policy store temporarily unavailable');
        }
        return readPolicy(id);
      });

    await expect(edge.createContextGraph({
      id: contextGraphId,
      name: 'Post-commit responsibility failure',
    })).resolves.toBeUndefined();

    expect(flush).toHaveBeenCalledOnce();
    await expect(edge.contextGraphExists(contextGraphId)).resolves.toBe(true);
    expect(observedPostCommitFailure).toBe(true);
    await vi.waitFor(() => {
      expect(policyRead.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
        expect.objectContaining({
          contextGraphId,
          responsibilityReason: 'edge-subscription',
          active: true,
          mode: 'catalog',
        }),
      );
    });

    // No trusted owner was supplied, so the retry may recover responsibility
    // selection but authority remains visibly blocked and the receiver stays
    // fail-closed until a later authoritative lifecycle update.
    await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({
        contextGraphId,
        phase: 'blocked',
        authorityState: 'blocked',
        stableReason: 'unregistered-owner-unresolved',
        legacySyncAllowed: false,
      }),
    );
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId)).toMatchObject({
      active: false,
      legacySyncAllowed: false,
      reconciliationLane: 'disabled',
    });
  });

  it('reconciles default responsibility when a live subscription is bound late', async () => {
    const contextGraphId = `${AUTHOR}/late-verified-binding`;
    const edge = await startAgent({ name: 'late-verified-binding' });
    const requestReplays = vi.spyOn(
      edge,
      'requestRfc64CatalogHeadReplaysFromConnectedPeersV1',
    ).mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);
    vi.spyOn(edge, 'getContextGraphOnChainPolicy').mockResolvedValue({
      accessPolicy: 0,
      publishPolicy: 0,
    });

    edge.subscribeToContextGraph(contextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);

    const subscription = edge.getSubscribedContextGraphs().get(contextGraphId);
    expect(subscription).toBeDefined();
    (edge as any).bindSubscriptionOnChainId(contextGraphId, subscription, '3');
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'edge-subscription',
        mode: 'catalog',
        selectionSource: 'default',
      }),
    ]);
    expect(requestReplays).toHaveBeenCalledWith(contextGraphId);
  });

  it('retains a public chain event that arrives before the cleartext subscription', async () => {
    const contextGraphId = `${AUTHOR}/public-chain-event-first`;
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
    const edge = await startAgent({ name: 'public-chain-event-first' });
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);
    vi.spyOn(edge, 'getContextGraphOnChainPolicy').mockResolvedValue({
      accessPolicy: 0,
      publishPolicy: 0,
    });
    vi.spyOn(edge, 'reconcileRfc64CatalogAccessAuthorityV1').mockResolvedValue(null);
    const internals = edge as any;

    // Mirror the live ordering from a cold Edge: finalized ContextGraphCreated
    // is observed before the user supplies the matching human-readable id.
    expect(internals.stageOnChainContextGraphBindingFromNameHash(
      wireId,
      '3',
      { persist: false },
    )).toBe(wireId);
    expect(edge.getSubscribedContextGraphs().get(wireId)).toMatchObject({
      subscribed: false,
      onChainId: '3',
      onChainHash: wireId,
    });

    edge.subscribeToContextGraph(contextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.getSubscribedContextGraphs().has(wireId)).toBe(false);
    expect(edge.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '3',
      onChainHash: wireId,
    });
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'edge-subscription',
        mode: 'catalog',
        selectionSource: 'default',
      }),
    ]);
  });

  it('promotes a chain-discovered private wire placeholder to the admitted local identity', async () => {
    const contextGraphId = `${AUTHOR}/private-wire-promotion`;
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
    const edge = await startAgent({ name: 'private-wire-promotion' });
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('private');
    vi.spyOn(edge, 'hasRfc64VerifiedPrivateMembershipV1').mockResolvedValue(true);
    const internals = edge as any;

    // Mirror the private ContextGraphCreated path: before admission the Edge
    // knows only the curator-committed wire id and numeric chain id.
    internals.setContextGraphSubscription(wireId, {
      subscribed: false,
      synced: false,
      onChainHash: wireId,
      pendingMeta: true,
    }, { persist: false });
    expect(internals.bindOnChainContextGraphIdFromNameHash(
      wireId,
      '3',
      { persist: false },
    )).toBe(wireId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId: wireId,
        responsibilityReason: 'private-membership',
      }),
    ]);

    // A trusted join approval supplies the matching human id. The canonical
    // setter must carry its chain binding forward and retire the placeholder,
    // including its RFC-64 responsibility.
    internals.setContextGraphSubscription(contextGraphId, {
      subscribed: true,
      synced: false,
      pendingMeta: true,
      metaSynced: false,
    }, { persist: false });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.getSubscribedContextGraphs().has(wireId)).toBe(false);
    expect(edge.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '3',
      onChainHash: wireId,
    });
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'private-membership',
        mode: 'catalog',
        selectionSource: 'default',
      }),
    ]);
  });

  it('requires verified current membership for private responsibility', async () => {
    const privateContextGraphId = `${AUTHOR}/private-responsibility`;
    const edge = await startAgent({ name: 'private-responsibility' });
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('private');
    const hasMembership = vi.spyOn(edge, 'hasRfc64VerifiedPrivateMembershipV1')
      .mockResolvedValue(false);

    edge.subscribeToContextGraph(privateContextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);
    expect(hasMembership).toHaveBeenCalledWith(privateContextGraphId);

    hasMembership.mockResolvedValue(true);
    await edge.reconcileRfc64CatalogResponsibilityV1(privateContextGraphId);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId: privateContextGraphId,
        responsibilityReason: 'private-membership',
        mode: 'catalog',
        selectionSource: 'default',
      }),
    ]);
  });

  it('derives private responsibility from authenticated DKG ACL state, not a stale RFC-64 roster', async () => {
    const contextGraphId = `${AUTHOR}/private-roster-bootstrap` as ContextGraphIdV1;
    const edge = await startAgent({ name: 'private-roster-bootstrap' });
    (edge as any).defaultAgentAddress = MEMBER;
    vi.spyOn(edge, 'resolveRfc64PrivateReadRosterV1').mockReturnValue([AUTHOR]);
    await expect(edge.canReadContextGraph(contextGraphId, {
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('private');
    const confirmedMeta = vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(false);
    const recoveryGate = vi.spyOn(edge, 'getMemberRecoveryGate')
      .mockResolvedValue([AUTHOR, MEMBER]);
    await expect(edge.resolveRfc64VerifiedPrivateRosterV1(contextGraphId))
      .resolves.toBeNull();
    expect(recoveryGate).not.toHaveBeenCalled();

    confirmedMeta.mockResolvedValue(true);
    recoveryGate.mockResolvedValue([AUTHOR]);
    await expect(edge.hasRfc64VerifiedPrivateMembershipV1(contextGraphId))
      .resolves.toBe(false);
    recoveryGate.mockResolvedValue([AUTHOR, MEMBER]);
    await expect(edge.hasRfc64VerifiedPrivateMembershipV1(contextGraphId))
      .resolves.toBe(true);
    recoveryGate.mockClear();

    edge.subscribeToContextGraph(contextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(recoveryGate).toHaveBeenCalledWith(contextGraphId);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'private-membership',
        active: true,
      }),
    ]);
  });

  it('selects a non-default private local agent per Context Graph and fails closed on ambiguity', async () => {
    const contextGraphId = `${AUTHOR}/private-non-default-local-agent` as ContextGraphIdV1;
    const edge = await startAgent({ name: 'private-non-default-local-agent' });
    (edge as any).defaultAgentAddress = AUTHOR;
    vi.spyOn(edge, 'listLocalAgents').mockReturnValue([
      { agentAddress: AUTHOR },
      { agentAddress: MEMBER },
    ] as ReturnType<DKGAgent['listLocalAgents']>);
    vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(true);
    const recoveryGate = vi.spyOn(edge, 'getMemberRecoveryGate')
      .mockResolvedValue([MEMBER]);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('private');

    await expect(edge.resolveRfc64CatalogLocalAgentAddressV1(contextGraphId))
      .resolves.toBe(MEMBER);
    edge.subscribeToContextGraph(contextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'private-membership',
        active: true,
      }),
    );

    recoveryGate.mockResolvedValue([AUTHOR, MEMBER]);
    await expect(edge.resolveRfc64CatalogLocalAgentAddressV1(contextGraphId))
      .resolves.toBeNull();
    await edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);

    (edge as any).localApprovedAgentByCG.set(contextGraphId, MEMBER);
    await expect(edge.resolveRfc64CatalogLocalAgentAddressV1(contextGraphId))
      .resolves.toBe(MEMBER);
    await edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'private-membership',
        active: true,
      }),
    );
  });

  it('binds private catalog peers from verified join credentials without profile gossip', async () => {
    const contextGraphId = `${AUTHOR}/private-peer-binding` as ContextGraphIdV1;
    const curatorPeerId = '12D3KooWVerifiedPrivateCurator';
    const memberPeerId = '12D3KooWVerifiedPrivateMember';
    const edge = await startAgent({ name: 'private-peer-binding' });
    vi.spyOn(edge, 'findAgentByPeerId').mockResolvedValue(null);
    vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(true);
    const delegateePeers = vi.spyOn(edge, 'getContextGraphAllowedDelegateePeers')
      .mockResolvedValue(new Map([[MEMBER, [memberPeerId]]]));

    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      memberPeerId,
      contextGraphId,
    )).resolves.toBe(MEMBER);

    delegateePeers.mockResolvedValue(new Map());
    (edge as any).localApprovedAgentByCG.set(contextGraphId, MEMBER);
    const requesterState = vi.spyOn(edge, 'readRequesterJoinRequestState')
      .mockResolvedValue({
        status: 'approved',
        requestGeneration: `0x${'11'.repeat(32)}`,
        curatorPeerId,
        curatorAgentAddress: AUTHOR,
        curatorAuthorityEra: '0',
      });
    const currentCuratorBinding = vi.spyOn(
      edge,
      'readRfc64CurrentCuratorAuthorityBindingV1',
    ).mockResolvedValue({ agentAddress: AUTHOR, authorityEra: '0' });
    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      curatorPeerId,
      contextGraphId,
    )).resolves.toBe(AUTHOR);

    currentCuratorBinding.mockResolvedValue({ agentAddress: MEMBER, authorityEra: '1' });
    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      curatorPeerId,
      contextGraphId,
    )).resolves.toBeNull();
    currentCuratorBinding.mockResolvedValue({ agentAddress: AUTHOR, authorityEra: '0' });

    requesterState.mockResolvedValue({
      status: 'pending',
      requestGeneration: `0x${'11'.repeat(32)}`,
      curatorPeerId,
    });
    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      curatorPeerId,
      contextGraphId,
    )).resolves.toBeNull();
    requesterState.mockResolvedValue({
      status: 'approved',
      requestGeneration: `0x${'11'.repeat(32)}`,
      curatorPeerId: '12D3KooWDifferentCurator',
    });
    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      curatorPeerId,
      contextGraphId,
    )).resolves.toBeNull();

    delegateePeers.mockResolvedValue(new Map([
      [MEMBER, [memberPeerId]],
      [AUTHOR, [memberPeerId]],
    ]));
    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      memberPeerId,
      contextGraphId,
    )).resolves.toBeNull();
  });

  it('merges an authenticated lifecycle roster into finalized registered authority', async () => {
    const contextGraphId = `${AUTHOR}/registered-private-roster` as ContextGraphIdV1;
    const chainAdapter = chainWithFinalizedAuthority(finalizedAuthoritySnapshot(
      contextGraphId,
      [AUTHOR],
      '0',
    ));
    const edge = await startAgent({
      name: 'registered-private-roster',
      config: {
        chainAdapter,
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: MEMBER,
          resolveRemoteAgentAddress: async () => null,
        },
      },
    });
    (edge as any).defaultAgentAddress = MEMBER;
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue('9');
    vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(true);
    vi.spyOn(edge, 'getMemberRecoveryGate').mockResolvedValue([AUTHOR, MEMBER]);
    vi.spyOn(edge, 'readRfc64PrivateRosterVersionV1').mockResolvedValue('1788482000000');
    vi.spyOn(edge, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
      .mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));

    const authority = await edge.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId);

    expect(authority?.roster).toMatchObject({
      version: '1788482000000',
      members: [
        { agentAddress: MEMBER, roles: ['holder', 'provider'] },
        { agentAddress: AUTHOR, roles: ['holder', 'provider'] },
      ].sort((left, right) => left.agentAddress.localeCompare(right.agentAddress)),
    });
    expect(edge.resolveRfc64PrivateReadRosterV1(contextGraphId))
      .toEqual([MEMBER, AUTHOR].sort());
  });

  it('binds registered hash-only subscriptions to their explicit chain commitment', async () => {
    const wireId = `0x${'91'.repeat(32)}` as ContextGraphIdV1;
    const snapshot = Object.freeze({
      ...finalizedAuthoritySnapshot('cleartext-name-not-known-here', [], '0'),
      accessPolicy: 0 as const,
      publishPolicy: 1 as const,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
      participantAgents: Object.freeze([]),
      nameHash: wireId,
    });
    const core = await startAgent({
      name: 'registered-hash-only-authority',
      config: {
        nodeRole: 'core',
        chainAdapter: chainWithFinalizedAuthority(snapshot),
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
      },
    });
    vi.spyOn(core, 'getExplicitAccessPolicy').mockResolvedValue(null);
    vi.spyOn(core, 'getContextGraphOnChainPolicy').mockResolvedValue({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    vi.spyOn(core, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
      .mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));
    const internals = core as any;
    expect(internals.stageOnChainContextGraphBindingFromNameHash(
      wireId,
      '9',
      { persist: false },
    )).toBe(wireId);
    const staged = core.getSubscribedContextGraphs().get(wireId);
    internals.setContextGraphSubscription(wireId, {
      ...staged,
      coreHosted: true,
    }, { persist: false });
    await core.whenRfc64CatalogResponsibilitiesIdleV1();

    await expect(core.readRfc64CurrentCuratorAuthorityBindingV1(wireId))
      .resolves.toEqual({ agentAddress: AUTHOR, authorityEra: '0' });
    await expect(core.reconcileRfc64CatalogAccessAuthorityV1(wireId))
      .resolves.toMatchObject({ policy: { contextGraphId: wireId } });
    expect(core.resolveRfc64CatalogServingAuthorityV1(wireId))
      .toMatchObject({ active: true, track2Enabled: true });

    const hashShapedCleartext = `0x${'92'.repeat(32)}` as ContextGraphIdV1;
    const cleartextCommitment = ethers.keccak256(
      ethers.toUtf8Bytes(hashShapedCleartext),
    ).toLowerCase();
    const cleartextSnapshot = Object.freeze({
      ...snapshot,
      contextGraphId: '10',
      nameHash: cleartextCommitment,
    });
    const cleartextCore = await startAgent({
      name: 'registered-hash-shaped-cleartext-authority',
      config: {
        nodeRole: 'core',
        chainAdapter: chainWithFinalizedAuthority(cleartextSnapshot),
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
      },
    });
    vi.spyOn(cleartextCore, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
      .mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));
    (cleartextCore as any).setContextGraphSubscription(hashShapedCleartext, {
      subscribed: false,
      synced: false,
      coreHosted: true,
      onChainId: '10',
    }, { persist: false });
    await cleartextCore.whenRfc64CatalogResponsibilitiesIdleV1();
    await expect(cleartextCore.readRfc64CurrentCuratorAuthorityBindingV1(
      hashShapedCleartext,
    )).resolves.toEqual({ agentAddress: AUTHOR, authorityEra: '0' });
    await expect(cleartextCore.reconcileRfc64CatalogAccessAuthorityV1(
      hashShapedCleartext,
    )).resolves.toMatchObject({ policy: { contextGraphId: hashShapedCleartext } });
  });

  it('rejects a registered authority whose final merged roster exceeds 256 members', async () => {
    const contextGraphId = `${AUTHOR}/registered-private-roster-overflow` as ContextGraphIdV1;
    const chainMembers = Array.from({ length: 256 }, (_, index) => (
      `0x${(index + 1).toString(16).padStart(40, '0')}` as EvmAddressV1
    ));
    const localMember = '0x0000000000000000000000000000000000000101' as EvmAddressV1;
    const edge = await startAgent({
      name: 'registered-private-roster-overflow',
      config: {
        chainAdapter: chainWithFinalizedAuthority(finalizedAuthoritySnapshot(
          contextGraphId,
          chainMembers,
          '0',
        )),
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: localMember,
          resolveRemoteAgentAddress: async () => null,
        },
      },
    });
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue('9');
    vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(true);
    vi.spyOn(edge, 'getMemberRecoveryGate').mockResolvedValue([localMember]);
    vi.spyOn(edge, 'readRfc64PrivateRosterVersionV1').mockResolvedValue('1');

    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId))
      .rejects.toThrow(/member roster cannot exceed 256/u);
  });

  it('does not re-add a locally revoked participant from a finalized chain snapshot', async () => {
    const contextGraphId = `${AUTHOR}/registered-private-revocation` as ContextGraphIdV1;
    const chainAdapter = chainWithFinalizedAuthority(finalizedAuthoritySnapshot(
      contextGraphId,
      [AUTHOR, MEMBER],
      '6',
    ));
    const edge = await startAgent({
      name: 'registered-private-revocation',
      config: {
        chainAdapter,
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          resolveRemoteAgentAddress: async () => null,
        },
      },
    });
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue('9');
    vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(true);
    vi.spyOn(edge, 'getMemberRecoveryGate').mockResolvedValue([AUTHOR]);
    vi.spyOn(edge, 'getCgMeta').mockResolvedValue({
      ...(await edge.getCgMeta(contextGraphId)),
      revokedAgents: [MEMBER],
    });
    vi.spyOn(edge, 'readRfc64PrivateRosterVersionV1').mockResolvedValue('7');
    vi.spyOn(edge, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
      .mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));

    const authority = await edge.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId);

    expect(authority?.roster?.members.map(({ agentAddress }) => agentAddress))
      .toEqual([AUTHOR]);
    expect(edge.resolveRfc64PrivateReadRosterV1(contextGraphId)).toEqual([AUTHOR]);
  });

  it('rotates the private authority generation on ordinary invite and removal', async () => {
    const contextGraphId = `${AUTHOR}/private-roster-rotation` as ContextGraphIdV1;
    const curator = await startAgent({
      name: 'private-roster-rotation',
      config: {
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          resolveRemoteAgentAddress: async () => null,
        },
      },
    });
    (curator as any).defaultAgentAddress = AUTHOR;
    await curator.createContextGraph({
      id: contextGraphId,
      name: 'Private roster rotation',
      accessPolicy: 1,
      callerAgentAddress: AUTHOR,
    });
    expect(await curator.readRfc64PrivateRosterVersionV1(contextGraphId)).toBe('0');

    await curator.inviteAgentToContextGraph(contextGraphId, MEMBER, AUTHOR);
    const admittedVersion = BigInt(
      await curator.readRfc64PrivateRosterVersionV1(contextGraphId),
    );
    expect(admittedVersion).toBeGreaterThan(0n);
    expect(curator.resolveRfc64PrivateReadRosterV1(contextGraphId))
      .toEqual([MEMBER, AUTHOR].sort());

    await curator.removeAgentFromContextGraph(contextGraphId, MEMBER, AUTHOR);
    expect(BigInt(await curator.readRfc64PrivateRosterVersionV1(contextGraphId)))
      .toBeGreaterThan(admittedVersion);
    expect(curator.resolveRfc64PrivateReadRosterV1(contextGraphId)).toEqual([AUTHOR]);
  });

  it('rejects an out-of-order unregistered roster refresh after removal', async () => {
    const contextGraphId = `${AUTHOR}/private-roster-out-of-order` as ContextGraphIdV1;
    const curator = await startAgent({
      name: 'private-roster-out-of-order',
      config: {
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          resolveRemoteAgentAddress: async () => null,
        },
      },
    });
    (curator as any).defaultAgentAddress = AUTHOR;
    await curator.createContextGraph({
      id: contextGraphId,
      name: 'Private out-of-order roster refresh',
      accessPolicy: 1,
      callerAgentAddress: AUTHOR,
    });
    await curator.whenRfc64CatalogResponsibilitiesIdleV1();

    let releaseStaleVersion!: () => void;
    let staleVersionEntered!: () => void;
    const staleVersionGate = new Promise<void>((resolve) => { releaseStaleVersion = resolve; });
    const staleVersionRead = new Promise<void>((resolve) => { staleVersionEntered = resolve; });
    vi.spyOn(curator, 'resolveRfc64VerifiedPrivateRosterV1')
      .mockResolvedValueOnce([AUTHOR, MEMBER])
      .mockResolvedValueOnce([AUTHOR]);
    vi.spyOn(curator, 'readRfc64PrivateRosterVersionV1')
      .mockImplementationOnce(async () => {
        staleVersionEntered();
        await staleVersionGate;
        return '1';
      })
      .mockResolvedValueOnce('2');
    vi.spyOn(curator, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
      .mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));

    const staleRefresh = curator.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId);
    await staleVersionRead;
    const currentAuthority = await curator.reconcileRfc64CatalogAccessAuthorityV1(
      contextGraphId,
    );
    expect(currentAuthority).toMatchObject({ roster: { version: '2' } });
    expect(curator.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    releaseStaleVersion();
    await expect(staleRefresh).resolves.toBeNull();
    expect((curator as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      contextGraphId,
    )?.roster).toMatchObject({
      version: '2',
      members: [{ agentAddress: AUTHOR, roles: ['holder', 'provider'] }],
    });
    expect(curator.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    expect(curator.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    await expect(curator.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({
        contextGraphId,
        authorityState: 'accepted',
        policyDigest: currentAuthority?.policyDigest,
        stableReason: null,
      }),
    );
  });

  it('reconciles private responsibility when refreshed ACL facts change without a subscription transition', async () => {
    const contextGraphId = `${AUTHOR}/private-acl-refresh`;
    const edge = await startAgent({ name: 'private-acl-refresh' });
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('private');
    const hasMembership = vi.spyOn(edge, 'hasRfc64VerifiedPrivateMembershipV1')
      .mockResolvedValue(false);
    vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(true);
    vi.spyOn(edge.store, 'query').mockResolvedValue({
      type: 'bindings',
      bindings: [],
    });

    (edge as any).setContextGraphSubscription(contextGraphId, {
      subscribed: true,
      synced: true,
      metaSynced: true,
      onChainId: '3',
    }, { persist: false });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);

    // The curator projection now admits this local agent, but every canonical
    // subscription field is unchanged. Metadata completion itself must own the
    // responsibility refresh.
    hasMembership.mockResolvedValue(true);
    await (edge as any).refreshMetaSyncedFlags([contextGraphId]);

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'private-membership',
        active: true,
        mode: 'catalog',
      }),
    ]);
  });

  it('uses durable public hosting and preserves explicit disabled rollback', async () => {
    const coreContextGraphId = `${AUTHOR}/core-hosted-responsibility`;
    const core = await startAgent({
      name: 'core-hosted-responsibility',
      config: {
        nodeRole: 'core',
        rfc64CatalogActivation: { enabled: false },
      },
    });
    vi.spyOn(core, 'getExplicitAccessPolicy').mockResolvedValue('public');

    (core as any).setContextGraphSubscription(coreContextGraphId, {
      syncMode: 'always-on',
      subscribed: false,
      synced: false,
      coreHosted: true,
    });
    await core.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(core.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId: coreContextGraphId,
        responsibilityReason: 'core-public',
        active: true,
        mode: 'legacy',
        selectionSource: 'operator-override',
      }),
    ]);
  });

  it('lets unified rollback suppress deprecated selected-public runtime lanes', async () => {
    const edge = await startAgent({
      name: 'unified-rollback-suppresses-public-alias',
      activation: activation('catalog'),
      config: { rfc64CatalogActivation: { enabled: false } },
    });
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('public');
    await edge.reconcileRfc64CatalogResponsibilityV1(CONTEXT_GRAPH_ID);

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
      expect.objectContaining({
        contextGraphId: CONTEXT_GRAPH_ID,
        active: true,
        mode: 'legacy',
        selectionSource: 'operator-override',
      }),
    );
    expect((edge as any).config.rfc64CatalogExecutionPlan).toMatchObject({
      responsibilityDefaultMode: 'legacy',
      selectedAuthority: {},
      track2ContextGraphs: [],
      standaloneTrack2Enabled: false,
    });
    expect((edge as any).config.rfc64CatalogBootstrap).toBeUndefined();
    expect((edge as any).config.rfc64CatalogAuthoringPolicy).toBeUndefined();
    expect((edge as any).rfc64PublicCatalogServiceV1).toBeUndefined();
  });

  it('keeps an eligible edge CG dormant until subscribe and deactivates it on unsubscribe', async () => {
    const providerPeerId = '12D3KooWSubscriptionOwnedCatalogProvider';
    let synchronize!: ReturnType<typeof vi.spyOn>;
    const edge = await startAgent({
      name: 'subscription-owned-selection',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
          }],
        },
      },
      beforeStart: (agent) => {
        synchronize = vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
      },
      config: { syncContextGraphs: [] },
    });
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    const initialPass = edge.readRfc64PublicCatalogBootstrapStatusV1()?.pass ?? 0;

    expect(edge.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(edge.readRfc64CatalogRuntimeSelectionV1()).toEqual({
      subscriptionDriven: true,
      eligibleContextGraphs: [CONTEXT_GRAPH_ID],
      selectedContextGraphs: [],
    });
    expect(edge.rfc64PublicCatalogStatsV1()).toMatchObject({
      started: true,
      acceptedPolicies: 1,
    });
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'inactive',
      attempts: 0,
    });
    expect(synchronize).not.toHaveBeenCalled();

    // Sync-scope bookkeeping is not a subscription and cannot independently
    // activate RFC-64 receiver work.
    expect(edge.trackSyncContextGraph(CONTEXT_GRAPH_ID)).toBe(false);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(synchronize).not.toHaveBeenCalled();

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(edge.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs)
      .toEqual([CONTEXT_GRAPH_ID]);
    expect(edge.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(true);
    expect((edge as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.pass).toBeGreaterThan(initialPass);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'not-found',
      attempts: 1,
    });

    // An idempotent subscription cannot enqueue a duplicate invalidation.
    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(synchronize).toHaveBeenCalledTimes(1);

    edge.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(edge.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs).toEqual([]);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'inactive',
      attempts: 0,
    });
    expect(synchronize).toHaveBeenCalledTimes(1);

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(edge.deleteContextGraphSubscription(CONTEXT_GRAPH_ID)).toBe(true);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(edge.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs).toEqual([]);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'inactive',
      attempts: 0,
    });
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it('aborts a stale in-flight bootstrap pass and waits through the inactive rerun', async () => {
    const providerPeerId = '12D3KooWBlockedSubscriptionCatalogProvider';
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let firstSignal: AbortSignal | undefined;
    let synchronize!: ReturnType<typeof vi.spyOn>;
    const edge = await startAgent({
      name: 'subscription-transition-during-bootstrap',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
          }],
        },
      },
      beforeStart: (agent) => {
        synchronize = vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockImplementationOnce(async ({ signal }) => {
            firstSignal = signal;
            markEntered();
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return null;
          })
          .mockResolvedValue(null);
      },
      config: { syncContextGraphs: [] },
    });
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    const initialPass = edge.readRfc64PublicCatalogBootstrapStatusV1()?.pass ?? 0;

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await entered;
    edge.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(firstSignal?.aborted).toBe(true);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
      running: false,
      pass: initialPass + 2,
      targets: [expect.objectContaining({
        outcome: 'inactive',
        attempts: 0,
      })],
    });
  });

  it('retains manifest-wide RFC-64 selection on core nodes', async () => {
    const providerPeerId = '12D3KooWCoreManifestWideCatalogProvider';
    let synchronize!: ReturnType<typeof vi.spyOn>;
    let queueRecovery!: ReturnType<typeof vi.spyOn>;
    const core = await startAgent({
      name: 'core-manifest-selection',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
            completeSwmProviders: [providerPeerId],
          }],
        },
      },
      beforeStart: (agent) => {
        vi.spyOn(agent, 'connectToPeerId').mockResolvedValue();
        queueRecovery = vi.spyOn(
          agent,
          'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect',
        ).mockReturnValue(true);
        synchronize = vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
      },
      config: { nodeRole: 'core', syncContextGraphs: [] },
    });
    await core.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(core.readRfc64CatalogRuntimeSelectionV1()).toEqual({
      subscriptionDriven: false,
      eligibleContextGraphs: [CONTEXT_GRAPH_ID],
      selectedContextGraphs: [CONTEXT_GRAPH_ID],
    });
    expect(synchronize).toHaveBeenCalledWith(expect.objectContaining({
      remotePeerIds: [providerPeerId],
      scope: expect.objectContaining({
        authorAddress: AUTHOR,
        contextGraphId: CONTEXT_GRAPH_ID,
      }),
    }));
    const queuedRecoveryPasses = queueRecovery.mock.calls.length;
    expect(queuedRecoveryPasses).toBeGreaterThan(0);
    const lease = core.acquireRfc64SwmRecoveryTargetLeaseV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      lane: 'selected-public',
    });
    expect(lease.isCurrent()).toBe(true);
    expect(lease.signal.aborted).toBe(false);

    // An ordinary host-only transition cannot abort manifest-wide core work.
    const deactivate = vi.spyOn(
      (core as any).rfc64PublicCatalogServiceV1,
      'deactivateReceiverContextGraph',
    );
    core.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    core.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await core.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(deactivate).not.toHaveBeenCalled();
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(queueRecovery).toHaveBeenCalledTimes(queuedRecoveryPasses);
    expect(lease.isCurrent()).toBe(true);
    expect(lease.signal.aborted).toBe(false);
    expect(() => lease.assertCurrent()).not.toThrow();
  });

  it('enforces legacy, shadow, catalog, and kill-switch authority at startup', async () => {
    const legacy = await startAgent({ name: 'legacy', activation: activation('legacy') });
    expect(legacy.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    // The process-wide service remains ready for later default-selected CGs;
    // this explicit graph itself is fenced to the legacy lane.
    expect(legacy.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    expect(legacy.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID))
      .toMatchObject({ reconciliationLane: 'legacy', track2Enabled: false });

    const shadow = await startAgent({ name: 'shadow', activation: activation('shadow') });
    expect(shadow.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(shadow.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });

    const catalog = await startAgent({ name: 'catalog', activation: activation('catalog') });
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(catalog.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect((catalog as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);

    const stopped = await startAgent({
      name: 'kill-switch',
      activation: {
        ...activation('catalog', true),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [],
            completeSwmProviders: ['12D3KooWKilledCompleteProvider'],
          }],
        },
      },
    });
    expect(stopped.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(stopped.rfc64PublicCatalogStatsV1()).toBeNull();
    expect(stopped.readRfc64PublicCatalogBootstrapStatusV1()).toBeNull();
    expect(stopped.resolveRfc64CompleteSwmProviderPeerIdsV1(CONTEXT_GRAPH_ID))
      .toEqual([]);
    expect(stopped.resolveActiveRfc64SwmRecoveryPlanV1(
      '12D3KooWKilledCompleteProvider',
    ).targets).toEqual([]);
    vi.spyOn(stopped, 'canUseSharedMemoryForContextGraph').mockResolvedValue(true);
    await expect(stopped.planSharedMemorySyncContextGraphs(
      '12D3KooWAdmittedOrdinaryFallbackPeer',
      [CONTEXT_GRAPH_ID],
      createOperationContext('sync'),
    )).resolves.toEqual({
      targets: [{ contextGraphId: CONTEXT_GRAPH_ID, lane: 'selected-public' }],
    });
  });

  it('keeps the compatibility start dormant until RFC-64 persistence opens', async () => {
    const agent = await startAgent({
      name: 'compatibility-pre-persistence-start',
      beforeStart: (created) => {
        expect((created as any).rfc64PersistenceV1).toBeUndefined();
        created.startRfc64PublicCatalogServiceV1(createOperationContext('connect'));
        expect(created.rfc64PublicCatalogStatsV1()).toBeNull();
      },
    });

    expect(agent.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    agent.startRfc64PublicCatalogServiceV1(createOperationContext('connect'));
    expect(agent.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
  });

  it('retains catalog-mode member transport only for the named-subgraph compatibility lane', async () => {
    const catalog = await startAgent({
      name: 'catalog-metadata-refresh-fence',
      activation: activation('catalog'),
    });
    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);

    const internals = catalog as any;
    expect(catalog.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID)).toMatchObject({
      subscribed: true,
    });
    expect(internals.sharedMemoryGossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);

    // Catalog mode owns the root lane, but named subgraphs still require the
    // authorized member transport. queueSharedMemoryGossipSubscription remains
    // fire-and-forget, so capture the concrete reconciliation promise.
    vi.spyOn(catalog, 'hasConfirmedMetaState').mockResolvedValue(true);
    const memberAuthority = vi.spyOn(catalog, 'canUseSharedMemoryForContextGraph')
      .mockResolvedValue(true);
    const reconciliations: Promise<void>[] = [];
    const reconcile = catalog.reconcileSharedMemoryGossipSubscription.bind(catalog);
    vi.spyOn(catalog, 'reconcileSharedMemoryGossipSubscription').mockImplementation((cg) => {
      const pending = reconcile(cg);
      reconciliations.push(pending);
      return pending;
    });

    await internals.refreshMetaSyncedFlags([CONTEXT_GRAPH_ID]);
    await vi.waitFor(() => expect(reconciliations).toHaveLength(1));
    await Promise.all(reconciliations);

    expect(catalog.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID)).toMatchObject({
      subscribed: true,
      metaSynced: true,
    });
    expect(memberAuthority).toHaveBeenCalledWith(CONTEXT_GRAPH_ID);
    expect(internals.sharedMemoryGossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(true);

    // A core's ordinary host reconciliation is another legacy entry point.
    // Make every non-RFC prerequisite available so catalog authority is the
    // reason it stays unwired.
    internals.swmHostModeStore = {};
    const curated = vi.spyOn(catalog, 'isCuratedForHostMode').mockResolvedValue(true);
    await catalog.reconcileSwmHostModeSubscription(CONTEXT_GRAPH_ID);
    const hostKey = catalog.canonicalSwmHostModeKey(CONTEXT_GRAPH_ID);
    expect(curated).not.toHaveBeenCalled();
    expect(internals.swmHostModeSubscribed.has(hostKey)).toBe(false);
    expect(internals.swmHostModeHandlers.has(hostKey)).toBe(false);
  });

  it('rehydrates persisted edge intent through exclusive catalog authority', async () => {
    const persisted = new Map<string, any>([[CONTEXT_GRAPH_ID, {
      id: CONTEXT_GRAPH_ID,
      name: 'persisted-before-rfc64',
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      coreHosted: false,
    }]]);
    const catalog = await startAgent({
      name: 'catalog-rehydration-fence',
      activation: activation('catalog'),
      config: {
        contextGraphSubscriptionStore: {
          loadAll: async () => [...persisted.values()],
          save: async (record) => { persisted.set(record.id, { ...record }); },
          delete: async (contextGraphId) => { persisted.delete(contextGraphId); },
        },
      },
    });
    expect(catalog.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(true);
    expect(catalog.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs)
      .toEqual([CONTEXT_GRAPH_ID]);
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect((catalog as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(catalog.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
      dormantIds: [],
    });
    expect(persisted.get(CONTEXT_GRAPH_ID)).toMatchObject({ subscribed: true });
  });

  it('keeps complete-provider recovery live when every selected CG is legacy-mode', async () => {
    const providerPeerId = '12D3KooWAllLegacyCompleteProvider';
    let connect!: ReturnType<typeof vi.spyOn>;
    let queue!: ReturnType<typeof vi.spyOn>;
    const legacy = await startAgent({
      name: 'all-legacy-provider',
      activation: {
        ...activation('legacy'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [],
            completeSwmProviders: [providerPeerId],
          }],
        },
      },
      beforeStart: (agent) => {
        connect = vi.spyOn(agent, 'connectToPeerId').mockResolvedValue();
        queue = vi.spyOn(agent, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect')
          .mockReturnValue(true);
      },
    });
    await legacy.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(legacy.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
      pass: expect.any(Number),
      targets: [],
    });
    expect(connect).toHaveBeenCalledWith(providerPeerId, { timeoutMs: 10_000 });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ providerPeerId }),
      expect.any(Function),
      0,
    );
  });

  it.each(['legacy', 'shadow'] as const)(
    'semantically deactivates durable catalog authority before a %s restart',
    async (nextMode) => {
    const dataDir = await createDataDir('rollout-transition');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'catalog-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(81n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-restart-guard' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(applied).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    await seedCatalogSemanticClosure(author, seal, 'rollout-restart-guard');
    await expectCatalogSemanticClosure(
      author,
      seal,
      'rollout-restart-guard',
      true,
    );
    const producer = vi.spyOn(
      Rfc64PublicCatalogSuccessorProducerV1.prototype,
      'produceAndStageExactSet',
    );
    const restarted = await restartAgent(author, {
      name: `${nextMode}-after-catalog`,
      activation: activation(nextMode),
      dataDir,
      persistentStorePath,
    });
    expect(restarted.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
    await expectCatalogSemanticClosure(
      restarted,
      seal,
      'rollout-restart-guard',
      false,
    );
    expect(restarted.rfc64PublicCatalogStatsV1())
      .toEqual(expect.objectContaining({ started: true }));
    expect(producer).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('preserves locally authored shadow discovery state and legacy material on restart', async () => {
    const dataDir = await createDataDir('rollout-shadow-author');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'shadow-author-restart',
      activation: {
        ...activation('shadow'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(810n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'shadow-author-restart-guard' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(applied).not.toBeNull();
    // Shadow catalog publication accompanies existing legacy material; it does
    // not grant catalog semantic authority over that material.
    await seedCatalogSemanticClosure(author, seal, 'shadow-author-restart-guard');
    const restarted = await restartAgent(author, {
      name: 'shadow-author-restarted',
      activation: activation('shadow'),
      dataDir,
      persistentStorePath,
    });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ currentCatalogHeadDigest: applied?.currentCatalogHeadDigest });
    await expectCatalogSemanticClosure(
      restarted,
      seal,
      'shadow-author-restart-guard',
      true,
    );
  }, 30_000);

  it('preserves later legacy semantic content while relinquishing stale catalog authority', async () => {
    const dataDir = await createDataDir('rollout-divergent');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'catalog-divergent-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(85n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-divergent-preservation' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    await seedCatalogSemanticClosure(author, seal, 'rollout-divergent-preservation');
    const store = (author as unknown as { store: OxigraphStore }).store;
    const swmGraph = deriveRfc64PublicSwmGraphV1(CONTEXT_GRAPH_ID, seal.reservedKaId as never);
    await store.insert([{
      subject: 'https://example.org/later-legacy-write',
      predicate: 'https://schema.org/name',
      object: '"must survive"',
      graph: swmGraph,
    }]);
    const restarted = await restartAgent(author, {
      name: 'legacy-after-divergent-catalog',
      activation: activation('legacy'),
      dataDir,
      persistentStorePath,
    });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
    expect(applied).not.toBeNull();
    await expectCatalogSemanticClosure(
      restarted,
      seal,
      'rollout-divergent-preservation',
      true,
    );
    const preserved = await (restarted as unknown as { store: OxigraphStore }).store.query(
      `ASK { GRAPH <${swmGraph}> { <https://example.org/later-legacy-write> ?p ?o } }`,
    );
    expect(preserved).toEqual({ type: 'boolean', value: true });
  }, 30_000);

  it.each(['later semantic removal', 'inventory deletion'] as const)(
    'rolls back the whole CG after injected %s failure and retries cleanly',
    async (failureStage) => {
      const author = await startAgent({
        name: 'catalog-atomic-transition',
        activation: {
          ...activation('catalog'),
          autoPublish: {
            peers: [],
            catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
          },
        },
      });
      vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
      const seals = [await authorSeal(86n), await authorSeal(87n)] as const;
      for (const [index, seal] of seals.entries()) {
        await author.recordRfc64PublicCatalogAssetV1({
          contextGraphId: CONTEXT_GRAPH_ID,
          assertionCoordinate: `rollout-atomic-${index}` as never,
          publicQuads: PROJECTION_QUADS,
          seal: assertionSealFromCanonical(seal),
        });
        await seedCatalogSemanticClosure(author, seal, `rollout-atomic-${index}`);
      }
      const internals = author as unknown as {
        store: TripleStore;
        rfc64PersistenceV1: {
          controlObjects: Parameters<
            typeof prepareRfc64AppliedCatalogAuthorityDeactivationV1
          >[0]['controlObjects'];
          inventory: Parameters<
            typeof commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1
          >[0]['inventory'] & {
            listAppliedCatalogHeadsV1(): readonly any[];
          };
        };
      };
      const [appliedHead] = internals.rfc64PersistenceV1.inventory.listAppliedCatalogHeadsV1();
      expect(appliedHead).toBeDefined();
      const prepared = await prepareRfc64AppliedCatalogAuthorityDeactivationV1({
        store: internals.store,
        controlObjects: internals.rfc64PersistenceV1.controlObjects,
        appliedHead,
      });
      let semanticMutations = 0;
      const injectedStore = new Proxy(internals.store, {
        get(target, property, receiver) {
          if (property === 'replaceGraphAndSubject') {
            return async (...args: unknown[]) => {
              semanticMutations += 1;
              if (failureStage === 'later semantic removal' && semanticMutations === 2) {
                throw new Error('injected later semantic removal failure');
              }
              return (target.replaceGraphAndSubject as (...values: unknown[]) => unknown)
                .apply(target, args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const injectedInventory = failureStage === 'inventory deletion'
        ? { deleteAppliedCatalogHeadsV1: () => { throw new Error('injected inventory failure'); } }
        : internals.rfc64PersistenceV1.inventory;

      await expect(commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1({
        store: injectedStore,
        inventory: injectedInventory,
        prepared: [prepared],
      })).rejects.toThrow('catalog semantic authority deactivation failed');
      for (const [index, seal] of seals.entries()) {
        await expectCatalogSemanticClosure(author, seal, `rollout-atomic-${index}`, true);
      }
      expect(author.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: catalogScopeDigest(),
        authorAddress: AUTHOR,
      })).not.toBeNull();

      await commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1({
        store: internals.store,
        inventory: internals.rfc64PersistenceV1.inventory,
        prepared: [prepared],
      });
      for (const [index, seal] of seals.entries()) {
        await expectCatalogSemanticClosure(author, seal, `rollout-atomic-${index}`, false);
      }
      expect(author.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: catalogScopeDigest(),
        authorAddress: AUTHOR,
      })).toBeNull();
    },
    30_000,
  );

  it('pauses and resumes existing catalog authority without deleting it', async () => {
    const dataDir = await createDataDir('rollout-kill-switch');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'kill-switch-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(84n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'kill-switch-preservation' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(applied).not.toBeNull();
    await seedCatalogSemanticClosure(author, seal, 'kill-switch-preservation');
    await expectCatalogSemanticClosure(author, seal, 'kill-switch-preservation', true);
    const stopped = await restartAgent(author, {
      name: 'kill-switch-active',
      activation: activation('catalog', true),
      dataDir,
      persistentStorePath,
    });
    expect(stopped.rfc64PublicCatalogStatsV1()).toBeNull();
    expect(stopped.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(stopped.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ currentCatalogHeadDigest: applied?.currentCatalogHeadDigest });
    await expectCatalogSemanticClosure(stopped, seal, 'kill-switch-preservation', true);
    const resumed = await restartAgent(stopped, {
      name: 'kill-switch-cleared',
      activation: activation('catalog'),
      dataDir,
      persistentStorePath,
    });
    expect(resumed.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    expect(resumed.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(resumed.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ currentCatalogHeadDigest: applied?.currentCatalogHeadDigest });
    await expectCatalogSemanticClosure(resumed, seal, 'kill-switch-preservation', true);
  }, 30_000);

  it('retains durable catalog authority for pre-activation standalone controls', async () => {
    const dataDir = await createDataDir('rollout-standalone');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'standalone-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-standalone-compatibility' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(83n)),
    });
    expect(applied).not.toBeNull();
    const restarted = await restartAgent(author, {
      name: 'standalone-compatibility',
      dataDir,
      persistentStorePath,
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        rfc64PublicCatalogBootstrap: {
          acceptedPublicPolicies: [{ policyEnvelope: policyEnvelope(), targets: [] }],
        },
      },
    });
    expect(restarted.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: applied?.currentCatalogHeadDigest,
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
  }, 30_000);

  it('cold-bootstraps a valid shadow head as staged-only with no applied head', async () => {
    const author = await startAgent({
      name: 'shadow-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const published = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-shadow-bootstrap' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(82n)),
    });
    const shadow = await startAgent({
      name: 'shadow-receiver',
      activation: {
        ...activation('shadow'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [author.peerId] }],
          }],
        },
      },
    });
    await connectBothWays(author, shadow);
    await vi.waitFor(() => {
      expect(shadow.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        mode: 'shadow',
        outcome: 'shadow-staged',
        stagedHeadDigest: published?.currentCatalogHeadDigest,
        appliedHeadDigest: null,
      });
    }, { timeout: 20_000, interval: 100 });
    expect(shadow.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 30_000);
});

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  const address = (agent: DKGAgent) => {
    const tcp = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
    if (tcp === undefined) throw new Error('agent has no TCP multiaddr');
    return tcp;
  };
  await a.node.libp2p.dial(multiaddr(address(b)));
  await b.node.libp2p.dial(multiaddr(address(a)));
}

async function expectCatalogSemanticClosure(
  agent: DKGAgent,
  seal: CanonicalGraphScopedAuthorSealV1,
  assertionCoordinate: string,
  present: boolean,
): Promise<void> {
  const swmGraph = deriveRfc64PublicSwmGraphV1(
    CONTEXT_GRAPH_ID,
    seal.reservedKaId as never,
  );
  const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1({
    contextGraphId: CONTEXT_GRAPH_ID,
    subGraphName: null,
    authorAddress: AUTHOR,
    assertionCoordinate: assertionCoordinate as never,
  });
  const store = (agent as unknown as { store: OxigraphStore }).store;
  await expect(store.hasGraph(swmGraph)).resolves.toBe(present);
  const sealRows = await store.query(
    `SELECT ?p ?o WHERE { GRAPH <${placement.metaGraph}> { `
      + `<${placement.subject}> ?p ?o } } LIMIT 1`,
  );
  expect(sealRows.type).toBe('bindings');
  if (sealRows.type !== 'bindings') throw new Error('expected seal bindings');
  expect(sealRows.bindings.length > 0).toBe(present);
}

async function seedCatalogSemanticClosure(
  agent: DKGAgent,
  seal: CanonicalGraphScopedAuthorSealV1,
  assertionCoordinate: string,
): Promise<void> {
  const swmGraph = deriveRfc64PublicSwmGraphV1(
    CONTEXT_GRAPH_ID,
    seal.reservedKaId as never,
  );
  const store = (agent as unknown as { store: OxigraphStore }).store;
  await store.insert([
    ...PROJECTION_QUADS.map((quad) => ({ ...quad, graph: swmGraph })),
    ...projectCanonicalGraphScopedAuthorSealRowsV1(seal, {
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      assertionCoordinate: assertionCoordinate as never,
    }),
  ]);
}

function catalogScopeDigest() {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0' as never,
    bucketCount: '1' as never,
  });
}

async function authorSeal(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const assertionMerkleRoot = ethers.hexlify(
    computeFlatKCRootV10([...PROJECTION_QUADS], []),
  ) as Digest32V1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: String(PROJECTION_QUADS.length),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function assertionSealFromCanonical(seal: CanonicalGraphScopedAuthorSealV1): AssertionSeal {
  return {
    merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
    authorAddress: seal.authorAddress,
    authorAttestationR: ethers.getBytes(seal.authorAttestationR),
    authorAttestationVS: ethers.getBytes(seal.authorAttestationVS),
    authorSchemeVersion: 1,
    chainId: BigInt(seal.assertedAtChainId),
    kav10Address: seal.assertedAtKav10Address,
    reservedKaId: BigInt(seal.reservedKaId),
    finalizedAtIso: seal.assertionFinalizedAt,
    contentScopeVersion: 2,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    publicTripleCount: Number(seal.publicTripleCount),
    privateTripleCount: Number(seal.privateTripleCount),
    rootEntities: [],
  };
}
