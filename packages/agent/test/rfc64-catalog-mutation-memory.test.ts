/**
 * GH#3081 / GH#3072 — the verified state of an author catalog kept in memory between placements:
 * when it is served, when it is read again from the durable store, what a carried state holds,
 * and what bounds the memory.
 */
import {
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
} from '../src/internal/catalog-mutation-memory.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../src/rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import {
  snapshotRfc64PublicCatalogSuccessorAssetV1,
  type Rfc64PublicCatalogSuccessorAssetInputV1,
} from '../src/rfc64/public-catalog-successor-asset-v1.js';
import {
  PRODUCER_AUTHOR,
  PRODUCER_DEPLOYMENT,
  producerAssetV1,
  producerGenesisV1,
  producerOverMemoryV1,
  producerSignerV1,
} from './support/rfc64-successor-producer-fixture.js';

const SCOPE_A = `0x${'a1'.repeat(32)}` as Digest32V1;
const SCOPE_B = `0x${'b2'.repeat(32)}` as Digest32V1;
const SCOPE_C = `0x${'c3'.repeat(32)}` as Digest32V1;
const AUTHOR = `0x${'11'.repeat(20)}` as EvmAddressV1;
const POLICY = `0x${'d4'.repeat(32)}`;
const AUTHORIZATION = Object.freeze({ catalogIssuerDelegation: {}, parentAuthorAgentEvidence: null }) as never;

