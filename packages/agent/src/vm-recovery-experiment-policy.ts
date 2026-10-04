// SPDX-License-Identifier: Apache-2.0
import { resolveVmRecoveryPrefetchEnabled, VM_RECOVERY_PREPARATION_LIMITS, type VmRecoveryPreparationLimits } from './vm-recovery-preparation.js';

export type VmRecoveryAuthorityRetryPolicy =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'spaced'; readonly minIntervalMs: number };

/** Resolve the bundled experiment once; owner presence is not a policy switch. */
export function resolveVmRecoveryExperimentPolicy(configValue?: boolean, limits: Readonly<VmRecoveryPreparationLimits> = VM_RECOVERY_PREPARATION_LIMITS) {
  const enabled = resolveVmRecoveryPrefetchEnabled(configValue);
  return Object.freeze({
    prefetchEnabled: enabled,
    sharePassAuthorityEvidence: enabled,
    authorityRetry: Object.freeze(enabled
      ? { kind: 'spaced' as const, minIntervalMs: limits.authorityRetryMinIntervalMs }
      : { kind: 'disabled' as const }),
    sizing: enabled ? Object.freeze({
      sizingReadConcurrency: limits.planningReadConcurrency,
      sizingReadTimeoutMs: limits.planningReadTimeoutMs,
    }) : undefined,
  });
}
