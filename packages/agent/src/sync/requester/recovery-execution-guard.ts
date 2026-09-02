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
  wait<T>(operation: () => Promise<T>): Promise<T>;
  commit<T>(operation: () => T): T;
}

/** Build one owned boundary for a complete requester recovery invocation. */
export function createRecoveryExecutionBoundary(
  guard?: RecoveryExecutionGuard,
): RecoveryExecutionBoundary {
  const assertCurrent = (): void => guard?.assertCurrent();
  return Object.freeze({
    signal: guard?.signal,
    assertCurrent,
    async wait<T>(operation: () => Promise<T>): Promise<T> {
      assertCurrent();
      try {
        const result = await operation();
        assertCurrent();
        return result;
      } catch (error) {
        // Revocation is the authoritative outcome even when the in-flight
        // operation reports its own abort/transport error first.
        assertCurrent();
        throw error;
      }
    },
    commit<T>(operation: () => T): T {
      assertCurrent();
      const result = operation();
      assertCurrent();
      return result;
    },
  });
}
