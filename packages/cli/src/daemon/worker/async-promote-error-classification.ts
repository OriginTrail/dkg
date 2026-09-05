import { isChainRpcTransportError } from '@origintrail-official/dkg-chain';
import {
  isReadOnlyStoreOperation,
  isStoreOperationTimeoutError,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  getPromoteReplaySafeErrorDiagnostic,
  isPromoteReplaySafeError,
  type PromoteFailureClassification,
  type PromoteJob,
} from '@origintrail-official/dkg-publisher';

import type { PromoteWorkerLogger } from './async-promote-worker.js';

export type ClassifiedPromoteError = {
  classification: PromoteFailureClassification;
  retryable: boolean;
  message?: string;
};

const PROMOTE_STEP_TAG = /^\[promote:([^\]]*)\]\s*/;
const PROMOTE_DIAGNOSTIC_STAGES = new Set([
  'ensureSubGraphRegistered',
  'assertGraphScopedLifecycleWritable',
  'knowledgeAssetPrivateQuads',
  'assertionScopedQuads',
  'assertTrustedCatalogTriplesAllowed',
  'encodeWorkspaceGossipPayload',
]);
const SAFE_ERROR_NAMES = new Set([
  'Error',
  'DKGError',
  'DKGUserError',
  'DKGInternalError',
  'PayloadTooLargeError',
  'SwmGossipPayloadTooLargeError',
  'CuratorUnconfirmedError',
  'CuratorRejectedError',
  'AssertionNotPersistedError',
]);
const SAFE_ERROR_CODES = new Set([
  'PAYLOAD_TOO_LARGE',
  'SWM_GOSSIP_PAYLOAD_TOO_LARGE',
  'CURATOR_UNCONFIRMED',
  'CURATOR_REJECTED',
  'ASSERTION_NOT_PERSISTED',
  'RPC_ENDPOINTS_EXHAUSTED',
  'RPC_RECEIPT_LOOKUP_FAILED',
  'RPC_TIMEOUT',
]);

function untagPromoteMessage(message: string): string {
  return message.replace(PROMOTE_STEP_TAG, '');
}

function diagnosticPromoteStage(message: string): string {
  const candidate = PROMOTE_STEP_TAG.exec(message)?.[1];
  return candidate !== undefined && PROMOTE_DIAGNOSTIC_STAGES.has(candidate)
    ? candidate
    : 'unknown';
}

function safeErrorIdentity(
  err: unknown,
  field: 'name' | 'code',
  allowed: ReadonlySet<string>,
): string | undefined {
  if ((typeof err !== 'object' && typeof err !== 'function') || err === null) return undefined;
  try {
    const value = Reflect.get(err, field);
    return typeof value === 'string' && allowed.has(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function bestEffortLog(log: PromoteWorkerLogger, message: string): void {
  try {
    void Promise.resolve(log(message)).catch(() => {});
  } catch {
    // Logging must never delay or alter queue state transitions.
  }
}

/** Emit privacy-bounded evidence before a failed attempt becomes clearable. */
export function logPromoteAttemptFailure(input: {
  job: PromoteJob;
  err: unknown;
  message: string;
  classified: ClassifiedPromoteError;
  promoteStarted: boolean;
  log: PromoteWorkerLogger;
}): void {
  try {
    const replaySafeDiagnostic = getPromoteReplaySafeErrorDiagnostic(input.err);
    bestEffortLog(
      input.log,
      `[async-promote-worker] ${JSON.stringify({
        event: 'async_promote_attempt_failed',
        schemaVersion: 1,
        jobId: input.job.jobId,
        attempt: input.job.attempt.count,
        maxAttempts: input.job.attempt.maxRetries,
        promoteStartedMarkerPersisted: input.promoteStarted,
        swmCommitObserved: false,
        stage: diagnosticPromoteStage(input.message),
        classification: input.classified.classification,
        retryable: input.classified.retryable,
        errorName: replaySafeDiagnostic?.name
          ?? safeErrorIdentity(input.err, 'name', SAFE_ERROR_NAMES)
          ?? 'unknown',
        errorCode: replaySafeDiagnostic?.code
          ?? safeErrorIdentity(input.err, 'code', SAFE_ERROR_CODES)
          ?? 'unknown',
      })}`,
    );
  } catch {
    // Diagnostics must never prevent fail-closed queue bookkeeping.
  }
}

/** Map a promote failure to its durable queue retry disposition. */
export function classifyPromoteError(err: unknown): ClassifiedPromoteError {
  if (isPromoteReplaySafeError(err)) {
    return { classification: 'transient', retryable: true };
  }

  const raw = err instanceof Error ? err.message : String(err);
  const message = untagPromoteMessage(raw ?? '').toLowerCase();
  const code = err && typeof err === 'object' && 'code' in err
    ? String((err as { code?: unknown }).code ?? '').toLowerCase()
    : '';

  if (isChainRpcTransportError(err)) {
    return { classification: 'fatal', retryable: false };
  }
  if (
    code === 'swm_gossip_payload_too_large'
    || code === 'payload_too_large'
    || (message.includes('gossip') && (message.includes('limit') || message.includes('too large')))
    || message.includes('promoted assertion too large')
  ) {
    return { classification: 'cap_exceeded', retryable: false };
  }
  if (message.includes('request body too large') || message.includes('payload too large')) {
    return { classification: 'cap_exceeded', retryable: false };
  }
  if (isStoreOperationTimeoutError(err)) {
    if (
      err.outcome === 'not_started'
      || (
        err.outcome === 'indeterminate'
        && err.storeOperation !== undefined
        && isReadOnlyStoreOperation(err.storeOperation)
      )
    ) {
      return { classification: 'transient', retryable: true };
    }
    return { classification: 'fatal', retryable: false };
  }
  if (err instanceof StoreSchedulerBusyError) {
    return { classification: 'transient', retryable: true };
  }
  if (
    code === 'store_operation_timeout'
    || code === 'store_scheduler_busy'
    || message.includes('managed oxigraph')
    || message.includes('store scheduler')
  ) {
    return { classification: 'fatal', retryable: false };
  }
  if (
    message.includes('fetch failed')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('etimedout')
    || message.includes('socket hang up')
    || message.includes('network')
    || message.includes('timeout')
    || message.includes('timed out')
  ) {
    return { classification: 'transient', retryable: true };
  }
  return { classification: 'fatal', retryable: false };
}
