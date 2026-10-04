import type { RegisteredContextGraphAuthorityUnavailableReason } from '@origintrail-official/dkg-agent';
import type { PromoteJob } from '@origintrail-official/dkg-publisher';
import { diagnosticPromoteStage } from '../promote-stage-diagnostics.js';
import { safePromoteErrorIdentity, type ClassifiedPromoteError } from './async-promote-error-classification.js';

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

function safePromoteAuthorityReason(cause: unknown): string | undefined {
  if ((typeof cause !== 'object' && typeof cause !== 'function') || cause === null) {
    return undefined;
  }
  try {
    if (Reflect.get(cause, 'code') !== 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE') return undefined;
    const reason = Reflect.get(cause, 'reason');
    return typeof reason === 'string'
      && Object.hasOwn(SAFE_PROMOTE_AUTHORITY_REASONS, reason)
      ? reason
      : undefined;
  } catch {
    return undefined;
  }
}

function safePromoteAuthorityOrigin(cause: unknown): 'agent-gate-revision' | undefined {
  if ((typeof cause !== 'object' && typeof cause !== 'function') || cause === null) {
    return undefined;
  }
  try {
    if (Reflect.get(cause, 'code') !== 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE'
      || Reflect.get(cause, 'reason') !== 'local-existence-unavailable') return undefined;
    return Reflect.get(cause, 'origin') === 'agent-gate-revision'
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
  log: (message: string) => void;
}): void {
  try {
    // The queue marker hides arbitrary cause text. A typed authority reason is
    // a closed, privacy-bounded value that identifies which prerequisite kept
    // this pre-commit attempt from making progress.
    const cause = input.classified.diagnostic?.code === 'PROMOTE_RETRYABLE_FAILURE'
      && (typeof input.err === 'object' || typeof input.err === 'function')
      && input.err !== null
      ? Reflect.get(input.err, 'cause')
      : undefined;
    const authorityReason = safePromoteAuthorityReason(cause);
    const authorityOrigin = safePromoteAuthorityOrigin(cause);
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
        ...(authorityOrigin === undefined ? {} : { authorityOrigin }),
      })}`,
    );
  } catch {
    // Diagnostics must never prevent fail-closed queue bookkeeping.
  }
}
