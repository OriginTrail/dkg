// SPDX-License-Identifier: Apache-2.0

/**
 * Announced-head apply latency (verified live): a replica whose RFC-64
 * receiver lane was active received the author's head announcement about one
 * second after a share but applied it only minutes later, when connect-time
 * replay churn from other peers re-delivered the head. This file pins the two
 * scheduling fixes and the observability that makes the remaining failures
 * visible instead of silent:
 *
 *  T1  A verified current head must not stall behind a strictly OLDER ambient
 *      task that is merely slow for the same scope. `before-same-scope`
 *      placement only reorders the queue; the scope lock is held by the ACTIVE
 *      task, so it is aborted (the same version-dominance rule already applied
 *      to queued ambient work after a durable verified success).
 *  T2  An acceleration pull that fails is re-pulled after `intervalMs`, the
 *      failure is observable, and the head is applied by the retried pull.
 *  T3  The re-pull is bounded: the target is dropped after `maxAttempts`, the
 *      terminal pass is observable, and no timer is left armed.
 *  T4  A throwing policy/authority read for one target drops that target,
 *      observably, and never rejects the pass its siblings run in.
 *  T5  A retained target re-inserted after a pass respects the announced-scope
 *      cap: the most-attempted retained entry yields, never a fresh hint.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  DKGNode,
  ProtocolRouter,
  computeControlSignatureVariantDigestHex,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type EvmAddressV1,
  type SendOptions,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import {
  Rfc64PublicCatalogReceiverV1,
  type Rfc64PublicCatalogReceiverReconcilerV1,
  type Rfc64PublicCatalogReconcileResultV1,
} from '../src/rfc64/public-catalog-receiver-v1.js';
import {
  Rfc64PublicCatalogServiceV1,
  type Rfc64AnnouncedCurrentHeadAccelerationFailureV1,
  type Rfc64PublicCatalogServiceOptionsV1,
} from '../src/rfc64/public-catalog-service-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
  encodeRfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';
import {
  RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
} from '../src/rfc64/public-catalog-current-head-discovery-v1.js';
import type { Rfc64ControlObjectOperationsV1 } from '../src/rfc64/control-object-store-v1.js';
import {
  openRfc64PersistenceV1,
  type Rfc64PersistenceV1,
} from '../src/rfc64/persistence-v1.js';

// ---------------------------------------------------------------------------
// Receiver-level fakes (mirrors rfc64-public-catalog-receiver-v1.test.ts)
// ---------------------------------------------------------------------------

function announcement(
  overrides: Partial<Rfc64PublicCatalogHeadAnnouncementV1> = {},
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return {
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/lane',
    subGraphName: null,
    authorAddress: '0x2222222222222222222222222222222222222222',
    catalogEra: '0',
    catalogVersion: '1',
    policyDigest: `0x${'71'.repeat(32)}`,
    catalogHeadObjectDigest: `0x${'aa'.repeat(32)}`,
    signatureVariantDigest: `0x${'bb'.repeat(32)}`,
    ...overrides,
  } as Rfc64PublicCatalogHeadAnnouncementV1;
}

function headAt(version: string): Rfc64PublicCatalogHeadAnnouncementV1 {
  return announcement({
    catalogVersion: version,
    catalogHeadObjectDigest: `0x${version.padStart(2, '0').slice(-2).repeat(32)}` as Digest32V1,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reconciler(
  reconcileHead: Rfc64PublicCatalogReceiverReconcilerV1['reconcileHead'],
  isHeadSatisfied: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ) => Promise<boolean> = async () => false,
): Rfc64PublicCatalogReceiverReconcilerV1 {
  return { isHeadSatisfied, reconcileHead };
}

/** Let the pump and every queued microtask/macrotask settle without timers of our own. */
async function settle(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A provider fetch that honours cancellation and otherwise never returns. */
function blockUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('RFC-64 announced-head apply: verified head vs. stale active ambient task (T1)', () => {
  it('reproduces the stall: same-scope work never runs while an older ambient task is active', async () => {
    const ambientStarted = deferred<void>();
    const releaseAmbient = deferred<Rfc64PublicCatalogReconcileResultV1>();
    const versions: string[] = [];
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async (_peerId, head) => {
      versions.push(head.catalogVersion);
      if (head.catalogVersion === '3') {
        ambientStarted.resolve();
        return releaseAmbient.promise;
      }
      return 'applied';
    }), { maxAttempts: 1, retryBackoffMs: 0 });

    receiver.schedule(headAt('3'), 'peer-slow');
    await ambientStarted.promise;
    // An explicit but UNVERIFIED request has no dominance over active work:
    // this is exactly what the newer head's ambient task experiences too.
    const isolated = receiver.scheduleManyAndWait([{
      announcement: headAt('4'),
      remotePeerId: 'peer-current',
    }]);
    await settle();

    expect(versions).toEqual(['3']);
    expect(receiver.stats()).toMatchObject({ inFlight: 1, queued: 1, preemptedActive: 0 });

    releaseAmbient.resolve('applied');
    await expect(isolated).resolves.toMatchObject({ outcome: 'applied' });
    await receiver.whenIdle();
    expect(versions).toEqual(['3', '4']);
    expect(receiver.stats()).toMatchObject({ applied: 2, preemptedActive: 0 });
  });

  it('aborts a strictly older active ambient task so the verified head applies within one pump', async () => {
    const ambientStarted = deferred<void>();
    const versions: string[] = [];
    let ambientSignal: AbortSignal | undefined;
    const onTerminalEvent = vi.fn();
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async (_peerId, head, signal) => {
      versions.push(head.catalogVersion);
      if (head.catalogVersion === '3') {
        ambientSignal = signal;
        ambientStarted.resolve();
        return blockUntilAborted(signal);
      }
      return 'applied';
    }), { maxAttempts: 1, retryBackoffMs: 0, onTerminalEvent });

    receiver.schedule(headAt('3'), 'peer-slow');
    await ambientStarted.promise;
    expect(ambientSignal?.aborted).toBe(false);

    const verified = receiver.scheduleVerifiedCurrentHeadAndWait([{
      announcement: headAt('4'),
      remotePeerId: 'peer-current',
    }]);

    // Preemption is decided synchronously at admission, before any pump.
    expect(ambientSignal?.aborted).toBe(true);
    expect(receiver.stats().preemptedActive).toBe(1);
    await expect(verified).resolves.toMatchObject({
      outcome: 'applied',
      appliedProviderPeerId: 'peer-current',
      providerAttempts: 1,
    });
    await receiver.whenIdle();

    expect(versions).toEqual(['3', '4']);
    expect(receiver.stats()).toMatchObject({
      applied: 1,
      failed: 0,
      preemptedActive: 1,
      inFlight: 0,
      queued: 0,
    });
    expect(onTerminalEvent.mock.calls.map(([event]) => [
      event.announcement.catalogVersion,
      event.outcome,
    ]).sort()).toEqual([
      ['3', 'closed'],
      ['4', 'applied'],
    ]);
  });

  it('never preempts an equal-version active ambient task', async () => {
    const applied = new Set<string>();
    const ambientStarted = deferred<void>();
    const releaseAmbient = deferred<void>();
    let ambientSignal: AbortSignal | undefined;
    const peers: string[] = [];
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(
      async (peerId, head, signal) => {
        peers.push(peerId);
        if (peerId === 'peer-slow') {
          ambientSignal = signal;
          ambientStarted.resolve();
          await releaseAmbient.promise;
        }
        applied.add(head.catalogHeadObjectDigest);
        return 'applied';
      },
      async (head) => applied.has(head.catalogHeadObjectDigest),
    ), { maxAttempts: 1, retryBackoffMs: 0 });

    receiver.schedule(headAt('4'), 'peer-slow');
    await ambientStarted.promise;
    const verified = receiver.scheduleVerifiedCurrentHeadAndWait([{
      announcement: headAt('4'),
      remotePeerId: 'peer-current',
    }]);
    await settle();

    // Same head, same version: the active writer is left alone and the
    // verified request converges to already-applied once it lands.
    expect(ambientSignal?.aborted).toBe(false);
    expect(receiver.stats()).toMatchObject({ preemptedActive: 0, inFlight: 1, queued: 1 });
    releaseAmbient.resolve();
    await expect(verified).resolves.toMatchObject({ outcome: 'already-applied' });
    await receiver.whenIdle();
    expect(peers).toEqual(['peer-slow']);
    expect(receiver.stats()).toMatchObject({ applied: 1, dedupedAlreadyApplied: 1, preemptedActive: 0 });
  });

  it('never preempts an older active task that is not ambient', async () => {
    const isolatedStarted = deferred<void>();
    const releaseIsolated = deferred<Rfc64PublicCatalogReconcileResultV1>();
    let isolatedSignal: AbortSignal | undefined;
    const versions: string[] = [];
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async (_peerId, head, signal) => {
      versions.push(head.catalogVersion);
      if (head.catalogVersion === '3') {
        isolatedSignal = signal;
        isolatedStarted.resolve();
        return releaseIsolated.promise;
      }
      return 'applied';
    }), { maxAttempts: 1, retryBackoffMs: 0 });

    const isolated = receiver.scheduleManyAndWait([{
      announcement: headAt('3'),
      remotePeerId: 'peer-awaited',
    }]);
    await isolatedStarted.promise;
    const verified = receiver.scheduleVerifiedCurrentHeadAndWait([{
      announcement: headAt('4'),
      remotePeerId: 'peer-current',
    }]);
    await settle();

    expect(isolatedSignal?.aborted).toBe(false);
    expect(receiver.stats()).toMatchObject({ preemptedActive: 0, inFlight: 1, queued: 1 });
    releaseIsolated.resolve('applied');
    await expect(isolated).resolves.toMatchObject({ outcome: 'applied' });
    await expect(verified).resolves.toMatchObject({ outcome: 'applied' });
    expect(versions).toEqual(['3', '4']);
  });
});

