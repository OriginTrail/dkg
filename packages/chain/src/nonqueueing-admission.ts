export interface NonqueueingAdmissionGateV1<K> {
  run<T>(
    key: K,
    operation: () => Promise<T>,
    saturated: (active: number) => Error,
  ): Promise<T>;
}

/**
 * A per-instance policy, for callers whose limit is genuinely local.
 *
 * The one-shot finalized read is the only such caller today: its limit is 4 and
 * folding it into the snapshot's single process-wide lane would throttle an
 * unrelated path. Its saturation reports no holder, because a local gate has no
 * owner concept to report.
 */
export function createLocalNonqueueingAdmissionV1<K>(limit: number): {
  run<T>(
    key: K,
    operation: () => Promise<T>,
    saturated: (active: number, holder?: string) => Error,
  ): Promise<T>;
} {
  const gate = createNonqueueingAdmissionGateV1<K>(limit);
  return Object.freeze({
    run: <T>(
      key: K,
      operation: () => Promise<T>,
      saturated: (active: number, holder?: string) => Error,
    ) => gate.run(key, operation, (active) => saturated(active, undefined)),
  });
}

/** Shared non-queueing permit state used by finalized routers and transports. */
export function createNonqueueingAdmissionGateV1<K>(
  limit: number,
): NonqueueingAdmissionGateV1<K> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Non-queueing admission limit must be a positive safe integer');
  }
  const activeByKey = new Map<K, number>();
  const gate: NonqueueingAdmissionGateV1<K> = Object.freeze({
    async run<T>(
      key: K,
      operation: () => Promise<T>,
      saturated: (active: number) => Error,
    ): Promise<T> {
      const active = activeByKey.get(key) ?? 0;
      if (active >= limit) throw saturated(active);
      activeByKey.set(key, active + 1);
      try {
        return await operation();
      } finally {
        const remaining = (activeByKey.get(key) ?? 1) - 1;
        activeByKey.set(key, Math.max(0, remaining));
      }
    },
  });
  return gate;
}
