/**
 * Shared formatter for the native gas-token (ETH/xDAI/NEURO) balance
 * shown across the UI. Settings has historically rounded to 6 fractional
 * digits via `parseFloat(x).toFixed(6)`, while the Dashboard wallet card
 * dumped the raw value at full 17-digit precision (BUG-006/009). Routing
 * both consumers through this helper keeps the rendering consistent and
 * gives us one place to evolve the format.
 *
 * @param value Raw balance from `/api/wallets/balances`. Accepts string
 *              ("0.04058352…") or number; null/undefined renders "—".
 * @param digits Maximum fractional digits to display. Defaults to 6 —
 *               enough precision to act on a tiny gas balance (microETH
 *               level) without spilling beyond what JS Number can
 *               represent (~15 significant digits).
 */
export function formatEth(value: unknown, digits = 6): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const fixed = n.toFixed(digits);
  // Trim trailing zeros and a stray decimal point so "0.040000" → "0.04"
  // but keep at least one digit after the decimal so "0" doesn't read as
  // an int when the underlying value is non-zero (e.g. 0.0000004 → "0").
  const trimmed = fixed.replace(/\.?0+$/, '');
  if (n > 0 && Number(trimmed) === 0) {
    // Below the rounding threshold — surface a `< 1e-6` style hint so
    // the user knows it isn't literally zero.
    return `< ${1 / Math.pow(10, digits)}`;
  }
  return trimmed;
}

/**
 * Build a `title` tooltip string for the formatted balance. The
 * Dashboard wallet card is now compact (formatEth output), so the user
 * needs a way to see the underlying full-precision value when they care.
 * Mirrors how the Settings page already exposes the address tooltip.
 */
export function formatEthTooltip(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  return `Exact balance: ${value} (full precision from chain)`;
}
