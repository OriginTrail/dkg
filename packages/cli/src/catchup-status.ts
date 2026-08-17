import type { Rfc64SelectedSwmGraphSyncStatus } from '@origintrail-official/dkg-agent';
import type { CatchupJobResult } from './catchup-runner.js';

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

/** Explicit public response shape for the catch-up status endpoint. */
export interface CatchupStatusResponse {
  readonly jobId: string;
  readonly contextGraphId: string;
  /** Legacy request field retained on the wire. */
  readonly includeWorkspace: boolean;
  readonly includeSharedMemory: boolean;
  /** Closed legacy status vocabulary for older clients. */
  readonly status: LegacyCatchupJobState;
  /** Precise bounded-job outcome for upgraded clients. */
  readonly jobStatus: CatchupJobState;
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly result?: CatchupJobResult;
  readonly error?: string;
  readonly graphSync?: Rfc64SelectedSwmGraphSyncStatus;
}

/** Older daemons can omit newer aliases; the client normalizes them at the boundary. */
export type CatchupStatusWireResponse = Omit<
  CatchupStatusResponse,
  'includeSharedMemory' | 'jobStatus'
> & {
  readonly includeSharedMemory?: boolean;
  readonly jobStatus?: CatchupJobState;
};

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
