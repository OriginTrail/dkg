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

/**
 * Owns transition publication and the explicit chain of physical settlements.
 * Detach drains this chain rather than discovering successor work by following
 * a mutable transition pointer after each await.
 */
export class SystemRecordTransitionCoordinatorV1<Transition extends object> {
  private active: Transition | null = null;
  private recoverySequence = 0n;
  private settlementVersion = 0;
  private readonly ownedSettlements = new Map<Transition, Readonly<{
    settlement: Promise<void>;
    assertSettled?: () => void;
  }>>();

  get current(): Transition | null {
    return this.active;
  }

  publish(entry: Transition): void {
    this.active = entry;
  }

  release(entry: object): void {
    if (this.active === entry) this.active = null;
    if (this.ownedSettlements.delete(entry as Transition)) this.settlementVersion += 1;
  }

  createRecoverySettlement<Resolution>(): SystemRecordOwnedRecoverySettlementV1<Resolution> {
    this.recoverySequence += 1n;
    const recoveryGeneration = this.recoverySequence.toString(10);
    let settled = false;
    let resolve!: (resolution: Resolution) => void;
    const completion = new Promise<Resolution>((settle) => { resolve = settle; });
    return Object.freeze({
      recoveryGeneration,
      completion,
      get settled() { return settled; },
      settle: (resolution: Resolution) => {
        if (settled) return;
        settled = true;
        resolve(resolution);
      },
    });
  }

  ownSettlement(
    entry: Transition,
    settlement: Promise<void>,
    assertSettled?: () => void,
  ): void {
    if (this.active !== entry) {
      void settlement.catch(() => undefined);
      throw new Error('system-record transition settlement owner is not the active transition');
    }
    if (this.ownedSettlements.has(entry)) {
      throw new Error('system-record transition settlement is already owned');
    }
    // The state machine permits only the current transition plus one
    // shutdown-superseded predecessor. Enforce that physical bound rather than
    // turning the settlement registry into a general-purpose queue.
    if (this.ownedSettlements.size >= 2) {
      throw new Error('system-record transition settlement ownership exceeded its bound');
    }
    this.ownedSettlements.set(entry, Object.freeze({ settlement, assertSettled }));
    this.settlementVersion += 1;
    void settlement.catch(() => undefined);
  }

  async drainSettlements(): Promise<void> {
    for (;;) {
      const version = this.settlementVersion;
      const owned = [...this.ownedSettlements.entries()];
      const results = await Promise.allSettled(owned.map(([, value]) => value.settlement));
      if (version !== this.settlementVersion) continue;
      for (const [index, [entry, value]] of owned.entries()) {
        if (!this.ownedSettlements.has(entry)) continue;
        const result = results[index];
        if (result?.status === 'rejected') throw result.reason;
        value.assertSettled?.();
      }
      return;
    }
  }
}
