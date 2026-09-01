// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AssertionCoordinateV1,
  CanonicalDeterministicUalV1,
  ContextGraphIdV1,
  Digest32V1,
  EvmAddressV1,
  PositiveDecimalU64V1,
  SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';

import { createRfc64FinalizedPrivatePlacementRepairStoreV1 } from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { openInventoryV1 } from '../src/rfc64/inventory-v1/index.js';

const roots: string[] = [];
const inventories: Array<Awaited<ReturnType<typeof openInventoryV1>>> = [];
const repair = Object.freeze({
  version: 1 as const,
  contextGraphId: 'finalized-private-repair' as ContextGraphIdV1,
  authorAddress: `0x${'11'.repeat(20)}` as EvmAddressV1,
  inventoryScope: Object.freeze({
    networkId: 'testnet' as const,
    contextGraphId: 'finalized-private-repair' as ContextGraphIdV1,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    authorAddress: `0x${'11'.repeat(20)}` as EvmAddressV1,
    subGraphName: null,
    era: '1' as const,
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
