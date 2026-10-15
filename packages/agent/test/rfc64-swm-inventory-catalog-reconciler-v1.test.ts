import {
  SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
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
  readCurrentAuthorCatalogScopeV1,
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

describe('RFC-64 catalog target rows the applied catalog already holds (GH#3134)', () => {
  /** Two signed rows, KA 7 and KA 8, and the assets a resolver returns for them. */
  async function twoRows() {
    const seals = [await authorSeal(7n), await authorSeal(8n)];
    const rows = seals.map((seal, index) => Object.freeze({
      ...inventoryRow(seal, PROJECTION),
      assertionCoordinate: `r1-draft-${index}`,
      shareOperationId: `r1-share-operation-${index}`,
    }) as SwmAuthorInventoryRowV1);
    const snapshot = await signedSnapshot(rows, AUTHOR_WALLET);
    const assets = rows.map((row, index) => Object.freeze({
      assertionCoordinate: row.assertionCoordinate,
      projectionBytes: new Uint8Array(PROJECTION),
      seal: seals[index]!,
    }));
    const resolveAsset = vi.fn(async (row: Readonly<SwmAuthorInventoryRowV1>) => (
      assets.find(({ seal }) => seal.kaUal === row.kaUal)!
    ));
    const resolvedAll = await prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset: async (row) => assets.find(({ seal }) => seal.kaUal === row.kaUal)!,
    });
    return { rows, snapshot, assets, resolveAsset, resolvedAll };
  }

  it('uses a placed asset that binds its row exactly, and resolves only the other rows', async () => {
    const { rows, snapshot, assets, resolveAsset, resolvedAll } = await twoRows();

    const readPlacedAssets = vi.fn(async () => (row: Readonly<SwmAuthorInventoryRowV1>) => (
      row.kaUal === rows[0]!.kaUal ? assets[0] : undefined
    ));

    const target = await prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset,
      readPlacedAssets,
    });

    // Asked once, for the catalog the target belongs to.
    expect(readPlacedAssets).toHaveBeenCalledOnce();
    expect(readPlacedAssets.mock.calls[0]).toEqual([{ ...SCOPE, bucketCount: '1' }]);
    expect(resolveAsset).toHaveBeenCalledOnce();
    expect(resolveAsset.mock.calls[0]![0].kaUal).toBe(rows[1]!.kaUal);
    expect(target).toEqual(resolvedAll);
    // The target holds its own copy, as it does of a resolved asset.
    expect(target.assets[0]).not.toBe(assets[0]);
    expect(target.assets[0]!.projectionBytes).not.toBe(assets[0]!.projectionBytes);
    expect(Object.isFrozen(target.assets[0])).toBe(true);
  });

  it.each([
    ['another assertion coordinate', (asset: Record<string, unknown>) => ({ ...asset, assertionCoordinate: 'r1-other' })],
    ['other projection bytes', (asset: Record<string, unknown>) => ({
      ...asset,
      projectionBytes: new TextEncoder().encode('<https://example.org/r1> <https://schema.org/name> "older" .\n'),
    })],
    ['the seal of another KA', (asset: Record<string, unknown>, other: Record<string, unknown>) => ({ ...asset, seal: other.seal })],
    ['something that is not an asset', () => ({ projectionBytes: 'not bytes' })],
  ] as const)('resolves a row whose placed asset is %s', async (_difference, change) => {
    const { rows, snapshot, assets, resolveAsset, resolvedAll } = await twoRows();

    const target = await prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset,
      readPlacedAssets: async () => (row) => (row.kaUal === rows[0]!.kaUal
        ? change({ ...assets[0]! }, { ...assets[1]! }) as never
        : assets[1]),
    });

    expect(resolveAsset).toHaveBeenCalledOnce();
    expect(resolveAsset.mock.calls[0]![0].kaUal).toBe(rows[0]!.kaUal);
    expect(target).toEqual(resolvedAll);
  });

  it('refuses a target larger than its catalog holds before resolving any row', async () => {
    // One bucket holds 1,024 rows; the 1,025th is one more than the catalog of this scope holds.
    const rows = Array.from({ length: 1_025 }, (_, index) => Object.freeze({
      assertionCoordinate: `capacity-${index + 1}`,
      assertionVersion: '1',
      kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${index + 1}`,
      shareOperationId: `capacity-share-${index + 1}`,
      projectionDigest: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      publicTripleCount: '1',
      privateTripleCount: '0',
      sealDigest: `0x${(index + 2).toString(16).padStart(64, '0')}`,
      sharedAt: '1773900000000',
      expiresAt: null,
    }) as SwmAuthorInventoryRowV1);
    const resolveAsset = vi.fn();
    const readPlacedAssets = vi.fn();

    await expect(prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot: await signedSnapshot(rows, AUTHOR_WALLET),
      resolveAsset,
      readPlacedAssets,
    })).rejects.toMatchObject({
      code: 'swm-catalog-reconcile-capacity',
      message: expect.stringContaining('1025 rows exceeds the 1024 rows of a catalog of 1 bucket(s)'),
    });
    // Neither the catalog nor the store was asked for anything.
    expect(resolveAsset).not.toHaveBeenCalled();
    expect(readPlacedAssets).not.toHaveBeenCalled();
  });

  it.each([
    ['cannot be read', async () => { throw new Error('the catalog store is closed'); }],
    ['are not a lookup', async () => 'not a lookup'],
  ] as const)('resolves every row when the placed assets %s', async (_reason, readPlacedAssets) => {
    const { snapshot, resolveAsset, resolvedAll } = await twoRows();

    const target = await prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset,
      readPlacedAssets: readPlacedAssets as never,
    });

    expect(resolveAsset).toHaveBeenCalledTimes(2);
    expect(target).toEqual(resolvedAll);
  });

  it('refuses a reader of placed assets that is not a function', async () => {
    const { snapshot, resolveAsset } = await twoRows();

    await expect(prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset,
      readPlacedAssets: 'not a function' as never,
    })).rejects.toMatchObject({ code: 'swm-catalog-reconcile-input' });
    expect(resolveAsset).not.toHaveBeenCalled();
  });
});

describe('the author\'s current catalog scope (GH#3134)', () => {
  /** Applied heads at these bucket counts of SCOPE's lane, and every bucket count asked for. */
  function inventoryWith(bucketCounts: readonly string[]) {
    const digests = new Map(bucketCounts.map((bucketCount) => [
      computeAuthorCatalogScopeDigestV1({ ...SCOPE, bucketCount } as never),
      bucketCount,
    ]));
    const asked: string[] = [];
    return {
      asked,
      inventory: {
        readAppliedCatalogHeadV1: (catalogScopeDigest: string, authorAddress: string) => {
          expect(authorAddress).toBe(AUTHOR);
          asked.push(digests.get(catalogScopeDigest) ?? 'none');
          return digests.has(catalogScopeDigest) ? ({ catalogScopeDigest } as never) : null;
        },
      },
    };
  }

  it('is the lane\'s largest bucket count with an applied head, and one bucket with none', () => {
    expect(readCurrentAuthorCatalogScopeV1(inventoryWith([]).inventory, SCOPE))
      .toEqual({ ...SCOPE, bucketCount: '1' });
    expect(readCurrentAuthorCatalogScopeV1(inventoryWith(['1']).inventory, SCOPE))
      .toEqual({ ...SCOPE, bucketCount: '1' });
    // After a move the author keeps the one-bucket head to serve; the moved catalog is current.
    expect(readCurrentAuthorCatalogScopeV1(inventoryWith(['1', '4']).inventory, SCOPE))
      .toEqual({ ...SCOPE, bucketCount: '4' });
    expect(readCurrentAuthorCatalogScopeV1(inventoryWith(['1', '4', '65536']).inventory, SCOPE))
      .toEqual({ ...SCOPE, bucketCount: '65536' });
  });

  it('asks for 65,536 buckets down to two, largest first, and for nothing larger', () => {
    const probed = inventoryWith(['131072']);

    expect(readCurrentAuthorCatalogScopeV1(probed.inventory, SCOPE)).toEqual({ ...SCOPE, bucketCount: '1' });
    expect(probed.asked).toHaveLength(16);
    expect(probed.asked).not.toContain('131072');
  });

  it('prepares the target of the current catalog, bounded by that catalog\'s capacity', async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => Object.freeze({
      assertionCoordinate: `capacity-${index + 1}`,
      assertionVersion: '1',
      kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${index + 1}`,
      shareOperationId: `capacity-share-${index + 1}`,
      projectionDigest: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      publicTripleCount: '1',
      privateTripleCount: '0',
      sealDigest: `0x${(index + 2).toString(16).padStart(64, '0')}`,
      sharedAt: '1773900000000',
      expiresAt: null,
    }) as SwmAuthorInventoryRowV1);
    const twoBuckets = () => ({ ...SCOPE, bucketCount: '2' }) as never;

    // 1,025 rows fit a catalog of two buckets: past the capacity check, into resolution.
    const readPlacedAssets = vi.fn(async () => () => undefined);
    await expect(prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot: await signedSnapshot(rows(1_025), AUTHOR_WALLET),
      resolveAsset: async () => { throw new Error('stop here'); },
      readPlacedAssets,
      currentCatalogScope: twoBuckets,
    })).rejects.toMatchObject({ code: 'swm-catalog-reconcile-resolution' });
    expect(readPlacedAssets).toHaveBeenCalledWith({ ...SCOPE, bucketCount: '2' });

    // 2,049 do not.
    await expect(prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot: await signedSnapshot(rows(2_049), AUTHOR_WALLET),
      resolveAsset: vi.fn(),
      currentCatalogScope: twoBuckets,
    })).rejects.toMatchObject({
      code: 'swm-catalog-reconcile-capacity',
      message: expect.stringContaining('2049 rows exceeds the 2048 rows of a catalog of 2 bucket(s)'),
    });
  });

  it.each([
    ['another graph', { contextGraphId: '99' }],
    ['another author', { authorAddress: `0x${'43'.repeat(20)}` }],
    ['a bucket count that is not a catalog\'s', { bucketCount: '3' }],
    ['a missing bucket count', { bucketCount: undefined }],
  ] as const)('refuses a current catalog scope with %s', async (_difference, change) => {
    const seal = await authorSeal();
    const resolveAsset = vi.fn();

    await expect(prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot: await signedSnapshot([inventoryRow(seal, PROJECTION)], AUTHOR_WALLET),
      resolveAsset,
      currentCatalogScope: () => ({ ...SCOPE, bucketCount: '1', ...change }) as never,
    })).rejects.toMatchObject({ code: 'swm-catalog-reconcile-input' });
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
