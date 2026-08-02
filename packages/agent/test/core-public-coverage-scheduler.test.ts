import { describe, expect, it } from 'vitest';
import {
  CorePublicSyncCoverageScheduler,
  DEFAULT_CORE_PUBLIC_SYNC_BATCH_SIZE,
  DEFAULT_CORE_PUBLIC_SYNC_MAX_PLANNING_LANES,
  resolveCorePublicSyncBatchSize,
} from '../src/sync/core-public-coverage-scheduler.js';

describe('Core public Context Graph coverage scheduler', () => {
  it('always admits explicit selections outside the automatic coverage cap', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1, () => 123);
    scheduler.register('public-a');
    scheduler.register('selected');
    scheduler.register('public-b');

    const automaticCoverage = scheduler.planAutomaticCoverage(['selected', 'selected']);

    expect(automaticCoverage).toEqual(['public-a']);
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

    expect(scheduler.planAutomaticCoverage([])).toEqual(['public-a', 'public-b']);
    expect(scheduler.planAutomaticCoverage([])).toEqual(['public-c', 'public-d']);
    expect(scheduler.planAutomaticCoverage([])).toEqual(['public-e', 'public-a']);
  });

  it('honors priority ordering without starving lower-priority graphs', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1);
    scheduler.register('normal');
    scheduler.register('low');
    scheduler.register('high');
    const priorities = { high: 10, low: -10 };

    expect(scheduler.planAutomaticCoverage([], priorities)).toEqual(['high']);
    expect(scheduler.planAutomaticCoverage([], priorities)).toEqual(['normal']);
    expect(scheduler.planAutomaticCoverage([], priorities)).toEqual(['low']);
  });

  it('anchors each lane to graph identity when priority ordering is rebuilt', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1);
    for (const id of ['public-a', 'public-b', 'public-c']) scheduler.register(id);

    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-a')).toEqual(['public-a']);
    expect(scheduler.planAutomaticCoverage([], { 'public-c': 10 }, 'peer-a'))
      .toEqual(['public-b']);
  });

  it('resets only lanes anchored to an unregistered graph', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1);
    for (const id of ['public-a', 'public-b', 'public-c']) scheduler.register(id);

    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-a')).toEqual(['public-a']);
    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-b')).toEqual(['public-a']);
    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-b')).toEqual(['public-b']);
    expect(scheduler.unregister('public-a')).toBe(true);

    expect(scheduler.getStatus(true).planningLanes).toBe(1);
    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-a')).toEqual(['public-b']);
    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-b')).toEqual(['public-c']);
  });

  it('rotates independently per peer so stable peer order cannot pin batches', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(2);
    for (const id of ['public-a', 'public-b', 'public-c', 'public-d']) {
      scheduler.register(id);
    }

    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-a'))
      .toEqual(['public-a', 'public-b']);
    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-b'))
      .toEqual(['public-a', 'public-b']);
    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-a'))
      .toEqual(['public-b', 'public-c']);
    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-b'))
      .toEqual(['public-b', 'public-c']);
  });

  it('eventually puts every graph first when each batch fails fast on its first graph', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(4);
    const contextGraphIds = Array.from({ length: 8 }, (_, index) => `public-${index}`);
    for (const id of contextGraphIds) scheduler.register(id);

    const firstAttempted = new Set<string>();
    for (let round = 0; round < contextGraphIds.length; round += 1) {
      firstAttempted.add(scheduler.planAutomaticCoverage([], undefined, 'failing-peer')[0]!);
    }

    expect(firstAttempted).toEqual(new Set(contextGraphIds));
  });

  it('bounds peer-lane state internally while retaining active-lane fairness', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1, Date.now, 3);
    scheduler.register('public-a');
    scheduler.register('public-b');
    for (const peer of ['peer-a', 'peer-b', 'peer-c', 'peer-d']) {
      expect(scheduler.planAutomaticCoverage([], undefined, peer)).toEqual(['public-a']);
    }

    expect(scheduler.getStatus(true).planningLanes).toBe(3);
    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-d')).toEqual(['public-b']);
    expect(scheduler.planAutomaticCoverage([], undefined, 'peer-a')).toEqual(['public-a']);
    expect(scheduler.getStatus(true).planningLanes).toBe(3);
    expect(DEFAULT_CORE_PUBLIC_SYNC_MAX_PLANNING_LANES).toBeGreaterThan(3);
  });

  it('never exceeds the production lane cap under transient peer churn', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(1);
    scheduler.register('public-a');
    scheduler.register('public-b');

    for (let index = 0; index < DEFAULT_CORE_PUBLIC_SYNC_MAX_PLANNING_LANES + 52; index += 1) {
      scheduler.planAutomaticCoverage([], undefined, `transient-peer-${index}`);
    }

    expect(scheduler.getStatus(true).planningLanes)
      .toBe(DEFAULT_CORE_PUBLIC_SYNC_MAX_PLANNING_LANES);
  });

  it('returns no automatic tail when coverage is disabled', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(0);
    scheduler.register('public-a');

    expect(scheduler.planAutomaticCoverage(['selected'])).toEqual([]);
    expect(scheduler.hasAutomaticCoverageBacklog(0)).toBe(false);
    expect(scheduler.getStatus(true)).toMatchObject({
      enabled: false,
      batchSize: 0,
      trackedContextGraphs: 1,
      planningLanes: 0,
    });
  });

  it('clamps a live automatic-coverage batch without counting selected CGs', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(4);
    for (const contextGraphId of ['cg:a', 'cg:b', 'cg:c', 'cg:d']) {
      scheduler.register(contextGraphId);
    }

    const constrained = scheduler.planAutomaticCoverageWithOptions(['cg:selected'], {
      planningLane: 'peer-a',
      effectiveBatchSize: 1,
    });
    expect(constrained).toHaveLength(1);

    const recovered = scheduler.planAutomaticCoverageWithOptions(['cg:selected'], {
      planningLane: 'peer-a',
      effectiveBatchSize: 20,
    });
    expect(recovered).toHaveLength(4);
    expect(recovered).not.toContain('cg:selected');
  });

  it('preserves first-slot rotation while the effective batch changes', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(3);
    for (const contextGraphId of ['cg:a', 'cg:b', 'cg:c', 'cg:d', 'cg:e']) {
      scheduler.register(contextGraphId);
    }

    const first = scheduler.planAutomaticCoverageWithOptions([], {
      planningLane: 'peer-a',
      effectiveBatchSize: 1,
    });
    const second = scheduler.planAutomaticCoverageWithOptions([], {
      planningLane: 'peer-a',
      effectiveBatchSize: 2,
    });
    const third = scheduler.planAutomaticCoverageWithOptions([], {
      planningLane: 'peer-a',
      effectiveBatchSize: 1,
    });

    expect(first).toEqual(['cg:a']);
    expect(second).toEqual(['cg:c', 'cg:d']);
    expect(third).toEqual(['cg:d']);
  });

  it('reports automatic coverage demand only while the live batch truncates candidates', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(4);
    for (const contextGraphId of ['cg:a', 'cg:b', 'cg:c', 'cg:d', 'cg:e']) {
      scheduler.register(contextGraphId);
    }

    expect(scheduler.hasAutomaticCoverageBacklog(2)).toBe(true);
    scheduler.planAutomaticCoverage(['cg:a', 'cg:b'], undefined, 'peer-a', 2);
    expect(scheduler.hasAutomaticCoverageBacklog(2)).toBe(true);
    expect(scheduler.hasAutomaticCoverageBacklog(3)).toBe(false);
  });

  it('rejects invalid live automatic-coverage batches', () => {
    const scheduler = new CorePublicSyncCoverageScheduler(3);
    scheduler.register('cg:a');

    expect(() => scheduler.planAutomaticCoverageWithOptions([], {
      planningLane: 'peer-a',
      effectiveBatchSize: -1,
    })).toThrow(
      /effective Core public sync batch size/,
    );
    expect(() => scheduler.planAutomaticCoverageWithOptions([], {
      planningLane: 'peer-a',
      effectiveBatchSize: 1.5,
    })).toThrow(
      /effective Core public sync batch size/,
    );
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
