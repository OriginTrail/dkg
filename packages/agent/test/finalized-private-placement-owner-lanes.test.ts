import { pinnedPrivatePlacementDecisionV1 } from './support/finalized-placement-decision-fixture.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOperationContext, type ContextGraphIdV1, type EvmAddressV1 } from '@origintrail-official/dkg-core';
import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { AuthorCatalogFullErrorV1 } from '../src/internal/author-catalog-capacity.js';
import { CatalogRepairConditionErrorV1 } from '../src/rfc64/catalog-repair-diagnostics-v1.js';
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
function repair(id: string, contextGraphId = graph): Rfc64FinalizedPrivatePlacementRepairV1 {
  return { version: 1, contextGraphId, authorAddress: author,
    inventoryScope: { networkId: 'testnet', contextGraphId, governanceChainId: null,
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
    if (refuseWrites && entries.some(entry => entry.repair.contextGraphId === graph)) throw new Error('reset storage unavailable');
    for (const entry of entries) records.set(entry.repair.assertionCoordinate, entry.state);
  });
  const owner = new Rfc64SwmCatalogProjectionOwnerV1({
    resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
    listDurableInventoryScopes: () => [], listLocalAuthorAddresses: () => [], acceptsPublicRootLane: () => true,
    resolveFinalizedPlacementDecision: row => pinnedPrivatePlacementDecisionV1(row, row.contextGraphId === graph ? active : true, refuseAuthority && row.contextGraphId === graph ? new CatalogRepairConditionErrorV1('policy_conflict', 'authority unavailable') : undefined),
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

it('records an inactive lane as a measured failure and later resets it before admission', async () => {
  const row = repair('inactive'); const healthy = repair('healthy', 'healthy' as ContextGraphIdV1);
  const f = fixture([row, healthy]);
  const observer = { cooldownSkipped: vi.fn(), released: vi.fn() };
  const request = f.owner.requestFinalizedPrivate({ repair: row, ctx, observer });
  f.setActive(false);
  await f.pass(); await request.whenAttempted;
  expect(f.attempt.mock.calls.map(([item]) => item.assertionCoordinate)).toEqual(['healthy']);
  expect(f.records.get('inactive')).toMatchObject({ kind: 'lane_inactive', consecutiveFailures: 1,
    firstFailedAtMs: 20000, lastFailedAtMs: 20000, nextAttemptAtMs: 25000 });
  expect(observer.released).toHaveBeenCalledTimes(1);
  expect(observer.released.mock.calls[0][0]?.record?.failed).toBe(true);
  expect(f.owner.status()?.finalizedPrivatePlacement.waiters).toBe(0);
  f.setActive(true); await f.pass();
  expect(f.attempt.mock.calls.map(([item]) => item.assertionCoordinate)).toEqual(['healthy', 'inactive']);
  expect(f.records.get('inactive')).toMatchObject({ consecutiveFailures: 0, firstFailedAtMs: 20000,
    lastFailedAtMs: 20000, nextAttemptAtMs: null });
});

it('records the original authority failure without a pending reset and lets healthy graphs finish', async () => {
  const row = repair('unresolved'); const healthy = repair('healthy', 'healthy' as ContextGraphIdV1);
  const f = fixture([row, healthy]);
  const observer = { cooldownSkipped: vi.fn(), released: vi.fn() };
  const request = f.owner.requestFinalizedPrivate({ repair: row, ctx, observer });
  f.failAuthority(true);
  await f.pass(); await request.whenAttempted;
  expect(f.attempt.mock.calls.map(([item]) => item.assertionCoordinate)).toEqual(['healthy']);
  expect(f.records.get('unresolved')).toMatchObject({ kind: 'policy_conflict', consecutiveFailures: 1,
    firstFailedAtMs: 20000, lastFailedAtMs: 20000, nextAttemptAtMs: 25000 });
  expect(observer.released).toHaveBeenCalledTimes(1);
  expect(observer.released.mock.calls[0][0]?.record?.failed).toBe(true);
  expect(f.owner.status()?.finalizedPrivatePlacement.waiters).toBe(0);
  f.failAuthority(false); await f.pass();
  expect(f.attempt).toHaveBeenCalledTimes(1); // Authority recovery alone does not consume cooldown.
  await vi.advanceTimersByTimeAsync(5000); await f.pass();
  expect(f.attempt.mock.calls.map(([item]) => item.assertionCoordinate)).toEqual(['healthy', 'unresolved']);
});

it('observes an unannounced inactive edge after awaited failure before recording the current generation', async () => {
  const row = repair('changed-during-attempt'); const f = fixture([row]); const held = deferred();
  const previous = { ...parked, kind: 'unknown' as const, parked: false, nextAttemptAtMs: 20000 };
  f.records.set(row.assertionCoordinate, previous);
  f.attempt.mockImplementationOnce(async () => { await held.promise; throw new Error('obsolete attempt'); });
  const request = f.owner.requestFinalizedPrivate({ repair: row, ctx });
  f.owner.start(ctx); await vi.advanceTimersByTimeAsync(0);
  try {
    expect(f.attempt).toHaveBeenCalledTimes(1);
    f.setActive(false); // No explicit availability notification: the completion must re-observe.
    held.resolve(); await f.owner.whenIdle(); await request.whenAttempted;
    expect(f.write.mock.calls.map(([entries]) => entries[0].state)).toEqual([
      { ...previous, consecutiveFailures: 0, sameKindFailures: 0, nextAttemptAtMs: null },
      { ...previous, kind: 'lane_inactive', consecutiveFailures: 1, sameKindFailures: 1,
        lastFailedAtMs: 20000, nextAttemptAtMs: 25000 },
    ]);
    expect(f.attempt).toHaveBeenCalledTimes(1);
    expect(f.owner.status()?.finalizedPrivatePlacement.waiters).toBe(0);
    f.setActive(true); await f.pass();
    expect(f.attempt).toHaveBeenCalledTimes(2);
  } finally { held.resolve(); }
});

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

it.each(['unknown', 'catalog_full'] as const)('fences a first in-flight %s failure on a lane reset without manufacturing persisted evidence', async kind => {
  const row = repair('first-attempt'); const f = fixture([row]);
  const held = deferred();
  f.attempt.mockImplementationOnce(async () => {
    await held.promise;
    if (kind === 'catalog_full') throw new AuthorCatalogFullErrorV1(Array.from({ length: 1024 }, (_, i) => ({ seal: { kaUal: `held-${i}` } })), 1);
    throw new Error('obsolete first failure');
  });
  f.owner.start(ctx); await vi.advanceTimersByTimeAsync(0);
  try {
    expect(f.attempt).toHaveBeenCalledTimes(1);
    expect(f.records.size).toBe(0);
    f.setActive(false); f.owner.observeLaneAvailability(graph);
    f.setActive(true); held.resolve(); await f.owner.whenIdle();
    expect(f.attempt).toHaveBeenCalledTimes(2);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
    expect(f.owner.status()?.authorCatalogCapacity.parkedPlacements).toBe(0);
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


it.each(['persistence', 'authority'])('contains a pending %s reset failure before admission to its graph and settles every sibling waiter', async failure => {
  const a = repair('a'); const sibling = repair('sibling'); const healthy = repair('healthy', 'healthy' as ContextGraphIdV1);
  const f = fixture([a, sibling]);
  f.records.set('a', parked); f.records.set('sibling', parked);
  await f.pass();
  f.failWrites(true); f.setActive(false); f.owner.observeLaneAvailability(graph);
  f.setRows([a, sibling, healthy]); f.setActive(true);
  const requests = [a, sibling].map(row => f.owner.requestFinalizedPrivate({ repair: row, ctx }));
  if (failure === 'authority') { f.failWrites(false); f.failAuthority(true); }
  await f.pass();
  expect(f.attempt.mock.calls.map(([row]) => row.assertionCoordinate)).toEqual(['healthy']);
  expect(f.records.get('a')).toEqual(parked); expect(f.records.get('sibling')).toEqual(parked);
  expect(f.owner.status()?.finalizedPrivatePlacement.waiters).toBe(0);
  await Promise.all(requests.map(request => request.whenAttempted));
  await vi.advanceTimersByTimeAsync(1); await f.owner.whenIdle();
  expect(vi.getTimerCount()).toBe(0);
  f.failWrites(false); f.failAuthority(false); await f.pass();
  expect(f.attempt.mock.calls.map(([row]) => row.assertionCoordinate)).toEqual(['healthy', 'a', 'sibling']);
});

it.each(['persistence', 'authority'])('contains a pending %s reset failure after an in-flight failure while healthy later work completes', async failure => {
  const before = repair('before'); const active = repair('active'); const after = repair('after');
  const healthy = repair('healthy', 'healthy' as ContextGraphIdV1);
  const f = fixture([before, active, after, healthy]);
  const previous: PrivatePlacementFailureStateV1 = { ...parked, kind: 'unknown', parked: false,
    consecutiveFailures: 1, sameKindFailures: 1, nextAttemptAtMs: 20000 };
  f.records.set('before', { ...previous, nextAttemptAtMs: 40000 });
  f.records.set('active', previous); f.records.set('after', parked);
  const originals = new Map(f.records);
  const held = deferred();
  f.attempt.mockImplementationOnce(async () => {
    await held.promise;
    throw new AuthorCatalogFullErrorV1(Array.from({ length: 1024 }, (_, i) => ({ seal: { kaUal: `held-${i}` } })), 1);
  });
  const observer = { cooldownSkipped: vi.fn(), released: vi.fn() };
  const requests = [before, active, after].map(row => f.owner.requestFinalizedPrivate({ repair: row, ctx,
    observer: row === active ? observer : undefined }));
  f.owner.start(ctx); await vi.advanceTimersByTimeAsync(0);
  try {
    expect(f.attempt.mock.calls.map(([row]) => row.assertionCoordinate)).toEqual(['active']);
    f.failWrites(true); f.setActive(false); f.owner.observeLaneAvailability(graph);
    f.setActive(true);
    if (failure === 'authority') { f.failWrites(false); f.failAuthority(true); }
    held.resolve(); await f.owner.whenIdle();
    expect(f.attempt.mock.calls.map(([row]) => row.assertionCoordinate)).toEqual(['active', 'healthy']);
    expect(f.records).toEqual(originals);
    expect(observer.released).toHaveBeenCalledTimes(1);
    expect(observer.released.mock.calls[0][0]?.record?.failed).toBe(true);
    expect(f.owner.status()?.authorCatalogCapacity.parkedPlacements).toBe(0);
    expect(f.owner.status()?.finalizedPrivatePlacement.waiters).toBe(0);
    await Promise.all(requests.map(request => request.whenAttempted));
    await vi.advanceTimersByTimeAsync(1); await f.owner.whenIdle();
    expect(vi.getTimerCount()).toBe(0);
    f.failWrites(false); f.failAuthority(false); await f.pass();
    expect(f.attempt.mock.calls.map(([row]) => row.assertionCoordinate)).toEqual(['active', 'healthy', 'before', 'active', 'after']);
  } finally { held.resolve(); }
});

it.each([false, true])('resets three sibling revisions once and retries an uncommitted edge (write failure=%s)', async fail => {
  const rows = ['a', 'b', 'c'].map(id => repair(id));
  const f = fixture(rows);
  rows.forEach(row => f.records.set(row.assertionCoordinate, parked));
  await f.pass();
  expect(f.attempt).not.toHaveBeenCalled();
  f.write.mockClear();
  f.setActive(false); f.failWrites(fail);
  f.owner.observeLaneAvailability(graph);
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.write.mock.calls[0][0]).toHaveLength(3);
  if (fail) {
    rows.forEach(row => expect(f.records.get(row.assertionCoordinate)?.parked).toBe(true));
    f.failWrites(false); f.owner.observeLaneAvailability(graph);
    expect(f.write).toHaveBeenCalledTimes(2);
  }
  const writes = f.write.mock.calls.length;
  f.owner.observeLaneAvailability(graph);
  expect(f.write).toHaveBeenCalledTimes(writes);
  rows.forEach(row => expect(f.records.get(row.assertionCoordinate)?.consecutiveFailures).toBe(0));
});
