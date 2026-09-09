export type SyncWorkAdmissionScope = Readonly<
  | { sharing: 'coalescible'; key: string }
  | { sharing: 'exclusive'; owner: string }
>;

/** One already-composed job-window + round-deadline capability. */
export interface SyncWorkAdmission {
  readonly scope: SyncWorkAdmissionScope;
  readonly canAdmitWork: () => boolean;
  readonly assertCurrent: () => void;
  readonly capTimeout: (timeoutMs: number) => number;
  /** Admit one positive whole-millisecond transport timeout or classify exhaustion. */
  readonly admitTimeout: (timeoutMs: number) => number;
}

export const UNRESTRICTED_SYNC_WORK: SyncWorkAdmission = Object.freeze({
  scope: Object.freeze({ sharing: 'coalescible', key: 'unrestricted' }),
  canAdmitWork: () => true,
  assertCurrent: () => {},
  capTimeout: (timeoutMs: number) => timeoutMs,
  admitTimeout: (timeoutMs: number) => positiveTimeout(timeoutMs),
});

export function createSyncWorkAdmission(
  remainingMs: () => number,
  scope: SyncWorkAdmissionScope = { sharing: 'exclusive', owner: 'scoped-operation' },
): SyncWorkAdmission {
  const canAdmitWork = () => remainingMs() > 0;
  return Object.freeze({
    scope: Object.freeze({ ...scope }),
    canAdmitWork,
    assertCurrent: () => {
      if (!canAdmitWork()) throw new SyncWorkAdmissionExhaustedError();
    },
    // Node's timer APIs reject fractional delays. Flooring also guarantees the
    // capped value never grants more time than the operation still owns.
    capTimeout: (timeoutMs: number) => Math.max(
      0,
      Math.floor(Math.min(timeoutMs, remainingMs())),
    ),
    admitTimeout: (timeoutMs: number) => positiveTimeout(Math.min(timeoutMs, remainingMs())),
  });
}

/** Compose a wall-clock round deadline with an optional monotonic job window once. */
export function composeSyncWorkAdmission(options: {
  readonly deadline: number;
  readonly window?: SyncWorkAdmission;
  readonly scope: SyncWorkAdmissionScope;
  readonly now?: () => number;
}): SyncWorkAdmission {
  const now = options.now ?? Date.now;
  const window = options.window ?? UNRESTRICTED_SYNC_WORK;
  const deadlineRemainingMs = () => options.deadline - now();
  const remainingMs = () => Math.max(0, Math.min(
    deadlineRemainingMs(),
    window.capTimeout(Number.MAX_SAFE_INTEGER),
  ));
  return Object.freeze({
    scope: Object.freeze({ ...options.scope }),
    canAdmitWork: () => remainingMs() > 0,
    assertCurrent: () => {
      if (deadlineRemainingMs() <= 0) {
        throw new SyncWorkAdmissionExhaustedError('timed_out');
      }
      // Preserve the underlying monotonic window's failure classification.
      window.assertCurrent();
    },
    capTimeout: (timeoutMs: number) => Math.max(
      0,
      Math.floor(Math.min(timeoutMs, remainingMs())),
    ),
    admitTimeout: (timeoutMs: number) => window.admitTimeout(positiveTimeout(
      Math.min(timeoutMs, deadlineRemainingMs()),
      'timed_out',
    )),
  });
}

function positiveTimeout(
  timeoutMs: number,
  outcome: 'local_yield' | 'timed_out' = 'local_yield',
): number {
  const admittedMs = Math.floor(timeoutMs);
  if (!Number.isFinite(admittedMs) || admittedMs <= 0) {
    throw new SyncWorkAdmissionExhaustedError(outcome);
  }
  return admittedMs;
}

/** Capability exhaustion; no request needs to have crossed the wire. */
export class SyncWorkAdmissionExhaustedError extends Error {
  constructor(readonly outcome: 'local_yield' | 'timed_out' = 'local_yield') {
    super('Sync operation work allowance exhausted');
    this.name = 'SyncWorkAdmissionExhaustedError';
  }
}

export function assertSyncWorkAdmission(admission: SyncWorkAdmission): void {
  admission.assertCurrent();
}
