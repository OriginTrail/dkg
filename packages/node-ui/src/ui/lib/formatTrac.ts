/**
 * Normalise the TRAC token symbol surfaced in wallet rows so the
 * Dashboard and Settings pages agree (BUG-013). The daemon reports
 * `b.symbol` straight from the on-chain ERC-20: on Base Sepolia it's
 * `v9TRAC` (the legacy v9 testnet contract), and on Base mainnet it's
 * `TRAC`. Without normalisation, Settings shows `v9TRAC` while the
 * Dashboard column header shows `TRAC` for the same balance — the user
 * can't tell whether they're looking at one token or two.
 *
 * The chosen rendering keeps the on-chain identity visible (so users
 * see the v9 prefix on Base Sepolia and know they're on the legacy
 * contract) but appends a "(testnet)" qualifier so it's obvious the
 * token isn't the production TRAC.
 */
export function formatTracSymbol(symbol: string | null | undefined, chainId: string | null | undefined): string {
  const sym = (symbol ?? '').trim();
  if (!sym) return 'TRAC';
  const id = (chainId ?? '').includes(':') ? (chainId ?? '').split(':')[1] : (chainId ?? '');
  const isTestnet = id === '84532' || id === '11155111' || id === '31337' || id === '10200' || id === '20430';
  if (isTestnet) {
    if (/test/i.test(sym)) return sym;
    return `${sym} (testnet)`;
  }
  return sym;
}
