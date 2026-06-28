// Self-contained address truncation for the PCA components. The app's existing
// truncators are all file-local (`truncateAddress` in Settings.tsx,
// `shortAddr` duplicated across Notifications/Dashboard) and none is exported,
// so the PCA surfaces carry their own — the FULL address is always preserved in
// the accessible name / tooltip, never only the truncated form.
export function truncateAddress(address: string, head = 6, tail = 4): string {
  const a = (address ?? '').trim();
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/**
 * Format a wei (1e18) TRAC amount string for display. The snapshot pre-formats
 * `committedTRAC`/`topUpBuffer` into `*Trac` ether strings, but `baseEpochAllowance`
 * has no formatted twin — this converts its raw wei via BigInt so we never import
 * ethers into the client. Returns an em-dash for missing/un-parseable values.
 */
export function formatWeiToTrac(wei: string | null | undefined, digits = 2): string {
  if (wei == null || wei === '') return '—';
  let v: bigint;
  try {
    v = BigInt(wei);
  } catch {
    return '—';
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** 18n;
  const int = v / base;
  // Padded fractional digits, truncated to `digits` (display only).
  const fracStr = (v % base + base).toString().slice(1).slice(0, digits);
  const num = Number(`${int}.${fracStr || '0'}`);
  return `${neg ? '-' : ''}${num.toFixed(digits)}`;
}

// Native gas-token symbol per chain (DRIFT-4 OUTCOME = ETH/xDAI/NEURO) — the
// single shared map lives in lib/nativeGasSymbol (used by DashboardView too, so
// the chain→symbol map can't drift across surfaces). Re-exported for the PCA barrel.
export { nativeGasSymbol } from '../../lib/nativeGasSymbol.js';

// Testnet chains (faucet CTA is testnet-only — §6.2). Mirrors formatTrac.ts's
// testnet set; handles compound "slug:chainId".
const PCA_TESTNET_CHAINS = new Set(['84532', '11155111', '31337', '10200', '20430']);
export function isTestnetChain(chainId: string | null | undefined): boolean {
  if (chainId == null) return false;
  const k = String(chainId);
  const numeric = k.includes(':') ? k.split(':').pop()! : k;
  return PCA_TESTNET_CHAINS.has(numeric);
}

/**
 * Wall-clock expiry label (UX §6.4 — every expiry surface leads with wall-clock,
 * the epoch index is demoted to a tooltip). `expiresAtTimestamp` is unix SECONDS.
 */
export function formatRelativeExpiry(
  expiresAtTimestamp?: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  if (!expiresAtTimestamp || expiresAtTimestamp <= 0) return 'Expiry unknown';
  const diff = expiresAtTimestamp - nowSec;
  const days = Math.round(Math.abs(diff) / 86400);
  if (diff <= 0) {
    return days === 0 ? 'Expired today' : `Expired ~${days} day${days === 1 ? '' : 's'} ago`;
  }
  return `Expires in ~${days} day${days === 1 ? '' : 's'}`;
}
