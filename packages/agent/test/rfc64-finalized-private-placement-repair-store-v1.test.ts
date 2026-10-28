import { pinnedPrivatePlacementAuthorityV1 } from './support/finalized-placement-decision-fixture.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { CATALOG_REPAIR_FAILURE_KINDS_V1 } from '../src/rfc64/private-placement-failure-state-v1.js';
import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { CatalogRepairConditionErrorV1 } from '../src/rfc64/catalog-repair-diagnostics-v1.js';
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

const owners: Rfc64SwmCatalogProjectionOwnerV1[] = [];
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
  await Promise.all(owners.splice(0).map(owner => owner.close()));
  vi.useRealTimers();
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
    await expect(first.put({ ...confirmed, subGraphName: 'team' } as unknown as Rfc64FinalizedPrivatePlacementRepairV1)).rejects.toThrow('root graphs only');
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

const failure = Object.freeze({ kind: 'signer_mismatch' as const, consecutiveFailures: 3,
  sameKindFailures: 3, firstFailedAtMs: 1000, lastFailedAtMs: 16000, nextAttemptAtMs: null, parked: true });

it('retains bounded failure evidence on reopen and cascades it only with exact marker completion', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-failure-')); roots.push(dataDir);
  const store = await openStore(dataDir);
  // Diagnostic writes must never manufacture owed work.
  store.writeFailure(repair, failure);
  expect(store.list()).toEqual([]); expect(store.readFailure(repair)).toBeNull();
  await store.put(repair); store.writeFailure(repair, failure);
  await store.put(repair); // Idempotent queue admission does not erase the prior failure.
  inventories.pop()!.close();
  const reopened = await openStore(dataDir);
  expect(reopened.list()).toEqual([repair]); expect(reopened.readFailure(repair)).toEqual(failure);
  const unrelated = { ...repair, assertionCoordinate: 'other' as AssertionCoordinateV1, assertionVersion: '2' as PositiveDecimalU64V1 };
  await reopened.put(unrelated); expect(reopened.readFailure(unrelated)).toBeNull();
  await reopened.delete(repair); expect(reopened.readFailure(repair)).toBeNull();
  expect(reopened.list()).toEqual([unrelated]);
  reopened.writeFailure(repair, failure); expect(reopened.readFailure(repair)).toBeNull();
});

it('upgrades the prior exact v5 schema while retaining canonical owed rows', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-failure-v5-')); roots.push(dataDir);
  const store = await openStore(dataDir); await store.put(repair); inventories.pop()!.close();
  const path = join(dataDir, 'rfc64-sync', 'inventory-v1.sqlite3');
  const old = new DatabaseSync(path);
  old.exec('DROP TABLE rfc64_private_placement_failures_v1; PRAGMA user_version = 5'); old.close();
  const upgraded = await openStore(dataDir);
  expect(upgraded.list()).toEqual([repair]); expect(upgraded.readFailure(repair)).toBeNull();
  upgraded.writeFailure(repair, failure); inventories.pop()!.close();
  const read = new DatabaseSync(path); expect(read.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 }); read.close();
  const reopened = await openStore(dataDir); expect(reopened.readFailure(repair)).toEqual(failure);
});

it('refuses invalid failure state, and ignores damaged diagnostics without losing owed work', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-failure-corrupt-')); roots.push(dataDir);
  const store = await openStore(dataDir); await store.put(repair);
  expect(() => store.writeFailure(repair, { ...failure, kind: 'secret' } as any)).toThrow('Invalid');
  store.writeFailure(repair, failure);
  expect(() => store.writeFailure(repair, null as any)).toThrow('Invalid');
  expect(store.readFailure(repair)).toEqual(failure);
  inventories.pop()!.close();
  const db = new DatabaseSync(join(dataDir, 'rfc64-sync', 'inventory-v1.sqlite3'));
  db.exec("UPDATE rfc64_private_placement_failures_v1 SET state_json = 'broken'"); db.close();
  const reopened = await openStore(dataDir);
  expect(reopened.readFailure(repair)).toBeNull(); expect(reopened.list()).toEqual([repair]);
  reopened.writeFailure(repair, failure); expect(reopened.readFailure(repair)).toEqual(failure);
});


