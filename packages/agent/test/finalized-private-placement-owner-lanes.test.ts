import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOperationContext, type ContextGraphIdV1, type EvmAddressV1 } from '@origintrail-official/dkg-core';
import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { AuthorCatalogFullErrorV1 } from '../src/internal/author-catalog-capacity.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import type { PrivatePlacementFailureStateV1 } from '../src/rfc64/private-placement-failure-state-v1.js';

const graph = 'pending-lane-reset' as ContextGraphIdV1;
const author = `0x${'11'.repeat(20)}` as EvmAddressV1;
const ctx = createOperationContext('system');
const parked: PrivatePlacementFailureStateV1 = { kind: 'signer_mismatch', consecutiveFailures: 3,
  sameKindFailures: 3, firstFailedAtMs: 1000, lastFailedAtMs: 16000, nextAttemptAtMs: null, parked: true };
const owners: Rfc64SwmCatalogProjectionOwnerV1[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(20000); });
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); vi.useRealTimers(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function repair(id: string): Rfc64FinalizedPrivatePlacementRepairV1 {
  return { version: 1, contextGraphId: graph, authorAddress: author,
    inventoryScope: { networkId: 'testnet', contextGraphId: graph, governanceChainId: null,
      governanceContractAddress: null, ownershipTransitionDigest: null, authorAddress: author, subGraphName: null, era: '1' },
    assertionCoordinate: id, assertionVersion: '1', kaUal: `did:dkg:otp:20430/${author}/1`, sealDigest: `0x${'22'.repeat(32)}` };
}
function fixture(rows: readonly Rfc64FinalizedPrivatePlacementRepairV1[]) {
  let pending = rows;
  let active = true;
  let refuseWrites = false;
  let refuseAuthority = false;
  const records = new Map<string, PrivatePlacementFailureStateV1 | null>();
  const attempt = vi.fn(async (row: Rfc64FinalizedPrivatePlacementRepairV1) => {
    pending = pending.filter(item => item !== row);
  });
  const write = vi.fn((entries: readonly { repair: Rfc64FinalizedPrivatePlacementRepairV1; state: PrivatePlacementFailureStateV1 | null }[]) => {
    if (refuseWrites) throw new Error('reset storage unavailable');
    for (const entry of entries) records.set(entry.repair.assertionCoordinate, entry.state);
  });
  const owner = new Rfc64SwmCatalogProjectionOwnerV1({
    resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
    listDurableInventoryScopes: () => [], listLocalAuthorAddresses: () => [], acceptsPublicRootLane: () => true,
    acceptsFinalizedPrivateLane: () => { if (refuseAuthority) throw new Error('authority unavailable'); return active; },
    readRepairRevision: () => null, listFinalizedPrivateRepairs: () => pending,
    readPrivateFailure: row => records.get(row.assertionCoordinate) ?? null, writePrivateFailures: write,
    repairFinalizedPrivatePlacement: attempt, reconcile: async () => null, warn: vi.fn(),
  });
  owners.push(owner);
  return { owner, records, attempt, write,
    setActive: (value: boolean) => { active = value; },
    setRows: (value: readonly Rfc64FinalizedPrivatePlacementRepairV1[]) => { pending = value; },
    failWrites: (value: boolean) => { refuseWrites = value; },
    failAuthority: (value: boolean) => { refuseAuthority = value; },
    pass: async () => { owner.start(ctx); await owner.whenIdle(); },
  };
}

it('loads queued siblings before awaiting an attempt so a concurrent lane edge resets the parked sibling', async () => {
  const a = repair('a'); const b = repair('b'); const f = fixture([a, b]);
  f.records.set('b', parked);
  const held = deferred();
  f.attempt.mockImplementationOnce(async () => { await held.promise; f.setRows([b]); });
  f.owner.start(ctx); await vi.advanceTimersByTimeAsync(0);
  try {
    expect(f.attempt).toHaveBeenCalledTimes(1);
    f.setActive(false); f.owner.observeLaneAvailability(graph);
    expect(f.records.get('b')).toMatchObject({ parked: false, consecutiveFailures: 0, firstFailedAtMs: 1000, lastFailedAtMs: 16000 });
    f.setActive(true); held.resolve(); await f.owner.whenIdle();
    expect(f.attempt.mock.calls.map(([row]) => row.assertionCoordinate)).toEqual(['a', 'b']);
  } finally { held.resolve(); }
});

it.each([false, true])('keeps the pending graph reset when siblings change (replace all: %s)', async replaceAll => {
  const a = repair('a'); const b = repair('b'); const c = repair('c'); const f = fixture([a, b]);
  for (const row of [a, b, c]) f.records.set(row.assertionCoordinate, parked);
  await f.pass();
  f.failWrites(true); f.setActive(false); f.owner.observeLaneAvailability(graph);
  f.setRows(replaceAll ? [c] : [b, c]); f.setActive(true);
  await f.pass(); await f.pass();
  expect(f.attempt).not.toHaveBeenCalled();
  for (const row of [a, b, c]) expect(f.records.get(row.assertionCoordinate)).toEqual(parked);
  f.failWrites(false); await f.pass();
  expect(f.attempt.mock.calls.map(([row]) => row.assertionCoordinate)).toEqual(replaceAll ? ['c'] : ['b', 'c']);
  expect(f.records.get('a')).toEqual(parked);
  expect(f.records.get('c')).toMatchObject({ parked: false, consecutiveFailures: 0, firstFailedAtMs: 1000, lastFailedAtMs: 16000 });
});

it.each(['unknown', 'catalog_full'] as const)('does not record an in-flight %s completion over a pending reset when storage or authority is unavailable', async kind => {
  const row = repair('a'); const f = fixture([row]);
  const previous: PrivatePlacementFailureStateV1 = { ...parked, kind: 'unknown', parked: false,
    consecutiveFailures: 1, sameKindFailures: 1, nextAttemptAtMs: 20000 };
  f.records.set('a', previous);
  const held = deferred();
  f.attempt.mockImplementationOnce(async () => {
    await held.promise;
    if (kind === 'catalog_full') throw new AuthorCatalogFullErrorV1(Array.from({ length: 1024 }, (_, i) => ({ seal: { kaUal: `held-${i}` } })), 1);
    throw new Error('old attempt failed');
  });
  f.owner.start(ctx); await vi.advanceTimersByTimeAsync(0);
  try {
    expect(f.attempt).toHaveBeenCalledTimes(1);
    f.failWrites(true); f.setActive(false); f.owner.observeLaneAvailability(graph);
    f.setActive(true); f.failAuthority(true);
    held.resolve(); await f.owner.whenIdle();
    expect(f.records.get('a')).toEqual(previous);
    expect(f.owner.status()?.authorCatalogCapacity.parkedPlacements).toBe(0);
    f.failWrites(false); await f.pass();
    expect(f.attempt).toHaveBeenCalledTimes(1); // Uncertain authority cannot bypass the pending reset.
    f.failAuthority(false); await f.pass();
    expect(f.attempt).toHaveBeenCalledTimes(2);
    expect(f.records.get('a')).toEqual({ ...previous, consecutiveFailures: 0, sameKindFailures: 0, nextAttemptAtMs: null });
    expect(f.owner.status()?.authorCatalogCapacity.parkedPlacements).toBe(0);
  } finally { held.resolve(); }
});