// ---------------------------------------------------------------------------
// Service-level fixtures (mirrors rfc64-public-catalog-current-head-discovery-v1.test.ts)
// ---------------------------------------------------------------------------

const NETWORK_ID = 'otp:20430' as const;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/announced-head-retry' as const;
const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const DELEGATION_DIGEST = `0x${'72'.repeat(32)}` as Digest32V1;
/** Short real cadence: libp2p nodes and fake timers do not mix. */
const RETRY_INTERVAL_MS = 150;
const MAX_PULL_ATTEMPTS = 3;

const temporaryDirectories: string[] = [];
const nodes: DKGNode[] = [];
const persistences: Rfc64PersistenceV1[] = [];
const services: Rfc64PublicCatalogServiceV1[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) {
    try { await service.close(); } catch {}
  }
  for (const persistence of persistences.splice(0)) {
    try { await persistence.close(); } catch {}
  }
  for (const node of nodes.splice(0)) {
    try { await node.stop(); } catch {}
  }
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

async function startNode(): Promise<DKGNode> {
  const node = new DKGNode({
    listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
    enableMdns: false,
  });
  nodes.push(node);
  await node.start();
  return node;
}

async function connect(from: DKGNode, to: DKGNode): Promise<void> {
  const address = to.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('test node has no TCP multiaddr');
  await from.libp2p.dial(multiaddr(address));
}

async function openPersistence(label: string): Promise<Rfc64PersistenceV1> {
  const path = await mkdtemp(join(tmpdir(), `dkg-rfc64-announced-head-${label}-`));
  temporaryDirectories.push(path);
  const persistence = await openRfc64PersistenceV1(path, {
    yieldAfterPurgeBatch: async () => {},
  });
  persistences.push(persistence);
  return persistence;
}

