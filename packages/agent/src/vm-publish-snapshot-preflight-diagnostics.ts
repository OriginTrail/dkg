import {
  LegacyKnowledgeAssetReadOnlyError,
  createOperationContext,
  type Logger,
} from '@origintrail-official/dkg-core';
import {
  isStoreOperationTimeoutError,
  isStoreSchedulerBusyError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

const PRESSURE_FIELDS = [
  'ackInflight', 'healthInflight', 'normalInflight', 'backgroundInflight',
  'ackQueued', 'healthQueued', 'normalQueued', 'backgroundQueued',
  'maxConcurrent', 'ackReservedSlots', 'normalReservedSlots',
  'healthReservedSlots', 'backgroundReservedSlots',
] as const;

/** Payload-free, best-effort attribution for the read-only admission boundary. */
export function recordVmPublishSnapshotPreflightFailure(input: {
  store: Pick<TripleStore, 'getPressureSnapshot'>;
  log: Pick<Logger, 'warn' | 'debug'>;
  error: unknown;
  elapsedMs: number;
}): void {
  try {
    const busy = isStoreSchedulerBusyError(input.error);
    const timeout = isStoreOperationTimeoutError(input.error);
    const legacy = input.error instanceof LegacyKnowledgeAssetReadOnlyError;
    const diagnostic: Record<string, unknown> = {
      event: 'vm_publish_snapshot_preflight_rejected',
      phase: 'snapshot_preflight',
      classification: busy ? 'store_busy' : timeout ? 'store_timeout' : legacy ? 'legacy_read_only' : 'stale',
      code: busy ? 'STORE_SCHEDULER_BUSY' : timeout ? 'STORE_OPERATION_TIMEOUT'
        : legacy ? 'LEGACY_KA_READ_ONLY' : 'PUBLISH_INTENT_STALE',
      ...(Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0
        ? { elapsedMs: Math.round(input.elapsedMs) } : {}),
    };
    if (isStoreSchedulerBusyError(input.error)) {
      diagnostic.outcome = 'not_started';
      diagnostic.reason = input.error.reason;
      diagnostic.lane = input.error.priority;
    } else if (isStoreOperationTimeoutError(input.error)) {
      diagnostic.outcome = input.error.outcome ?? 'indeterminate';
    }

    const snapshot = input.store.getPressureSnapshot?.();
    if (snapshot) {
      const pressure: Record<string, number> = {};
      for (const field of PRESSURE_FIELDS) {
        const value = snapshot[field];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          pressure[field] = value;
        }
      }
      diagnostic.pressure = pressure;
    }
    const ctx = createOperationContext('publishFromSWM');
    if (busy || timeout) input.log.warn(ctx, JSON.stringify(diagnostic));
    else input.log.debug(ctx, JSON.stringify(diagnostic));
  } catch {
    // Pressure providers and logger sinks must never change the admission error.
  }
}
