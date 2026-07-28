import { describe, expect, it } from 'vitest';
import {
  LIFT_JOB_FAILURE_CODES,
  LIFT_JOB_FAILURE_PHASES,
  LIFT_JOB_FAILURE_MODES,
  LIFT_JOB_TIMEOUT_HANDLINGS,
  createLiftJobFailureMetadata,
  getLiftJobFailurePolicy,
  isRetryableLiftJobFailure,
  isTerminalLiftJobFailure,
  isTimeoutLiftJobFailure,
} from '../src/lift-job.js';

describe('LiftJob failure classification', () => {
  it('defines failure classification primitives', () => {
    expect(LIFT_JOB_FAILURE_PHASES).toEqual([
      'validation',
      'broadcast',
      'confirmation',
      'recovery',
    ]);
    expect(LIFT_JOB_FAILURE_MODES).toEqual(['retryable', 'terminal', 'timeout']);
    expect(LIFT_JOB_TIMEOUT_HANDLINGS).toEqual([
      'reset_to_accepted',
      'fail_job',
      'check_chain_then_finalize_or_reset',
      'retry_recovery',
    ]);
    expect(LIFT_JOB_FAILURE_CODES).toContain('validation_timeout');
    expect(LIFT_JOB_FAILURE_CODES).toContain('tx_submit_timeout');
    expect(LIFT_JOB_FAILURE_CODES).toContain('finality_timeout');
    expect(LIFT_JOB_FAILURE_CODES).toContain('recovery_state_inconsistent');
  });

  it('classifies terminal validation failures as non-retryable', () => {
    const policy = getLiftJobFailurePolicy('authority_forbidden');

    expect(policy.phase).toBe('validation');
    expect(policy.mode).toBe('terminal');
    expect(policy.retryable).toBe(false);
    expect(policy.resolution).toBe('fail_job');
    expect(isTerminalLiftJobFailure('authority_forbidden')).toBe(true);
    expect(isRetryableLiftJobFailure('authority_forbidden')).toBe(false);
  });

  // GH#1786 — `authority_forbidden` became reachable from `broadcast` as a defensive
  // fallback (if a re-wrap hides the marker from the no-send precondition check, the mapper
  // is the last thing between a permanent failure and the retryable rpc_unavailable default).
  // Widening the ALLOWED STATES must not change the reported phase: `phase` is the CONCERN
  // that failed, not a mirror of the state. Author capability is a validation concern from
  // every state, exactly as `wallet_claim_timeout` stays a 'broadcast' concern when raised
  // from 'accepted'. Expected values are written out here rather than derived from the
  // production policy, so a wrong policy cannot make this test agree with it.
  it('keeps authority_forbidden a validation concern from every state it is allowed from', () => {
    for (const state of ['claimed', 'validated', 'broadcast'] as const) {
      const failure = createLiftJobFailureMetadata({
        code: 'authority_forbidden',
        failedFromState: state,
        errorPayloadRef: `urn:error:not-custodial-${state}`,
      });
      expect(failure.failedFromState).toBe(state);
      expect(failure.phase).toBe('validation');
      // Terminal from every origin — the widening is about REACHABILITY, not policy.
      expect(failure.retryable).toBe(false);
      expect(failure.resolution).toBe('fail_job');
    }
    // 'accepted' is still rejected: nothing has tried to sign yet.
    expect(() => createLiftJobFailureMetadata({
      code: 'authority_forbidden',
      failedFromState: 'accepted',
      errorPayloadRef: 'urn:error:not-custodial-accepted',
    })).toThrow(/Invalid LiftJob failure state for code authority_forbidden/);
  });

  // The concern-vs-state distinction, stated on a PRE-EXISTING code so the rule is pinned
  // independently of GH#1786: claiming a wallet is a broadcast concern even when the job is
  // still 'accepted'. A future change that derives phase from the state would break here.
  it('reports the concern phase, not the state phase, for wallet_claim_timeout', () => {
    const failure = createLiftJobFailureMetadata({
      code: 'wallet_claim_timeout',
      failedFromState: 'accepted',
      errorPayloadRef: 'urn:error:wallet-claim',
      timeout: { timeoutMs: 1000, timeoutAt: 1, handling: 'reset_to_accepted' },
    });
    expect(failure.failedFromState).toBe('accepted');
    expect(failure.phase).toBe('broadcast');
  });

  it('classifies ambiguous broadcast timeouts as chain-check recoverable', () => {
    const policy = getLiftJobFailurePolicy('tx_submit_timeout');

    expect(policy.phase).toBe('broadcast');
    expect(policy.mode).toBe('timeout');
    expect(policy.retryable).toBe(true);
    expect(policy.resolution).toBe('check_chain_then_finalize_or_reset');
    expect(policy.timeoutHandling).toBe('check_chain_then_finalize_or_reset');
    expect(isTimeoutLiftJobFailure('tx_submit_timeout')).toBe(true);
  });

  it('classifies confirmation timeouts as chain-aware retry paths', () => {
    const policy = getLiftJobFailurePolicy('finality_timeout');

    expect(policy.phase).toBe('confirmation');
    expect(policy.mode).toBe('timeout');
    expect(policy.retryable).toBe(true);
    expect(policy.timeoutHandling).toBe('check_chain_then_finalize_or_reset');
  });

  it('classifies recovery failures separately from broadcast/confirmation', () => {
    const retryable = getLiftJobFailurePolicy('recovery_chain_unavailable');
    const terminal = getLiftJobFailurePolicy('recovery_state_inconsistent');

    expect(retryable.phase).toBe('recovery');
    expect(retryable.mode).toBe('retryable');
    expect(retryable.resolution).toBe('retry_recovery');
    expect(terminal.phase).toBe('recovery');
    expect(terminal.mode).toBe('terminal');
    expect(terminal.resolution).toBe('fail_job');
  });

  it('derives persisted failure metadata from the classified code', () => {
    const failure = createLiftJobFailureMetadata({
      failedFromState: 'included',
      code: 'finality_timeout',
      message: 'waiting for finality took too long',
      errorPayloadRef: 'urn:error:finality-timeout',
      timeout: {
        timeoutMs: 60000,
        timeoutAt: 123,
        handling: 'check_chain_then_finalize_or_reset',
      },
    });

    expect(failure.phase).toBe('confirmation');
    expect(failure.mode).toBe('timeout');
    expect(failure.retryable).toBe(true);
    expect(failure.resolution).toBe('check_chain_then_finalize_or_reset');
  });

  it('rejects timeout failures without timeout metadata', () => {
    expect(() =>
      createLiftJobFailureMetadata({
        failedFromState: 'included',
        code: 'finality_timeout',
        message: 'waiting for finality took too long',
        errorPayloadRef: 'urn:error:missing-timeout',
      }),
    ).toThrow('Timeout metadata is required for LiftJob failure code finality_timeout');
  });

  it('rejects timeout metadata on non-timeout failures', () => {
    expect(() =>
      createLiftJobFailureMetadata({
        failedFromState: 'broadcast',
        code: 'rpc_unavailable',
        message: 'rpc down',
        errorPayloadRef: 'urn:error:rpc',
        timeout: {
          timeoutMs: 1000,
          timeoutAt: 1,
          handling: 'reset_to_accepted',
        },
      }),
    ).toThrow('Timeout metadata is not allowed for non-timeout LiftJob failure code rpc_unavailable');
  });

  it('rejects mismatched timeout handling', () => {
    expect(() =>
      createLiftJobFailureMetadata({
        failedFromState: 'broadcast',
        code: 'tx_submit_timeout',
        message: 'submit timed out',
        errorPayloadRef: 'urn:error:submit-timeout',
        timeout: {
          timeoutMs: 1000,
          timeoutAt: 1,
          handling: 'reset_to_accepted',
        },
      }),
    ).toThrow(
      'Invalid timeout handling for LiftJob failure code tx_submit_timeout: reset_to_accepted. Expected: check_chain_then_finalize_or_reset',
    );
  });

  it('rejects failure codes that are incompatible with the failed state', () => {
    expect(() =>
      createLiftJobFailureMetadata({
        failedFromState: 'included',
        code: 'validation_timeout',
        message: 'wrong phase',
        errorPayloadRef: 'urn:error:wrong-phase',
        timeout: {
          timeoutMs: 1000,
          timeoutAt: 1,
          handling: 'reset_to_accepted',
        },
      }),
    ).toThrow(
      'Invalid LiftJob failure state for code validation_timeout: included. Allowed: claimed, validated',
    );
  });
});