function catalogScope(): AuthorCatalogScopeV1 {
  return Object.freeze({
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
}

async function stageHead(persistence: Rfc64PersistenceV1) {
  const produced = await produceEmptyAuthorCatalogGenesisV1({
    scope: catalogScope(),
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    issuedAt: '1773900000000' as TimestampMsV1,
    signer: {
      issuer: AUTHOR,
      signDigest: (digest) => AUTHOR_WALLET.signMessage(digest),
    },
  });
  const verified = await Promise.all(produced.stagedObjects.map(async (envelope) => ({
    envelope,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
  })));
  await persistence.controlObjects.stageVerifiedObjects(verified);
  return produced.head;
}

function acceptPolicy(service: Rfc64PublicCatalogServiceV1) {
  return service.acceptOpenPolicy({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
  });
}

function announcementFor(
  head: Awaited<ReturnType<typeof stageHead>>,
  policyDigest: Digest32V1,
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return Object.freeze({
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    subGraphName: null,
    authorAddress: AUTHOR,
    catalogEra: '0',
    catalogVersion: '0',
    policyDigest,
    catalogHeadObjectDigest: head.objectDigest as Digest32V1,
    signatureVariantDigest: computeControlSignatureVariantDigestHex(
      head.objectDigest,
      head.signature,
    ) as Digest32V1,
  }) as Rfc64PublicCatalogHeadAnnouncementV1;
}

interface ReplicaFixtureV1 {
  readonly requester: Rfc64PublicCatalogServiceV1;
  readonly applied: Set<string>;
  readonly reconcilePeers: string[];
  readonly onAccelerationFailed: ReturnType<
    typeof vi.fn<(event: Rfc64AnnouncedCurrentHeadAccelerationFailureV1) => void>
  >;
  readonly onNotFound: ReturnType<typeof vi.fn>;
}

/**
 * A replica whose native lane is a fake reconciler: the FIRST reconcile (the
 * ambient hint's own pull) misses, so only the acceleration lane's verified
 * pull can apply the head. `alwaysMiss` keeps every pull missing (T3).
 */
function replicaService(
  node: DKGNode,
  persistence: Rfc64PersistenceV1,
  alwaysMiss: boolean,
): ReplicaFixtureV1 {
  const applied = new Set<string>();
  const reconcilePeers: string[] = [];
  const onAccelerationFailed =
    vi.fn<(event: Rfc64AnnouncedCurrentHeadAccelerationFailureV1) => void>();
  const onNotFound = vi.fn();
  const requester = new Rfc64PublicCatalogServiceV1({
    router: new ProtocolRouter(node),
    controlObjects: persistence.controlObjects,
    native: {
      readCatalogObjectByDigest: async () => null,
      readKaBundleByDigest: async () => null,
      createReconciler: () => ({
        isHeadSatisfied: async (head) => applied.has(head.catalogHeadObjectDigest),
        reconcileHead: async (peerId, head) => {
          reconcilePeers.push(peerId);
          if (alwaysMiss || reconcilePeers.length === 1) return 'not-found';
          applied.add(head.catalogHeadObjectDigest);
          return 'applied';
        },
      }),
    },
    currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
    announcedCurrentHeadRetry: { intervalMs: RETRY_INTERVAL_MS, maxAttempts: MAX_PULL_ATTEMPTS },
    onAccelerationFailed,
    receiver: { onNotFound, retryBackoffMs: 0 },
    transportTimeoutMs: 4_000,
  });
  services.push(requester);
  return { requester, applied, reconcilePeers, onAccelerationFailed, onNotFound };
}

type RouterHandler = (
  data: Uint8Array,
  peerId: { toString(): string },
) => Promise<Uint8Array>;

/** In-process router (mirrors rfc64-public-catalog-service-v1.test.ts). */
class RecordingRouter {
  readonly handlers = new Map<string, RouterHandler>();
  readonly sends: Array<Readonly<{
    peerId: string;
    protocolId: string;
    data: Uint8Array;
    options?: SendOptions;
  }>> = [];
  sendResponse: (
    protocolId: string,
    options: SendOptions | undefined,
    peerId: string,
  ) => Promise<Uint8Array> = async () => Uint8Array.of(0);

  register(protocolId: string, handler: RouterHandler): void {
    this.handlers.set(protocolId, handler);
  }

  unregister(protocolId: string): void {
    this.handlers.delete(protocolId);
  }

  async send(
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    options?: SendOptions,
  ): Promise<Uint8Array> {
    this.sends.push(Object.freeze({ peerId, protocolId, data, options }));
    return this.sendResponse(protocolId, options, peerId);
  }

  asProtocolRouter(): ProtocolRouter {
    return this as unknown as ProtocolRouter;
  }

  async invoke(
    protocolId: string,
    data: Uint8Array,
    remotePeerId: string,
  ): Promise<Uint8Array> {
    const handler = this.handlers.get(protocolId);
    if (handler === undefined) throw new Error(`protocol is not registered: ${protocolId}`);
    return handler(data, { toString: () => remotePeerId });
  }
}

function inertControlObjects(): Rfc64ControlObjectOperationsV1 {
  return {
    namespaceDurability: 'posix-hardlink-no-replace-directory-fsync-v1',
    getVerifiedObject: vi.fn(async () => null),
    getVerifiedObjectByDigest: vi.fn(async () => null),
    stageVerifiedObjects: vi.fn(async () => {
      throw new Error('this test never stages control objects');
    }),
  } as unknown as Rfc64ControlObjectOperationsV1;
}

describe('RFC-64 announced-head acceleration re-pull (T2/T3)', () => {
  it('re-pulls after intervalMs when the first pull finds no head, reports it once, and applies the head', async () => {
    const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
      await Promise.all([
        startNode(),
        startNode(),
        openPersistence('provider'),
        openPersistence('requester'),
      ]);
    await connect(requesterNode, providerNode);
    const head = await stageHead(providerPersistence);
    // The provider's FIRST discovery answers a clean not-found (it reads its
    // applied pointer twice per query to confirm a stable snapshot); every
    // later query serves the head. A thrown read is deliberately not used here
    // because the transport layer retries recoverable stream errors on its own.
    let queriesServedEmpty = 0;
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () => {
      if (queriesServedEmpty < 2) {
        queriesServedEmpty += 1;
        return null;
      }
      return head.objectDigest as Digest32V1;
    });
    let failedAt = 0;
    let appliedAt = 0;
    const provider = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(providerNode),
      controlObjects: providerPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest },
      transportTimeoutMs: 4_000,
    });
    services.push(provider);
    const replica = replicaService(requesterNode, requesterPersistence, false);
    replica.onAccelerationFailed.mockImplementation(() => { failedAt = Date.now(); });
    const policy = acceptPolicy(provider);
    acceptPolicy(replica.requester);
    provider.start();
    replica.requester.start();

    const delivery = await provider.announceCatalogHead({
      announcement: announcementFor(head, policy.policyDigest),
      peers: [requesterNode.peerId],
    });
    expect(delivery).toMatchObject({ announcedPeers: [requesterNode.peerId], failedPeers: [] });

    await vi.waitFor(() => {
      expect(replica.applied.has(head.objectDigest)).toBe(true);
    }, { timeout: 20_000, interval: 20 });
    appliedAt = Date.now();
    await replica.requester.whenReceiverIdle();

    // The ambient hint's own miss is now observable, not silent.
    expect(replica.onNotFound).toHaveBeenCalledTimes(1);
    expect(replica.onNotFound.mock.calls[0]![0]).toMatchObject({
      catalogHeadObjectDigest: head.objectDigest,
    });
    // Exactly one failed pass, then the retried pull applied the head.
    expect(replica.onAccelerationFailed).toHaveBeenCalledTimes(1);
    const [failure] = replica.onAccelerationFailed.mock.calls[0]!;
    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure).toMatchObject({
      attempt: 1,
      maxAttempts: MAX_PULL_ATTEMPTS,
      abandoned: false,
      announcedCatalogVersion: '0',
      catalogHeadObjectDigest: head.objectDigest,
      remotePeerIds: [providerNode.peerId],
      scope: { contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR, catalogEra: '0' },
    });
    expect(failure.error).toBeNull();
    // The head was applied by a pull that started no earlier than one retry
    // interval after the failed pass was reported.
    expect(appliedAt - failedAt).toBeGreaterThanOrEqual(RETRY_INTERVAL_MS - 5);
    expect(readCurrentAppliedCatalogHeadDigest.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(replica.reconcilePeers).toEqual([providerNode.peerId, providerNode.peerId]);
    expect(replica.requester.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: 0,
      announcedCurrentHeadRetryArmed: false,
      receiver: { applied: 1, notFound: 1, failed: 0 },
    });
  }, 40_000);

  it('propagates a thrown pull error, re-arms exactly one deadline, and drops after the cap (fake timers)', async () => {
    vi.useFakeTimers();
    const router = new RecordingRouter();
    const discoveryFailure = new Error('provider unreachable');
    router.sendResponse = async (protocolId) => {
      if (protocolId === RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1) {
        throw discoveryFailure;
      }
      return Uint8Array.of(1);
    };
    const onAccelerationFailed =
      vi.fn<(event: Rfc64AnnouncedCurrentHeadAccelerationFailureV1) => void>();
    const onNotFound = vi.fn();
    const reconcilePeers: string[] = [];
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: inertControlObjects(),
      native: {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        createReconciler: () => ({
          isHeadSatisfied: async () => false,
          reconcileHead: async (peerId) => {
            reconcilePeers.push(peerId);
            return 'not-found';
          },
        }),
      },
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
      announcedCurrentHeadRetry: { intervalMs: RETRY_INTERVAL_MS, maxAttempts: 2 },
      onAccelerationFailed,
      receiver: { onNotFound, retryBackoffMs: 0 },
    });
    services.push(service);
    const policy = acceptPolicy(service);
    service.start();
    const hint = announcement({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      catalogVersion: '0',
      policyDigest: policy.policyDigest,
    });

    // The transport ACKs the hint only after the receiver scheduled it and the
    // acceleration lane was requested; neither awaits network work.
    await expect(router.invoke(
      RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
      encodeRfc64PublicCatalogHeadAnnouncementV1(hint),
      'peer-provider',
    )).resolves.toEqual(Uint8Array.of(1));
    await service.whenReceiverIdle();

    expect(reconcilePeers).toEqual(['peer-provider']);
    expect(onNotFound).toHaveBeenCalledTimes(1);
    expect(onAccelerationFailed).toHaveBeenCalledTimes(1);
    const [first] = onAccelerationFailed.mock.calls[0]!;
    expect(first).toMatchObject({
      attempt: 1,
      maxAttempts: 2,
      abandoned: false,
      remotePeerIds: ['peer-provider'],
      catalogHeadObjectDigest: hint.catalogHeadObjectDigest,
    });
    expect(first.error).toBeInstanceOf(AggregateError);
    expect((first.error as AggregateError).errors).toEqual([discoveryFailure]);
    expect(service.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: 1,
      announcedCurrentHeadRetryArmed: true,
    });

    // Nothing runs before the deadline; exactly one re-pull runs at it.
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS - 1);
    expect(onAccelerationFailed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await service.whenReceiverIdle();
    expect(onAccelerationFailed).toHaveBeenCalledTimes(2);
    expect(onAccelerationFailed.mock.calls[1]![0]).toMatchObject({ attempt: 2, abandoned: true });
    expect(service.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: 0,
      announcedCurrentHeadRetryArmed: false,
    });

    // Dropped means dropped: further intervals arm nothing and pull nothing.
    const discoverySends = router.sends.filter(
      ({ protocolId }) => protocolId === RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
    ).length;
    expect(discoverySends).toBe(2);
    await vi.advanceTimersByTimeAsync(5 * RETRY_INTERVAL_MS);
    expect(onAccelerationFailed).toHaveBeenCalledTimes(2);
    expect(router.sends.filter(
      ({ protocolId }) => protocolId === RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
    ).length).toBe(discoverySends);
  });

  it('drops the head after maxAttempts, reports the terminal pass, and arms no further timer', async () => {
    const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
      await Promise.all([
        startNode(),
        startNode(),
        openPersistence('provider'),
        openPersistence('requester'),
      ]);
    await connect(requesterNode, providerNode);
    const head = await stageHead(providerPersistence);
    // The provider has nothing applied: every discovery is a clean not-found.
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () => null);
    const provider = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(providerNode),
      controlObjects: providerPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest },
      transportTimeoutMs: 4_000,
    });
    services.push(provider);
    const replica = replicaService(requesterNode, requesterPersistence, true);
    const policy = acceptPolicy(provider);
    acceptPolicy(replica.requester);
    provider.start();
    replica.requester.start();

    await provider.announceCatalogHead({
      announcement: announcementFor(head, policy.policyDigest),
      peers: [requesterNode.peerId],
    });

    await vi.waitFor(() => {
      expect(replica.onAccelerationFailed).toHaveBeenCalledTimes(MAX_PULL_ATTEMPTS);
    }, { timeout: 20_000, interval: 20 });
    await replica.requester.whenReceiverIdle();

    expect(replica.onAccelerationFailed.mock.calls.map(([event]) => [
      event.attempt,
      event.abandoned,
      event.error,
    ])).toEqual([
      [1, false, null],
      [2, false, null],
      [3, true, null],
    ]);
    expect(replica.applied.size).toBe(0);
    expect(replica.requester.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: 0,
      announcedCurrentHeadRetryArmed: false,
    });

    // No dangling timer: several further intervals produce no pull and no report.
    const providerReadsAtDrop = readCurrentAppliedCatalogHeadDigest.mock.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 5 * RETRY_INTERVAL_MS));
    expect(replica.onAccelerationFailed).toHaveBeenCalledTimes(MAX_PULL_ATTEMPTS);
    expect(readCurrentAppliedCatalogHeadDigest.mock.calls.length).toBe(providerReadsAtDrop);
    expect(replica.requester.stats().announcedCurrentHeadRetryArmed).toBe(false);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Pass-integrity fixtures (T4/T5): an in-process router whose discovery
