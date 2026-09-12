import { describe, expect, it } from 'vitest';
import { resolveAgentResourceEnvironment } from '../src/resource-limits.js';
import { projectStartupResourceDiagnostics, resolveStartupResourcePolicy } from '../src/resource-policy.js';

const env = {
  DKG_VM_RECONCILE_INTERVAL_MS: '101', DKG_VM_RECONCILE_BACKOFF_MAX_MS: '202',
  DKG_VM_RECONCILE_CACHE_MAX_ENTRIES: '3', DKG_VM_RECONCILE_CG_STATE_MAX_ENTRIES: '4',
  DKG_VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS: '5', DKG_VM_RECONCILE_QUEUE_MAX_PENDING: '6',
  DKG_VM_RECONCILE_BATCH_SIZE: '7', DKG_VM_RECONCILE_ORDINAL_CONCURRENCY: '8',
  DKG_VM_RECONCILE_CONCURRENCY: '9', DKG_VM_RECONCILE_MAX_FOREGROUND_BURST: '10',
  DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS: '111', DKG_RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS: '222',
  DKG_CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS: '333', DKG_VM_RECONCILE_CONFIRMATION_DEPTH: '14',
  DKG_CATCHUP_MAX_CONCURRENT_PEERS: '15', DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS: '444',
  DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS: '55', DKG_SWM_CATCHUP_PASS_BUDGET_MS: '66', DKG_SWM_CATCHUP_MAX_PASSES: '2',
};
const priorities = { elevated: 1, default: 2, deprioritized: 3 };
function resolve(config: Parameters<typeof resolveStartupResourcePolicy>[0] = {}) {
  return resolveStartupResourcePolicy({
    syncGlobalMaxInflight: 3, syncGlobalQueueLimit: 4,
    syncReconcilerIntervalMs: 1000, syncStalenessThresholdMs: 2000,
    syncBackoffBaseMs: 3000, syncBackoffMaxMs: 4000, syncBackoffJitter: 0.1,
    syncResponderSnapshotLimits: { global: { rows: 100, bytesEstimate: 1000 }, local: { rows: 40, bytesEstimate: 400 } },
    ...config,
  }, env, resolveAgentResourceEnvironment(env));
}

const expectedShared = {
  vm: { values: {
    DKG_VM_RECONCILE_INTERVAL_MS: 101, DKG_VM_RECONCILE_BACKOFF_MAX_MS: 202,
    DKG_VM_RECONCILE_CACHE_MAX_ENTRIES: 3, DKG_VM_RECONCILE_CG_STATE_MAX_ENTRIES: 4,
    DKG_VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS: 5, DKG_VM_RECONCILE_QUEUE_MAX_PENDING: 6,
    DKG_VM_RECONCILE_BATCH_SIZE: 7, DKG_VM_RECONCILE_ORDINAL_CONCURRENCY: 8,
    DKG_VM_RECONCILE_CONCURRENCY: 9, DKG_VM_RECONCILE_MAX_FOREGROUND_BURST: 10,
    DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS: 111, DKG_RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS: 222,
    DKG_CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS: 333, DKG_VM_RECONCILE_CONFIRMATION_DEPTH: 14,
    DKG_CATCHUP_MAX_CONCURRENT_PEERS: 15, DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS: 444,
  }, startupMaxDelayMs: 55 },
  reconcilerTiming: { intervalMs: 1000, stalenessThresholdMs: 2000, backoffBaseMs: 3000, backoffMaxMs: 4000, backoffJitter: 0.1 },
  admission: { mode: 'shared', limit: 3, queueLimit: 4, selectedRecoveryContextGraphCount: 0 },
  snapshot: { budget: { maxRows: 100, maxBytesEstimate: 1000, maxSnapshotRows: 40, maxSnapshotBytesEstimate: 400 } },
  initialSwmPass: { budgetMs: 66, maxPasses: 2 },
  configuredPriorities: { elevated: 1, default: 2, deprioritized: 3 },
};

describe('startup resource diagnostics schema', () => {
  it('serializes deliberate resolved scalar values without policy metadata', () => {
    const diagnostic = projectStartupResourceDiagnostics(resolve(), priorities);
    expect(diagnostic).toEqual(expectedShared);
    expect(JSON.parse(JSON.stringify(diagnostic))).toEqual(expectedShared);
  });

  it('preserves partition limits while summarizing recovery scopes by count', () => {
    const policy = resolve({
      syncGlobalMaxInflight: undefined, syncGlobalQueueLimit: undefined,
      selectedRecoveryContextGraphIds: ['urn:private:first', 'urn:private:second'],
      syncAdmission: {
        mode: 'partitioned', globalMaxInflight: 5,
        fast: { maxInflight: 3, queueLimit: 7, queueTimeoutMs: 99 },
        slow: { maxInflight: 2, foregroundReserved: 1, foregroundQueueLimit: 3, backgroundMaxInflight: 1, backgroundQueueLimit: 2 },
      },
    });
    const diagnostic = projectStartupResourceDiagnostics(policy, priorities);
    expect(diagnostic.admission).toEqual({
      mode: 'partitioned', limit: 5, queueLimit: 12, selectedRecoveryContextGraphCount: 2,
      partitions: {
        fast: { maxInflight: 3, queueLimit: 7, queueTimeoutMs: 99 },
        slow: { maxInflight: 2, foregroundReserved: 1, foregroundQueueLimit: 3, backgroundMaxInflight: 1, backgroundQueueLimit: 2 },
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain('urn:private:');
  });

  it('reports explicit null ceilings when admission is disabled', () => {
    const diagnostic = projectStartupResourceDiagnostics(resolve({ syncGlobalMaxInflight: 0 }), priorities);
    expect(diagnostic.admission).toEqual({ mode: 'shared', limit: null, queueLimit: null, selectedRecoveryContextGraphCount: 0 });
    expect(JSON.parse(JSON.stringify(diagnostic))).toEqual(diagnostic);
  });

  it('ignores future cyclic, bigint, collection and accessor-backed implementation fields', () => {
    const original = resolve();
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const internal = { cycle, counter: 1n, selected: new Set(['secret internal scope']), predicate: () => true };
    const policy = {
      ...original, internal,
      vm: { ...original.vm, internal, values: { ...original.vm.values, futureField: internal } },
      reconcilerTiming: { ...original.reconcilerTiming, internal },
      admission: { ...original.admission, internal },
      snapshot: { ...original.snapshot, internal, budget: { ...original.snapshot.budget, internal } },
      initialSwmPass: { ...original.initialSwmPass, internal },
    };
    for (const [owner, key] of [[policy, 'diagnostics'], [policy.vm, 'rejected'], [policy.snapshot, 'diagnostics']] as const) {
      Object.defineProperty(owner, key, { enumerable: true, get() { throw new Error('internal diagnostics accessed'); } });
    }
    const prioritiesWithInternal = { ...priorities, internal };
    const diagnostic = projectStartupResourceDiagnostics(policy, prioritiesWithInternal);
    expect(JSON.parse(JSON.stringify(diagnostic))).toEqual(expectedShared);
  });
});
