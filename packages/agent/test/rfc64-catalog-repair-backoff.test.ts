import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationContext,
  type ContextGraphIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { activeDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';

const CG = 'repair-backoff' as ContextGraphIdV1;
const AUTHOR = `0x${'11'.repeat(20)}` as EvmAddressV1;
const owners: Rfc64SwmCatalogProjectionOwnerV1[] = [];
const ctx = createOperationContext('system');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  vi.useRealTimers();
});

function fixture(retryIntervalMs = 5_000) {
  let revision = 'scope-1:head-1';
  let available = true;
  let privateRepairs: readonly Rfc64FinalizedPrivatePlacementRepairV1[] = [];
  const reconcile = vi.fn(async (): Promise<null> => { throw new Error('unchanged repair failure'); });
  const repairPrivate = vi.fn(async (_repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): Promise<void> => {
    throw new Error('unchanged private repair failure');
  });
  const readRevision = vi.fn(() => available ? revision : null);
  const listPrivateRepairs = vi.fn(() => privateRepairs);
  const warn = vi.fn();
  const dependencies = {
    resolvePartition: () => ({ retryIntervalMs, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
    listLocalAuthorAddresses: () => [AUTHOR],
    acceptsPublicRootLane: () => available,
    acceptsFinalizedPrivateLane: () => available,
    readRepairRevision: readRevision,
    listFinalizedPrivateRepairs: listPrivateRepairs,
    repairFinalizedPrivatePlacement: repairPrivate,
    reconcile,
    warn,
  };
  const owner = new Rfc64SwmCatalogProjectionOwnerV1(dependencies);
  owners.push(owner);
  return {
    owner, reconcile, repairPrivate, readRevision, listPrivateRepairs, warn,
    request: () => owner.request({ contextGraphId: CG, authorAddress: AUTHOR, ctx }),
    setRevision: (value: string) => { revision = value; },
    setAvailable: (value: boolean) => { available = value; },
    setPrivateRepairs: (value: readonly Rfc64FinalizedPrivatePlacementRepairV1[]) => { privateRepairs = value; },
    advance: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await owner.whenIdle(); },
  };
}

function privateRepair(): Rfc64FinalizedPrivatePlacementRepairV1 {
  return {
    version: 1, contextGraphId: CG, authorAddress: AUTHOR,
    inventoryScope: {
      networkId: 'otp:20430', contextGraphId: CG, governanceChainId: null,
      governanceContractAddress: null, ownershipTransitionDigest: null,
      authorAddress: AUTHOR, subGraphName: null, era: '1',
    },
    assertionCoordinate: 'repair', assertionVersion: '1',
    kaUal: `did:dkg:otp:20430/${AUTHOR}/1`, sealDigest: `0x${'22'.repeat(32)}`,
  } as Rfc64FinalizedPrivatePlacementRepairV1;
}

describe('RFC-64 unchanged repair backoff', () => {
  it('backs unchanged failures off exponentially with a finite cap', async () => {
    const f = fixture();
    const attempts: number[] = [];
    f.reconcile.mockImplementation(async () => { attempts.push(Date.now()); throw new Error('same failure'); });
    f.request();
    await f.owner.whenIdle();
    await f.advance(155_000);
    expect(attempts).toEqual([0, 5_000, 15_000, 35_000, 75_000, 135_000]);
    await f.advance(40_000);
    expect(attempts.at(-1)).toBe(195_000);
  });

  it('does not bypass cooldown through duplicate request or active start notifications', async () => {
    const f = fixture();
    f.request();
    await f.owner.whenIdle();
    for (let i = 0; i < 20; i++) { f.request(); f.owner.start(ctx); }
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.owner.status()?.repairs).toHaveLength(1);
    await f.advance(5_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('admits a genuinely changed head promptly and restarts its retry history', async () => {
    const f = fixture();
    f.request();
    await f.owner.whenIdle();
    await f.advance(5_000);
    f.setRevision('scope-1:head-2');
    f.request();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(3);
    await f.advance(5_000);
    expect(f.reconcile).toHaveBeenCalledTimes(4);
  });

  it('preserves a changed revision received while the old failed attempt drains', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.reconcile.mockImplementationOnce(async () => { await gate; throw new Error('old head failed'); });
    f.request();
    f.setRevision('scope-1:head-2');
    for (let i = 0; i < 10; i++) f.request();
    release();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    f.request();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('wakes on observed lane recovery but not a repeated active notification', async () => {
    const f = fixture();
    f.request();
    await f.owner.whenIdle();
    await f.advance(5_000);
    f.setAvailable(false);
    expect(f.request()).toBe(false);
    f.setAvailable(true);
    f.owner.start(ctx);
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(3);
    f.owner.start(ctx);
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(3);
  });

  it('requeues a head changed during failure even without a mutation notification', async () => {
    const f = fixture(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.reconcile.mockImplementationOnce(async () => {
      await gate;
      throw new Error('old head failed');
    });
    f.request();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    f.setRevision('scope-1:head-2');
    release();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.owner.status()?.repairs[0]).toMatchObject({
      consecutiveFailures: 1, nextAttemptAtMs: 5_000,
    });
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('resets failure history after a successful no-inventory result', async () => {
    const f = fixture();
    f.request();
    await f.owner.whenIdle();
    await f.advance(5_000);
    f.reconcile.mockResolvedValueOnce(null);
    await f.advance(10_000);
    expect(f.owner.status()?.repairs[0].outcome).toBe('no-inventory');
    f.setRevision('scope-1:head-2');
    f.request();
    await f.owner.whenIdle();
    await f.advance(5_000);
    expect(f.reconcile).toHaveBeenCalledTimes(5);
  });

  it('keeps a positive request cooldown when the periodic interval is disabled', async () => {
    const f = fixture(0);
    f.request();
    await f.owner.whenIdle();
    f.request(); f.owner.start(ctx);
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    f.request();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    f.setRevision('scope-2:head-1'); f.request();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(3);
  });

  it('contains revision read failures without generating unchanged request storms', async () => {
    const f = fixture();
    f.readRevision.mockImplementation(() => { throw new Error('local cursor unavailable'); });
    expect(f.request()).toBe(true);
    await f.owner.whenIdle();
    for (let i = 0; i < 10; i++) expect(f.request()).toBe(true);
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    await f.advance(5_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it.each(['cooldown', 'in-flight'])('retains an unknown public mutation through %s with periodic retries disabled', async (phase) => {
    const f = fixture(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    if (phase === 'in-flight') {
      f.reconcile.mockImplementationOnce(async () => { await gate; throw new Error('head A failed'); });
    }
    f.request();
    if (phase === 'cooldown') await f.owner.whenIdle();
    f.setRevision('scope-1:head-2');
    f.readRevision.mockImplementation(() => { throw new Error('hint temporarily unavailable'); });
    for (let i = 0; i < 10; i++) expect(f.request()).toBe(true);
    release();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.owner.status()?.repairs[0]).toMatchObject({ consecutiveFailures: 1, nextAttemptAtMs: 5_000 });
    await f.advance(4_999);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    f.readRevision.mockImplementation(() => 'scope-1:head-2');
    await f.advance(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an unknown public mutation deadline on close', async () => {
    const f = fixture(0);
    f.request();
    await f.owner.whenIdle();
    f.readRevision.mockImplementation(() => { throw new Error('hint unavailable'); });
    f.request();
    await f.owner.whenIdle();
    expect(vi.getTimerCount()).toBe(1);
    await f.owner.close();
    expect(vi.getTimerCount()).toBe(0);
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
  });

  it('retains an unknown mutation received while the previous public attempt succeeds', async () => {
    const f = fixture(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.reconcile.mockImplementationOnce(async () => { await gate; return null; });
    f.request();
    f.setRevision('scope-1:head-2');
    f.readRevision.mockImplementation(() => { throw new Error('hint unavailable'); });
    f.request();
    release();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels cooldown on close and starts fresh after the same owner restarts', async () => {
    const f = fixture();
    f.request();
    await f.owner.whenIdle();
    await f.owner.close();
    expect(f.request()).toBe(false);
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    f.owner.start(ctx);
    expect(f.request()).toBe(true);
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['generic failure', 'unchanged private repair failure'],
    ['non-newer assertion', 'RFC-64 catalog upsert for KA 1 is not a newer assertion version on the same coordinate'],
  ])('backs off durable private %s and settles duplicate waiters when their row disappears', async (_label, message) => {
    const f = fixture();
    f.repairPrivate.mockRejectedValue(new Error(message));
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    const firstDuplicate = f.owner.requestFinalizedPrivate({ repair, ctx });
    await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledTimes(1);
    await f.advance(5_000);
    await firstDuplicate.whenAttempted;
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    let settled = false;
    const duplicate = f.owner.requestFinalizedPrivate({ repair, ctx });
    void duplicate.whenAttempted.then(() => { settled = true; });
    await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    f.setPrivateRepairs([]);
    await f.advance(5_000);
    await duplicate.whenAttempted;
    expect(settled).toBe(true);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
  });

  it('keeps private cooldown when unrelated same-author inventory and repairs change', async () => {
    const f = fixture();
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    await f.advance(1_000);
    const other = { ...repair, assertionCoordinate: 'other', kaUal: `${repair.kaUal}-other` };
    f.setPrivateRepairs([repair, other]);
    f.setRevision('scope-1:head-2');
    await f.owner.requestFinalizedPrivate({ repair: other, ctx }).whenAttempted;
    expect(f.repairPrivate.mock.calls.filter(([value]) => value === repair)).toHaveLength(1);
    await f.advance(4_000);
    expect(f.repairPrivate.mock.calls.filter(([value]) => value === repair)).toHaveLength(2);
    f.setRevision('scope-1:head-3');
    f.owner.start(ctx);
    await f.owner.whenIdle();
    await f.advance(5_000);
    expect(f.repairPrivate.mock.calls.filter(([value]) => value === repair)).toHaveLength(2);
    await f.advance(5_000);
    expect(f.repairPrivate.mock.calls.filter(([value]) => value === repair)).toHaveLength(3);
  });

  it('wakes an accepted private cooldown request once with periodic retries disabled', async () => {
    const f = fixture(0);
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    await f.advance(1_000);
    const duplicate = f.owner.requestFinalizedPrivate({ repair, ctx });
    expect(duplicate.accepted).toBe(true);
    let settled = false;
    void duplicate.whenAttempted.then(() => { settled = true; });
    await f.owner.whenIdle();
    await f.advance(3_999);
    expect(f.repairPrivate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.repairPrivate.mockImplementationOnce(async () => { await gate; throw new Error('still failed'); });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    release();
    await f.owner.whenIdle();
    await duplicate.whenAttempted;
    expect(settled).toBe(true);
    await f.advance(60_000);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps private failure history when the author head changes during an attempt', async () => {
    const f = fixture(0);
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.repairPrivate.mockImplementationOnce(async () => { await gate; throw new Error('failed'); });
    const request = f.owner.requestFinalizedPrivate({ repair, ctx });
    f.setRevision('scope-1:head-2');
    release();
    await request.whenAttempted;
    await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledTimes(1);
    await f.advance(60_000);
    expect(f.repairPrivate).toHaveBeenCalledTimes(1);
  });

  it('uses one wake for the earliest private waiter deadline and preserves later waiters', async () => {
    const f = fixture(0);
    const repair = privateRepair();
    const other = { ...repair, assertionCoordinate: 'other', kaUal: `${repair.kaUal}-other` };
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    await f.advance(1_000);
    f.setPrivateRepairs([repair, other]);
    await f.owner.requestFinalizedPrivate({ repair: other, ctx }).whenAttempted;
    const first = f.owner.requestFinalizedPrivate({ repair, ctx });
    const second = f.owner.requestFinalizedPrivate({ repair: other, ctx });
    let secondSettled = false;
    void second.whenAttempted.then(() => { secondSettled = true; });
    await f.owner.whenIdle();
    expect(vi.getTimerCount()).toBe(1);
    await f.advance(4_000);
    await first.whenAttempted;
    expect(secondSettled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await f.advance(1_000);
    await second.whenAttempted;
    expect(secondSettled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await f.advance(60_000);
    expect(f.repairPrivate).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])('bounds failed queue reads while preserving a private waiter (prior failure: %s)', async (priorFailure) => {
    const f = fixture(0);
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    if (priorFailure) await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    f.listPrivateRepairs.mockImplementation(() => { throw new Error('queue temporarily unavailable'); });
    const request = f.owner.requestFinalizedPrivate({ repair, ctx });
    let settled = false;
    void request.whenAttempted.then(() => { settled = true; });
    await f.owner.whenIdle();
    f.listPrivateRepairs.mockClear();
    await f.advance(5_000);
    expect(f.listPrivateRepairs).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await f.advance(4_999);
    expect(f.listPrivateRepairs).toHaveBeenCalledTimes(1);
    f.listPrivateRepairs.mockImplementation(() => [repair]);
    await f.advance(1);
    await request.whenAttempted;
    expect(settled).toBe(true);
    expect(f.repairPrivate).toHaveBeenCalledTimes(priorFailure ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an obsolete private deadline when a real lane edge recovers early', async () => {
    const f = fixture(0);
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    const duplicate = f.owner.requestFinalizedPrivate({ repair, ctx });
    await f.owner.whenIdle();
    expect(vi.getTimerCount()).toBe(1);
    f.setAvailable(false);
    f.owner.observeLaneAvailability(CG);
    f.setAvailable(true);
    f.owner.start(ctx);
    await f.owner.whenIdle();
    await duplicate.whenAttempted;
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await f.advance(60_000);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
  });

  it('does not transfer private cooldown across a changed durable confirmation scope', async () => {
    const f = fixture();
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    await f.advance(5_000);
    const oldWaiter = f.owner.requestFinalizedPrivate({ repair, ctx });
    await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    const replacement = {
      ...repair, inventoryScope: { ...repair.inventoryScope, era: '2' },
    } as Rfc64FinalizedPrivatePlacementRepairV1;
    f.setPrivateRepairs([replacement]);
    await f.owner.requestFinalizedPrivate({ repair: replacement, ctx }).whenAttempted;
    await oldWaiter.whenAttempted;
    expect(f.repairPrivate).toHaveBeenCalledTimes(3);
    expect(f.repairPrivate).toHaveBeenLastCalledWith(replacement);
    const duplicate = f.owner.requestFinalizedPrivate({ repair: replacement, ctx });
    await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledTimes(3);
    await f.owner.close();
    await duplicate.whenAttempted;
  });

  it('settles a duplicate private waiter only after its next eligible attempt drains', async () => {
    const f = fixture();
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    let settled = false;
    const duplicate = f.owner.requestFinalizedPrivate({ repair, ctx });
    void duplicate.whenAttempted.then(() => { settled = true; });
    await f.owner.whenIdle();
    await f.advance(4_999);
    expect(f.repairPrivate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.repairPrivate.mockImplementationOnce(async () => {
      await gate;
      throw new Error('next private attempt failed');
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    release();
    await f.owner.whenIdle();
    await duplicate.whenAttempted;
    expect(settled).toBe(true);
    await f.advance(9_999);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    await f.advance(1);
    expect(f.repairPrivate).toHaveBeenCalledTimes(3);
  });

  it('wakes a private repair on observed lane recovery and settles cooldown waiters on close', async () => {
    const f = fixture(0);
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    f.setAvailable(false);
    expect(f.owner.requestFinalizedPrivate({ repair, ctx }).accepted).toBe(false);
    f.setAvailable(true);
    f.owner.start(ctx);
    await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    const duplicate = f.owner.requestFinalizedPrivate({ repair, ctx });
    let settled = false;
    void duplicate.whenAttempted.then(() => { settled = true; });
    await f.owner.whenIdle();
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await f.owner.close();
    await duplicate.whenAttempted;
    expect(vi.getTimerCount()).toBe(0);
    await f.advance(60_000);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
  });

  it('reports closed diagnostics and retry eligibility without reflecting private error text', async () => {
    const f = fixture();
    f.reconcile.mockRejectedValue(new Error('private-repair-secret-token'));
    f.request();
    await f.owner.whenIdle();
    expect(f.owner.status()?.repairs[0]).toMatchObject({
      attempts: 1, consecutiveFailures: 1, nextAttemptAtMs: 5_000,
      lastError: 'RFC-64 catalog repair unknown (stage: unknown)',
      diagnostic: { kind: 'unknown', stage: 'unknown', source: 'unknown', stageElapsedMs: null },
    });
    const message = f.warn.mock.calls[0][1];
    expect(JSON.parse(message)).toMatchObject({
      event: 'catalog_repair_failed', attempt: 1, consecutiveFailures: 1, nextAttemptAtMs: 5_000,
    });
    expect(message).not.toContain('private-repair-secret-token');
    expect(message).not.toContain(CG);
    expect(message).not.toContain(AUTHOR);
  });

  it('keeps the complete asynchronous private repair in the background store lane', async () => {
    const f = fixture();
    const repair = privateRepair();
    f.setPrivateRepairs([repair]);
    const priorities: unknown[] = [];
    f.repairPrivate.mockImplementationOnce(async () => {
      priorities.push(activeDefaultStoreWorkPriority());
      await Promise.resolve();
      priorities.push(activeDefaultStoreWorkPriority());
      f.setPrivateRepairs([]);
    });
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    expect(priorities).toEqual(['background', 'background']);
    expect(activeDefaultStoreWorkPriority()).not.toBe('background');
    await f.advance(20_000);
    expect(f.repairPrivate).toHaveBeenCalledTimes(1);
  });
});
