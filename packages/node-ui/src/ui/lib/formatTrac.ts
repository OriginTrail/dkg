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

/**
 * Guarded formatter for a TRAC wallet balance (GH #915). `/api/wallets/balances`
 * types `trac` as `string`, but a node that can't read the TRAC token balance
 * (RPC hiccup, token contract unreachable on a fresh chain, …) returns it null
 * or non-numeric. The previous Settings render did `parseFloat(b.trac).toFixed(2)`,
 * and `parseFloat(null|undefined|non-numeric)` is `NaN`, so the wallet row showed
 * the literal string "NaN" — while the sibling ETH amount was guarded via
 * `formatEth`. This returns an em-dash for missing/non-numeric values so the two
 * balances stay consistent and the UI never renders "NaN".
 *
 * @param value Raw TRAC balance (string | number); null/undefined/non-numeric → "—".
 * @param digits Fractional digits to display. Defaults to 2.
 */
export function formatTrac(value: unknown, digits = 2): string {
  if (value == null) return '—';
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else {
    const s = String(value).trim();
    // Strict decimal parse: `parseFloat` is too permissive at a trust
    // boundary ("12abc" → 12, "0x10" → 0). Only a plain decimal number
    // (optional sign, integer/fraction, optional exponent) is accepted;
    // anything else falls back to the em-dash (Codex).
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return '—';
    n = Number(s);
  }
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/**
 * Tooltip companion to {@link formatTrac}: the exact raw balance, but ONLY when
 * it's a real number. When the daemon returns null/undefined/empty/non-numeric
 * the visible cell already falls back to an em-dash, so the `title` tooltip must
 * not leak the raw "null"/"NaN"/junk either (Codex) — return undefined so no
 * tooltip renders. Reuses formatTrac's validation to stay in lockstep.
 */
export function formatTracTooltip(value: unknown): string | undefined {
  if (formatTrac(value) === '—') return undefined;
  return `Exact: ${value}`;
}
