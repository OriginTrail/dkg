import {
  LegacyKnowledgeAssetReadOnlyError,
  createOperationContext,
  type Logger,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  isStoreOperationTimeoutError,
  isStoreSchedulerBusyError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  createKnowledgeAssetVmPublishSnapshotMetadata,
  createKnowledgeAssetVmPublishSnapshotRequest,
  resolveLiftWorkspaceSlice,
  validateLiftPublishPayload,
  type KnowledgeAssetVmPublishRequest,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';

interface SnapshotPreflightDependencies {
  store: TripleStore;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  log: Pick<Logger, 'warn' | 'debug'>;
  request: KnowledgeAssetVmPublishRequest;
}

/** Verify the immutable share before any VM publish job is admitted. */
export async function preflightKnowledgeAssetVmPublishSnapshot(
  input: SnapshotPreflightDependencies,
): Promise<void> {
  const { store, publicSnapshotStore, request } = input;
  const startedAt = performance.now();
  const snapshot = createKnowledgeAssetVmPublishSnapshotRequest(request);
  const snapshotMetadata = createKnowledgeAssetVmPublishSnapshotMetadata(request);
  try {
    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager: new GraphManager(store),
      request: snapshot,
      publicSnapshotStore,
    });
    validateLiftPublishPayload({ request: snapshot, metadata: snapshotMetadata, resolved });
    if (resolved.quads.length === 0 && (resolved.privateQuads ?? []).length === 0) {
      throw new Error(
        `No queued shared-memory snapshot quads for context graph ${request.contextGraphId} ` +
          `share operation ${request.shareOperationId}`,
      );
    }
  } catch (err) {
    const failure = classifySnapshotPreflightFailure(err);
    recordSnapshotPreflightFailure(input, failure, performance.now() - startedAt);
    // A failed read proves nothing about snapshot validity. Preserve the typed
    // store failure so admission can retry the same immutable share after recovery.
    if (failure.classification !== 'stale') throw err;
    const wrapped = new Error(
      `Cannot enqueue VM publish for "${request.name}" because share snapshot ` +
        `${request.shareOperationId} is unavailable or stale. Re-share the knowledge asset before enqueueing: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    (wrapped as Error & { code?: string }).code = 'PUBLISH_INTENT_STALE';
    throw wrapped;
  }
}

function classifySnapshotPreflightFailure(error: unknown) {
  if (error instanceof LegacyKnowledgeAssetReadOnlyError) {
    return { classification: 'legacy_read_only', code: 'LEGACY_KA_READ_ONLY' } as const;
  }
  if (isStoreSchedulerBusyError(error)) {
    return {
      classification: 'store_busy', code: 'STORE_SCHEDULER_BUSY', outcome: 'not_started',
      reason: error.reason, lane: error.priority,
    } as const;
  }
  if (isStoreOperationTimeoutError(error)) {
    return {
      classification: 'store_timeout', code: 'STORE_OPERATION_TIMEOUT',
      outcome: error.outcome ?? 'indeterminate',
    } as const;
  }
  return { classification: 'stale', code: 'PUBLISH_INTENT_STALE' } as const;
}

type SnapshotPreflightFailure = ReturnType<typeof classifySnapshotPreflightFailure>;

const PRESSURE_FIELDS = [
  'ackInflight', 'healthInflight', 'normalInflight', 'backgroundInflight',
  'ackQueued', 'healthQueued', 'normalQueued', 'backgroundQueued',
  'maxConcurrent', 'ackReservedSlots', 'normalReservedSlots',
  'healthReservedSlots', 'backgroundReservedSlots',
] as const;

/** Payload-free, best-effort attribution for the read-only admission boundary. */
function recordSnapshotPreflightFailure(
  input: Pick<SnapshotPreflightDependencies, 'store' | 'log'>,
  failure: SnapshotPreflightFailure,
  elapsedMs: number,
): void {
  try {
    const diagnostic: Record<string, unknown> = {
      event: 'vm_publish_snapshot_preflight_rejected',
      phase: 'snapshot_preflight',
      ...failure,
      ...(Number.isFinite(elapsedMs) && elapsedMs >= 0
        ? { elapsedMs: Math.round(elapsedMs) } : {}),
    };

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
    if (failure.classification === 'store_busy' || failure.classification === 'store_timeout') {
      input.log.warn(ctx, JSON.stringify(diagnostic));
    } else {
      input.log.debug(ctx, JSON.stringify(diagnostic));
    }
  } catch {
    // Pressure providers and logger sinks must never change the admission error.
  }
}
