// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startDiscovery,
  subscribe,
  _resetDiscoveryForTesting,
  type Eip6963ProviderDetail,
  type Eip1193Provider,
} from '../src/ui/web3/eip6963.js';
import {
  saveProviderRdns,
  loadProviderRdns,
  clearProviderRdns,
  _STORAGE_KEY_FOR_TESTING,
} from '../src/ui/web3/session.js';

function makeProvider(): Eip1193Provider {
  return { request: vi.fn(async () => undefined) };
}

function announce(uuid: string, rdns: string): void {
  const detail: Eip6963ProviderDetail = {
    info: { uuid, name: `Wallet ${rdns}`, icon: 'data:,', rdns },
    provider: makeProvider(),
  };
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
}

describe('eip6963 discovery', () => {
  beforeEach(() => _resetDiscoveryForTesting());
  afterEach(() => _resetDiscoveryForTesting());

  it('startDiscovery requests providers and collects announcements', () => {
    const requestSpy = vi.fn();
    window.addEventListener('eip6963:requestProvider', requestSpy);
    const seen: Eip6963ProviderDetail[][] = [];
    subscribe((list) => seen.push(list));
    startDiscovery();
    expect(requestSpy).toHaveBeenCalledTimes(1); // the page broadcast fired

    announce('uuid-1', 'io.metamask');
    const last = seen[seen.length - 1];
    expect(last.map((d) => d.info.rdns)).toEqual(['io.metamask']);
    window.removeEventListener('eip6963:requestProvider', requestSpy);
  });

  it('de-dupes by uuid (a wallet re-announcing does not double-add)', () => {
    startDiscovery();
    let list: Eip6963ProviderDetail[] = [];
    subscribe((l) => { list = l; });
    announce('uuid-1', 'io.metamask');
    announce('uuid-1', 'io.metamask'); // same uuid → ignored
    announce('uuid-2', 'app.rabby');
    expect(list.map((d) => d.info.uuid).sort()).toEqual(['uuid-1', 'uuid-2']);
  });

  it('subscribe fires immediately with the current set and unsubscribes cleanly', () => {
    startDiscovery();
    announce('uuid-1', 'io.metamask');
    const calls: number[] = [];
    const unsub = subscribe((l) => calls.push(l.length));
    expect(calls).toEqual([1]); // immediate fire with the already-detected provider
    unsub();
    announce('uuid-2', 'app.rabby');
    expect(calls).toEqual([1]); // no further calls after unsubscribe
  });

  it('startDiscovery is idempotent (a second call does not re-request)', () => {
    const requestSpy = vi.fn();
    window.addEventListener('eip6963:requestProvider', requestSpy);
    startDiscovery();
    startDiscovery();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    window.removeEventListener('eip6963:requestProvider', requestSpy);
  });
});

describe('wallet session (provider rdns persistence)', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  it('round-trips the rdns and clears it', () => {
    expect(loadProviderRdns()).toBeNull();
    saveProviderRdns('io.metamask');
    expect(loadProviderRdns()).toBe('io.metamask');
    expect(localStorage.getItem(_STORAGE_KEY_FOR_TESTING)).toBe('io.metamask');
    clearProviderRdns();
    expect(loadProviderRdns()).toBeNull();
  });

  it('silently no-ops when localStorage throws (private mode / disabled storage)', () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage disabled'); },
    });
    try {
      expect(() => saveProviderRdns('io.metamask')).not.toThrow();
      expect(loadProviderRdns()).toBeNull();
      expect(() => clearProviderRdns()).not.toThrow();
    } finally {
      if (orig) Object.defineProperty(globalThis, 'localStorage', orig);
    }
  });
});