// answers are gated per provider, so one pass can be held open while hints
// keep arriving.
// ---------------------------------------------------------------------------

/** `MAX_ANNOUNCED_CURRENT_HEAD_SCOPES_V1` (module-private in the service). */
const ANNOUNCED_SCOPE_CAP = 1_024;
/** Long enough that no re-pull deadline fires while a test holds a pass open. */
const HELD_PASS_RETRY_INTERVAL_MS = 60_000;
const FRESH_AUTHOR_BASE = 0x10_0000;

/**
 * Move the wall clock past the first re-pull delay of a retained target, so the
 * next pass takes it too. Timers stay real.
 */
function passFirstRePullDelay(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + HELD_PASS_RETRY_INTERVAL_MS);
}

/** Distinct lowercase author for one announced scope inside the shared open CG. */
function authorAt(index: number): EvmAddressV1 {
  return `0x${'ab'.repeat(16)}${index.toString(16).padStart(8, '0')}` as EvmAddressV1;
}

/**
 * Discovery fake: a held provider keeps its query pending until it is released
 * or the pass aborts; every other provider fails immediately.
 */
class GatedDiscoveryRouter extends RecordingRouter {
  readonly failure = new Error('provider unreachable');
  readonly #held = new Set<string>();
  readonly #pending = new Map<string, Array<() => void>>();

