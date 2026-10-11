// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  parseCanonicalGraphScopedAuthorSealV1,
  type AssertionCoordinateV1,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type DecimalU64V1,
  type PositiveDecimalU64V1,
  type SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';

import {
  createRfc64FinalizedPrivatePlacementRepairStoreV1,
  encodeRfc64FinalizedPrivatePlacementRepairV1,
  parseRfc64FinalizedPrivatePlacementRepairV1,
} from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';
import { openInventoryV1 } from '../src/rfc64/inventory-v1/index.js';

const roots: string[] = [];
const inventories: Array<Awaited<ReturnType<typeof openInventoryV1>>> = [];
const repair = Object.freeze({
  version: 1 as const,
  contextGraphId: 'finalized-private-repair' as ContextGraphIdV1,
  authorAddress: `0x${'11'.repeat(20)}` as EvmAddressV1,
  inventoryScope: Object.freeze({
    networkId: 'testnet' as NetworkIdV1,
    contextGraphId: 'finalized-private-repair' as ContextGraphIdV1,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    authorAddress: `0x${'11'.repeat(20)}` as EvmAddressV1,
    subGraphName: null,
    era: '1' as DecimalU64V1,
  }) satisfies SwmAuthorInventoryScopeV1,
  assertionCoordinate: 'asset-1' as AssertionCoordinateV1,
  assertionVersion: '1' as PositiveDecimalU64V1,
  kaUal: `did:dkg:otp:20430/0x${'11'.repeat(20)}/1` as CanonicalDeterministicUalV1,
  sealDigest: `0x${'22'.repeat(32)}` as Digest32V1,
});

afterEach(async () => {
  for (const inventory of inventories.splice(0)) inventory.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function openStore(dataDir: string) {
  const inventory = await openInventoryV1(dataDir);
  inventories.push(inventory);
  return createRfc64FinalizedPrivatePlacementRepairStoreV1(inventory);
}

describe('RFC-64 finalized-private placement repair store', () => {
  it('durably retains confirmation in the inventory database until exact completion', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-placement-repair-'));
    roots.push(dataDir);
    const first = await openStore(dataDir);
    await first.put(repair);
    await first.put(repair);
    expect(first.list()).toEqual([repair]);

    const inventory = inventories.pop();
    inventory?.close();
    const restarted = await openStore(dataDir);
    expect(restarted.list()).toEqual([repair]);
    await restarted.delete(repair);
    expect(restarted.list()).toEqual([]);
  });

  it('reopens mixed V1/V2 records and deletes only the exact sealed obligation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-confirmed-placement-mixed-'));
    roots.push(dataDir);
    const seal = await authorSealV1(991n);
    const confirmed = { ...repair, version: 2 as const, inventoryScope: null,
      subGraphName: null, authorAddress: seal.authorAddress, kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion, sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal };
    const first = await openStore(dataDir);
    await first.put(repair);
    await first.put(confirmed);
    inventories.pop()?.close();
    const restarted = await openStore(dataDir);
    expect(restarted.list()).toEqual(expect.arrayContaining([repair, confirmed]));
    await restarted.delete(confirmed);
    expect(restarted.list()).toEqual([repair]);
  });

  it('owns a bounded immutable seal for large private assertions without any payload rows', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-confirmed-placement-large-'));
    roots.push(dataDir);
    const original = await authorSealV1(992n);
    const largeSeal: unknown = { ...original, publicTripleCount: '0',
      privateTripleCount: '9007199254740991', privateMerkleRoot: `0x${'ab'.repeat(32)}` };
    assertCanonicalGraphScopedAuthorSealV1(largeSeal);
    const seal = parseCanonicalGraphScopedAuthorSealV1(canonicalizeCanonicalGraphScopedAuthorSealV1(largeSeal));
    const confirmed = { ...repair, version: 2 as const, inventoryScope: null,
      subGraphName: null, authorAddress: seal.authorAddress, kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion, sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal };
    const store = await openStore(dataDir);
    await store.put(confirmed);
    const recorded = store.list()[0];
    expect(recorded?.version).toBe(2);
    if (recorded?.version !== 2) throw new Error('expected confirmed seal record');
    expect(recorded.seal).toEqual(seal);
    expect(recorded.seal).not.toBe(seal);
    expect(Object.isFrozen(recorded.seal)).toBe(true);
    const bytes = encodeRfc64FinalizedPrivatePlacementRepairV1(recorded);
    expect(bytes.byteLength).toBeLessThan(2048);
    expect(Object.keys(recorded)).toHaveLength(10);
  });

  it('rejects altered V2 seals, scoped V2 records and unknown fields while retaining V1 bytes', async () => {
    const seal = await authorSealV1(993n);
    const confirmed = { ...repair, version: 2 as const, inventoryScope: null,
      subGraphName: null, authorAddress: seal.authorAddress, kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion, sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal };
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(() => parseRfc64FinalizedPrivatePlacementRepairV1(encode({ ...confirmed,
      seal: { ...seal, assertionVersion: '2' } }))).toThrow(/seal differs/);
    expect(() => parseRfc64FinalizedPrivatePlacementRepairV1(encode({ ...confirmed,
      inventoryScope: repair.inventoryScope }))).toThrow(/scope-independent/);
    expect(() => parseRfc64FinalizedPrivatePlacementRepairV1(encode({ ...confirmed,
      payload: [] }))).toThrow(/unknown fields/);
    expect(new TextDecoder().decode(encodeRfc64FinalizedPrivatePlacementRepairV1(repair)))
      .toBe(`${JSON.stringify(repair)}\n`);
  });

  it('keeps the repair queue co-located with SQLite and creates no parallel directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-placement-layout-'));
    roots.push(dataDir);
    const store = await openStore(dataDir);
    await store.put(repair);
    const persistenceRoot = join(dataDir, 'rfc64-sync');
    await expect(readdir(persistenceRoot)).resolves.not.toContain(
      'finalized-private-placement-repairs-v1',
    );
    expect(store.list()).toEqual([repair]);
  });
});
