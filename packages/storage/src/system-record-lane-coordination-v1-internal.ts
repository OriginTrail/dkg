import type {
  SystemRecordAtomicRecoveryRegistrarV1,
  SystemRecordAtomicRecoveryRequestV1,
  SystemRecordAtomicRecoveryRegistrationV1,
} from './system-record-atomic-apply-executor-v1-internal.js';

export interface SystemRecordOwnedRecoverySettlementV1<Resolution> {
  readonly recoveryGeneration: string;
  readonly completion: Promise<Resolution>;
  readonly settled: boolean;
  settle(resolution: Resolution): void;
}

/** Owns the complete lifetime of already-admitted apply invocations. */
export class SystemRecordApplyAdmissionTrackerV1 {
  private admitted = 0;
  private drainPromise: Promise<void> | null = null;
  private resolveDrain: (() => void) | null = null;

  async run<T>(
    registerRecovery: (
      request: SystemRecordAtomicRecoveryRequestV1,
    ) => SystemRecordAtomicRecoveryRegistrationV1,
    execute: (registerRecovery: SystemRecordAtomicRecoveryRegistrarV1) => Promise<T>,
  ): Promise<T> {
    this.admitted += 1;
    let registrarOpen = true;
    let registrationAttempted = false;
    const registrar: SystemRecordAtomicRecoveryRegistrarV1 = (request) => {
      if (!registrarOpen || registrationAttempted) {
        throw new Error(
          'system-record recovery registrar is no longer live for this apply invocation',
        );
      }
      registrationAttempted = true;
      return registerRecovery(request);
    };
    try {
      return await execute(registrar);
    } finally {
      registrarOpen = false;
      this.release();
    }
  }

  drain(): Promise<void> {
    if (this.admitted === 0) return Promise.resolve();
    if (this.drainPromise === null) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.resolveDrain = resolve;
      });
    }
    return this.drainPromise;
  }

  private release(): void {
    if (this.admitted <= 0) throw new Error('system-record admitted apply count underflow');
    this.admitted -= 1;
    if (this.admitted !== 0) return;
    const resolve = this.resolveDrain;
    this.drainPromise = null;
    this.resolveDrain = null;
    resolve?.();
  }
}
