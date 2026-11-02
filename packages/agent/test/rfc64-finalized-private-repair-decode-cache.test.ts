// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatementSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeCanonicalGraphScopedAuthorSealDigestV1,
  type AssertionCoordinateV1, type CanonicalDeterministicUalV1, type ContextGraphIdV1, type DecimalU64V1,
  type Digest32V1, type EvmAddressV1, type NetworkIdV1, type PositiveDecimalU64V1,
} from '@origintrail-official/dkg-core';
import * as codec from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { FinalizedPrivateRepairPersistenceV1 } from '../src/rfc64/inventory-v1/finalized-private-repair-persistence.js';
import { openInventoryV1 } from '../src/rfc64/inventory-v1/index.js';
import { authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';

const GRAPH = 'repair-decode-cache' as ContextGraphIdV1;
const AUTHOR = `0x${'11'.repeat(20)}` as EvmAddressV1;
type Repair = codec.Rfc64FinalizedPrivatePlacementRepairV1;
const inventories: Awaited<ReturnType<typeof openInventoryV1>>[] = [];
const roots: string[] = [];

function legacy(index: number): Repair {
  return {
    version: 1, contextGraphId: GRAPH, authorAddress: AUTHOR,
    inventoryScope: {
      networkId: 'testnet' as NetworkIdV1, contextGraphId: GRAPH,
      governanceChainId: null, governanceContractAddress: null,
      ownershipTransitionDigest: null, authorAddress: AUTHOR,
      subGraphName: null, era: '1' as DecimalU64V1,
    },
    assertionCoordinate: `asset-${index}` as AssertionCoordinateV1,
    assertionVersion: '1' as PositiveDecimalU64V1,
    kaUal: `did:dkg:otp:20430/${AUTHOR}/${index}` as CanonicalDeterministicUalV1,
    sealDigest: `0x${'22'.repeat(32)}` as Digest32V1,
  };
}

async function confirmed(index: bigint): Promise<Repair> {
  const seal = await authorSealV1(index);
  return {
    version: 2, contextGraphId: GRAPH, authorAddress: seal.authorAddress,
    inventoryScope: null, subGraphName: null,
    assertionCoordinate: `confirmed-${index}` as AssertionCoordinateV1,
    assertionVersion: seal.assertionVersion, kaUal: seal.kaUal,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal,
  };
}

async function openStore(root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'rfc64-repair-decode-cache-'));
  if (!root) roots.push(directory);
  const inventory = await openInventoryV1(directory);
  inventories.push(inventory);
  return { directory, store: codec.createRfc64FinalizedPrivatePlacementRepairStoreV1(inventory) };
}

afterEach(async () => {
  for (const inventory of inventories.splice(0)) inventory.close();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true })));
});

