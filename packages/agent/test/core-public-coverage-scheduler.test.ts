import { describe, expect, it } from 'vitest';
import {
  CorePublicSyncCoverageScheduler,
  DEFAULT_CORE_PUBLIC_SYNC_BATCH_SIZE,
  resolveCorePublicSyncBatchSize,
} from '../src/sync/core-public-coverage-scheduler.js';

describe('Core public Context Graph coverage scheduler', () => {
  it('always admits explicit selections outside the automatic coverage cap', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1, () => 123);
    scheduler.register('public-a');
    scheduler.register('selected');
    scheduler.register('public-b');

    const plan = scheduler.plan(['selected', 'selected']);

    expect(plan.selectedContextGraphIds).toEqual(['selected']);
    expect(plan.coverageContextGraphIds).toHaveLength(1);
    expect(plan.contextGraphIds).toEqual(['selected', 'public-a']);
    expect(scheduler.getStatus(true)).toMatchObject({
      enabled: true,
      batchSize: 1,
      trackedContextGraphs: 3,
      lastPlanAt: 123,
      lastPlan: {
        selectedContextGraphs: 1,
        coverageContextGraphs: 1,
        totalContextGraphs: 2,
      },
    });
  });

  it('rotates bounded batches so every tracked public graph is eventually admitted', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(2);
    for (const id of ['public-a', 'public-b', 'public-c', 'public-d', 'public-e']) {
      scheduler.register(id);
    }

    expect(scheduler.plan([]).coverageContextGraphIds).toEqual(['public-a', 'public-b']);
    expect(scheduler.plan([]).coverageContextGraphIds).toEqual(['public-c', 'public-d']);
    expect(scheduler.plan([]).coverageContextGraphIds).toEqual(['public-e', 'public-a']);
  });

  it('honors priority ordering without starving lower-priority graphs', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1);
    scheduler.register('normal');
    scheduler.register('low');
    scheduler.register('high');
    const priorities = { high: 10, low: -10 };

    expect(scheduler.plan([], priorities).coverageContextGraphIds).toEqual(['high']);
    expect(scheduler.plan([], priorities).coverageContextGraphIds).toEqual(['normal']);
    expect(scheduler.plan([], priorities).coverageContextGraphIds).toEqual(['low']);
  });

  it('rotates independently per peer so stable peer order cannot pin batches', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(2);
    for (const id of ['public-a', 'public-b', 'public-c', 'public-d']) {
      scheduler.register(id);
    }

    expect(scheduler.plan([], undefined, 'peer-a').coverageContextGraphIds)
      .toEqual(['public-a', 'public-b']);
    expect(scheduler.plan([], undefined, 'peer-b').coverageContextGraphIds)
      .toEqual(['public-a', 'public-b']);
    expect(scheduler.plan([], undefined, 'peer-a').coverageContextGraphIds)
      .toEqual(['public-b', 'public-c']);
    expect(scheduler.plan([], undefined, 'peer-b').coverageContextGraphIds)
      .toEqual(['public-b', 'public-c']);
  });

  it('eventually puts every graph first when each batch fails fast on its first graph', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(4);
    const contextGraphIds = Array.from({ length: 8 }, (_, index) => `public-${index}`);
    for (const id of contextGraphIds) scheduler.register(id);

    const firstAttempted = new Set<string>();
    for (let round = 0; round < contextGraphIds.length; round += 1) {
      firstAttempted.add(scheduler.plan([], undefined, 'failing-peer').coverageContextGraphIds[0]!);
    }

    expect(firstAttempted).toEqual(new Set(contextGraphIds));
  });

  it('retains fairness across more peer lanes than a Core can normally connect', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1);
    scheduler.register('public-a');
    scheduler.register('public-b');
    const peers = Array.from({ length: 2_100 }, (_, index) => `peer-${index}`);

    for (const peer of peers) {
      expect(scheduler.plan([], undefined, peer).coverageContextGraphIds).toEqual(['public-a']);
    }
    for (const peer of peers) {
      expect(scheduler.plan([], undefined, peer).coverageContextGraphIds).toEqual(['public-b']);
    }
  });

  it('releases peer-lane cursor state when lifecycle pruning removes a peer', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1);
    scheduler.register('public-a');
    scheduler.plan([], undefined, 'departed-peer');

    expect(scheduler.getStatus(true).planningLanes).toBe(1);
    expect(scheduler.releasePlanningLane('departed-peer')).toBe(true);
    expect(scheduler.getStatus(true).planningLanes).toBe(0);
  });

  it('keeps explicit selections active when automatic coverage is disabled', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(0);
    scheduler.register('public-a');

    expect(scheduler.plan(['selected']).contextGraphIds).toEqual(['selected']);
    expect(scheduler.getStatus(true)).toMatchObject({
      enabled: false,
      batchSize: 0,
      trackedContextGraphs: 1,
      planningLanes: 0,
    });
  });

  it('resolves the env override and rejects unsafe batch sizes', () => {
    expect(resolveCorePublicSyncBatchSize(undefined, undefined))
      .toBe(DEFAULT_CORE_PUBLIC_SYNC_BATCH_SIZE);
    expect(resolveCorePublicSyncBatchSize(3, '5')).toBe(5);
    expect(() => resolveCorePublicSyncBatchSize(-1, undefined)).toThrow(/syncCorePublicBatchSize/);
    expect(() => resolveCorePublicSyncBatchSize(3, '1.5'))
      .toThrow(/DKG_SYNC_CORE_PUBLIC_BATCH_SIZE/);
  });
});
