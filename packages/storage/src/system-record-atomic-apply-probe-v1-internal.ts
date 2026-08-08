import {
  isManagedOxigraphOwnershipLeaseV1,
  type ManagedOxigraphOwnershipLeaseV1,
} from './managed-oxigraph-ownership-v1-internal.js';
import type { SystemRecordLaneExecutionBindingV1 } from './system-record-materializer-v1.js';

const SYSTEM_RECORD_ATOMIC_APPLY_PROBE_OPTION_V1: unique symbol = Symbol(
  'dkg.systemRecordAtomicApplyProbeV1',
);

export interface SystemRecordAtomicApplyProbeV1 {
  observe(binding: SystemRecordLaneExecutionBindingV1): void;
}

/** Attach a process-local probe to options carrying the exact authentic ownership lease. */
export function attachSystemRecordAtomicApplyProbeForTestsV1<
  T extends Record<string | symbol, unknown>,
>(
  options: T,
  lease: ManagedOxigraphOwnershipLeaseV1,
  probe: SystemRecordAtomicApplyProbeV1,
): T {
  if (!isManagedOxigraphOwnershipLeaseV1(lease)) {
    throw new Error('system-record atomic apply probe requires an authentic ownership lease');
  }
  return {
    ...options,
    [SYSTEM_RECORD_ATOMIC_APPLY_PROBE_OPTION_V1]: Object.freeze({ lease, probe }),
  };
}

export function extractSystemRecordAtomicApplyProbeV1(
  options: unknown,
  lease: ManagedOxigraphOwnershipLeaseV1 | null,
): SystemRecordAtomicApplyProbeV1 | null {
  if (lease === null || typeof options !== 'object' || options === null) return null;
  const candidate = (options as Record<symbol, unknown>)[SYSTEM_RECORD_ATOMIC_APPLY_PROBE_OPTION_V1];
  if (typeof candidate !== 'object' || candidate === null) return null;
  const entry = candidate as { readonly lease?: unknown; readonly probe?: unknown };
  if (entry.lease !== lease || typeof entry.probe !== 'object' || entry.probe === null) return null;
  const probe = entry.probe as Partial<SystemRecordAtomicApplyProbeV1>;
  return typeof probe.observe === 'function' ? (probe as SystemRecordAtomicApplyProbeV1) : null;
}
