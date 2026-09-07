import { afterEach, describe, expect, it, vi } from 'vitest';
import { backpressureRegistry, createOperationContext } from '@origintrail-official/dkg-core';
import {
  AGENT_RESOURCE_ENV_SPECS, RESOURCE_MAX, ResourceConfigWarnings,
  resolveAgentResourceEnvironment, resourceInteger, resourceIntegerEnv,
} from '../src/resource-limits.js';
import {
  getSyncBackpressureSnapshot, resolveNonNegativeIntegerSwitch, resolvePositiveIntegerSwitch,
  resolveSyncGlobalBackpressure, withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import { resolveSyncReconcilerTiming } from '../src/sync/reconciler-timing.js';
import { resolveSyncResponderSnapshotPolicy } from '../src/sync/responder/sync-handler.js';
import { resolveCatchupBackpressureMaxWaitMs } from '../src/sync/catchup-policy.js';
import { resolveSwmCatchupMaxPasses, resolveSwmCatchupPassBudgetMs } from '../src/sync/catchup-pass-policy.js';

const invalidNumbers = [NaN, Infinity, -Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1];
afterEach(() => vi.unstubAllEnvs());

describe('bounded resource integers', () => {
  it.each([0, 1] as const)('accepts only safe integers in the explicit range with minimum %s', (min) => {
    const bounds = { min, max: 100 };
    const warnings = new ResourceConfigWarnings();
    for (const value of [...invalidNumbers, 101, ...(min === 1 ? [0] : [])]) {
      expect(resourceInteger(value, bounds, 'capacity', warnings.reject)).toBeUndefined();
      expect(resourceIntegerEnv(String(value), bounds, 'CAPACITY', warnings.reject)).toBeUndefined();
    }
    for (const value of [min, 99, 100]) {
      expect(resourceInteger(value, bounds, 'capacity')).toBe(value);
      expect(resourceIntegerEnv(` ${value} `, bounds, 'CAPACITY')).toBe(value);
    }
    expect(warnings.settings).toEqual(['capacity', 'CAPACITY']);
    expect(resourceInteger('2', bounds, 'capacity')).toBeUndefined();
    expect(resourceInteger(null, bounds, 'capacity')).toBeUndefined();
  });

  it('does not mistake omitted or blank assignments for an explicit zero', () => {
    const rejected = vi.fn();
    for (const raw of [undefined, '', '   ']) {
      expect(resourceIntegerEnv(raw, { min: 0, max: 10 }, 'LIMIT', rejected)).toBeUndefined();
    }
    expect(resourceInteger(undefined, { min: 0, max: 10 }, 'limit', rejected)).toBeUndefined();
    expect(rejected).not.toHaveBeenCalled();
    expect(new ResourceConfigWarnings().message()).toBeUndefined();
  });

  it('bounds diagnostics independently of invalid value size and repeated resolutions', () => {
    const warnings = new ResourceConfigWarnings();
    const secret = 'secret-value'.repeat(20_000);
    for (let i = 0; i < 10_000; i++) {
      resourceIntegerEnv(secret, { min: 1, max: 10 }, `DKG_LIMIT_${i}`, warnings.reject);
    }
    expect(warnings.settings).toHaveLength(24);
    expect(warnings.message()).toContain('...');
    expect(warnings.message()!.length).toBeLessThan(2_600);
    expect(warnings.message()).not.toContain('secret-value');
    warnings.reject('bad\nname'.repeat(50));
    expect(warnings.message()).not.toContain('\n');
  });
});

describe('restart-scoped VM and catch-up environment policy', () => {
  it.each(Object.entries(AGENT_RESOURCE_ENV_SPECS))('%s rejects out-of-range values and retains boundaries', (name, spec) => {
    for (const raw of [...invalidNumbers, spec.max + 1, ...(spec.min ? [0] : [])].map(String)) {
      const result = resolveAgentResourceEnvironment({ [name]: raw });
      expect(result.values[name as keyof typeof result.values]).toBe(spec.fallback);
      expect(result.rejected).toContain(name);
    }
    for (const value of [spec.min, spec.max]) {
      const result = resolveAgentResourceEnvironment({ [name]: String(value) });
      expect(result.values[name as keyof typeof result.values]).toBe(value);
      expect(result.rejected).toEqual([]);
    }
    for (const raw of [undefined, '', ' ']) {
      const result = resolveAgentResourceEnvironment({ [name]: raw });
      expect(result.values[name as keyof typeof result.values]).toBe(spec.fallback);
      expect(result.rejected).toEqual([]);
    }
  });

  it('bounds startup jitter using the effective cadence and retains immediate startup', () => {
    for (const raw of [...invalidNumbers, RESOURCE_MAX.timerMs + 1].map(String)) {
      expect(resolveAgentResourceEnvironment({
        DKG_VM_RECONCILE_INTERVAL_MS: '75000', DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS: raw,
      })).toMatchObject({ startupMaxDelayMs: 75_000, rejected: ['DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS'] });
    }
    expect(resolveAgentResourceEnvironment({ DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS: '0' }).startupMaxDelayMs).toBe(0);
    expect(resolveAgentResourceEnvironment({ DKG_VM_RECONCILE_INTERVAL_MS: 'Infinity' }).startupMaxDelayMs).toBe(60_000);
  });
});

describe('resolved sync policy and production pressure reporting', () => {
  it.each(invalidNumbers.concat(RESOURCE_MAX.concurrency + 1))('falls through invalid global inflight %s to valid config', (value) => {
    vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', String(value));
    vi.stubEnv('DKG_SYNC_GLOBAL_LIMIT', '');
    vi.stubEnv('DKG_SYNC_GLOBAL_QUEUE_LIMIT', String(RESOURCE_MAX.queue + 1));
    const warnings = new ResourceConfigWarnings();
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 3, syncGlobalQueueLimit: 6 }, warnings.reject);
    expect(policy).toEqual({ mode: 'shared', limit: 3, queueLimit: 6 });
    expect(warnings.settings).toEqual(['DKG_SYNC_GLOBAL_MAX_INFLIGHT', 'DKG_SYNC_GLOBAL_QUEUE_LIMIT']);
    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ limit: 3, queueLimit: 6 });
  });

  it('uses existing defaults for invalid config, and preserves zero off/zero queue modes', () => {
    for (const key of ['DKG_SYNC_GLOBAL_MAX_INFLIGHT', 'DKG_SYNC_GLOBAL_LIMIT', 'DKG_SYNC_GLOBAL_QUEUE_LIMIT']) vi.stubEnv(key, '');
    const baseline = resolveSyncGlobalBackpressure({});
    expect(resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: Infinity, syncGlobalLimit: -1,
      syncGlobalQueueLimit: RESOURCE_MAX.queue + 1 })).toEqual(baseline);
    expect(resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 0 })).toEqual({ mode: 'shared', limit: undefined, queueLimit: undefined });
    expect(resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 })).toEqual({ mode: 'shared', limit: 1, queueLimit: 0 });
    expect(resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: RESOURCE_MAX.concurrency,
      syncGlobalQueueLimit: RESOURCE_MAX.queue })).toMatchObject({ limit: RESOURCE_MAX.concurrency, queueLimit: RESOURCE_MAX.queue });
  });

  it('reports the same fallback capacity on status and W1 as the admitted production queue', async () => {
    vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', 'Infinity');
    vi.stubEnv('DKG_SYNC_GLOBAL_LIMIT', '');
    vi.stubEnv('DKG_SYNC_GLOBAL_QUEUE_LIMIT', 'Infinity');
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 2 });
    await withGlobalSyncBackpressure({ policy, ctx: createOperationContext('sync'), label: 'resource-bounds', source: 'reconcile' }, async () => {
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, limit: 1, queueLimit: 2 });
      expect(backpressureRegistry.capture().schedulers.find((entry) => entry.scheduler === 'sync-global'))
        .toMatchObject({ capacityModel: 'shared', totals: { inflight: 1, inflightLimit: 1, queueLimit: 2 } });
    });
    expect(getSyncBackpressureSnapshot(policy).inflight).toBe(0);
  });

  it('bounds all partition leaves while retaining structural/cross-field validation', () => {
    for (const key of ['DKG_SYNC_GLOBAL_MAX_INFLIGHT', 'DKG_SYNC_GLOBAL_LIMIT', 'DKG_SYNC_GLOBAL_QUEUE_LIMIT']) vi.stubEnv(key, '');
    const warnings = new ResourceConfigWarnings();
    const baseline = resolveSyncGlobalBackpressure({ syncAdmission: { mode: 'partitioned' } });
    const result = resolveSyncGlobalBackpressure({ syncAdmission: { mode: 'partitioned',
      globalMaxInflight: Infinity,
      fast: { maxInflight: RESOURCE_MAX.concurrency + 1, queueLimit: RESOURCE_MAX.queue + 1, queueTimeoutMs: RESOURCE_MAX.timerMs + 1 },
      slow: { maxInflight: Infinity, foregroundReserved: -1, foregroundQueueLimit: NaN, backgroundMaxInflight: 1.5, backgroundQueueLimit: Infinity },
    } }, warnings.reject);
    expect(result).toEqual(baseline);
    expect(warnings.settings).toHaveLength(9);
    expect(() => resolveSyncGlobalBackpressure({ syncAdmission: { fast: [] } as never })).toThrow('syncAdmission.fast');
    expect(() => resolveSyncGlobalBackpressure({ syncAdmission: { globalMaxInflight: 1, fast: { maxInflight: 2 } } })).toThrow('must not exceed');
  });

  it('bounds generic integer switches with an explicit tighter owner ceiling', () => {
    vi.stubEnv('DKG_TEST_RESOURCE', 'Infinity');
    expect(resolveNonNegativeIntegerSwitch(0, 'DKG_TEST_RESOURCE', 100)).toBe(0);
    expect(resolvePositiveIntegerSwitch(5, 'DKG_TEST_RESOURCE', 100)).toBe(5);
    vi.stubEnv('DKG_TEST_RESOURCE', '101');
    expect(resolvePositiveIntegerSwitch(101, 'DKG_TEST_RESOURCE', 100)).toBeUndefined();
    vi.stubEnv('DKG_TEST_RESOURCE', '100');
    expect(resolvePositiveIntegerSwitch(5, 'DKG_TEST_RESOURCE', 100)).toBe(100);
  });
});

