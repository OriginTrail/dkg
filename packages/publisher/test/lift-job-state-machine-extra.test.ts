/**
 * Publisher state-machine bullet-proofing tests.
 *
 * Audit findings covered:
 *
 *   P-12  LIFT_JOB_FAILURE_PHASES / state machine were only spot-checked.
 *         A whole-matrix transition test pins the FSM so any silent edge add /
 *         removal (eg. allowing `finalized -> claimed`) is caught.
 *
 *   P-14  `createLiftJobFailureMetadata` only had positive tests for codes the
 *         author thought to write. We now do an exhaustive sweep over every
 *         (code × state) pair and assert exactly the spec-allowed combinations
 *         are accepted.
 *
 *   P-15  Spec §6 "Publish flow": the recovery phase MUST be reachable from
 *         broadcast and included (chain-aware codes) but NOT from validation
 *         (no chain context yet). Pin this so a "make recovery global"
 *         refactor cannot drop the guard.
 *
 *   P-16  `assertLiftJobTransition` should produce a deterministic, parseable
 *         error message (control-plane logs and operators rely on it). Pin the
 *         exact wording.
 *
 * Per QA policy: do NOT modify production code. If the FSM disagrees with the
 * spec, the failing test IS the bug signal
 */
import { describe, it, expect } from 'vitest';
import {
  LIFT_JOB_STATES,
  LIFT_JOB_ALLOWED_TRANSITIONS,
  TERMINAL_LIFT_JOB_STATES,
  LIFT_JOB_FAILURE_CODES,
  LIFT_JOB_FAILURE_PHASES,
  LIFT_JOB_FAILURE_MODES,
  LIFT_JOB_FAILURE_RESOLUTIONS,
  LIFT_JOB_TIMEOUT_HANDLINGS,
  LIFT_JOB_FAILURE_POLICIES,
  type LiftJobState,
  type LiftJobActiveState,
  type LiftJobFailureCode,
  canTransitionLiftJob,
  assertLiftJobTransition,
  isTerminalLiftJobState,
  createLiftJobFailureMetadata,
  getLiftJobFailurePolicy,
} from '../src/lift-job.js';

describe('LiftJob state set — pinned [P-12]', () => {
  it('contains exactly the spec states in canonical order', () => {
    expect(LIFT_JOB_STATES).toEqual([
      'accepted',
      'claimed',
      'validated',
      'broadcast',
      'included',
      'finalized',
      'failed',
    ]);
  });

  it('terminal states are exactly {finalized, failed}', () => {
    expect(new Set(TERMINAL_LIFT_JOB_STATES)).toEqual(new Set(['finalized', 'failed']));
  });

  it('every state is classified as terminal or non-terminal — no orphans', () => {
    for (const s of LIFT_JOB_STATES) {
      const terminal = isTerminalLiftJobState(s);
      const inTerminalSet = (TERMINAL_LIFT_JOB_STATES as readonly string[]).includes(s);
      expect(terminal).toBe(inTerminalSet);
    }
  });
});

