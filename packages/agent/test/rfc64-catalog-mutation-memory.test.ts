/**
 * GH#3081 / GH#3072 — the verified state of an author catalog kept in memory between placements:
 * when it is served, when it is read again from the durable store, what a carried state holds,
 * and what bounds the memory.
 */
import {
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeAuthorCatalogScopeDigestV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeControlSignatureVariantDigestHex,
  encodeOpaqueKaBundleV1,
  type CanonicalGraphScopedAuthorSealV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const hashes = vi.hoisted(() => ({ seal: 0 }));
vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return {
    ...actual,
    computeCanonicalGraphScopedAuthorSealDigestV1: (
      ...args: Parameters<typeof actual.computeCanonicalGraphScopedAuthorSealDigestV1>
    ) => {
      hashes.seal += 1;
      return actual.computeCanonicalGraphScopedAuthorSealDigestV1(...args);
    },
  };
});

import {
  DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1,
  RETAINED_STATE_ROW_BYTES_V1,
  RETAINED_VERIFIED_ROW_BYTES_V1,
  Rfc64CatalogMutationMemoryV1,
  installRfc64CatalogMutationMemoryV1,
  readVerifiedRfc64CatalogMutationStateV1,
  resolveCatalogMutationMemoryLimitsV1,
  rfc64CatalogMutationMemoryV1,
  type Rfc64CatalogMutationStateV1,
  type Rfc64SignedCatalogSuccessorV1,
} from '../src/internal/catalog-mutation-memory.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../src/rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from
  '../src/rfc64/public-catalog-inventory-completeness-v1.js';
import {
  compareRfc64PublicCatalogSuccessorAssetsByKaIdV1,
  snapshotRfc64PublicCatalogSuccessorAssetV1,
  type Rfc64PublicCatalogSuccessorAssetInputV1,
} from '../src/rfc64/public-catalog-successor-asset-v1.js';
import {
  PRODUCER_AUTHOR,
  PRODUCER_DEPLOYMENT,
  PRODUCER_PROJECTION,
  producerAssetV1,
  producerGenesisV1,
  producerOverMemoryV1,
  producerSealV1,
  producerSignerV1,
} from './support/rfc64-successor-producer-fixture.js';

const SCOPE_A = `0x${'a1'.repeat(32)}` as Digest32V1;
const SCOPE_B = `0x${'b2'.repeat(32)}` as Digest32V1;
const SCOPE_C = `0x${'c3'.repeat(32)}` as Digest32V1;
const AUTHOR = `0x${'11'.repeat(20)}` as EvmAddressV1;
const POLICY = `0x${'d4'.repeat(32)}`;
const OUTCOME = { transfer: {}, projection: {} } as never;

function digest(byte: number): Digest32V1 {
  return `0x${byte.toString(16).padStart(2, '0').repeat(32)}` as Digest32V1;
}

const DELEGATION_DIGEST = digest(240);
const AUTHORIZATION = Object.freeze({
  catalogIssuerDelegation: { objectDigest: DELEGATION_DIGEST },
  parentAuthorAgentEvidence: null,
}) as never;

/** Real author seals, by KA number and assertion version: `advance` compares their digests. */
const SEALS = new Map<string, CanonicalGraphScopedAuthorSealV1>();

beforeAll(async () => {
  for (const kaNumber of [1, 2, 3, 4]) {
    for (const version of ['1', '2']) {
      SEALS.set(`${kaNumber}@${version}`, await producerSealV1(BigInt(kaNumber), version));
    }
  }
});

function asset(kaNumber: number, bytes = 16, version = '1'): Rfc64PublicCatalogSuccessorAssetInputV1 {
  return Object.freeze({
    assertionCoordinate: `row-${kaNumber}` as never,
    projectionBytes: new Uint8Array(bytes),
    seal: SEALS.get(`${kaNumber}@${version}`)!,
  });
}

function applied(
  scope: Digest32V1,
  head: number,
  overrides: Partial<AppliedCatalogHeadSnapshotV1> = {},
): AppliedCatalogHeadSnapshotV1 {
  return Object.freeze({
    catalogScopeDigest: scope,
    authorAddress: AUTHOR,
    currentCatalogHeadDigest: digest(head),
    appliedInventoryDigest: digest(head + 100),
    catalogVersion: String(head) as never,
    inventoryRowCount: '2' as never,
    ...overrides,
  });
}

/** The rows a successor reports for `assets`, as the agent derives them from its signed bucket. */
function signedRows(assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[]) {
  return [...assets].sort(compareRfc64PublicCatalogSuccessorAssetsByKaIdV1).map(({ seal }) => ({
    kaId: seal.reservedKaId,
    catalogRowDigest: digest(1),
    bundleDigest: digest(2),
    contentDigest: digest(3),
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    activatedTripleCount: 2,
    contentByteLength: '10',
    bundleByteLength: '20',
    kaUal: seal.kaUal,
  })) as unknown as Rfc64SignedCatalogSuccessorV1['assets'];
}

/** The applied-head record and the successor one own CAS leaves for exactly `assets`. */
function committed(
  scope: Digest32V1,
  head: number,
  assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[],
) {
  const rows = signedRows(assets);
  return {
    applied: applied(scope, head, {
      inventoryRowCount: String(rows.length) as never,
      appliedInventoryDigest: computeRfc64AppliedInventoryDigestV1({ catalogScopeDigest: scope, rows }),
    }),
    successor: {
      headObjectDigest: digest(head),
      signatureVariantDigest: digest(77),
      assets: rows,
    } satisfies Rfc64SignedCatalogSuccessorV1,
  };
}

function stateOf(
  current: AppliedCatalogHeadSnapshotV1,
  assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[] = [asset(1), asset(2)],
): Rfc64CatalogMutationStateV1 {
  return Object.freeze({
    current,
    previousHead: Object.freeze({
      objectDigest: current.currentCatalogHeadDigest,
      signatureVariantDigest: digest(250),
    }),
    catalogIssuerAuthorization: AUTHORIZATION,
    assets: Object.freeze([...assets]),
    expectedCurrentCatalogHeadDigest: current.currentCatalogHeadDigest,
  });
}

/**
 * An inventory whose applied heads the test moves, a durable read that only counts, and control
 * objects and bundles that are there unless the test takes them away.
 */
