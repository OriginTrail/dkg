/**
 * Policy-agnostic cancellation/current-authority capability for recovery work.
 *
 * RFC-64 owns the concrete authority and revocation policy. Requester
 * algorithms receive only this execution capability and enforce it at their
 * cancellable-read and mutation-admission boundaries.
 */
export interface RecoveryExecutionGuard {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface RecoveryExecutionAdmission {
  readonly signal: AbortSignal | undefined;
  assertCurrent(): void;
  /** Cancellable/read-only await: authority is checked before and after it. */
  read<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Admit one synchronous mutation against current authority, then let it
   * drain without another lease check. This is not a transaction and provides
   * no rollback; a multi-step caller must be idempotent and resumable.
   */
  admitSyncMutation<T>(operation: () => T): T;
  /**
   * Admit one asynchronous mutation sequence against current authority, then
   * let it drain without another lease check. This is not atomic and provides
   * no rollback; an error may follow earlier durable effects, so callers must
   * make the sequence safe to retry from any awaited step.
   */
  admitAsyncMutation<T>(operation: () => Promise<T>): Promise<T>;
}

/** Build one authority-admission capability for a requester recovery. */
export function createRecoveryExecutionAdmission(
  guard?: RecoveryExecutionGuard,
): RecoveryExecutionAdmission {
  const assertCurrent = (): void => guard?.assertCurrent();
  return Object.freeze({
    signal: guard?.signal,
    assertCurrent,
    async read<T>(operation: () => Promise<T>): Promise<T> {
      guard?.assertCurrent();
      try {
        const result = await operation();
        guard?.assertCurrent();
        return result;
      } catch (error) {
        // Revocation is the authoritative outcome even when the in-flight
        // operation reports its own abort/transport error first.
        guard?.assertCurrent();
        throw error;
      }
    },
    admitSyncMutation<T>(operation: () => T): T {
      guard?.assertCurrent();
      return operation();
    },
    async admitAsyncMutation<T>(operation: () => Promise<T>): Promise<T> {
      guard?.assertCurrent();
      return operation();
    },
  });
}
