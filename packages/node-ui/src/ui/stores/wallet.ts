// Adapted from OriginTrail/staking-ui-v10 (Apache-2.0, © OriginTrail) — Svelte store → zustand.
//
// Single active connected wallet (inv-15): EIP-1193 exposes one active account; a swap is a
// disconnect→reconnect. Holds the EIP-6963 provider list, the connected provider/address/chain, and
// the bootstrap (expected) chain from `/api/pca/contracts` for the wrong-network guard + chain
// switch. VIEM-FREE on purpose (raw provider.request only) — viem clients are built by the submitter
// from this store's provider; keeping the store viem-free keeps its unit tests light.

import { create } from 'zustand';
import {
  startDiscovery,
  subscribe as subscribeProviders,
  type Eip1193Provider,
  type Eip6963ProviderDetail,
  type Eip6963ProviderInfo,
} from '../web3/eip6963.js';
import { numericChainId, chainIdHex } from '../web3/chainId.js';
import { nativeGasSymbol } from '../lib/nativeGasSymbol.js';
import { loadProviderRdns, saveProviderRdns, clearProviderRdns } from '../web3/session.js';
import type { PcaContracts } from '../api.js';

/**
 * Wallets hidden from the picker AND silent reconnect. Phantom announces EVM support via EIP-6963 but
 * doesn't cover every chain we support (Gnosis/NeuroWeb) — connecting strands the user on an
 * unsupported chain. Excluded by stable `rdns`.
 */
const EXCLUDED_WALLET_RDNS = new Set<string>(['app.phantom']);

/** Wait for staggered EIP-6963 announcements to quiesce before judging a saved rdns unambiguous. */
const RECONNECT_QUIESCE_MS = 300;

export interface WalletState {
  /** Visible (excluded-filtered) discovered providers. Metadata is UNTRUSTED/display-only (inv-14). */
  discovered: Eip6963ProviderDetail[];
  /** Detected-but-excluded — so the UI can say "detected but not supported", not "none". */
  unsupported: Eip6963ProviderDetail[];
  provider: Eip1193Provider | null;
  providerInfo: Eip6963ProviderInfo | null;
  address: `0x${string}` | null;
  /** The connected wallet's chain id (numeric). */
  chainId: number | null;
  /** The bootstrap (expected) chain id from /api/pca/contracts (numeric); null until set. */
  expectedChainId: number | null;
  /** The bootstrap contracts (kept for wallet_addEthereumChain params on the 4902 fallback). */
  bootstrap: PcaContracts | null;
  setBootstrap: (contracts: PcaContracts) => void;
  initWallet: () => void;
  connect: (detail: Eip6963ProviderDetail) => Promise<void>;
  disconnect: () => void;
  switchToExpectedChain: () => Promise<void>;
}

/** The provider list minus excluded wallets — what the picker + silent reconnect use. (Pure; tested.) */
export function visibleProviders(list: Eip6963ProviderDetail[]): Eip6963ProviderDetail[] {
  return list.filter((p) => !EXCLUDED_WALLET_RDNS.has(p.info.rdns));
}

/**
 * The provider to silently reconnect to for a saved rdns, or null when there's no UNAMBIGUOUS single
 * match. rdns is stable across reloads but not guaranteed unique — a duplicate must NOT auto-connect
 * (it could route writes through the wrong wallet). Evaluate against a SETTLED list. (Pure; tested.)
 */
export function reconnectTarget(
  list: Eip6963ProviderDetail[],
  savedRdns: string | null,
): Eip6963ProviderDetail | null {
  if (!savedRdns) return null;
  const matches = list.filter((p) => p.info.rdns === savedRdns);
  return matches.length === 1 ? matches[0] : null;
}

/** True when a wallet is connected but on a different chain than the node's PCA contracts. */
export function isWrongNetwork(s: Pick<WalletState, 'address' | 'chainId' | 'expectedChainId'>): boolean {
  return s.address != null && s.expectedChainId != null && s.chainId !== s.expectedChainId;
}

let reconnectAttempted = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let discoverySubscribed = false;

