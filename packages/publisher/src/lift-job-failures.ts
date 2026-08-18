import type { LiftJobActiveState } from './lift-job-states.js';

export const LIFT_JOB_FAILURE_PHASES = [
  'validation',
  'broadcast',
  'confirmation',
  'recovery',
] as const;

export type LiftJobFailurePhase = (typeof LIFT_JOB_FAILURE_PHASES)[number];

export const LIFT_JOB_FAILURE_MODES = ['retryable', 'terminal', 'timeout'] as const;

export type LiftJobFailureMode = (typeof LIFT_JOB_FAILURE_MODES)[number];

export const LIFT_JOB_TIMEOUT_HANDLINGS = [
  'reset_to_accepted',
  'fail_job',
  'check_chain_then_finalize_or_reset',
  'retry_recovery',
] as const;

export type LiftJobTimeoutHandling = (typeof LIFT_JOB_TIMEOUT_HANDLINGS)[number];

export const LIFT_JOB_FAILURE_RESOLUTIONS = [
  'reset_to_accepted',
  'fail_job',
  'check_chain_then_finalize_or_reset',
  'retry_recovery',
] as const;

export type LiftJobFailureResolution = (typeof LIFT_JOB_FAILURE_RESOLUTIONS)[number];

export const LIFT_JOB_FAILURE_CODES = [
  'workspace_unavailable',
  'workspace_slice_not_found',
  'publish_intent_stale',
  'canonicalization_failed',
  'authority_unavailable',
  'authority_forbidden',
  'validation_timeout',
  'wallet_claim_timeout',
  'wallet_unavailable',
  'quorum_unmet',
  'rpc_unavailable',
  'tx_submit_timeout',
  'tx_reverted',
  'insufficient_funds',
  'nonce_conflict',
  'inclusion_timeout',
  'finality_timeout',
  'confirmation_mismatch',
  'chain_reorg',
  'recovery_lookup_timeout',
  'recovery_chain_unavailable',
  'recovery_state_inconsistent',
] as const;

export type LiftJobFailureCode = (typeof LIFT_JOB_FAILURE_CODES)[number];

export interface LiftJobTimeoutMetadata {
  readonly timeoutMs: number;
  readonly timeoutAt: number;
  readonly handling: LiftJobTimeoutHandling;
}

