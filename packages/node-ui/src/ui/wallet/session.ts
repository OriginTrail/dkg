/**
 * Persistence for "remember which EIP-6963 provider I last used".
 * Ported from staking-ui-v10. Only the provider UUID is stored — never the
 * address/chain (re-read from the provider on reconnect so account/chain
 * switches are picked up). All access is try/catch (localStorage throws in
 * private mode / some webviews); the wallet still works without persistence.
 */

const STORAGE_KEY = 'dkg-node-ui:wallet-provider-uuid';

export function saveProviderUuid(uuid: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, uuid);
  } catch {
    /* localStorage unavailable; auto-reconnect won't work this session */
  }
}

export function loadProviderUuid(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function clearProviderUuid(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* see saveProviderUuid */
  }
}

export const _STORAGE_KEY_FOR_TESTING = STORAGE_KEY;