export const useWalletStore = create<WalletState>((set, get) => {
  function bindProviderEvents(provider: Eip1193Provider) {
    if (!provider.on) return;
    provider.on('accountsChanged', (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      const next = accounts?.[0] ?? null;
      // "All accounts disconnected in the wallet" = a full disconnect (clear the persisted provider,
      // else the next load silently reconnects to a wallet the user walked away from).
      if (next === null) {
        get().disconnect();
        return;
      }
      set({ address: next as `0x${string}` });
    });
    provider.on('chainChanged', (...args: unknown[]) => {
      set({ chainId: parseInt(args[0] as string, 16) });
    });
    provider.on('disconnect', () => get().disconnect());
  }

  async function silentReconnect(detail: Eip6963ProviderDetail) {
    const provider = detail.provider;
    try {
      const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
      if (accounts.length === 0) {
        clearProviderRdns(); // site permission revoked in the wallet → stop retrying
        return;
      }
      const chainHex = (await provider.request({ method: 'eth_chainId' })) as string;
      bindProviderEvents(provider);
      set({
        provider,
        providerInfo: detail.info,
        address: accounts[0] as `0x${string}`,
        chainId: parseInt(chainHex, 16),
      });
    } catch (err) {
      // Wallet offline / rejected the silent read — leave the stored rdns (transient), but log.
      console.warn('[wallet] silent reconnect failed', err);
    }
  }

  return {
    discovered: [],
    unsupported: [],
    provider: null,
    providerInfo: null,
    address: null,
    chainId: null,
    expectedChainId: null,
    bootstrap: null,

    setBootstrap(contracts) {
      set({ bootstrap: contracts, expectedChainId: numericChainId(contracts.chainId) });
    },

    initWallet() {
      if (typeof window === 'undefined') return;
      startDiscovery();
      if (discoverySubscribed) return;
      discoverySubscribed = true;
      const savedRdns = loadProviderRdns();
      subscribeProviders((list) => {
        set({
          discovered: visibleProviders(list),
          unsupported: list.filter((p) => EXCLUDED_WALLET_RDNS.has(p.info.rdns)),
        });
        if (!savedRdns || reconnectAttempted) return;
        // Debounce against the staggered announcements: only judge the saved rdns unique once the
        // list quiesces (else a late duplicate is missed and we reconnect to the wrong wallet).
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (reconnectAttempted) return;
          const target = reconnectTarget(get().discovered, savedRdns);
          if (!target) return; // 0 or >1 matches ⇒ ambiguous, stay manual
          reconnectAttempted = true;
          void silentReconnect(target);
        }, RECONNECT_QUIESCE_MS);
      });
    },

    async connect(detail) {
      const provider = detail.provider;
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      const chainHex = (await provider.request({ method: 'eth_chainId' })) as string;
      bindProviderEvents(provider);
      set({
        provider,
        providerInfo: detail.info,
        address: (accounts[0] ?? null) as `0x${string}` | null,
        chainId: parseInt(chainHex, 16),
      });
      // Persist the provider (not the address — re-read on reconnect so account switches are picked up).
      saveProviderRdns(detail.info.rdns);
      reconnectAttempted = false;
    },

    disconnect() {
      set({ provider: null, providerInfo: null, address: null, chainId: null });
      clearProviderRdns();
    },

    async switchToExpectedChain() {
      const { provider, bootstrap } = get();
      if (!provider) throw new Error('Wallet not connected.');
      if (!bootstrap) throw new Error('Chain not bootstrapped.');
      const hex = chainIdHex(bootstrap.chainId);
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
      } catch (err: unknown) {
        // 4902 = chain unknown to the wallet → offer to add it.
        if ((err as { code?: number })?.code === 4902) {
          const symbol = nativeGasSymbol(bootstrap.chainId);
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: hex,
                chainName: `chain-${numericChainId(bootstrap.chainId)}`,
                nativeCurrency: { name: symbol, symbol, decimals: 18 },
                rpcUrls: bootstrap.rpcUrls,
              },
            ],
          });
        } else {
          throw err;
        }
      }
    },
  };
});

/** Test seam — reset the module-level reconnect/discovery guards between unit tests. */
export function _resetWalletModuleStateForTesting(): void {
  reconnectAttempted = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  discoverySubscribed = false;
}
