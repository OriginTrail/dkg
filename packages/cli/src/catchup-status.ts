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
export type LegacyCatchupJobState = Exclude<CatchupJobState, 'partial'>;

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
  return state === 'partial' ? 'unreachable' : state;
}
