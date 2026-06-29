// Ported from OriginTrail/staking-ui-v10 (internal).
//
// Persistence for "remember which EIP-6963 provider I last used".
//
// We store the provider's **rdns** (its reverse-DNS id, e.g. `io.metamask`) — never the
// address, never the chain id, and NOT the EIP-6963 `uuid` (the wallet regenerates the uuid
// every page load, so it can't be matched in a later session; `rdns` is stable per wallet).
// Address/chain are re-read from the provider on every reconnect, so account/chain switches
// the user makes in their wallet are picked up automatically.
//
// All accesses are try/catch'd: `localStorage` throws in private/incognito on some browsers,
// embedded webviews disable storage, and cross-origin iframes can't access it. The wallet
// still works without persistence (the user just re-clicks "Connect" once per load), so we
// silently no-op on storage failure rather than surfacing an error.

const STORAGE_KEY = 'dkg-node-ui:wallet-provider-rdns';

export function saveProviderRdns(rdns: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, rdns);
  } catch {
    // localStorage unavailable; auto-reconnect won't work this session, everything else is fine.
  }
}

export function loadProviderRdns(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function clearProviderRdns(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // see saveProviderRdns
  }
}

/** Test seam — exported so unit tests can assert against the real key. */
export const _STORAGE_KEY_FOR_TESTING = STORAGE_KEY;
