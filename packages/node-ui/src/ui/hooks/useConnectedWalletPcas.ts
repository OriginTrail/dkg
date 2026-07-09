import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useWalletStore } from '../stores/wallet.js';
import { publicClientFor } from '../web3/clients.js';
import { publishingConvictionNftAbi } from '../web3/pcaContract.js';
import type { PcaContracts } from '../api.js';

export interface ConnectedWalletPcas {
  ids: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Connected-wallet PCA discovery — the low-level ERC721Enumerable walk
 * (`balanceOf` → `tokenOfOwnerByIndex`) that surfaces PCAs owned by the browser
 * wallet, kept out of the page component (#1375 item 5). Reads the connected
 * wallet + bootstrap contracts from the wallet store; returns
 * `{ ids, loading, error, refresh }`. Behavior is unchanged from
 * `ConvictionOverview`'s former inline discovery (extracted verbatim).
 */
export function useConnectedWalletPcas(): ConnectedWalletPcas {
  const connectedWallet = useWalletStore((s) => s.address);
  const walletBootstrap = useWalletStore((s) => s.bootstrap);
  const [state, setState] = useState<{ loading: boolean; error: string | null; ids: string[] }>({
    loading: false,
    error: null,
    ids: [],
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function discoverConnectedWalletPcas(contracts: PcaContracts, wallet: `0x${string}`) {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        if (!contracts.rpcUrls?.length) throw new Error('No PCA RPC endpoints were provided.');
        const client = publicClientFor(contracts.chainId, contracts.rpcUrls);
        const nft = contracts.nft as Address;
        const owner = wallet as Address;
        const balance = await client.readContract({
          address: nft,
          abi: publishingConvictionNftAbi,
          functionName: 'balanceOf',
          args: [owner],
        });
        const ids: string[] = [];
        const count = typeof balance === 'bigint' ? balance : BigInt(String(balance));
        for (let i = 0n; i < count; i += 1n) {
          const tokenId = await client.readContract({
            address: nft,
            abi: publishingConvictionNftAbi,
            functionName: 'tokenOfOwnerByIndex',
            args: [owner, i],
          });
          ids.push((typeof tokenId === 'bigint' ? tokenId : BigInt(String(tokenId))).toString());
        }
        if (cancelled) return;
        setState({ loading: false, error: null, ids });
      } catch (err) {
        if (cancelled) return;
        setState({
          loading: false,
          error: (err as Error)?.message ?? 'Could not read connected-wallet PCAs.',
          ids: [],
        });
      }
    }

    if (!connectedWallet || !walletBootstrap) {
      setState({ loading: false, error: null, ids: [] });
      return () => {
        cancelled = true;
      };
    }
    void discoverConnectedWalletPcas(walletBootstrap, connectedWallet);
    return () => {
      cancelled = true;
    };
  }, [connectedWallet, walletBootstrap, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ids: state.ids, loading: state.loading, error: state.error, refresh };
}
