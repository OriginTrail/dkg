export const CATCHUP_JOB_STATES = [
  'queued',
  'running',
  'done',
  'failed',
  'denied',
  'deferred',
  'partial',
  'unreachable',
] as const;

export type CatchupJobState = typeof CATCHUP_JOB_STATES[number];

/** Closed pre-`jobStatus` vocabulary retained for older API clients. */
export const LEGACY_CATCHUP_JOB_STATES = [
  'queued',
  'running',
  'done',
  'failed',
  'denied',
  'deferred',
  'unreachable',
] as const;

export type LegacyCatchupJobState = typeof LEGACY_CATCHUP_JOB_STATES[number];

/**
 * Keep the compatibility boundary exhaustive: adding a precise job state must
 * also make an explicit decision about what older clients receive.
 */
const LEGACY_CATCHUP_JOB_STATE_BY_STATE = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  denied: 'denied',
  deferred: 'deferred',
  partial: 'unreachable',
  unreachable: 'unreachable',
} as const satisfies Record<CatchupJobState, LegacyCatchupJobState>;

/** One terminality contract for daemon telemetry and CLI watch behavior. */
export const CATCHUP_TERMINAL_STATES: ReadonlySet<CatchupJobState> = new Set([
  'done',
  'failed',
  'denied',
  'deferred',
  'partial',
  'unreachable',
]);

export function isTerminalCatchupJobState(state: CatchupJobState): boolean {
  return CATCHUP_TERMINAL_STATES.has(state);
}

/** Preserve the pre-`jobStatus` wire vocabulary for older clients. */
export function toLegacyCatchupJobState(state: CatchupJobState): LegacyCatchupJobState {
  return LEGACY_CATCHUP_JOB_STATE_BY_STATE[state];
}