  constructor() {
    super();
    this.sendResponse = (protocolId, options, peerId) => {
      if (protocolId !== RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1) {
        return Promise.resolve(Uint8Array.of(1));
      }
      if (!this.#held.has(peerId)) return Promise.reject(this.failure);
      return new Promise<Uint8Array>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
        const waiters = this.#pending.get(peerId) ?? [];
        waiters.push(() => reject(this.failure));
        this.#pending.set(peerId, waiters);
      });
    };
  }

  hold(...peerIds: readonly string[]): void {
    for (const peerId of peerIds) this.#held.add(peerId);
  }

  /** Fail every pending and future discovery against the provider. */
  release(peerId: string): void {
    this.#held.delete(peerId);
    for (const fail of this.#pending.get(peerId) ?? []) fail();
    this.#pending.delete(peerId);
  }
}

interface HeldPassFixtureV1 {
  readonly router: GatedDiscoveryRouter;
  readonly service: Rfc64PublicCatalogServiceV1;
  readonly onAccelerationFailed: ReturnType<
    typeof vi.fn<(event: Rfc64AnnouncedCurrentHeadAccelerationFailureV1) => void>
  >;
  /** Pending-scope count sampled inside every failure callback: right after any re-insert. */
  readonly pendingAtEvent: number[];
}

function heldPassService(options: Readonly<{
  maxAttempts: number;
  resolveContextGraphAuthority?: Rfc64PublicCatalogServiceOptionsV1['resolveContextGraphAuthority'];
}>): HeldPassFixtureV1 {
  const router = new GatedDiscoveryRouter();
  const pendingAtEvent: number[] = [];
  const onAccelerationFailed =
    vi.fn<(event: Rfc64AnnouncedCurrentHeadAccelerationFailureV1) => void>(() => {
      pendingAtEvent.push(service.stats().announcedCurrentHeadPendingScopes);
    });
  const service = new Rfc64PublicCatalogServiceV1({
    router: router.asProtocolRouter(),
    controlObjects: inertControlObjects(),
    native: {
      readCatalogObjectByDigest: async () => null,
      readKaBundleByDigest: async () => null,
      createReconciler: () => ({
        isHeadSatisfied: async () => false,
        reconcileHead: async () => 'not-found',
      }),
    },
    currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
    announcedCurrentHeadRetry: {
      intervalMs: HELD_PASS_RETRY_INTERVAL_MS,
      maxAttempts: options.maxAttempts,
    },
    onAccelerationFailed,
    receiver: { retryBackoffMs: 0 },
    ...(options.resolveContextGraphAuthority === undefined
      ? {}
      : { resolveContextGraphAuthority: options.resolveContextGraphAuthority }),
  });
  services.push(service);
  return { router, service, onAccelerationFailed, pendingAtEvent };
}

/** The service's default authority shape: an active catalog-apply receiver. */
const catalogApplyAuthority: NonNullable<
  Rfc64PublicCatalogServiceOptionsV1['resolveContextGraphAuthority']
> = (contextGraphId) => Object.freeze({
  contextGraphId,
  selected: false,
  eligible: false,
  active: true,
  mode: 'catalog',
  killSwitchActive: false,
  legacySyncAllowed: true,
  track2Enabled: true,
  authoringAllowed: true,
  reconciliationLane: 'catalog-apply',
});

/** Deliver one policy-admitted hint; the transport ACKs once it is scheduled. */
async function deliverHint(
  router: RecordingRouter,
  head: Rfc64PublicCatalogHeadAnnouncementV1,
  peerId: string,
): Promise<void> {
  const ack = await router.invoke(
    RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
    encodeRfc64PublicCatalogHeadAnnouncementV1(head),
    peerId,
  );
  expect(ack).toEqual(Uint8Array.of(1));
}

