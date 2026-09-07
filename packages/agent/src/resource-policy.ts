import {
  ResourceConfigWarnings,
  type resolveAgentResourceEnvironment,
} from './resource-limits.js';
import { resolveSwmCatchupPassConfig } from './sync/catchup-pass-policy.js';
import { resolveSyncGlobalBackpressure, type SyncGlobalBackpressureConfig } from './sync/backpressure.js';
import { resolveSyncReconcilerTiming, type SyncReconcilerTimingConfig } from './sync/reconciler-timing.js';
import { resolveSyncResponderSnapshotPolicy, type SyncResponderSnapshotLimitsConfig } from './sync/responder/snapshot-policy.js';

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
  const resolvedSnapshot = resolveSyncResponderSnapshotPolicy(
    config.syncResponderSnapshotLimits, env, undefined, warnings.reject,
  );
  if (resolvedSnapshot.localRowsClamped) warnings.clamp('syncResponderSnapshotLimits.local.rows');
  if (resolvedSnapshot.localBytesEstimateClamped) warnings.clamp('syncResponderSnapshotLimits.local.bytesEstimate');
  const snapshot = Object.freeze({ ...resolvedSnapshot, budget: Object.freeze(resolvedSnapshot.budget) });
  const initialSwmPass = resolveSwmCatchupPassConfig(env, warnings.reject);
  return Object.freeze({ vm, reconcilerTiming, admission, snapshot, initialSwmPass, diagnostics: warnings.snapshot() });
}

export type StartupResourcePolicy = ReturnType<typeof resolveStartupResourcePolicy>;
