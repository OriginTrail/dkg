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
  type LiftJobFailureCode,
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
    expect(LIFT_JOB_FAILURE_CODES).toContain('fee_cap_below_base_fee');
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

  // GH#2270 — the INSTRUMENT for both per-code policy decisions: `autoRetry` (does this node retry
  // the job by itself?) and `provenIneffective` (did its transaction demonstrably do nothing, so
  // the job is not held for chain proof?). Every expected value is written out per code instead of
  // derived from the policy table, so a wrong policy cannot make this row agree with it; and
  // because the actual map is built from LIFT_JOB_FAILURE_CODES, a new code joining the enum fails
  // here instead of silently inheriting either decision.
  const EXPECTED_POLICY_FLAGS: Record<LiftJobFailureCode, { autoRetry: boolean; provenIneffective: boolean }> = {
    workspace_unavailable: { autoRetry: true, provenIneffective: false },
    workspace_slice_not_found: { autoRetry: false, provenIneffective: false },
    publish_intent_stale: { autoRetry: false, provenIneffective: false },
    canonicalization_failed: { autoRetry: false, provenIneffective: false },
    authority_unavailable: { autoRetry: false, provenIneffective: false },
    authority_forbidden: { autoRetry: false, provenIneffective: false },
    validation_timeout: { autoRetry: false, provenIneffective: false },
    wallet_claim_timeout: { autoRetry: false, provenIneffective: false },
    wallet_unavailable: { autoRetry: false, provenIneffective: false },
    quorum_unmet: { autoRetry: true, provenIneffective: false },
    fee_cap_below_base_fee: { autoRetry: true, provenIneffective: false },
    rpc_unavailable: { autoRetry: false, provenIneffective: false },
    tx_submit_timeout: { autoRetry: false, provenIneffective: false },
    tx_reverted: { autoRetry: false, provenIneffective: true },
    insufficient_funds: { autoRetry: false, provenIneffective: true },
    nonce_conflict: { autoRetry: false, provenIneffective: false },
    inclusion_timeout: { autoRetry: false, provenIneffective: false },
    finality_timeout: { autoRetry: false, provenIneffective: false },
    confirmation_mismatch: { autoRetry: false, provenIneffective: false },
    chain_reorg: { autoRetry: false, provenIneffective: false },
    recovery_lookup_timeout: { autoRetry: false, provenIneffective: false },
    recovery_chain_unavailable: { autoRetry: false, provenIneffective: false },
    recovery_state_inconsistent: { autoRetry: false, provenIneffective: false },
  };

  it('allow-lists bounded pre-send retries and proven-ineffective chain effects explicitly', () => {
    const actual = Object.fromEntries(
      LIFT_JOB_FAILURE_CODES.map((code) => [code, {
        autoRetry: getLiftJobFailurePolicy(code).autoRetry === true,
        provenIneffective: getLiftJobFailurePolicy(code).provenIneffective === true,
      }]),
    );

    expect(actual).toEqual(EXPECTED_POLICY_FLAGS);
  });

  // Conditions 2 and 3 of the `autoRetry` qualification (see LiftJobFailurePolicy): an
  // auto-retried job must be re-runnable from the start, with no chain evidence to reconcile.
  it('keeps every autoRetry code retryable and resolvable by reset_to_accepted', () => {
    const autoRetryCodes = LIFT_JOB_FAILURE_CODES.filter(
      (code) => getLiftJobFailurePolicy(code).autoRetry === true,
    );

    expect(autoRetryCodes.length).toBeGreaterThan(0);
    for (const code of autoRetryCodes) {
      const policy = getLiftJobFailurePolicy(code);
      expect([code, policy.retryable, policy.resolution]).toEqual([code, true, 'reset_to_accepted']);
    }
  });

  // Condition 1, structurally, for the code that claims it structurally: `workspace_unavailable`
  // is UNRECORDABLE from either post-send state, so no allow-listed retry can follow a sent
  // transaction. `quorum_unmet` deliberately does NOT hold this property (its allowed state is
  // 'broadcast'); its pre-send guarantee comes from its single producer, not from the enum.
  it('cannot record workspace_unavailable from any post-send state', () => {
    for (const state of ['broadcast', 'included'] as const) {
      expect(() =>
        createLiftJobFailureMetadata({
          failedFromState: state,
          code: 'workspace_unavailable',
          message: 'corrupt head',
          errorPayloadRef: `urn:error:workspace-${state}`,
        }),
      ).toThrow(`Invalid LiftJob failure state for code workspace_unavailable: ${state}`);
    }
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
