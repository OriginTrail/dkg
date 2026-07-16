/**
 * EIP-6963 multi-injected-provider discovery (https://eips.ethereum.org/EIPS/eip-6963).
 *
 * Ported verbatim from staking-ui-v10 (src/lib/wallet/eip6963.ts) — it is
 * framework-agnostic. The page broadcasts `eip6963:requestProvider`, every
 * injected wallet replies with `eip6963:announceProvider`; we collect those and
 * expose them as a list. No library, no transitive deps.
 */

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

export function startDiscovery(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function subscribe(fn: (list: Eip6963ProviderDetail[]) => void): () => void {
  subscribers.add(fn);
  fn([...detected.values()]);
  return () => {
    subscribers.delete(fn);
  };
}
