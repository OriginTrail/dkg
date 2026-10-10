/**
 * GH#3081 / GH#3072 — the verified state of an author catalog kept in memory between placements:
 * when it is served, when it is read again from the durable store, what a carried state holds,
 * and which failures of a mutation forget it. Its bounds and what it reads back from a real
 * catalog are in the two suites beside this one.
 */
import { describe, expect, it, vi } from 'vitest';

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
  RETAINED_STATE_ROW_BYTES_V1,
  RETAINED_VERIFIED_ROW_BYTES_V1,
  Rfc64CatalogMutationMemoryV1,
} from '../src/internal/catalog-mutation-memory.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../src/rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from
  '../src/rfc64/public-catalog-successor-asset-v1.js';
import {
  AUTHOR,
  AUTHORIZATION,
  DELEGATION_DIGEST,
  OUTCOME,
  POLICY,
  SCOPE_A,
  SCOPE_B,
  SCOPE_C,
  applied,
  asset,
  committed,
  digest,
  durableStore,
  stateOf,
} from './support/rfc64-catalog-mutation-memory-fixture.js';

describe('RFC-64 catalog mutation memory', () => {
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
      mutation.producing();
      mutation.failed();

      expect(memory.verifiedRows(SCOPE_A, AUTHOR)).not.toBe(rows);
      expect(memory.verifiedRows(SCOPE_A, AUTHOR)!.size).toBe(0);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(3);
      // Another scope is untouched.
      expect(await memory.read(store.persistence, SCOPE_B, AUTHOR, POLICY)).toBe(otherScope);
    });

    it('forgets its scope when it fails before it asked for any successor', async () => {
      const { store, memory } = await mutating();
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);

      // A request the mutation refuses from the state it read.
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      mutation.failed();

      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(3);
    });

    it('keeps the committed state when it fails after its own applied-head CAS', async () => {
      const { store, memory } = await mutating();
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      mutation.producing();
      const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
      rows.replace('binding', new Map([['row', OUTCOME]]));
      const second = committed(SCOPE_A, 2, previous.assets);
      const next = mutation.committed(previous, second.applied, second.successor, previous.assets);
      store.apply(second.applied);

      // Handing the committed head to its peers throws.
      mutation.failed();

      // Both scopes still hold their state.
      expect(memory.retained.states).toBe(2);
      expect(memory.verifiedRows(SCOPE_A, AUTHOR)).toBe(rows);
      expect(await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).toBe(next);
      expect(store.readVerified).toHaveBeenCalledTimes(2);
    });

    it('keeps the committed state whatever looked up the rows of the scope in between', async () => {
      const { store, memory } = await mutating();
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      mutation.producing();
      const second = committed(SCOPE_A, 2, previous.assets);
      const next = mutation.committed(previous, second.applied, second.successor, previous.assets);
      store.apply(second.applied);

      // Another production of the scope asks for its rows; that is not this mutation's business.
      memory.verifiedRows(SCOPE_A, AUTHOR);
      mutation.failed();

      expect(await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY)).toBe(next);
    });

    it('keeps the verified rows of a committed successor whose state does not fit the budget', async () => {
      const store = durableStore(() => [asset(1, 16)]);
      const stateBytes = 16 + RETAINED_STATE_ROW_BYTES_V1;
      const memory = new Rfc64CatalogMutationMemoryV1(
        { maxScopes: 16, maxRetainedBytes: RETAINED_VERIFIED_ROW_BYTES_V1 + stateBytes - 1 },
        store.readVerified,
      );
      store.apply(applied(SCOPE_A, 1, { inventoryRowCount: '1' as never }));
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      mutation.producing();
      const rows = memory.verifiedRows(SCOPE_A, AUTHOR)!;
      rows.replace('binding', new Map([['row', OUTCOME]]));
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      const second = committed(SCOPE_A, 2, previous.assets);
      mutation.committed(previous, second.applied, second.successor, previous.assets);

      mutation.failed();

      expect(memory.retained).toEqual({ scopes: 1, states: 0, bytes: RETAINED_VERIFIED_ROW_BYTES_V1 });
      expect(rows.find('binding', 'row')).toBe(OUTCOME);
    });

    it('forgets the scope when it fails after a further successor was asked for', async () => {
      const { store, memory } = await mutating();
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      mutation.producing();
      const second = committed(SCOPE_A, 2, previous.assets);
      mutation.committed(previous, second.applied, second.successor, previous.assets);

      mutation.producing();
      mutation.failed();

      // Only the scope of the mutation went; the other scope is the one still held.
      expect(memory.retained).toMatchObject({ scopes: 1, states: 1 });
      store.apply(second.applied);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(3);
    });

    it('forgets the scope when the next mutation fails before a CAS of its own', async () => {
      const { store, memory } = await mutating();
      const first = memory.mutation(SCOPE_A, AUTHOR);
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      first.producing();
      const second = committed(SCOPE_A, 2, previous.assets);
      first.committed(previous, second.applied, second.successor, previous.assets);
      store.apply(second.applied);

      // The earlier mutation's CAS does not excuse a later mutation's failure.
      const later = memory.mutation(SCOPE_A, AUTHOR);
      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      later.failed();

      await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY);
      expect(store.readVerified).toHaveBeenCalledTimes(3);
    });

    it('has nothing left to forget after a commit that did not name the signed set', async () => {
      const { store, memory } = await mutating();
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      const previous = (await memory.read(store.persistence, SCOPE_A, AUTHOR, POLICY))!;
      mutation.producing();
      const second = committed(SCOPE_A, 2, previous.assets);
      mutation.committed(previous, { ...second.applied, appliedInventoryDigest: digest(9) }, second.successor, previous.assets);
      expect(memory.retained).toMatchObject({ scopes: 1, states: 1 });

      mutation.failed();
      expect(memory.retained).toMatchObject({ scopes: 1, states: 1 });
    });

    it('has nothing to forget for a scope it never remembered', () => {
      const memory = new Rfc64CatalogMutationMemoryV1();
      const mutation = memory.mutation(SCOPE_A, AUTHOR);
      mutation.producing();
      mutation.failed();
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
    rows.invalidate();
    expect(later.size).toBe(1);
    // The failure of the production that holds them does.
    later.invalidate();
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
});
