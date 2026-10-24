/**
 * r3 (3877646541) — INTERNAL, deliberately not exported from the package barrel: the
 * swallow-all-errors dispatch policy belongs to the publisher's own scheduling callbacks
 * (`onPublishConfirmed`), not to the public contract.
 *
 * r2 (3877540214) — THE one implementation of non-fail-closed listener dispatch: neither a
 * synchronous throw nor an asynchronous rejection may escape into the caller. Every
 * `onPublishConfirmed` invocation goes through here so the containment recipe cannot drift
 * between call sites.
 */
export function bestEffortNotify<T>(
  listener: ((arg: T) => void | Promise<void>) | undefined,
  arg: T,
): void {
  try {
    void Promise.resolve(listener?.(arg)).catch(() => {});
  } catch {
    // Synchronous listener throw: contained for the same reason as the rejection above.
  }
}
