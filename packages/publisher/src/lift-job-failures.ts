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
  'canonicalization_failed',
  'authority_unavailable',
  'authority_forbidden',
  'validation_timeout',
  'wallet_claim_timeout',
  'wallet_unavailable',
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
  readonly phase: LiftJobFailurePhase;
  readonly mode: LiftJobFailureMode;
  readonly retryable: boolean;
  readonly resolution: LiftJobFailureResolution;
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

export const LIFT_JOB_FAILURE_POLICIES: Record<LiftJobFailureCode, LiftJobFailurePolicy> = {
  workspace_unavailable: { code: 'workspace_unavailable', phase: 'validation', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted' },
  workspace_slice_not_found: { code: 'workspace_slice_not_found', phase: 'validation', mode: 'terminal', retryable: false, resolution: 'fail_job' },
  canonicalization_failed: { code: 'canonicalization_failed', phase: 'validation', mode: 'terminal', retryable: false, resolution: 'fail_job' },
  authority_unavailable: { code: 'authority_unavailable', phase: 'validation', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted' },
  authority_forbidden: { code: 'authority_forbidden', phase: 'validation', mode: 'terminal', retryable: false, resolution: 'fail_job' },
  validation_timeout: { code: 'validation_timeout', phase: 'validation', mode: 'timeout', retryable: true, resolution: 'reset_to_accepted', timeoutHandling: 'reset_to_accepted' },
  wallet_claim_timeout: { code: 'wallet_claim_timeout', phase: 'broadcast', mode: 'timeout', retryable: true, resolution: 'reset_to_accepted', timeoutHandling: 'reset_to_accepted' },
  wallet_unavailable: { code: 'wallet_unavailable', phase: 'broadcast', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted' },
  rpc_unavailable: { code: 'rpc_unavailable', phase: 'broadcast', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted' },
  tx_submit_timeout: { code: 'tx_submit_timeout', phase: 'broadcast', mode: 'timeout', retryable: true, resolution: 'check_chain_then_finalize_or_reset', timeoutHandling: 'check_chain_then_finalize_or_reset' },
  tx_reverted: { code: 'tx_reverted', phase: 'broadcast', mode: 'terminal', retryable: false, resolution: 'fail_job' },
  insufficient_funds: { code: 'insufficient_funds', phase: 'broadcast', mode: 'terminal', retryable: false, resolution: 'fail_job' },
  nonce_conflict: { code: 'nonce_conflict', phase: 'broadcast', mode: 'retryable', retryable: true, resolution: 'reset_to_accepted' },
  inclusion_timeout: { code: 'inclusion_timeout', phase: 'confirmation', mode: 'timeout', retryable: true, resolution: 'check_chain_then_finalize_or_reset', timeoutHandling: 'check_chain_then_finalize_or_reset' },
  finality_timeout: { code: 'finality_timeout', phase: 'confirmation', mode: 'timeout', retryable: true, resolution: 'check_chain_then_finalize_or_reset', timeoutHandling: 'check_chain_then_finalize_or_reset' },
  confirmation_mismatch: { code: 'confirmation_mismatch', phase: 'confirmation', mode: 'terminal', retryable: false, resolution: 'fail_job' },
  chain_reorg: { code: 'chain_reorg', phase: 'confirmation', mode: 'retryable', retryable: true, resolution: 'check_chain_then_finalize_or_reset' },
  recovery_lookup_timeout: { code: 'recovery_lookup_timeout', phase: 'recovery', mode: 'timeout', retryable: true, resolution: 'retry_recovery', timeoutHandling: 'retry_recovery' },
  recovery_chain_unavailable: { code: 'recovery_chain_unavailable', phase: 'recovery', mode: 'retryable', retryable: true, resolution: 'retry_recovery' },
  recovery_state_inconsistent: { code: 'recovery_state_inconsistent', phase: 'recovery', mode: 'terminal', retryable: false, resolution: 'fail_job' },
};

const LIFT_JOB_FAILURE_ALLOWED_STATES: Record<LiftJobFailureCode, readonly LiftJobActiveState[]> = {
  workspace_unavailable: ['accepted', 'claimed', 'validated'],
  workspace_slice_not_found: ['accepted', 'claimed', 'validated'],
  canonicalization_failed: ['claimed', 'validated'],
  authority_unavailable: ['claimed', 'validated'],
  authority_forbidden: ['claimed', 'validated'],
  validation_timeout: ['claimed', 'validated'],
  wallet_claim_timeout: ['accepted', 'claimed'],
  wallet_unavailable: ['claimed', 'broadcast'],
  rpc_unavailable: ['broadcast'],
  tx_submit_timeout: ['broadcast'],
  tx_reverted: ['broadcast'],
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

export function getLiftJobFailurePolicy(code: LiftJobFailureCode): LiftJobFailurePolicy {
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
