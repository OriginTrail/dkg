/**
 * Absolute Hermes channel response deadline. The default preserves the
 * pre-configuration behavior; tool progress and stream keepalives do not
 * extend an AbortSignal deadline.
 */
export const HERMES_CHANNEL_RESPONSE_TIMEOUT_MS = 15 * 60_000;

/**
 * Keeps an operator typo from disabling the only forward deadline, and stays
 * inside the timer range `AbortSignal.timeout` itself accepts.
 */
export const MAX_HERMES_CHANNEL_RESPONSE_TIMEOUT_MS = 24 * 60 * 60_000;

export function resolveHermesChannelResponseTimeoutMs(value: unknown): number {
  if (value === undefined) return HERMES_CHANNEL_RESPONSE_TIMEOUT_MS;
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_HERMES_CHANNEL_RESPONSE_TIMEOUT_MS
  ) {
    throw new TypeError(
      'localAgentIntegrations.hermes.responseTimeoutMs must be a positive integer number of milliseconds '
      + `between 1 and ${MAX_HERMES_CHANNEL_RESPONSE_TIMEOUT_MS}`,
    );
  }
  return value;
}

/** Reject an invalid persisted deadline before the daemon starts forwards. */
export function assertHermesChannelResponseTimeoutConfig(config: {
  localAgentIntegrations?: { hermes?: { responseTimeoutMs?: number } };
}): void {
  resolveHermesChannelResponseTimeoutMs(config.localAgentIntegrations?.hermes?.responseTimeoutMs);
}
