// SPDX-License-Identifier: Apache-2.0

/**
 * `whenReceiverIdleForContextGraph` is the barrier a per-context-graph replay
 * pass parks on, and while it is parked that graph's replay-active flag
 * withholds its reported catalog parity. So the wait has to be scoped in BOTH
 * halves: a graph must never be held by another graph's receiver tasks, nor by
 * another graph's pull in the announced-current-head acceleration lane, whose
 * passes await receiver completions of every graph they carry.
 *
 * It must stay fail-closed for the graph's OWN work: an announced head that is
 * not yet satisfied keeps the wait parked until its pull has settled, including
 * the window in which a running pass has emptied the target map and the pull is
 * still in discovery, recorded in neither the map nor the receiver.
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
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import type { Rfc64PublicCatalogReconcileResultV1 } from '../src/rfc64/public-catalog-receiver-v1.js';
import { Rfc64PublicCatalogServiceV1 } from '../src/rfc64/public-catalog-service-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from '../src/rfc64/public-catalog-transport-v1.js';
import {
  openRfc64PersistenceV1,
  type Rfc64PersistenceV1,
} from '../src/rfc64/persistence-v1.js';

const NETWORK_ID = 'otp:20430' as const;
const WEDGED_CG = '0x1111111111111111111111111111111111111111/scoped-idle-wedged' as ContextGraphIdV1;
const OTHER_CG = '0x1111111111111111111111111111111111111111/scoped-idle-other' as ContextGraphIdV1;
const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const DELEGATION_DIGEST = `0x${'72'.repeat(32)}` as Digest32V1;

const temporaryDirectories: string[] = [];
const nodes: DKGNode[] = [];
const persistences: Rfc64PersistenceV1[] = [];
const services: Rfc64PublicCatalogServiceV1[] = [];
/** Every gate a test opened; released on teardown so a failed test cannot hang close(). */
const gates: Array<() => void> = [];

afterEach(async () => {
  for (const release of gates.splice(0)) release();
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

function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  gates.push(open);
  return { opened, open };
}

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
  const path = await mkdtemp(join(tmpdir(), `dkg-rfc64-scoped-idle-${label}-`));
  temporaryDirectories.push(path);
  const persistence = await openRfc64PersistenceV1(path, {
    yieldAfterPurgeBatch: async () => {},
  });
  persistences.push(persistence);
  return persistence;
}