describe('validated finalized-placement snapshots', () => {
  it('does not repeat canonical decoding for unchanged V1/V2 bytes, and validates a newly owed row', async () => {
    const { store } = await openStore();
    const v1 = legacy(1), v2 = await confirmed(901n);
    await store.put(v1); await store.put(v2);
    const parse = vi.spyOn(codec, 'parseRfc64FinalizedPrivatePlacementRepairV1');
    const cold = await store.listAsync(new AbortController().signal);
    expect(cold).toEqual(expect.arrayContaining([v1, v2]));
    expect(parse).toHaveBeenCalledTimes(2);
    expect(store.list()).toEqual(cold);
    expect(await store.listAsync(new AbortController().signal)).toEqual(cold);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(cold.every(row => Object.isFrozen(row))).toBe(true);
    const sealed = cold.find(row => row.version === 2);
    if (sealed?.version !== 2) throw new Error('confirmed record missing');
    expect(Object.isFrozen(sealed.seal)).toBe(true);
    await store.put(legacy(2));
    expect(await store.listAsync(new AbortController().signal)).toHaveLength(3);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('drops completed rows and starts cold when the durable owner reopens', async () => {
    const first = await openStore(); const repair = legacy(1);
    await first.store.put(repair);
    const parse = vi.spyOn(codec, 'parseRfc64FinalizedPrivatePlacementRepairV1');
    expect(first.store.list()).toEqual([repair]);
    expect(parse).toHaveBeenCalledTimes(1);
    await first.store.delete(repair);
    expect(await first.store.listAsync(new AbortController().signal)).toEqual([]);
    await first.store.put(repair);
    expect(first.store.list()).toEqual([repair]);
    expect(parse).toHaveBeenCalledTimes(2);
    inventories.pop()!.close();
    const reopened = await openStore(first.directory);
    expect(reopened.store.list()).toEqual([repair]);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('still rejects a changed stored digest or storage type after a warm read', async () => {
    const f = memoryRows([legacy(1)]);
    expect(f.persistence.listFinalizedPrivatePlacementRepairs()).toHaveLength(1);
    const original = f.rows[0]!;
    f.rows = [{ ...original, repair_digest: new Uint8Array(32).fill(7) }];
    await expect(f.persistence.listFinalizedPrivatePlacementRepairsAsync(new AbortController().signal)).rejects.toThrow('digest-bound');
    f.rows = [{ ...original, repair_digest: 'not-a-blob' }];
    expect(() => f.persistence.listFinalizedPrivatePlacementRepairs()).toThrow('storage types');
    f.rows = [{ ...original, repair_json: 5 }];
    await expect(f.persistence.listFinalizedPrivatePlacementRepairsAsync(new AbortController().signal)).rejects.toThrow('storage types');
    f.rows = [original];
    expect(f.persistence.listFinalizedPrivatePlacementRepairs()).toEqual([legacy(1)]);
  });

  it('does not publish a replacement cache when the read transaction fails after decoding', () => {
    const f = memoryRows([legacy(1)]);
    f.persistence.listFinalizedPrivatePlacementRepairs();
    const parse = vi.spyOn(codec, 'parseRfc64FinalizedPrivatePlacementRepairV1');
    f.rows = [sqlRow(legacy(2))]; f.failAfterRead = true;
    expect(() => f.persistence.listFinalizedPrivatePlacementRepairs()).toThrow('read completion failed');
    expect(parse).toHaveBeenCalledTimes(1);
    expect(f.persistence.listFinalizedPrivatePlacementRepairs()).toEqual([legacy(2)]);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('does not publish newly decoded entries from a corrupt asynchronous snapshot', async () => {
    const f = memoryRows([legacy(1)]);
    f.persistence.listFinalizedPrivatePlacementRepairs();
    const parse = vi.spyOn(codec, 'parseRfc64FinalizedPrivatePlacementRepairV1');
    f.rows = [sqlRow(legacy(2)), { ...sqlRow(legacy(3)), repair_json: 'broken' }];
    await expect(f.persistence.listFinalizedPrivatePlacementRepairsAsync(new AbortController().signal)).rejects.toThrow('not valid JSON');
    expect(parse).toHaveBeenCalledTimes(2);
    f.rows = [sqlRow(legacy(2))];
    expect(await f.persistence.listFinalizedPrivatePlacementRepairsAsync(new AbortController().signal)).toEqual([legacy(2)]);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('does not retain partial new entries when a sliced asynchronous snapshot is cancelled', async () => {
    const f = memoryRows([]); const parse = vi.spyOn(codec, 'parseRfc64FinalizedPrivatePlacementRepairV1');
    f.rows = Array.from({ length: 64 }, (_, i) => sqlRow(legacy(i + 1)));
    const controller = new AbortController();
    const listing = f.persistence.listFinalizedPrivatePlacementRepairsAsync(controller.signal);
    controller.abort(new Error('cancel snapshot'));
    await expect(listing).rejects.toThrow('cancel snapshot');
    const partial = parse.mock.calls.length;
    expect(partial).toBeGreaterThan(0); expect(partial).toBeLessThan(64);
    expect(await f.persistence.listFinalizedPrivatePlacementRepairsAsync(new AbortController().signal)).toHaveLength(64);
    expect(parse).toHaveBeenCalledTimes(partial + 64);
  });
});

function sqlRow(repair: Repair): Record<string, unknown> {
  const bytes = codec.encodeRfc64FinalizedPrivatePlacementRepairV1(repair);
  return { repair_digest: codec.digestRfc64FinalizedPrivatePlacementRepairV1(bytes), repair_json: new TextDecoder().decode(bytes) };
}

function memoryRows(repairs: Repair[]) {
  const f = { rows: repairs.map(sqlRow), failAfterRead: false };
  const persistence = new FinalizedPrivateRepairPersistenceV1({
    assertOpen() {},
    prepare: () => ({ all: () => f.rows }) as unknown as StatementSync,
    statement: run => run(),
    read: run => {
      const result = run();
      if (f.failAfterRead) { f.failAfterRead = false; throw new Error('read completion failed'); }
      return result;
    },
    write() { throw new Error('read fixture must not write'); },
    corrupt: message => new Error(message),
  });
  return Object.assign(f, { persistence });
}
