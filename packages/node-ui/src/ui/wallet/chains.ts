import type { Chain } from 'viem';
import { base, gnosis, baseSepolia, hardhat } from 'viem/chains';

// NeuroWeb is not in viem/chains — define it (chainId 2043).
const neuroweb: Chain = {
  id: 2043,
  name: 'NeuroWeb',
  nativeCurrency: { name: 'NEURO', symbol: 'NEURO', decimals: 18 },
  rpcUrls: { default: { http: ['https://astrosat.origintrail.network'] } },
  blockExplorers: { default: { name: 'NeuroWeb', url: 'https://neuroweb.subscan.io' } },
};

// All chains a DKG V10 node might run on. Keyed by numeric EVM chainId.
// `writeContract({ chain })` wants the Chain object, not the number — the
// daemon's /api/pca/contracts gives us the number; we map it here.
const KNOWN: Chain[] = [base, gnosis, baseSepolia, hardhat, neuroweb];

export function chainByChainId(chainId: number): Chain | undefined {
  return KNOWN.find((c) => c.id === chainId);
}

/** Human label for a chainId — falls back to "Chain <id>" for the unknown. */
export function chainLabel(chainId: number | null | undefined): string {
  if (chainId == null) return '—';
  return chainByChainId(chainId)?.name ?? `Chain ${chainId}`;
}