async function stageHead(persistence: Rfc64PersistenceV1, contextGraphId: ContextGraphIdV1) {
  const produced = await produceEmptyAuthorCatalogGenesisV1({
    scope: Object.freeze({
      networkId: NETWORK_ID,
      contextGraphId,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    }) as AuthorCatalogScopeV1,
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

type StagedHeadV1 = Awaited<ReturnType<typeof stageHead>>;

function announcementFor(
  head: StagedHeadV1,
  contextGraphId: ContextGraphIdV1,
  policyDigest: Digest32V1,
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return Object.freeze({
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: NETWORK_ID,
    contextGraphId,
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

type ReconcileBehaviourV1 = (
  head: Rfc64PublicCatalogHeadAnnouncementV1,
  signal: AbortSignal,
) => Promise<Rfc64PublicCatalogReconcileResultV1>;

interface FixtureV1 {
  readonly provider: Rfc64PublicCatalogServiceV1;
  readonly requester: Rfc64PublicCatalogServiceV1;
  readonly requesterPeerId: string;
  /** Digests the requester's fake native lane has durably applied. */
  readonly applied: Set<string>;
  readonly announce: (contextGraphId: ContextGraphIdV1) => Promise<void>;
}

/**
 * Two real nodes. The provider serves one staged head per context graph; the
 * requester's native lane is a fake whose reconcile is scripted per test, and
 * whose satisfaction check reads the same `applied` set the script writes.
 */
async function fixture(options: {
  readonly contextGraphIds: readonly ContextGraphIdV1[];
  readonly reconcile: (applied: Set<string>) => ReconcileBehaviourV1;
  /** Holds the provider's current-head discovery answer for one context graph. */
  readonly discoveryGate?: Readonly<{ contextGraphId: ContextGraphIdV1; opened: Promise<void> }>;
}): Promise<FixtureV1> {
  const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
    await Promise.all([
      startNode(),
      startNode(),
      openPersistence('provider'),
      openPersistence('requester'),
    ]);
  await connect(requesterNode, providerNode);

  const heads = new Map<string, StagedHeadV1>();
  for (const contextGraphId of options.contextGraphIds) {
    heads.set(contextGraphId, await stageHead(providerPersistence, contextGraphId));
  }
  const provider = new Rfc64PublicCatalogServiceV1({
    router: new ProtocolRouter(providerNode),
    controlObjects: providerPersistence.controlObjects,
    currentHeadDiscovery: {
      readCurrentAppliedCatalogHeadDigest: async (scope) => {
        if (options.discoveryGate?.contextGraphId === scope.contextGraphId) {
          await options.discoveryGate.opened;
        }
        return (heads.get(scope.contextGraphId)?.objectDigest ?? null) as Digest32V1 | null;
      },
    },
    transportTimeoutMs: 8_000,
  });
  services.push(provider);

  const applied = new Set<string>();
  const reconcile = options.reconcile(applied);
  const requester = new Rfc64PublicCatalogServiceV1({
    router: new ProtocolRouter(requesterNode),
    controlObjects: requesterPersistence.controlObjects,
    native: {
      readCatalogObjectByDigest: async () => null,
      readKaBundleByDigest: async () => null,
      createReconciler: () => ({
        isHeadSatisfied: async (head) => applied.has(head.catalogHeadObjectDigest),
        reconcileHead: (_peerId, head, signal) => reconcile(head, signal),
      }),
    },
    currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
    // Long on purpose: nothing in these tests may depend on the timed re-pull.
    announcedCurrentHeadRetry: { intervalMs: 60_000, maxAttempts: 3 },
    receiver: { retryBackoffMs: 0, maxAttempts: 1 },
    transportTimeoutMs: 8_000,
  });
  services.push(requester);

  const policyDigests = new Map<string, Digest32V1>();
  for (const contextGraphId of options.contextGraphIds) {
    const accepted = provider.acceptOpenPolicy({
      networkId: NETWORK_ID,
      contextGraphId,
      ownerAddress: AUTHOR,
    });
    requester.acceptOpenPolicy({ networkId: NETWORK_ID, contextGraphId, ownerAddress: AUTHOR });
    policyDigests.set(contextGraphId, accepted.policyDigest);
  }
  provider.start();
  requester.start();

  return {
    provider,
    requester,
    requesterPeerId: requesterNode.peerId,
    applied,
    announce: async (contextGraphId) => {
      const delivery = await provider.announceCatalogHead({
        announcement: announcementFor(
          heads.get(contextGraphId)!,
          contextGraphId,
          policyDigests.get(contextGraphId)!,
        ),
        peers: [requesterNode.peerId],
      });
      expect(delivery).toMatchObject({ announcedPeers: [requesterNode.peerId], failedPeers: [] });
    },
  };
}

/** A reconcile that stays in flight until `opened`, honouring cancellation like a real one. */
function applyOnceOpened(
  applied: Set<string>,
  opened: Promise<void>,
): ReconcileBehaviourV1 {
  return (head, signal) => new Promise((resolve) => {
    const finish = (): void => {
      if (signal.aborted) {
        resolve('not-found');
        return;
      }
      applied.add(head.catalogHeadObjectDigest);
      resolve('applied');
    };
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener('abort', finish, { once: true });
    void opened.then(finish);
  });
}

async function staysPending(wait: Promise<void>, forMs = 400): Promise<boolean> {
  let settled = false;
  void wait.then(() => { settled = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, forMs));
  return !settled;
}

async function settlesSoon(wait: Promise<void>, withinMs = 5_000): Promise<'settled' | 'pending'> {
  return Promise.race([
    wait.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), withinMs)),
  ]);
}

/**
 * Wedge one context graph the way a slow or stuck reconcile does: its ambient
 * task holds the scope lock, so the acceleration pass's equal-version verified
 * task queues behind it and the pass stays open awaiting that completion.
 */
async function wedgeAccelerationPass(f: FixtureV1): Promise<void> {
  await f.announce(WEDGED_CG);
  await vi.waitFor(() => {
    expect(f.requester.stats().receiver).toMatchObject({ inFlight: 1, queued: 1 });
  }, { timeout: 15_000, interval: 20 });
}

describe('RFC-64 public catalog service: per-context-graph idle barrier', () => {
  it('does not hold an idle context graph while another graph wedges the acceleration pass', async () => {
    const wedge = gate();
    const f = await fixture({
      contextGraphIds: [WEDGED_CG],
      reconcile: (applied) => applyOnceOpened(applied, wedge.opened),
    });
    await wedgeAccelerationPass(f);

    // The node is busy in both halves, and stays so until the wedge is released.
    const nodeWide = f.requester.whenReceiverIdle();
    const wedged = f.requester.whenReceiverIdleForContextGraph(WEDGED_CG);
    // A graph with no work of its own is not held by any of it.
    await expect(settlesSoon(f.requester.whenReceiverIdleForContextGraph(OTHER_CG)))
      .resolves.toBe('settled');
    // Fail-closed for the graph that does own the work.
    expect(await staysPending(wedged)).toBe(true);
    expect(await staysPending(nodeWide, 50)).toBe(true);

    wedge.open();
    await expect(settlesSoon(wedged, 15_000)).resolves.toBe('settled');
    await expect(settlesSoon(nodeWide, 15_000)).resolves.toBe('settled');
  }, 60_000);

  it('does not wait for a pull whose announced head is already satisfied', async () => {
    const wedge = gate();
    const f = await fixture({
      contextGraphIds: [WEDGED_CG, OTHER_CG],
      reconcile: (applied) => {
        const wedged = applyOnceOpened(applied, wedge.opened);
        return async (head, signal) => {
          if (head.contextGraphId === WEDGED_CG) return wedged(head, signal);
          applied.add(head.catalogHeadObjectDigest);
          return 'applied';
        };
      },
    });
    await wedgeAccelerationPass(f);

    // This graph's hint arrives while the pass is held open by the other one:
    // its ambient task applies the head, but its own pull can only be recorded,
    // because the lane runs one pass at a time.
    await f.announce(OTHER_CG);
    await vi.waitFor(() => {
      expect(f.requester.stats()).toMatchObject({
        announcedCurrentHeadPendingScopes: 1,
        receiver: { applied: 1, inFlight: 1, queued: 1 },
      });
    }, { timeout: 15_000, interval: 20 });

    // The recorded pull can no longer change what a parity read would see, so
    // waiting for it would only be waiting for the other graph.
    await expect(settlesSoon(f.requester.whenReceiverIdleForContextGraph(OTHER_CG)))
      .resolves.toBe('settled');
    expect(f.requester.stats().announcedCurrentHeadPendingScopes).toBe(1);

    wedge.open();
    await expect(settlesSoon(f.requester.whenReceiverIdle(), 15_000)).resolves.toBe('settled');
  }, 60_000);

  it('stays parked on an unsatisfied head while its pull is in discovery and recorded nowhere', async () => {
    const discovery = gate();
    let reconciles = 0;
    const f = await fixture({
      contextGraphIds: [OTHER_CG],
      discoveryGate: { contextGraphId: OTHER_CG, opened: discovery.opened },
      reconcile: (applied) => async (head) => {
        reconciles += 1;
        // The ambient hint's own pull misses; only the verified pull applies.
        if (reconciles === 1) return 'not-found';
        applied.add(head.catalogHeadObjectDigest);
        return 'applied';
      },
    });
    await f.announce(OTHER_CG);
    // The running pass has emptied the target map and its pull is parked in
    // provider discovery, and the ambient task has already finished: this
    // graph's outstanding work is in neither the map nor the receiver.
    await vi.waitFor(() => {
      expect(f.requester.stats()).toMatchObject({
        announcedCurrentHeadPendingScopes: 0,
        receiver: { notFound: 1, inFlight: 0, queued: 0, deferred: 0 },
      });
    }, { timeout: 15_000, interval: 20 });

    const wait = f.requester.whenReceiverIdleForContextGraph(OTHER_CG);
    expect(await staysPending(wait)).toBe(true);
    expect(f.applied.size).toBe(0);

    discovery.open();
    await expect(settlesSoon(wait, 15_000)).resolves.toBe('settled');
    // Released by the pull settling, and only after its admission was applied.
    expect(f.applied.size).toBe(1);
    expect(f.requester.stats().receiver).toMatchObject({ applied: 1, notFound: 1 });
  }, 60_000);

  it('stays parked on an unsatisfied head whose pull is still only requested, then follows it through', async () => {
    const wedge = gate();
    let otherReconciles = 0;
    const f = await fixture({
      contextGraphIds: [WEDGED_CG, OTHER_CG],
      reconcile: (applied) => {
        const wedged = applyOnceOpened(applied, wedge.opened);
        return async (head, signal) => {
          if (head.contextGraphId === WEDGED_CG) return wedged(head, signal);
          otherReconciles += 1;
          if (otherReconciles === 1) return 'not-found';
          applied.add(head.catalogHeadObjectDigest);
          return 'applied';
        };
      },
    });
    await wedgeAccelerationPass(f);
    await f.announce(OTHER_CG);
    await vi.waitFor(() => {
      expect(f.requester.stats()).toMatchObject({
        announcedCurrentHeadPendingScopes: 1,
        receiver: { notFound: 1, inFlight: 1, queued: 1 },
      });
    }, { timeout: 15_000, interval: 20 });

    // Unsatisfied, with a pull a hint asked for: the graph is genuinely not
    // converged, so the barrier holds even though the pull has not started.
    const wait = f.requester.whenReceiverIdleForContextGraph(OTHER_CG);
    expect(await staysPending(wait)).toBe(true);

    // The open pass ends, the coalesced pass pulls this graph's target, and
    // the wait follows the verified task through the receiver before returning.
    wedge.open();
    await expect(settlesSoon(wait, 15_000)).resolves.toBe('settled');
    expect(f.applied.size).toBe(2);
  }, 60_000);

  it('does not wait out the timed re-pull of a head that could not be pulled', async () => {
    const f = await fixture({
      contextGraphIds: [OTHER_CG],
      reconcile: () => async () => 'not-found',
    });
    await f.announce(OTHER_CG);
    // Ambient miss, then the pull's verified task misses too: the pass retains
    // the target and arms the re-pull deadline (60 s in this fixture).
    await vi.waitFor(() => {
      expect(f.requester.stats()).toMatchObject({
        announcedCurrentHeadPendingScopes: 1,
        announcedCurrentHeadRetryArmed: true,
        receiver: { notFound: 2, inFlight: 0, queued: 0 },
      });
    }, { timeout: 15_000, interval: 20 });

    // The retry budget is the lane's own business, exactly as `whenIdle()`
    // never waited on an armed timer: a caller parked for all of it would hold
    // this graph's replay pass, and the node-wide refresh slot behind it, for
    // minutes on one head nobody can serve.
    await expect(settlesSoon(f.requester.whenReceiverIdleForContextGraph(OTHER_CG)))
      .resolves.toBe('settled');
    expect(f.applied.size).toBe(0);
  }, 60_000);

  it('releases a wait parked on an outstanding pull when that context graph is deactivated', async () => {
    const wedge = gate();
    const f = await fixture({
      contextGraphIds: [WEDGED_CG, OTHER_CG],
      reconcile: (applied) => {
        const wedged = applyOnceOpened(applied, wedge.opened);
        return async (head, signal) => (
          head.contextGraphId === WEDGED_CG ? wedged(head, signal) : 'not-found'
        );
      },
    });
    await wedgeAccelerationPass(f);
    await f.announce(OTHER_CG);
    await vi.waitFor(() => {
      expect(f.requester.stats()).toMatchObject({
        announcedCurrentHeadPendingScopes: 1,
        receiver: { notFound: 1 },
      });
    }, { timeout: 15_000, interval: 20 });

    const wait = f.requester.whenReceiverIdleForContextGraph(OTHER_CG);
    expect(await staysPending(wait)).toBe(true);

    // Its receiver selection ends while the other graph still holds the pass.
    f.requester.deactivateReceiverContextGraph(OTHER_CG);
    await expect(settlesSoon(wait)).resolves.toBe('settled');
    expect(f.requester.stats().announcedCurrentHeadPendingScopes).toBe(0);
  }, 60_000);

  it('re-reads a parked graph when one of its own receiver tasks settles', async () => {
    const wedge = gate();
    let otherReconciles = 0;
    const f = await fixture({
      contextGraphIds: [WEDGED_CG, OTHER_CG],
      reconcile: (applied) => {
        const wedged = applyOnceOpened(applied, wedge.opened);
        return async (head, signal) => {
          if (head.contextGraphId === WEDGED_CG) return wedged(head, signal);
          otherReconciles += 1;
          if (otherReconciles === 1) return 'not-found';
          applied.add(head.catalogHeadObjectDigest);
          return 'applied';
        };
      },
    });
    await wedgeAccelerationPass(f);
    await f.announce(OTHER_CG);
    await vi.waitFor(() => {
      expect(f.requester.stats().receiver).toMatchObject({ notFound: 1 });
    }, { timeout: 15_000, interval: 20 });
    const wait = f.requester.whenReceiverIdleForContextGraph(OTHER_CG);
    expect(await staysPending(wait)).toBe(true);

    // A second hint's ambient task applies the head while the pull is still
    // stuck behind the other graph's pass. No acceleration event fires, yet the
    // head is now satisfied, so the wait must notice through the receiver.
    await f.announce(OTHER_CG);
    await expect(settlesSoon(wait)).resolves.toBe('settled');
    expect(f.applied.size).toBe(1);
    expect(f.requester.stats().announcedCurrentHeadPendingScopes).toBe(1);
  }, 60_000);
});