describe('RFC-64 announced-head acceleration pass integrity (T4/T5)', () => {
  it('drops only the target whose authority read throws, records the error, and keeps its sibling in the pass', async () => {
    const CG_B = '0x1111111111111111111111111111111111111111/announced-head-retry-b' as const;
    let authorityReadFailure: Error | null = null;
    const { router, service, onAccelerationFailed } = heldPassService({
      maxAttempts: MAX_PULL_ATTEMPTS,
      resolveContextGraphAuthority: (contextGraphId, direction) => {
        if (
          authorityReadFailure !== null
          && contextGraphId === CONTEXT_GRAPH_ID
          && direction === 'receiving'
        ) {
          throw authorityReadFailure;
        }
        return catalogApplyAuthority(contextGraphId, direction);
      },
    });
    const policyA = acceptPolicy(service);
    const policyB = service.acceptOpenPolicy({
      networkId: NETWORK_ID,
      contextGraphId: CG_B,
      ownerAddress: AUTHOR,
    });
    service.start();
    const headA = announcement({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      catalogVersion: '0',
      policyDigest: policyA.policyDigest,
    });
    const headB = announcement({
      contextGraphId: CG_B,
      authorAddress: AUTHOR,
      catalogVersion: '0',
      policyDigest: policyB.policyDigest,
    });

    // Pass 1: A alone fails fast and is retained with one attempt.
    await deliverHint(router, headA, 'peer-a');
    await service.whenReceiverIdle();
    expect(onAccelerationFailed).toHaveBeenCalledTimes(1);
    expect(service.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: 1,
      announcedCurrentHeadRetryArmed: true,
    });

    // Pass 2 starts on B's hint with [A, B], A being due for its re-pull;
    // both discoveries are held open.
    passFirstRePullDelay();
    router.hold('peer-a', 'peer-b');
    await deliverHint(router, headB, 'peer-b');
    expect(service.stats().announcedCurrentHeadPendingScopes).toBe(0);

    // A's authority read now throws. Finish A first so its outcome is settled
    // before B's, then B: the pass must still run B to completion.
    authorityReadFailure = new Error('authority registry unavailable');
    router.release('peer-a');
    await vi.waitFor(() => expect(onAccelerationFailed).toHaveBeenCalledTimes(2));
    router.release('peer-b');
    await service.whenReceiverIdle();

    expect(onAccelerationFailed.mock.calls.map(([event]) => [
      event.scope.contextGraphId,
      event.attempt,
      event.abandoned,
      event.error,
    ])).toEqual([
      [CONTEXT_GRAPH_ID, 1, false, expect.any(AggregateError)],
      [CONTEXT_GRAPH_ID, 2, true, authorityReadFailure],
      [CG_B, 1, false, expect.any(AggregateError)],
    ]);
    // The sibling survived: B is retained and its re-pull deadline is armed.
    expect(service.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: 1,
      announcedCurrentHeadRetryArmed: true,
    });
  });

  it('keeps the announced-scope map at its cap on re-insert: the most-attempted retained target yields, never a fresh hint', async () => {
    const { router, service, onAccelerationFailed, pendingAtEvent } =
      heldPassService({ maxAttempts: MAX_PULL_ATTEMPTS });
    const policy = acceptPolicy(service);
    service.start();
    const headFor = (authorAddress: EvmAddressV1) => announcement({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress,
      catalogVersion: '0',
      policyDigest: policy.policyDigest,
    });
    const A = authorAt(0xa);
    const B = authorAt(0xb);

    // Pass 1: A alone fails fast and is retained with one attempt.
    await deliverHint(router, headFor(A), 'peer-a');
    await service.whenReceiverIdle();
    expect(onAccelerationFailed).toHaveBeenCalledTimes(1);

    // Pass 2 starts on B's hint with [A, B], A being due for its re-pull, and
    // is held open on both.
    passFirstRePullDelay();
    router.hold('peer-a', 'peer-b');
    await deliverHint(router, headFor(B), 'peer-b');
    expect(service.stats().announcedCurrentHeadPendingScopes).toBe(0);
    // Fresh hints refill the cleared map to one below the cap while it runs.
    for (let index = 0; index < ANNOUNCED_SCOPE_CAP - 1; index += 1) {
      await deliverHint(router, headFor(authorAt(FRESH_AUTHOR_BASE + index)), 'peer-fresh');
    }
    expect(service.stats().announcedCurrentHeadPendingScopes).toBe(ANNOUNCED_SCOPE_CAP - 1);

    // A (now two attempts) re-inserts into the last free slot.
    router.release('peer-a');
    await vi.waitFor(() => expect(onAccelerationFailed).toHaveBeenCalledTimes(2));
    expect(service.stats().announcedCurrentHeadPendingScopes).toBe(ANNOUNCED_SCOPE_CAP);
    // B (one attempt) finds the map full: A, the most-attempted retained
    // entry, yields observably; no fresh hint does. The coalesced follow-up
    // pass then pulls every fresh hint once (all fail fast, retained); B waits
    // for its re-pull delay.
    router.release('peer-b');
    await service.whenReceiverIdle();

    const events = onAccelerationFailed.mock.calls.map(([event]) => event);
    expect(events.slice(0, 4).map((event) => [
      event.scope.authorAddress,
      event.attempt,
      event.abandoned,
    ])).toEqual([
      [A, 1, false],
      [A, 2, false],
      [A, 2, true],
      [B, 1, false],
    ]);
    expect(events[2]!.error).toBeInstanceOf(Error);
    expect((events[2]!.error as Error).message).toMatch(/capacity exhausted/);
    expect(events[3]!.error).toBeInstanceOf(AggregateError);
    const followUp = events.slice(4);
    expect(followUp).toHaveLength(ANNOUNCED_SCOPE_CAP - 1);
    const followUpAuthors = new Set(followUp.map((event) => event.scope.authorAddress));
    expect(followUpAuthors.size).toBe(ANNOUNCED_SCOPE_CAP - 1);
    expect(followUpAuthors.has(A)).toBe(false);
    expect(followUpAuthors.has(B)).toBe(false);
    expect(followUp.every((event) => !event.abandoned)).toBe(true);
    // Never above the cap at any re-insert, and at rest exactly at it.
    expect(Math.max(...pendingAtEvent)).toBe(ANNOUNCED_SCOPE_CAP);
    expect(service.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: ANNOUNCED_SCOPE_CAP,
      announcedCurrentHeadRetryArmed: true,
    });
  });

  it('drops the retained target itself, observably, when the cap is held entirely by fresh hints', async () => {
    const { router, service, onAccelerationFailed, pendingAtEvent } =
      heldPassService({ maxAttempts: MAX_PULL_ATTEMPTS });
    const policy = acceptPolicy(service);
    service.start();
    const headFor = (authorAddress: EvmAddressV1) => announcement({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress,
      catalogVersion: '0',
      policyDigest: policy.policyDigest,
    });
    const T = authorAt(0xc);

    // Pass 1 starts on T's hint and is held open; fresh hints fill the map.
    router.hold('peer-t');
    await deliverHint(router, headFor(T), 'peer-t');
    for (let index = 0; index < ANNOUNCED_SCOPE_CAP; index += 1) {
      await deliverHint(router, headFor(authorAt(FRESH_AUTHOR_BASE + index)), 'peer-fresh');
    }
    expect(service.stats().announcedCurrentHeadPendingScopes).toBe(ANNOUNCED_SCOPE_CAP);
    // Admission refuses a new scope at the cap.
    await deliverHint(router, headFor(authorAt(FRESH_AUTHOR_BASE + ANNOUNCED_SCOPE_CAP)), 'peer-fresh');
    expect(service.stats().announcedCurrentHeadPendingScopes).toBe(ANNOUNCED_SCOPE_CAP);

    // T finds no retained work older than itself: it is the one dropped.
    router.release('peer-t');
    await service.whenReceiverIdle();

    const [dropped, ...followUp] = onAccelerationFailed.mock.calls.map(([event]) => event);
    expect(dropped).toMatchObject({
      scope: { authorAddress: T },
      attempt: 1,
      maxAttempts: MAX_PULL_ATTEMPTS,
      abandoned: true,
    });
    expect((dropped!.error as Error).message).toMatch(/capacity exhausted/);
    expect((dropped!.error as Error).cause).toBeInstanceOf(AggregateError);
    // Every fresh hint survived and was pulled exactly once by the follow-up pass.
    expect(followUp).toHaveLength(ANNOUNCED_SCOPE_CAP);
    expect(new Set(followUp.map((event) => event.scope.authorAddress)).size)
      .toBe(ANNOUNCED_SCOPE_CAP);
    expect(followUp.every((event) => (
      event.attempt === 1 && !event.abandoned && event.scope.authorAddress !== T
    ))).toBe(true);
    expect(Math.max(...pendingAtEvent)).toBe(ANNOUNCED_SCOPE_CAP);
    expect(service.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: ANNOUNCED_SCOPE_CAP,
      announcedCurrentHeadRetryArmed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// T6: an announced head that no provider serves. Every pass finds the older
// head the providers hold, and the receiver replays that head (under a receiver
// lease, on a graph with a late legacy SWM marker). The lane must space those
// passes out, and a head whose budget ran out must not start again on the next
// repeat of its hint.
// ---------------------------------------------------------------------------

/** Short real cadence for T6: libp2p nodes and fake timers do not mix. */
const UNSERVED_INTERVAL_MS = 100;
const UNSERVED_MAX_ATTEMPTS = 4;

interface UnservedHeadFixtureV1 {
  readonly provider: Rfc64PublicCatalogServiceV1;
  readonly replica: Rfc64PublicCatalogServiceV1;
  readonly requesterPeerId: string;
  readonly policyDigest: Digest32V1;
  readonly head: Awaited<ReturnType<typeof stageHead>>;
  /** Discovery reads served by the provider. */
  readonly providerReads: ReturnType<typeof vi.fn>;
  /** Reconciles of the provider-served head: one receiver lease each. */
  readonly replays: number[];
  readonly failures: Array<Readonly<{ at: number; event: Rfc64AnnouncedCurrentHeadAccelerationFailureV1 }>>;
}

async function unservedHeadFixture(): Promise<UnservedHeadFixtureV1> {
  const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
    await Promise.all([
      startNode(),
      startNode(),
      openPersistence('unserved-provider'),
      openPersistence('unserved-requester'),
    ]);
  await connect(requesterNode, providerNode);
  const head = await stageHead(providerPersistence);
  // The provider serves the older head it holds, never the announced one.
  const providerReads = vi.fn(async () => head.objectDigest as Digest32V1);
  const provider = new Rfc64PublicCatalogServiceV1({
    router: new ProtocolRouter(providerNode),
    controlObjects: providerPersistence.controlObjects,
    currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: providerReads },
    transportTimeoutMs: 4_000,
  });
  services.push(provider);
  const replays: number[] = [];
  const failures: Array<Readonly<{
    at: number;
    event: Rfc64AnnouncedCurrentHeadAccelerationFailureV1;
  }>> = [];
  const replica = new Rfc64PublicCatalogServiceV1({
    router: new ProtocolRouter(requesterNode),
    controlObjects: requesterPersistence.controlObjects,
    native: {
      readCatalogObjectByDigest: async () => null,
      readKaBundleByDigest: async () => null,
      createReconciler: () => ({
        // The older head always needs a replay; the announced one is never there.
        isHeadSatisfied: async () => false,
        reconcileHead: async (_peerId, announced) => {
          if (announced.catalogHeadObjectDigest !== head.objectDigest) return 'not-found';
          replays.push(Date.now());
          return 'applied';
        },
      }),
    },
    currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
    announcedCurrentHeadRetry: {
      intervalMs: UNSERVED_INTERVAL_MS,
      maxAttempts: UNSERVED_MAX_ATTEMPTS,
    },
    onAccelerationFailed: (event) => { failures.push(Object.freeze({ at: Date.now(), event })); },
    receiver: { retryBackoffMs: 0 },
    transportTimeoutMs: 4_000,
  });
  services.push(replica);
  const policy = acceptPolicy(provider);
  acceptPolicy(replica);
  provider.start();
  replica.start();
  return {
    provider,
    replica,
    requesterPeerId: requesterNode.peerId,
    policyDigest: policy.policyDigest,
    head,
    providerReads,
    replays,
    failures,
  };
}

/** An announcement of a version above the served head, which no provider holds. */
function unservedAnnouncement(
  f: UnservedHeadFixtureV1,
  version: string,
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return Object.freeze({
    ...announcementFor(f.head, f.policyDigest),
    catalogVersion: version,
    catalogHeadObjectDigest: `0x${version.padStart(2, '0').repeat(32)}` as Digest32V1,
  }) as Rfc64PublicCatalogHeadAnnouncementV1;
}

async function announceTo(f: UnservedHeadFixtureV1, version: string): Promise<void> {
  const delivery = await f.provider.announceCatalogHead({
    announcement: unservedAnnouncement(f, version),
    peers: [f.requesterPeerId],
  });
  expect(delivery.failedPeers).toEqual([]);
}

describe('RFC-64 announced head that no provider serves (T6)', () => {
  it('replays the served head once per pass, doubles the delay between passes, then goes quiet', async () => {
    const f = await unservedHeadFixture();
    await announceTo(f, '1');

    await vi.waitFor(() => {
      expect(f.failures).toHaveLength(UNSERVED_MAX_ATTEMPTS);
    }, { timeout: 20_000, interval: 10 });
    await f.replica.whenReceiverIdle();

    expect(f.failures.map(({ event }) => [event.attempt, event.abandoned, event.error])).toEqual([
      [1, false, null],
      [2, false, null],
      [3, false, null],
      [4, true, null],
    ]);
    // Each pass replayed the older head the provider serves: one lease turn each.
    expect(f.replays).toHaveLength(UNSERVED_MAX_ATTEMPTS);
    // The delay before each re-pull doubles: 1, 2 and 4 intervals.
    const gaps = f.failures.slice(1).map(({ at }, index) => at - f.failures[index]!.at);
    gaps.forEach((gap, index) => {
      expect(gap).toBeGreaterThanOrEqual(UNSERVED_INTERVAL_MS * 2 ** index - 5);
    });

    // The provider repeats the hint, as it does on every connect: nothing is pulled.
    const readsAtQuiet = f.providerReads.mock.calls.length;
    await announceTo(f, '1');
    await new Promise<void>((resolve) => setTimeout(resolve, 4 * UNSERVED_INTERVAL_MS));
    await f.replica.whenReceiverIdle();
    expect(f.failures).toHaveLength(UNSERVED_MAX_ATTEMPTS);
    expect(f.replays).toHaveLength(UNSERVED_MAX_ATTEMPTS);
    expect(f.providerReads.mock.calls.length).toBe(readsAtQuiet);
    expect(f.replica.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: 0,
      announcedCurrentHeadRetryArmed: false,
    });

    // A newer head is new work: it is pulled at once, with a fresh budget.
    await announceTo(f, '2');
    await vi.waitFor(() => {
      expect(f.failures).toHaveLength(UNSERVED_MAX_ATTEMPTS + 1);
    }, { timeout: 20_000, interval: 10 });
    expect(f.failures.at(-1)!.event).toMatchObject({
      announcedCatalogVersion: '2',
      attempt: 1,
      abandoned: false,
    });
  }, 60_000);

  it('does not pull a retained head again before its delay when the same hint repeats', async () => {
    const f = await unservedHeadFixture();
    await announceTo(f, '1');
    await vi.waitFor(() => { expect(f.failures).toHaveLength(1); }, { timeout: 20_000, interval: 10 });
    const [first] = f.failures;

    // Repeats arrive well inside the 100 ms delay; the re-pull still waits for it.
    await announceTo(f, '1');
    await announceTo(f, '1');
    await vi.waitFor(() => { expect(f.failures).toHaveLength(2); }, { timeout: 20_000, interval: 5 });
    expect(f.failures[1]!.at - first!.at).toBeGreaterThanOrEqual(UNSERVED_INTERVAL_MS - 5);
    expect(f.replays).toHaveLength(2);
  }, 60_000);
});

describe('RFC-64 announced-head acceleration: a hint repeated during the pass (T7)', () => {
  it('leaves the retained head to its delay instead of pulling it again in the follow-up pass', async () => {
    const { router, service, onAccelerationFailed } = heldPassService({
      maxAttempts: MAX_PULL_ATTEMPTS,
    });
    const policy = acceptPolicy(service);
    service.start();
    const head = announcement({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      catalogVersion: '0',
      policyDigest: policy.policyDigest,
    });

    // Pass 1 is held open on the provider; the same hint arrives again meanwhile.
    router.hold('peer-a');
    await deliverHint(router, head, 'peer-a');
    await deliverHint(router, head, 'peer-a');
    expect(service.stats().announcedCurrentHeadPendingScopes).toBe(1);

    router.release('peer-a');
    await service.whenReceiverIdle();

    // One pull and one report: the follow-up pass found the head not yet due.
    expect(onAccelerationFailed).toHaveBeenCalledTimes(1);
    expect(router.sends.filter(
      ({ protocolId }) => protocolId === RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
    )).toHaveLength(1);
    expect(service.stats()).toMatchObject({
      announcedCurrentHeadPendingScopes: 1,
      announcedCurrentHeadRetryArmed: true,
    });
    // A caller waiting on the graph does not wait out that delay.
    await expect(service.whenReceiverIdleForContextGraph(CONTEXT_GRAPH_ID)).resolves.toBeUndefined();
  });

  it('pulls again in the follow-up pass when the hint came from another provider', async () => {
    const { router, service, onAccelerationFailed } = heldPassService({
      maxAttempts: MAX_PULL_ATTEMPTS,
    });
    const policy = acceptPolicy(service);
    service.start();
    const head = announcement({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      catalogVersion: '0',
      policyDigest: policy.policyDigest,
    });

    router.hold('peer-a');
    await deliverHint(router, head, 'peer-a');
    await deliverHint(router, head, 'peer-b');
    router.release('peer-a');
    await service.whenReceiverIdle();

    // The follow-up pass pulled the head from both providers at once.
    expect(onAccelerationFailed).toHaveBeenCalledTimes(2);
    expect(onAccelerationFailed.mock.calls[1]![0]).toMatchObject({
      attempt: 2,
      remotePeerIds: ['peer-b', 'peer-a'],
    });
  });
});

describe('RFC-64 announced-head acceleration: a retained head another lane applied (T8)', () => {
  function satisfiedLaneService() {
    const router = new GatedDiscoveryRouter();
    const applied = new Set<string>();
    const onAccelerationFailed =
      vi.fn<(event: Rfc64AnnouncedCurrentHeadAccelerationFailureV1) => void>();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: inertControlObjects(),
      native: {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        createReconciler: () => ({
          isHeadSatisfied: async (head) => applied.has(head.catalogHeadObjectDigest),
          isHeadKnownSatisfied: (head) => applied.has(head.catalogHeadObjectDigest),
          reconcileHead: async () => 'not-found',
        }),
      },
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
      announcedCurrentHeadRetry: { intervalMs: HELD_PASS_RETRY_INTERVAL_MS, maxAttempts: MAX_PULL_ATTEMPTS },
      onAccelerationFailed,
      receiver: { retryBackoffMs: 0 },
    });
    services.push(service);
    const policy = acceptPolicy(service);
    service.start();
    const headAtVersion = (catalogVersion: string, digestByte: string) => announcement({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      catalogVersion,
      policyDigest: policy.policyDigest,
      catalogHeadObjectDigest: `0x${digestByte.repeat(32)}` as Digest32V1,
    });
    return { router, service, applied, onAccelerationFailed, headAtVersion };
  }

  it('drops the retained target when a hint for a head that supersedes it is known satisfied', async () => {
    const { router, service, applied, onAccelerationFailed, headAtVersion } = satisfiedLaneService();
    const first = headAtVersion('1', 'c1');
    await deliverHint(router, first, 'peer-a');
    await service.whenReceiverIdle();
    expect(onAccelerationFailed).toHaveBeenCalledTimes(1);
    expect(service.stats().announcedCurrentHeadPendingScopes).toBe(1);

    // The receiver applied a newer head meanwhile; its hint settles the retained target.
    const newer = headAtVersion('2', 'c2');
    applied.add(newer.catalogHeadObjectDigest);
    const scheduledBefore = service.stats().receiver.scheduled;
    await deliverHint(router, newer, 'peer-a');
    expect(service.stats()).toMatchObject({
      announcedHeadsAlreadySatisfied: 1,
      announcedCurrentHeadPendingScopes: 0,
    });
    expect(service.stats().receiver.scheduled).toBe(scheduledBefore);
  });

  it('keeps the retained target for a satisfied hint of the same version with another head', async () => {
    const { router, service, applied, headAtVersion } = satisfiedLaneService();
    await deliverHint(router, headAtVersion('1', 'c1'), 'peer-a');
    await service.whenReceiverIdle();

    const conflicting = headAtVersion('1', 'd1');
    applied.add(conflicting.catalogHeadObjectDigest);
    await deliverHint(router, conflicting, 'peer-a');
    await service.whenReceiverIdle();
    expect(service.stats()).toMatchObject({
      announcedHeadsAlreadySatisfied: 0,
      announcedCurrentHeadPendingScopes: 1,
    });
  });
});

