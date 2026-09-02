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
   * One logical durability unit. Authority is checked at admission; once the
   * unit starts, revocation cannot interrupt it between related mutations.
   */
  commit<T>(operation: () => T): T;
}

/** Build one owned boundary for a complete requester recovery invocation. */
export function createRecoveryExecutionBoundary(
  guard?: RecoveryExecutionGuard,
): RecoveryExecutionBoundary {
  let commitDepth = 0;
  const assertGuardCurrent = (): void => guard?.assertCurrent();
  const assertCurrent = (): void => {
    // Explicit checks made by existing dependency callbacks are also part of
    // an admitted durability unit. Deferring them prevents revocation from
    // surfacing after the first mutation but before the remaining mutations.
    if (commitDepth === 0) assertGuardCurrent();
  };
  return Object.freeze({
    signal: guard?.signal,
    assertCurrent,
    async read<T>(operation: () => Promise<T>): Promise<T> {
      // A commit may contain dependency calls that are reads internally. Once
      // admitted, the whole unit is deliberately non-interruptible: checking
      // the lease here would recreate a delete-without-insert failure window.
      if (commitDepth > 0) return operation();
      assertGuardCurrent();
      try {
        const result = await operation();
        assertGuardCurrent();
        return result;
      } catch (error) {
        // Revocation is the authoritative outcome even when the in-flight
        // operation reports its own abort/transport error first.
        assertGuardCurrent();
        throw error;
      }
    },
    commit<T>(operation: () => T): T {
      if (commitDepth === 0) assertGuardCurrent();
      commitDepth += 1;
      try {
        const result = operation();
        if (
          result !== null
          && (typeof result === 'object' || typeof result === 'function')
          && typeof (result as unknown as PromiseLike<unknown>).then === 'function'
        ) {
          return Promise.resolve(result).finally(() => {
            commitDepth -= 1;
          }) as T;
        }
        commitDepth -= 1;
        return result;
      } catch (error) {
        commitDepth -= 1;
        throw error;
      }
    },
  });
}
