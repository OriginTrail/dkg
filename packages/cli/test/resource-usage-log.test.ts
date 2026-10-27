import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Logger,
  type BackpressureLaneSnapshot,
  type BackpressureOperationSummary,
  type BackpressureRegistrySnapshot,
  type BackpressureSnapshot,
} from '@origintrail-official/dkg-core';
import {
  captureResourceUsage,
  formatResourceUsageLine,
  RESOURCE_USAGE_LOG_INTERVAL_MS,
  startResourceUsageLog,
  type ResourceUsageSample,
} from '../src/daemon/resource-usage-log.js';

const MIB = 1024 * 1024;

function lane(
  name: string,
  values: {
    inflight?: number;
    inflightLimit?: number | null;
    queued?: number;
    active?: BackpressureOperationSummary[];
  } = {},
): BackpressureLaneSnapshot {
  return {
    lane: name,
    state: 'healthy',
    queued: values.queued ?? 0,
    queueLimit: 64,
    inflight: values.inflight ?? 0,
    inflightLimit: values.inflightLimit === undefined ? 1 : values.inflightLimit,
    oldestQueuedAgeMs: 0,
    oldestActiveAgeMs: 0,
    queuedOperations: [],
    activeOperations: values.active ?? [],
    events: {},
    rejectedTotal: 0,
    rejectedByReason: {},
    lastRejectedAgeMs: null,
  };
}

function scheduler(
  name: string,
  lanes: BackpressureLaneSnapshot[],
  totals: Partial<BackpressureSnapshot['totals']> = {},
): BackpressureSnapshot {
  return {
    scheduler: name,
    state: 'healthy',
    totals: {
      queued: 0,
      queueLimit: null,
      inflight: 0,
      inflightLimit: null,
      oldestQueuedAgeMs: 0,
      oldestActiveAgeMs: 0,
      rejectedTotal: 0,
      ...totals,
    },
    lanes,
  };
}

const op = (operation: string, oldestAgeMs: number, count = 1): BackpressureOperationSummary =>
  ({ operation, count, oldestAgeMs });

