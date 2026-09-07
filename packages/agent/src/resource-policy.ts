import {
  ResourceConfigWarnings,
  type resolveAgentResourceEnvironment,
} from './resource-limits.js';
import { resolveSwmCatchupPassConfig } from './sync/catchup-pass-policy.js';
import { resolveSyncGlobalBackpressure, type SyncGlobalBackpressureConfig } from './sync/backpressure.js';
import { resolveSyncReconcilerTiming, type SyncReconcilerTimingConfig } from './sync/reconciler-timing.js';
import { resolveSyncResponderSnapshotPolicy } from './sync/responder/sync-handler.js';

interface StartupResourceConfig extends SyncGlobalBackpressureConfig, SyncReconcilerTimingConfig {
  syncResponderSnapshotLimits?: Parameters<typeof resolveSyncResponderSnapshotPolicy>[0];
}

/**
 * Resolve executable startup policy and its diagnostics together. The caller
 * supplies the process-scoped VM snapshot explicitly; importing a parser alone
 * cannot initialize it. SWM jobs use the startup policy while their settings
 * are unchanged; changed settings are resolved quietly at the next job boundary.
 */
export function resolveStartupResourcePolicy(
  config: StartupResourceConfig,
  env: Readonly<Record<string, string | undefined>>,
  vm: ReturnType<typeof resolveAgentResourceEnvironment>,
) {
  const warnings = new ResourceConfigWarnings();
  for (const name of vm.rejected) warnings.reject(name);
  const reconcilerTiming = Object.freeze(resolveSyncReconcilerTiming(config, warnings.reject));
  const admission = resolveSyncGlobalBackpressure(config, warnings.reject, env);
  const resolvedSnapshot = resolveSyncResponderSnapshotPolicy(
    config.syncResponderSnapshotLimits, env, undefined, warnings.reject,
  );
  if (resolvedSnapshot.localRowsClamped) warnings.clamp('syncResponderSnapshotLimits.local.rows');
  if (resolvedSnapshot.localBytesEstimateClamped) warnings.clamp('syncResponderSnapshotLimits.local.bytesEstimate');
  const snapshot = Object.freeze({ ...resolvedSnapshot, budget: Object.freeze(resolvedSnapshot.budget) });
  const swmEnvironment = Object.freeze({
    DKG_SWM_CATCHUP_PASS_BUDGET_MS: env.DKG_SWM_CATCHUP_PASS_BUDGET_MS,
    DKG_SWM_CATCHUP_MAX_PASSES: env.DKG_SWM_CATCHUP_MAX_PASSES,
  });
  const swmPass = Object.freeze(resolveSwmCatchupPassConfig(swmEnvironment, warnings.reject));
  const swmPassForJob = (jobEnv: typeof env = process.env) => (
    jobEnv.DKG_SWM_CATCHUP_PASS_BUDGET_MS === swmEnvironment.DKG_SWM_CATCHUP_PASS_BUDGET_MS
    && jobEnv.DKG_SWM_CATCHUP_MAX_PASSES === swmEnvironment.DKG_SWM_CATCHUP_MAX_PASSES
      ? swmPass
      : Object.freeze(resolveSwmCatchupPassConfig(jobEnv))
  );
  const partitions = admission.mode === 'partitioned' && admission.limit !== undefined ? admission.partitions : undefined;
  const summary = Object.freeze({
    vmReconcileLimits: vm.values,
    swmCatchupPassAtStartup: swmPass,
    vmReconcileStartupMaxDelayMs: vm.startupMaxDelayMs,
    syncReconcilerTiming: reconcilerTiming,
    syncAdmissionMode: admission.mode,
    snapshotGlobalRows: snapshot.budget.maxRows,
    snapshotGlobalBytesEstimate: snapshot.budget.maxBytesEstimate,
    snapshotLocalRows: snapshot.budget.maxSnapshotRows,
    snapshotLocalBytesEstimate: snapshot.budget.maxSnapshotBytesEstimate,
    syncGlobalInflightLimit: admission.limit ?? 0,
    syncGlobalQueueLimit: admission.queueLimit ?? 0,
    syncFastInflightLimit: partitions?.fast.maxInflight,
    syncFastQueueLimit: partitions?.fast.queueLimit,
    syncSlowInflightLimit: partitions?.slow.maxInflight,
    syncSlowForegroundReserved: partitions?.slow.foregroundReserved,
    syncSlowForegroundQueueLimit: partitions?.slow.foregroundQueueLimit,
    syncSlowBackgroundInflightLimit: partitions?.slow.backgroundMaxInflight,
    syncSlowBackgroundQueueLimit: partitions?.slow.backgroundQueueLimit,
    snapshotLocalClamped: snapshot.localRowsClamped || snapshot.localBytesEstimateClamped,
  });
  return Object.freeze({ vm, reconcilerTiming, admission, snapshot, swmPassForJob, summary, diagnostics: warnings.snapshot() });
}

export type StartupResourcePolicy = ReturnType<typeof resolveStartupResourcePolicy>;
