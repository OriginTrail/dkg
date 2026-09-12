import {
  ResourceConfigWarnings,
  type resolveAgentResourceEnvironment,
} from './resource-limits.js';
import { resolveSwmCatchupPassConfig } from './sync/catchup-pass-policy.js';
import { resolveSyncGlobalBackpressure, type SyncGlobalBackpressureConfig } from './sync/backpressure.js';
import { resolveSyncReconcilerTiming, type SyncReconcilerTimingConfig } from './sync/reconciler-timing.js';
import { resolveSyncResponderSnapshotDiagnostics, type SyncResponderSnapshotLimitsConfig } from './sync/responder/snapshot-policy.js';

interface StartupResourceConfig extends SyncGlobalBackpressureConfig, SyncReconcilerTimingConfig {
  syncResponderSnapshotLimits?: SyncResponderSnapshotLimitsConfig;
}

/** Resolve immutable startup data and diagnostics with an explicit process-scoped VM snapshot. */
export function resolveStartupResourcePolicy(
  config: StartupResourceConfig,
  env: Readonly<Record<string, string | undefined>>,
  vm: ReturnType<typeof resolveAgentResourceEnvironment>,
) {
  const warnings = new ResourceConfigWarnings();
  for (const name of vm.rejected) warnings.reject(name);
  const reconcilerTiming = Object.freeze(resolveSyncReconcilerTiming(config, warnings.reject));
  const admission = resolveSyncGlobalBackpressure(config, warnings.reject, env);
  const snapshot = resolveSyncResponderSnapshotDiagnostics(config.syncResponderSnapshotLimits, env);
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.kind === 'rejected') warnings.reject(diagnostic.setting);
    else warnings.clamp(diagnostic.setting);
  }
  const initialSwmPass = Object.freeze(resolveSwmCatchupPassConfig(env, warnings.reject));
  return Object.freeze({ vm, reconcilerTiming, admission, snapshot, initialSwmPass, diagnostics: warnings.snapshot() });
}

export type StartupResourcePolicy = ReturnType<typeof resolveStartupResourcePolicy>;

// Deliberate operator-log fields: adding runtime policy fields must not change
// this schema or require internal state to be JSON-serializable.
const VM_DIAGNOSTIC_FIELDS = [
  'DKG_VM_RECONCILE_INTERVAL_MS',
  'DKG_VM_RECONCILE_BACKOFF_MAX_MS',
  'DKG_VM_RECONCILE_CACHE_MAX_ENTRIES',
  'DKG_VM_RECONCILE_CG_STATE_MAX_ENTRIES',
  'DKG_VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS',
  'DKG_VM_RECONCILE_QUEUE_MAX_PENDING',
  'DKG_VM_RECONCILE_BATCH_SIZE',
  'DKG_VM_RECONCILE_ORDINAL_CONCURRENCY',
  'DKG_VM_RECONCILE_CONCURRENCY',
  'DKG_VM_RECONCILE_MAX_FOREGROUND_BURST',
  'DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS',
  'DKG_RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS',
  'DKG_CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS',
  'DKG_VM_RECONCILE_CONFIRMATION_DEPTH',
  'DKG_CATCHUP_MAX_CONCURRENT_PEERS',
  'DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS',
] as const satisfies readonly (keyof StartupResourcePolicy['vm']['values'])[];

interface ConfiguredPriorityDiagnostics {
  elevated: number;
  default: number;
  deprioritized: number;
}

export interface StartupResourceDiagnostics {
  vm: { values: Record<(typeof VM_DIAGNOSTIC_FIELDS)[number], number>; startupMaxDelayMs: number };
  reconcilerTiming: {
    intervalMs: number; stalenessThresholdMs: number; backoffBaseMs: number; backoffMaxMs: number; backoffJitter: number;
  };
  admission: {
    mode: 'shared' | 'partitioned';
    limit: number | null;
    queueLimit: number | null;
    selectedRecoveryContextGraphCount: number;
    partitions?: {
      fast: { maxInflight: number; queueLimit: number; queueTimeoutMs: number };
      slow: { maxInflight: number; foregroundReserved: number; foregroundQueueLimit: number; backgroundMaxInflight: number; backgroundQueueLimit: number };
    };
  };
  snapshot: { budget: {
    maxRows: number | null; maxBytesEstimate: number | null;
    maxSnapshotRows: number | null; maxSnapshotBytesEstimate: number | null;
  } };
  initialSwmPass: { budgetMs: number; maxPasses: number };
  configuredPriorities: ConfiguredPriorityDiagnostics;
}

/** JSON-safe resolved values, independent of warnings and policy implementation. */
export function projectStartupResourceDiagnostics(
  policy: StartupResourcePolicy,
  priorities: ConfiguredPriorityDiagnostics,
): StartupResourceDiagnostics {
  const { vm, reconcilerTiming, admission, snapshot, initialSwmPass } = policy;
  const values = {} as StartupResourceDiagnostics['vm']['values'];
  for (const field of VM_DIAGNOSTIC_FIELDS) values[field] = vm.values[field];
  const partitions = admission.partitions;
  return {
    vm: { values, startupMaxDelayMs: vm.startupMaxDelayMs },
    reconcilerTiming: {
      intervalMs: reconcilerTiming.intervalMs,
      stalenessThresholdMs: reconcilerTiming.stalenessThresholdMs,
      backoffBaseMs: reconcilerTiming.backoffBaseMs,
      backoffMaxMs: reconcilerTiming.backoffMaxMs,
      backoffJitter: reconcilerTiming.backoffJitter,
    },
    admission: {
      mode: admission.mode,
      limit: admission.limit ?? null,
      queueLimit: admission.queueLimit ?? null,
      selectedRecoveryContextGraphCount: admission.selectedRecoveryContextGraphIds?.length ?? 0,
      ...(partitions ? { partitions: {
        fast: {
          maxInflight: partitions.fast.maxInflight,
          queueLimit: partitions.fast.queueLimit,
          queueTimeoutMs: partitions.fast.queueTimeoutMs,
        },
        slow: {
          maxInflight: partitions.slow.maxInflight,
          foregroundReserved: partitions.slow.foregroundReserved,
          foregroundQueueLimit: partitions.slow.foregroundQueueLimit,
          backgroundMaxInflight: partitions.slow.backgroundMaxInflight,
          backgroundQueueLimit: partitions.slow.backgroundQueueLimit,
        },
      } } : {}),
    },
    snapshot: { budget: {
      maxRows: snapshot.budget.maxRows ?? null,
      maxBytesEstimate: snapshot.budget.maxBytesEstimate ?? null,
      maxSnapshotRows: snapshot.budget.maxSnapshotRows ?? null,
      maxSnapshotBytesEstimate: snapshot.budget.maxSnapshotBytesEstimate ?? null,
    } },
    initialSwmPass: { budgetMs: initialSwmPass.budgetMs, maxPasses: initialSwmPass.maxPasses },
    configuredPriorities: {
      elevated: priorities.elevated, default: priorities.default, deprioritized: priorities.deprioritized,
    },
  };
}