export interface LiftJobFailurePolicy {
  readonly code: LiftJobFailureCode;
  /**
   * The CONCERN this failure belongs to, NOT a mirror of `failedFromState`. Several codes are
   * legitimately raised from a state in a different phase — `wallet_claim_timeout` is allowed
   * from 'accepted'/'claimed' yet labelled 'broadcast', because claiming a wallet is a
   * broadcast concern; `wallet_unavailable` likewise from 'claimed'. Clients read `phase` to
   * learn WHICH CONCERN failed and `failedFromState` to learn where the job stopped; deriving
   * one from the other would collapse two different questions into one.
   */
  readonly phase: LiftJobFailurePhase;
  readonly mode: LiftJobFailureMode;
  readonly retryable: boolean;
  readonly resolution: LiftJobFailureResolution;
  /**
   * Opt-in to the publisher's own bounded, jittered retry lane
   * (`isAutomaticallyRetryable` → `scheduleRetryIfEligible` + the claim-time sweep).
   *
   * QUALIFICATION — a code may set this only when ALL THREE hold:
   *   1. NO transaction can have been accepted when the failure is recorded. For
   *      `workspace_unavailable` this is STRUCTURAL: every state in
   *      `LIFT_JOB_FAILURE_ALLOWED_STATES` is pre-send and `createLiftJobFailureMetadata`
   *      throws on the others, so the guarantee is enforced, not documented. For
   *      `quorum_unmet` it comes from the PRODUCER's position instead — its allowed state is
   *      'broadcast', but ACK quorum is collected before the publish tx is signed, so the
   *      error cannot follow a send. A code whose pre-send-ness rests on the producer must
   *      have exactly one, narrowly-typed producer (`QuorumUnmetError`); a catch-all never
   *      qualifies this way.
   *   2. the cause is UNAMBIGUOUS — the failure cannot also be produced by a landed
   *      transaction whose local recording failed, so a re-run can never double-publish.
   *   3. `resolution` is 'reset_to_accepted' — the job is completable by re-running it from
   *      the start, with no chain evidence to reconcile first.
   * `quorum_unmet` (GH#1620) and `workspace_unavailable` (GH#2270) are the only codes that
   * qualify today. The field is optional on this PUBLIC interface (external
   * constructors keep compiling) but REQUIRED on every built-in table entry
   * via `BuiltInLiftJobFailurePolicy`: `autoRetry: false` is an explicit
   * policy decision (manual-only), never an omission a reader must interpret.
   *
   * EXCLUDED, and why — `rpc_unavailable`/`nonce_conflict`/`wallet_unavailable` are allowed
   * from 'broadcast' with no pre-send producer guarantee, and `rpc_unavailable` is additionally
   * the broadcast-phase CATCH-ALL, so a transaction that landed and merely failed to record
   * locally arrives under that code (violates 1 and 2); `tx_submit_timeout`/`inclusion_timeout`/
   * `finality_timeout`/`chain_reorg` resolve via `check_chain_then_finalize_or_reset`, which has
   * no dispatcher yet (violates 3); terminal codes are not retryable at all; codes with no
   * production producer (annotated below) stay off regardless, since no end-to-end witness
   * could cover the flag.
   */
  readonly autoRetry?: boolean;
  /**
   * GH#2270 — does this failure PROVE the transaction it may have carried had no effect?
   *
   * A failed job that persisted a transaction hash is normally HELD: no path republishes it, it
   * keeps its KA's lifecycle subject, and bulk cleanup leaves it alone, because re-running it
   * could publish the same Knowledge Asset twice. `true` is the ONLY way out of that hold short of
   * chain recovery, so it must rest on a guarantee rather than on a plausible reading of the code:
   *
   *   - `tx_reverted` — the publish mapper assigns it for an actual revert. The receipt exists and
   *     says the transaction changed nothing, so a re-run cannot double-publish.
   *   - `insufficient_funds` — a DEFINITIVE pre-acceptance reject (see
   *     `isDefinitivePreAcceptanceSendFailure`): the node refused the transaction before it entered
   *     the mempool. The #1851 pre-send write-ahead may already have persisted a hash for that
   *     attempt, and this is what lets an operator top the wallet up and re-submit instead of
   *     waiting for proof that cannot arrive.
   *
   * Everything else is `false`, including every timeout and `confirmation_mismatch`, whose whole
   * meaning is that the local view and the chain disagree. Like `autoRetry` the field is optional
   * on this PUBLIC interface (external constructors keep compiling) but REQUIRED on every built-in
   * entry via `BuiltInLiftJobFailurePolicy`, so a new code must state its chain effect instead of
   * inheriting one by omission.
   */
  readonly provenIneffective?: boolean;
  readonly timeoutHandling?: LiftJobTimeoutHandling;
}

export interface LiftJobFailureMetadata {
  readonly failedFromState: LiftJobActiveState;
  readonly phase: LiftJobFailurePhase;
  readonly mode: LiftJobFailureMode;
  readonly retryable: boolean;
  readonly resolution: LiftJobFailureResolution;
  readonly code: LiftJobFailureCode;
  readonly message: string;
  readonly errorPayloadRef: string;
  readonly stackTraceRef?: string;
  readonly rpcResponseRef?: string;
  readonly revertReasonRef?: string;
  readonly timeout?: LiftJobTimeoutMetadata;
}

/**
 * Table-only strictness: the PUBLIC interface keeps `autoRetry` and `provenIneffective` optional
 * (required fields would source-break external constructors of `LiftJobFailurePolicy`), while every
 * BUILT-IN entry must declare both decisions explicitly — `false` is a policy statement, never an
 * omission. A 23rd code cannot be added without answering "does this retry itself?" and "did its
 * transaction have no effect?".
 */
export type BuiltInLiftJobFailurePolicy = LiftJobFailurePolicy & {
  readonly autoRetry: boolean;
  readonly provenIneffective: boolean;
};

