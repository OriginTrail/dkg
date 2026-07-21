/**
 * User-requested catch-up must outrank autonomous exact-VM repair (priority
 * 1_000) and ordinary background sync (priority 0). This lets a subscribe or
 * explicit catch-up displace queued background work instead of being marked
 * deferred before it has fetched a byte.
 */
export const FOREGROUND_CATCHUP_SYNC_PRIORITY = 2_000;

/**
 * Admission can still race another foreground catch-up. Retry that local-only
 * outcome briefly; transport, authorization, timeout, and integrity failures
 * are deliberately not retried here.
 */
export const CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS = [100, 250, 500] as const;

export interface CatchupBackpressureResult {
  deferredBackpressure?: number;
}

export async function retryCatchupPlaneOnBackpressure<T extends CatchupBackpressureResult>(
  run: () => Promise<T>,
  options?: {
    delaysMs?: readonly number[];
    wait?: (delayMs: number) => Promise<void>;
  },
): Promise<T> {
  const delaysMs = options?.delaysMs ?? CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS;
  const wait = options?.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));

  let result = await run();
  for (const delayMs of delaysMs) {
    if ((result.deferredBackpressure ?? 0) === 0) break;
    await wait(delayMs);
    result = await run();
  }
  return result;
}
