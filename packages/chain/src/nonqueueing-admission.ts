export interface NonqueueingAdmissionGateV1<K> {
  run<T>(
    key: K,
    operation: () => Promise<T>,
    saturated: (active: number) => Error,
  ): Promise<T>;
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
