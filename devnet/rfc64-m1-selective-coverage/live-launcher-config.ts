/**
 * The shipped testnet adapter may spend up to 20 minutes waiting for chain
 * finality, durable/SWM catch-up, and exact store observations. The launcher
 * owns that live-operation policy and gives response framing and final
 * observation another five minutes. Generic process runtimes remain neutral.
 */
export const DEFAULT_LIVE_ADAPTER_TIMEOUT_MS = 25 * 60_000;

export function resolveLiveAdapterTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_LIVE_ADAPTER_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError('DKG_RFC64_M1_ADAPTER_TIMEOUT_MS must be an integer');
  }
  return parsed;
}