function durableStore(assetsOf: (current: AppliedCatalogHeadSnapshotV1) =>
  readonly Rfc64PublicCatalogSuccessorAssetInputV1[] = () => [asset(1), asset(2)]) {
  const heads = new Map<string, AppliedCatalogHeadSnapshotV1>();
  const missing = new Set<string>();
  const bundles = new Map<string, Uint8Array>();
  const controlObjectReads: string[] = [];
  const readVerified = vi.fn(async (_persistence: Rfc64PersistenceV1, current: AppliedCatalogHeadSnapshotV1) => (
    stateOf(current, assetsOf(current))
  ));
  const persistence = {
    inventory: {
      readAppliedCatalogHeadV1: (scope: Digest32V1, author: string) => heads.get(`${scope}\n${author}`) ?? null,
    },
    controlObjects: {
      getVerifiedObjectByDigest: async ({ objectDigest }: { objectDigest: string }) => {
        controlObjectReads.push(objectDigest);
        return missing.has(objectDigest) ? null : { envelope: {}, issuerSignature: {} };
      },
    },
    kaBundles: {
      readKaBundleByDigest: async (blobDigest: string) => bundles.get(blobDigest) ?? null,
    },
  } as unknown as Rfc64PersistenceV1;
  return {
    persistence,
    readVerified,
    missing,
    bundles,
    controlObjectReads,
    apply(head: AppliedCatalogHeadSnapshotV1 | null, scope: Digest32V1 = SCOPE_A): void {
      if (head === null) heads.delete(`${scope}\n${AUTHOR}`);
      else heads.set(`${scope}\n${AUTHOR}`, head);
    },
  };
}

