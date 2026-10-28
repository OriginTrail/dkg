import { pinnedPrivatePlacementDecisionV1 } from './support/finalized-placement-decision-fixture.js';
import { SwmCatalogAuthorityNotReady } from '../src/internal/swm-inventory-write.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationContext,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { CatalogRepairRetryV1, type CatalogRepairRevisionHintV1 } from '../src/rfc64/catalog-repair-retry-v1.js';
import { CatalogRepairIntegrityErrorV1 } from '../src/rfc64/catalog-repair-diagnostics-v1.js';
import { StoreSchedulerBusyError, StoreOperationTimeoutError, activeDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { resolveFinalizedPlacementDecisionV1, type FinalizedPlacementDecisionV1 } from '../src/internal/finalized-placement-decision.js';
import { authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';

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

function fixture(retryIntervalMs = 5_000, overrides: Partial<ConstructorParameters<typeof Rfc64SwmCatalogProjectionOwnerV1>[0]> = {}) {
  let revision: CatalogRepairRevisionHintV1 = { scopeIdentity: 'scope-1', headRevision: 'head-1' };
  let available = true;
  const durableScopes = vi.fn((): {contextGraphId: ContextGraphIdV1; authorAddress: EvmAddressV1}[] => []);
  let privateRepairs: readonly Rfc64FinalizedPrivatePlacementRepairV1[] = [];
  const reconcile = vi.fn(async (): Promise<null> => { throw new Error('unchanged repair failure'); });
  const repairPrivate = vi.fn(async (_repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): Promise<void> => {
    throw new Error('unchanged private repair failure');
  });
  const readRevision = vi.fn(() => available ? revision : null);
  const listPrivateRepairs = vi.fn(() => privateRepairs);
  const resolvePlacement = vi.fn<(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => FinalizedPlacementDecisionV1>(
    (repair) => pinnedPrivatePlacementDecisionV1(repair, available),
  );
  const warn = vi.fn();
  const dependencies = {
    resolvePartition: () => ({ retryIntervalMs, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
    listDurableInventoryScopes: durableScopes,
    listLocalAuthorAddresses: () => [AUTHOR],
    acceptsPublicRootLane: () => available,
    resolveFinalizedPlacementDecision: resolvePlacement,
    readRepairRevision: readRevision,
    readPrivateFailure: () => null,
    writePrivateFailures: () => {},
    listFinalizedPrivateRepairs: listPrivateRepairs,
    repairFinalizedPrivatePlacement: repairPrivate,
    reconcile,
    warn,
    ...overrides,
  };
  const owner = new Rfc64SwmCatalogProjectionOwnerV1(dependencies);
  owners.push(owner);
  return {
    owner, reconcile, repairPrivate, readRevision, listPrivateRepairs, resolvePlacement, warn, durableScopes,
    request: () => owner.request({ contextGraphId: CG, authorAddress: AUTHOR, ctx }),
    setRevision: (value: string | CatalogRepairRevisionHintV1) => { revision = typeof value === 'string' ? { scopeIdentity: 'scope-1', headRevision: value } : value; },
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

const retainedFailures = [
  ['integrity', () => new CatalogRepairIntegrityErrorV1('invalid seal')],
  ['queue_full', () => new StoreSchedulerBusyError('queue_full', 'background', 'query')],
  ['queue_wait', () => new StoreSchedulerBusyError('queue_wait_timeout', 'background', 'query')],
  ['store_timeout_not_started', () => new StoreOperationTimeoutError({ backend: 'test', operation: 'query', outcome: 'not_started' })],
  ['store_timeout_indeterminate', () => new StoreOperationTimeoutError({ backend: 'test', operation: 'query', outcome: 'indeterminate' })],
] as const;

describe('RFC-64 unchanged repair backoff', () => {
  it('retains unavailable evidence and pinned V1 capacity directly from the canonical lane decision', () => {
    const repair = privateRepair();
    const failure = new Error('accepted policy temporarily unavailable');
    const readLane = vi.fn(() => ({ status: 'unavailable' as const, error: failure }));
    const decision = resolveFinalizedPlacementDecisionV1(repair, readLane);
    expect(readLane).toHaveBeenCalledOnce();
    expect(decision.status).toBe('unavailable');
    if (decision.status !== 'unavailable') throw new Error('expected unavailable placement');
    expect(decision.error).toBe(failure);
    expect(decision.capacityScope).toEqual({ ...repair.inventoryScope, bucketCount: '1' });
  });

  it.each([new Error('unexpected lane read failure'), 'unexpected non-Error lane read failure'])
    ('contains unexpected lane exceptions at the placement boundary: %s', failure => {
      const repair = privateRepair();
      const readLane = vi.fn(() => { throw failure; });
      const decision = resolveFinalizedPlacementDecisionV1(repair, readLane);
      expect(readLane).toHaveBeenCalledOnce();
      expect(decision.status).toBe('unavailable');
      if (decision.status !== 'unavailable') throw new Error('expected unavailable placement');
      if (failure instanceof Error) expect(decision.error).toBe(failure);
      else expect(decision.error.message).toBe(failure);
      expect(decision.capacityScope).toEqual({ ...repair.inventoryScope, bucketCount: '1' });
    });
  it('discovers unregistered authors without partition policies and retries unavailable authority', async () => {
    const f = fixture();
    const other = `0x${'22'.repeat(20)}` as EvmAddressV1;
    f.durableScopes.mockReturnValue([{ contextGraphId: CG, authorAddress: other }]);
    f.setAvailable(false);
    f.owner.start(ctx); await f.owner.whenIdle();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.owner.status()?.repairs).toHaveLength(1);
    f.setAvailable(true); f.reconcile.mockResolvedValue(null);
    await f.advance(5_000);
    expect(f.reconcile).toHaveBeenCalledWith(expect.objectContaining({ contextGraphId: CG, authorAddress: other }));
  });

  it('wakes a discovered head when accepted policy replaces a typed unavailable hint', async () => {
    const f = fixture();
    f.durableScopes.mockReturnValue([{ contextGraphId: CG, authorAddress: AUTHOR }]);
    const missing = new SwmCatalogAuthorityNotReady('policy-not-accepted');
    f.readRevision.mockImplementation(() => { throw missing; });
    f.reconcile.mockRejectedValue(missing);
    f.owner.start(ctx); await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.owner.status()?.repairs[0].nextAttemptAtMs).toBe(5_000);
    f.readRevision.mockReturnValue({ scopeIdentity: 'accepted', headRevision: 'same-head' });
    f.reconcile.mockResolvedValue(null);
    f.request(); await f.owner.whenIdle();
    expect(Date.now()).toBe(0);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.owner.status()?.repairs[0].outcome).toBe('no-inventory');
  });

  it('retries transient discovery failure even when there are no local author scopes', async () => {
    const f = fixture();
    f.durableScopes.mockImplementationOnce(() => { throw new Error('inventory unavailable'); });
    f.durableScopes.mockReturnValue([{ contextGraphId: CG, authorAddress: AUTHOR }]);
    f.reconcile.mockResolvedValue(null);
    f.owner.start(ctx); await f.owner.whenIdle();
    expect(f.reconcile).not.toHaveBeenCalled();
    await f.advance(5_000);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    await f.advance(10_000);
    expect(f.durableScopes).toHaveBeenCalledTimes(2);
  });

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

  it('does not impose a stale integrity cooldown after a lane transition', () => {
    const retry = new CatalogRepairRetryV1();
    retry.observe({ scopeIdentity: 'scope-1', headRevision: 'head-1' });
    const generation = retry.generation;
    retry.observe(null);
    retry.observe({ scopeIdentity: 'scope-1', headRevision: 'head-2' });
    expect(retry.fail(generation, 0, 5_000, 'integrity')).toBe(false);
    expect(retry.nextAttemptAtMs).toBeNull();
  });

  it.each(retainedFailures)('preserves %s cooldown and failure history under continuous inventory churn', async (_kind, failure) => {
    const f = fixture();
    f.reconcile.mockImplementation(async () => { throw failure(); });
    f.request();
    await f.owner.whenIdle();
    for (let i = 0; i < 20; i++) {
      f.setRevision(`scope-1:head-${i + 2}`);
      f.request();
      await f.owner.whenIdle();
    }
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    await f.advance(5_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    f.setRevision('scope-1:head-100'); f.request();
    await f.owner.whenIdle();
    expect(f.owner.status()?.repairs[0]).toMatchObject({ consecutiveFailures: 2, nextAttemptAtMs: 15_000 });
    f.setAvailable(false); f.request();
    f.setAvailable(true); f.owner.start(ctx);
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(3);
  });

  it.each(retainedFailures)('does not immediately replay a %s failure when its head changes while running', async (_kind, failure) => {
    const f = fixture(0);
    f.reconcile.mockImplementationOnce(async () => {
      f.setRevision('scope-1:head-2');
      throw failure();
    });
    f.request();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.owner.status()?.repairs[0]).toMatchObject({ consecutiveFailures: 1, nextAttemptAtMs: 5_000 });
    f.reconcile.mockResolvedValue(null);
    await f.advance(4_999);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    await f.advance(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a changed head observed only by start until the cooldown deadline', async () => {
    const f = fixture(0);
    f.reconcile.mockRejectedValueOnce(new CatalogRepairIntegrityErrorV1('invalid seal'));
    f.request();
    await f.owner.whenIdle();
    f.setRevision({ scopeIdentity: 'scope-1', headRevision: 'head-2' });
    f.reconcile.mockResolvedValue(null);
    f.owner.start(ctx);
    await f.owner.whenIdle();
    await f.advance(4_999);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    await f.advance(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cooldown', 'in-flight'])('retains a known changed head through %s with periodic retries disabled', async (phase) => {
    const f = fixture(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.reconcile.mockImplementationOnce(async () => {
      if (phase === 'in-flight') await gate;
      throw new CatalogRepairIntegrityErrorV1('invalid seal');
    });
    f.request();
    if (phase === 'cooldown') await f.owner.whenIdle();
    f.setRevision('scope-1:head-2');
    for (let i = 0; i < 5; i++) f.request();
    release();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.owner.status()?.repairs[0]).toMatchObject({ consecutiveFailures: 1, nextAttemptAtMs: 5_000 });
    f.reconcile.mockResolvedValue(null);
    await f.advance(4_999);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    await f.advance(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cooldown', 'in-flight'])('resets and fences an active authoring-scope change through %s', async (phase) => {
    const f = fixture(0);
    const revision = (scope: string): CatalogRepairRevisionHintV1 => ({ scopeIdentity: scope, headRevision: 'head-1' });
    f.setRevision(revision('era-1'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.reconcile.mockResolvedValue(null).mockImplementationOnce(async () => {
      if (phase === 'in-flight') await gate;
      throw new CatalogRepairIntegrityErrorV1('old era seal');
    });
    f.request();
    if (phase === 'cooldown') await f.owner.whenIdle();
    f.setRevision(revision('era-2'));
    f.request();
    release();
    await f.owner.whenIdle();
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.owner.status()?.repairs[0]).toMatchObject({ consecutiveFailures: 0, nextAttemptAtMs: null });
    await f.advance(60_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('retains cooldown for production head hints within the same authoring scope', () => {
    const retry = new CatalogRepairRetryV1();
    retry.observe({ scopeIdentity: 'scope-1', headRevision: 'head-1' });
    retry.fail(retry.generation, 0, 0, 'integrity');
    retry.observe({ scopeIdentity: 'scope-1', headRevision: 'head-2' });
    expect(retry.nextAttemptAtMs).toBe(5_000);
    expect(retry.consecutiveFailures).toBe(1);
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
    f.setRevision({ scopeIdentity: 'scope-2', headRevision: 'head-1' }); f.request();
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
    f.readRevision.mockImplementation(() => ({ scopeIdentity: 'scope-1', headRevision: 'head-2' }));
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
    const other = { ...repair, assertionCoordinate: 'other', kaUal: `did:dkg:otp:20430/${AUTHOR}/2` };
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
    const other = { ...repair, assertionCoordinate: 'other', kaUal: `did:dkg:otp:20430/${AUTHOR}/2` };
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

  it('observes the exact V2 private/public decision without starting work or erasing unavailable cooldown', async () => {
    const f = fixture(0);
    const legacy = privateRepair();
    if (legacy.version !== 1) throw new Error('expected pinned legacy fixture');
    const seal = await authorSealV1(101n);
    const repair: Rfc64FinalizedPrivatePlacementRepairV1 = {
      ...legacy, version: 2, inventoryScope: null, subGraphName: null,
      authorAddress: seal.authorAddress, kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal,
    };
    let lane: 'private' | 'public' | 'inactive' | 'unavailable' = 'private';
    f.resolvePlacement.mockImplementation((selected) => resolveFinalizedPlacementDecisionV1(selected, () => {
      if (lane === 'unavailable') return { status: 'unavailable', error: new Error('authority is unavailable') };
      if (lane === 'inactive') return { status: 'inactive' };
      return { status: 'active', lane: { kind: lane, acceptsFinalizedVmRepair: lane === 'private', scopeBase: legacy.inventoryScope } };
    }));
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    expect(f.repairPrivate).toHaveBeenCalledTimes(1);

    lane = 'public';
    f.setAvailable(false); // Public retirement has no finalized-private lane.
    f.resolvePlacement.mockClear();
    f.owner.observeLaneAvailability(CG);
    expect(f.resolvePlacement).toHaveBeenCalledOnce();
    expect(f.resolvePlacement).toHaveBeenLastCalledWith(repair);
    expect(f.repairPrivate).toHaveBeenCalledTimes(1);
    f.owner.start(ctx);
    await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);

    for (const observed of ['public', 'unavailable', 'public'] as const) {
      lane = observed;
      f.owner.observeLaneAvailability(CG);
      expect(f.repairPrivate).toHaveBeenCalledTimes(2);
      f.owner.start(ctx);
      await f.owner.whenIdle();
      expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    }
    lane = 'inactive';
    f.owner.observeLaneAvailability(CG);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    lane = 'private';
    f.owner.observeLaneAvailability(CG);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    f.owner.start(ctx);
    await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledTimes(3);
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
    // The second argument is the admitted attempt's placement recorder (GH#3081).
    expect(f.repairPrivate).toHaveBeenLastCalledWith(replacement, expect.anything());
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

it('reduces the repeated private-marker retry cost beyond the old one-minute ceiling', async () => {
  const f = fixture();
  f.setPrivateRepairs([privateRepair()]);
  f.owner.start(ctx);
  await f.advance(600_000);
  expect(f.repairPrivate.mock.calls.length).toBeLessThanOrEqual(8);
  expect(f.repairPrivate.mock.calls.length).toBeGreaterThan(1);
});


it('atomically persists all operator resets before changing any scheduling generation', async () => {
  const failure = { kind: 'signer_mismatch' as const, consecutiveFailures: 3, sameKindFailures: 3,
    firstFailedAtMs: 0, lastFailedAtMs: 0, nextAttemptAtMs: null, parked: true };
  let rejectBatch = true;
  const write = vi.fn((entries: readonly import('../src/rfc64/finalized-private-placement-repair-store-v1.js').Rfc64PrivatePlacementFailureWriteV1[]) => {
    expect(entries).toHaveLength(2);
    if (rejectBatch) throw new Error('atomic batch unavailable');
  });
  const f = fixture(0, { readPrivateFailure: () => failure, writePrivateFailures: write });
  const a = privateRepair(), b = { ...privateRepair(), assertionCoordinate: 'other' };
  f.setPrivateRepairs([a, b]); f.owner.start(ctx); await f.owner.whenIdle();
  const before = f.owner.status()?.finalizedPrivatePlacement;
  expect(f.repairPrivate).not.toHaveBeenCalled();
  expect(() => f.owner.retryFailedPrivate(ctx)).toThrow('atomic batch unavailable');
  await f.advance(0);
  expect(f.repairPrivate).not.toHaveBeenCalled();
  expect(f.owner.status()?.finalizedPrivatePlacement).toEqual(before);
  expect(write).toHaveBeenCalledTimes(1);
  rejectBatch = false;
  f.repairPrivate.mockResolvedValue(undefined);
  expect(f.owner.retryFailedPrivate(ctx)).toBe(2);
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1][0].map(entry => entry.state)).toEqual([a, b].map(() => ({ ...failure,
    consecutiveFailures: 0, sameKindFailures: 0, nextAttemptAtMs: null, parked: false })));
  await f.advance(0);
  expect(f.repairPrivate).toHaveBeenCalledTimes(2);
  expect(f.repairPrivate.mock.calls.map(call => call[0])).toEqual([a, b]);
  expect(f.listPrivateRepairs()).toEqual([a, b]);
});

it.each(['unknown', 'catalog_full'] as const)('operator retry fences an in-flight %s failure through the owner', async kind => {
  const { AuthorCatalogFullErrorV1 } = await import('../src/internal/author-catalog-capacity.js');
  let persisted: import('../src/rfc64/private-placement-failure-state-v1.js').PrivatePlacementFailureStateV1 | null = null;
  const f = fixture(0, { readPrivateFailure: () => persisted, writePrivateFailures: entries => { for (const entry of entries) persisted = entry.state; } });
  const repair = privateRepair(); f.setPrivateRepairs([repair]);
  await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
  let rejectOld!: () => void; const old = new Promise<void>(resolve => { rejectOld = resolve; });
  let releaseFollowup!: () => void; const followup = new Promise<void>(resolve => { releaseFollowup = resolve; });
  f.repairPrivate.mockImplementationOnce(async () => {
    await old;
    if (kind === 'catalog_full') throw new AuthorCatalogFullErrorV1(Array.from({ length: 1024 }, (_, i) => ({ seal: { kaUal: `held-${i}` } })), 1);
    throw new Error('private stale failure must not be retained');
  }).mockImplementationOnce(async () => { await followup; });
  const request = f.owner.requestFinalizedPrivate({ repair, ctx });
  try {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    expect(f.owner.retryFailedPrivate(ctx)).toBe(1);
    const reset = persisted;
    expect(reset).toMatchObject({ consecutiveFailures: 0, sameKindFailures: 0, nextAttemptAtMs: null, parked: false });
    rejectOld(); await vi.advanceTimersByTimeAsync(1);
    expect(f.repairPrivate).toHaveBeenCalledTimes(3);
    expect(persisted).toEqual(reset);
    expect(f.owner.status()?.authorCatalogCapacity.parkedPlacements).toBe(0);
  } finally {
    rejectOld(); releaseFollowup(); await request.whenAttempted; await f.owner.whenIdle();
  }
});

it('keeps a capacity-refused owed marker visible without introducing a generic cooldown', async () => {
  const { AuthorCatalogFullErrorV1 } = await import('../src/internal/author-catalog-capacity.js');
  let persisted: import('../src/rfc64/private-placement-failure-state-v1.js').PrivatePlacementFailureStateV1 | null = null;
  const f = fixture(0, { readPrivateFailure: () => persisted, writePrivateFailures: entries => { for (const entry of entries) persisted = entry.state; } });
  const repair = privateRepair(); f.setPrivateRepairs([repair]);
  f.repairPrivate.mockRejectedValue(new AuthorCatalogFullErrorV1(Array.from({ length: 1024 }, (_, i) => ({ seal: { kaUal: `held-${i}` } })), 1));
  await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
  expect(f.owner.status()?.finalizedPrivatePlacement.failures).toMatchObject({ failedMarkers: 1, oldestFailureAgeMs: 0, kinds: [{ kind: 'catalog_full', count: 1 }] });
  expect(persisted).toMatchObject({ kind: 'catalog_full', nextAttemptAtMs: null });
  f.setAvailable(false); f.owner.observeLaneAvailability(CG);
  expect(persisted).toMatchObject({ kind: 'catalog_full', consecutiveFailures: 0, sameKindFailures: 0,
    firstFailedAtMs: 0, lastFailedAtMs: 0, nextAttemptAtMs: null });
  expect(f.owner.status()?.authorCatalogCapacity.parkedPlacements).toBe(1);
  f.setAvailable(true); f.owner.start(ctx); await f.owner.whenIdle();
  expect(f.repairPrivate).toHaveBeenCalledTimes(1); // Lane reset does not take capacity's wakeup.
  await f.advance(60_000); f.owner.start(ctx); await f.owner.whenIdle();
  expect(f.repairPrivate).toHaveBeenCalledTimes(1);
  expect(f.owner.status()?.finalizedPrivatePlacement.failures).toMatchObject({ failedMarkers: 1, oldestFailureAgeMs: 60_000, kinds: [{ kind: 'catalog_full', count: 1 }] });
  await f.owner.close();
  const restarted = fixture(0, { readPrivateFailure: () => persisted, writePrivateFailures: entries => { for (const entry of entries) persisted = entry.state; } });
  restarted.setPrivateRepairs([repair]);
  restarted.repairPrivate.mockRejectedValue(new AuthorCatalogFullErrorV1(Array.from({ length: 1024 }, (_, i) => ({ seal: { kaUal: `held-${i}` } })), 1));
  restarted.owner.start(ctx); await restarted.owner.whenIdle();
  expect(restarted.owner.status()?.finalizedPrivatePlacement.failures).toMatchObject({ failedMarkers: 1, oldestFailureAgeMs: 60_000, kinds: [{ kind: 'catalog_full', count: 1 }] });
  expect(persisted).toMatchObject({ kind: 'catalog_full', firstFailedAtMs: 0, nextAttemptAtMs: null });
});


it.each(['unknown', 'catalog_full'] as const)('durable lane reset fences an in-flight %s failure without changing capacity policy', async kind => {
  const { AuthorCatalogFullErrorV1 } = await import('../src/internal/author-catalog-capacity.js');
  let persisted: import('../src/rfc64/private-placement-failure-state-v1.js').PrivatePlacementFailureStateV1 | null = null;
  const f = fixture(0, { readPrivateFailure: () => persisted, writePrivateFailures: entries => { for (const entry of entries) persisted = entry.state; } });
  const repair = privateRepair(); f.setPrivateRepairs([repair]);
  await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
  let rejectOld!: () => void; const old = new Promise<void>(resolve => { rejectOld = resolve; });
  let releaseFollowup!: () => void; const followup = new Promise<void>(resolve => { releaseFollowup = resolve; });
  f.repairPrivate.mockImplementationOnce(async () => {
    await old;
    if (kind === 'catalog_full') throw new AuthorCatalogFullErrorV1(Array.from({ length: 1024 }, (_, i) => ({ seal: { kaUal: `held-${i}` } })), 1);
    throw new Error('stale failure after lane reset');
  }).mockImplementationOnce(async () => { await followup; });
  const request = f.owner.requestFinalizedPrivate({ repair, ctx });
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    f.setAvailable(false); f.owner.observeLaneAvailability(CG);
    const reset = persisted;
    expect(reset).toMatchObject({ consecutiveFailures: 0, sameKindFailures: 0, parked: false, nextAttemptAtMs: null });
    f.setAvailable(true); f.owner.start(ctx);
    rejectOld(); await vi.advanceTimersByTimeAsync(1);
    expect(f.repairPrivate).toHaveBeenCalledTimes(3);
    expect(persisted).toEqual(reset);
    expect(f.owner.status()?.authorCatalogCapacity.parkedPlacements).toBe(0);
  } finally {
    rejectOld(); releaseFollowup(); await request.whenAttempted; await f.owner.whenIdle();
  }
});
