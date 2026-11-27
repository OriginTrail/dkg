/** Startup-time parsing and bounds for the worker's hard shutdown timeout. */
export interface ShutdownPolicy {
  hardTimeoutMs: number;
}

export const DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS = 15_000;
export const MIN_SHUTDOWN_HARD_TIMEOUT_MS = 5_000;
export const MAX_SHUTDOWN_HARD_TIMEOUT_MS = 300_000;

/** Parse the worker hard-timeout environment override once at startup. */
export function resolveShutdownPolicy(value: string | undefined): ShutdownPolicy {
  let hardTimeoutMs = DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS;
  if (value !== undefined) {
    const parsed = Number(value);
    if (
      value.trim() === ''
      || !Number.isSafeInteger(parsed)
      || parsed < MIN_SHUTDOWN_HARD_TIMEOUT_MS
      || parsed > MAX_SHUTDOWN_HARD_TIMEOUT_MS
    ) {
      throw new TypeError(
        `DKG_SHUTDOWN_HARD_TIMEOUT_MS must be an integer from `
          + `${MIN_SHUTDOWN_HARD_TIMEOUT_MS} to ${MAX_SHUTDOWN_HARD_TIMEOUT_MS}`,
      );
    }
    hardTimeoutMs = parsed;
  }

  return { hardTimeoutMs };
}