describe('RFC-64 announced-head acceleration: the quiet period covers one exact head (T9)', () => {
  const discoveriesTo = (router: RecordingRouter, peerId: string) => router.sends.filter((send) => (
    send.protocolId === RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1 && send.peerId === peerId
  )).length;

  it('lets an honest lower-version hint pull after a forged high version spent its budget', async () => {
    const { router, service, onAccelerationFailed } = heldPassService({ maxAttempts: 1 });
    const policy = acceptPolicy(service);
    service.start();
    const headAtVersion = (catalogVersion: string, digestByte: string) => announcement({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      catalogVersion,
      policyDigest: policy.policyDigest,
      catalogHeadObjectDigest: `0x${digestByte.repeat(32)}` as Digest32V1,
    });

    // A policy-admitted peer claims a version that does not exist; its one pull fails.
    const forged = headAtVersion('999999', 'f0');
    await deliverHint(router, forged, 'peer-forger');
    await service.whenReceiverIdle();
    expect(onAccelerationFailed.mock.calls.map(([event]) => [event.announcedCatalogVersion, event.abandoned]))
      .toEqual([['999999', true]]);

    // The same claim again is quiet...
    await deliverHint(router, forged, 'peer-forger');
    await service.whenReceiverIdle();
    expect(discoveriesTo(router, 'peer-forger')).toBe(1);

    // ...but an honest provider's hint for a real, lower version is pulled.
    await deliverHint(router, headAtVersion('8', '08'), 'peer-honest');
    await service.whenReceiverIdle();
    expect(discoveriesTo(router, 'peer-honest')).toBe(1);
    expect(onAccelerationFailed.mock.calls.at(-1)![0]).toMatchObject({ announcedCatalogVersion: '8' });

    // And the quiet head itself is pulled again when a provider the lane has not tried names it.
    await deliverHint(router, forged, 'peer-other');
    await service.whenReceiverIdle();
    expect(discoveriesTo(router, 'peer-other')).toBe(1);
  });
});
