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
import { validateSyncResponderSnapshotLimitsConfig as validatePublicSnapshotConfig } from '../src/index.js';
import { resolveStartupResourcePolicy } from '../src/resource-policy.js';
import { resolveSyncReconcilerTiming } from '../src/sync/reconciler-timing.js';
import { resolveSyncResponderSnapshotDiagnostics } from '../src/sync/responder/snapshot-policy.js';
import { resolveCatchupBackpressureMaxWaitMs } from '../src/sync/catchup-policy.js';
import { resolveSwmCatchupMaxPasses, resolveSwmCatchupPassBudgetMs, resolveSwmCatchupPassConfig } from '../src/sync/catchup-pass-policy.js';

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

  it('sanitizes retained names before rendering diagnostics', () => {
    const warnings = new ResourceConfigWarnings();
    warnings.reject('bad\nname'.repeat(50));
    expect(warnings.settings).toEqual([('bad_name'.repeat(50)).slice(0, 100)]);
    expect(warnings.settings[0]).toHaveLength(100);
    expect(warnings.message()).toContain(warnings.settings[0]);
    expect(warnings.message()).not.toContain('\n');
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

  it('caps the aggregate queue even when every partition leaf is valid', () => {
    for (const key of ['DKG_SYNC_GLOBAL_MAX_INFLIGHT', 'DKG_SYNC_GLOBAL_LIMIT', 'DKG_SYNC_GLOBAL_QUEUE_LIMIT']) vi.stubEnv(key, '');
    const policy = resolveSyncGlobalBackpressure({ syncAdmission: {
      mode: 'partitioned', globalMaxInflight: 4,
      fast: { maxInflight: 1, queueLimit: RESOURCE_MAX.queue },
      slow: { maxInflight: 3, foregroundReserved: 1, backgroundMaxInflight: 2,
        foregroundQueueLimit: RESOURCE_MAX.queue, backgroundQueueLimit: RESOURCE_MAX.queue },
    } });
    expect(policy.queueLimit).toBe(RESOURCE_MAX.queue);
    expect(getSyncBackpressureSnapshot(policy).queueLimit).toBe(RESOURCE_MAX.queue);
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

it('composes bounded executable policy and immutable diagnostics using the supplied environment', () => {
  vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', '100');
  const env = { DKG_SYNC_GLOBAL_MAX_INFLIGHT: 'invalid', DKG_SYNC_GLOBAL_QUEUE_LIMIT: '12' };
  const policy = resolveStartupResourcePolicy({
    syncGlobalMaxInflight: 3,
    syncReconcilerIntervalMs: 12.5,
    syncResponderSnapshotLimits: { global: { rows: 100 }, local: { rows: 101 } },
  }, env, resolveAgentResourceEnvironment({ DKG_VM_RECONCILE_BATCH_SIZE: '20' }));
  expect(policy.admission).toMatchObject({ limit: 3, queueLimit: 12 });
  expect(policy.snapshot.budget.maxRows).toBe(100);
  expect(policy.vm.values.DKG_VM_RECONCILE_BATCH_SIZE).toBe(20);
  expect(policy.diagnostics.rejected).toEqual(['syncReconcilerIntervalMs', 'DKG_SYNC_GLOBAL_MAX_INFLIGHT']);
  expect(policy.diagnostics.clamped).toEqual(['syncResponderSnapshotLimits.local.rows']);
  expect(policy.diagnostics.warning).toContain('Clamped resource settings');
  expect(Object.isFrozen(policy.snapshot.budget)).toBe(true);
});

it('keeps initial SWM diagnostics immutable while job-scoped resolution refreshes explicitly', () => {
  const env = { DKG_SWM_CATCHUP_PASS_BUDGET_MS: 'invalid', DKG_SWM_CATCHUP_MAX_PASSES: '3' };
  const policy = resolveStartupResourcePolicy({}, env, resolveAgentResourceEnvironment({}));
  expect(resolveSwmCatchupPassConfig(env)).toEqual(policy.initialSwmPass);
  expect(policy.initialSwmPass).toEqual({ budgetMs: 600_000, maxPasses: 3 });
  expect(policy.diagnostics.rejected).toEqual(['DKG_SWM_CATCHUP_PASS_BUDGET_MS']);
  const next = resolveSwmCatchupPassConfig({ ...env, DKG_SWM_CATCHUP_PASS_BUDGET_MS: '0' });
  expect(next).toEqual({ budgetMs: 0, maxPasses: 3 });
  next.maxPasses = 2;
  next.budgetMs = 123;
  expect(next).toEqual({ maxPasses: 2, budgetMs: 123 });
  expect(Object.isFrozen(policy.initialSwmPass)).toBe(true);
  expect(policy.initialSwmPass.budgetMs).toBe(600_000);
  expect(policy.diagnostics.rejected).toEqual(['DKG_SWM_CATCHUP_PASS_BUDGET_MS']);
});

describe('snapshot and retry/timing budgets', () => {
  it.each(['global', 'local'] as const)('keeps the package-root %s validator strict while runtime resolution falls back', (scope) => {
    for (const [field, maximum] of [['rows', RESOURCE_MAX.rows], ['bytesEstimate', RESOURCE_MAX.bytes]] as const) {
      for (const value of [0, ...invalidNumbers, maximum + 1]) {
        const config = { [scope]: { [field]: value } };
        expect(() => validatePublicSnapshotConfig(config)).toThrow(TypeError);
        expect(() => validatePublicSnapshotConfig(config)).toThrow(`syncResponderSnapshotLimits.${scope}.${field}`);
        expect(resolveSyncResponderSnapshotDiagnostics(config, {}).diagnostics).toContainEqual({
          kind: 'rejected', setting: `syncResponderSnapshotLimits.${scope}.${field}`,
        });
      }
      for (const value of [1, maximum]) {
        expect(() => validatePublicSnapshotConfig({ [scope]: { [field]: value } })).not.toThrow();
      }
    }
  });

  it('resolves invalid snapshot numeric leaves to defaults without disclosing raw values', () => {
    const baseline = resolveSyncResponderSnapshotDiagnostics(undefined, {});
    const resolved = resolveSyncResponderSnapshotDiagnostics({
      global: { rows: RESOURCE_MAX.rows + 1, bytesEstimate: Infinity },
      local: { rows: -1, bytesEstimate: RESOURCE_MAX.bytes + 1 },
    }, { DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT: 'secret' });
    expect(resolved.budget).toEqual(baseline.budget);
    expect(resolved.diagnostics).toEqual([
      'DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT',
      'syncResponderSnapshotLimits.global.rows',
      'syncResponderSnapshotLimits.global.bytesEstimate',
      'syncResponderSnapshotLimits.local.rows',
      'syncResponderSnapshotLimits.local.bytesEstimate',
    ].map((setting) => ({ kind: 'rejected', setting })));
    expect(JSON.stringify(resolved.diagnostics)).not.toContain('secret');
    expect(Object.isFrozen(resolved.diagnostics)).toBe(true);
    expect(() => resolveSyncResponderSnapshotDiagnostics({ global: [] } as never, {})).toThrow('global');
  });

  it('accepts snapshot ceilings and keeps the per-snapshot budget within the global budget', () => {
    expect(resolveSyncResponderSnapshotDiagnostics({ global: { rows: RESOURCE_MAX.rows, bytesEstimate: RESOURCE_MAX.bytes },
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
