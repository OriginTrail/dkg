// SPDX-License-Identifier: Apache-2.0

import {
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/dkg-agent.js';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';

import { mapWithConcurrency } from '../src/map-with-concurrency.js';
import {
  loadRfc64OperationalAppliedHeadsV1,
  type Rfc64OperationalAppliedHeadV1,
  type Rfc64OperationalAppliedHeadsStorageV1,
} from '../src/rfc64/catalog-operational-applied-heads-v1.js';
import { Rfc64ControlObjectStoreErrorV1 } from '../src/rfc64/control-object-store-v1.js';
import {
  createAppliedCatalogHeadsSnapshotV1,
  type AppliedCatalogHeadSnapshotV1,
} from '../src/rfc64/inventory-v1/index.js';

const NETWORK_ID = 'hardhat1';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const OTHER_AUTHOR = '0x2222222222222222222222222222222222222222';
const DELEGATION_DIGEST = `0x${'66'.repeat(32)}` as Digest32V1;
const APPLIED_INVENTORY_DIGEST = `0x${'99'.repeat(32)}` as Digest32V1;
const OTHER_APPLIED_INVENTORY_DIGEST = `0x${'98'.repeat(32)}` as Digest32V1;
const SIGNATURE = `0x${'77'.repeat(65)}`;

function catalogScope(
  contextGraphId: string,
  authorAddress = AUTHOR,
  subGraphName: string | null = null,
): Readonly<AuthorCatalogScopeV1> {
  return Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName,
    authorAddress,
    era: '0',
    bucketCount: '1',
  }) as AuthorCatalogScopeV1;
}

function signedHead(
  scope: Readonly<AuthorCatalogScopeV1>,
  version: string,
): SignedAuthorCatalogHeadEnvelopeV1 {
  const directoryByte = (BigInt(version) + 1n).toString(16).padStart(2, '0');
  const payload = Object.freeze({
    ...scope,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    version,
    previousHeadDigest: null,
    totalRows: version,
    directoryHeight: '0',
    directoryRootDigest: `0x${directoryByte.repeat(32)}`,
    issuedAt: String(1_773_900_000_000n + BigInt(version)),
  }) as AuthorCatalogHeadV1;
  const unsigned = Object.freeze({
    issuer: scope.authorAddress,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }) as unknown as UnsignedControlEnvelopeV1;
  const head = Object.freeze({
    ...unsigned,
    objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsigned),
    signature: SIGNATURE,
  });
  assertSignedAuthorCatalogHeadEnvelopeV1(head);
  return head;
}

function appliedSnapshot(
  head: Readonly<SignedAuthorCatalogHeadEnvelopeV1>,
  appliedInventoryDigest = APPLIED_INVENTORY_DIGEST,
): AppliedCatalogHeadSnapshotV1 {
  const scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
  return Object.freeze({
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    authorAddress: head.payload.authorAddress,
    currentCatalogHeadDigest: head.objectDigest as Digest32V1,
    appliedInventoryDigest,
    catalogVersion: head.payload.version,
    inventoryRowCount: head.payload.totalRows,
  });
}

type StoredHeadFaultV1 = 'missing' | 'verification' | 'not-a-head' | 'closed';

/**
 * A persistence fake that counts every head-object read and inventory
 * snapshot read. Every write lists the inventory again (`setInventory`, or
 * `relist` for a write that changed nothing), as the durable inventory does.
 */
