import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  startDiscovery,
  subscribe as subscribeProviders,
  type Eip1193Provider,
  type Eip6963ProviderDetail,
} from './eip6963.js';
import { loadProviderUuid, saveProviderUuid, clearProviderUuid } from './session.js';
import { chainByChainId } from './chains.js';

export interface WalletConnection {
  provider: Eip1193Provider;
  address: `0x${string}`;
  chainId: number;
}

interface WalletCtxValue {
  address: `0x${string}` | null;
  chainId: number | null;
  providerInfo: Eip6963ProviderDetail['info'] | null;
  availableProviders: Eip6963ProviderDetail[];
  connected: boolean;
  connect: (detail: Eip6963ProviderDetail) => Promise<void>;
  disconnect: () => void;
  switchChain: (targetChainId: number) => Promise<void>;
  /** Reads the LIVE connection from a ref (current account/chain even inside a stale closure). */
  getConnection: () => WalletConnection | null;
}

const WalletContext = createContext<WalletCtxValue | null>(null);

export function useWallet(): WalletCtxValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within <WalletProvider>');
  return ctx;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [providerInfo, setProviderInfo] = useState<Eip6963ProviderDetail['info'] | null>(null);
  const [available, setAvailable] = useState<Eip6963ProviderDetail[]>([]);

  // Live mirror of the active connection — read by getConnection() at call time.
  const connRef = useRef<WalletConnection | null>(null);
  const setConnection = useCallback((c: WalletConnection | null) => {
    connRef.current = c;
    setAddress(c?.address ?? null);
    setChainId(c?.chainId ?? null);
  }, []);

  const disconnect = useCallback(() => {
    connRef.current = null;
    setConnection(null);
    setProviderInfo(null);
    clearProviderUuid();
  }, [setConnection]);

  const bindEvents = useCallback((provider: Eip1193Provider) => {
    if (!provider.on) return;
    provider.on('accountsChanged', (...args: unknown[]) => {
      const accounts = args[0] as string[];
      const next = accounts?.[0] ?? null;
      if (next === null) { disconnect(); return; }
      const cur = connRef.current;
      if (cur) setConnection({ ...cur, address: next as `0x${string}` });
    });
    provider.on('chainChanged', (...args: unknown[]) => {
      const cid = parseInt(args[0] as string, 16);
      const cur = connRef.current;
      if (cur) setConnection({ ...cur, chainId: cid });
    });
    provider.on('disconnect', () => disconnect());
  }, [disconnect, setConnection]);

  const connect = useCallback(async (detail: Eip6963ProviderDetail) => {
    const provider = detail.provider;
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    const chainHex = (await provider.request({ method: 'eth_chainId' })) as string;
    bindEvents(provider);
    setProviderInfo(detail.info);
    setConnection({ provider, address: (accounts[0] ?? '') as `0x${string}`, chainId: parseInt(chainHex, 16) });
    saveProviderUuid(detail.info.uuid);
  }, [bindEvents, setConnection]);

  const switchChain = useCallback(async (targetChainId: number) => {
    const conn = connRef.current;
    if (!conn) throw new Error('Wallet not connected.');
    const hex = `0x${targetChainId.toString(16)}`;
    try {
      await conn.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      const cfg = chainByChainId(targetChainId);
      // 4902 = chain not added. Auto-add only known PUBLIC chains (their viem
      // rpcUrls are correct). A local devnet must be added manually (its RPC
      // is not shipped to the browser), so surface a clear instruction.
      if (code === 4902 && cfg && cfg.rpcUrls.default.http[0] && !cfg.rpcUrls.default.http[0].includes('127.0.0.1')) {
        await conn.provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hex,
            chainName: cfg.name,
            nativeCurrency: cfg.nativeCurrency,
            rpcUrls: [...cfg.rpcUrls.default.http],
            blockExplorerUrls: cfg.blockExplorers ? [cfg.blockExplorers.default.url] : [],
          }],
        });
      } else if (code === 4902) {
        throw new Error(`Add this network to your wallet manually (chainId ${targetChainId}), then retry.`);
      } else {
        throw err;
      }
    }
  }, []);

  // Discovery + silent reconnect on mount.
  useEffect(() => {
    startDiscovery();
    const savedUuid = loadProviderUuid();
    let reconnected = false;
    const unsub = subscribeProviders((list) => {
      setAvailable(list);
      if (!savedUuid || reconnected) return;
      const match = list.find((p) => p.info.uuid === savedUuid);
      if (!match) return;
      reconnected = true;
      void (async () => {
        try {
          const accounts = (await match.provider.request({ method: 'eth_accounts' })) as string[];
          if (accounts.length === 0) { clearProviderUuid(); return; }
          const chainHex = (await match.provider.request({ method: 'eth_chainId' })) as string;
          bindEvents(match.provider);
          setProviderInfo(match.info);
          setConnection({ provider: match.provider, address: accounts[0] as `0x${string}`, chainId: parseInt(chainHex, 16) });
        } catch (e) {
          console.warn('[wallet] silent reconnect failed', e);
        }
      })();
    });
    return () => unsub();
  }, [bindEvents, setConnection]);

  const value: WalletCtxValue = {
    address,
    chainId,
    providerInfo,
    availableProviders: available,
    connected: address !== null,
    connect,
    disconnect,
    switchChain,
    getConnection: () => connRef.current,
  };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
