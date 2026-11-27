declare const syncFetchSharingIdentityBrand: unique symbol;

/**
 * Opaque authority to join an in-flight page fetch. Only capabilities minted
 * once and then deliberately shared can coalesce; caller-controlled labels
 * are never fetch ownership.
 */
export type SyncFetchSharingIdentity = Readonly<{
  [syncFetchSharingIdentityBrand]: true;
}>;

export function createSyncFetchSharingIdentity(): SyncFetchSharingIdentity {
  return Object.freeze({}) as SyncFetchSharingIdentity;
}

/** One already-composed job-window + round-deadline capability. */
export interface SyncWorkAdmission {
  readonly fetchSharingIdentity?: SyncFetchSharingIdentity;
  readonly canAdmitWork: () => boolean;
  readonly assertCurrent: () => void;
  readonly capTimeout: (timeoutMs: number) => number;
  /** Admit one positive whole-millisecond transport timeout or classify exhaustion. */
  readonly admitTimeout: (timeoutMs: number) => number;
}

const unrestrictedSyncFetchSharingIdentity = createSyncFetchSharingIdentity();

export const UNRESTRICTED_SYNC_WORK: SyncWorkAdmission = Object.freeze({
  fetchSharingIdentity: unrestrictedSyncFetchSharingIdentity,
  canAdmitWork: () => true,
  assertCurrent: () => {},
  capTimeout: (timeoutMs: number) => timeoutMs,
  admitTimeout: (timeoutMs: number) => positiveTimeout(timeoutMs),
});

export function createSyncWorkAdmission(
  remainingMs: () => number,
  options: Readonly<{ fetchSharingIdentity?: SyncFetchSharingIdentity }> = {},
): SyncWorkAdmission {
  const canAdmitWork = () => remainingMs() > 0;
  return Object.freeze({
    ...(options.fetchSharingIdentity === undefined
      ? {}
      : { fetchSharingIdentity: options.fetchSharingIdentity }),
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
  readonly fetchSharingIdentity?: SyncFetchSharingIdentity;
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
    ...(options.fetchSharingIdentity === undefined
      ? {}
      : { fetchSharingIdentity: options.fetchSharingIdentity }),
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