/** A 4-vCPU Core: one slot per store lane, one general and two reserved sync slots. */
const busyCore: ResourceUsageSample = {
  rssBytes: 1806 * MIB,
  heapUsedBytes: 812.4 * MIB,
  heapLimitBytes: 4144 * MIB,
  externalBytes: 95 * MIB,
  // The registry lists lanes alphabetically; the line puts them in priority order.
  store: scheduler('store', [
    lane('ack', { inflightLimit: 4 }),
    lane('background', {
      inflight: 1,
      queued: 12,
      active: [op('agent.durableSync.graphScopedMaterialization', 9_830)],
    }),
    lane('health', { inflightLimit: 3 }),
    lane('normal', { inflight: 1, inflightLimit: 2, queued: 3, active: [op('agent.vmRefresh.holders', 4_210)] }),
  ]),
  sync: scheduler('sync-global', [
    lane('durable', {
      inflight: 3,
      active: [op('durable:vm-recovery', 62_000), op('durable:control-plane', 300, 2)],
    }),
  ], { inflight: 3, inflightLimit: 3, queued: 0, queueLimit: 16 }),
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resource_usage line', () => {
  it('carries the memory figures, every store lane with its queue and active operation, and the sync slots', () => {
    expect(formatResourceUsageLine(busyCore)).toBe([
      'resource_usage',
      'rss_mb=1806 heap_used_mb=812 heap_limit_mb=4144 external_mb=95',
      'store_ack=0/4 store_ack_queued=0',
      'store_health=0/3 store_health_queued=0',
      'store_normal=1/2 store_normal_queued=3 store_normal_active=agent.vmRefresh.holders:4.2s',
      'store_background=1/1 store_background_queued=12',
      'store_background_active=agent.durableSync.graphScopedMaterialization:9.8s',
      'sync=3/3 sync_queued=0/16 sync_active=durable:vm-recovery:62.0s,durable:control-plane*2:0.3s',
    ].join(' '));
  });

  it('prints the queue control schedulers after the store lanes, only while that path is on', () => {
    const control = [
      // The registry lists schedulers by id; each has the one `control` lane.
      scheduler('store-control-publisher', [
        lane('control', { inflight: 2, inflightLimit: 2, queued: 1, active: [op('publisher.asyncLift.claim', 200, 2)] }),
      ], { inflight: 2, inflightLimit: 2, queued: 1, queueLimit: 64 }),
      scheduler('store-control-share', [lane('control', { inflightLimit: 1 })], { inflight: 0, inflightLimit: 1, queued: 0, queueLimit: 64 }),
    ];
    const line = formatResourceUsageLine({ ...busyCore, control });
    expect(line).toContain(
      'store_background_active=agent.durableSync.graphScopedMaterialization:9.8s '
      + 'store_control_publisher=2/2 store_control_publisher_queued=1 store_control_publisher_active=publisher.asyncLift.claim*2:0.2s '
      + 'store_control_share=0/1 store_control_share_queued=0 '
      + 'sync=3/3',
    );
    const [name, ...tokens] = line.split(' ');
    expect(name).toBe('resource_usage');
    for (const token of tokens) expect(token).toMatch(/^[a-z_]+=[^\s="]+$/);

    // Off: no instance registered, so no control figure and the line is unchanged.
    expect(formatResourceUsageLine({ ...busyCore, control: [] })).toBe(formatResourceUsageLine(busyCore));
    expect(formatResourceUsageLine(busyCore)).not.toContain('store_control');
  });

  it('is one logfmt record: a name, then key=value tokens without spaces or quotes', () => {
    const [name, ...tokens] = formatResourceUsageLine(busyCore).split(' ');
    expect(name).toBe('resource_usage');
    for (const token of tokens) expect(token).toMatch(/^[a-z_]+=[^\s="]+$/);
  });

  it('leaves out a scheduler that never registered, an idle lane\'s operations and an unknown limit', () => {
    const memoryOnly = { ...busyCore, store: undefined, sync: undefined };
    expect(formatResourceUsageLine(memoryOnly))
      .toBe('resource_usage rss_mb=1806 heap_used_mb=812 heap_limit_mb=4144 external_mb=95');

    expect(formatResourceUsageLine({
      ...memoryOnly,
      store: scheduler('store', [lane('normal', { inflightLimit: null, queued: 2 }), lane('custom lane')]),
      sync: scheduler('sync-global', []),
    })).toBe('resource_usage rss_mb=1806 heap_used_mb=812 heap_limit_mb=4144 external_mb=95 '
      + 'store_normal=0 store_normal_queued=2 store_custom_lane=0/1 store_custom_lane_queued=0 '
      + 'sync=0 sync_queued=0');
  });

  it('merges an operation that holds slots in several sync lanes and lists eight at most, oldest first', () => {
    const many = Array.from({ length: 10 }, (_, index) => op(`durable:source-${index}`, index * 1_000));
    const line = formatResourceUsageLine({
      ...busyCore,
      store: undefined,
      sync: scheduler('sync-global', [
        lane('durable', { active: [op('shared-memory:on-connect', 1_000), ...many.slice(0, 5)] }),
        lane('shared_memory', { active: [op('shared-memory:on-connect', 2_500, 2), ...many.slice(5)] }),
      ], { inflight: 13, inflightLimit: 13 }),
    });

    const active = line.split(' ').find((token) => token.startsWith('sync_active='))!.slice('sync_active='.length);
    expect(active.split(',')).toEqual([
      'durable:source-9:9.0s',
      'durable:source-8:8.0s',
      'durable:source-7:7.0s',
      'durable:source-6:6.0s',
      'durable:source-5:5.0s',
      'durable:source-4:4.0s',
      'durable:source-3:3.0s',
      'shared-memory:on-connect*3:2.5s',
    ]);
  });

  it('reads the process memory, the V8 heap limit and the two schedulers from the registry', () => {
    const snapshot: BackpressureRegistrySnapshot = {
      capturedAt: new Date(0).toISOString(),
      state: 'healthy',
      schedulers: [scheduler('other', []), busyCore.store!, busyCore.sync!],
      failures: [],
    };
    const sample = captureResourceUsage({ capture: () => snapshot });

    expect(sample.store).toBe(busyCore.store);
    expect(sample.sync).toBe(busyCore.sync);
    expect(sample.control).toEqual([]);
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.heapUsedBytes).toBeGreaterThan(0);
    expect(sample.heapLimitBytes).toBeGreaterThan(sample.heapUsedBytes);
    expect(sample.externalBytes).toBeGreaterThanOrEqual(0);
  });
});

describe('captureResourceUsage with the control path on', () => {
  it('takes the control schedulers by their registry ids and leaves the shared store scheduler alone', () => {
    const share = scheduler('store-control-share', [lane('control')]);
    const publisher = scheduler('store-control-publisher', [lane('control')]);
    const snapshot: BackpressureRegistrySnapshot = {
      capturedAt: new Date(0).toISOString(),
      state: 'healthy',
      schedulers: [scheduler('other', []), busyCore.store!, publisher, share, busyCore.sync!],
      failures: [],
    };
    const sample = captureResourceUsage({ capture: () => snapshot });

    expect(sample.store).toBe(busyCore.store);
    expect(sample.control).toEqual([publisher, share]);
  });
});

describe('startResourceUsageLog', () => {
  it('logs a line at start and one every five minutes until stopped, skipping a failed sample', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const lines: string[] = [];
    let samples = 0;
    const log = startResourceUsageLog({
      emit: (line) => lines.push(line),
      capture: () => {
        samples += 1;
        if (samples === 2) throw new Error('registry source failed');
        return busyCore;
      },
    });
    expect(lines).toHaveLength(1);

    vi.advanceTimersByTime(RESOURCE_USAGE_LOG_INTERVAL_MS - 1);
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(samples).toBe(2);
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(RESOURCE_USAGE_LOG_INTERVAL_MS);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(formatResourceUsageLine(busyCore));

    log.stop();
    vi.advanceTimersByTime(10 * RESOURCE_USAGE_LOG_INTERVAL_MS);
    expect(lines).toHaveLength(2);
    expect(RESOURCE_USAGE_LOG_INTERVAL_MS).toBe(5 * 60_000);
  });

  it('writes through the structured logger by default, from the live registry', () => {
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});

    startResourceUsageLog().stop();

    expect(info).toHaveBeenCalledTimes(1);
    const [ctx, line] = info.mock.calls[0];
    expect(ctx).toMatchObject({ operationName: 'system' });
    expect(line).toMatch(/^resource_usage rss_mb=\d+ heap_used_mb=\d+ heap_limit_mb=\d+ external_mb=\d+/);
  });
});
