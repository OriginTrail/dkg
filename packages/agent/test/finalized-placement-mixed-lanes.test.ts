import { describe, expect, it } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers';
import { computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { resolveFinalizedPlacementDecisionV1 } from '../src/internal/finalized-placement-decision.js';
import { authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';
import { CG, ctx, fixture, privateRepair, setupCatalogRepairBackoffFixture } from './support/catalog-repair-backoff-fixture.js';
setupCatalogRepairBackoffFixture();

describe('mixed finalized placement lanes', () => {
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
    f.readAuthority.mockImplementation(() => {
      if (lane === 'unavailable') return { status: 'unavailable', error: new Error('authority is unavailable') };
      if (lane === 'inactive') return { status: 'inactive' };
      return { status: 'active', lane: { kind: lane, acceptsFinalizedVmRepair: lane === 'private', scopeBase: legacy.inventoryScope } };
    });
    f.setPrivateRepairs([repair]);
    await f.owner.requestFinalizedPrivate({ repair, ctx }).whenAttempted;
    expect(f.repairPrivate).toHaveBeenCalledTimes(1);

    lane = 'public';
    f.setAvailable(false); // Public retirement has no finalized-private lane.
    f.readAuthority.mockClear();
    f.owner.observeLaneAvailability(CG);
    expect(f.readAuthority).toHaveBeenCalledOnce();
    expect(f.readAuthority).toHaveBeenLastCalledWith(CG);
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

  it.each([false, true])('keeps a stale V1 pending while a current V2 completes (V2 first=%s)', async v2First => {
    const f = fixture(0);
    const legacy = privateRepair();
    if (legacy.version !== 1) throw new Error('expected V1');
    const seal = await authorSealV1(102n);
    const current: Rfc64FinalizedPrivatePlacementRepairV1 = { ...legacy,
      version: 2, assertionCoordinate: 'current', inventoryScope: null, subGraphName: null,
      authorAddress: seal.authorAddress, kaUal: seal.kaUal, assertionVersion: seal.assertionVersion,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal };
    let era = '1';
    f.readAuthority.mockImplementation(() => ({
      status: 'active', lane: { kind: 'private', acceptsFinalizedVmRepair: true,
        scopeBase: { ...legacy.inventoryScope, era } },
    }));
    f.setPrivateRepairs(v2First ? [current, legacy] : [legacy, current]);
    f.owner.start(ctx); await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledTimes(2);
    era = '2';
    f.repairPrivate.mockClear();
    f.repairPrivate.mockImplementation(async row => {
      expect(row.version).toBe(2);
      f.setPrivateRepairs([legacy]);
    });
    f.owner.observeLaneAvailability(CG);
    f.owner.start(ctx); await f.owner.whenIdle();
    expect(f.repairPrivate).toHaveBeenCalledOnce();
    expect(f.repairPrivate).toHaveBeenCalledWith(current, expect.anything());
    expect(f.listPrivateRepairs()).toEqual([legacy]);
    expect(resolveFinalizedPlacementDecisionV1(legacy, () => f.readAuthority(CG))).toMatchObject({ status: 'unavailable' });
    expect(resolveFinalizedPlacementDecisionV1(current, () => f.readAuthority(CG))).toMatchObject({ status: 'ready', inventoryScope: { era: '2' } });
  });

  it('evaluates a thousand unchanged cooling repairs in linear work', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({ ...privateRepair(), assertionCoordinate: `cooling-${index}` }));
    const f = fixture(0, { readPrivateFailure: () => ({ kind: 'unknown', consecutiveFailures: 2,
      sameKindFailures: 2, firstFailedAtMs: 0, lastFailedAtMs: 0, nextAttemptAtMs: 10_000, parked: false }) });
    f.setPrivateRepairs(rows);
    f.owner.start(ctx); await f.owner.whenIdle();
    f.readAuthority.mockClear();
    f.owner.start(ctx); await f.owner.whenIdle();
    expect(f.repairPrivate).not.toHaveBeenCalled();
    expect(f.readAuthority.mock.calls.length).toBeGreaterThanOrEqual(rows.length);
    expect(f.readAuthority.mock.calls.length).toBeLessThanOrEqual(3 * rows.length);
  });

  it('lets foreground callbacks run before a cooling backlog finishes', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({ ...privateRepair(), assertionCoordinate: `yield-${index}` }));
    const f = fixture(0, { readPrivateFailure: () => ({ kind: 'unknown', consecutiveFailures: 2,
      sameKindFailures: 2, firstFailedAtMs: 0, lastFailedAtMs: 0, nextAttemptAtMs: 10_000, parked: false }) });
    f.setPrivateRepairs(rows);
    f.owner.start(ctx); await f.owner.whenIdle();
    const authority = f.readAuthority.getMockImplementation()!;
    let reads = 0;
    let foregroundReads = Infinity;
    let foreground!: Promise<void>;
    f.readAuthority.mockImplementation(graph => {
      if (++reads === 1) foreground = new Promise(resolve => nextTurn(() => {
        foregroundReads = reads; resolve();
      }));
      return authority(graph);
    });
    f.owner.start(ctx); await f.owner.whenIdle(); await foreground;
    expect(foregroundReads).toBeGreaterThan(0);
    expect(foregroundReads).toBeLessThan(rows.length);
    expect(f.repairPrivate).not.toHaveBeenCalled();
  });
  it('rechecks authority after yielding before admitting later repairs', async () => {
    const f = fixture(0);
    f.setPrivateRepairs(Array.from({ length: 100 }, (_, index) => ({ ...privateRepair(), assertionCoordinate: `authority-${index}` })));
    const authority = f.readAuthority.getMockImplementation()!;
    let scheduled = false;
    f.readAuthority.mockImplementation(graph => {
      if (!scheduled) { scheduled = true; nextTurn(() => f.setAvailable(false)); }
      return authority(graph);
    });
    f.owner.start(ctx);
    await f.owner.whenIdle();
    expect(f.repairPrivate.mock.calls.length).toBeGreaterThan(0);
    expect(f.repairPrivate.mock.calls.length).toBeLessThan(100);
  });

  it('stops admission when closed during a yielded pass', async () => {
    const f = fixture(0);
    f.setPrivateRepairs(Array.from({ length: 100 }, (_, index) => ({ ...privateRepair(), assertionCoordinate: `close-${index}` })));
    const authority = f.readAuthority.getMockImplementation()!;
    let closing: Promise<void> | undefined;
    let scheduled = false;
    let admittedAtClose = 0;
    f.readAuthority.mockImplementation(graph => {
      if (!scheduled) {
        scheduled = true;
        nextTurn(() => { admittedAtClose = f.repairPrivate.mock.calls.length; closing = f.owner.close(); });
      }
      return authority(graph);
    });
    f.owner.start(ctx);
    await f.owner.whenIdle();
    await closing;
    expect(admittedAtClose).toBeGreaterThan(0);
    expect(admittedAtClose).toBeLessThan(100);
    expect(f.repairPrivate).toHaveBeenCalledTimes(admittedAtClose);
  });

  it('yields during cold durable failure-history restoration', async () => {
    let reads = 0;
    let observed = Infinity;
    let foreground!: Promise<void>;
    const f = fixture(0, { readPrivateFailure: () => {
      if (++reads === 1) foreground = new Promise(resolve => nextTurn(() => { observed = reads; resolve(); }));
      return { kind: 'unknown', consecutiveFailures: 2, sameKindFailures: 2,
        firstFailedAtMs: 0, lastFailedAtMs: 0, nextAttemptAtMs: 10_000, parked: false };
    } });
    f.setPrivateRepairs(Array.from({ length: 100 }, (_, index) => ({ ...privateRepair(), assertionCoordinate: `cold-${index}` })));
    f.owner.start(ctx);
    await f.owner.whenIdle();
    await foreground;
    expect(observed).toBeGreaterThan(0);
    expect(observed).toBeLessThan(100);
    expect(reads).toBe(100);
    expect(f.repairPrivate).not.toHaveBeenCalled();
  });

  it('keeps a request arriving during an asynchronous listing until its own attempt', async () => {
    let finishFirst!: () => void;
    let reads = 0;
    const later = { ...privateRepair(), assertionCoordinate: 'arrived-during-list' };
    const f = fixture(0, { listFinalizedPrivateRepairsAsync: async () => {
      if (++reads === 1) { await new Promise<void>(resolve => { finishFirst = resolve; }); return []; }
      return [later];
    } });
    f.owner.start(ctx);
    let releasedWithoutAttempt = false;
    const request = f.owner.requestFinalizedPrivate({ repair: later, ctx, observer: {
      cooldownSkipped: () => {}, released: attempt => { if (!attempt) releasedWithoutAttempt = true; },
    } });
    finishFirst();
    await request.whenAttempted;
    await f.owner.whenIdle();
    expect(releasedWithoutAttempt).toBe(false);
    expect(f.repairPrivate).toHaveBeenCalledOnce();
  });

});
