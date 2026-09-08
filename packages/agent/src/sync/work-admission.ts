/** An operation-owned allowance, independent of any synchronization plane. */
export interface SyncWorkAdmission {
  readonly canAdmitWork: () => boolean;
  readonly capDeadline: (deadline: number) => number;
  readonly capTimeout: (timeoutMs: number) => number;
}

export const UNRESTRICTED_SYNC_WORK: SyncWorkAdmission = Object.freeze({
  canAdmitWork: () => true,
  capDeadline: (deadline: number) => deadline,
  capTimeout: (timeoutMs: number) => timeoutMs,
});

export function createSyncWorkAdmission(remainingMs: () => number): SyncWorkAdmission {
  return Object.freeze({
    canAdmitWork: () => remainingMs() > 0,
    capDeadline: (deadline: number) => Math.min(deadline, Date.now() + remainingMs()),
    capTimeout: (timeoutMs: number) => Math.min(timeoutMs, remainingMs()),
  });
}

/** Local admission yield; no request needs to have crossed the wire. */
export class SyncWorkAdmissionExhaustedError extends Error {
  constructor() {
    super('Sync operation work allowance exhausted');
    this.name = 'SyncWorkAdmissionExhaustedError';
  }
}

export function assertSyncWorkAdmission(admission: SyncWorkAdmission): void {
  if (!admission.canAdmitWork()) throw new SyncWorkAdmissionExhaustedError();
}
