import type {
  ContextGraphAuthorityFailureSite,
  RegisteredContextGraphAuthorityUnavailableReason,
} from '@origintrail-official/dkg-agent';
import type { PromoteJob } from '@origintrail-official/dkg-publisher';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { diagnosticPromoteStage } from '../promote-stage-diagnostics.js';
import {
  safePromoteErrorIdentity,
  safePromoteRetryCauseCode,
  type ClassifiedPromoteError,
} from './async-promote-error-classification.js';
import type { PromoteWorkerSyncLogger } from './async-promote-worker.js';

const SAFE_PROMOTE_AUTHORITY_REASONS = Object.freeze({
  'finalized-name-absence-unaccepted': true,
  'chain-name-binding-unavailable': true,
  'authority-circuit-open': true,
  'local-chain-binding-unavailable': true,
  'local-existence-unavailable': true,
  'chain-access-policy-unavailable': true,
  'chain-access-policy-timeout': true,
  'chain-access-policy-unknown': true,
  'chain-participant-authority-unsupported': true,
  'chain-participant-authority-unavailable': true,
  'chain-participant-authority-invalid': true,
  'rfc64-private-read-roster-unavailable': true,
} as const satisfies Record<RegisteredContextGraphAuthorityUnavailableReason
  | 'rfc64-private-read-roster-unavailable', true>);

/**
 * Which check of the recipient stability loop raised an authority failure
 * (GH#3067): the same closed set the agent exports as a type. Free text such as
 * `detail` stays out of the log; it can carry RPC error text.
 */
const SAFE_PROMOTE_AUTHORITY_SITES = Object.freeze({
  'transport-unavailable': true,
  'transport-changed': true,
  'revision-moved': true,
  'recipient-set-changed': true,
} as const satisfies Record<ContextGraphAuthorityFailureSite, true>);

/** A string field of an authority error, only when it is a member of a closed set. */
function safePromoteAuthorityToken(
  cause: unknown,
  field: 'reason' | 'site',
  allowed: object,
): string | undefined {
  if ((typeof cause !== 'object' && typeof cause !== 'function') || cause === null) {
    return undefined;
  }
  try {
    if (Reflect.get(cause, 'code') !== 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE') return undefined;
    const value = Reflect.get(cause, field);
    return typeof value === 'string' && Object.hasOwn(allowed, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

type PromoteStoreFailure =
  | 'queue_wait'
  | 'queue_full'
  | 'store_timeout_not_started'
  | 'store_timeout_indeterminate';

/**
 * A raw store failure behind an attempt (a scheduler rejection or a store
 * deadline) from the storage package's own guards, so the log names it instead of
 * `unknown`. Closed tokens only; the error's message and operation never leave.
 */
function safePromoteStoreFailure(error: unknown): PromoteStoreFailure | undefined {
  try {
    if (isStoreSchedulerBusyError(error)) {
      return error.reason === 'queue_full' ? 'queue_full' : 'queue_wait';
    }
    if (isStoreOperationTimeoutError(error)) {
      return error.outcome === 'not_started' ? 'store_timeout_not_started' : 'store_timeout_indeterminate';
    }
  } catch {
    // A hostile getter never changes the queue bookkeeping.
  }
  return undefined;
}

function safePromoteAuthorityOrigin(cause: unknown): 'agent-gate-revision' | undefined {
  if ((typeof cause !== 'object' && typeof cause !== 'function') || cause === null) {
    return undefined;
  }
  try {
    if (Reflect.get(cause, 'code') !== 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE'
      || Reflect.get(cause, 'reason') !== 'local-existence-unavailable') return undefined;
    const detail = Reflect.get(cause, 'detail');
    return typeof detail === 'string'
      && detail.endsWith(' metadata authority changed while resolving its agent gate')
      ? 'agent-gate-revision'
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Emit privacy-bounded evidence before queue.fail() makes a terminal row
 * externally clearable. Diagnostics are best-effort and can never change the
 * promote state transition: the logger is the normalized one, which contains
 * a sink that throws or rejects, and the catch below covers building the
 * diagnostic itself.
 */
export function logPromoteAttemptFailure(input: {
  job: PromoteJob;
  err: unknown;
  message: string;
  classified: ClassifiedPromoteError;
  promoteStarted: boolean;
  log: PromoteWorkerSyncLogger;
}): void {
  try {
    // The queue marker hides arbitrary cause text. A typed authority reason or
    // retry cause code is a closed, privacy-bounded value that identifies which
    // prerequisite kept this pre-commit attempt from making progress.
    const cause = input.classified.diagnostic?.code === 'PROMOTE_RETRYABLE_FAILURE'
      && (typeof input.err === 'object' || typeof input.err === 'function')
      && input.err !== null
      ? Reflect.get(input.err, 'cause')
      : undefined;
    const authorityReason = safePromoteAuthorityToken(cause, 'reason', SAFE_PROMOTE_AUTHORITY_REASONS);
    const authoritySite = safePromoteAuthorityToken(cause, 'site', SAFE_PROMOTE_AUTHORITY_SITES);
    const storeFailure = safePromoteStoreFailure(input.err) ?? safePromoteStoreFailure(cause);
    const authorityOrigin = safePromoteAuthorityOrigin(cause);
    const causeCode = safePromoteRetryCauseCode(cause);
    input.log(
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
        errorName: input.classified.diagnostic?.name
          ?? safePromoteErrorIdentity(input.err, 'name')
          ?? 'unknown',
        errorCode: input.classified.diagnostic?.code
          ?? safePromoteErrorIdentity(input.err, 'code')
          ?? 'unknown',
        ...(authorityReason === undefined ? {} : { authorityReason }),
        ...(authoritySite === undefined ? {} : { authoritySite }),
        ...(storeFailure === undefined ? {} : { storeFailure }),
        ...(authorityOrigin === undefined ? {} : { authorityOrigin }),
        ...(causeCode === undefined ? {} : { causeCode }),
      })}`,
    );
  } catch {
    // Diagnostics must never prevent fail-closed queue bookkeeping.
  }
}