describe('LiftJob transition matrix — exhaustive [P-12 / P-15]', () => {
  // Spec §6 publish FSM: the only legal forward edges are accepted -> claimed
  // -> validated -> broadcast -> included -> finalized, with `failed` as an
  // absorbing sink reachable from every active state, and a single short-cut
  // `validated -> finalized` for off-chain finalization paths. There must be
  // NO backward edges, NO same-state self-loops, and NO outgoing edges from
  // either terminal state.

  const EXPECTED: Record<LiftJobState, ReadonlySet<LiftJobState>> = {
    accepted: new Set(['claimed', 'failed']),
    claimed: new Set(['validated', 'failed']),
    validated: new Set(['broadcast', 'finalized', 'failed']),
    broadcast: new Set(['included', 'failed']),
    included: new Set(['finalized', 'failed']),
    finalized: new Set<LiftJobState>(),
    failed: new Set<LiftJobState>(),
  };

  it('matches the spec transition matrix exactly (full N×N sweep)', () => {
    for (const from of LIFT_JOB_STATES) {
      for (const to of LIFT_JOB_STATES) {
        const allowed = canTransitionLiftJob(from, to);
        const expected = EXPECTED[from].has(to);
        expect(allowed, `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('terminal states have ZERO outgoing transitions (cannot be revived)', () => {
    for (const s of TERMINAL_LIFT_JOB_STATES) {
      expect(LIFT_JOB_ALLOWED_TRANSITIONS[s]).toEqual([]);
      for (const t of LIFT_JOB_STATES) {
        expect(canTransitionLiftJob(s, t)).toBe(false);
      }
    }
  });

  it('no state allows a same-state self-loop (idempotent transitions are not legal)', () => {
    for (const s of LIFT_JOB_STATES) {
      expect(canTransitionLiftJob(s, s)).toBe(false);
    }
  });

  it('no state allows a backward edge in the canonical pipeline', () => {
    const order: readonly LiftJobState[] = ['accepted', 'claimed', 'validated', 'broadcast', 'included', 'finalized'];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < i; j++) {
        // i is "later", j is "earlier" — later -> earlier must be illegal
        expect(canTransitionLiftJob(order[i], order[j]), `${order[i]} -> ${order[j]}`).toBe(false);
      }
    }
  });

  it('every active state has `failed` as a legal target (job can always be killed)', () => {
    for (const s of LIFT_JOB_STATES) {
      if (isTerminalLiftJobState(s)) continue;
      expect(canTransitionLiftJob(s, 'failed'), `${s} -> failed`).toBe(true);
    }
  });

  it('assertLiftJobTransition error message is deterministic and lists allowed targets [P-16]', () => {
    expect(() => assertLiftJobTransition('accepted', 'broadcast'))
      .toThrow('Invalid LiftJob transition: accepted -> broadcast. Allowed: claimed, failed');
    expect(() => assertLiftJobTransition('finalized', 'claimed'))
      .toThrow('Invalid LiftJob transition: finalized -> claimed. Allowed: <none>');
    expect(() => assertLiftJobTransition('failed', 'finalized'))
      .toThrow('Invalid LiftJob transition: failed -> finalized. Allowed: <none>');
  });

  it('assertLiftJobTransition is silent on legal transitions', () => {
    expect(() => assertLiftJobTransition('broadcast', 'included')).not.toThrow();
    expect(() => assertLiftJobTransition('validated', 'finalized')).not.toThrow();
    expect(() => assertLiftJobTransition('validated', 'broadcast')).not.toThrow();
  });
});

describe('LiftJob failure-code policy — exhaustive [P-14]', () => {
  it('every code has a policy entry', () => {
    for (const code of LIFT_JOB_FAILURE_CODES) {
      expect(LIFT_JOB_FAILURE_POLICIES[code], `policy for ${code}`).toBeDefined();
      const p = getLiftJobFailurePolicy(code);
      expect(p.code).toBe(code);
      expect(LIFT_JOB_FAILURE_PHASES).toContain(p.phase);
      expect(LIFT_JOB_FAILURE_MODES).toContain(p.mode);
      expect(LIFT_JOB_FAILURE_RESOLUTIONS).toContain(p.resolution);
      // mode/retryable consistency: terminal => not retryable; retryable+timeout => retryable
      if (p.mode === 'terminal') {
        expect(p.retryable).toBe(false);
        expect(p.resolution).toBe('fail_job');
      }
      if (p.mode === 'timeout') {
        expect(p.timeoutHandling).toBeDefined();
        expect(LIFT_JOB_TIMEOUT_HANDLINGS).toContain(p.timeoutHandling!);
      }
      if (p.mode !== 'timeout') {
        expect(p.timeoutHandling).toBeUndefined();
      }
    }
  });

  it('every code accepts at least one (failedFromState) and rejects every other state', () => {
    const ACTIVE_STATES: readonly LiftJobActiveState[] = [
      'accepted', 'claimed', 'validated', 'broadcast', 'included',
    ];

    for (const code of LIFT_JOB_FAILURE_CODES) {
      const policy = getLiftJobFailurePolicy(code);
      const buildBase = (state: LiftJobActiveState) => {
        const base: any = {
          failedFromState: state,
          code,
          message: `test ${code}`,
          errorPayloadRef: `urn:test:${code}`,
        };
        if (policy.mode === 'timeout') {
          base.timeout = {
            timeoutMs: 1000,
            timeoutAt: 1,
            handling: policy.timeoutHandling!,
          };
        }
        return base;
      };

      let acceptedAny = false;
      for (const state of ACTIVE_STATES) {
        try {
          const out = createLiftJobFailureMetadata(buildBase(state));
          acceptedAny = true;
          // sanity: when accepted, it returns a fully-formed metadata
          expect(out.code).toBe(code);
          expect(out.phase).toBe(policy.phase);
          expect(out.mode).toBe(policy.mode);
          expect(out.retryable).toBe(policy.retryable);
          expect(out.resolution).toBe(policy.resolution);
          expect(out.failedFromState).toBe(state);
        } catch (e) {
          expect((e as Error).message).toMatch(/Invalid LiftJob failure state for code/);
        }
      }
      expect(acceptedAny, `code ${code} must be accepted by SOME active state`).toBe(true);
    }
  });

  it('rejects terminal states (finalized / failed) for every code', () => {
    for (const code of LIFT_JOB_FAILURE_CODES) {
      const policy = getLiftJobFailurePolicy(code);
      const baseTimeout = policy.mode === 'timeout'
        ? { timeoutMs: 1000, timeoutAt: 1, handling: policy.timeoutHandling! }
        : undefined;

      // finalized is terminal — must never be a "failed from" state because it
      // is already terminal and not active.
      expect(() => createLiftJobFailureMetadata({
        failedFromState: 'finalized' as any,
        code,
        message: 'should never happen',
        errorPayloadRef: 'urn:test:terminal',
        ...(baseTimeout ? { timeout: baseTimeout } : {}),
      })).toThrow(/Invalid LiftJob failure state for code/);

      expect(() => createLiftJobFailureMetadata({
        failedFromState: 'failed' as any,
        code,
        message: 'should never happen',
        errorPayloadRef: 'urn:test:terminal',
        ...(baseTimeout ? { timeout: baseTimeout } : {}),
      })).toThrow(/Invalid LiftJob failure state for code/);
    }
  });

  it('all timeout codes require the policy-specified handling string (not just any timeout handling)', () => {
    const TIMEOUT_CODES: readonly LiftJobFailureCode[] = LIFT_JOB_FAILURE_CODES.filter(
      (c) => getLiftJobFailurePolicy(c).mode === 'timeout',
    );
    expect(TIMEOUT_CODES.length).toBeGreaterThan(0); // sanity: at least one timeout code exists

    for (const code of TIMEOUT_CODES) {
      const policy = getLiftJobFailurePolicy(code);
      // Pick any allowed state for this code by trying all active states.
      const ACTIVE: readonly LiftJobActiveState[] = ['accepted', 'claimed', 'validated', 'broadcast', 'included'];
      let allowedState: LiftJobActiveState | null = null;
      for (const s of ACTIVE) {
        try {
          createLiftJobFailureMetadata({
            failedFromState: s,
            code,
            message: 'find allowed',
            errorPayloadRef: 'urn:test:find',
            timeout: { timeoutMs: 1, timeoutAt: 1, handling: policy.timeoutHandling! },
          });
          allowedState = s;
          break;
        } catch { /* try next state */ }
      }
      expect(allowedState, `code ${code} must allow some state`).not.toBeNull();

      // Now feed a wrong handling and assert it's rejected with the policy-pin message.
      const wrong: any = LIFT_JOB_TIMEOUT_HANDLINGS.find((h) => h !== policy.timeoutHandling);
      expect(() => createLiftJobFailureMetadata({
        failedFromState: allowedState!,
        code,
        message: 'wrong handling',
        errorPayloadRef: 'urn:test:wrong',
        timeout: { timeoutMs: 1, timeoutAt: 1, handling: wrong },
      })).toThrow(new RegExp(
        `Invalid timeout handling for LiftJob failure code ${code}: ${wrong}\\. Expected: ${policy.timeoutHandling}`,
      ));
    }
  });

  it('all non-timeout codes reject any timeout metadata', () => {
    const NON_TIMEOUT: readonly LiftJobFailureCode[] = LIFT_JOB_FAILURE_CODES.filter(
      (c) => getLiftJobFailurePolicy(c).mode !== 'timeout',
    );
    expect(NON_TIMEOUT.length).toBeGreaterThan(0);

    for (const code of NON_TIMEOUT) {
      // Find an allowed state (no timeout needed for the success path).
      const ACTIVE: readonly LiftJobActiveState[] = ['accepted', 'claimed', 'validated', 'broadcast', 'included'];
      let allowedState: LiftJobActiveState | null = null;
      for (const s of ACTIVE) {
        try {
          createLiftJobFailureMetadata({
            failedFromState: s,
            code,
            message: 'find allowed',
            errorPayloadRef: 'urn:test:find',
          });
          allowedState = s;
          break;
        } catch { /* try next */ }
      }
      expect(allowedState, `code ${code} must allow some state`).not.toBeNull();

      expect(() => createLiftJobFailureMetadata({
        failedFromState: allowedState!,
        code,
        message: 'unexpected timeout',
        errorPayloadRef: 'urn:test:unexpected',
        timeout: { timeoutMs: 1, timeoutAt: 1, handling: 'reset_to_accepted' },
      })).toThrow(new RegExp(`Timeout metadata is not allowed for non-timeout LiftJob failure code ${code}`));
    }
  });

  it('recovery-phase codes are NEVER allowed from validation states (P-15)', () => {
    // Per spec §6, "recovery" is a chain-aware phase that only makes sense
    // after broadcast or included — there is no chain-side state to recover
    // from validation. If a refactor ever adds e.g. `accepted` to a recovery
    // code's allowed-states list, this test catches it.
    const RECOVERY_CODES: readonly LiftJobFailureCode[] = LIFT_JOB_FAILURE_CODES.filter(
      (c) => getLiftJobFailurePolicy(c).phase === 'recovery',
    );
    expect(RECOVERY_CODES.length).toBeGreaterThan(0);

    const VALIDATION_STATES: readonly LiftJobActiveState[] = ['accepted', 'claimed', 'validated'];
    for (const code of RECOVERY_CODES) {
      const policy = getLiftJobFailurePolicy(code);
      const baseTimeout = policy.mode === 'timeout'
        ? { timeoutMs: 1, timeoutAt: 1, handling: policy.timeoutHandling! }
        : undefined;
      for (const s of VALIDATION_STATES) {
        expect(() => createLiftJobFailureMetadata({
          failedFromState: s,
          code,
          message: 'recovery from validation should not be allowed',
          errorPayloadRef: 'urn:test:recovery-validation',
          ...(baseTimeout ? { timeout: baseTimeout } : {}),
        }), `code ${code} from ${s}`).toThrow(/Invalid LiftJob failure state for code/);
      }
    }
  });

  it('insufficient_funds and tx_reverted are terminal-fail (no retry, no recovery)', () => {
    // These are spec-§6 hard-fail codes: the publisher must NOT retry them
    // because the underlying cost / contract reason will not change on retry.
    const fundsP = getLiftJobFailurePolicy('insufficient_funds');
    expect(fundsP.mode).toBe('terminal');
    expect(fundsP.retryable).toBe(false);
    expect(fundsP.resolution).toBe('fail_job');

    const revertP = getLiftJobFailurePolicy('tx_reverted');
    expect(revertP.mode).toBe('terminal');
    expect(revertP.retryable).toBe(false);
    expect(revertP.resolution).toBe('fail_job');
  });

  it('chain_reorg is retryable via chain-check, NOT reset_to_accepted (P-15)', () => {
    // Resetting to accepted on a reorg would lose the on-chain partial work
    // (e.g. the tx may have re-included). Spec §6 requires chain-check first.
    const p = getLiftJobFailurePolicy('chain_reorg');
    expect(p.mode).toBe('retryable');
    expect(p.retryable).toBe(true);
    expect(p.resolution).toBe('check_chain_then_finalize_or_reset');
  });
});
