// Single source of truth for the NATIVE gas-token symbol per chain
// (ETH / xDAI / NEURO). Shared by the Dashboard wallet/spending columns and the
// PCA surfaces so the chain→symbol map can't drift across surfaces.
//
// NOTE: `balances[].symbol` from /api/wallets/balances is the TRAC ERC-20 symbol
// (the daemon does `token.symbol()`), NOT the native gas symbol — gas is derived
// from the chainId here. Handles compound "slug:chainId" ids (e.g. "base:84532").
const CHAIN_GAS: Record<string, string> = {
  '1': 'ETH',
  '8453': 'ETH',
  '84532': 'ETH',
  '11155111': 'ETH',
  '31337': 'ETH',
  '100': 'xDAI',
  '10200': 'xDAI',
  '2043': 'NEURO',
  '20430': 'NEURO',
};

export function nativeGasSymbol(chainId: string | number | null | undefined): string {
  if (chainId == null) return 'ETH';
  const k = String(chainId);
  if (CHAIN_GAS[k]) return CHAIN_GAS[k];
  const numeric = k.match(/(\d+)\s*$/)?.[1];
  return (numeric && CHAIN_GAS[numeric]) || 'ETH';
}
