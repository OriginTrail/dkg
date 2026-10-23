// SPDX-License-Identifier: Apache-2.0

/**
 * A receiver applies each catalog head of a root scope under a legacy SWM
 * receiver lease, and the leases of all graphs take one node-wide turn at a
 * time. While a head of a scope waits for its turn, more heads of the same
 * scope can be delivered. These tests pin what the next turn of that scope
 * applies: the newest delivered head, in place of every head it supersedes.
 */
import { describe, expect, it } from 'vitest';

import {
  createRfc64LegacySwmFenceCoordinatorV1,
  runRfc64LegacySwmRetirementV1,
  type Rfc64LegacySwmFenceCoordinatorV1,
} from '../src/rfc64/legacy-swm-boundary-fence-v1.js';
import { RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1 } from '../src/rfc64/catalog-head-lineage-v1.js';
import {
  Rfc64PublicCatalogReceiverV1,
  type Rfc64PublicCatalogReconcileResultV1,
} from '../src/rfc64/public-catalog-receiver-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from '../src/rfc64/public-catalog-transport-v1.js';

const CG = '0x1111111111111111111111111111111111111111/new-private-graph';
const STALE_CG = '0x1111111111111111111111111111111111111111/stale-public-graph';

function headAt(version: number, contextGraphId = CG): Rfc64PublicCatalogHeadAnnouncementV1 {
  const digestByte = (version % 256).toString(16).padStart(2, '0');
  return {
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: 'otp:20430',
    contextGraphId,
    subGraphName: null,
    authorAddress: '0x2222222222222222222222222222222222222222',
    catalogEra: '0',
    catalogVersion: String(version),
    policyDigest: `0x${'71'.repeat(32)}`,
    catalogHeadObjectDigest: `0x${digestByte.repeat(32)}`,
    signatureVariantDigest: `0x${'bb'.repeat(32)}`,
  } as Rfc64PublicCatalogHeadAnnouncementV1;
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Another graph's lease holds the node-wide turn until `open()`. */
function holdNodeWideTurn(fence: Rfc64LegacySwmFenceCoordinatorV1): { open: () => void; done: Promise<unknown> } {
  const held = gate();
  const done = runRfc64LegacySwmRetirementV1(
    fence,
    { source: 'receiver-lease', contextGraphId: STALE_CG },
    () => held.promise,
  );
  return { open: held.open, done };
}

interface LeasedReceiverV1 {
  readonly receiver: Rfc64PublicCatalogReceiverV1;
  /** The catalog version each lease turn of {@link CG} applied, in order. */
  readonly leaseTurns: number[];
  readonly applied: () => number;
}

/**
 * A receiver whose reconciler applies a head the way the native receiver
 * does: under one receiver lease of the head's graph. `outcome` lets a test
 * make one version miss.
 */
function leasedReceiver(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  outcome: (version: number) => Rfc64PublicCatalogReconcileResultV1 = () => 'applied',
): LeasedReceiverV1 {
  let applied = 0;
  const leaseTurns: number[] = [];
  const receiver = new Rfc64PublicCatalogReceiverV1({
    isHeadSatisfied: async (head) => Number(head.catalogVersion) <= applied,
    reconcileHead: async (_peerId, head) => {
      const version = Number(head.catalogVersion);
      const result = outcome(version);
      if (result !== 'applied') return result;
      const lease = await runRfc64LegacySwmRetirementV1(
        fence,
        { source: 'receiver-lease', contextGraphId: head.contextGraphId },
        async () => {
          if (head.contextGraphId === CG) leaseTurns.push(version);
          applied = Math.max(applied, version);
        },
      );
      if (!lease.ran) throw new Error('lease was not acquired in time');
      return 'applied';
    },
  }, { maxAttempts: 1, retryBackoffMs: 0 });
  return { receiver, leaseTurns, applied: () => applied };
}

describe('RFC-64 receiver: one lease turn applies the newest delivered head of a scope', () => {
  it('applies a burst of delivered heads in two lease turns, not one turn per head', async () => {
    const fence = createRfc64LegacySwmFenceCoordinatorV1();
    const { receiver, leaseTurns, applied } = leasedReceiver(fence);
    const stale = holdNodeWideTurn(fence);

    // The first head starts and waits for its lease behind the stale graph.
    receiver.schedule(headAt(1), 'member');
    await settle();
    // The member's next five writes are delivered while it waits.
    for (let version = 2; version <= 6; version += 1) receiver.schedule(headAt(version), 'member');
    await settle();
    expect(receiver.stats()).toMatchObject({ inFlight: 1, queued: 5 });

    stale.open();
    await stale.done;
    await receiver.whenIdle();

    expect(applied()).toBe(6);
    expect(leaseTurns).toEqual([1, 6]);
    // The superseded heads still settle, as already applied, without a lease.
    expect(receiver.stats()).toMatchObject({ applied: 2, dedupedAlreadyApplied: 4, failed: 0 });
  });

  it('keeps a caller-awaited head in its place', async () => {
    const fence = createRfc64LegacySwmFenceCoordinatorV1();
    const { receiver, leaseTurns } = leasedReceiver(fence);
    const stale = holdNodeWideTurn(fence);

    receiver.schedule(headAt(1), 'member');
    await settle();
    const awaited = receiver.scheduleManyAndWait([{ announcement: headAt(2), remotePeerId: 'member' }]);
    receiver.schedule(headAt(3), 'member');
    receiver.schedule(headAt(4), 'member');
    stale.open();

    // The awaited head runs in its place; the delivered ones after it coalesce.
    await expect(awaited).resolves.toMatchObject({ outcome: 'applied' });
    await receiver.whenIdle();
    expect(leaseTurns).toEqual([1, 2, 4]);
  });

  it('does not let a later delivered head overtake a caller-awaited one between them', async () => {
    const fence = createRfc64LegacySwmFenceCoordinatorV1();
    const { receiver, leaseTurns } = leasedReceiver(fence);
    const stale = holdNodeWideTurn(fence);

    receiver.schedule(headAt(1), 'member');
    await settle();
    receiver.schedule(headAt(2), 'member');
    const awaited = receiver.scheduleManyAndWait([{ announcement: headAt(3), remotePeerId: 'member' }]);
    receiver.schedule(headAt(4), 'member');
    stale.open();

    // The awaited head is reconciled through its own providers, not reported already applied.
    await expect(awaited).resolves.toMatchObject({ outcome: 'applied' });
    await receiver.whenIdle();
    expect(leaseTurns).toEqual([1, 2, 3, 4]);
  });

  it('still coalesces the delivered heads in front of a caller-awaited one', async () => {
    const fence = createRfc64LegacySwmFenceCoordinatorV1();
    const { receiver, leaseTurns } = leasedReceiver(fence);
    const stale = holdNodeWideTurn(fence);

    receiver.schedule(headAt(1), 'member');
    await settle();
    receiver.schedule(headAt(2), 'member');
    receiver.schedule(headAt(3), 'member');
    const awaited = receiver.scheduleManyAndWait([{ announcement: headAt(4), remotePeerId: 'member' }]);
    stale.open();

    await expect(awaited).resolves.toMatchObject({ outcome: 'applied' });
    await receiver.whenIdle();
    expect(leaseTurns).toEqual([1, 3, 4]);
  });

  it('falls back to the older heads, in order, when the newest one cannot be applied', async () => {
    const fence = createRfc64LegacySwmFenceCoordinatorV1();
    const { receiver, leaseTurns, applied } = leasedReceiver(
      fence,
      (version) => (version === 9 ? 'not-found' : 'applied'),
    );
    const stale = holdNodeWideTurn(fence);

    receiver.schedule(headAt(1), 'member');
    await settle();
    for (const version of [2, 3, 9]) receiver.schedule(headAt(version), 'member');
    await settle();
    stale.open();
    await receiver.whenIdle();

    // 9 was tried first and missed; 2 and 3 were each passed over once already,
    // so they run in delivery order and a newer head cannot jump them again.
    expect(leaseTurns).toEqual([1, 2, 3]);
    expect(applied()).toBe(3);
    expect(receiver.stats()).toMatchObject({ applied: 3, notFound: 1 });
  });

  it('does not jump further than one signed lineage window', async () => {
    const fence = createRfc64LegacySwmFenceCoordinatorV1();
    const { receiver, leaseTurns } = leasedReceiver(fence);
    const stale = holdNodeWideTurn(fence);
    const window = RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1;

    receiver.schedule(headAt(1), 'member');
    await settle();
    for (const version of [2, 3, 2 + window, 3 + window]) receiver.schedule(headAt(version), 'member');
    await settle();
    stale.open();
    await receiver.whenIdle();

    // From 2, the newest head within the window is 2 + window; from there 3 + window.
    expect(leaseTurns).toEqual([1, 2 + window, 3 + window]);
  });

  it('keeps the heads of other scopes in their order', async () => {
    const appliedByGraph = new Map<string, number>();
    const order: string[] = [];
    const receiver = new Rfc64PublicCatalogReceiverV1({
      isHeadSatisfied: async (head) => (
        Number(head.catalogVersion) <= (appliedByGraph.get(head.contextGraphId) ?? 0)
      ),
      reconcileHead: async (_peerId, head) => {
        order.push(`${head.contextGraphId === CG ? 'new' : 'other'}@${head.catalogVersion}`);
        appliedByGraph.set(head.contextGraphId, Number(head.catalogVersion));
        return 'applied';
      },
    }, { maxConcurrent: 1, maxAttempts: 1, retryBackoffMs: 0 });

    receiver.schedule(headAt(1, STALE_CG), 'peer');
    receiver.schedule(headAt(1), 'member');
    receiver.schedule(headAt(2, STALE_CG), 'peer');
    receiver.schedule(headAt(2), 'member');
    await receiver.whenIdle();

    // One slot: each scope gets its turn in delivery order, and the newest
    // queued head of a scope takes the place of its older one.
    // other@1 started at once; new@1 was queued before other@2.
    expect(order).toEqual(['other@1', 'new@2', 'other@2']);
    expect(receiver.stats()).toMatchObject({ applied: 3, dedupedAlreadyApplied: 1 });
  });
});
