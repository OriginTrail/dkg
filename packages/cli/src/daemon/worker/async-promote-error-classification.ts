// SPDX-License-Identifier: Apache-2.0

import { RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS_CODE } from '@origintrail-official/dkg-core';
import {
  isReadOnlyStoreOperation,
  isStoreOperationTimeoutError,
  StoreSchedulerBusyError, isStoreReadTransportFailure,
} from '@origintrail-official/dkg-storage';
import {
  getPromoteFailureDisposition,
  CuratorUnconfirmedError, CuratorRejectedError,
  type PromoteFailureDisposition,
  type PromoteFailureClassification,
} from '@origintrail-official/dkg-publisher';
import { untagPromoteMessage } from '../promote-stage-diagnostics.js';

// Keep the publisher's discriminated union intact. Legacy prose/store results
// cannot claim a publisher diagnostic with a contradictory queue disposition.
export type ClassifiedPromoteError = (
  | PromoteFailureDisposition
  | {
      classification: PromoteFailureClassification;
      retryable: boolean;
      diagnostic?: never;
    }
) & { message?: string };

// Three closed sets guard this boundary, under two deliberately different
// ownership rules. A promote STAGE is by construction a producer-owned literal
// — it only exists as an argument the publisher passes to `tagPromoteStep` —
// so the publisher owns that set and the CLI narrows through its
// `isPromoteStepName` predicate. That narrowing lives in
// `../promote-stage-diagnostics.ts`, which the synchronous routes share.
// An error NAME or CODE can originate anywhere upstream, including in a
// caller-influenced throw, so those two sets stay locally owned below and are
// never widened by a producer-side change.
//
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

// The causes whose code may be named beside a retryable promote: an explicit
// allowlist of shared contract codes (dkg-core), never a shape test.
const SAFE_PROMOTE_RETRY_CAUSE_CODES = Object.freeze({
  [RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS_CODE]: true,
} as const);

export function safePromoteRetryCauseCode(cause: unknown): string | undefined {
  if ((typeof cause !== 'object' && typeof cause !== 'function') || cause === null) return undefined;
  try {
    const value = Reflect.get(cause, 'code');
    return typeof value === 'string' && Object.hasOwn(SAFE_PROMOTE_RETRY_CAUSE_CODES, value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a promote error to a queue disposition. Unknown errors fail closed so an
 * operator can inspect and explicitly recover them.
 */
export function classifyPromoteError(err: unknown, options: { boundRecovery?: boolean } = {}): ClassifiedPromoteError {
  return options.boundRecovery ? classifyBoundRecovery(err) : classifyLegacyPromote(err);
}

const fatal = (): ClassifiedPromoteError => ({ classification: 'fatal', retryable: false });
const transient = (): ClassifiedPromoteError => ({ classification: 'transient', retryable: true });

/** Unlimited ownership accepts typed replay safety; arbitrary prose never grants retries. */
function classifyBoundRecovery(err: unknown): ClassifiedPromoteError {
  if (err instanceof CuratorRejectedError) return fatal();
  if (err instanceof CuratorUnconfirmedError) return transient();
  const publisher = getPromoteFailureDisposition(err);
  if (publisher) return publisher;
  if (isStoreReadTransportFailure(err)) return transient();
  return classifyPayloadCap(errorText(err)) ?? classifyScheduledStore(err) ?? fatal();
}

/** Preserve historical cap precedence and bounded message fallbacks for ordinary jobs. */
function classifyLegacyPromote(err: unknown): ClassifiedPromoteError {
  if (err instanceof CuratorRejectedError) return fatal();
  const publisher = getPromoteFailureDisposition(err);
  if (publisher) return publisher;
  const text = errorText(err);
  const cap = classifyPayloadCap(text);
  if (cap) return cap;
  const store = classifyScheduledStore(err);
  if (store) return store;
  if (isStoreReadTransportFailure(err)) return transient();
  const { code, message } = text;
  if (code === 'store_operation_timeout' || code === 'store_scheduler_busy'
    || message.includes('managed oxigraph') || message.includes('store scheduler')) return fatal();
  return ['fetch failed', 'econnreset', 'econnrefused', 'etimedout', 'socket hang up',
    'network', 'timeout', 'timed out'].some(fragment => message.includes(fragment)) ? transient() : fatal();
}

function errorText(err: unknown): { code: string; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  return { message: untagPromoteMessage(raw ?? '').toLowerCase(),
    code: err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code ?? '').toLowerCase() : '' };
}

function classifyPayloadCap({ code, message }: ReturnType<typeof errorText>): ClassifiedPromoteError | undefined {
  if (code === 'swm_gossip_payload_too_large' || code === 'payload_too_large'
    || (message.includes('gossip') && (message.includes('limit') || message.includes('too large')))
    || message.includes('promoted assertion too large') || message.includes('request body too large')
    || message.includes('payload too large')) return { classification: 'cap_exceeded', retryable: false };
  return undefined;
}

function classifyScheduledStore(err: unknown): ClassifiedPromoteError | undefined {
  if (isStoreOperationTimeoutError(err)) {
    // Indeterminate writes remain fail-closed without a producer's replay-safe disposition.
    return err.outcome === 'not_started' || (err.outcome === 'indeterminate'
      && err.storeOperation !== undefined && isReadOnlyStoreOperation(err.storeOperation)) ? transient() : fatal();
  }
  return err instanceof StoreSchedulerBusyError ? transient() : undefined;
}
