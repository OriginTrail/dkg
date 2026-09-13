import {
  ResourceConfigWarnings,
  ownedResourceEnvNames,
  type AgentResourceSnapshots,
  type OwnedResourceEnvName,
} from './resource-limits.js';
import { resolveSwmCatchupPassConfig } from './sync/catchup-pass-policy.js';
import { resolveSyncGlobalBackpressure, type SyncGlobalBackpressureConfig } from './sync/backpressure.js';
import { resolveSyncReconcilerTiming, type SyncReconcilerTimingConfig } from './sync/reconciler-timing.js';
import { resolveSyncResponderSnapshotDiagnostics, type SyncResponderSnapshotLimitsConfig } from './sync/responder/snapshot-policy.js';

interface StartupResourceConfig extends SyncGlobalBackpressureConfig, SyncReconcilerTimingConfig {
  syncResponderSnapshotLimits?: SyncResponderSnapshotLimitsConfig;
}

/**
 * Resolve immutable startup data and diagnostics from the explicit owner
 * snapshots the composition root captured; no owner is resolved implicitly.
 */
export function resolveStartupResourcePolicy(
  config: StartupResourceConfig,
  env: Readonly<Record<string, string | undefined>>,
  { vm, catchup }: AgentResourceSnapshots,
) {
  const warnings = new ResourceConfigWarnings();
  for (const name of vm.rejected) warnings.reject(name);
  for (const name of catchup.rejected) warnings.reject(name);
  const reconcilerTiming = Object.freeze(resolveSyncReconcilerTiming(config, warnings.reject));
  const admission = resolveSyncGlobalBackpressure(config, warnings.reject, env);
  const snapshot = resolveSyncResponderSnapshotDiagnostics(config.syncResponderSnapshotLimits, env);
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.kind === 'rejected') warnings.reject(diagnostic.setting);
    else warnings.clamp(diagnostic.setting);
  }
  const initialSwmPass = Object.freeze(resolveSwmCatchupPassConfig(env, warnings.reject));
  return Object.freeze({ vm, catchup, reconcilerTiming, admission, snapshot, initialSwmPass, diagnostics: warnings.snapshot() });
}

export type StartupResourcePolicy = ReturnType<typeof resolveStartupResourcePolicy>;

// Deliberate operator-log fields, chosen by each setting's diagnostic flag in
// the resource descriptor: adding runtime policy fields must not change this
// schema or require internal state to be JSON-serializable.
const VM_DIAGNOSTIC_FIELDS = ownedResourceEnvNames('vm', true);
const CATCHUP_DIAGNOSTIC_FIELDS = ownedResourceEnvNames('catchup', true);

interface ConfiguredPriorityDiagnostics {
  elevated: number;
  default: number;
  deprioritized: number;
}

export interface StartupResourceDiagnostics {
  vm: { values: Record<OwnedResourceEnvName<'vm', true>, number>; startupMaxDelayMs: number };
  catchup: { values: Record<OwnedResourceEnvName<'catchup', true>, number> };
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
  const { vm, catchup, reconcilerTiming, admission, snapshot, initialSwmPass } = policy;
  const values = {} as StartupResourceDiagnostics['vm']['values'];
  for (const field of VM_DIAGNOSTIC_FIELDS) values[field] = vm.values[field];
  const catchupValues = {} as StartupResourceDiagnostics['catchup']['values'];
  for (const field of CATCHUP_DIAGNOSTIC_FIELDS) catchupValues[field] = catchup.values[field];
  const partitions = admission.partitions;
  return {
    vm: { values, startupMaxDelayMs: vm.startupMaxDelayMs },
    catchup: { values: catchupValues },
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