function digest(byte: number): Digest32V1 {
  return `0x${byte.toString(16).padStart(2, '0').repeat(32)}` as Digest32V1;
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

function asset(kaId: number, bytes = 16): Rfc64PublicCatalogSuccessorAssetInputV1 {
  return Object.freeze({
    assertionCoordinate: `row-${kaId}` as never,
    projectionBytes: new Uint8Array(bytes),
    seal: Object.freeze({ reservedKaId: String(kaId) }) as never,
  });
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

/** An inventory whose applied heads the test moves, and a durable read that only counts. */
function durableStore(assetsOf: (current: AppliedCatalogHeadSnapshotV1) =>
  readonly Rfc64PublicCatalogSuccessorAssetInputV1[] = () => [asset(1), asset(2)]) {
  const heads = new Map<string, AppliedCatalogHeadSnapshotV1>();
  const readVerified = vi.fn(async (_persistence: Rfc64PersistenceV1, current: AppliedCatalogHeadSnapshotV1) => (
    stateOf(current, assetsOf(current))
  ));
  const persistence = {
    inventory: {
      readAppliedCatalogHeadV1: (scope: Digest32V1, author: string) => heads.get(`${scope}\n${author}`) ?? null,
    },
  } as unknown as Rfc64PersistenceV1;
  return {
    persistence,
    readVerified,
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

  it('carries the signed set forward after its own applied-head CAS', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;

    const committed = applied(SCOPE_A, 2, { inventoryRowCount: '3' as never });
    // The upsert appends the new asset; the bucket, and a fresh read, list rows in KA order.
    const signed = [...previous.assets, asset(0)];
    const next = memory.advance(previous, committed, {
      headObjectDigest: committed.currentCatalogHeadDigest,
      signatureVariantDigest: digest(77),
    }, signed);

    expect(next).toEqual({
      current: committed,
      previousHead: { objectDigest: committed.currentCatalogHeadDigest, signatureVariantDigest: digest(77) },
      catalogIssuerAuthorization: AUTHORIZATION,
      assets: [asset(0), asset(1), asset(2)],
      expectedCurrentCatalogHeadDigest: committed.currentCatalogHeadDigest,
    });
    expect(Object.isFrozen(next) && Object.isFrozen(next.assets) && Object.isFrozen(next.previousHead)).toBe(true);
    expect(signed.map(({ seal }) => seal.reservedKaId)).toEqual(['1', '2', '0']);

    store.apply(committed);
    expect(await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).toBe(next);
    expect(store.readVerified).toHaveBeenCalledTimes(1);
    // The carried state carries on: its own successor is kept too.
    const third = applied(SCOPE_A, 3);
    const afterThird = memory.advance(next, third, {
      headObjectDigest: third.currentCatalogHeadDigest,
      signatureVariantDigest: digest(78),
    }, next.assets);
    store.apply(third);
    expect(await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).toBe(afterThird);
    expect(store.readVerified).toHaveBeenCalledTimes(1);
  });

  it('does not serve a carried state once another writer has moved the head past it', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1));
    const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
    const committed = applied(SCOPE_A, 2);
    const carried = memory.advance(previous, committed, {
      headObjectDigest: committed.currentCatalogHeadDigest,
      signatureVariantDigest: digest(77),
    }, previous.assets);

    store.apply(applied(SCOPE_A, 3));
    const read = await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(read).not.toBe(carried);
    expect(read!.current!.currentCatalogHeadDigest).toBe(digest(3));
    expect(store.readVerified).toHaveBeenCalledTimes(2);
  });

  it('keeps no successor of a state it did not hand out, and none the committed record does not name', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    const committed = applied(SCOPE_A, 2);
    const successor = { headObjectDigest: committed.currentCatalogHeadDigest, signatureVariantDigest: digest(77) };

    // A genesis state is built by the caller, not read through this memory.
    const genesis = stateOf(applied(SCOPE_A, 1), []);
    const afterGenesis = memory.advance(genesis, committed, successor, [asset(1)]);
    expect(afterGenesis.assets).toEqual([asset(1)]);
    expect(memory.retained.states).toBe(0);

    store.apply(applied(SCOPE_A, 1));
    const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
    memory.advance(previous, committed, { ...successor, headObjectDigest: digest(99) }, previous.assets);
    store.apply(committed);
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(store.readVerified).toHaveBeenCalledTimes(2);
  });

  it('forgets the state and the verified rows of a scope whose mutation failed', async () => {
    const store = durableStore();
    const memory = new Rfc64CatalogMutationMemoryV1(undefined, store.readVerified);
    store.apply(applied(SCOPE_A, 1), SCOPE_A);
    store.apply(applied(SCOPE_B, 1), SCOPE_B);
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    const otherScope = await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY);
    const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
    rows.replace('binding', new Map([['row', { transfer: {}, projection: {} } as never]]));

    memory.forget(SCOPE_A, AUTHOR);

    expect(memory.verifiedRows(SCOPE_A, AUTHOR)).not.toBe(rows);
    expect(memory.verifiedRows(SCOPE_A, AUTHOR)!.size).toBe(0);
    await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
    expect(store.readVerified).toHaveBeenCalledTimes(3);
    // Another scope is untouched.
    expect(await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY)).toBe(otherScope);
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
    const committed = applied(SCOPE_A, 2);
    store.apply(committed);
    const current = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
    expect(current.current).toBe(committed);
    release();
    expect((await slow)!.current!.currentCatalogHeadDigest).toBe(previous.current!.currentCatalogHeadDigest);

    // The slower read's state names head 1: it is checked against the applied head, not served.
    const after = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
    expect(after.current!.currentCatalogHeadDigest).toBe(committed.currentCatalogHeadDigest);
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
      for (const scope of [SCOPE_A, SCOPE_B, SCOPE_C, scopeD]) store.apply(applied(scope, 1), scope);

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
      const committed = applied(SCOPE_C, 2);
      memory.advance(large!, committed, {
        headObjectDigest: committed.currentCatalogHeadDigest,
        signatureVariantDigest: digest(77),
      }, large!.assets);
      expect(memory.retained.bytes).toBeLessThanOrEqual(budget);
    });

    it('counts the verified rows of a scope against the same budget', async () => {
      const store = durableStore(() => [asset(1, 16)]);
      const stateBytes = 16 + RETAINED_STATE_ROW_BYTES_V1;
      const memory = new Rfc64CatalogMutationMemoryV1(
        { maxScopes: 16, maxRetainedBytes: 2 * stateBytes + 2 * RETAINED_VERIFIED_ROW_BYTES_V1 },
        store.readVerified,
      );
      const outcome = { transfer: {}, projection: {} } as never;
      for (const scope of [SCOPE_A, SCOPE_B, SCOPE_C]) store.apply(applied(scope, 1), scope);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY);

      // A successor completes for B: its two verified rows fill what was left.
      memory.verifiedRows(SCOPE_B, AUTHOR)!.replace('binding', new Map([['row-1', outcome], ['row-2', outcome]]));
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
      tight.verifiedRows(SCOPE_A, AUTHOR)!.replace('binding', new Map([['row-1', outcome]]));
      await tight.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(tight.retained).toEqual({ scopes: 1, states: 0, bytes: RETAINED_VERIFIED_ROW_BYTES_V1 });
    });

    it('remembers nothing at all when it is switched off', async () => {
      const store = durableStore();
      const memory = new Rfc64CatalogMutationMemoryV1(resolveCatalogMutationMemoryLimitsV1('0'), store.readVerified);
      store.apply(applied(SCOPE_A, 1));

      const first = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(2);
      expect(memory.verifiedRows(SCOPE_A, AUTHOR)).toBeUndefined();
      const committed = applied(SCOPE_A, 2);
      const next = memory.advance(first, committed, {
        headObjectDigest: committed.currentCatalogHeadDigest,
        signatureVariantDigest: digest(77),
      }, first.assets);
      expect(next.current).toBe(committed);
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
          appliedHead = Object.freeze({
            catalogScopeDigest: scopeDigest,
            authorAddress: PRODUCER_AUTHOR,
            currentCatalogHeadDigest: head.objectDigest as Digest32V1,
            appliedInventoryDigest: digest(step),
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

      const placements = [await producerAssetV1(1), await producerAssetV1(2), await producerAssetV1(3, '2')];
      for (const [index, incoming] of placements.entries()) {
        // As the upsert does: its own copy of the incoming asset, replaced in place or appended.
        const own = snapshotRfc64PublicCatalogSuccessorAssetV1(incoming);
        const assets = [...state.assets];
        const existing = assets.findIndex(({ seal }) => seal.reservedKaId === own.seal.reservedKaId);
        if (existing >= 0) assets[existing] = own;
        else assets.push(own);
        const committed = await catalog.advance(assets, index + 2);
        const carried = memory.advance(state, committed.applied, committed.successor, assets);

        const fresh = await readVerifiedRfc64CatalogMutationStateV1(catalog.persistence, committed.applied);
        expect(carried).toEqual(fresh);
        expect(carried.assets.map(({ seal }) => seal.kaUal)).toEqual(fresh.assets.map(({ seal }) => seal.kaUal));
        expect(await memory.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY)).toBe(carried);
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

      const [firstDigest, secondDigest] = [...catalog.bundles.keys()];
      const firstBundle = catalog.bundles.get(firstDigest!)!;
      catalog.bundles.set(firstDigest!, catalog.bundles.get(secondDigest!)!);
      await expect(read()).rejects.toThrow('RFC-64 applied catalog bundle differs from its signed predecessor row');
      catalog.bundles.delete(firstDigest!);
      await expect(read()).rejects.toThrow(/RFC-64 applied catalog bundle 0x[0-9a-f]{64} is unavailable/u);
      catalog.bundles.set(firstDigest!, firstBundle);

      const delegationDigest = catalog.genesis.authorization.catalogIssuerDelegation.objectDigest;
      const delegation = catalog.objects.get(delegationDigest);
      catalog.objects.delete(delegationDigest);
      await expect(read()).rejects.toThrow('RFC-64 applied author head delegation is not durably staged');
      catalog.objects.set(delegationDigest, delegation);

      catalog.objects.delete(head.currentCatalogHeadDigest);
      await expect(read()).rejects.toThrow('RFC-64 applied author head is not durably staged');

      // A read that fails keeps nothing.
      const memory = new Rfc64CatalogMutationMemoryV1();
      await expect(memory.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY)).rejects.toThrow();
      expect(memory.retained.states).toBe(0);
    });
  });
});
