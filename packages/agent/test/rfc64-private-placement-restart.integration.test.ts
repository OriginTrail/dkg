// SPDX-License-Identifier: Apache-2.0
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AssertionCoordinateV1, CanonicalDeterministicUalV1, ContextGraphIdV1,
  Digest32V1, EvmAddressV1, PositiveDecimalU64V1, SwmAuthorInventoryScopeV1 } from '@origintrail-official/dkg-core';
import { openInventoryV1 } from '../src/rfc64/inventory-v1/index.js';
import { createRfc64FinalizedPrivatePlacementRepairStoreV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { agents, startRepairAgentV1, tempDirs } from './support/rfc64-local-catalog-repair-fixture.js';

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

it('restores actual node repair failure evidence and keeps inactive owed work after restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dkg-private-repair-native-')); tempDirs.push(dataDir);
  const inventory = await openInventoryV1(dataDir);
  try { await createRfc64FinalizedPrivatePlacementRepairStoreV1(inventory).put(repair); }
  finally { inventory.close(); }
  const first = await startRepairAgentV1({ name: 'private-repair-before-restart', dataDir });
  await first.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  const before = first.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.finalizedPrivatePlacement.failures;
  expect(before).toMatchObject({ failedMarkers: 1, kinds: [{ kind: 'lane_inactive', count: 1 }] });
  await first.stop(); agents.splice(agents.indexOf(first), 1);
  const read = await openInventoryV1(dataDir);
  let firstFailureAt: number;
  try {
    const store = createRfc64FinalizedPrivatePlacementRepairStoreV1(read);
    expect(store.list()).toEqual([repair]);
    firstFailureAt = store.readFailure!(repair)!.firstFailedAtMs;
  } finally { read.close(); }
  const second = await startRepairAgentV1({ name: 'private-repair-after-restart', dataDir });
  await second.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  const after = second.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.finalizedPrivatePlacement.failures;
  expect(after).toMatchObject({ failedMarkers: 1, kinds: [{ kind: 'lane_inactive', count: 1 }] });
  expect(after!.maxConsecutiveFailures).toBeGreaterThanOrEqual(before!.maxConsecutiveFailures);
  expect(after!.oldestFailureAgeMs).toBeGreaterThanOrEqual(before!.oldestFailureAgeMs!);
  expect(second.retryRfc64FailedPrivatePlacementsV1()).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 10));
  await second.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  await second.stop(); agents.splice(agents.indexOf(second), 1);
  const final = await openInventoryV1(dataDir);
  try {
    const store = createRfc64FinalizedPrivatePlacementRepairStoreV1(final);
    expect(store.list()).toEqual([repair]); // An inactive lane is never acknowledged as placed.
    expect(store.readFailure!(repair)).toMatchObject({ firstFailedAtMs: firstFailureAt, kind: 'lane_inactive' });
  } finally { final.close(); }
}, 60000);
