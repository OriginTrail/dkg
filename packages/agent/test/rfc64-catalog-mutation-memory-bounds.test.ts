/**
 * GH#3081 / GH#3072 — what bounds the catalog mutation memory: a number of scopes and a number of
 * retained bytes, held at every point where a scope grows, and the operator's switch.
 */
import type { Digest32V1 } from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1,
  RETAINED_STATE_ROW_BYTES_V1,
  RETAINED_VERIFIED_ROW_BYTES_V1,
  Rfc64CatalogMutationMemoryV1,
  installRfc64CatalogMutationMemoryV1,
  resolveCatalogMutationMemoryLimitsV1,
  rfc64CatalogMutationMemoryV1,
} from '../src/internal/catalog-mutation-memory.js';
import {
  AUTHOR,
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
} from './support/rfc64-catalog-mutation-memory-fixture.js';

describe('RFC-64 catalog mutation memory bounds', () => {
  afterEach(() => {
    delete process.env.DKG_RFC64_CATALOG_MUTATION_MEMORY;
  });

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
