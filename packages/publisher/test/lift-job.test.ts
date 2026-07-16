import { describe, expect, it } from 'vitest';
import {
  LIFT_JOB_STATES,
  LIFT_JOB_ALLOWED_TRANSITIONS,
  assertLiftJobTransition,
  canTransitionLiftJob,
  getAllowedLiftJobTransitions,
  isTerminalLiftJobState,
} from '../src/lift-job.js';

describe('LiftJob state machine', () => {
  it('defines the expected states in order', () => {
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

  it('allows only forward progression plus failure from active states', () => {
    expect(LIFT_JOB_ALLOWED_TRANSITIONS).toEqual({
      accepted: ['claimed', 'failed'],
      claimed: ['validated', 'failed'],
      validated: ['broadcast', 'finalized', 'failed'],
      broadcast: ['included', 'failed'],
      included: ['finalized', 'failed'],
      finalized: [],
      failed: [],
    });
  });

  it('reports allowed transitions per state', () => {
    expect(getAllowedLiftJobTransitions('accepted')).toEqual(['claimed', 'failed']);
    expect(getAllowedLiftJobTransitions('included')).toEqual(['finalized', 'failed']);
    expect(getAllowedLiftJobTransitions('finalized')).toEqual([]);
  });

  it('treats finalized and failed as terminal', () => {
    expect(isTerminalLiftJobState('finalized')).toBe(true);
    expect(isTerminalLiftJobState('failed')).toBe(true);
    expect(isTerminalLiftJobState('broadcast')).toBe(false);
  });

  it('accepts valid transitions', () => {
    expect(canTransitionLiftJob('accepted', 'claimed')).toBe(true);
    expect(canTransitionLiftJob('claimed', 'validated')).toBe(true);
    expect(canTransitionLiftJob('validated', 'broadcast')).toBe(true);
    expect(canTransitionLiftJob('validated', 'finalized')).toBe(true);
    expect(canTransitionLiftJob('broadcast', 'included')).toBe(true);
    expect(canTransitionLiftJob('included', 'finalized')).toBe(true);
    expect(canTransitionLiftJob('accepted', 'failed')).toBe(true);
    expect(canTransitionLiftJob('included', 'failed')).toBe(true);
  });

  it('rejects skipped, backward, and terminal transitions', () => {
    expect(canTransitionLiftJob('accepted', 'validated')).toBe(false);
    expect(canTransitionLiftJob('broadcast', 'claimed')).toBe(false);
    expect(canTransitionLiftJob('finalized', 'failed')).toBe(false);
    expect(canTransitionLiftJob('failed', 'accepted')).toBe(false);
  });

  it('throws a helpful error for invalid transitions', () => {
    expect(() => assertLiftJobTransition('broadcast', 'finalized')).toThrow(
      'Invalid LiftJob transition: broadcast -> finalized. Allowed: included, failed',
    );
  });
});