function createStorageFixture(
  initialHeads: readonly SignedAuthorCatalogHeadEnvelopeV1[],
) {
  let inventory = createAppliedCatalogHeadsSnapshotV1(
    initialHeads.map((head) => appliedSnapshot(head)),
  );
  const objects = new Map<string, SignedAuthorCatalogHeadEnvelopeV1>();
  const faults = new Map<string, StoredHeadFaultV1>();
  const reads: Digest32V1[] = [];
  let snapshotReads = 0;
  let listingFailure: Error | null = null;
  let hold: Promise<void> | null = null;
  const store = (...heads: readonly SignedAuthorCatalogHeadEnvelopeV1[]) => {
    for (const head of heads) objects.set(head.objectDigest, head);
  };
  store(...initialHeads);
  const storage: Rfc64OperationalAppliedHeadsStorageV1 = Object.freeze({
    inventory: Object.freeze({
      readAppliedCatalogHeadsSnapshotV1: () => {
        snapshotReads += 1;
        if (listingFailure !== null) throw listingFailure;
        return inventory;
      },
    }),
    controlObjects: Object.freeze({
      getVerifiedObjectByDigest: (input: { readonly objectDigest: Digest32V1 }) => {
        const fault = faults.get(input.objectDigest);
        // Like the real store, a closed store refuses synchronously.
        if (fault === 'closed') {
          throw new Rfc64ControlObjectStoreErrorV1('control-store-closed', 'store is closed');
        }
        reads.push(input.objectDigest);
        return (async () => {
          if (hold !== null) await hold;
          if (fault === 'verification') {
            throw new Rfc64ControlObjectStoreErrorV1(
              'control-store-verification',
              'stored control object signature verification failed',
            );
          }
          const head = objects.get(input.objectDigest);
          if (head === undefined || fault === 'missing') return null;
          const envelope: SignedControlEnvelopeV1 = fault === 'not-a-head'
            ? Object.freeze({ ...head, objectType: 'dkg.not-an-author-catalog-head.v1' }) as never
            : head;
          return Object.freeze({ envelope, issuerSignature: Object.freeze({}) as never });
        })();
      },
    }),
  }) as Rfc64OperationalAppliedHeadsStorageV1;
  return {
    storage,
    reads,
    get snapshotReads() {
      return snapshotReads;
    },
    store,
    setInventory(next: readonly AppliedCatalogHeadSnapshotV1[]) {
      inventory = createAppliedCatalogHeadsSnapshotV1(next);
    },
    /** A write that changed no row: the same rows, listed again. */
    relist() {
      inventory = createAppliedCatalogHeadsSnapshotV1(inventory.heads);
    },
    get snapshot() {
      return inventory;
    },
    get inventory() {
      return inventory.heads;
    },
    fault(digest: string, fault: StoredHeadFaultV1 | null) {
      if (fault === null) faults.delete(digest);
      else faults.set(digest, fault);
    },
    failListing(error: Error | null) {
      listingFailure = error;
    },
    /** Hold reads started from now on; the returned function releases them. */
    holdReads() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => { release = resolve; });
      return () => {
        hold = null;
        release();
      };
    },
    /** Let reads started from now on through, while held ones stay held. */
    readFreely() {
      hold = null;
    },
  };
}

/**
 * The pre-cache implementation, verbatim apart from its storage parameter and
 * reading the listing from the inventory snapshot: the oracle every cached
 * result must equal.
 */
async function loadUncachedOperationalAppliedHeads(
  persistence: Rfc64OperationalAppliedHeadsStorageV1,
): Promise<readonly Readonly<Rfc64OperationalAppliedHeadV1>[]> {
  const scopeKey = (input: Readonly<{
    networkId: string;
    contextGraphId: string;
    subGraphName: string | null;
    authorAddress: string;
    catalogEra: string;
  }>): string => [
    input.networkId,
    input.contextGraphId,
    input.subGraphName ?? '',
    input.authorAddress.toLowerCase(),
    input.catalogEra,
  ].join('\0');
  const snapshots = persistence.inventory.readAppliedCatalogHeadsSnapshotV1().heads;
  const loaded = await mapWithConcurrency(
    snapshots,
    8,
    async (snapshot): Promise<Readonly<Rfc64OperationalAppliedHeadV1> | null> => {
      const stored = await persistence.controlObjects.getVerifiedObjectByDigest({
        objectDigest: snapshot.currentCatalogHeadDigest,
        verifyIssuerSignature: async () => { throw new Error('the fake store never verifies'); },
      }).catch(() => null);
      if (stored === null) return null;
      try {
        assertSignedAuthorCatalogHeadEnvelopeV1(stored.envelope);
      } catch {
        return null;
      }
      const payload = stored.envelope.payload;
      return Object.freeze({
        snapshot,
        issuedAt: payload.issuedAt,
        contextGraphId: payload.contextGraphId,
        scopeKey: scopeKey({
          networkId: payload.networkId,
          contextGraphId: payload.contextGraphId,
          subGraphName: payload.subGraphName,
          authorAddress: payload.authorAddress,
          catalogEra: payload.era,
        }),
      });
    },
  );
  return Object.freeze(loaded.filter(
    (head): head is Readonly<Rfc64OperationalAppliedHeadV1> => head !== null,
  ));
}

/** Compare against the oracle over a separate fixture holding the same state. */
async function expectMatchesUncached(
  fixture: ReturnType<typeof createStorageFixture>,
  objects: readonly SignedAuthorCatalogHeadEnvelopeV1[],
  faults: ReadonlyMap<string, StoredHeadFaultV1> = new Map(),
): Promise<readonly Readonly<Rfc64OperationalAppliedHeadV1>[]> {
  const oracle = createStorageFixture([]);
  oracle.store(...objects);
  oracle.setInventory(fixture.inventory);
  for (const [digest, fault] of faults) oracle.fault(digest, fault);
  const expected = await loadUncachedOperationalAppliedHeads(oracle.storage);
  const actual = await loadRfc64OperationalAppliedHeadsV1(fixture.storage);
  expect(actual).toEqual(expected);
  expect(actual.map((head) => head.snapshot.currentCatalogHeadDigest))
    .toEqual(expected.map((head) => head.snapshot.currentCatalogHeadDigest));
  expect(Object.isFrozen(actual)).toBe(true);
  return actual;
}