it('restores real SQLite failure age, cooldown and parking, then retries only by explicit operator action', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-owner-restart-')); roots.push(dataDir);
  let store = await openStore(dataDir); await store.put(repair);
  const ctx = createOperationContext('system');
  const attempt = vi.fn(async (): Promise<void> => { throw new CatalogRepairConditionErrorV1('signer_mismatch', 'private detail'); });
  const makeOwner = () => {
    const owner = new Rfc64SwmCatalogProjectionOwnerV1({
      resolvePartition: () => ({ retryIntervalMs: 5000, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
      listDurableInventoryScopes: () => [],
      listLocalAuthorAddresses: () => [], acceptsPublicRootLane: () => true,
      readFinalizedPlacementAuthority: () => pinnedPrivatePlacementAuthorityV1(repair), readRepairRevision: () => null,
      listFinalizedPrivateRepairs: () => store.list(), readPrivateFailure: row => store.readFailure(row),
      writePrivateFailures: entries => store.writeFailures(entries),
      repairFinalizedPrivatePlacement: attempt, reconcile: async () => null, warn: vi.fn(),
    });
    owners.push(owner); return owner;
  };
  let owner = makeOwner(); owner.start(ctx); await owner.whenIdle();
  expect(attempt).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000); await owner.whenIdle();
  expect(attempt).toHaveBeenCalledTimes(2);
  await owner.close(); inventories.pop()!.close();
  vi.setSystemTime(7000); store = await openStore(dataDir); owner = makeOwner();
  owner.start(ctx); await owner.whenIdle();
  expect(attempt).toHaveBeenCalledTimes(2); // Restart cannot bypass the persisted 16000 deadline.
  expect(owner.status()?.finalizedPrivatePlacement.failures).toMatchObject({
    failedMarkers: 1, parkedMarkers: 0, maxConsecutiveFailures: 2, oldestFailureAgeMs: 6000,
    kinds: [{ kind: 'signer_mismatch', count: 1 }],
  });
  await vi.advanceTimersByTimeAsync(10000); await owner.whenIdle();
  expect(attempt).toHaveBeenCalledTimes(3); expect(store.readFailure(repair)?.parked).toBe(true);
  await owner.close(); inventories.pop()!.close();
  store = await openStore(dataDir); owner = makeOwner(); owner.start(ctx); await owner.whenIdle();
  await vi.advanceTimersByTimeAsync(60000); await owner.whenIdle();
  expect(attempt).toHaveBeenCalledTimes(3); expect(store.list()).toEqual([repair]);
  expect(owner.status()?.finalizedPrivatePlacement.failures?.parkedMarkers).toBe(1);
  attempt.mockImplementation(async () => { await store.delete(repair); });
  expect(owner.retryFailedPrivate(ctx)).toBe(1);
  expect(store.list()).toEqual([repair]); // Retry schedules; it never declares the obligation complete.
  expect(store.readFailure(repair)).toMatchObject({ firstFailedAtMs: 1000, parked: false, consecutiveFailures: 0 });
  await vi.advanceTimersByTimeAsync(0); await owner.whenIdle();
  expect(attempt).toHaveBeenCalledTimes(4); expect(store.list()).toEqual([]);
  expect(store.readFailure(repair)).toBeNull();
  expect(owner.status()?.finalizedPrivatePlacement.failures?.failedMarkers).toBe(0);
  await owner.close(); expect(() => owner.retryFailedPrivate(ctx)).toThrow('closed');
});


