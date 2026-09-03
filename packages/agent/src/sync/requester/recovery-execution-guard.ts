/**
 * Policy-agnostic cancellation/current-authority capability for recovery work.
 *
 * RFC-64 owns the concrete authority and revocation policy. Requester
 * algorithms receive only this execution capability and enforce it at their
 * actual await and commit boundaries.
 */
export interface RecoveryExecutionGuard {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface RecoveryExecutionBoundary {
  readonly signal: AbortSignal | undefined;
  assertCurrent(): void;
  /** Cancellable/read-only await: authority is checked before and after it. */
  read<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * One synchronous durability unit. Authority is checked exactly once at
   * admission; the operation is then allowed to drain without another lease
   * check being hidden inside this boundary.
   */
  commitSync<T>(operation: () => T): T;
  /**
   * One asynchronous durability unit. Authority is checked exactly once at
   * admission; an admitted promise is never interrupted between its related
   * mutations.
   */
  commitAsync<T>(operation: () => Promise<T>): Promise<T>;
}

/** Build one owned boundary for a complete requester recovery invocation. */
export function createRecoveryExecutionBoundary(
  guard?: RecoveryExecutionGuard,
): RecoveryExecutionBoundary {
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
    commitSync<T>(operation: () => T): T {
      guard?.assertCurrent();
      return operation();
    },
    async commitAsync<T>(operation: () => Promise<T>): Promise<T> {
      guard?.assertCurrent();
      return operation();
    },
  });
}