const HEAD_A1 = signedHead(catalogScope(`${AUTHOR}/alpha`), '1');
const HEAD_A2 = signedHead(catalogScope(`${AUTHOR}/alpha`), '2');
const HEAD_B1 = signedHead(catalogScope(`${AUTHOR}/beta`, OTHER_AUTHOR), '1');
const HEAD_C1 = signedHead(catalogScope(`${AUTHOR}/gamma`, AUTHOR, 'sub'), '1');
const HEAD_D3 = signedHead(catalogScope(`${AUTHOR}/delta`), '3');
const ALL_OBJECTS = [HEAD_A1, HEAD_A2, HEAD_B1, HEAD_C1];

describe('RFC-64 operational applied heads', () => {
  it('reads and verifies each head once while the inventory is unchanged', async () => {
    const fixture = createStorageFixture([HEAD_A1, HEAD_B1, HEAD_C1]);

    const first = await loadRfc64OperationalAppliedHeadsV1(fixture.storage);
    expect(first.map((head) => head.snapshot.currentCatalogHeadDigest)).toEqual(
      fixture.inventory.map((snapshot) => snapshot.currentCatalogHeadDigest),
    );
    expect(fixture.reads).toHaveLength(3);

    for (let call = 0; call < 25; call += 1) {
      expect(await loadRfc64OperationalAppliedHeadsV1(fixture.storage)).toBe(first);
    }
    expect(fixture.reads).toHaveLength(3);
    // The inventory snapshot is read every call: that is the invalidation.
    expect(fixture.snapshotReads).toBe(26);
  });

  it('shares one load between concurrent callers that list the same inventory', async () => {
    const fixture = createStorageFixture([HEAD_A1, HEAD_B1, HEAD_C1]);
    const release = fixture.holdReads();

    const pending = Array.from({ length: 6 }, () =>
      loadRfc64OperationalAppliedHeadsV1(fixture.storage));
    await Promise.resolve();
    release();
    const results = await Promise.all(pending);

    expect(fixture.reads).toHaveLength(3);
    for (const result of results) expect(result).toBe(results[0]);
    expect(results[0]).toHaveLength(3);
  });

  it('sees a head applied, replaced or removed on the very next call', async () => {
    const fixture = createStorageFixture([HEAD_A1]);
    fixture.store(...ALL_OBJECTS);
    await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(fixture.reads).toEqual([HEAD_A1.objectDigest]);

    // Applied: only the new head is read; the verified one is reused.
    fixture.setInventory([appliedSnapshot(HEAD_A1), appliedSnapshot(HEAD_B1)]);
    const applied = await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(applied.map((head) => head.snapshot.currentCatalogHeadDigest))
      .toEqual([HEAD_A1.objectDigest, HEAD_B1.objectDigest]);
    expect(fixture.reads).toEqual([HEAD_A1.objectDigest, HEAD_B1.objectDigest]);

    // Replaced: the same scope and author advance to a new head.
    fixture.setInventory([appliedSnapshot(HEAD_A2), appliedSnapshot(HEAD_B1)]);
    const replaced = await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(replaced[0]!.snapshot.catalogVersion).toBe('2');
    expect(replaced[0]!.snapshot.currentCatalogHeadDigest).toBe(HEAD_A2.objectDigest);
    expect(replaced[0]!.issuedAt).toBe(HEAD_A2.payload.issuedAt);
    expect(fixture.reads.at(-1)).toBe(HEAD_A2.objectDigest);

    // Removed.
    fixture.setInventory([appliedSnapshot(HEAD_B1)]);
    const removed = await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(removed.map((head) => head.snapshot.currentCatalogHeadDigest))
      .toEqual([HEAD_B1.objectDigest]);

    // Removal prunes the reuse set: a head that returns is read again.
    const readsBeforeReturn = fixture.reads.length;
    fixture.setInventory([appliedSnapshot(HEAD_A2), appliedSnapshot(HEAD_B1)]);
    await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(fixture.reads.slice(readsBeforeReturn)).toEqual([HEAD_A2.objectDigest]);

    // Emptied.
    fixture.setInventory([]);
    expect(await expectMatchesUncached(fixture, ALL_OBJECTS)).toEqual([]);
  });

  it('keys every snapshot field, not only the head digest', async () => {
    const fixture = createStorageFixture([HEAD_A1, HEAD_B1]);
    await loadRfc64OperationalAppliedHeadsV1(fixture.storage);
    const readsAfterFirst = fixture.reads.length;

    const variants: Array<Partial<AppliedCatalogHeadSnapshotV1>> = [
      { appliedInventoryDigest: OTHER_APPLIED_INVENTORY_DIGEST },
      { inventoryRowCount: '7' as AppliedCatalogHeadSnapshotV1['inventoryRowCount'] },
      { catalogVersion: '9' as AppliedCatalogHeadSnapshotV1['catalogVersion'] },
      { authorAddress: OTHER_AUTHOR as AppliedCatalogHeadSnapshotV1['authorAddress'] },
      { catalogScopeDigest: `0x${'55'.repeat(32)}` as Digest32V1 },
    ];
    for (const variant of variants) {
      const changed = Object.freeze({ ...appliedSnapshot(HEAD_A1), ...variant });
      fixture.setInventory([changed, appliedSnapshot(HEAD_B1)]);
      const heads = await expectMatchesUncached(fixture, ALL_OBJECTS);
      expect(heads[0]!.snapshot).toEqual(changed);
    }
    // The head objects did not change, so none of those rows re-read them.
    expect(fixture.reads).toHaveLength(readsAfterFirst);

    // Row order is part of the key: the result keeps listing order.
    fixture.setInventory([appliedSnapshot(HEAD_B1), appliedSnapshot(HEAD_A1)]);
    const reordered = await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(reordered.map((head) => head.snapshot.currentCatalogHeadDigest))
      .toEqual([HEAD_B1.objectDigest, HEAD_A1.objectDigest]);
  });

  it.each([
    'verification',
    'missing',
    'not-a-head',
  ] as const)('leaves out a %s head as before and never caches that answer', async (fault) => {
    const fixture = createStorageFixture([HEAD_A1, HEAD_B1, HEAD_C1]);
    fixture.fault(HEAD_B1.objectDigest, fault);
    const faults = new Map([[HEAD_B1.objectDigest, fault]]);

    const first = await expectMatchesUncached(fixture, ALL_OBJECTS, faults);
    expect(first.map((head) => head.snapshot.currentCatalogHeadDigest))
      .toEqual([HEAD_A1.objectDigest, HEAD_C1.objectDigest]);

    // Still failing: every call retries the failed head, and only that one.
    const readsAfterFirst = fixture.reads.length;
    await expectMatchesUncached(fixture, ALL_OBJECTS, faults);
    await expectMatchesUncached(fixture, ALL_OBJECTS, faults);
    expect(fixture.reads.slice(readsAfterFirst))
      .toEqual([HEAD_B1.objectDigest, HEAD_B1.objectDigest]);

    // Once it reads back and verifies, the next call includes it.
    fixture.fault(HEAD_B1.objectDigest, null);
    const recovered = await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(recovered.map((head) => head.snapshot.currentCatalogHeadDigest))
      .toEqual([HEAD_A1.objectDigest, HEAD_B1.objectDigest, HEAD_C1.objectDigest]);

    // Now complete, so it is reused without reading.
    const readsAfterRecovery = fixture.reads.length;
    expect(await loadRfc64OperationalAppliedHeadsV1(fixture.storage)).toBe(recovered);
    expect(fixture.reads).toHaveLength(readsAfterRecovery);
  });

  it('rejects like the uncached load when the store refuses, and caches nothing', async () => {
    const fixture = createStorageFixture([HEAD_A1, HEAD_B1]);
    const oracle = createStorageFixture([HEAD_A1, HEAD_B1]);
    fixture.fault(HEAD_B1.objectDigest, 'closed');
    oracle.fault(HEAD_B1.objectDigest, 'closed');

    const expected = await loadUncachedOperationalAppliedHeads(oracle.storage)
      .then(() => null, (error: unknown) => error);
    expect(expected).toBeInstanceOf(Rfc64ControlObjectStoreErrorV1);
    await expect(loadRfc64OperationalAppliedHeadsV1(fixture.storage))
      .rejects.toThrow((expected as Error).message);

    fixture.fault(HEAD_B1.objectDigest, null);
    const readsBefore = fixture.reads.length;
    await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(fixture.reads.slice(readsBefore)).toEqual([HEAD_A1.objectDigest, HEAD_B1.objectDigest]);
  });

  it('rejects when the inventory cannot be listed, even with a cached answer', async () => {
    const fixture = createStorageFixture([HEAD_A1]);
    await loadRfc64OperationalAppliedHeadsV1(fixture.storage);

    fixture.failListing(new Error('RFC-64 persistence owner is closed'));
    await expect(loadRfc64OperationalAppliedHeadsV1(fixture.storage))
      .rejects.toThrow('RFC-64 persistence owner is closed');
    await expect(loadUncachedOperationalAppliedHeads(fixture.storage))
      .rejects.toThrow('RFC-64 persistence owner is closed');
  });

  it('keeps each persistence instance separate', async () => {
    const first = createStorageFixture([HEAD_A1, HEAD_B1]);
    const second = createStorageFixture([HEAD_A1, HEAD_B1]);
    second.fault(HEAD_B1.objectDigest, 'missing');

    const fromFirst = await loadRfc64OperationalAppliedHeadsV1(first.storage);
    const fromSecond = await loadRfc64OperationalAppliedHeadsV1(second.storage);

    expect(fromFirst).toHaveLength(2);
    expect(fromSecond.map((head) => head.snapshot.currentCatalogHeadDigest))
      .toEqual([HEAD_A1.objectDigest]);
    expect(second.reads).toEqual([HEAD_A1.objectDigest, HEAD_B1.objectDigest]);
  });

  it('does not let a slower load of an older inventory replace a newer one', async () => {
    const fixture = createStorageFixture([HEAD_A1]);
    fixture.store(HEAD_A2);
    const releaseOlder = fixture.holdReads();
    const older = loadRfc64OperationalAppliedHeadsV1(fixture.storage);
    fixture.readFreely();

    // The newer inventory's load settles first; the older one after it.
    fixture.setInventory([appliedSnapshot(HEAD_A2)]);
    const newerHeads = await loadRfc64OperationalAppliedHeadsV1(fixture.storage);
    releaseOlder();
    const olderHeads = await older;

    expect(olderHeads.map((head) => head.snapshot.currentCatalogHeadDigest))
      .toEqual([HEAD_A1.objectDigest]);
    expect(newerHeads.map((head) => head.snapshot.currentCatalogHeadDigest))
      .toEqual([HEAD_A2.objectDigest]);

    const readsBefore = fixture.reads.length;
    expect(await loadRfc64OperationalAppliedHeadsV1(fixture.storage)).toBe(newerHeads);
    expect(fixture.reads).toHaveLength(readsBefore);
  });

  it('matches the uncached load across mixed inventories', async () => {
    // Stored head objects are immutable, so a fault only ever hits a head this
    // fixture has not verified yet: one that has not reached the store, or
    // that reads back invalid.
    const inventories: Array<{
      readonly rows: readonly AppliedCatalogHeadSnapshotV1[];
      readonly faults?: ReadonlyMap<string, StoredHeadFaultV1>;
    }> = [
      { rows: [] },
      { rows: [appliedSnapshot(HEAD_C1)] },
      { rows: [appliedSnapshot(HEAD_A1), appliedSnapshot(HEAD_B1), appliedSnapshot(HEAD_C1)] },
      {
        rows: [
          appliedSnapshot(HEAD_A2),
          appliedSnapshot(HEAD_B1),
          appliedSnapshot(HEAD_C1),
          appliedSnapshot(HEAD_D3),
        ],
        faults: new Map([
          [HEAD_A2.objectDigest, 'verification' as const],
          [HEAD_D3.objectDigest, 'not-a-head' as const],
        ]),
      },
      {
        rows: [
          appliedSnapshot(HEAD_B1),
          appliedSnapshot(HEAD_A2, OTHER_APPLIED_INVENTORY_DIGEST),
          appliedSnapshot(HEAD_D3),
        ],
        faults: new Map([
          [HEAD_A2.objectDigest, 'missing' as const],
          [HEAD_D3.objectDigest, 'not-a-head' as const],
        ]),
      },
      { rows: [appliedSnapshot(HEAD_A2), appliedSnapshot(HEAD_C1)] },
      {
        rows: [
          appliedSnapshot(HEAD_A2),
          appliedSnapshot(HEAD_B1),
          appliedSnapshot(HEAD_C1, OTHER_APPLIED_INVENTORY_DIGEST),
        ],
      },
      { rows: [appliedSnapshot(HEAD_B1)] },
    ];
    const objects = [...ALL_OBJECTS, HEAD_D3];
    const fixture = createStorageFixture([]);
    fixture.store(...objects);
    for (const { rows, faults = new Map() } of inventories) {
      for (const head of objects) fixture.fault(head.objectDigest, null);
      for (const [digest, fault] of faults) fixture.fault(digest, fault);
      fixture.setInventory(rows);
      await expectMatchesUncached(fixture, objects, faults);
      // And again, from the cache or the retry path.
      await expectMatchesUncached(fixture, objects, faults);
    }
  });

  it('keeps the cached result when a write lists the same rows again', async () => {
    const fixture = createStorageFixture([HEAD_A1, HEAD_B1, HEAD_C1]);
    fixture.store(...ALL_OBJECTS);

    const first = await expectMatchesUncached(fixture, ALL_OBJECTS);
    const firstSnapshot = fixture.snapshot;
    expect(fixture.reads).toHaveLength(3);

    // A write that changed no row: a new snapshot with the same token.
    fixture.relist();
    expect(fixture.snapshot).not.toBe(firstSnapshot);
    expect(fixture.snapshot.token).toBe(firstSnapshot.token);
    expect(await loadRfc64OperationalAppliedHeadsV1(fixture.storage)).toBe(first);
    expect(await loadRfc64OperationalAppliedHeadsV1(fixture.storage)).toBe(first);
    expect(fixture.reads).toHaveLength(3);

    // A write that changed a row is seen on the very next call.
    fixture.setInventory([appliedSnapshot(HEAD_A2), appliedSnapshot(HEAD_B1)]);
    const replaced = await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(replaced.map((head) => head.snapshot.currentCatalogHeadDigest))
      .toEqual([HEAD_A2.objectDigest, HEAD_B1.objectDigest]);
    expect(fixture.reads.slice(3)).toEqual([HEAD_A2.objectDigest]);
    fixture.relist();
    expect(await loadRfc64OperationalAppliedHeadsV1(fixture.storage)).toBe(replaced);
  });

  it('shares one load between callers across a listing of the same rows', async () => {
    const fixture = createStorageFixture([HEAD_A1, HEAD_B1, HEAD_C1]);
    const release = fixture.holdReads();

    const early = Array.from({ length: 3 }, () =>
      loadRfc64OperationalAppliedHeadsV1(fixture.storage));
    fixture.relist();
    const late = Array.from({ length: 3 }, () =>
      loadRfc64OperationalAppliedHeadsV1(fixture.storage));
    await Promise.resolve();
    release();
    const results = await Promise.all([...early, ...late]);

    expect(fixture.reads).toHaveLength(3);
    for (const result of results) expect(result).toBe(results[0]);
  });

  it('keeps retrying a failed head across listings of the same rows', async () => {
    const fixture = createStorageFixture([HEAD_A1, HEAD_B1]);
    fixture.fault(HEAD_B1.objectDigest, 'missing');
    const faults = new Map([[HEAD_B1.objectDigest, 'missing' as const]]);

    await expectMatchesUncached(fixture, ALL_OBJECTS, faults);
    fixture.relist();
    await expectMatchesUncached(fixture, ALL_OBJECTS, faults);
    expect(fixture.reads).toEqual([
      HEAD_A1.objectDigest,
      HEAD_B1.objectDigest,
      HEAD_B1.objectDigest,
    ]);

    fixture.fault(HEAD_B1.objectDigest, null);
    const recovered = await expectMatchesUncached(fixture, ALL_OBJECTS);
    expect(recovered).toHaveLength(2);
    const reads = fixture.reads.length;
    fixture.relist();
    expect(await loadRfc64OperationalAppliedHeadsV1(fixture.storage)).toBe(recovered);
    expect(fixture.reads).toHaveLength(reads);
  });
});

