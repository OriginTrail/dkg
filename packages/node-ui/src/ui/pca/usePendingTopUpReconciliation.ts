import { useEffect } from 'react';
import { useWalletStore } from '../stores/wallet.js';
import { usePcaStore } from '../stores/pca.js';
import { publicClientFor } from '../web3/clients.js';
import type { ActionState } from './pcaAction.js';

/**
 * M9 — poll/reconcile the pending top-up receipt.
 *
 * The WRITE side (runFund persisting `topUpPending` on an ambiguous 504/receipt-wait)
 * stays in the component; this hook owns the read side: while a pending marker is
 * stored and the wallet is bootstrapped, it polls the exact broadcast hash, then on
 * a confirmed receipt clears the marker + reports success (+refresh), or on a revert
 * clears the marker + reports the revert. Failures retry every 5s until the hash
 * resolves. `setFund`/`refresh` are stable, so the poll doesn't churn per render.
 */
export function usePendingTopUpReconciliation({
  accountId,
  setFund,
  refresh,
}: {
  accountId: string;
  setFund: (state: ActionState) => void;
  refresh: () => void;
}): void {
  const topUpPending = usePcaStore((s) => s.topUpPending[accountId] ?? null);
  const clearTopUpPending = usePcaStore((s) => s.clearTopUpPending);
  const walletBootstrap = useWalletStore((s) => s.bootstrap);

  useEffect(() => {
    if (!topUpPending || !walletBootstrap?.rpcUrls?.length) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const client = publicClientFor(walletBootstrap.chainId, walletBootstrap.rpcUrls);
        const receipt = await client.getTransactionReceipt({
          hash: topUpPending.txHash as `0x${string}`,
        });
        if (cancelled) return;
        clearTopUpPending(accountId);
        if (receipt.status === 'success') {
          setFund({
            busy: false,
            error: null,
            warning: null,
            result: { txHash: topUpPending.txHash, message: 'Top-up confirmed on-chain.' },
          });
          refresh();
        } else {
          setFund({
            busy: false,
            error: 'The pending top-up transaction reverted on-chain.',
            warning: null,
            result: null,
          });
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 5_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [accountId, clearTopUpPending, refresh, setFund, topUpPending, walletBootstrap]);
}
