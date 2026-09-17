// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { multiaddr } from '@multiformats/multiaddr';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  contextGraphDataGraphUri,
  createOperationContext,
  DKG_ONTOLOGY,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  SYSTEM_CONTEXT_GRAPHS,
  type AssertionSeal,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import {
  NoChainAdapter,
  activeRpcRequestAbortSignal,
  createRpcRequestProvider,
  RpcRequestGovernor,
  RpcEndpointsExhaustedError,
  withRpcRequestContext,
  type ChainAdapter,
  type ContextGraphAuthorityIndexId,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import { Rfc64PublicCatalogSuccessorProducerV1 } from
  '../src/rfc64/public-catalog-successor-producer-v1.js';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from
  '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  '../src/rfc64/catalog-authority-config-v1.js';
import { isRfc64AuthorityRpcCircuitOpenErrorV1 } from
  '../src/rfc64/authority-rpc-circuit-breaker-v1.js';
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
const AUTHOR_CHAIN_CONFIG = Object.freeze({
  rpcUrl: 'http://127.0.0.1:1',
  hubAddress: '0x3333333333333333333333333333333333333333',
  operationalKeys: Object.freeze([AUTHOR_WALLET.privateKey]),
});

function custodialAuthorConfig(chainAdapter: ChainAdapter = new NoChainAdapter()) {
  return { chainAdapter, chainConfig: AUTHOR_CHAIN_CONFIG };
}

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
  it('preserves the caller lane for authority reads and lets foreground bypass cold-start jitter', async () => {
    let hits = 0;
    const rpc = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits += 1;
        if (hits === 1) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32005, message: 'rate limited' },
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }));
      });
    });
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
    const address = rpc.address() as AddressInfo;
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 50,
      burstRequests: 100,
      maxQueueSize: 8,
      startupJitterMs: 60_000,
    }, {
      clock: {
        now: () => Date.now(),
        random: () => 1,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });
    const provider = createRpcRequestProvider(
      `http://127.0.0.1:${address.port}`,
      {
        maxRetries: 1,
        providerOptions: { batchMaxCount: 1 },
        admission: governor,
      },
    );
    const edge = await startAgent({ name: 'authority-transport-background-lane' });
    vi.spyOn(edge, 'getContextGraphOnChainId').mockImplementation(async () => {
      await provider._send({
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
      });
      return null;
    });
    vi.spyOn(edge, 'getContextGraphOwner').mockResolvedValue(`did:dkg:agent:${AUTHOR}`);
    try {
      await expect(edge.readRfc64CurrentCuratorAuthorityBindingV1(CONTEXT_GRAPH_ID))
        .resolves.toMatchObject({ agentAddress: AUTHOR });
      expect(hits).toBe(2);
      expect(governor.snapshot()).toMatchObject({
        backgroundAdmitted: 0,
        foregroundAdmitted: 2,
        backgroundQueued: 0,
      });
    } finally {
      provider.destroy();
      await new Promise<void>((resolve, reject) => {
        rpc.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('runs the production scheduled authority revision read in the background lane with its owner signal', async () => {
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 50,
      burstRequests: 100,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    let observedSignal: AbortSignal | undefined;
    const readRevisions = vi.fn(async (
      _contextGraphIds: readonly string[],
      options?: { signal?: AbortSignal },
    ) => {
      observedSignal = options?.signal;
      await governor.acquireActiveRequest();
      return new Map([['9', `0x${'ab'.repeat(32)}`]]);
    });
    const { edge, runtime } = await prepareAuthorityRefreshLifecycle(readRevisions);
    const subscription = edge.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID);
    expect(subscription).toBeDefined();
    (edge as any).bindSubscriptionOnChainId(CONTEXT_GRAPH_ID, subscription, '9');
    try {
      runtime.start(createOperationContext('system'));
      await runtime.whenIdle();
      // Scheduled responsibility batching settles before the refresh owner starts,
      // so startup needs only the owner's initial revision read.
      expect(readRevisions).toHaveBeenCalledOnce();
      expect(readRevisions).toHaveBeenCalledWith(['9'], {
        signal: expect.any(AbortSignal),
      });
      expect(observedSignal?.aborted).toBe(false);
      expect(governor.snapshot()).toMatchObject({
        backgroundAdmitted: 1,
        foregroundAdmitted: 0,
      });
    } finally {
      await runtime.close();
    }
  });

  it('cancels a queued auto-publish authority read at the observer boundary without HTTP or warnings', async () => {
    let hits = 0;
    const rpc = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }));
      });
    });
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
    const address = rpc.address() as AddressInfo;
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 60_000,
    }, {
      clock: {
        now: () => Date.now(),
        random: () => 1,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });
    const provider = createRpcRequestProvider(
      `http://127.0.0.1:${address.port}`,
      {
        maxRetries: 0,
        providerOptions: { batchMaxCount: 1 },
        admission: governor,
      },
    );
    const edge = await startAgent({
      name: 'auto-publish-observer-local-cancellation',
    });
    await edge.createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Auto-publish observer local cancellation',
      callerAgentAddress: AUTHOR,
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    const warn = vi.spyOn((edge as any).log, 'warn');
    vi.spyOn(edge, 'recordRfc64SwmAuthorInventoryShadowV1').mockResolvedValue({
      status: 'dormant',
      action: 'upsert',
      attempts: 0,
      headObjectDigest: null,
      error: null,
      dormantReason: 'inactive-lane',
    });
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('public');
    vi.spyOn(edge, 'resolveRfc64AcceptedCompatibilityAuthorityV1').mockReturnValue(null);
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(edge, 'reconcileRfc64CatalogAccessAuthorityV1')
      .mockImplementation(async (_contextGraphId, signal) => {
        observedSignal = signal;
        await provider._send({
          id: 1,
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
        });
        return null;
      });

    try {
      const observer = edge.observeRfc64DurableSwmPromotionV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        assertionCoordinate: 'observer-local-cancellation',
        lifecycleAgentAddress: AUTHOR,
        shareOperationId: 'observer-local-cancellation-operation',
        ctx: createOperationContext('share'),
      });
      await vi.waitFor(() => {
        expect(governor.snapshot()).toMatchObject({
          backgroundQueued: 1,
          foregroundQueued: 0,
          foregroundAdmitted: 0,
          backgroundAdmitted: 0,
        });
      });
      expect(observedSignal?.aborted).toBe(false);

      await edge.closeRfc64SwmInventoryObserversV1();
      await expect(observer).resolves.toBeUndefined();

      expect(observedSignal?.aborted).toBe(true);
      expect(governor.snapshot()).toMatchObject({
        backgroundQueued: 0,
        cancelled: 1,
        foregroundAdmitted: 0,
        backgroundAdmitted: 0,
      });
      expect(hits).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      expect((edge as any).rfc64BackgroundWorkDispatcherV1.shutdownSignal.aborted)
        .toBe(false);
      await expect((edge as any).rfc64BackgroundWorkDispatcherV1.runAwaited(
        async () => 'still-open',
      )).resolves.toBe('still-open');
    } finally {
      provider.destroy();
      await edge.stop();
      await new Promise<void>((resolve, reject) => {
        rpc.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('cancels and drains queued scheduled responsibility RPC admission on agent shutdown', async () => {
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 60_000,
    }, {
      clock: {
        now: () => Date.now(),
        random: () => 1,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });
    const edge = await startAgent({
      name: 'scheduled-responsibility-shutdown-drain',
      activation: activation('catalog'),
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockImplementation(async () => {
      await governor.acquireActiveRequest();
      return 'public';
    });

    // Keep a real active subscription in the batch. A missing subscription is
    // terminal local state and is intentionally removed synchronously before
    // any RPC admission, which would make this shutdown test a false pass.
    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await vi.waitFor(() => {
      expect(governor.snapshot().backgroundQueued).toBe(1);
    });
    await expect(edge.stop()).resolves.toBeUndefined();
    expect(governor.snapshot()).toMatchObject({
      backgroundQueued: 0,
      cancelled: 1,
      backgroundAdmitted: 0,
    });
  });

  it('keeps awaited responsibility reconciliation in the foreground lane at cold start', async () => {
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 50,
      burstRequests: 100,
      maxQueueSize: 8,
      startupJitterMs: 60_000,
    }, {
      clock: {
        now: () => Date.now(),
        random: () => 1,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });
    const edge = await startAgent({
      name: 'foreground-responsibility-reconcile',
      activation: activation('catalog'),
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockImplementation(async () => {
      await governor.acquireActiveRequest();
      return 'public';
    });

    await expect(edge.reconcileRfc64CatalogResponsibilityV1(CONTEXT_GRAPH_ID))
      .resolves.toMatchObject({ contextGraphId: CONTEXT_GRAPH_ID });
    expect(governor.snapshot()).toMatchObject({
      foregroundAdmitted: 1,
      backgroundAdmitted: 0,
      backgroundQueued: 0,
    });
  });

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
    // Unreachable providers say nothing about this node's applied rows: they
    // stay visible as retried provider failures, never as CG incompleteness.
    await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({
        contextGraphId: CONTEXT_GRAPH_ID,
        phase: 'bootstrapping',
        stableReason: null,
        providerHealth: expect.objectContaining({ unresolvedReplayPeers: 2 }),
      }),
    );
  });

  it('retries an unresolved provider during a later scoped peer replay', async () => {
    const edge = await startAgent({
      name: 'replay-preserves-unresolved-provider',
      activation: activation('catalog'),
    });
    const failedPeer = '12D3KooWReplayPreviouslyFailedProvider';
    const newPeer = '12D3KooWReplayLaterConnectedProvider';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => failedPeer },
    ] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockRejectedValue(new Rfc64PublicCatalogTransportErrorV1(
        'catalog-transport-wire',
        'provider temporarily unreachable',
      ));

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 0, failed: 1 });
    await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({
        contextGraphId: CONTEXT_GRAPH_ID,
        phase: 'bootstrapping',
        stableReason: null,
        providerHealth: expect.objectContaining({ unresolvedReplayPeers: 1 }),
      }),
    );

    requestReplay.mockClear();
    requestReplay.mockResolvedValue(Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
      heads: Object.freeze([]),
    }));
    expect(edge.markRfc64CatalogReplayPeerPendingV1(
      CONTEXT_GRAPH_ID,
      newPeer,
    )).not.toBeNull();

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 2, failed: 0 });
    expect(new Set(requestReplay.mock.calls.map(
      ([{ remotePeerId }]: [{ remotePeerId: string }]) => remotePeerId,
    ))).toEqual(new Set([failedPeer, newPeer]));
    const [recoveredStatus] = await edge.readRfc64CatalogOperationalStatusV1();
    expect(recoveredStatus?.stableReason).not.toBe('catalog-replay-incomplete');
    expect(recoveredStatus?.providerHealth.unresolvedReplayPeers).toBe(0);
  });

  it('bounds unresolved provider attribution and retains an aggregate churn witness', async () => {
    const edge = await startAgent({
      name: 'replay-bounded-unresolved-provider-churn',
      activation: activation('catalog'),
    });
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockRejectedValue(new Rfc64PublicCatalogTransportErrorV1(
        'catalog-transport-wire',
        'provider unreachable during churn',
      ));
    const queueGeneration = (generation: number): void => {
      for (let index = 0; index < 64; index += 1) {
        expect(edge.markRfc64CatalogReplayPeerPendingV1(
          CONTEXT_GRAPH_ID,
          `12D3KooWReplayFailedGeneration${generation}Peer${index}`,
        )).not.toBeNull();
      }
    };

    queueGeneration(0);
    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 0, failed: 64 });
    queueGeneration(1);
    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 0, failed: 64 });

    requestReplay.mockClear();
    requestReplay.mockResolvedValue(Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
      heads: Object.freeze([]),
    }));
    expect(edge.markRfc64CatalogReplayPeerPendingV1(
      CONTEXT_GRAPH_ID,
      '12D3KooWReplayFailedGenerationRecoveryPeer',
    )).not.toBeNull();
    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 64, failed: 0 });
    expect(requestReplay).toHaveBeenCalledTimes(64);
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
    expect(markPending.mock.invocationCallOrder[0]).toBeLessThan(
      admission.mock.invocationCallOrder[0]!,
    );
    await vi.waitFor(async () => {
      await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
        expect.objectContaining({ contextGraphId: CONTEXT_GRAPH_ID, phase: 'bootstrapping' }),
      );
    });
    expect(requestReplay).not.toHaveBeenCalled();
  }, 15_000);

  it('clears the matching connection replay generation when admission probing fails', async () => {
    const peer = await startAgent({ name: 'replay-failed-admission-peer' });
    const edge = await startAgent({
      name: 'replay-failed-admission-edge',
      activation: activation('catalog'),
    });
    vi.spyOn(
      (edge as any).networkAdmissionCoordinator,
      'ensureAdmitted',
    ).mockRejectedValue(new Error('admission transport unavailable'));
    const markPending = vi.spyOn(edge, 'markRfc64CatalogReplayPeerPendingV1');
    edge.node.libp2p.dispatchEvent(new CustomEvent('connection:open', {
      detail: {
        remotePeer: peer.node.libp2p.peerId,
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1' },
        direction: 'inbound',
        timeline: { open: Date.now() },
      },
    } as any));
    expect(markPending).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, peer.peerId);
    await vi.waitFor(async () => {
      await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
        expect.objectContaining({ contextGraphId: CONTEXT_GRAPH_ID, phase: 'bootstrapping' }),
      );
    });
  }, 15_000);

  it('retries replay immediately when an admission failure is followed by reconnect', async () => {
    const peer = await startAgent({ name: 'replay-admission-retry-peer' });
    const edge = await startAgent({
      name: 'replay-admission-retry-edge',
      activation: activation('catalog'),
    });
    const admission = vi.spyOn(
      (edge as any).networkAdmissionCoordinator,
      'ensureAdmitted',
    )
      .mockRejectedValueOnce(new Error('admission transport unavailable'))
      .mockResolvedValue(true);
    vi.spyOn(edge as any, 'enrichPeerStoreFromInboundCircuit')
      .mockResolvedValue(undefined);
    vi.spyOn(edge as any, 'drainPendingSenderKeyForPeer')
      .mockResolvedValue(0);
    const warn = vi.spyOn((edge as any).log, 'warn');
    const markPending = vi.spyOn(edge, 'markRfc64CatalogReplayPeerPendingV1');
    const replay = vi.spyOn(Rfc64CatalogReplayRecoveryRuntimeV1.prototype, 'request')
      .mockResolvedValue(Object.freeze({ requested: 1, failed: 0 }));
    vi.spyOn(edge, 'reannounceRfc64CatalogHeadsToPeerV1')
      .mockResolvedValue(Object.freeze({ announced: 0, failed: 0, manifest: Object.freeze([]) }));
    const event = () => new CustomEvent('connection:open', {
      detail: {
        remotePeer: peer.node.libp2p.peerId,
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1' },
        direction: 'inbound',
        timeline: { open: Date.now() },
      },
    } as any);

    edge.node.libp2p.dispatchEvent(event());
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Network admission probe failed'),
    ));
    edge.node.libp2p.dispatchEvent(event());

    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    expect(admission).toHaveBeenCalledTimes(2);
    expect(markPending).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('coalesces protocol-dial connection churn into one scoped replay pass', async () => {
    const edge = await startAgent({
      name: 'replay-protocol-dial-connection-debounce',
      activation: activation('catalog'),
    });
    const peerId = '12D3KooWReplayProtocolDialConnectionPeer';
    const remotePeer = { toString: () => peerId };
    vi.spyOn(
      (edge as any).networkAdmissionCoordinator,
      'ensureAdmitted',
    ).mockResolvedValue(true);
    vi.spyOn(edge as any, 'enrichPeerStoreFromInboundCircuit')
      .mockResolvedValue(undefined);
    vi.spyOn(edge as any, 'drainPendingSenderKeyForPeer')
      .mockResolvedValue(0);
    const markPending = vi.spyOn(edge, 'markRfc64CatalogReplayPeerPendingV1');
    const replay = vi.spyOn(Rfc64CatalogReplayRecoveryRuntimeV1.prototype, 'request')
      .mockResolvedValue(Object.freeze({ requested: 1, failed: 0 }));
    const reannounce = vi.spyOn(edge, 'reannounceRfc64CatalogHeadsToPeerV1')
      .mockResolvedValue(Object.freeze({ announced: 0, failed: 0, manifest: Object.freeze([]) }));
    const event = () => new CustomEvent('connection:open', {
      detail: {
        remotePeer,
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1' },
        direction: 'outbound',
        timeline: { open: Date.now() },
      },
    } as any);

    edge.node.libp2p.dispatchEvent(event());
    edge.node.libp2p.dispatchEvent(event());

    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    expect(markPending).toHaveBeenCalledTimes(1);
    expect(markPending).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, peerId);
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId: CONTEXT_GRAPH_ID,
      kind: 'connection-demand',
      demand: expect.objectContaining({
        peerId,
        generation: expect.any(Number),
      }),
    }));
    expect(reannounce).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('debounces one live session but replays a genuine reconnect before time expiry', async () => {
    const edge = await startAgent({
      name: 'replay-connection-debounce-expiry',
      activation: activation('catalog'),
    });
    const peerId = '12D3KooWReplayDebounceBoundaryPeer';
    const remotePeer = { toString: () => peerId };
    const admission = vi.spyOn(
      (edge as any).networkAdmissionCoordinator,
      'ensureAdmitted',
    ).mockResolvedValue(true);
    vi.spyOn(edge as any, 'enrichPeerStoreFromInboundCircuit')
      .mockResolvedValue(undefined);
    vi.spyOn(edge as any, 'drainPendingSenderKeyForPeer')
      .mockResolvedValue(0);
    const markPending = vi.spyOn(edge, 'markRfc64CatalogReplayPeerPendingV1');
    let providerHead = 'head-v1';
    const replayedHeads: string[] = [];
    const replay = vi.spyOn(Rfc64CatalogReplayRecoveryRuntimeV1.prototype, 'request')
      .mockImplementation(async () => {
        replayedHeads.push(providerHead);
        return Object.freeze({ requested: 1, failed: 0 });
      });
    vi.spyOn(edge, 'reannounceRfc64CatalogHeadsToPeerV1')
      .mockResolvedValue(Object.freeze({ announced: 0, failed: 0, manifest: Object.freeze([]) }));
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const event = () => new CustomEvent('connection:open', {
      detail: {
        remotePeer,
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1' },
        direction: 'outbound',
        timeline: { open: Date.now() },
      },
    } as any);

    edge.node.libp2p.dispatchEvent(event());
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));

    now.mockReturnValue(109_999);
    edge.node.libp2p.dispatchEvent(event());
    await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(2));
    expect(replay).toHaveBeenCalledTimes(1);

    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([] as never);
    now.mockReturnValue(110_000);
    edge.node.libp2p.dispatchEvent(new CustomEvent('connection:close', {
      detail: {
        remotePeer,
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1' },
        timeline: { open: 100_000, close: 110_000 },
      },
    } as any));
    providerHead = 'head-v2';
    now.mockReturnValue(110_001);
    edge.node.libp2p.dispatchEvent(event());
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
    expect(markPending).toHaveBeenCalledTimes(2);
    expect(replayedHeads).toEqual(['head-v1', 'head-v2']);
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

  it('discards the replay snapshot cache at the mutation-persistence close boundary', async () => {
    const { provider, persistence } = await startAppliedOpenReplayProvider(
      'replay-snapshot-lifecycle-reset',
    );
    let readHeadCalls = 0;
    const getVerifiedObjectByDigest = persistence.controlObjects
      .getVerifiedObjectByDigest.bind(persistence.controlObjects);
    const lifecyclePersistence = Object.freeze({
      ...persistence,
      controlObjects: Object.freeze({
        ...persistence.controlObjects,
        getVerifiedObjectByDigest: async (
          ...args: Parameters<typeof getVerifiedObjectByDigest>
        ) => {
            readHeadCalls += 1;
            return getVerifiedObjectByDigest(...args);
        },
      }),
    });
    (provider as any).rfc64PersistenceV1 = lifecyclePersistence;
    vi.spyOn((provider as any).router, 'send').mockResolvedValue(Uint8Array.of(1));

    await expect(provider.reannounceRfc64CatalogHeadsToPeerV1(
      '12D3KooWReplaySnapshotFirstLifecycle',
    )).resolves.toMatchObject({ announced: 1, failed: 0 });
    expect(readHeadCalls).toBe(1);

    await provider.closeRfc64PublicCatalogMutationPersistenceV1();
    (provider as any).rfc64CatalogMutationCoordinatorV1.reopen();
    provider.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });

    await expect(provider.reannounceRfc64CatalogHeadsToPeerV1(
      '12D3KooWReplaySnapshotReopenedLifecycle',
    )).resolves.toMatchObject({ announced: 1, failed: 0 });
    expect(readHeadCalls).toBe(2);
  });

  it('refreshes scoped provider replay after its head advances while the scope lock waits', async () => {
    const { provider, persistence, publication, scope, applied } =
      await startAppliedOpenReplayProvider('scoped-replay-lock-race');
    const successor = await provider.publishOpenAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: publication.headObjectDigest,
        signatureVariantDigest: publication.signatureVariantDigest,
      },
      author: Object.freeze({
        address: AUTHOR,
        signMessage: (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
      }),
      catalogIssuerAuthorization: publication.catalogIssuerAuthorization,
      assets: [{
        assertionCoordinate: 'scoped-replay-lock-race' as never,
        projectionBytes: encodeCanonicalCgSharedPublicRootProjectionV1(PROJECTION_QUADS),
        seal: await authorSeal(91n),
      }],
      deployment: DEPLOYMENT,
      issuedAt: '1773900000001' as TimestampMsV1,
      peers: [],
    });
    const [successorAsset] = successor.assets;
    if (successorAsset === undefined) throw new Error('successor has no asset evidence');

    const coordinator = (provider as any).rfc64CatalogMutationCoordinatorV1;
    let releaseScope!: () => void;
    let markScopeEntered!: () => void;
    const scopeGate = new Promise<void>((resolve) => { releaseScope = resolve; });
    const scopeEntered = new Promise<void>((resolve) => { markScopeEntered = resolve; });
    const heldScope = coordinator.run(scope, async () => {
      markScopeEntered();
      await scopeGate;
    });
    await scopeEntered;

    const runMany = vi.spyOn(coordinator, 'runMany');
    const send = vi.spyOn((provider as any).router, 'send')
      .mockResolvedValue(Uint8Array.of(1));
    const replay = provider.reannounceRfc64CatalogHeadsToPeerV1(
      '12D3KooWScopedReplayLockRacePeer',
      Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        policyDigest: publication.announcement.policyDigest,
      }),
    );
    try {
      await vi.waitFor(() => expect(runMany).toHaveBeenCalledTimes(1));
      persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
        ...applied,
        expectedCurrentCatalogHeadDigest: applied.currentCatalogHeadDigest,
        currentCatalogHeadDigest: successor.headObjectDigest,
        appliedInventoryDigest: computeRfc64AppliedInventoryDigestV1({
          catalogScopeDigest: successor.catalogScopeDigest,
          rows: [successorAsset],
        }),
        catalogVersion: successor.announcement.catalogVersion,
        inventoryRowCount: successor.inventoryRowCount,
      });
    } finally {
      releaseScope();
    }
    await heldScope;

    await expect(replay).resolves.toMatchObject({
      announced: 1,
      failed: 0,
      manifest: [{ catalogHeadObjectDigest: successor.headObjectDigest }],
    });
    const sentAnnouncements = send.mock.calls
      .filter(([, protocolId]) => protocolId === RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1)
      .map(([, , data]) => parseRfc64PublicCatalogHeadAnnouncementV1(data));
    expect(sentAnnouncements).toMatchObject([
      { catalogHeadObjectDigest: successor.headObjectDigest },
    ]);
  });

  it('rejects provider replay when durable inventory changes during delivery', async () => {
    const { provider, persistence, applied } =
      await startAppliedOpenReplayProvider('replay-delivery-race');
    let releaseDelivery!: () => void;
    let markDeliveryEntered!: () => void;
    const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const deliveryEntered = new Promise<void>((resolve) => { markDeliveryEntered = resolve; });
    vi.spyOn((provider as any).router, 'send').mockImplementation(async () => {
      markDeliveryEntered();
      await deliveryGate;
      return Uint8Array.of(1);
    });

    const replay = provider.reannounceRfc64CatalogHeadsToPeerV1(
      '12D3KooWReplayDeliveryRacePeer',
    );
    await deliveryEntered;
    persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
      ...applied,
      expectedCurrentCatalogHeadDigest: applied.currentCatalogHeadDigest,
      currentCatalogHeadDigest: `0x${'cd'.repeat(32)}`,
      catalogVersion: '1',
    });
    releaseDelivery();

    await expect(replay).rejects.toThrow(/durable catalog inventory changed during replay/u);
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

  it('uses the deployment-profile namespace for accepted SWM authority without chain identity', async () => {
    const publicContextGraphId = `${AUTHOR}/profile-only-public` as ContextGraphIdV1;
    const privateContextGraphId = `${AUTHOR}/profile-only-private` as ContextGraphIdV1;
    const edge = await startAgent({
      name: 'profile-only-accepted-swm-authority',
      config: {
        ...custodialAuthorConfig(),
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          resolveRemoteAgentAddress: async () => null,
        },
      },
    });
    (edge as any).defaultAgentAddress = AUTHOR;
    await edge.createContextGraph({
      id: publicContextGraphId,
      name: 'Profile-only public',
      accessPolicy: 0,
      callerAgentAddress: AUTHOR,
    });
    await edge.createContextGraph({
      id: privateContextGraphId,
      name: 'Profile-only private',
      accessPolicy: 1,
      callerAgentAddress: AUTHOR,
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    await edge.reconcileRfc64CatalogAccessAuthorityV1(publicContextGraphId);
    await edge.reconcileRfc64CatalogAccessAuthorityV1(privateContextGraphId);
    Reflect.set((edge as any).config, 'networkIdentity', undefined);

    await expect(edge.canUseSharedMemoryForContextGraph(publicContextGraphId))
      .resolves.toBe(true);
    await expect(edge.canUseSharedMemoryForContextGraph(privateContextGraphId, {
      callerAgentAddress: AUTHOR,
    })).resolves.toBe(true);
    await expect(edge.canUseSharedMemoryForContextGraph(privateContextGraphId, {
      callerAgentAddress: NONMEMBER,
    })).resolves.toBe(false);
  });

  it('coalesces multiple authority acceptances into one freshness-bypassing peer catch-up', async () => {
    const contextGraphIds = [
      `${AUTHOR}/authority-catchup-a`,
      `${AUTHOR}/authority-catchup-b`,
    ] as const satisfies readonly ContextGraphIdV1[];
    const remotePeerId = '12D3KooWAuthorityCatchupPeer';
    const edge = await startAgent({
      name: 'authority-accepted-peer-catchup',
      config: {
        ...custodialAuthorConfig(),
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
      },
    });
    (edge as any).defaultAgentAddress = AUTHOR;
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => remotePeerId },
    ] as never);
    const queueSync = vi.spyOn(edge, 'queueSyncFromPeerOnConnect')
      .mockReturnValue(true);
    for (const [index, contextGraphId] of contextGraphIds.entries()) {
      await edge.createContextGraph({
        id: contextGraphId,
        name: `Authority catch-up ${index + 1}`,
        accessPolicy: 0,
        callerAgentAddress: AUTHOR,
      });
    }
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(queueSync).not.toHaveBeenCalled();

    // Context-graph creation exercises real libp2p/store lifecycle timers, so
    // keep this integration boundary on the real clock while observing the
    // production three-second authority catch-up window.
    await new Promise<void>((resolve) => setTimeout(resolve, 3_100));

    expect(queueSync).toHaveBeenCalledOnce();
    expect(queueSync).toHaveBeenCalledWith(
      remotePeerId,
      expect.any(Function),
      0,
      { authorityScopeChanged: true },
    );
    // Unchanged direct reconciliations must not create another timer.
    for (const contextGraphId of contextGraphIds) {
      await edge.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3_100));
    expect(queueSync).toHaveBeenCalledOnce();
  });

  it('fails closed when an unregistered graph has no authenticated owner', async () => {
    const contextGraphId = `${AUTHOR}/unresolved-owner` as ContextGraphIdV1;
    const edge = await startAgent({ name: 'unresolved-unregistered-owner' });
    (edge as any).defaultAgentAddress = AUTHOR;
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue(null);
    vi.spyOn(edge, 'getContextGraphOwner').mockResolvedValue(null);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('public');

    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId))
      .rejects.toMatchObject({ code: 'unregistered-owner-unresolved' });
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

  it('uses the finalized authority index for RFC-64 without changing the public resolver', async () => {
    const snapshot = Object.freeze({
      ...finalizedAuthoritySnapshot(CONTEXT_GRAPH_ID, [AUTHOR], '0'),
      accessPolicy: 0,
    });
    const chainAdapter = chainWithFinalizedAuthority(snapshot);
    const edge = await startAgent({
      name: 'registered-authority-finalized-name-index',
      config: { chainAdapter },
    });
    const resolveFinalized = vi.fn(async () => 9n);
    const resolveFinalizedSnapshot = vi.fn(async () => snapshot);
    Object.assign(chainAdapter, {
      resolveContextGraphIdByNameHash: vi.fn(async () => {
        throw new Error('public current-state resolver must not be used');
      }),
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdByNameHash: resolveFinalized,
        resolveFinalizedContextGraphAuthoritySnapshotByNameHash:
          resolveFinalizedSnapshot,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });

    await expect(edge.resolveFinalizedContextGraphAuthorityTargetV1(CONTEXT_GRAPH_ID))
      .resolves.toMatchObject({
        expectedNameHash: snapshot.nameHash,
        expectedOnChainId: 9n,
        finalizedSnapshot: snapshot,
      });
    await expect(edge.getContextGraphOnChainId(CONTEXT_GRAPH_ID))
      .resolves.toBeNull();

    await expect(edge.readRfc64CurrentCuratorAuthorityBindingV1(CONTEXT_GRAPH_ID))
      .resolves.toEqual({ agentAddress: AUTHOR, authorityEra: '0' });
    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID))
      .resolves.toMatchObject({ policy: { contextGraphId: CONTEXT_GRAPH_ID } });

    expect(resolveFinalized).not.toHaveBeenCalled();
    expect(resolveFinalizedSnapshot).toHaveBeenCalledTimes(3);
    expect(resolveFinalizedSnapshot).toHaveBeenCalledWith(
      snapshot.nameHash,
      expect.any(Object),
    );
    expect(chainAdapter.getContextGraphAuthoritySnapshot).not.toHaveBeenCalled();
    expect(chainAdapter.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('uses a durable binding directly while reverse-resolving only unbound names', async () => {
    const firstContextGraphId = `${AUTHOR}/atomic-refresh-a`;
    const secondContextGraphId = `${AUTHOR}/atomic-refresh-b`;
    const localFirstContextGraphId = `${AUTHOR}/atomic-refresh-local`;
    const firstSnapshot = Object.freeze({
      ...finalizedAuthoritySnapshot(firstContextGraphId, [AUTHOR], '0'),
      accessPolicy: 0,
    });
    const secondSnapshot = Object.freeze({
      ...finalizedAuthoritySnapshot(secondContextGraphId, [AUTHOR], '0'),
      contextGraphId: '10',
      accessPolicy: 0,
    });
    const resolveSnapshots = vi.fn(async (nameHashes: readonly string[]) => {
      if (nameHashes.includes(firstSnapshot.nameHash)) {
        throw new Error('durably bound duplicate name hash is ambiguous');
      }
      return new Map([[secondSnapshot.nameHash, secondSnapshot]]);
    });
    const resolveIds = vi.fn(async () => {
      throw new Error('atomic refresh must not reopen name-to-id resolution');
    });
    const readSnapshots = vi.fn(async (onChainIds: readonly string[]) => new Map(
      onChainIds.flatMap((onChainId) => {
        if (onChainId === '9') return [['9', firstSnapshot] as const];
        if (onChainId === '10') return [['10', secondSnapshot] as const];
        return [];
      }),
    ));
    const pointAuthorityRead = vi.fn(async () => {
      throw new Error('atomic refresh must not perform a point snapshot read');
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointAuthorityRead,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
        resolveFinalizedContextGraphIdsByNameHashes: resolveIds,
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'atomic-multi-name-authority-refresh',
      config: { chainAdapter },
    });
    edge.recordDiscoveredContextGraph(firstContextGraphId, {
      name: firstContextGraphId,
      onChainId: firstSnapshot.contextGraphId,
      onChainHash: firstSnapshot.nameHash,
    });
    vi.spyOn(edge, 'isLocalFirstUnregisteredContextGraph')
      .mockImplementation(async (contextGraphId) => (
        contextGraphId === localFirstContextGraphId
      ));

    const requests = await edge.createRfc64CatalogAuthorityRefreshRequestsV1(
      [firstContextGraphId, localFirstContextGraphId, secondContextGraphId],
      new AbortController().signal,
    );

    expect(resolveSnapshots).toHaveBeenCalledOnce();
    expect(resolveSnapshots).toHaveBeenCalledWith([
      secondSnapshot.nameHash,
    ], { signal: expect.any(AbortSignal) });
    expect(requests.get(firstContextGraphId)).toMatchObject({
      kind: 'finalized-evidence',
      evidence: {
        contextGraphAuthorityIndexId: '9',
        batchTargetIds: ['9'],
        snapshot: firstSnapshot,
      },
    });
    expect(requests.get(secondContextGraphId)).toMatchObject({
      kind: 'finalized-evidence',
      evidence: {
        contextGraphAuthorityIndexId: '10',
        batchTargetIds: ['10'],
        snapshot: secondSnapshot,
      },
    });
    expect(requests.get(localFirstContextGraphId)).toEqual({
      kind: 'finalized-absence',
    });
    expect(resolveIds).not.toHaveBeenCalled();
    expect(readSnapshots).toHaveBeenCalledOnce();
    expect(readSnapshots).toHaveBeenCalledWith(['9'], {
      signal: expect.any(AbortSignal),
    });
    expect(pointAuthorityRead).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'numeric slot',
      snapshotPatch: { contextGraphId: '80' },
    },
    {
      label: 'name commitment',
      snapshotPatch: { nameHash: `0x${'55'.repeat(32)}` },
    },
  ])('keeps conflicting bound $label evidence fail closed', async ({ snapshotPatch }) => {
    const contextGraphId = `${AUTHOR}/bound-conflicting-evidence`;
    const expectedNameHash = ethers.keccak256(
      ethers.toUtf8Bytes(contextGraphId),
    ).toLowerCase();
    const conflictingSnapshot = Object.freeze({
      ...finalizedAuthoritySnapshot(contextGraphId, [], '0'),
      contextGraphId: '79',
      accessPolicy: 0,
      nameHash: expectedNameHash,
      ...snapshotPatch,
    });
    const resolveSnapshots = vi.fn(async () => {
      throw new Error('bound target must not reverse-resolve an ambiguous name hash');
    });
    const readSnapshots = vi.fn(async (onChainIds: readonly string[]) => new Map(
      onChainIds.includes('79') ? [['79', conflictingSnapshot]] : [],
    ));
    const pointAuthorityRead = vi.fn(async () => {
      throw new Error('conflicting finalized evidence must not reopen a point read');
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointAuthorityRead,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'bound-conflicting-authority-evidence',
      config: { chainAdapter },
    });
    edge.recordDiscoveredContextGraph(contextGraphId, {
      name: contextGraphId,
      onChainId: '79',
      onChainHash: expectedNameHash,
    });
    const signal = new AbortController().signal;

    const request = (await edge.createRfc64CatalogAuthorityRefreshRequestsV1(
      [contextGraphId],
      signal,
    )).get(contextGraphId)!;

    expect(request).toMatchObject({
      kind: 'finalized-evidence',
      evidence: { contextGraphAuthorityIndexId: '79' },
    });
    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(
      contextGraphId,
      signal,
      request,
    )).rejects.toThrow();
    expect(edge.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      onChainId: '79',
      onChainHash: expectedNameHash,
    });
    expect(resolveSnapshots).not.toHaveBeenCalled();
    expect(readSnapshots).toHaveBeenCalledWith(['79'], {
      signal: expect.any(AbortSignal),
    });
    expect(pointAuthorityRead).not.toHaveBeenCalled();
  });

  it('shares provider-pool exhaustion across registered authority reconciliations', async () => {
    const readAuthority = vi.fn(async () => {
      throw new RpcEndpointsExhaustedError(
        'authority read failed on every provider',
        { exhaustionKind: 'mixed', retryAfterMs: 30_000 },
      );
    });
    const edge = await startAgent({
      name: 'registered-authority-shared-rpc-circuit',
      config: {
        chainAdapter: Object.assign(new NoChainAdapter(), {
          getContextGraphAuthoritySnapshot: readAuthority,
        }),
      },
    });
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue('9');

    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID))
      .rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(
      `${AUTHOR}/second-registered-authority` as ContextGraphIdV1,
    )).rejects.toSatisfy(isRfc64AuthorityRpcCircuitOpenErrorV1);

    expect(readAuthority).toHaveBeenCalledOnce();
    expect(readAuthority).toHaveBeenCalledWith(9n, {
      signal: expect.any(AbortSignal),
    });
  });

  it('accepts local unregistered authority while the shared RPC circuit is open', async () => {
    const contextGraphId = `${AUTHOR}/local-unregistered-open-circuit` as ContextGraphIdV1;
    const resolveContextGraphIdByNameHash = vi.fn(async () => {
      throw new Error('local unregistered authority must not query the CG registry');
    });
    const readAuthority = vi.fn(async () => {
      throw new Error('local unregistered authority must not read a chain snapshot');
    });
    const edge = await startAgent({
      name: 'local-unregistered-open-rpc-circuit',
      config: {
        chainAdapter: Object.assign(new NoChainAdapter(), {
          resolveContextGraphIdByNameHash,
          getContextGraphAuthoritySnapshot: readAuthority,
        }),
      },
    });
    await expect((edge as any).rfc64AuthorityReadCoordinatorV1.run(
      undefined,
      async () => {
        throw new RpcEndpointsExhaustedError(
          'unrelated registered authority exhausted every provider',
          { exhaustionKind: 'mixed', retryAfterMs: 30_000 },
        );
      },
    )).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    expect(edge.readRfc64AuthorityRpcCircuitSnapshotV1()).toMatchObject({ state: 'open' });
    const getContextGraphOnChainId = vi.spyOn(edge, 'getContextGraphOnChainId')
      .mockRejectedValue(new Error('local unregistered authority must not resolve a chain id'));

    await expect(edge.createContextGraph({
      id: contextGraphId,
      name: 'Local unregistered open circuit',
      callerAgentAddress: AUTHOR,
    })).resolves.toBeUndefined();
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId))
      .resolves.toMatchObject({
        policy: {
          contextGraphId,
          source: {
            kind: 'owner-signed-unregistered',
            ownerAddress: AUTHOR,
          },
        },
      });

    expect((edge as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      contextGraphId,
    )).toMatchObject({
      policy: {
        contextGraphId,
        source: {
          kind: 'owner-signed-unregistered',
          ownerAddress: AUTHOR,
        },
      },
    });
    expect(getContextGraphOnChainId).not.toHaveBeenCalled();
    expect(resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    expect(readAuthority).not.toHaveBeenCalled();
    expect(edge.readRfc64AuthorityRpcCircuitSnapshotV1()).toMatchObject({ state: 'open' });
  });

  it('propagates caller cancellation into the registered authority snapshot read', async () => {
    let readSignal: AbortSignal | undefined;
    const readAuthority = vi.fn(async (
      _contextGraphId: bigint,
      options?: { signal?: AbortSignal },
    ) => {
      readSignal = options?.signal;
      return Object.freeze({
        ...finalizedAuthoritySnapshot(CONTEXT_GRAPH_ID, [], '0'),
        accessPolicy: 0,
      });
    });
    const edge = await startAgent({
      name: 'registered-authority-signal-propagation',
      config: {
        chainAdapter: Object.assign(new NoChainAdapter(), {
          getContextGraphAuthoritySnapshot: readAuthority,
        }),
      },
    });
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue('9');
    const controller = new AbortController();

    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      controller.signal,
    )).resolves.toMatchObject({ policy: { contextGraphId: CONTEXT_GRAPH_ID } });
    expect(readSignal).toBeInstanceOf(AbortSignal);
    const reason = new Error('caller stopped');
    controller.abort(reason);
    expect(readSignal).toMatchObject({ aborted: true, reason });
  });

  it('propagates caller cancellation into the initial registered authority binding lookup', async () => {
    const readAuthority = vi.fn();
    const edge = await startAgent({
      name: 'registered-authority-binding-signal-propagation',
      config: {
        chainAdapter: Object.assign(new NoChainAdapter(), {
          getContextGraphAuthoritySnapshot: readAuthority,
        }),
      },
    });
    let lookupSignal: AbortSignal | undefined;
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    vi.spyOn(edge, 'getContextGraphOnChainId').mockImplementation(async (
      _contextGraphId,
      options,
    ) => {
      lookupSignal = options?.signal;
      markLookupStarted();
      await new Promise<never>((_resolve, reject) => {
        if (lookupSignal?.aborted) {
          reject(lookupSignal.reason);
          return;
        }
        lookupSignal?.addEventListener('abort', () => reject(lookupSignal!.reason), { once: true });
      });
      return null;
    });
    const controller = new AbortController();
    const operation = edge.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      controller.signal,
    );
    await lookupStarted;
    const reason = new Error('caller stopped during authority binding lookup');
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(lookupSignal).toMatchObject({ aborted: true, reason });
    expect(readAuthority).not.toHaveBeenCalled();
  });

  it('opens the shared circuit when cold numeric binding discovery exhausts providers', async () => {
    const readAuthority = vi.fn();
    const edge = await startAgent({
      name: 'registered-authority-id-discovery-circuit',
      config: {
        chainAdapter: Object.assign(new NoChainAdapter(), {
          getContextGraphAuthoritySnapshot: readAuthority,
        }),
      },
    });
    const resolveOnChainId = vi.spyOn(edge, 'getContextGraphOnChainId')
      .mockRejectedValue(new RpcEndpointsExhaustedError(
        'numeric context graph lookup exhausted every provider',
        { exhaustionKind: 'mixed', retryAfterMs: 30_000 },
      ));

    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID))
      .rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(
      `${AUTHOR}/second-cold-binding` as ContextGraphIdV1,
    )).rejects.toSatisfy(isRfc64AuthorityRpcCircuitOpenErrorV1);

    expect(resolveOnChainId).toHaveBeenCalledOnce();
    expect(readAuthority).not.toHaveBeenCalled();
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

  it('keeps an unlisted lifecycle responsibility legacy while one canary runs Track-2', async () => {
    const unlistedContextGraphId = `${AUTHOR}/bounded-default-unlisted` as ContextGraphIdV1;
    const edge = await startAgent({
      name: 'bounded-default-responsibility',
      config: {
        rfc64CatalogActivation: {
          rollout: {
            defaultMode: 'legacy',
            contextGraphModes: { [CONTEXT_GRAPH_ID]: 'shadow' },
          },
        },
      },
    });

    expect((edge as any).config.rfc64CatalogExecutionPlan).toMatchObject({
      responsibilityDefaultMode: 'legacy',
      contextGraphModes: { [CONTEXT_GRAPH_ID]: 'shadow' },
      track2ContextGraphs: [CONTEXT_GRAPH_ID],
    });
    expect(edge.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });

    await edge.createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Bounded RFC-64 canary',
      callerAgentAddress: AUTHOR,
    });
    await edge.createContextGraph({
      id: unlistedContextGraphId,
      name: 'Bounded RFC-64 unlisted control',
      callerAgentAddress: AUTHOR,
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contextGraphId: CONTEXT_GRAPH_ID,
        active: true,
        mode: 'shadow',
        selectionSource: 'operator-override',
      }),
      expect.objectContaining({
        contextGraphId: unlistedContextGraphId,
        active: true,
        mode: 'legacy',
        selectionSource: 'operator-override',
      }),
    ]));
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toHaveLength(2);
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID)).toMatchObject({
      mode: 'shadow',
      legacySyncAllowed: true,
      track2Enabled: true,
      reconciliationLane: 'shadow-stage',
    });
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(unlistedContextGraphId)).toMatchObject({
      mode: 'legacy',
      legacySyncAllowed: true,
      track2Enabled: false,
      reconciliationLane: 'legacy',
    });
    const shadowStatus = edge.readRfc64CatalogShadowExecutionStatusV1();
    expect(shadowStatus).toMatchObject({ contextGraphCount: 1 });
    expect(JSON.stringify(shadowStatus)).not.toContain(CONTEXT_GRAPH_ID);
    expect(JSON.stringify(shadowStatus)).not.toContain(unlistedContextGraphId);
  });

  it('reports a lifecycle responsibility inherited from a shadow default', async () => {
    const contextGraphId = `${AUTHOR}/default-shadow-responsibility` as ContextGraphIdV1;
    const edge = await startAgent({
      name: 'default-shadow-responsibility',
      config: {
        rfc64CatalogActivation: { rollout: { defaultMode: 'shadow' } },
      },
    });
    expect((edge as any).config.rfc64CatalogExecutionPlan.selectedAuthority).toEqual({});

    await edge.createContextGraph({
      id: contextGraphId,
      name: 'Default shadow responsibility',
      callerAgentAddress: AUTHOR,
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
      expect.objectContaining({ contextGraphId, mode: 'shadow' }),
    );
    const status = edge.readRfc64CatalogShadowExecutionStatusV1();
    expect(status).toMatchObject({ contextGraphCount: 1 });
    expect(JSON.stringify(status)).not.toContain(contextGraphId);
  });

  async function prepareAuthorityRefreshLifecycle(
    readRevisions?: (
      contextGraphIds: readonly string[],
      options?: { signal?: AbortSignal },
    ) => Promise<ReadonlyMap<string, string>>,
    whenRevisionReadsIdle: () => Promise<void> = async () => undefined,
  ) {
    const legacyContextGraphId = `${AUTHOR}/authority-refresh-legacy` as ContextGraphIdV1;
    const inactiveContextGraphId = `${AUTHOR}/authority-refresh-inactive` as ContextGraphIdV1;
    const authoritySnapshot = finalizedAuthoritySnapshot(CONTEXT_GRAPH_ID, [AUTHOR], '0');
    const chainAdapter = chainWithFinalizedAuthority(authoritySnapshot);
    if (readRevisions !== undefined) {
      Object.assign(chainAdapter, {
        contextGraphAuthorityIndexRevisionReader: {
          whenIdle: vi.fn(whenRevisionReadsIdle),
          readContextGraphAuthorityIndexRevisions: readRevisions,
        },
      });
    }
    const edge = await startAgent({
      name: 'authority-refresh-lifecycle',
      config: {
        ...custodialAuthorConfig(chainAdapter),
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

  it('retries superseded runtime refreshes and suppresses committed unchanged revisions', async () => {
    const revision = `0x${'ab'.repeat(32)}`;
    let holdNextRevisionRead = false;
    let markRevisionReadStarted!: () => void;
    let releaseRevisionRead!: () => void;
    const revisionReadStarted = new Promise<void>((resolve) => {
      markRevisionReadStarted = resolve;
    });
    const revisionReadGate = new Promise<void>((resolve) => {
      releaseRevisionRead = resolve;
    });
    const readRevisions = vi.fn(async () => {
      if (holdNextRevisionRead) {
        holdNextRevisionRead = false;
        markRevisionReadStarted();
        await revisionReadGate;
      }
      return new Map([['9', revision]]);
    });
    const { authoritySnapshot, edge, runtime } =
      await prepareAuthorityRefreshLifecycle(readRevisions);
    const subscription = edge.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID);
    expect(subscription).toBeDefined();
    // This test owns the refresh runtime directly after its lifecycle was
    // closed above. Seed its durable target without scheduling the separate
    // responsibility owner against that intentionally closed coordinator.
    (edge as any).contextGraphBindingState.bindAuthoritative(
      CONTEXT_GRAPH_ID,
      subscription,
      '9',
    );
    const reconcile = vi.spyOn(edge, 'reconcileRfc64CatalogAccessAuthorityV1')
      .mockResolvedValueOnce(null)
      .mockResolvedValue(authoritySnapshot as never);
    vi.useFakeTimers();
    try {
      holdNextRevisionRead = true;
      runtime.start(createOperationContext('system'));
      await revisionReadStarted;
      // Make the coalesced selection change explicit while the first selector
      // is physically in flight; relying on unrelated responsibility-owner
      // microtask ordering made this assertion scheduler-dependent.
      (edge as any).rfc64PublicCatalogOwnerV1.requestAuthorityRefresh();
      releaseRevisionRead();
      await runtime.whenIdle();
      // Runtime startup coalesces one responsibility update behind its initial
      // pass. The first result is superseded; the follow-up must therefore run
      // and commit instead of accepting the unchanged revision prematurely.
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledWith(
        CONTEXT_GRAPH_ID,
        expect.any(AbortSignal),
        { kind: 'auto' },
      );

      await vi.advanceTimersByTimeAsync(
        RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs,
      );
      await runtime.whenIdle();
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledWith(
        CONTEXT_GRAPH_ID,
        expect.any(AbortSignal),
        { kind: 'auto' },
      );
      await vi.advanceTimersByTimeAsync(
        RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs,
      );
      await runtime.whenIdle();
      // The fourth pass is the configured safety revalidation. It refreshes
      // unchanged authority before the four-interval freshness deadline.
      expect(reconcile).toHaveBeenCalledTimes(3);
      expect(readRevisions).toHaveBeenCalledTimes(4);
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

  it('keeps manifest-backed authority out of release-native runtime reconciliation', async () => {
    const edge = await startAgent({
      name: 'authority-refresh-manifest-bypass',
      activation: activation('catalog'),
      config: { nodeRole: 'core', syncContextGraphs: [] },
    });
    const runtime = (edge as unknown as {
      rfc64CatalogRuntimeV1: Rfc64CatalogRuntimeV1;
    }).rfc64CatalogRuntimeV1;
    expect((edge as any).config.rfc64CatalogExecutionPlan
      .selectedAuthority[CONTEXT_GRAPH_ID]).toBeDefined();
    await runtime.close();
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('public');
    (edge as any).setContextGraphSubscription(CONTEXT_GRAPH_ID, {
      syncMode: 'always-on',
      subscribed: false,
      synced: false,
      coreHosted: true,
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId: CONTEXT_GRAPH_ID,
        responsible: true,
        responsibilityReason: 'core-public',
      }),
    ]);
    const reconcile = vi.spyOn(edge, 'reconcileRfc64CatalogAccessAuthorityV1');
    vi.useFakeTimers();
    try {
      runtime.start(createOperationContext('system'));
      await runtime.whenIdle();
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
      const subscription = edge.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID);
      expect(subscription).toBeDefined();
      (edge as any).bindSubscriptionOnChainId(CONTEXT_GRAPH_ID, subscription, '9');
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

  it('drains a detached authority-index revision scan during public agent shutdown', async () => {
    let blockRevisionRead = false;
    let markRevisionReadStarted!: () => void;
    let releasePhysicalRead = () => undefined;
    const revisionReadStarted = new Promise<void>((resolve) => {
      markRevisionReadStarted = resolve;
    });
    const physicalRead = new Promise<void>((resolve) => {
      releasePhysicalRead = resolve;
    });
    const readRevisions = vi.fn(async (
      _contextGraphIds: readonly string[],
      options?: { signal?: AbortSignal },
    ): Promise<ReadonlyMap<string, string>> => {
      if (!blockRevisionRead) return new Map();
      markRevisionReadStarted();
      return new Promise((_, reject) => {
        const signal = options?.signal;
        if (signal === undefined) throw new Error('revision read signal is missing');
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const whenRevisionReadsIdle = vi.fn(async () => {
      if (blockRevisionRead) await physicalRead;
    });
    const { edge, runtime } = await prepareAuthorityRefreshLifecycle(
      readRevisions,
      whenRevisionReadsIdle,
    );

    const subscription = edge.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID);
    expect(subscription).toBeDefined();
    (edge as any).bindSubscriptionOnChainId(CONTEXT_GRAPH_ID, subscription, '9');
    blockRevisionRead = true;
    let stopping: Promise<void> | undefined;
    try {
      runtime.start(createOperationContext('system'));
      await revisionReadStarted;
      let stopSettled = false;
      stopping = edge.stop().then(() => { stopSettled = true; });
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      expect(whenRevisionReadsIdle).toHaveBeenCalled();

      releasePhysicalRead();
      await stopping;
      expect(stopSettled).toBe(true);
    } finally {
      releasePhysicalRead();
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
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(policyRead).toHaveBeenCalledTimes(2);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'edge-subscription',
        active: true,
        mode: 'catalog',
      }),
    );

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

  it('coalesces many scheduled responsibility notifications into one finalized batch', async () => {
    const targets = Array.from({ length: 12 }, (_, index) => {
      const contextGraphId = `${AUTHOR}/scheduled-responsibility-${index}`;
      return Object.freeze({
        contextGraphId,
        onChainId: String(index + 9),
        nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
      });
    });
    const missing = targets.at(-1)!;
    const privateTarget = targets.at(-2)!;
    const inactiveTarget = targets.at(-3)!;
    const explicitPolicyTarget = targets.at(-4)!;
    const conflictingBindingTarget = targets.at(-5)!;
    const nameMismatchTarget = targets.at(-6)!;
    const idMismatchTarget = targets.at(-7)!;
    const snapshotsByNameHash = new Map(targets.slice(0, -1).map((target) => [
      target.nameHash,
      Object.freeze({
        ...finalizedAuthoritySnapshot(target.contextGraphId, [], '0'),
        contextGraphId: target === idMismatchTarget
          ? `0${target.onChainId}`
          : target.onChainId,
        active: target !== inactiveTarget,
        accessPolicy: target === privateTarget ? 1 : 0,
        nameHash: target === nameMismatchTarget ? `0x${'55'.repeat(32)}` : target.nameHash,
      }),
    ]));
    const resolveSnapshots = vi.fn(async (nameHashes: readonly string[]) => new Map(
      nameHashes.flatMap((nameHash) => {
        const snapshot = snapshotsByNameHash.get(nameHash);
        return snapshot === undefined ? [] : [[nameHash, snapshot] as const];
      }),
    ));
    const snapshotsByOnChainId = new Map(
      [...snapshotsByNameHash.values()].map((snapshot) => [
        BigInt(snapshot.contextGraphId).toString(10),
        snapshot,
      ] as const),
    );
    const readSnapshots = vi.fn(async (onChainIds: readonly string[]) => new Map(
      onChainIds.flatMap((onChainId) => {
        const snapshot = snapshotsByOnChainId.get(onChainId);
        return snapshot === undefined ? [] : [[onChainId, snapshot] as const];
      }),
    ));
    const scalarNameResolution = vi.fn(async () => {
      throw new Error('scheduled responsibility must not fan out scalar name resolution');
    });
    const scalarSnapshot = vi.fn(async () => {
      throw new Error('scheduled responsibility must not fan out scalar snapshots');
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      resolveContextGraphIdByNameHash: scalarNameResolution,
      getContextGraphAuthoritySnapshot: scalarSnapshot,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'scheduled-responsibility-batch',
      config: { chainAdapter },
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    resolveSnapshots.mockClear();
    readSnapshots.mockClear();
    const requestAuthorityRefresh = vi.spyOn(
      (edge as any).rfc64PublicCatalogOwnerV1,
      'requestAuthorityRefresh',
    ).mockImplementation(() => undefined);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockImplementation(async (contextGraphId) => (
      contextGraphId === explicitPolicyTarget.contextGraphId ? 'public' : null
    ));
    const legacyPolicy = vi.spyOn(edge, 'getContextGraphOnChainPolicy')
      .mockRejectedValue(new Error('finalized responsibility must not use current policy'));
    const privateMembership = vi.spyOn(edge, 'hasRfc64VerifiedPrivateMembershipV1')
      .mockResolvedValue(false);

    for (const target of targets) edge.subscribeToContextGraph(target.contextGraphId);
    const conflictingSubscription = edge.getSubscribedContextGraphs()
      .get(conflictingBindingTarget.contextGraphId);
    expect(conflictingSubscription).toBeDefined();
    (edge as any).bindSubscriptionOnChainId(
      conflictingBindingTarget.contextGraphId,
      conflictingSubscription,
      '999',
    );
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(resolveSnapshots).toHaveBeenCalledOnce();
    expect(new Set(resolveSnapshots.mock.calls[0]![0])).toEqual(
      new Set(targets
        .filter((target) => target !== conflictingBindingTarget)
        .map(({ nameHash }) => nameHash)),
    );
    expect(readSnapshots).toHaveBeenCalledTimes(2);
    expect(new Set(readSnapshots.mock.calls[0]![0])).toEqual(
      new Set(['999']),
    );
    expect(new Set(readSnapshots.mock.calls[1]![0])).toEqual(
      new Set(targets
        .filter((target) => ![
          missing,
          conflictingBindingTarget,
          nameMismatchTarget,
          idMismatchTarget,
        ].includes(target))
        .map(({ onChainId }) => onChainId)),
    );
    expect(privateMembership).toHaveBeenCalledWith(privateTarget.contextGraphId);
    expect(privateMembership).not.toHaveBeenCalledWith(missing.contextGraphId);
    expect(edge.readRfc64CatalogResponsibilitiesV1().map(({ contextGraphId }) => (
      contextGraphId
    )).sort()).toEqual(targets
      .filter((target) => target !== missing
        && target !== privateTarget
        && target !== inactiveTarget
        && target !== conflictingBindingTarget
        && target !== nameMismatchTarget
        && target !== idMismatchTarget)
      .map(({ contextGraphId }) => contextGraphId)
      .sort());
    expect(scalarNameResolution).not.toHaveBeenCalled();
    expect(scalarSnapshot).not.toHaveBeenCalled();
    expect(legacyPolicy).not.toHaveBeenCalled();
    expect(requestAuthorityRefresh).toHaveBeenCalled();
    for (const target of targets.filter((candidate) => ![
      missing,
      conflictingBindingTarget,
      nameMismatchTarget,
      idMismatchTarget,
    ].includes(candidate))) {
      expect(edge.getSubscribedContextGraphs().get(target.contextGraphId)).toMatchObject({
        onChainId: target.onChainId,
        onChainHash: target.nameHash,
      });
    }
    expect(edge.getSubscribedContextGraphs().get(conflictingBindingTarget.contextGraphId))
      .toMatchObject({ onChainId: '999' });
    for (const target of [missing, nameMismatchTarget, idMismatchTarget]) {
      expect(edge.getSubscribedContextGraphs().get(target.contextGraphId)?.onChainId)
        .toBeUndefined();
    }
  });

  it('defers an asynchronously produced thousand-target inventory into one batch', async () => {
    const contextGraphIds = Array.from(
      { length: 1_000 },
      (_, index) => `${AUTHOR}/scheduled-inventory-${index}`,
    );
    const expectedNameHashes = contextGraphIds.map((contextGraphId) => (
      ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase()
    ));
    const resolveSnapshots = vi.fn(async () => new Map());
    const readSnapshots = vi.fn(async () => new Map());
    const scalarNameResolution = vi.fn(async () => {
      throw new Error('large scheduled inventory must not use scalar resolution');
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      resolveContextGraphIdByNameHash: scalarNameResolution,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'scheduled-responsibility-large-inventory',
      config: { chainAdapter },
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    resolveSnapshots.mockClear();
    readSnapshots.mockClear();

    const release = edge.beginRfc64ScheduledCatalogResponsibilityBatchV1();
    try {
      for (let index = 0; index < contextGraphIds.length; index++) {
        (edge as any).setContextGraphSubscription(contextGraphIds[index]!, {
          subscribed: true,
          synced: false,
          coreHosted: false,
        }, { persist: false });
        if ((index + 1) % 25 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      expect(resolveSnapshots).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(resolveSnapshots).toHaveBeenCalledOnce();
    expect(new Set(resolveSnapshots.mock.calls[0]![0])).toEqual(
      new Set(expectedNameHashes),
    );
    expect(readSnapshots).not.toHaveBeenCalled();
    expect(scalarNameResolution).not.toHaveBeenCalled();
  });

  it('holds delayed store discovery auto-subscriptions in one responsibility batch', async () => {
    const contextGraphIds = Array.from(
      { length: 64 },
      (_, index) => `${AUTHOR}/delayed-store-discovery-${index}`,
    );
    const expectedNameHashes = contextGraphIds.map((contextGraphId) => (
      ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase()
    ));
    const snapshotsByNameHash = new Map(expectedNameHashes.map((nameHash, index) => [
      nameHash,
      Object.freeze({
        ...finalizedAuthoritySnapshot(contextGraphIds[index]!, [], '0'),
        contextGraphId: String(index + 200),
        accessPolicy: 0,
        nameHash,
      }),
    ]));
    const resolveSnapshots = vi.fn(async (nameHashes: readonly string[]) => new Map(
      nameHashes.map((nameHash) => [nameHash, snapshotsByNameHash.get(nameHash)!]),
    ));
    const snapshotsByOnChainId = new Map(
      [...snapshotsByNameHash.values()].map((snapshot) => [
        snapshot.contextGraphId,
        snapshot,
      ] as const),
    );
    const readSnapshots = vi.fn(async (onChainIds: readonly string[]) => new Map(
      onChainIds.map((onChainId) => [onChainId, snapshotsByOnChainId.get(onChainId)!]),
    ));
    const scalarNameResolution = vi.fn(async () => {
      throw new Error('store discovery responsibility must not use scalar resolution');
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      resolveContextGraphIdByNameHash: scalarNameResolution,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const core = await startAgent({
      name: 'scheduled-responsibility-store-discovery',
      config: { chainAdapter, nodeRole: 'core' },
    });
    await core.whenRfc64CatalogResponsibilitiesIdleV1();
    resolveSnapshots.mockClear();
    readSnapshots.mockClear();
    vi.spyOn((core as any).rfc64PublicCatalogOwnerV1, 'requestAuthorityRefresh')
      .mockImplementation(() => undefined);
    vi.spyOn(core, 'getExplicitAccessPolicy').mockResolvedValue(null);
    vi.spyOn(core, 'isPrivateContextGraph').mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      return false;
    });
    await core.store.insert(contextGraphIds.map((contextGraphId) => ({
      subject: contextGraphDataGraphUri(contextGraphId),
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
    })));

    await expect(core.discoverContextGraphsFromStore()).resolves.toBe(64);
    await core.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(resolveSnapshots).toHaveBeenCalledOnce();
    expect(new Set(resolveSnapshots.mock.calls[0]![0])).toEqual(
      new Set(expectedNameHashes),
    );
    expect(readSnapshots).toHaveBeenCalledOnce();
    expect(new Set(readSnapshots.mock.calls[0]![0]))
      .toEqual(new Set(snapshotsByOnChainId.keys()));
    expect(scalarNameResolution).not.toHaveBeenCalled();
    for (const contextGraphId of contextGraphIds) {
      expect(core.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
        subscribed: true,
        onChainHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
      });
    }
  });

  it('retries a failed scheduled batch without partial responsibility commits', async () => {
    const contextGraphId = `${AUTHOR}/scheduled-batch-retry`;
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
    const snapshot = Object.freeze({
      ...finalizedAuthoritySnapshot(contextGraphId, [], '0'),
      contextGraphId: '91',
      accessPolicy: 0,
      nameHash,
    });
    let failNext = false;
    const resolveSnapshots = vi.fn(async (nameHashes: readonly string[]) => {
      if (failNext) {
        failNext = false;
        throw new Error('temporary finalized index outage');
      }
      return new Map(nameHashes.includes(nameHash) ? [[nameHash, snapshot]] : []);
    });
    const readSnapshots = vi.fn(async (onChainIds: readonly string[]) => new Map(
      onChainIds.includes('91') ? [['91', snapshot]] : [],
    ));
    const scalarNameResolution = vi.fn(async () => {
      throw new Error('scheduled batch retry must not fan out scalar resolution');
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      resolveContextGraphIdByNameHash: scalarNameResolution,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'scheduled-responsibility-retry',
      config: { chainAdapter },
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    resolveSnapshots.mockClear();
    readSnapshots.mockClear();
    vi.spyOn((edge as any).rfc64PublicCatalogOwnerV1, 'requestAuthorityRefresh')
      .mockImplementation(() => undefined);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);

    vi.useFakeTimers();
    try {
      failNext = true;
      edge.subscribeToContextGraph(contextGraphId);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(resolveSnapshots).toHaveBeenCalledOnce();
      expect(edge.readRfc64CatalogResponsibilitiesV1()).not.toContainEqual(
        expect.objectContaining({ contextGraphId }),
      );

      await vi.advanceTimersByTimeAsync(30_100);
      await edge.whenRfc64CatalogResponsibilitiesIdleV1();
      expect(resolveSnapshots).toHaveBeenCalledTimes(2);
      expect(readSnapshots).toHaveBeenCalledOnce();
      expect(readSnapshots.mock.calls.map(([onChainIds]) => onChainIds)).toEqual([
        ['91'],
      ]);
      expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
        expect.objectContaining({ contextGraphId, responsibilityReason: 'edge-subscription' }),
      );
      expect(edge.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
        onChainId: '91',
        onChainHash: nameHash,
      });
      expect(scalarNameResolution).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses a scheduled responsibility batch after one shared store timeout', async () => {
    const contextGraphIds = Array.from(
      { length: 16 },
      (_, index) => `${AUTHOR}/scheduled-store-pressure-${index}`,
    );
    const resolveSnapshots = vi.fn(async () => new Map());
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
        readContextGraphAuthorityIndexSnapshots: vi.fn(async () => new Map()),
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'scheduled-responsibility-store-pressure',
      config: { chainAdapter },
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    resolveSnapshots.mockClear();
    vi.spyOn((edge as any).rfc64PublicCatalogOwnerV1, 'requestAuthorityRefresh')
      .mockImplementation(() => undefined);
    const storePressure = Object.assign(
      new Error('Managed Oxigraph is recovering; query was not started'),
      {
        code: 'STORE_OPERATION_TIMEOUT',
        retryable: true,
        outcome: 'not_started',
      },
    );
    const readAccessPolicy = vi.spyOn(edge, 'getExplicitAccessPolicy')
      .mockRejectedValueOnce(storePressure)
      .mockResolvedValue('public');

    vi.useFakeTimers();
    try {
      for (const contextGraphId of contextGraphIds) {
        edge.subscribeToContextGraph(contextGraphId);
      }
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);

      expect(resolveSnapshots).toHaveBeenCalledOnce();
      expect(readAccessPolicy).toHaveBeenCalledOnce();
      expect(edge.readRfc64CatalogResponsibilitiesV1()).not.toContainEqual(
        expect.objectContaining({ contextGraphId: expect.stringContaining(
          '/scheduled-store-pressure-',
        ) }),
      );

      await vi.advanceTimersByTimeAsync(30_100);
      await edge.whenRfc64CatalogResponsibilitiesIdleV1();

      expect(resolveSnapshots).toHaveBeenCalledTimes(2);
      expect(readAccessPolicy).toHaveBeenCalledTimes(contextGraphIds.length + 1);
      expect(new Set(edge.readRfc64CatalogResponsibilitiesV1()
        .map(({ contextGraphId }) => contextGraphId)))
        .toEqual(new Set(contextGraphIds));
    } finally {
      vi.useRealTimers();
    }
  });

  it('deactivates a withdrawn responsibility before a sibling index failure retries', async () => {
    const withdrawnContextGraphId = `${AUTHOR}/scheduled-withdrawn-before-index-failure`;
    const retainedContextGraphId = `${AUTHOR}/scheduled-retained-index-failure`;
    const snapshots = new Map([
      ['95', Object.freeze({
        ...finalizedAuthoritySnapshot(withdrawnContextGraphId, [], '0'),
        contextGraphId: '95',
        accessPolicy: 0,
        nameHash: ethers.keccak256(
          ethers.toUtf8Bytes(withdrawnContextGraphId),
        ).toLowerCase(),
      })],
      ['96', Object.freeze({
        ...finalizedAuthoritySnapshot(retainedContextGraphId, [], '0'),
        contextGraphId: '96',
        accessPolicy: 0,
        nameHash: ethers.keccak256(
          ethers.toUtf8Bytes(retainedContextGraphId),
        ).toLowerCase(),
      })],
    ] as const);
    let rejectReads = false;
    const readSnapshots = vi.fn(async (onChainIds: readonly string[]) => {
      if (rejectReads) throw new Error('registered sibling index unavailable');
      return new Map(onChainIds.flatMap((onChainId) => {
        const snapshot = snapshots.get(onChainId);
        return snapshot === undefined ? [] : [[onChainId, snapshot] as const];
      }));
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'scheduled-responsibility-terminal-before-index-failure',
      config: { chainAdapter },
    });
    vi.spyOn((edge as any).rfc64PublicCatalogOwnerV1, 'requestAuthorityRefresh')
      .mockImplementation(() => undefined);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);

    edge.subscribeToContextGraph(withdrawnContextGraphId);
    edge.subscribeToContextGraph(retainedContextGraphId);
    const withdrawnSubscription = edge.getSubscribedContextGraphs()
      .get(withdrawnContextGraphId);
    const retainedSubscription = edge.getSubscribedContextGraphs()
      .get(retainedContextGraphId);
    expect(withdrawnSubscription).toBeDefined();
    expect(retainedSubscription).toBeDefined();
    (edge as any).bindSubscriptionOnChainId(
      withdrawnContextGraphId,
      withdrawnSubscription,
      '95',
    );
    (edge as any).bindSubscriptionOnChainId(
      retainedContextGraphId,
      retainedSubscription,
      '96',
    );
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    await edge.reconcileRfc64CatalogAccessAuthorityV1(withdrawnContextGraphId);
    await edge.reconcileRfc64CatalogAccessAuthorityV1(retainedContextGraphId);
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(withdrawnContextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(retainedContextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });

    readSnapshots.mockClear();
    rejectReads = true;
    const release = edge.beginRfc64ScheduledCatalogResponsibilityBatchV1();
    edge.unsubscribeFromContextGraph(withdrawnContextGraphId);
    edge.scheduleRfc64CatalogResponsibilityReconciliationV1(retainedContextGraphId);
    release();
    await vi.waitFor(() => expect(readSnapshots).toHaveBeenCalledOnce());

    expect(readSnapshots).toHaveBeenCalledWith(['96'], {
      signal: expect.any(AbortSignal),
    });
    expect(edge.readRfc64CatalogResponsibilitiesV1()).not.toContainEqual(
      expect.objectContaining({ contextGraphId: withdrawnContextGraphId }),
    );
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(withdrawnContextGraphId))
      .toMatchObject({ active: false, track2Enabled: false });
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(retainedContextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    await edge.stop();
  });

  it('deactivates a withdrawn receiver while its in-flight authority batch is still held', async () => {
    const contextGraphId = `${AUTHOR}/scheduled-withdrawn-during-index-failure`;
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
    const snapshot = Object.freeze({
      ...finalizedAuthoritySnapshot(contextGraphId, [], '0'),
      contextGraphId: '97',
      accessPolicy: 0,
      nameHash,
    });
    let holdNextRead = false;
    let markHeldReadStarted!: () => void;
    let rejectHeldRead!: (reason: Error) => void;
    const heldReadStarted = new Promise<void>((resolve) => {
      markHeldReadStarted = resolve;
    });
    const readSnapshots = vi.fn(async (onChainIds: readonly string[]) => {
      if (holdNextRead) {
        holdNextRead = false;
        markHeldReadStarted();
        await new Promise<never>((_resolve, reject) => {
          rejectHeldRead = reject;
        });
      }
      return new Map(onChainIds.includes('97') ? [['97', snapshot]] : []);
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'scheduled-responsibility-terminal-during-index-failure',
      config: { chainAdapter },
    });
    vi.spyOn((edge as any).rfc64PublicCatalogOwnerV1, 'requestAuthorityRefresh')
      .mockImplementation(() => undefined);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);

    edge.subscribeToContextGraph(contextGraphId);
    const subscription = edge.getSubscribedContextGraphs().get(contextGraphId);
    expect(subscription).toBeDefined();
    (edge as any).bindSubscriptionOnChainId(contextGraphId, subscription, '97');
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    await edge.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId);
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });

    readSnapshots.mockClear();
    holdNextRead = true;
    edge.scheduleRfc64CatalogResponsibilityReconciliationV1(contextGraphId);
    await heldReadStarted;

    edge.unsubscribeFromContextGraph(contextGraphId);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).not.toContainEqual(
      expect.objectContaining({ contextGraphId }),
    );
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId))
      .toMatchObject({ active: false, track2Enabled: false });
    expect(readSnapshots).toHaveBeenCalledOnce();

    rejectHeldRead(new Error('held registered authority read failed'));
    await edge.stop();
  });

  it('fences a stale finalized batch after the subscription is removed', async () => {
    const contextGraphId = `${AUTHOR}/scheduled-stale-unsubscribe`;
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
    const snapshot = Object.freeze({
      ...finalizedAuthoritySnapshot(contextGraphId, [], '0'),
      contextGraphId: '92',
      accessPolicy: 0,
      nameHash,
    });
    let holdNext = false;
    let releaseRead: (() => void) | undefined;
    const resolveSnapshots = vi.fn(async (nameHashes: readonly string[]) => {
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => { releaseRead = resolve; });
      }
      return new Map(nameHashes.includes(nameHash) ? [[nameHash, snapshot]] : []);
    });
    const readSnapshots = vi.fn(async (onChainIds: readonly string[]) => new Map(
      onChainIds.includes('92') ? [['92', snapshot]] : [],
    ));
    const scalarNameResolution = vi.fn(async () => {
      throw new Error('stale scheduled work must not use scalar resolution');
    });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      resolveContextGraphIdByNameHash: scalarNameResolution,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'scheduled-responsibility-stale-unsubscribe',
      config: { chainAdapter },
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    resolveSnapshots.mockClear();
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);

    holdNext = true;
    edge.subscribeToContextGraph(contextGraphId);
    await vi.waitFor(() => expect(releaseRead).toBeDefined());
    (edge as any).deleteContextGraphSubscription(contextGraphId);
    releaseRead!();
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).not.toContainEqual(
      expect.objectContaining({ contextGraphId }),
    );
    expect(scalarNameResolution).not.toHaveBeenCalled();
  });

  it('clears failed scheduled targets when shutdown aborts retry before reopen', async () => {
    const staleContextGraphId = `${AUTHOR}/scheduled-close-stale`;
    const pendingContextGraphId = `${AUTHOR}/scheduled-close-pending`;
    const freshContextGraphId = `${AUTHOR}/scheduled-close-fresh`;
    const staleNameHash = ethers.keccak256(
      ethers.toUtf8Bytes(staleContextGraphId),
    ).toLowerCase();
    const freshNameHash = ethers.keccak256(
      ethers.toUtf8Bytes(freshContextGraphId),
    ).toLowerCase();
    const pendingNameHash = ethers.keccak256(
      ethers.toUtf8Bytes(pendingContextGraphId),
    ).toLowerCase();
    let rejectReads = false;
    const resolveSnapshots = vi.fn(async (nameHashes: readonly string[]) => {
      if (rejectReads) throw new Error('finalized index remains unavailable');
      return new Map(nameHashes.includes(freshNameHash) ? [[freshNameHash, Object.freeze({
        ...finalizedAuthoritySnapshot(freshContextGraphId, [], '0'),
        contextGraphId: '93',
        accessPolicy: 0,
        nameHash: freshNameHash,
      })]] : []);
    });
    const readSnapshots = vi.fn(async (onChainIds: readonly string[]) => new Map(
      onChainIds.includes('93') ? [['93', Object.freeze({
        ...finalizedAuthoritySnapshot(freshContextGraphId, [], '0'),
        contextGraphId: '93',
        accessPolicy: 0,
        nameHash: freshNameHash,
      })]] : [],
    ));
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'scheduled-responsibility-close-reopen',
      config: { chainAdapter },
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    resolveSnapshots.mockClear();
    vi.spyOn((edge as any).rfc64PublicCatalogOwnerV1, 'requestAuthorityRefresh')
      .mockImplementation(() => undefined);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);

    rejectReads = true;
    edge.subscribeToContextGraph(staleContextGraphId);
    await vi.waitFor(() => expect(resolveSnapshots).toHaveBeenCalledOnce());
    // The failed pass is now inside its retry delay. Queue another real,
    // non-terminal target so shutdown must clear work accepted after the
    // immutable failed selection, not merely observe a target deleted by the
    // test itself.
    edge.subscribeToContextGraph(pendingContextGraphId);
    await edge.stop();

    rejectReads = false;
    await edge.start();
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(resolveSnapshots).toHaveBeenCalledTimes(1);
    resolveSnapshots.mockClear();
    edge.subscribeToContextGraph(freshContextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(resolveSnapshots).toHaveBeenCalled();
    expect(resolveSnapshots.mock.calls.every(([nameHashes]) => (
      !nameHashes.includes(staleNameHash)
      && !nameHashes.includes(pendingNameHash)
    ))).toBe(true);
    expect(edge.getSubscribedContextGraphs().get(freshContextGraphId)).toMatchObject({
      onChainId: '93',
      onChainHash: freshNameHash,
    });
  });

  it('keeps registered responsibility evidence scoped to each explicit consumer pass', async () => {
    const firstContextGraphId = `${AUTHOR}/bulk-responsibility-first`;
    const secondContextGraphId = `${AUTHOR}/bulk-responsibility-second`;
    const firstNameHash = ethers.keccak256(
      ethers.toUtf8Bytes(firstContextGraphId),
    ).toLowerCase();
    const secondNameHash = ethers.keccak256(
      ethers.toUtf8Bytes(secondContextGraphId),
    ).toLowerCase();
    let finalizedOwner = AUTHOR;
    let finalizedOwnershipEra = '0';
    let finalizedSourceBlockNumber = '42';
    const readPolicies = vi.fn(async (
      contextGraphIds: readonly ContextGraphAuthorityIndexId[],
    ) => new Map(contextGraphIds.map((contextGraphId) => [
      contextGraphId,
      Object.freeze({
        ...finalizedAuthoritySnapshot(
          contextGraphId === '9' ? firstContextGraphId : secondContextGraphId,
          [],
          '0',
        ),
        contextGraphId,
        owner: finalizedOwner,
        active: true,
        accessPolicy: 0,
        nameHash: contextGraphId === '9' ? firstNameHash : secondNameHash,
        ownershipEra: finalizedOwnershipEra,
        sourceBlockNumber: finalizedSourceBlockNumber,
      }),
    ])));
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        readContextGraphAuthorityIndexSnapshots: readPolicies,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'bulk-registered-responsibility-policy',
      config: { chainAdapter },
    });
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);
    const legacyPolicy = vi.spyOn(edge, 'getContextGraphOnChainPolicy')
      .mockRejectedValue(new Error('legacy per-graph policy read must not run'));

    edge.subscribeToContextGraph(firstContextGraphId);
    edge.subscribeToContextGraph(secondContextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    const firstSubscription = edge.getSubscribedContextGraphs().get(firstContextGraphId);
    const secondSubscription = edge.getSubscribedContextGraphs().get(secondContextGraphId);
    expect(firstSubscription).toBeDefined();
    expect(secondSubscription).toBeDefined();
    (edge as any).bindSubscriptionOnChainId(firstContextGraphId, firstSubscription, '9');
    (edge as any).bindSubscriptionOnChainId(secondContextGraphId, secondSubscription, '10');
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    await edge.whenRfc64CatalogSupervisorsIdleV1();

    // Each coalesced pass owns one immutable union of the targets it selected.
    // The durable-binding successor may narrow to the first target before the
    // next shared pass observes both bindings. The accepted SWM transport path
    // itself reopens none of these reads.
    const initialAuthorityReads = readPolicies.mock.calls.map(
      ([targetIds]) => [...targetIds],
    );
    expect(initialAuthorityReads).toEqual([
      ['9', '10'],
      ['9'],
      ['9', '10'],
    ]);
    expect(legacyPolicy).not.toHaveBeenCalled();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contextGraphId: firstContextGraphId,
        responsibilityReason: 'edge-subscription',
      }),
      expect.objectContaining({
        contextGraphId: secondContextGraphId,
        responsibilityReason: 'edge-subscription',
      }),
    ]));
    expect(edge.resolveRfc64CatalogServingAuthorityV1(firstContextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    expect(edge.resolveRfc64CatalogServingAuthorityV1(secondContextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });

    const firstAccepted = (edge as any).rfc64PublicCatalogServiceV1
      .acceptedPolicySnapshot(NETWORK_ID, firstContextGraphId);
    expect(firstAccepted).toMatchObject({ policy: { era: '0' } });

    // A later revision refresh must select a new finalized anchor. It may not
    // reuse the responsibility bootstrap evidence merely because it remains
    // inside a wall-clock TTL.
    finalizedOwner = MEMBER;
    finalizedOwnershipEra = '1';
    finalizedSourceBlockNumber = '43';
    const authorityReadsBeforeDirectRefresh = readPolicies.mock.calls.length;
    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(firstContextGraphId))
      .resolves.toMatchObject({ policy: { era: '1' } });
    expect(readPolicies).toHaveBeenCalledTimes(authorityReadsBeforeDirectRefresh + 1);
    expect(readPolicies.mock.calls.at(-1)?.[0]).toEqual(['9']);
    expect((edge as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      firstContextGraphId,
    )).toMatchObject({
      policy: {
        era: '1',
        source: { blockNumber: '43' },
      },
    });
    expect((edge as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      firstContextGraphId,
    )?.policy.ownershipTransitionDigest).not.toBe(
      firstAccepted?.policy.ownershipTransitionDigest,
    );
  });

  it('keeps finalized snapshot absence explicit through refresh reconciliation', async () => {
    const contextGraphId = `${AUTHOR}/finalized-absence`;
    const expectedNameHash = ethers.keccak256(
      ethers.toUtf8Bytes(contextGraphId),
    ).toLowerCase();
    const readSnapshots = vi.fn(async () => new Map());
    const resolveIds = vi.fn(async (nameHashes: readonly string[]) => new Map([
      [nameHashes[0]!, 9n],
    ]));
    const pointAuthorityRead = vi.fn(async () => finalizedAuthoritySnapshot(
      contextGraphId,
      [],
      '0',
    ));
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointAuthorityRead,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdsByNameHashes: resolveIds,
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'finalized-authority-absence',
      config: { chainAdapter },
    });
    edge.recordDiscoveredContextGraph(contextGraphId, {
      name: contextGraphId,
      onChainId: '9',
      onChainHash: expectedNameHash,
    });
    const legacyPolicy = vi.spyOn(edge, 'getContextGraphOnChainPolicy')
      .mockRejectedValue(new Error('finalized absence must not reopen current policy'));
    const signal = new AbortController().signal;

    const requests = await edge.createRfc64CatalogAuthorityRefreshRequestsV1(
      [contextGraphId],
      signal,
    );
    const request = requests.get(contextGraphId);

    expect(request).toEqual({ kind: 'finalized-absence' });
    expect(Object.isFrozen(request)).toBe(true);
    await expect(edge.reconcileRfc64CatalogAccessAuthorityV1(
      contextGraphId,
      signal,
      request,
    )).rejects.toThrow('no finalized indexed authority');
    expect(resolveIds).not.toHaveBeenCalled();
    expect(readSnapshots).toHaveBeenCalledWith(['9'], { signal: expect.any(AbortSignal) });
    expect(pointAuthorityRead).not.toHaveBeenCalled();
    expect(legacyPolicy).not.toHaveBeenCalled();
  });

  /**
   * A freshly registered graph is invisible to the FINALIZED authority index
   * until chain finality catches up (~600 blocks / ~20 min on Base Sepolia).
   * That lag used to be reported as `registered-authority-binding-mismatch`
   * and parked the graph as `blocked`, which silenced the AUTHOR of a public
   * graph (no heads authored, served or announced) for the whole finality
   * window after every registration. It is retryable, and the author of
   * record keeps its already-accepted authority through it.
   */
  it('treats a registered graph the finalized index has not indexed yet as retryable, retaining the author\'s accepted authority', async () => {
    const contextGraphId = `${AUTHOR}/unfinalized-author`;
    const expectedNameHash = ethers.keccak256(
      ethers.toUtf8Bytes(contextGraphId),
    ).toLowerCase();
    // The helper defaults to a private graph; this scenario is a PUBLIC one.
    const indexed = {
      ...finalizedAuthoritySnapshot(contextGraphId, [], '0'),
      accessPolicy: 0 as const,
      nameHash: expectedNameHash,
    };
    const readSnapshots = vi.fn(async () => new Map([['9', indexed]]));
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdsByNameHashes: vi.fn(async () => new Map()),
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const author = await startAgent({
      name: 'unfinalized-author',
      config: { chainAdapter },
    });
    (author as any).localContextGraphProvenance.recordLocalCreate(contextGraphId);
    author.recordDiscoveredContextGraph(contextGraphId, {
      name: contextGraphId,
      onChainId: '9',
      onChainHash: expectedNameHash,
    });
    // A responsibility (not just a discovered binding) is what the fence,
    // the refresh workload and the operational status all key on.
    author.subscribeToContextGraph(contextGraphId);
    await author.whenRfc64CatalogResponsibilitiesIdleV1();
    const signal = new AbortController().signal;

    // Accepted while the index carries the entry.
    await expect(author.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId, signal))
      .resolves.toMatchObject({ source: 'finalized-chain' });
    const accepted = (author as any).rfc64PublicCatalogServiceV1
      .acceptedPolicySnapshot(NETWORK_ID, contextGraphId);
    expect(accepted).not.toBeNull();

    // The finalized index no longer carries the bound id (finality lag).
    readSnapshots.mockResolvedValue(new Map());
    const request = (await author.createRfc64CatalogAuthorityRefreshRequestsV1(
      [contextGraphId],
      signal,
    )).get(contextGraphId);
    await expect(author.reconcileRfc64CatalogAccessAuthorityV1(
      contextGraphId,
      signal,
      request,
    )).rejects.toMatchObject({
      code: 'registered-authority-unfinalized',
      message: expect.stringContaining('no finalized indexed authority'),
    });

    // Retryable, not a denial: authority retained, fence open, not parked.
    expect((author as any).rfc64PublicCatalogServiceV1
      .acceptedPolicySnapshot(NETWORK_ID, contextGraphId)).toEqual(accepted);
    expect(author.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: true });
    const status = (await author.readRfc64CatalogOperationalStatusV1())
      .find((entry) => entry.contextGraphId === contextGraphId);
    expect(status?.authorityState).toBe('resolving');
    expect(status?.authorityState).not.toBe('blocked');
  });

  it('keeps a replica fail-closed but retryable through the same finality lag (no retained seed, not parked)', async () => {
    const contextGraphId = `${AUTHOR}/unfinalized-replica`;
    const expectedNameHash = ethers.keccak256(
      ethers.toUtf8Bytes(contextGraphId),
    ).toLowerCase();
    // The helper defaults to a private graph; this scenario is a PUBLIC one.
    const indexed = {
      ...finalizedAuthoritySnapshot(contextGraphId, [], '0'),
      accessPolicy: 0 as const,
      nameHash: expectedNameHash,
    };
    const readSnapshots = vi.fn(async () => new Map([['9', indexed]]));
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdsByNameHashes: vi.fn(async () => new Map()),
        readContextGraphAuthorityIndexSnapshots: readSnapshots,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const replica = await startAgent({
      name: 'unfinalized-replica',
      config: { chainAdapter },
    });
    // NOT the author of record: no recordLocalCreate.
    replica.recordDiscoveredContextGraph(contextGraphId, {
      name: contextGraphId,
      onChainId: '9',
      onChainHash: expectedNameHash,
    });
    replica.subscribeToContextGraph(contextGraphId);
    await replica.whenRfc64CatalogResponsibilitiesIdleV1();
    const signal = new AbortController().signal;
    await expect(replica.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId, signal))
      .resolves.toMatchObject({ source: 'finalized-chain' });

    readSnapshots.mockResolvedValue(new Map());
    const request = (await replica.createRfc64CatalogAuthorityRefreshRequestsV1(
      [contextGraphId],
      signal,
    )).get(contextGraphId);
    await expect(replica.reconcileRfc64CatalogAccessAuthorityV1(
      contextGraphId,
      signal,
      request,
    )).rejects.toMatchObject({ code: 'registered-authority-unfinalized' });

    // A replica does not get to keep serving on a stale acceptance ...
    expect(replica.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: false });
    // ... but it is left retryable rather than parked as blocked.
    const status = (await replica.readRfc64CatalogOperationalStatusV1())
      .find((entry) => entry.contextGraphId === contextGraphId);
    expect(status?.authorityState).toBe('resolving');
  });

  it('gates indexed private responsibility and authority on verified membership', async () => {
    const contextGraphId = `${AUTHOR}/indexed-private-responsibility`;
    const indexedSnapshot = finalizedAuthoritySnapshot(
      contextGraphId,
      [AUTHOR, MEMBER],
      '0',
    );
    const readPolicies = vi.fn(async (
      contextGraphIds: readonly ContextGraphAuthorityIndexId[],
    ) => new Map(contextGraphIds.map((contextGraphAuthorityIndexId) => [
      contextGraphAuthorityIndexId,
      indexedSnapshot,
    ])));
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        readContextGraphAuthorityIndexSnapshots: readPolicies,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const edge = await startAgent({
      name: 'indexed-private-responsibility',
      config: {
        chainAdapter,
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: MEMBER,
          resolveRemoteAgentAddress: async () => null,
        },
      },
    });
    (edge as any).defaultAgentAddress = MEMBER;
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);
    const legacyPolicy = vi.spyOn(edge, 'getContextGraphOnChainPolicy')
      .mockRejectedValue(new Error('indexed private policy must not use current RPC state'));
    const hasMembership = vi.spyOn(edge, 'hasRfc64VerifiedPrivateMembershipV1')
      .mockResolvedValue(false);
    vi.spyOn(edge, 'resolveRfc64VerifiedPrivateRosterV1')
      .mockResolvedValue([AUTHOR, MEMBER]);
    vi.spyOn(edge, 'readRfc64PrivateRosterVersionV1').mockResolvedValue('1');
    vi.spyOn(edge, 'getCgMeta').mockResolvedValue({
      ...(await edge.getCgMeta(contextGraphId)),
      revokedAgents: [],
    });
    vi.spyOn(edge, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
      .mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));

    edge.subscribeToContextGraph(contextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    const subscription = edge.getSubscribedContextGraphs().get(contextGraphId);
    expect(subscription).toBeDefined();
    (edge as any).bindSubscriptionOnChainId(contextGraphId, subscription, '9');
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(readPolicies).toHaveBeenCalled();
    expect(hasMembership).toHaveBeenCalledWith(contextGraphId);
    expect(legacyPolicy).not.toHaveBeenCalled();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);
    expect((edge as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      contextGraphId,
    )).toBeNull();
    expect(edge.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: false, track2Enabled: false });

    hasMembership.mockResolvedValue(true);
    await expect(edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId))
      .resolves.toMatchObject({
        active: true,
        responsibilityReason: 'private-membership',
      });

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'private-membership',
        active: true,
        mode: 'catalog',
      }),
    );
    expect(edge.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    expect((edge as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      contextGraphId,
    )).toMatchObject({
      policy: { accessPolicy: 1 },
      roster: {
        members: expect.arrayContaining([
          expect.objectContaining({ agentAddress: MEMBER }),
        ]),
      },
    });
    expect(legacyPolicy).not.toHaveBeenCalled();
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

  it('preserves active responsibility when a refresh owner is cancelled', async () => {
    const contextGraphId = `${AUTHOR}/cancelled-responsibility-refresh`;
    const edge = await startAgent({ name: 'cancelled-responsibility-refresh' });
    const accessPolicy = vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('public');
    edge.subscribeToContextGraph(contextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
      expect.objectContaining({ contextGraphId, active: true, mode: 'catalog' }),
    );

    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    accessPolicy.mockImplementation(async () => {
      const signal = activeRpcRequestAbortSignal();
      if (signal === undefined) throw new Error('refresh did not bind its owner signal');
      notifyStarted();
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(signal.reason);
        signal.addEventListener('abort', rejectAbort, { once: true });
        if (signal.aborted) rejectAbort();
      });
      return 'public';
    });
    const owner = new AbortController();
    const refresh = withRpcRequestContext({ signal: owner.signal }, () => (
      edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId)
    ));
    await started;
    const reason = new Error('superseded responsibility refresh');
    owner.abort(reason);
    await expect(refresh).rejects.toBe(reason);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toContainEqual(
      expect.objectContaining({ contextGraphId, active: true, mode: 'catalog' }),
    );
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
    // A refresh must not create a transport outage while it reads the next
    // finalized generation. The already accepted snapshot remains the latest
    // finalized authority until this attempt either commits or blocks.
    expect(curator.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    expect(curator.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    expect(curator.resolveAcceptedRfc64SharedMemoryAuthorityV1(contextGraphId)).toBe(true);
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

  it('keeps a blocked authority disabled throughout a stalled retry', async () => {
    const contextGraphId = `${AUTHOR}/blocked-authority-retry` as ContextGraphIdV1;
    const curator = await startAgent({ name: 'blocked-authority-retry' });
    (curator as any).defaultAgentAddress = AUTHOR;
    await curator.createContextGraph({
      id: contextGraphId,
      name: 'Blocked authority retry',
      accessPolicy: 0,
      callerAgentAddress: AUTHOR,
    });
    await curator.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(curator.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });

    let releaseRetry!: () => void;
    let retryStarted!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const retryEntered = new Promise<void>((resolve) => { retryStarted = resolve; });
    vi.spyOn(curator, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
      .mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));
    vi.spyOn(curator, 'getContextGraphOwner')
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => {
        retryStarted();
        await retryGate;
        return `did:dkg:agent:${AUTHOR}`;
      });

    await expect(curator.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId))
      .rejects.toThrow(/no canonical owner address/u);
    expect(curator.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: false, track2Enabled: false });
    expect(curator.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId))
      .toMatchObject({ active: false, track2Enabled: false });
    expect(curator.resolveAcceptedRfc64SharedMemoryAuthorityV1(contextGraphId)).toBe(false);

    const retry = curator.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId);
    await retryEntered;
    expect(curator.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: false, track2Enabled: false });
    expect(curator.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId))
      .toMatchObject({ active: false, track2Enabled: false });
    expect(curator.resolveAcceptedRfc64SharedMemoryAuthorityV1(contextGraphId)).toBe(false);

    releaseRetry();
    await expect(retry).resolves.toMatchObject({ source: 'owner-signed-unregistered' });
    expect(curator.resolveRfc64CatalogServingAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    expect(curator.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId))
      .toMatchObject({ active: true, track2Enabled: true });
    expect(curator.resolveAcceptedRfc64SharedMemoryAuthorityV1(contextGraphId)).toBe(true);
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

  it('keeps the deprecated disabled rollback out of standalone Track-2 mode', async () => {
    const edge = await startAgent({
      name: 'deprecated-disabled-rollback',
      config: {
        rfc64PublicCatalogActivation: { enabled: false },
        // A rollback must remain usable while an operator removes stale
        // pre-activation controls in a later configuration change.
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          resolveRemoteAgentAddress: async () => AUTHOR,
        },
        rfc64PublicCatalogAutoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
    });
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('public');
    await edge.createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Deprecated disabled rollback',
      callerAgentAddress: AUTHOR,
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

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
    expect((edge as any).config.rfc64CatalogDeploymentProfile).toBeUndefined();
    expect((edge as any).config.rfc64CatalogAccessPolicyAuthority).toBeUndefined();
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
    vi.spyOn(core, 'getExplicitAccessPolicy').mockResolvedValue('public');
    core.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await core.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(core.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId: CONTEXT_GRAPH_ID,
        responsibilityReason: 'core-public',
        active: true,
      }),
    ]);

    const queuedRecoveryPasses = queueRecovery.mock.calls.length;
    expect(queuedRecoveryPasses).toBeGreaterThan(0);
    const configuredTargets = core.readRfc64PublicCatalogBootstrapStatusV1()?.targets;
    expect(configuredTargets).toEqual([
      expect.objectContaining({
        mode: 'catalog',
        scope: expect.objectContaining({ contextGraphId: CONTEXT_GRAPH_ID }),
      }),
    ]);
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
    const clearTargets = vi.spyOn(core, 'clearRfc64CatalogOperationalTargetsV1');
    core.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await core.whenRfc64CatalogResponsibilitiesIdleV1();
    await core.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(core.readRfc64CatalogResponsibilitiesV1()).toEqual([]);
    expect(core.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID))
      .toMatchObject({ active: true, mode: 'catalog' });
    expect(core.readRfc64PublicCatalogBootstrapStatusV1()?.targets)
      .toEqual(configuredTargets);
    expect(deactivate).not.toHaveBeenCalled();
    expect(clearTargets).not.toHaveBeenCalled();
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

  it('admits catalog-mode member transport immediately for the named-subgraph compatibility lane', async () => {
    const catalog = await startAgent({
      name: 'catalog-metadata-refresh-fence',
      activation: activation('catalog'),
    });
    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);

    const internals = catalog as any;
    expect(catalog.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID)).toMatchObject({
      subscribed: true,
    });
    // Finalized RFC-64 authority is sufficient at the transport boundary, so
    // catalog-owned SWM no longer waits for a legacy metadata bootstrap read.
    expect(internals.sharedMemoryGossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(true);

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

  it('admits catalog-owned SWM from the accepted RFC-64 snapshot without a legacy read', async () => {
    const catalog = await startAgent({
      name: 'catalog-accepted-swm-authority',
      activation: activation('catalog'),
    });
    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    vi.spyOn(catalog, 'hasConfirmedMetaState').mockResolvedValue(true);
    await vi.waitFor(() => {
      expect(catalog.resolveAcceptedRfc64SharedMemoryAuthorityV1(CONTEXT_GRAPH_ID))
        .toBe(true);
    });

    const legacyRead = vi.spyOn(catalog, 'canReadContextGraph')
      .mockRejectedValue(new Error('legacy registered authority must not run'));
    await expect(catalog.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID))
      .resolves.toBe(true);
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it('keeps private catalog SWM admission bound to the accepted member roster', async () => {
    const privateContextGraphId = `${AUTHOR}/private-accepted-swm-authority` as ContextGraphIdV1;
    const catalog = await startAgent({
      name: 'private-catalog-accepted-swm-authority',
      activation: activation('catalog'),
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
    catalog.acceptRfc64CatalogAccessSnapshotV1({
      policy: privateAuthority.policy,
      policyDigest: privateAuthority.policyDigest,
      roster: privateAuthority.roster,
    });

    const legacyRead = vi.spyOn(catalog, 'canReadContextGraph')
      .mockRejectedValue(new Error('legacy registered authority must not run'));
    await expect(catalog.canUseSharedMemoryForContextGraph(privateContextGraphId, {
      callerAgentAddress: MEMBER,
    })).resolves.toBe(true);
    await expect(catalog.canUseSharedMemoryForContextGraph(privateContextGraphId, {
      callerAgentAddress: NONMEMBER,
    })).resolves.toBe(false);
    expect(legacyRead).not.toHaveBeenCalled();
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
    const shadowExecution = shadow.readRfc64CatalogShadowExecutionStatusV1();
    expect(shadowExecution).toMatchObject({
      receiverStaging: {
        authoritativeApplyCount: 0,
        stagingObserved: true,
        stageOnlyInvariantSatisfied: true,
      },
    });
    expect(shadowExecution!.receiverStaging.trackedTargets).toBeGreaterThanOrEqual(1);
    expect(shadowExecution!.receiverStaging.staged).toBeGreaterThanOrEqual(1);
    expect(shadow.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 30_000);

  it('records staging from normal announcements for a rollout-only lifecycle canary', async () => {
    const shadow = await startAgent({
      name: 'lifecycle-shadow-receiver',
      config: {
        ...custodialAuthorConfig(),
        rfc64CatalogActivation: {
          deploymentProfile: DEPLOYMENT,
          rollout: {
            defaultMode: 'legacy',
            contextGraphModes: { [CONTEXT_GRAPH_ID]: 'shadow' },
          },
        },
      },
    });
    await shadow.createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Lifecycle shadow receiver',
      callerAgentAddress: AUTHOR,
    });
    await shadow.whenRfc64CatalogResponsibilitiesIdleV1();

    const author = await startAgent({
      name: 'lifecycle-shadow-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [shadow.peerId],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    await connectBothWays(author, shadow);
    const published = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-lifecycle-shadow-announcement' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(85n)),
    });
    expect(published).not.toBeNull();

    await vi.waitFor(() => {
      const shadowExecution = shadow.readRfc64CatalogShadowExecutionStatusV1();
      expect(shadowExecution).toMatchObject({
        contextGraphCount: 1,
        receiverStaging: {
          authoritativeApplyCount: 0,
          stagingObserved: true,
          stageOnlyInvariantSatisfied: true,
        },
      });
      expect(shadowExecution!.receiverStaging.trackedTargets).toBeGreaterThanOrEqual(1);
      expect(shadowExecution!.receiverStaging.staged).toBeGreaterThanOrEqual(1);
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