describe('RFC-64 catalog mutation memory', () => {
  afterEach(() => {
    delete process.env.DKG_RFC64_CATALOG_MUTATION_MEMORY;
  });

  it('serves the verified state from memory while the applied head and the policy are the ones it was read under', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));

    const first = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    // The inventory hands out a new record object on every read; only its fields matter.
    store.apply(applied(SCOPE_A, 1));
    const second = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);

    expect(second).toBe(first);
    expect(store.readVerified).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(first!.assets)).toBe(true);
    expect(memory.retained).toEqual({ scopes: 1, states: 1, bytes: 2 * (16 + RETAINED_STATE_ROW_BYTES_V1) });
  });

  it('reads the applied head and its delegation from the durable store again before it serves a state', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    const first = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(store.controlObjectReads).toEqual([]);

    await expect(memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).resolves.toBe(first);
    expect(store.controlObjectReads.sort()).toEqual([digest(1), DELEGATION_DIGEST].sort());
  });

  it.each([
    ['applied head', digest(1)],
    ['delegation', DELEGATION_DIGEST],
  ] as const)('reads the durable catalog again when the %s is no longer in the durable store', async (_object, gone) => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    const first = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
    rows.replace('binding', new Map([['row', OUTCOME]]));

    store.missing.add(gone);
    // The read of the durable catalog is what reports the missing object.
    store.readVerified.mockRejectedValueOnce(new Error('is not durably staged'));
    await expect(memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).rejects.toThrow('is not durably staged');
    expect(store.readVerified).toHaveBeenCalledTimes(2);
    // Nothing verified before stays: neither the state nor the rows.
    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    expect(rows.find('binding', 'row')).toBeUndefined();

    store.missing.clear();
    const after = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(after).not.toBe(first);
    expect(store.readVerified).toHaveBeenCalledTimes(3);
  });

  it('reads the durable catalog again when the applied head or its delegation cannot be verified', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    const first = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);

    const controlObjects = store.persistence.controlObjects as unknown as {
      getVerifiedObjectByDigest: (input: unknown) => Promise<unknown>;
    };
    const present = controlObjects.getVerifiedObjectByDigest;
    controlObjects.getVerifiedObjectByDigest = async () => { throw new Error('signature does not verify'); };
    const second = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(second).not.toBe(first);
    expect(store.readVerified).toHaveBeenCalledTimes(2);

    controlObjects.getVerifiedObjectByDigest = present;
    await expect(memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).resolves.toBe(second);
  });

  it('does not put back a scope that was forgotten while its durable objects were being read', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    const first = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);

    const serving = memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    memory.forget(SCOPE_A, AUTHOR);
    // The read that was already under way answers for the head it read.
    await expect(serving).resolves.toBe(first);
    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
  });

  it('leaves a scope that was remembered anew alone when a read begun earlier finds its head gone', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);

    // A read is checking the durable head, which is gone, when the scope is forgotten and a
    // production of the scope completes.
    store.missing.add(digest(1));
    const serving = memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    memory.forget(SCOPE_A, AUTHOR);
    const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
    rows.replace('binding', new Map([['row', OUTCOME]]));
    await serving;

    // The earlier read drops only what it had looked at.
    expect(rows.find('binding', 'row')).toBe(OUTCOME);
    expect(memory.verifiedRows(SCOPE_A, AUTHOR)).toBe(rows);
  });

  it.each([
    ['head digest', { currentCatalogHeadDigest: digest(9) }],
    ['applied inventory digest', { appliedInventoryDigest: digest(9) }],
    ['catalog version', { catalogVersion: '7' as never }],
    ['row count', { inventoryRowCount: '3' as never }],
  ] as const)('reads the durable store again when another writer changed the applied %s', async (_field, change) => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    const before = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    const rowsBefore = memory.verifiedRows(SCOPE_A, AUTHOR);

    const moved = applied(SCOPE_A, 1, change);
    store.apply(moved);
    const after = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);

    expect(store.readVerified).toHaveBeenCalledTimes(2);
    expect(after).not.toBe(before);
    expect(after!.current).toBe(moved);
    // Nothing verified for the scope before the foreign change is trusted after it.
    expect(memory.verifiedRows(SCOPE_A, AUTHOR)).not.toBe(rowsBefore);
    // The state of the foreign head is the one kept now.
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(store.readVerified).toHaveBeenCalledTimes(2);
  });

  it('reads the durable store again when the policy accepted for the scope has changed', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    const rowsBefore = memory.verifiedRows(SCOPE_A, AUTHOR);

    await memory.read(store.persistence, SCOPE_A, AUTHOR, `0x${'e5'.repeat(32)}`);

    expect(store.readVerified).toHaveBeenCalledTimes(2);
    expect(memory.verifiedRows(SCOPE_A, AUTHOR)).not.toBe(rowsBefore);
    // Not served under the earlier policy either: it is no longer the state's own.
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(store.readVerified).toHaveBeenCalledTimes(3);
  });

  it('serves nothing and keeps nothing for a scope without an accepted policy', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));

    const first = await memory.read(store.persistence, SCOPE_A, AUTHOR, undefined);
    const second = await memory.read(store.persistence, SCOPE_A, AUTHOR, undefined);
    expect(store.readVerified).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(memory.retained.states).toBe(0);

    // A state kept under a policy is dropped by a read that has none.
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(memory.retained.states).toBe(1);
    await memory.read(store.persistence, SCOPE_A, AUTHOR, undefined);
    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
  });

  it('keeps one state per scope and never serves one scope the state of another', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1), SCOPE_A);
    store.apply(applied(SCOPE_B, 1), SCOPE_B);

    const a = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    const b = await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY);
    expect(b).not.toBe(a);
    expect(b!.current!.catalogScopeDigest).toBe(SCOPE_B);
    expect(await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).toBe(a);
    expect(store.readVerified).toHaveBeenCalledTimes(2);
    expect(memory.retained.states).toBe(2);
  });

  it('forgets a scope whose applied head is gone', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);

    store.apply(null);
    await expect(memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).resolves.toBeNull();
    expect(memory.retained.scopes).toBe(0);
    expect(store.readVerified).toHaveBeenCalledTimes(1);
  });

  it('forgets the rows of a scope whose durable catalog could not be read', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    // A first successor of the scope completed before any state of it was read.
    const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
    rows.replace('binding', new Map([['row', OUTCOME]]));
    expect(memory.retained.bytes).toBe(RETAINED_VERIFIED_ROW_BYTES_V1);

    store.readVerified.mockRejectedValueOnce(new Error('applied catalog bundle is unavailable'));
    await expect(memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).rejects.toThrow('is unavailable');

    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    expect(rows.size).toBe(0);
  });

  it('carries the signed set forward after its own applied-head CAS', async () => {
    const store = durableStore(() => [asset(2), asset(3)]);
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;

    // The upsert appends the new asset; the bucket, and a fresh read, list rows in KA order.
    const signed = [...previous.assets, asset(1)];
    const second = committed(SCOPE_A, 2, signed);
    const next = memory.advance(previous, second.applied, second.successor, signed);

    expect(next).toEqual({
      current: second.applied,
      previousHead: { objectDigest: digest(2), signatureVariantDigest: digest(77) },
      catalogIssuerAuthorization: AUTHORIZATION,
      assets: [asset(1), asset(2), asset(3)],
      expectedCurrentCatalogHeadDigest: digest(2),
    });
    expect(Object.isFrozen(next) && Object.isFrozen(next.assets) && Object.isFrozen(next.previousHead)).toBe(true);
    expect(signed.map(({ seal }) => seal.kaUal.split('/').at(-1))).toEqual(['2', '3', '1']);

    store.apply(second.applied);
    expect(await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).toBe(next);
    expect(store.readVerified).toHaveBeenCalledTimes(1);
    // The carried state carries on: its own successor is kept too.
    const third = committed(SCOPE_A, 3, next.assets);
    const afterThird = memory.advance(next, third.applied, third.successor, next.assets);
    store.apply(third.applied);
    expect(await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).toBe(afterThird);
    expect(store.readVerified).toHaveBeenCalledTimes(1);
  });

  it('does not serve a carried state once another writer has moved the head past it', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
    const second = committed(SCOPE_A, 2, previous.assets);
    const carried = memory.advance(previous, second.applied, second.successor, previous.assets);
    expect(memory.retained.states).toBe(1);

    store.apply(applied(SCOPE_A, 3));
    const read = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(read).not.toBe(carried);
    expect(read!.current!.currentCatalogHeadDigest).toBe(digest(3));
    expect(store.readVerified).toHaveBeenCalledTimes(2);
  });

  it('keeps no successor of a state it did not hand out', async () => {
    const memory = new Rfc64CatalogMutationMemoryV1();
    // A genesis state is built by the caller, not read through this memory.
    const genesis = stateOf(applied(SCOPE_A, 1), []);
    const first = committed(SCOPE_A, 2, [asset(1)]);
    const afterGenesis = memory.advance(genesis, first.applied, first.successor, [asset(1)]);
    expect(afterGenesis.assets).toEqual([asset(1)]);
    expect(memory.retained.states).toBe(0);
  });

  describe('a committed record that does not name the signed set', () => {
    /** A scope with a kept state of rows 1 and 2 and one verified row. */
    async function remembered() {
      const store = durableStore();
      const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
      store.apply(applied(SCOPE_A, 1));
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      memory.verifiedRows(SCOPE_A, AUTHOR)!.replace('binding', new Map([['row', OUTCOME]]));
      expect(memory.retained.states).toBe(1);
      return { store, memory, previous };
    }

    it('is kept when it does', async () => {
      const { memory, previous } = await remembered();
      const signed = [...previous.assets, asset(3)];
      const third = committed(SCOPE_A, 2, signed);
      memory.advance(previous, third.applied, third.successor, signed);
      expect(memory.retained.states).toBe(1);
      expect(memory.verifiedRows(SCOPE_A, AUTHOR)!.size).toBe(1);
    });

    it.each([
      ['another head', (c: ReturnType<typeof committed>) => ({
        ...c, successor: { ...c.successor, headObjectDigest: digest(99) },
      })],
      ['another row count', (c: ReturnType<typeof committed>) => ({
        ...c, applied: { ...c.applied, inventoryRowCount: '4' as never },
      })],
      ['another inventory digest', (c: ReturnType<typeof committed>) => ({
        ...c, applied: { ...c.applied, appliedInventoryDigest: digest(9) },
      })],
    ] as const)('leaves nothing remembered when the committed record names %s', async (_what, change) => {
      const { store, memory, previous } = await remembered();
      const signed = [...previous.assets, asset(3)];
      const record = change(committed(SCOPE_A, 2, signed));

      const next = memory.advance(previous, record.applied, record.successor, signed);

      // The caller still gets the state it asked for; the memory keeps none of it.
      expect(next.assets).toHaveLength(3);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      store.apply(record.applied);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['misses the row that was added', () => [asset(1), asset(2)]],
      ['holds a row that was not signed', () => [asset(1), asset(2), asset(3), asset(4)]],
      ['holds another asset in a signed row\'s place', () => [asset(1), asset(2), asset(4)]],
      ['holds the earlier version of a row that was replaced', () => [asset(1), asset(2), asset(3, 16, '1')]],
    ] as const)('leaves nothing remembered when the set handed over %s', async (_what, handedOver) => {
      const { memory, previous } = await remembered();
      // What was signed and committed: rows 1 and 2 and the second version of row 3.
      const record = committed(SCOPE_A, 2, [...previous.assets, asset(3, 16, '2')]);

      memory.advance(previous, record.applied, record.successor, handedOver());

      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    });

    it('leaves nothing remembered when the signed rows cannot be hashed', async () => {
      const { memory, previous } = await remembered();
      const record = committed(SCOPE_A, 2, previous.assets);
      const rows = record.successor.assets.map((row) => ({ ...row, catalogRowDigest: 'not a digest' }));

      memory.advance(previous, record.applied, { ...record.successor, assets: rows as never }, previous.assets);

      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    });

    it('hashes the seal of an asset once, however many successors repeat it', async () => {
      const { memory, previous } = await remembered();
      const steps: Array<[(held: readonly Rfc64PublicCatalogSuccessorAssetInputV1[]) =>
        readonly Rfc64PublicCatalogSuccessorAssetInputV1[], number]> = [
        // Nothing of the state read from the durable store has been hashed yet.
        [(held) => [...held, asset(3)], 3],
        // One row is new.
        [(held) => [...held, asset(4)], 1],
        // A removal repeats what is left.
        [(held) => held.filter((_row, index) => index !== 0), 0],
      ];
      let state = previous;
      for (const [index, [change, hashed]] of steps.entries()) {
        const assets = change(state.assets);
        const record = committed(SCOPE_A, index + 2, assets);
        hashes.seal = 0;
        state = memory.advance(state, record.applied, record.successor, assets);
        expect(hashes.seal).toBe(hashed);
        expect(memory.retained.states).toBe(1);
      }
      expect(state.assets.map(({ seal }) => seal.kaUal.split('/').at(-1))).toEqual(['2', '3', '4']);
    });
  });

  describe('a mutation that fails', () => {
    async function mutating() {
      const store = durableStore();
      const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
      store.apply(applied(SCOPE_A, 1), SCOPE_A);
      store.apply(applied(SCOPE_B, 1), SCOPE_B);
      const otherScope = await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY);
      return { store, memory, otherScope };
    }

    it('forgets the state and the verified rows of its scope when it fails before its applied-head CAS', async () => {
      const { store, memory, otherScope } = await mutating();
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
      rows.replace('binding', new Map([['row', OUTCOME]]));

      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      mutation.failed();

      expect(memory.verifiedRows(SCOPE_A, AUTHOR)).not.toBe(rows);
      expect(memory.verifiedRows(SCOPE_A, AUTHOR)!.size).toBe(0);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(3);
      // Another scope is untouched.
      expect(await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY)).toBe(otherScope);
    });

    it('keeps the committed state when it fails after its own applied-head CAS', async () => {
      const { store, memory } = await mutating();
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      memory.producing(previous);
      const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
      rows.replace('binding', new Map([['row', OUTCOME]]));
      const second = committed(SCOPE_A, 2, previous.assets);
      const next = memory.advance(previous, second.applied, second.successor, previous.assets);
      store.apply(second.applied);

      // The announcement of the committed head throws.
      mutation.failed();

      // Both scopes still hold their state.
      expect(memory.retained.states).toBe(2);
      expect(memory.verifiedRows(SCOPE_A, AUTHOR)).toBe(rows);
      expect(await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).toBe(next);
      expect(store.readVerified).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['a further successor was asked for', (memory: Rfc64CatalogMutationMemoryV1, next: Rfc64CatalogMutationStateV1) => memory.producing(next)],
      ['a production of the scope began', (memory: Rfc64CatalogMutationMemoryV1) => { memory.verifiedRows(SCOPE_A, AUTHOR); }],
    ] as const)('forgets the scope when it fails after %s', async (_what, proceed) => {
      const { store, memory } = await mutating();
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      const second = committed(SCOPE_A, 2, previous.assets);
      const next = memory.advance(previous, second.applied, second.successor, previous.assets);

      proceed(memory, next);
      mutation.failed();

      expect(memory.retained.scopes).toBe(1);
      expect(memory.retained.states).toBe(1);
      // Only the scope of the mutation went; the other scope is the one still held.
      store.apply(second.applied);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(3);
    });

    it('forgets the scope when the next mutation fails before a CAS of its own', async () => {
      const { store, memory } = await mutating();
      const first = memory.mutation(SCOPE_A, AUTHOR);
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      const second = committed(SCOPE_A, 2, previous.assets);
      memory.advance(previous, second.applied, second.successor, previous.assets);
      store.apply(second.applied);
      void first;

      // The earlier mutation's CAS does not excuse a later mutation's failure.
      const later = memory.mutation(SCOPE_A, AUTHOR);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      later.failed();

      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(3);
    });

    it('has nothing to forget for a scope it never remembered', () => {
      const memory = new Rfc64CatalogMutationMemoryV1();
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      mutation.failed();
      memory.producing(stateOf(applied(SCOPE_A, 1)));
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    });
  });

  describe('the bundle of one row, before a decision about it ends work', () => {
    function rowOf(kaNumber: number) {
      const row = asset(kaNumber, PRODUCER_PROJECTION.byteLength);
      row.projectionBytes.set(PRODUCER_PROJECTION);
      const encoded = encodeOpaqueKaBundleV1(
        row.projectionBytes,
        canonicalizeCanonicalGraphScopedAuthorSealBytesV1(row.seal),
      );
      return { row, encoded };
    }

    async function remembered() {
      const store = durableStore();
      const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
      store.apply(applied(SCOPE_A, 1));
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      memory.verifiedRows(SCOPE_A, AUTHOR)!.replace('binding', new Map([['row', OUTCOME]]));
      return { store, memory };
    }

    it('is found in the durable store, byte for byte', async () => {
      const { store, memory } = await remembered();
      const { row, encoded } = rowOf(1);
      store.bundles.set(encoded.blobDigest, new Uint8Array(encoded.bundleBytes));

      await expect(memory.confirmRowBundle(store.persistence, SCOPE_A, AUTHOR, row)).resolves.toBeUndefined();
      expect(memory.retained.states).toBe(1);
    });

    it('fails the decision and forgets the scope when the bundle is not there', async () => {
      const { store, memory } = await remembered();
      const { row } = rowOf(1);

      await expect(memory.confirmRowBundle(store.persistence, SCOPE_A, AUTHOR, row))
        .rejects.toThrow(/RFC-64 applied catalog bundle 0x[0-9a-f]{64} is unavailable/u);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    });

    it('fails the decision and forgets the scope when the durable bytes are not the remembered ones', async () => {
      const { store, memory } = await remembered();
      const { row, encoded } = rowOf(1);
      const other = new Uint8Array(encoded.bundleBytes);
      other[other.length - 1] ^= 1;
      store.bundles.set(encoded.blobDigest, other);

      await expect(memory.confirmRowBundle(store.persistence, SCOPE_A, AUTHOR, row))
        .rejects.toThrow('RFC-64 applied catalog bundle differs from its signed predecessor row');
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });

      // Nor a bundle that stops short of them.
      store.bundles.set(encoded.blobDigest, encoded.bundleBytes.subarray(0, encoded.bundleBytes.byteLength - 1));
      await expect(memory.confirmRowBundle(store.persistence, SCOPE_A, AUTHOR, row)).rejects.toThrow('differs');
    });

    it('fails the decision and forgets the scope when the durable store cannot be read', async () => {
      const { store, memory } = await remembered();
      (store.persistence.kaBundles as unknown as { readKaBundleByDigest: unknown }).readKaBundleByDigest =
        async () => { throw new Error('the bundle store is closed'); };

      await expect(memory.confirmRowBundle(store.persistence, SCOPE_A, AUTHOR, rowOf(1).row))
        .rejects.toThrow('the bundle store is closed');
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    });
  });

  it('forgets one scope, or all of them when the durable stores close', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    for (const scope of [SCOPE_A, SCOPE_B, SCOPE_C]) store.apply(applied(scope, 1), scope);
    for (const scope of [SCOPE_A, SCOPE_B, SCOPE_C]) await memory.read(store.persistence, scope, AUTHOR, POLICY);
    const rows = memory.verifiedRows(SCOPE_B, AUTHOR)!;
    rows.replace('binding', new Map([['row', OUTCOME]]));

    memory.forget(SCOPE_A, AUTHOR);
    expect(memory.retained.scopes).toBe(2);

    memory.clear();
    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    expect(rows.size).toBe(0);
    await memory.read(store.persistence, SCOPE_C, AUTHOR, POLICY);
    expect(store.readVerified).toHaveBeenCalledTimes(4);
  });

  it('keeps the verified rows of a scope across reads and gives each scope its own', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    // A first placement produces its successor before any state of the scope has been read.
    const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
    expect(memory.retained).toEqual({ scopes: 1, states: 0, bytes: 0 });

    store.apply(applied(SCOPE_A, 1));
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(memory.verifiedRows(SCOPE_A, AUTHOR)).toBe(rows);
    expect(memory.verifiedRows(SCOPE_B, AUTHOR)).not.toBe(rows);
  });

  it('gives a production nothing from, and takes nothing back into, a scope forgotten while it ran', async () => {
    const memory = new Rfc64CatalogMutationMemoryV1();
    // A production of the scope holds these for as long as it runs.
    const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
    rows.replace('binding', new Map([['row', OUTCOME]]));
    expect(rows.find('binding', 'row')).toBe(OUTCOME);
    expect(rows.find('other-binding', 'row')).toBeUndefined();

    memory.forget(SCOPE_A, AUTHOR);

    expect(rows.find('binding', 'row')).toBeUndefined();
    rows.replace('binding', new Map([['row', OUTCOME]]));
    expect(rows.size).toBe(0);
    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    // Nor does its failure forget what the scope has learnt since.
    const later = memory.verifiedRows(SCOPE_A, AUTHOR)!;
    later.replace('binding', new Map([['row', OUTCOME]]));
    rows.clear();
    expect(later.size).toBe(1);
    // The failure of the production that holds them does.
    later.clear();
    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
  });

  it('never serves a state a slower read stored over a newer one', async () => {
    const store = durableStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowOnce = vi.fn(async (persistence: Rfc64PersistenceV1, current: AppliedCatalogHeadSnapshotV1) => {
      if (slowOnce.mock.calls.length === 2) await gate;
      return store.readVerified(persistence, current);
    });
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, slowOnce);
    store.apply(applied(SCOPE_A, 1));
    const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
    memory.forget(SCOPE_A, AUTHOR);

    // A read of head 1 is still loading when the head moves to 2 and is read.
    const slow = memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    const moved = applied(SCOPE_A, 2);
    store.apply(moved);
    const current = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
    expect(current.current).toBe(moved);
    release();
    expect((await slow)!.current!.currentCatalogHeadDigest).toBe(previous.current!.currentCatalogHeadDigest);

    // The slower read's state names head 1: it is checked against the applied head, not served.
    const after = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
    expect(after.current!.currentCatalogHeadDigest).toBe(moved.currentCatalogHeadDigest);
  });

  describe('bounds', () => {
    it('remembers at most the configured number of scopes, dropping the least recently used', async () => {
      const store = durableStore();
      const memory = new Rfc64CatalogMutationMemoryV1(
        { maxScopes: 2, maxRetainedBytes: 1024 * 1024 },
        store.readVerified,
      );
      for (const scope of [SCOPE_A, SCOPE_B, SCOPE_C]) store.apply(applied(scope, 1), scope);

      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY);
      // Using A again makes B the least recently used.
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      await memory.read(store.persistence, SCOPE_C, AUTHOR, POLICY);
      expect(memory.retained.scopes).toBe(2);
      expect(store.readVerified).toHaveBeenCalledTimes(3);

      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(3);
      await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(4);
      expect(memory.retained.scopes).toBe(2);
      // A scope that only has verified rows counts as one too.
      memory.verifiedRows(`0x${'f6'.repeat(32)}` as Digest32V1, AUTHOR);
      expect(memory.retained.scopes).toBe(2);
    });

    it('retains at most the configured bytes, and never a state larger than all of them', async () => {
      const rowBytes = 100_000;
      const store = durableStore((current) => (
        current.catalogScopeDigest === SCOPE_C
          ? [asset(1, 4 * rowBytes)]
          : [asset(1, rowBytes)]
      ));
      const budget = 2 * (rowBytes + RETAINED_STATE_ROW_BYTES_V1) + 1;
      const memory = new Rfc64CatalogMutationMemoryV1(
        { maxScopes: 16, maxRetainedBytes: budget },
        store.readVerified,
      );
      const scopeD = `0x${'d7'.repeat(32)}` as Digest32V1;
      for (const scope of [SCOPE_A, SCOPE_B, SCOPE_C, scopeD]) {
        store.apply(applied(scope, 1, { inventoryRowCount: '1' as never }), scope);
      }

      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY);
      expect(memory.retained).toEqual({ scopes: 2, states: 2, bytes: budget - 1 });

      // A third state does not fit beside the other two: the oldest goes.
      await memory.read(store.persistence, scopeD, AUTHOR, POLICY);
      expect(memory.retained).toEqual({ scopes: 2, states: 2, bytes: budget - 1 });
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(4);

      // One state larger than the whole budget is read every time; its verified rows stay.
      const calls = store.readVerified.mock.calls.length;
      const large = await memory.read(store.persistence, SCOPE_C, AUTHOR, POLICY);
      const rows = memory.verifiedRows(SCOPE_C, AUTHOR);
      expect(await memory.read(store.persistence, SCOPE_C, AUTHOR, POLICY)).not.toBe(large);
      expect(store.readVerified).toHaveBeenCalledTimes(calls + 2);
      expect(memory.verifiedRows(SCOPE_C, AUTHOR)).toBe(rows);
      expect(memory.retained.bytes).toBeLessThanOrEqual(budget);
      // Its successor is not kept either.
      const second = committed(SCOPE_C, 2, large!.assets);
      memory.advance(large!, second.applied, second.successor, large!.assets);
      expect(memory.retained.bytes).toBeLessThanOrEqual(budget);
    });

    it('counts the verified rows of a scope against the same budget', async () => {
      const store = durableStore(() => [asset(1, 16)]);
      const stateBytes = 16 + RETAINED_STATE_ROW_BYTES_V1;
      const memory = new Rfc64CatalogMutationMemoryV1(
        { maxScopes: 16, maxRetainedBytes: 2 * stateBytes + 2 * RETAINED_VERIFIED_ROW_BYTES_V1 },
        store.readVerified,
      );
      for (const scope of [SCOPE_A, SCOPE_B, SCOPE_C]) store.apply(applied(scope, 1), scope);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY);

      // A successor completes for B: its two verified rows fill what was left.
      memory.verifiedRows(SCOPE_B, AUTHOR)!.replace('binding', new Map([['row-1', OUTCOME], ['row-2', OUTCOME]]));
      expect(memory.retained).toEqual({
        scopes: 2,
        states: 2,
        bytes: 2 * stateBytes + 2 * RETAINED_VERIFIED_ROW_BYTES_V1,
      });

      // The next thing kept does not fit beside them: the least recently used scope goes.
      await memory.read(store.persistence, SCOPE_C, AUTHOR, POLICY);
      expect(memory.retained).toEqual({ scopes: 2, states: 2, bytes: 2 * stateBytes + 2 * RETAINED_VERIFIED_ROW_BYTES_V1 });
      await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(3);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(4);

      // A scope whose verified rows alone leave no room for its state keeps the rows only.
      const tight = new Rfc64CatalogMutationMemoryV1(
        { maxScopes: 16, maxRetainedBytes: RETAINED_VERIFIED_ROW_BYTES_V1 + stateBytes - 1 },
        store.readVerified,
      );
      tight.verifiedRows(SCOPE_A, AUTHOR)!.replace('binding', new Map([['row-1', OUTCOME]]));
      await tight.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(tight.retained).toEqual({ scopes: 1, states: 0, bytes: RETAINED_VERIFIED_ROW_BYTES_V1 });
    });

    it('holds the byte bound the moment a completed successor grows a scope\'s verified rows', () => {
      const budget = 2 * RETAINED_VERIFIED_ROW_BYTES_V1;
      const memory = new Rfc64CatalogMutationMemoryV1({ maxScopes: 16, maxRetainedBytes: budget });
      const first = memory.verifiedRows(SCOPE_A, AUTHOR)!;
      const second = memory.verifiedRows(SCOPE_B, AUTHOR)!;
      first.replace('binding', new Map([['row-1', OUTCOME]]));
      second.replace('binding', new Map([['row-1', OUTCOME]]));
      expect(memory.retained).toEqual({ scopes: 2, states: 0, bytes: budget });

      // The second scope's next successor has two rows: no read, lookup or state follows.
      second.replace('binding', new Map([['row-1', OUTCOME], ['row-2', OUTCOME]]));

      expect(memory.retained).toEqual({ scopes: 1, states: 0, bytes: budget });
      expect(second.size).toBe(2);
      // The least recently used scope made room, and what its production held is empty.
      expect(first.size).toBe(0);
      expect(memory.verifiedRows(SCOPE_A, AUTHOR)).not.toBe(first);
    });

    it('holds the byte bound over many scopes whose successors complete without a state of theirs being kept', () => {
      // Nine catalogs of four rows each against a budget of eight catalogs.
      const catalog = new Map(
        Array.from({ length: 4 }, (_unused, row) => [`row-${row}`, OUTCOME] as const),
      );
      const budget = 8 * catalog.size * RETAINED_VERIFIED_ROW_BYTES_V1;
      const memory = new Rfc64CatalogMutationMemoryV1({ maxScopes: 64, maxRetainedBytes: budget });

      for (let scope = 1; scope <= 9; scope += 1) {
        memory.verifiedRows(digest(scope), AUTHOR)!.replace('binding', catalog);
        expect(memory.retained.bytes).toBeLessThanOrEqual(budget);
      }

      expect(memory.retained).toEqual({ scopes: 8, states: 0, bytes: budget });
      // The first scope was the least recently used one.
      expect(memory.verifiedRows(digest(1), AUTHOR)!.size).toBe(0);
      expect(memory.verifiedRows(digest(9), AUTHOR)!.size).toBe(4);
    });

    it('keeps no verified rows of a successor that alone is larger than the budget, and drops a state to keep rows', async () => {
      const store = durableStore(() => [asset(1, 16)]);
      const stateBytes = 16 + RETAINED_STATE_ROW_BYTES_V1;
      // Two rows fit, and one row beside the state, but not two rows beside the state.
      const budget = 2 * RETAINED_VERIFIED_ROW_BYTES_V1 + stateBytes - 1;
      const memory = new Rfc64CatalogMutationMemoryV1({ maxScopes: 16, maxRetainedBytes: budget }, store.readVerified);
      store.apply(applied(SCOPE_A, 1));
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
      rows.replace('binding', new Map([['row-1', OUTCOME]]));
      expect(memory.retained).toEqual({ scopes: 1, states: 1, bytes: stateBytes + RETAINED_VERIFIED_ROW_BYTES_V1 });

      // Two rows do not fit beside the state: the rows stay verified, the state is read again.
      rows.replace('binding', new Map([['row-1', OUTCOME], ['row-2', OUTCOME]]));
      expect(memory.retained).toEqual({ scopes: 1, states: 0, bytes: 2 * RETAINED_VERIFIED_ROW_BYTES_V1 });
      expect(rows.size).toBe(2);

      // Three rows do not fit at all.
      rows.replace('binding', new Map([['row-1', OUTCOME], ['row-2', OUTCOME], ['row-3', OUTCOME]]));
      expect(memory.retained).toEqual({ scopes: 1, states: 0, bytes: 0 });
      expect(rows.size).toBe(0);
    });

    it('remembers nothing at all when it is switched off', async () => {
      const store = durableStore();
      const memory = new Rfc64CatalogMutationMemoryV1(resolveCatalogMutationMemoryLimitsV1('0'), store.readVerified);
      store.apply(applied(SCOPE_A, 1));

      const first = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(2);
      expect(memory.verifiedRows(SCOPE_A, AUTHOR)).toBeUndefined();
      const second = committed(SCOPE_A, 2, first.assets);
      const next = memory.advance(first, second.applied, second.successor, first.assets);
      expect(next.current).toBe(second.applied);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    });

    it('is on unless the operator sets the switch to 0', () => {
      expect(resolveCatalogMutationMemoryLimitsV1(undefined)).toBe(DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1);
      expect(resolveCatalogMutationMemoryLimitsV1('1')).toBe(DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1);
      expect(resolveCatalogMutationMemoryLimitsV1('')).toBe(DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1);
      expect(resolveCatalogMutationMemoryLimitsV1(' 0 ')).toEqual({ maxScopes: 0, maxRetainedBytes: 0 });
      // One exact set is at most 64 MiB of bundles; a full catalog fits with its per-row overhead.
      expect(DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1.maxRetainedBytes).toBeGreaterThanOrEqual(
        64 * 1024 * 1024 + 1024 * (RETAINED_STATE_ROW_BYTES_V1 + RETAINED_VERIFIED_ROW_BYTES_V1),
      );
    });

    it('gives each agent one memory, created with the operator\'s switch', async () => {
      const owner = {};
      const memory = rfc64CatalogMutationMemoryV1(owner);
      expect(rfc64CatalogMutationMemoryV1(owner)).toBe(memory);
      expect(memory.verifiedRows(SCOPE_A, AUTHOR)).toBeDefined();

      process.env.DKG_RFC64_CATALOG_MUTATION_MEMORY = '0';
      const switchedOff = rfc64CatalogMutationMemoryV1({});
      expect(switchedOff.verifiedRows(SCOPE_A, AUTHOR)).toBeUndefined();

      const replacement = new Rfc64CatalogMutationMemoryV1();
      installRfc64CatalogMutationMemoryV1(owner, replacement);
      expect(rfc64CatalogMutationMemoryV1(owner)).toBe(replacement);
    });
  });

  describe('over a real author catalog', () => {
    /** Durable stores that hold exactly what the successor producer staged. */
    async function realCatalog() {
      const genesis = await producerGenesisV1();
      const objects = new Map<string, unknown>();
      const bundles = new Map<string, Uint8Array>();
      const delegation = genesis.authorization.catalogIssuerDelegation;
      objects.set(delegation.objectDigest, delegation);
      for (const envelope of [genesis.history.previousHead, ...genesis.history.previousDirectoryPath]) {
        objects.set(envelope.objectDigest, envelope);
      }
      const scopeDigest = computeAuthorCatalogScopeDigestV1(genesis.scope);
      let appliedHead: AppliedCatalogHeadSnapshotV1 | null = null;
      const stored = (objectDigest: string) => {
        const envelope = objects.get(objectDigest);
        return envelope === undefined ? null : { envelope, issuerSignature: {} };
      };
      const persistence = {
        inventory: { readAppliedCatalogHeadV1: () => appliedHead },
        controlObjects: {
          getVerifiedObject: async ({ objectDigest }: { objectDigest: string }) => stored(objectDigest),
          getVerifiedObjectByDigest: async ({ objectDigest }: { objectDigest: string }) => stored(objectDigest),
        },
        kaBundles: {
          readKaBundleByDigest: async (blobDigest: string) => bundles.get(blobDigest) ?? null,
        },
      } as unknown as Rfc64PersistenceV1;
      let history = genesis.history;
      return {
        genesis,
        scopeDigest,
        persistence,
        objects,
        bundles,
        /** Produce, stage and apply the successor that holds exactly `assets`. */
        async advance(assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[], step: number) {
          const produced = await producerOverMemoryV1().produceAndStageExactSet({
            ...history,
            assets: [...assets],
            deployment: PRODUCER_DEPLOYMENT,
            issuedAt: String(1773900001000 + step * 1000) as never,
            catalogSigner: producerSignerV1(),
            catalogIssuerAuthorization: genesis.authorization,
          });
          for (const envelope of produced.publication.stagedObjects) objects.set(envelope.objectDigest, envelope);
          for (const { bundleDigest, bundleBytes } of produced.assets) bundles.set(bundleDigest, bundleBytes);
          const head = produced.publication.head;
          history = {
            previousHead: head,
            previousDirectoryPath: produced.publication.directoryPath,
            previousBucket: produced.publication.bucket,
          };
          // The rows the agent derives from the verified successor, and the digest it commits.
          const rows = produced.assets.map((signed) => ({
            kaId: signed.row.kaId,
            catalogRowDigest: signed.sealBinding.catalogRowDigest,
            bundleDigest: signed.bundleDigest,
            contentDigest: signed.projection.projectionDigest,
            sealDigest: signed.sealBinding.sealDigest,
            activatedTripleCount: Number(signed.projection.publicTripleCount),
            contentByteLength: signed.projection.projectionByteLength,
            bundleByteLength: signed.row.transfer.byteLength,
            kaUal: signed.projection.kaUal,
          })) as unknown as Rfc64SignedCatalogSuccessorV1['assets'];
          appliedHead = Object.freeze({
            catalogScopeDigest: scopeDigest,
            authorAddress: PRODUCER_AUTHOR,
            currentCatalogHeadDigest: head.objectDigest as Digest32V1,
            appliedInventoryDigest: computeRfc64AppliedInventoryDigestV1({ catalogScopeDigest: scopeDigest, rows }),
            catalogVersion: head.payload.version,
            inventoryRowCount: head.payload.totalRows as never,
          });
          return {
            applied: appliedHead,
            successor: {
              headObjectDigest: head.objectDigest as Digest32V1,
              signatureVariantDigest: computeControlSignatureVariantDigestHex(
                head.objectDigest,
                head.signature,
              ) as Digest32V1,
              assets: rows,
            },
          };
        },
      };
    }

    it('carries forward exactly the state a verified read of the durable store returns', async () => {
      const catalog = await realCatalog();
      const memory = new Rfc64CatalogMutationMemoryV1();
      // Three, one, two: the upsert appends, the signed bucket is in KA order.
      await catalog.advance([await producerAssetV1(3)], 1);
      let state = (await memory.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY))!;
      expect(state.assets.every(({ seal }) => Object.isFrozen(seal))).toBe(true);

      const placements = [await producerAssetV1(1), await producerAssetV1(2), await producerAssetV1(3, '2')];
      for (const [index, incoming] of placements.entries()) {
        // As the upsert does: its own copy of the incoming asset, replaced in place or appended.
        const own = snapshotRfc64PublicCatalogSuccessorAssetV1(incoming);
        const assets = [...state.assets];
        const existing = assets.findIndex(({ seal }) => seal.reservedKaId === own.seal.reservedKaId);
        if (existing >= 0) assets[existing] = own;
        else assets.push(own);
        const step = await catalog.advance(assets, index + 2);
        const carried = memory.advance(state, step.applied, step.successor, assets);

        const fresh = await readVerifiedRfc64CatalogMutationStateV1(catalog.persistence, step.applied);
        expect(carried).toEqual(fresh);
        expect(carried.assets.map(({ seal }) => seal.kaUal)).toEqual(fresh.assets.map(({ seal }) => seal.kaUal));
        expect(await memory.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY)).toBe(carried);
        // Every row a served state names is in the durable store, byte for byte.
        for (const row of carried.assets) {
          await memory.confirmRowBundle(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, row);
        }
        state = carried;
      }
      expect(state.assets.map(({ seal }) => `${seal.kaUal.split('/').at(-1)}@${seal.assertionVersion}`))
        .toEqual(['1@1', '2@1', '3@2']);
    });

    it('refuses an applied head whose durable objects are missing or are not the signed ones', async () => {
      const catalog = await realCatalog();
      const rows = [await producerAssetV1(1), await producerAssetV1(2)];
      await catalog.advance(rows.slice(0, 1), 1);
      const { applied: head } = await catalog.advance(rows, 2);
      const read = () => readVerifiedRfc64CatalogMutationStateV1(catalog.persistence, head);
      await expect(read()).resolves.toMatchObject({ expectedCurrentCatalogHeadDigest: head.currentCatalogHeadDigest });
      // A memory that holds the state refuses the head with the same words, and then holds nothing.
      const warm = new Rfc64CatalogMutationMemoryV1();
      const served = () => warm.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY);
      const held = await served();

      const [firstDigest, secondDigest] = [...catalog.bundles.keys()];
      const firstBundle = catalog.bundles.get(firstDigest!)!;
      catalog.bundles.set(firstDigest!, catalog.bundles.get(secondDigest!)!);
      await expect(read()).rejects.toThrow('RFC-64 applied catalog bundle differs from its signed predecessor row');
      catalog.bundles.delete(firstDigest!);
      await expect(read()).rejects.toThrow(/RFC-64 applied catalog bundle 0x[0-9a-f]{64} is unavailable/u);
      // A served state does not read every row's bundle again; the row a decision is about, it does.
      await expect(served()).resolves.toBe(held);
      const missingRow = held!.assets.find(({ seal, projectionBytes }) => encodeOpaqueKaBundleV1(
        projectionBytes,
        canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal),
      ).blobDigest === firstDigest)!;
      await expect(warm.confirmRowBundle(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, missingRow))
        .rejects.toThrow(/RFC-64 applied catalog bundle 0x[0-9a-f]{64} is unavailable/u);
      expect(warm.retained.states).toBe(0);
      catalog.bundles.set(firstDigest!, firstBundle);
      await expect(served()).resolves.toEqual(held);

      const delegationDigest = catalog.genesis.authorization.catalogIssuerDelegation.objectDigest;
      const delegation = catalog.objects.get(delegationDigest);
      catalog.objects.delete(delegationDigest);
      await expect(read()).rejects.toThrow('RFC-64 applied author head delegation is not durably staged');
      await expect(served()).rejects.toThrow('RFC-64 applied author head delegation is not durably staged');
      expect(warm.retained.states).toBe(0);
      catalog.objects.set(delegationDigest, delegation);
      await expect(served()).resolves.toEqual(held);

      catalog.objects.delete(head.currentCatalogHeadDigest);
      await expect(read()).rejects.toThrow('RFC-64 applied author head is not durably staged');
      await expect(served()).rejects.toThrow('RFC-64 applied author head is not durably staged');
      expect(warm.retained.states).toBe(0);

      // A read that fails keeps nothing.
      const memory = new Rfc64CatalogMutationMemoryV1();
      await expect(memory.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY)).rejects.toThrow();
      expect(memory.retained.states).toBe(0);
    });
  });
});
