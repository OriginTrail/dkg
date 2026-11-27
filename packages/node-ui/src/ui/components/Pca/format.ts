export { truncateAddress } from '../Wallet/truncateAddress.js';

/**
 * PCA-facing TRAC display: group thousands and hide fractional noise for
 * amounts >= 10 TRAC. Small non-zero amounts keep up to `digits` decimals so
 * sub-10 balances/fees remain legible. Display-only; transaction inputs keep
 * their raw strings.
 */
const PCA_DISPLAY_DASH = '\u2014';

export function formatPcaTrac(value: unknown, digits = 2): string {
  if (value == null) return PCA_DISPLAY_DASH;
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else {
    const s = String(value).trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return PCA_DISPLAY_DASH;
    n = Number(s);
  }
  if (!Number.isFinite(n)) return PCA_DISPLAY_DASH;
  const abs = Math.abs(n);
  const fractionDigits = abs > 0 && abs < 10 ? digits : 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(n);
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
  return formatPcaTrac(`${neg ? '-' : ''}${int}.${fracStr || '0'}`, digits);
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

/** Whole days to or since expiry (rounded), or null when the expiry isn't known. */
export interface ExpiryDistance {
  /** At or past the expiry time. */
  past: boolean;
  days: number;
}

/** The one expiry calculation both labels below render from. `expiresAtTimestamp` is unix SECONDS. */
export function expiryDistance(
  expiresAtTimestamp: number | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): ExpiryDistance | null {
  if (!expiresAtTimestamp || expiresAtTimestamp <= 0) return null;
  const diff = expiresAtTimestamp - nowSec;
  return { past: diff <= 0, days: Math.round(Math.abs(diff) / 86400) };
}

const dayUnit = (days: number) => `day${days === 1 ? '' : 's'}`;

/**
 * Wall-clock expiry label (UX §6.4 — every expiry surface leads with wall-clock,
 * the epoch index is demoted to a tooltip).
 */
export function formatRelativeExpiry(
  expiresAtTimestamp?: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const d = expiryDistance(expiresAtTimestamp, nowSec);
  if (!d) return 'Expiry unknown';
  if (d.past) return d.days === 0 ? 'Expired today' : `Expired ~${d.days} ${dayUnit(d.days)} ago`;
  return `Expires in ~${d.days} ${dayUnit(d.days)}`;
}

/**
 * Short expiry for a cell or tile that already says "Expires": `~221 days`,
 * `Expired today`, `Expired 3 days ago`. The day count is rounded, hence `~`.
 * Returns null when the expiry isn't known, so each place shows its own blank.
 */
export function formatExpiryShort(
  expiresAtTimestamp?: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | null {
  const d = expiryDistance(expiresAtTimestamp, nowSec);
  if (!d) return null;
  if (!d.past) return `~${d.days} ${dayUnit(d.days)}`;
  return d.days === 0 ? 'Expired today' : `Expired ${d.days} ${dayUnit(d.days)} ago`;
}