it('rolls back the entire reset batch when SQLite rejects its second row', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-batch-')); roots.push(dataDir);
  const store = await openStore(dataDir);
  const other = { ...repair, assertionCoordinate: 'asset-2' as AssertionCoordinateV1 };
  await store.put(repair); await store.put(other);
  store.writeFailure(repair, failure); store.writeFailure(other, { ...failure, firstFailedAtMs: 2000 });
  const db = new DatabaseSync(join(dataDir, 'rfc64-sync', 'inventory-v1.sqlite3'));
  try {
    const canonical = db.prepare('SELECT repair_digest, repair_json FROM rfc64_finalized_private_placement_repairs_v1 ORDER BY repair_digest').all();
    db.exec(`CREATE TRIGGER reject_second_reset BEFORE UPDATE ON rfc64_private_placement_failures_v1
      WHEN json_extract(OLD.state_json, '$.firstFailedAtMs') = 2000
      BEGIN SELECT RAISE(ABORT, 'second reset rejected'); END;`);
    const reset = { ...failure, consecutiveFailures: 0, sameKindFailures: 0, parked: false };
    const entries = [{ repair, state: reset }, { repair: other, state: { ...reset, firstFailedAtMs: 2000 } }];
    expect(() => store.writeFailures(entries)).toThrow();
    expect(store.readFailure(repair)).toEqual(failure);
    expect(store.readFailure(other)).toEqual({ ...failure, firstFailedAtMs: 2000 });
    db.exec('DROP TRIGGER reject_second_reset');
    store.writeFailures(entries);
    expect(store.readFailure(repair)).toEqual(entries[0].state);
    expect(store.readFailure(other)).toEqual(entries[1].state);
    expect(db.prepare('SELECT repair_digest, repair_json FROM rfc64_finalized_private_placement_repairs_v1 ORDER BY repair_digest').all()).toEqual(canonical);
    inventories.pop()!.close();
    const reopened = await openStore(dataDir);
    expect(reopened.readFailure(repair)).toEqual(entries[0].state);
    expect(reopened.readFailure(other)).toEqual(entries[1].state);
  } finally { db.close(); }
});

it('round-trips every declared failure kind through real SQLite and restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-kind-')); roots.push(dataDir);
  let store = await openStore(dataDir);
  const entries = CATALOG_REPAIR_FAILURE_KINDS_V1.map(kind => ({ repair: { ...repair, assertionCoordinate: `kind-${kind}` as AssertionCoordinateV1 },
    state: { ...failure, kind, parked: false } }));
  for (const entry of entries) await store.put(entry.repair);
  store.writeFailures(entries); inventories.pop()!.close(); store = await openStore(dataDir);
  for (const entry of entries) expect(store.readFailure(entry.repair)).toEqual(entry.state);
});