describe('snapshot and retry/timing budgets', () => {
  it('resolves invalid snapshot numeric leaves to defaults without disclosing raw values', () => {
    const baseline = resolveSyncResponderSnapshotPolicy(undefined, {});
    const warnings: string[] = [];
    expect(resolveSyncResponderSnapshotPolicy({
      global: { rows: RESOURCE_MAX.rows + 1, bytesEstimate: Infinity },
      local: { rows: -1, bytesEstimate: RESOURCE_MAX.bytes + 1 },
    }, { DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT: 'secret' }, (message) => warnings.push(message))).toEqual(baseline);
    expect(warnings).toHaveLength(5);
    expect(warnings.join(' ')).not.toContain('secret');
    expect(() => resolveSyncResponderSnapshotPolicy({ global: [] } as never, {})).toThrow('global');
  });

  it('accepts snapshot ceilings and keeps the per-snapshot budget within the global budget', () => {
    expect(resolveSyncResponderSnapshotPolicy({ global: { rows: RESOURCE_MAX.rows, bytesEstimate: RESOURCE_MAX.bytes },
      local: { rows: RESOURCE_MAX.rows, bytesEstimate: RESOURCE_MAX.bytes } }, {}).budget)
      .toEqual({ maxRows: RESOURCE_MAX.rows, maxSnapshotRows: RESOURCE_MAX.rows,
        maxBytesEstimate: RESOURCE_MAX.bytes, maxSnapshotBytesEstimate: RESOURCE_MAX.bytes });
  });

  it.each([
    [resolveCatchupBackpressureMaxWaitMs, 180_000, RESOURCE_MAX.retryMs, 0],
    [resolveSwmCatchupPassBudgetMs, 600_000, RESOURCE_MAX.retryMs, 0],
    [resolveSwmCatchupMaxPasses, 4, RESOURCE_MAX.passes, 1],
  ] as const)('bounds retry/pass parser %#', (resolve, fallback, maximum, minimum) => {
    for (const value of [...invalidNumbers, maximum + 1, ...(minimum ? [0] : [])]) expect(resolve(String(value))).toBe(fallback);
    expect(resolve(String(minimum))).toBe(minimum);
    expect(resolve(String(maximum))).toBe(maximum);
  });

  it('keeps timer bounds and rejects fractional milliseconds with named diagnostics', () => {
    const warnings = new ResourceConfigWarnings();
    expect(resolveSyncReconcilerTiming({ syncReconcilerIntervalMs: 1.5, syncStalenessThresholdMs: Infinity,
      syncBackoffBaseMs: RESOURCE_MAX.timerMs + 1, syncBackoffMaxMs: -1 }, warnings.reject)).toEqual(resolveSyncReconcilerTiming({}));
    expect(warnings.settings).toEqual(['syncReconcilerIntervalMs', 'syncStalenessThresholdMs', 'syncBackoffBaseMs', 'syncBackoffMaxMs']);
    expect(resolveSyncReconcilerTiming({ syncReconcilerIntervalMs: RESOURCE_MAX.timerMs }).intervalMs).toBe(RESOURCE_MAX.timerMs);
  });
});
