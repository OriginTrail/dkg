// Ported from OriginTrail/staking-ui-v10 (internal).
//
// EIP-6963 multi-injected-provider discovery (https://eips.ethereum.org/EIPS/eip-6963).
//
// The page broadcasts `eip6963:requestProvider`; every injected wallet replies with
// `eip6963:announceProvider`. We collect those announcements and expose them as a list.
// No library, no transitive deps.
//
// SECURITY: `info.name`/`icon`/`rdns` are self-reported by the wallet and spoofable — treat
// all provider metadata as UNTRUSTED, display-only. The trust boundary is the device screen.

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

interface AnnounceEvent extends CustomEvent<Eip6963ProviderDetail> {
  type: 'eip6963:announceProvider';
}

declare global {
  interface WindowEventMap {
    'eip6963:announceProvider': AnnounceEvent;
  }
}

const detected = new Map<string, Eip6963ProviderDetail>();
const subscribers = new Set<(list: Eip6963ProviderDetail[]) => void>();

let started = false;

function notify() {
  const list = [...detected.values()];
  for (const sub of subscribers) sub(list);
}

function onAnnounce(event: AnnounceEvent) {
  const detail = event.detail;
  if (!detected.has(detail.info.uuid)) {
    detected.set(detail.info.uuid, detail);
    notify();
  }
}

/** Begin listening for announcements and request them (idempotent; SSR-safe). */
export function startDiscovery(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** Subscribe to the discovered-provider list; fires immediately with the current set. */
export function subscribe(fn: (list: Eip6963ProviderDetail[]) => void): () => void {
  subscribers.add(fn);
  fn([...detected.values()]);
  return () => {
    subscribers.delete(fn);
  };
}

/** Test seam — reset the module-level discovery state between unit tests. */
export function _resetDiscoveryForTesting(): void {
  detected.clear();
  subscribers.clear();
  started = false;
  if (typeof window !== 'undefined') window.removeEventListener('eip6963:announceProvider', onAnnounce);
}