it.each(['availability', 'refused request'] as const)('persists a %s lane reset before stopping and reopening a parked marker', async transition => {
  vi.useFakeTimers(); vi.setSystemTime(20000);
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-lane-reset-')); roots.push(dataDir);
  let store = await openStore(dataDir); await store.put(repair); store.writeFailure(repair, failure);
  const other = { ...repair, assertionCoordinate: 'asset-2' as AssertionCoordinateV1 };
  await store.put(other); store.writeFailure(other, { ...failure, firstFailedAtMs: 2000 });
  const ctx = createOperationContext('system');
  let laneActive = true;
  const attempt = vi.fn(async (row: Parameters<typeof store.delete>[0]) => { await store.delete(row); });
  const makeOwner = () => {
    const owner = new Rfc64SwmCatalogProjectionOwnerV1({
      resolvePartition: () => ({ retryIntervalMs: 5000, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
      listDurableInventoryScopes: () => [], listLocalAuthorAddresses: () => [], acceptsPublicRootLane: () => true,
      readFinalizedPlacementAuthority: () => pinnedPrivatePlacementAuthorityV1(repair, laneActive), readRepairRevision: () => null,
      listFinalizedPrivateRepairs: () => store.list(), readPrivateFailure: row => store.readFailure(row),
      writePrivateFailures: entries => store.writeFailures(entries),
      repairFinalizedPrivatePlacement: attempt, reconcile: async () => null, warn: vi.fn(),
    });
    owners.push(owner); return owner;
  };
  let owner = makeOwner(); owner.start(ctx); await owner.whenIdle();
  expect(attempt).not.toHaveBeenCalled();
  expect(owner.status()?.finalizedPrivatePlacement.failures?.parkedMarkers).toBe(2);
  laneActive = false;
  if (transition === 'availability') owner.observeLaneAvailability(repair.contextGraphId);
  else expect(owner.requestFinalizedPrivate({ repair, ctx }).accepted).toBe(false);
  // Stop before an attempt can replace the durable failure record.
  await owner.close(); inventories.pop()!.close();
  store = await openStore(dataDir);
  expect(store.list()).toHaveLength(2);
  expect(store.readFailure(repair)).toEqual({ ...failure, consecutiveFailures: 0,
    sameKindFailures: 0, nextAttemptAtMs: null, parked: false });
  expect(store.readFailure(other)).toEqual({ ...failure, firstFailedAtMs: 2000, consecutiveFailures: 0,
    sameKindFailures: 0, nextAttemptAtMs: null, parked: false });
  expect(attempt).not.toHaveBeenCalled();
  laneActive = true;
  owner = makeOwner(); owner.start(ctx); await owner.whenIdle();
  expect(attempt).toHaveBeenCalledTimes(2);
  expect(store.list()).toEqual([]);
});


it('keeps all lane observations unchanged when SQLite rejects the reset batch, then retries the same edge', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  vi.useFakeTimers(); vi.setSystemTime(20000);
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-lane-rollback-')); roots.push(dataDir);
  const store = await openStore(dataDir);
  const other = { ...repair, assertionCoordinate: 'asset-2' as AssertionCoordinateV1 };
  await store.put(repair); await store.put(other);
  store.writeFailure(repair, failure); store.writeFailure(other, { ...failure, firstFailedAtMs: 2000 });
  let laneActive = true;
  const attempt = vi.fn(async () => {});
  const owner = new Rfc64SwmCatalogProjectionOwnerV1({
    resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
    listDurableInventoryScopes: () => [], listLocalAuthorAddresses: () => [], acceptsPublicRootLane: () => true,
    readFinalizedPlacementAuthority: () => pinnedPrivatePlacementAuthorityV1(repair, laneActive), readRepairRevision: () => null,
    listFinalizedPrivateRepairs: () => store.list(), readPrivateFailure: row => store.readFailure(row),
    writePrivateFailures: entries => store.writeFailures(entries),
    repairFinalizedPrivatePlacement: attempt, reconcile: async () => null, warn: vi.fn(),
  });
  owners.push(owner); owner.start(createOperationContext('system')); await owner.whenIdle();
  const db = new DatabaseSync(join(dataDir, 'rfc64-sync', 'inventory-v1.sqlite3'));
  try {
    const canonical = db.prepare('SELECT repair_digest, repair_json FROM rfc64_finalized_private_placement_repairs_v1 ORDER BY repair_digest').all();
    db.exec(`CREATE TRIGGER reject_lane_reset BEFORE UPDATE ON rfc64_private_placement_failures_v1
      WHEN OLD.repair_digest = (SELECT repair_digest FROM rfc64_finalized_private_placement_repairs_v1
        ORDER BY repair_digest LIMIT 1 OFFSET 1)
      BEGIN SELECT RAISE(ABORT, 'lane reset rejected'); END;`);
    laneActive = false; owner.observeLaneAvailability(repair.contextGraphId);
    expect(store.readFailure(repair)).toEqual(failure);
    expect(store.readFailure(other)).toEqual({ ...failure, firstFailedAtMs: 2000 });
    expect(owner.status()?.finalizedPrivatePlacement.failures).toMatchObject({ parkedMarkers: 2, maxConsecutiveFailures: 3 });
    db.exec('DROP TRIGGER reject_lane_reset');
    // No intervening activation: persistence failure must not consume the edge.
    owner.observeLaneAvailability(repair.contextGraphId);
    expect(owner.status()?.finalizedPrivatePlacement.failures).toMatchObject({ parkedMarkers: 0, maxConsecutiveFailures: 0 });
    expect(store.readFailure(repair)).toMatchObject({ parked: false, firstFailedAtMs: 1000, lastFailedAtMs: 16000 });
    expect(store.readFailure(other)).toMatchObject({ parked: false, firstFailedAtMs: 2000, lastFailedAtMs: 16000 });
    expect(db.prepare('SELECT repair_digest, repair_json FROM rfc64_finalized_private_placement_repairs_v1 ORDER BY repair_digest').all()).toEqual(canonical);
    expect(attempt).not.toHaveBeenCalled();
  } finally { db.close(); }
});

it.each(['availability', 'refused request'] as const)(
  'retains a failed %s reset across reactivation and commits every sibling reset before repair admission', async transition => {
    const { DatabaseSync } = await import('node:sqlite');
    vi.useFakeTimers(); vi.setSystemTime(20000);
    const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-lane-reactivation-')); roots.push(dataDir);
    const store = await openStore(dataDir);
    const other = { ...repair, assertionCoordinate: 'asset-2' as AssertionCoordinateV1 };
    await store.put(repair); await store.put(other);
    store.writeFailure(repair, failure); store.writeFailure(other, { ...failure, firstFailedAtMs: 2000 });
    let laneActive = true;
    const snapshots: Array<ReturnType<typeof store.readFailure>[]> = [];
    const markerBytes: unknown[] = [];
    const db = new DatabaseSync(join(dataDir, 'rfc64-sync', 'inventory-v1.sqlite3'));
    const canonical = () => db.prepare('SELECT repair_digest, repair_json FROM rfc64_finalized_private_placement_repairs_v1 ORDER BY repair_digest').all();
    const attempt = vi.fn(async (row: Rfc64FinalizedPrivatePlacementRepairV1) => {
      snapshots.push(store.list().map(item => store.readFailure(item)));
      markerBytes.push(canonical());
      await store.delete(row);
    });
    const owner = new Rfc64SwmCatalogProjectionOwnerV1({
      resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
      listDurableInventoryScopes: () => [], listLocalAuthorAddresses: () => [], acceptsPublicRootLane: () => true,
      readFinalizedPlacementAuthority: () => pinnedPrivatePlacementAuthorityV1(repair, laneActive), readRepairRevision: () => null,
      listFinalizedPrivateRepairs: () => store.list(), readPrivateFailure: row => store.readFailure(row),
      writePrivateFailures: entries => store.writeFailures(entries),
      repairFinalizedPrivatePlacement: attempt, reconcile: async () => null, warn: vi.fn(),
    });
    owners.push(owner);
    const ctx = createOperationContext('system');
    try {
      owner.start(ctx); await owner.whenIdle();
      expect(attempt).not.toHaveBeenCalled(); // Initial active observation preserves parked evidence.
      const originalBytes = canonical();
      db.exec(`CREATE TRIGGER reject_reactivation_reset BEFORE UPDATE ON rfc64_private_placement_failures_v1
        WHEN OLD.repair_digest = (SELECT repair_digest FROM rfc64_finalized_private_placement_repairs_v1
          ORDER BY repair_digest LIMIT 1 OFFSET 1)
        BEGIN SELECT RAISE(ABORT, 'reactivation reset rejected'); END;`);
      laneActive = false;
      if (transition === 'availability') owner.observeLaneAvailability(repair.contextGraphId);
      else expect(owner.requestFinalizedPrivate({ repair, ctx }).accepted).toBe(false);
      laneActive = true;
      owner.start(ctx); await owner.whenIdle();
      expect(attempt).not.toHaveBeenCalled(); // Persistence still fails: no new generation is admitted.
      expect(store.readFailure(repair)).toEqual(failure);
      expect(store.readFailure(other)).toEqual({ ...failure, firstFailedAtMs: 2000 });
      expect(canonical()).toEqual(originalBytes);
      db.exec('DROP TRIGGER reject_reactivation_reset');
      owner.start(ctx); await owner.whenIdle(); // The same active lane must still retry the pending reset.
      expect(attempt).toHaveBeenCalledTimes(2);
      expect(markerBytes[0]).toEqual(originalBytes);
      expect(snapshots[0]).toHaveLength(2);
      expect(snapshots[0]).toEqual(expect.arrayContaining([1000, 2000].map(firstFailedAtMs => ({
        ...failure, firstFailedAtMs, consecutiveFailures: 0, sameKindFailures: 0, parked: false,
      }))));
      expect(store.list()).toEqual([]);
    } finally { db.close(); }
  },
);


it.each([
  ['availability', false], ['availability', true],
  ['refused request', false], ['refused request', true],
] as const)('resolves unread SQLite failure history before a %s reset (first reset read fails: %s)', async (transition, failFirstReset) => {
  vi.useFakeTimers(); vi.setSystemTime(20000);
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-unread-reset-')); roots.push(dataDir);
  let store = await openStore(dataDir); await store.put(repair); store.writeFailure(repair, failure);
  let laneActive = true, readUnavailable = true;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const attempt = vi.fn(async (row: Rfc64FinalizedPrivatePlacementRepairV1) => { await store.delete(row); });
  attempt.mockImplementationOnce(async () => { await held; throw new Error('aborted old placement'); });
  const makeOwner = () => {
    const owner = new Rfc64SwmCatalogProjectionOwnerV1({
      resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
      listDurableInventoryScopes: () => [], listLocalAuthorAddresses: () => [], acceptsPublicRootLane: () => true,
      readFinalizedPlacementAuthority: () => pinnedPrivatePlacementAuthorityV1(repair, laneActive), readRepairRevision: () => null,
      listFinalizedPrivateRepairs: () => store.list(),
      readPrivateFailure: row => { if (readUnavailable) throw new Error('diagnostic read unavailable'); return store.readFailure(row); },
      writePrivateFailures: entries => store.writeFailures(entries),
      repairFinalizedPrivatePlacement: attempt, reconcile: async () => null, warn: vi.fn(),
    });
    owners.push(owner); return owner;
  };
  const ctx = createOperationContext('system');
  let owner = makeOwner(); owner.start(ctx); await vi.advanceTimersByTimeAsync(0);
  const observeInactive = () => {
    if (transition === 'availability') owner.observeLaneAvailability(repair.contextGraphId);
    else expect(owner.requestFinalizedPrivate({ repair, ctx }).accepted).toBe(false);
  };
  try {
    expect(attempt).toHaveBeenCalledTimes(1); // Unread diagnostics must not park owed work.
    laneActive = false;
    if (failFirstReset) {
      observeInactive();
      expect(store.readFailure(repair)).toEqual(failure);
    }
    readUnavailable = false;
    observeInactive();
  } finally {
    const closing = owner.close(); release(); await closing; // Stop before an attempt writes new evidence.
  }
  inventories.pop()!.close(); store = await openStore(dataDir);
  expect(store.list()).toEqual([repair]);
  expect(store.readFailure(repair)).toEqual({ ...failure, consecutiveFailures: 0,
    sameKindFailures: 0, nextAttemptAtMs: null, parked: false });
  laneActive = true; owner = makeOwner(); owner.start(ctx); await owner.whenIdle();
  expect(attempt).toHaveBeenCalledTimes(2); expect(store.list()).toEqual([]);
});


it('keeps unread SQLite history intact while runtime backoff continues, until operator reset can read it', async () => {
  vi.useFakeTimers(); vi.setSystemTime(20000);
  const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-private-unread-failure-')); roots.push(dataDir);
  const store = await openStore(dataDir); await store.put(repair); store.writeFailure(repair, failure);
  let readUnavailable = true;
  const attempt = vi.fn(async (): Promise<void> => { throw new Error('current transport failure'); });
  const owner = new Rfc64SwmCatalogProjectionOwnerV1({
    resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
    listDurableInventoryScopes: () => [], listLocalAuthorAddresses: () => [], acceptsPublicRootLane: () => true,
    readFinalizedPlacementAuthority: () => pinnedPrivatePlacementAuthorityV1(repair), readRepairRevision: () => null,
    listFinalizedPrivateRepairs: () => store.list(),
    readPrivateFailure: row => { if (readUnavailable) throw new Error('diagnostic read unavailable'); return store.readFailure(row); },
    writePrivateFailures: entries => store.writeFailures(entries),
    repairFinalizedPrivatePlacement: attempt, reconcile: async () => null, warn: vi.fn(),
  });
  owners.push(owner); const ctx = createOperationContext('system'); owner.start(ctx); await owner.whenIdle();
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(store.readFailure(repair)).toEqual(failure); // Best-effort diagnostics cannot overwrite unread history.
  const before = owner.status()?.finalizedPrivatePlacement;
  expect(() => owner.retryFailedPrivate(ctx)).toThrow('diagnostic read unavailable');
  expect(owner.status()?.finalizedPrivatePlacement).toEqual(before);
  owner.start(ctx); await owner.whenIdle(); expect(attempt).toHaveBeenCalledTimes(1); // Runtime cooldown still applies.
  readUnavailable = false; expect(owner.retryFailedPrivate(ctx)).toBe(1);
  await owner.close(); inventories.pop()!.close();
  const reopened = await openStore(dataDir);
  expect(reopened.readFailure(repair)).toEqual({ ...failure, consecutiveFailures: 0,
    sameKindFailures: 0, nextAttemptAtMs: null, parked: false });
});
