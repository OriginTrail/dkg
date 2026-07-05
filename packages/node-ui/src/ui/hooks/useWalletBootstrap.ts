import { useEffect } from 'react';
import { listPcaContracts } from '../api.js';
import { useWalletStore } from '../stores/wallet.js';
import { pcaStorageScopeForContracts, usePcaStore } from '../stores/pca.js';

/**
 * Bootstrap the PCA storage scope + wallet contract addresses on mount.
 *
 * Detail reads still work through the daemon if this fails; wallet writes fail
 * closed through the owner-action resolver until bootstrap succeeds. The wallet
 * is always initialized last (success or failure).
 */
export function useWalletBootstrap(): void {
  const setWalletBootstrap = useWalletStore((s) => s.setBootstrap);
  const initWallet = useWalletStore((s) => s.initWallet);
  const setPcaScope = usePcaStore((s) => s.setScope);

  useEffect(() => {
    let cancelled = false;
    void listPcaContracts()
      .then((contracts) => {
        if (!cancelled) {
          setPcaScope(pcaStorageScopeForContracts(contracts));
          setWalletBootstrap(contracts);
        }
      })
      .catch(() => {
        // Detail reads still work through the daemon. Wallet writes fail closed
        // through the owner-action resolver until bootstrap succeeds.
      })
      .finally(() => {
        if (!cancelled) initWallet();
      });
    return () => {
      cancelled = true;
    };
  }, [initWallet, setPcaScope, setWalletBootstrap]);
}
