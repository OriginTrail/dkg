import {
  SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  computeSwmAuthorInventoryHeadObjectDigestV1,
  computeSwmAuthorInventoryRowsDigestV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedSwmAuthorInventoryHeadEnvelopeV1,
  type SwmAuthorInventoryHeadV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
  type UnsignedSwmAuthorInventoryHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  StorePriorityScheduler,
  isStoreSchedulerBusyError,
  storeLaneInflightLimit,
} from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareRfc64SwmInventoryCatalogTargetV1,
} from '../src/rfc64/swm-inventory-catalog-reconciler-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'41'.repeat(32)}`);
const OTHER_WALLET = new ethers.Wallet(`0x${'42'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430';
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/r1-1-reconcile' as ContextGraphIdV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const ASSERTION_ROOT = `0x${'ab'.repeat(32)}` as Digest32V1;
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/r1> <https://schema.org/name> "R1.1" .\n',
);
const SCOPE = Object.freeze({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: '20430',
  governanceContractAddress: GOVERNANCE,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
}) as SwmAuthorInventoryScopeV1;
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

describe('RFC-64 R1.1 signed SWM inventory to catalog target', () => {
  it('stops dispatch and drains admitted siblings before reporting a failed repair', async () => {
    const seals = await Promise.all(Array.from({ length: 10 }, (_, i) => authorSeal(BigInt(i + 1))));
    const rows = seals.map((seal, i) => ({
      ...inventoryRow(seal, PROJECTION), assertionCoordinate: `draft-${i}`, shareOperationId: `share-${i}`,
    } as SwmAuthorInventoryRowV1));
    const snapshot = await signedSnapshot(rows, AUTHOR_WALLET);
    const failure = new Error('first read failed');
    let failFirst!: () => void;
    let releaseSiblings!: () => void;
    const firstGate = new Promise<void>((resolve) => { failFirst = resolve; });
    const siblingGate = new Promise<void>((resolve) => { releaseSiblings = resolve; });
    let calls = 0;
    const signals: AbortSignal[] = [];
    let settled = false;
    const task = prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset: async (row, signal) => {
        const index = calls++;
        signals.push(signal);
        if (index === 0) {
          await firstGate;
          throw failure;
        }
        await siblingGate; // Deliberately non-cooperative: still physically owned.
        return {
          assertionCoordinate: row.assertionCoordinate,
          projectionBytes: PROJECTION,
          seal: seals.find((seal) => seal.kaUal === row.kaUal)!,
        };
      },
    }).then(() => { settled = true; return null; }, (error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await vi.waitFor(() => expect(calls).toBe(8));
      failFirst();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect.soft(settled).toBe(false);
      expect.soft(calls).toBe(8);
      expect.soft(signals.every((signal) => signal?.aborted)).toBe(true);
    } finally {
      failFirst();
      releaseSiblings();
    }
    expect(await task).toMatchObject({ code: 'swm-catalog-reconcile-resolution', cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(8);
  });

  it('drains admitted reads on caller cancellation without dispatching another row', async () => {
    const seals = await Promise.all(Array.from({ length: 10 }, (_, i) => authorSeal(BigInt(i + 1))));
    const rows = seals.map((seal, i) => ({
      ...inventoryRow(seal, PROJECTION), assertionCoordinate: `cancel-${i}`, shareOperationId: `cancel-share-${i}`,
    } as SwmAuthorInventoryRowV1));
    const snapshot = await signedSnapshot(rows, AUTHOR_WALLET);
    const controller = new AbortController();
    const reason = new Error('closing');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    let settled = false;
    const task = prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot, signal: controller.signal,
      resolveAsset: async (row, signal) => {
        calls++;
        await gate;
        signal.throwIfAborted();
        return { assertionCoordinate: row.assertionCoordinate, projectionBytes: PROJECTION, seal: seals[0]! };
      },
    }).then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(calls).toBe(8));
      controller.abort(reason);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    expect(await task).toBe(reason);
    expect(calls).toBe(8);
  });

  it('authenticates and detaches one complete target before catalog mutation', async () => {
    const seal = await authorSeal();
    const row = inventoryRow(seal, PROJECTION);
    const snapshot = await signedSnapshot([row], AUTHOR_WALLET);
    const callerProjection = new Uint8Array(PROJECTION);
    const resolveAsset = vi.fn(async (resolvedRow: Readonly<SwmAuthorInventoryRowV1>) => ({
      assertionCoordinate: resolvedRow.assertionCoordinate,
      projectionBytes: callerProjection,
      seal,
    }));

    const target = await prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset,
    });
    callerProjection.fill(0);

    expect(resolveAsset).toHaveBeenCalledOnce();
    expect(resolveAsset.mock.calls[0]![0]).not.toBe(row);
    expect(target).toMatchObject({
      inventoryHeadObjectDigest: snapshot.head.objectDigest,
      inventoryScope: SCOPE,
      catalogScope: { ...SCOPE, bucketCount: '1' },
    });
    expect(target.assets).toHaveLength(1);
    expect(target.assets[0]).toMatchObject({
      assertionCoordinate: row.assertionCoordinate,
      seal,
    });
    expect(target.assets[0]!.projectionBytes).toEqual(PROJECTION);
    expect(Object.isFrozen(target.assets)).toBe(true);
    expect(Object.isFrozen(target.assets[0])).toBe(true);
  });

  it('rejects a signed row whose resolver substitutes different projection bytes', async () => {
    const seal = await authorSeal();
    const row = inventoryRow(seal, PROJECTION);
    const snapshot = await signedSnapshot([row], AUTHOR_WALLET);

    await expect(prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset: async () => ({
        assertionCoordinate: row.assertionCoordinate,
        projectionBytes: new TextEncoder().encode(
          '<https://example.org/r1> <https://schema.org/name> "substituted" .\n',
        ),
        seal,
      }),
    })).rejects.toMatchObject({ code: 'swm-catalog-reconcile-binding' });
  });

  it('rejects an inventory head whose signature does not recover to its scoped author', async () => {
    const seal = await authorSeal();
    const row = inventoryRow(seal, PROJECTION);
    const snapshot = await signedSnapshot([row], OTHER_WALLET);
    const resolveAsset = vi.fn();

    await expect(prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset,
    })).rejects.toMatchObject({ code: 'swm-catalog-reconcile-signature' });
    expect(resolveAsset).not.toHaveBeenCalled();
  });
});

describe('RFC-64 R1.1 catalog target fan-out width', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Ten signed rows and a resolver that reports how many rows it holds at once. */
  async function tenRows(read: () => Promise<void>) {
    const seals = await Promise.all(Array.from({ length: 10 }, (_, i) => authorSeal(BigInt(i + 1))));
    const rows = seals.map((seal, i) => ({
      ...inventoryRow(seal, PROJECTION), assertionCoordinate: `width-${i}`, shareOperationId: `width-share-${i}`,
    } as SwmAuthorInventoryRowV1));
    const snapshot = await signedSnapshot(rows, AUTHOR_WALLET);
    const held = { now: 0, most: 0 };
    const resolveAsset = async (row: Readonly<SwmAuthorInventoryRowV1>) => {
      held.now += 1;
      held.most = Math.max(held.most, held.now);
      try {
        await read();
      } finally {
        held.now -= 1;
      }
      return {
        assertionCoordinate: row.assertionCoordinate,
        projectionBytes: PROJECTION,
        seal: seals.find((seal) => seal.kaUal === row.kaUal)!,
      };
    };
    return { snapshot, resolveAsset, held };
  }

  it.each([
    [1, 1],
    [3, 3],
    [8, 8],
    // Never wider than the module's own bound, whatever the caller asks for.
    [100, 8],
  ])('given a width of %i it resolves at most %i rows at once', async (allowed, expected) => {
    const { snapshot, resolveAsset, held } = await tenRows(() => new Promise((resolve) => setTimeout(resolve, 1)));

    const prepared = await prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot, resolveAsset, resolveConcurrency: allowed,
    });

    expect(prepared.assets).toHaveLength(10);
    expect(held.most).toBe(expected);
  });

  it.each([undefined, 0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'keeps its own width of eight for the unusable width %s',
    async (unusable) => {
      const { snapshot, resolveAsset, held } = await tenRows(() => new Promise((resolve) => setTimeout(resolve, 1)));

      await prepareRfc64SwmInventoryCatalogTargetV1({
        snapshot, resolveAsset, resolveConcurrency: unusable,
      });

      expect(held.most).toBe(8);
    },
  );

  describe('through a store lane that admits one read at a time', () => {
    const READ_MS = 30;
    const QUEUE_WAIT_MS = 100;

    /** The store capacity of the incident: one background read at a time. */
    function oneSlotBackgroundLane() {
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 4, ackReservedSlots: 1, healthReservedSlots: 1,
        normalReservedSlots: 1, backgroundReservedSlots: 1,
        queueWaitTimeoutMs: QUEUE_WAIT_MS, now: Date.now,
      });
      const store = { getPressureSnapshot: () => scheduler.snapshot };
      const read = () => scheduler.run(
        'background',
        'agent.rfc64.swmInventory.catalogReconcile.seal',
        () => new Promise<void>((resolve) => setTimeout(resolve, READ_MS)),
      );
      return { scheduler, store, read };
    }

    /** Run the fake clock in small steps, so work queued by one step is seen by the next. */
    async function settle<T>(task: Promise<T>): Promise<T | { readonly failure: unknown }> {
      let settled = false;
      const outcome = task.then((value) => value, (failure: unknown) => ({ failure }))
        .finally(() => { settled = true; });
      for (let step = 0; step < 100 && !settled; step += 1) await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(true);
      return outcome;
    }

    it('fails when it fans out wider: its later reads wait out the deadline behind their siblings', async () => {
      let lane!: ReturnType<typeof oneSlotBackgroundLane>;
      const { snapshot, resolveAsset } = await tenRows(() => lane.read());
      vi.useFakeTimers();
      lane = oneSlotBackgroundLane();

      const outcome = await settle(prepareRfc64SwmInventoryCatalogTargetV1({ snapshot, resolveAsset }));

      expect(outcome).toMatchObject({ failure: { code: 'swm-catalog-reconcile-resolution' } });
      const { cause } = (outcome as { failure: { cause: unknown } }).failure;
      expect(isStoreSchedulerBusyError(cause)).toBe(true);
      expect(cause).toMatchObject({ reason: 'queue_wait_timeout', priority: 'background' });
    });

    it('resolves every row when it is as wide as the lane', async () => {
      let lane!: ReturnType<typeof oneSlotBackgroundLane>;
      const { snapshot, resolveAsset, held } = await tenRows(() => lane.read());
      vi.useFakeTimers();
      lane = oneSlotBackgroundLane();
      const width = storeLaneInflightLimit(lane.store, 'background');

      const outcome = await settle(prepareRfc64SwmInventoryCatalogTargetV1({
        snapshot, resolveAsset, resolveConcurrency: width,
      }));

      expect(width).toBe(1);
      expect(outcome).toMatchObject({ assets: expect.any(Array) });
      expect((outcome as { assets: unknown[] }).assets).toHaveLength(10);
      expect(held.most).toBe(1);
      expect(lane.scheduler.snapshot).toMatchObject({ backgroundInflight: 0, backgroundQueued: 0 });
    });
  });
});

function inventoryRow(
  seal: CanonicalGraphScopedAuthorSealV1,
  projectionBytes: Uint8Array,
): SwmAuthorInventoryRowV1 {
  return Object.freeze({
    assertionCoordinate: 'r1-draft',
    assertionVersion: seal.assertionVersion,
    kaUal: seal.kaUal,
    shareOperationId: 'r1-share-operation',
    projectionDigest: computeKaProjectionDigestV1(projectionBytes),
    publicTripleCount: seal.publicTripleCount,
    privateTripleCount: seal.privateTripleCount,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    sharedAt: '1773900000000',
    expiresAt: null,
  }) as SwmAuthorInventoryRowV1;
}

async function signedSnapshot(
  rows: readonly SwmAuthorInventoryRowV1[],
  signingWallet: ethers.Wallet,
): Promise<SwmAuthorInventorySnapshotV1> {
  const payload = Object.freeze({
    ...SCOPE,
    version: '0',
    previousHeadDigest: null,
    totalRows: rows.length.toString(),
    rowsDigest: computeSwmAuthorInventoryRowsDigestV1(rows),
    issuedAt: '1773900001000',
  }) as SwmAuthorInventoryHeadV1;
  const unsigned = Object.freeze({
    issuer: AUTHOR,
    objectType: SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' as const }),
    signatureSuite: 'eip191-personal-sign-digest-v1' as const,
  }) as UnsignedSwmAuthorInventoryHeadEnvelopeV1;
  const objectDigest = computeSwmAuthorInventoryHeadObjectDigestV1(unsigned);
  const head = Object.freeze({
    ...unsigned,
    objectDigest,
    signature: await signingWallet.signMessage(ethers.getBytes(objectDigest)),
  }) as SignedSwmAuthorInventoryHeadEnvelopeV1;
  return Object.freeze({ head, rows: Object.freeze([...rows]) });
}

async function authorSeal(kaNumber = 7n): Promise<CanonicalGraphScopedAuthorSealV1> {
  const reservedKaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(reservedKaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId,
    assertionFinalizedAt: '2026-08-28T10:00:00.000Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: '1',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}