describe('approved private catalog readiness handoff', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function fixture() {
    const cg = 'approved-private-ready';
    const head = signedHead(catalogScope(cg), '1');
    const storage = createStorageFixture([head]);
    let metadataRevision = 0;
    let accepted = { policy: { accessPolicy: 1, era: '0', source: { kind: 'owner-signed-unregistered' } }, roster: { members: [{ agentAddress: AUTHOR }, { agentAddress: OTHER_AUTHOR }] }, policyDigest: DELEGATION_DIGEST };
    const service = { started: true, acceptedPolicySnapshot: () => accepted };
    const replay = { revision: 0 };
    const subscription = { subscribed: true, onChainId: undefined as string | undefined };
    const requester = { status: 'approved', requestGeneration: 'request-1', curatorPeerId: 'curator-peer', curatorAgentAddress: AUTHOR, curatorAuthorityEra: '0' };
    const status = {
      contextGraphId: cg, effectiveMode: 'catalog', phase: 'complete', authorityState: 'accepted',
      authorityFreshness: 'current', policyDigest: DELEGATION_DIGEST, accessPolicy: 1,
      catalogServiceStarted: true, stableReason: null, legacyReadOnlyCount: 0, authorHeadCount: 1,
      missingRowCount: '0', appliedRowCount: '1', expectedRowCount: '1',
      expectedCatalogHeadDigest: head.objectDigest, appliedCatalogHeadDigest: head.objectDigest,
      expectedInventoryDigest: APPLIED_INVENTORY_DIGEST, appliedInventoryDigest: APPLIED_INVENTORY_DIGEST,
    };
    const agent = {
      peerId: 'receiver-peer',
      config: { networkIdentity: { chainId: NETWORK_ID }, rfc64CatalogExecutionPlan: {} },
      rfc64PublicCatalogServiceV1: service, rfc64PersistenceV1: storage.storage,
      localApprovedAgentByCG: new Map([[cg, OTHER_AUTHOR]]),
      subscribedContextGraphs: new Map([[cg, subscription]]),
      contextGraphMetaProjection: { readContextGraphAuthorityFactsRevision: () => metadataRevision },
      isRfc64JoinDerivedAcceptedAuthorityV1: vi.fn(() => true),
      isRfc64CatalogTransportAuthorityActiveV1: vi.fn(() => true),
      resolveContextGraphSubscriptionBootstrapAuthority: vi.fn(async () => ({ outcome: 'allowed', registration: 'unregistered' })),
      rfc64CatalogReplayRecoveryRuntimeV1: () => replay,
      listLocalAgents: vi.fn(() => [{ agentAddress: OTHER_AUTHOR }]),
      readRequesterJoinRequestState: vi.fn(async () => requester),
      getOwnCgMetaFacts: async () => ({ accessPolicy: 'private', curators: [`did:dkg:agent:${AUTHOR}`], creators: ['did:dkg:agent:curator-peer'], allowedPeers: ['receiver-peer'] }),
      readLocalContextGraphRegistrationStatus: async () => 'unregistered',
      store: { query: vi.fn(async () => ({ type: 'bindings', bindings: [{}] as Record<string, string>[] })) },
      listSubGraphs: vi.fn(async () => [] as unknown[]),
      readRfc64CatalogOperationalStatusV1: vi.fn(async () => [status]),
    };
    const commit = vi.fn();
    const run = () => Rfc64CatalogMethods.prototype.withVerifiedPrivateCatalogSubscriptionReadinessV1.call(agent as unknown as DKGAgent, cg, commit);
    return { agent, cg, head, storage, status, service, replay, subscription, requester, commit, run,
      moveMetadata: () => { metadataRevision += 1; },
      rotatePolicy: () => { accepted = { ...accepted }; },
    };
  }

  it('commits only after live absence, join proof and exact durable catalog parity', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe(true);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.agent.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledWith(f.cg, {
      callerAgentAddress: OTHER_AUTHOR, allowSubscriptionFallback: false,
    });
    expect(f.storage.reads).toEqual([f.head.objectDigest]);
  });

  it.each([
    ['not subscribed', (f: ReturnType<typeof fixture>) => { f.subscription.subscribed = false; }],
    ['service stopped', (f: ReturnType<typeof fixture>) => { f.service.started = false; }],
    ['not join-derived', (f: ReturnType<typeof fixture>) => { f.agent.isRfc64JoinDerivedAcceptedAuthorityV1.mockReturnValue(false); }],
    ['no approved identity', (f: ReturnType<typeof fixture>) => { f.agent.localApprovedAgentByCG.clear(); }],
    ['authority unavailable', (f: ReturnType<typeof fixture>) => { f.agent.resolveContextGraphSubscriptionBootstrapAuthority.mockResolvedValue({ outcome: 'unavailable', registration: undefined } as never); }],
    ['now registered', (f: ReturnType<typeof fixture>) => { f.agent.resolveContextGraphSubscriptionBootstrapAuthority.mockResolvedValue({ outcome: 'allowed', registration: undefined } as never); }],
    ['no accepted policy', (f: ReturnType<typeof fixture>) => { vi.spyOn(f.service, 'acceptedPolicySnapshot').mockReturnValue(null as never); }],
    ['accepted public policy', (f: ReturnType<typeof fixture>) => { f.service.acceptedPolicySnapshot().policy.accessPolicy = 0; }],
    ['another policy source', (f: ReturnType<typeof fixture>) => { f.service.acceptedPolicySnapshot().policy.source.kind = 'finalized-registry'; }],
    ['no accepted roster', (f: ReturnType<typeof fixture>) => { f.service.acceptedPolicySnapshot().roster = null as never; }],
    ['member proof absent', (f: ReturnType<typeof fixture>) => { f.agent.store.query.mockResolvedValue({ type: 'bindings', bindings: [] }); }],
    ['named legacy scope', (f: ReturnType<typeof fixture>) => { f.agent.listSubGraphs.mockResolvedValue([{}]); }],
    ['unreadable applied head', (f: ReturnType<typeof fixture>) => { f.storage.fault(f.head.objectDigest, 'missing'); }],
    ['head from another network', (f: ReturnType<typeof fixture>) => { f.agent.config.networkIdentity.chainId = 'another-network'; }],
    ['head from an old era', (f: ReturnType<typeof fixture>) => { f.service.acceptedPolicySnapshot().policy.era = '1'; }],
    ['head author outside the accepted roster', (f: ReturnType<typeof fixture>) => { f.service.acceptedPolicySnapshot().roster.members = [{ agentAddress: OTHER_AUTHOR }]; }],
  ])('rejects %s', async (_label, change) => {
    const f = fixture(); change(f);
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each([
    { effectiveMode: 'shadow' }, { phase: 'applying' }, { authorityState: 'resolving' },
    { authorityFreshness: 'unknown' }, { policyDigest: APPLIED_INVENTORY_DIGEST }, { accessPolicy: 0 },
    { catalogServiceStarted: false }, { stableReason: 'catalog-replay-incomplete' },
    { legacyReadOnlyCount: 1 }, { authorHeadCount: 0 }, { missingRowCount: '1' },
    { appliedRowCount: '0', expectedRowCount: '0' }, { appliedRowCount: null },
    { appliedRowCount: '01', expectedRowCount: '01' },
    { appliedRowCount: '+1', expectedRowCount: '+1' },
    { appliedRowCount: '1.0', expectedRowCount: '1.0' },
    { appliedRowCount: ' 1', expectedRowCount: ' 1' },
    { expectedRowCount: null }, { expectedRowCount: '2' }, { expectedCatalogHeadDigest: null },
    { appliedCatalogHeadDigest: null }, { appliedCatalogHeadDigest: DELEGATION_DIGEST },
    { expectedInventoryDigest: null }, { appliedInventoryDigest: null },
    { appliedInventoryDigest: DELEGATION_DIGEST },
  ])('never promotes incomplete/stale projection %j', async (patch) => {
    const f = fixture(); Object.assign(f.status, patch);
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rejects a missing catalog status row', async () => {
    const f = fixture();
    f.agent.readRfc64CatalogOperationalStatusV1.mockResolvedValue([]);
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rejects approval disappearing after the membership proof', async () => {
    const f = fixture();
    f.agent.readRequesterJoinRequestState
      .mockResolvedValueOnce(f.requester).mockResolvedValueOnce(f.requester)
      .mockResolvedValueOnce(null as never);
    await expect(f.run()).resolves.toBe(false);
    expect(f.agent.readRequesterJoinRequestState).toHaveBeenCalledTimes(3);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each([
    ['metadata', (f: ReturnType<typeof fixture>) => f.moveMetadata()],
    ['policy', (f: ReturnType<typeof fixture>) => f.rotatePolicy()],
    ['replay', (f: ReturnType<typeof fixture>) => { f.replay.revision += 1; }],
    ['inventory', (f: ReturnType<typeof fixture>) => { f.storage.setInventory([]); }],
    ['unsubscribe', (f: ReturnType<typeof fixture>) => { f.subscription.subscribed = false; }],
    ['registration', (f: ReturnType<typeof fixture>) => { f.subscription.onChainId = '7'; }],
    ['request generation', (f: ReturnType<typeof fixture>) => { f.requester.requestGeneration = 'request-2'; }],
    ['approval rejection', (f: ReturnType<typeof fixture>) => { f.requester.status = 'rejected'; }],
    ['curator peer', (f: ReturnType<typeof fixture>) => { f.requester.curatorPeerId = 'another-curator'; }],
    ['curator owner', (f: ReturnType<typeof fixture>) => { f.requester.curatorAgentAddress = OTHER_AUTHOR; }],
    ['curator era', (f: ReturnType<typeof fixture>) => { f.requester.curatorAuthorityEra = '1'; }],
    ['local agent removal', (f: ReturnType<typeof fixture>) => { f.agent.listLocalAgents.mockReturnValue([]); }],
    ['transport authority', (f: ReturnType<typeof fixture>) => { f.agent.isRfc64CatalogTransportAuthorityActiveV1.mockReturnValue(false); }],
    ['shutdown', (f: ReturnType<typeof fixture>) => { f.service.started = false; }],
    ['rollout', (f: ReturnType<typeof fixture>) => { f.agent.config.rfc64CatalogExecutionPlan = {}; }],
  ])('fences %s moving during the asynchronous reads', async (_label, move) => {
    const f = fixture();
    f.agent.readRfc64CatalogOperationalStatusV1.mockImplementation(async () => { move(f); return [f.status]; });
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rechecks delegation expiry after catalog reads', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const f = fixture();
    f.agent.store.query.mockResolvedValue({ type: 'bindings', bindings: [{ delegationExpiresAt: '11000' }] });
    f.agent.readRfc64CatalogOperationalStatusV1.mockImplementation(async () => { vi.setSystemTime(11_000); return [f.status]; });
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });
});
