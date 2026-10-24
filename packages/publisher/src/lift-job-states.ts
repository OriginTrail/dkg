export const LIFT_JOB_STATES = [
  'accepted',
  'claimed',
  'validated',
  'broadcast',
  'included',
  'finalized',
  'failed',
] as const;

export type LiftJobState = (typeof LIFT_JOB_STATES)[number];

export const LIFT_TRANSITION_TYPES = ['CREATE', 'MUTATE', 'REVOKE'] as const;

export type LiftTransitionType = (typeof LIFT_TRANSITION_TYPES)[number];

export const LIFT_AUTHORITY_TYPES = ['owner', 'multisig', 'quorum', 'capability'] as const;

export type LiftAuthorityType = (typeof LIFT_AUTHORITY_TYPES)[number];

export const TERMINAL_LIFT_JOB_STATES = ['finalized', 'failed'] as const;

export type TerminalLiftJobState = (typeof TERMINAL_LIFT_JOB_STATES)[number];

export type LiftJobActiveState = Exclude<LiftJobState, TerminalLiftJobState>;

export type LiftRecoverableJobState = Extract<LiftJobState, 'claimed' | 'validated' | 'broadcast' | 'included'>;

/**
 * The origin states a reset-to-accepted recovery can record. GH#2270 — `included` joined the
 * set: an `included`-origin failure carries a transaction hash, and dropping the origin dropped
 * that hash with it (the reset rebuilds the job from scratch). Recording the origin is what
 * preserves the evidence; it does NOT make such a job freely republishable — every manual path
 * refuses an evidence-bearing job (`hasBroadcastEvidence`) until chain proof resolves it.
 */
export type LiftJobResettableState = LiftRecoverableJobState;

export type LiftJobChainRecoverableState = Extract<LiftRecoverableJobState, 'broadcast' | 'included'>;

export const LIFT_JOB_ALLOWED_TRANSITIONS: Record<LiftJobState, readonly LiftJobState[]> = {
  accepted: ['claimed', 'failed'],
  claimed: ['validated', 'failed'],
  validated: ['broadcast', 'finalized', 'failed'],
  broadcast: ['included', 'failed'],
  included: ['finalized', 'failed'],
  finalized: [],
  failed: [],
};

export function getAllowedLiftJobTransitions(state: LiftJobState): readonly LiftJobState[] {
  return LIFT_JOB_ALLOWED_TRANSITIONS[state];
}

export function isTerminalLiftJobState(state: LiftJobState): state is TerminalLiftJobState {
  return state === 'finalized' || state === 'failed';
}

export function canTransitionLiftJob(from: LiftJobState, to: LiftJobState): boolean {
  return LIFT_JOB_ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertLiftJobTransition(from: LiftJobState, to: LiftJobState): void {
  if (canTransitionLiftJob(from, to)) {
    return;
  }

  const allowed = getAllowedLiftJobTransitions(from);
  const allowedText = allowed.length > 0 ? allowed.join(', ') : '<none>';
  throw new Error(`Invalid LiftJob transition: ${from} -> ${to}. Allowed: ${allowedText}`);
}
