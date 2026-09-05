// SPDX-License-Identifier: Apache-2.0

import {
  isReadOnlyStoreOperation,
  isStoreOperationTimeoutError,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  isPromoteReplaySafeError,
  isPromoteRetryableFailure,
  type PromoteFailureClassification,
} from '@origintrail-official/dkg-publisher';

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

// Only producer-owned, source-defined identities are safe to retain verbatim.
// Arbitrary upstream name/code strings can be credentials even when they are
// syntactically simple, so everything outside these closed sets becomes unknown.
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
]);

function untagPromoteMessage(message: string): string {
  return message.replace(PROMOTE_STEP_TAG, '');
}

export function diagnosticPromoteStage(message: string): string {
  const candidate = PROMOTE_STEP_TAG.exec(message)?.[1];
  return candidate !== undefined && PROMOTE_DIAGNOSTIC_STAGES.has(candidate)
    ? candidate
    : 'unknown';
}

export function safePromoteErrorIdentity(
  err: unknown,
  field: 'name' | 'code',
): string | undefined {
  if ((typeof err !== 'object' && typeof err !== 'function') || err === null) return undefined;
  try {
    const value = Reflect.get(err, field);
    const allowed = field === 'name' ? SAFE_ERROR_NAMES : SAFE_ERROR_CODES;
    return typeof value === 'string' && allowed.has(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a promote error to a queue disposition. Unknown errors fail closed so an
 * operator can inspect and explicitly recover them.
 */
export function classifyPromoteError(err: unknown): ClassifiedPromoteError {
  // Workflow-level replay safety is a typed producer disposition. It is more
  // authoritative than diagnostic prose inherited from the wrapped cause,
  // including incidental cap-like wording.
  if (isPromoteReplaySafeError(err)) {
    return { classification: 'transient', retryable: true };
  }
  if (isPromoteRetryableFailure(err)) {
    return { classification: 'transient', retryable: true };
  }

  const raw = err instanceof Error ? err.message : String(err);
  // Strip a leading diagnostic tag before substring classification. A step
  // label must not inject a classifier keyword into the producer's message.
  const untagged = untagPromoteMessage(raw ?? '');
  const message = untagged.toLowerCase();
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code ?? '').toLowerCase()
      : '';

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

  // Managed-store recovery can declare the exact operation outcome. A request
  // rejected before dispatch is safe to retry, and interrupted reads cannot
  // have mutated WM/SWM. Every interrupted write remains fail-closed unless
  // the producer supplied the typed replay-safe disposition above.
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
