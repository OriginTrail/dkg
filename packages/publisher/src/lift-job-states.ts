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

export type LiftJobResettableState = Extract<LiftRecoverableJobState, 'claimed' | 'validated' | 'broadcast'>;

export type LiftJobChainRecoverableState = Extract<LiftRecoverableJobState, 'broadcast' | 'included'>;

export const LIFT_JOB_ALLOWED_TRANSITIONS: Record<LiftJobState, readonly LiftJobState[]> = {
  accepted: ['claimed', 'failed'],
  claimed: ['validated', 'failed'],
  validated: ['broadcast', 'failed'],
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