export const LIFT_JOB_FAILURE_POLICIES: Record<LiftJobFailureCode, BuiltInLiftJobFailurePolicy> = {
  // autoRetry: pre-send by allowed-states (enforced), transient by cause (a
  // corrupt/unreadable SWM head that sync repair heals) — see the field doc.
  workspace_unavailable: { code: 'workspace_unavailable', phase: 'validation', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted', provenIneffective: false, autoRetry: true },
  workspace_slice_not_found: { code: 'workspace_slice_not_found', phase: 'validation', mode: 'terminal', retryable: false, resolution: 'fail_job', provenIneffective: false, autoRetry: false },
  publish_intent_stale: { code: 'publish_intent_stale', phase: 'validation', mode: 'terminal', retryable: false, resolution: 'fail_job', provenIneffective: false, autoRetry: false },
  canonicalization_failed: { code: 'canonicalization_failed', phase: 'validation', mode: 'terminal', retryable: false, resolution: 'fail_job', provenIneffective: false, autoRetry: false },
  // No production producer (dead-code sweep is a recorded follow-up); autoRetry
  // stays off until a producer exists to witness it.
  authority_unavailable: { code: 'authority_unavailable', phase: 'validation', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted', provenIneffective: false, autoRetry: false },
  authority_forbidden: { code: 'authority_forbidden', phase: 'validation', mode: 'terminal', retryable: false, resolution: 'fail_job', provenIneffective: false, autoRetry: false },
  // DEAD CODE — no production producer; see the dead-code follow-up.
  validation_timeout: { code: 'validation_timeout', phase: 'validation', mode: 'timeout', retryable: true, resolution: 'reset_to_accepted', timeoutHandling: 'reset_to_accepted', provenIneffective: false, autoRetry: false },
  // DEAD CODE — no production producer; see the dead-code follow-up.
  wallet_claim_timeout: { code: 'wallet_claim_timeout', phase: 'broadcast', mode: 'timeout', retryable: true, resolution: 'reset_to_accepted', timeoutHandling: 'reset_to_accepted', provenIneffective: false, autoRetry: false },
  // DEAD CODE — no production producer; see the dead-code follow-up.
  wallet_unavailable: { code: 'wallet_unavailable', phase: 'broadcast', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted', provenIneffective: false, autoRetry: false },
  quorum_unmet: { code: 'quorum_unmet', phase: 'broadcast', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted', provenIneffective: false, autoRetry: true },
  rpc_unavailable: { code: 'rpc_unavailable', phase: 'broadcast', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted', provenIneffective: false, autoRetry: false },
  tx_submit_timeout: { code: 'tx_submit_timeout', phase: 'broadcast', mode: 'timeout', retryable: true, resolution: 'check_chain_then_finalize_or_reset', timeoutHandling: 'check_chain_then_finalize_or_reset', provenIneffective: false, autoRetry: false },
  // provenIneffective: the receipt exists and reports failure — the transaction published nothing.
  tx_reverted: { code: 'tx_reverted', phase: 'broadcast', mode: 'terminal', retryable: false, resolution: 'fail_job', provenIneffective: true, autoRetry: false },
  // provenIneffective: a DEFINITIVE pre-acceptance reject — the node refused it before the mempool.
  insufficient_funds: { code: 'insufficient_funds', phase: 'broadcast', mode: 'terminal', retryable: false, resolution: 'fail_job', provenIneffective: true, autoRetry: false },
  nonce_conflict: { code: 'nonce_conflict', phase: 'broadcast', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted', provenIneffective: false, autoRetry: false },
  // DEAD CODE — no production producer; see the dead-code follow-up.
  inclusion_timeout: { code: 'inclusion_timeout', phase: 'confirmation', mode: 'timeout', retryable: true, resolution: 'check_chain_then_finalize_or_reset', timeoutHandling: 'check_chain_then_finalize_or_reset', provenIneffective: false, autoRetry: false },
  finality_timeout: { code: 'finality_timeout', phase: 'confirmation', mode: 'timeout', retryable: true, resolution: 'check_chain_then_finalize_or_reset', timeoutHandling: 'check_chain_then_finalize_or_reset', provenIneffective: false, autoRetry: false },
  confirmation_mismatch: { code: 'confirmation_mismatch', phase: 'confirmation', mode: 'terminal', retryable: false, resolution: 'fail_job', provenIneffective: false, autoRetry: false },
  chain_reorg: { code: 'chain_reorg', phase: 'confirmation', mode: 'retryable', retryable: true, resolution: 'check_chain_then_finalize_or_reset', provenIneffective: false, autoRetry: false },
  recovery_lookup_timeout: { code: 'recovery_lookup_timeout', phase: 'recovery', mode: 'timeout', retryable: true, resolution: 'retry_recovery', timeoutHandling: 'retry_recovery', provenIneffective: false, autoRetry: false },
  // DEAD CODE — no production producer; see the dead-code follow-up.
  recovery_chain_unavailable: { code: 'recovery_chain_unavailable', phase: 'recovery', mode: 'retryable', retryable: true, resolution: 'retry_recovery', provenIneffective: false, autoRetry: false },
  recovery_state_inconsistent: { code: 'recovery_state_inconsistent', phase: 'recovery', mode: 'terminal', retryable: false, resolution: 'fail_job', provenIneffective: false, autoRetry: false },
};

const LIFT_JOB_FAILURE_ALLOWED_STATES: Record<LiftJobFailureCode, readonly LiftJobActiveState[]> = {
  workspace_unavailable: ['accepted', 'claimed', 'validated'],
  workspace_slice_not_found: ['accepted', 'claimed', 'validated'],
  publish_intent_stale: ['claimed', 'validated'],
  canonicalization_failed: ['claimed', 'validated'],
  authority_unavailable: ['claimed', 'validated'],
  // GH#1786 — also reachable from 'broadcast': the executor discovers mid-publish, before
  // any transaction is sent, that it cannot re-sign the UpdateAuthorAttestation for this
  // author. That is an authority failure rather than a transport one, and it is PERMANENT,
  // so it must be able to fail the job terminally from the broadcast state instead of
  // falling through to the retryable `rpc_unavailable` default.
  authority_forbidden: ['claimed', 'validated', 'broadcast'],
  validation_timeout: ['claimed', 'validated'],
  wallet_claim_timeout: ['accepted', 'claimed'],
  wallet_unavailable: ['claimed', 'broadcast'],
  quorum_unmet: ['broadcast'],
  rpc_unavailable: ['broadcast'],
  tx_submit_timeout: ['broadcast'],
  // GH#2270 — also reachable from 'included': the proof-first dispatcher re-records this code on a
  // held job once the chain resolves its transaction to a failure receipt, and a job that had
  // already recorded an inclusion reaches that state when a reorg replaces its transaction. The
  // pre-send states stay excluded — a job that failed before signing has no transaction of its own
  // to revert, and the dispatcher releases that one by reset instead.
  tx_reverted: ['broadcast', 'included'],
  insufficient_funds: ['broadcast'],
  nonce_conflict: ['broadcast'],
  inclusion_timeout: ['broadcast', 'included'],
  finality_timeout: ['included'],
  confirmation_mismatch: ['broadcast', 'included'],
  chain_reorg: ['broadcast', 'included'],
  recovery_lookup_timeout: ['broadcast', 'included'],
  recovery_chain_unavailable: ['broadcast', 'included'],
  recovery_state_inconsistent: ['broadcast', 'included'],
};

export function getLiftJobFailurePolicy(code: LiftJobFailureCode): BuiltInLiftJobFailurePolicy {
  return LIFT_JOB_FAILURE_POLICIES[code];
}

export function createLiftJobFailureMetadata(
  params: Omit<LiftJobFailureMetadata, 'phase' | 'mode' | 'retryable' | 'resolution'>,
): LiftJobFailureMetadata {
  const policy = getLiftJobFailurePolicy(params.code);
  const allowedStates = LIFT_JOB_FAILURE_ALLOWED_STATES[params.code];

  if (!allowedStates.includes(params.failedFromState)) {
    throw new Error(
      `Invalid LiftJob failure state for code ${params.code}: ${params.failedFromState}. Allowed: ${allowedStates.join(', ')}`,
    );
  }

  if (policy.mode === 'timeout') {
    if (!params.timeout) {
      throw new Error(`Timeout metadata is required for LiftJob failure code ${params.code}`);
    }
    if (!policy.timeoutHandling) {
      throw new Error(`Timeout handling is not configured for LiftJob failure code ${params.code}`);
    }
    if (params.timeout.handling !== policy.timeoutHandling) {
      throw new Error(
        `Invalid timeout handling for LiftJob failure code ${params.code}: ${params.timeout.handling}. Expected: ${policy.timeoutHandling}`,
      );
    }
  } else if (params.timeout) {
    throw new Error(`Timeout metadata is not allowed for non-timeout LiftJob failure code ${params.code}`);
  }

  return {
    ...params,
    phase: policy.phase,
    mode: policy.mode,
    retryable: policy.retryable,
    resolution: policy.resolution,
  };
}

export function isRetryableLiftJobFailure(code: LiftJobFailureCode): boolean {
  return getLiftJobFailurePolicy(code).retryable;
}

export function isTerminalLiftJobFailure(code: LiftJobFailureCode): boolean {
  return getLiftJobFailurePolicy(code).mode === 'terminal';
}

export function isTimeoutLiftJobFailure(code: LiftJobFailureCode): boolean {
  return getLiftJobFailurePolicy(code).mode === 'timeout';
}
