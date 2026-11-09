// Amounts and times as the node sends them: wei as decimal strings (with
// `…Trac` siblings), prices in wei per unit, times in chain seconds. Math on
// amounts is BigInt; USD is display-only and shown only when the node has a
// reference rate.

const WEI_PER_TRAC = 10n ** 18n;
const WEI_PER_MICRO = 10n ** 12n;

const big = (v: string | bigint): bigint => {
  if (typeof v === 'bigint') return v;
  try { return BigInt(v); } catch { return 0n; }
};

/** `wei / 10^decimals` as a decimal string, cut to `dp` places, trailing zeros dropped. */
function decimalOf(value: string | bigint, decimals: number, dp: number): string {
  const v = big(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').slice(0, dp).replace(/0+$/, '');
  const s = frac ? `${whole}.${frac}` : whole.toString();
  return neg && s !== '0' ? `-${s}` : s;
}

/** `2.5` TRAC from wei: four places at most, and `<0.0001` for a dust amount above zero. */
export function fmtTrac(wei: string | bigint): string {
  const v = big(wei);
  const s = decimalOf(v, 18, 4);
  return s === '0' && v > 0n ? '<0.0001' : s;
}

/**
 * `0.6` µTRAC per unit from wei per unit (1 µTRAC per token is 1 TRAC per
 * million tokens), cut to four places: for display only, never to read back.
 */
export function fmtMicro(weiPerUnit: string | bigint): string {
  const v = big(weiPerUnit);
  const s = decimalOf(v, 12, 4);
  return s === '0' && v > 0n ? '<0.0001' : s;
}

/** µTRAC per unit from wei per unit, exact to the wei: a value to edit, which `weiOfMicro` reads back unchanged. */
export const microOfWei = (weiPerUnit: string | bigint): string => decimalOf(weiPerUnit, 12, 12);

/** TRAC from wei, exact to the wei: a value to edit, which `weiOfTrac` reads back unchanged. */
export const tracOfWei = (wei: string | bigint): string => decimalOf(wei, 18, 18);

/** `$0.56` / `$0.00007`: more places for a sub-cent value. */
function fmtUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(Math.min(7, Math.max(4, -Math.floor(Math.log10(Math.abs(usd))) + 1)))}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `~$0.56` for a TRAC amount, or null with no reference rate. */
export function usdOf(wei: string | bigint, tracUsd: number | null | undefined): string | null {
  if (tracUsd == null) return null;
  return `~${fmtUsd((Number(big(wei) / WEI_PER_MICRO) / 1e6) * tracUsd)}`;
}

/** `0.17` USD per million units from wei per unit, or null with no reference rate. */
export function usdPerMillion(weiPerUnit: string | bigint, tracUsd: number | null | undefined): string | null {
  if (tracUsd == null) return null;
  return ((Number(big(weiPerUnit)) / 1e12) * tracUsd).toFixed(2);
}

/** Wei from TRAC the operator typed (`1.5`, `0.25`), or null when it is not a positive amount of at most 18 places. */
export function weiOfTrac(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s) && !/^\.\d{1,18}$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const wei = BigInt(w || '0') * WEI_PER_TRAC + BigInt(f.padEnd(18, '0'));
  return wei > 0n ? wei : null;
}

/** Wei per unit from µTRAC per unit the operator typed, or null. */
export function weiOfMicro(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,12})?$/.test(s) && !/^\.\d{1,12}$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const wei = BigInt(w || '0') * WEI_PER_MICRO + BigInt(f.padEnd(12, '0'));
  return wei > 0n ? wei : null;
}

/** The share of `part` in `whole`, 0–100 with one place, by BigInt. */
export function pctOf(part: string | bigint, whole: string | bigint): number {
  const w = big(whole);
  if (w <= 0n) return 0;
  const p = big(part);
  return Number((p * 1000n) / w) / 10;
}

/** How many units `wei` buys at `weiPerUnit`, rounded down. */
export function unitsOf(wei: string | bigint, weiPerUnit: string | bigint): bigint {
  const price = big(weiPerUnit);
  return price > 0n ? big(wei) / price : 0n;
}

/** `1.2M` / `240k` / `912`. */
export function fmtCount(n: number | bigint): string {
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
  if (v >= 10_000) return `${Math.round(v / 1_000)}k`;
  return v.toLocaleString('en-US');
}

export const sumWei = (values: Array<string | bigint>): bigint => values.reduce<bigint>((s, v) => s + big(v), 0n);

/** `Nov 8, 02:00 PM` from chain seconds. */
export const fmtAt = (seconds: number | null | undefined): string =>
  seconds == null ? '—' : new Date(seconds * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** `HH:MM` from chain seconds. */
export const fmtTime = (seconds: number): string => new Date(seconds * 1000).toTimeString().slice(0, 5);

/** Whole minutes, hours or days from `nowMs` to chain seconds `at` (negative when past). */
export function spanOf(at: number, nowMs: number): { n: number; unit: 'min' | 'h' | 'd'; past: boolean } {
  const ms = at * 1000 - nowMs;
  const m = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (m < 60) return { n: m, unit: 'min', past: ms < 0 };
  const h = Math.round(m / 60);
  if (h < 48) return { n: h, unit: 'h', past: ms < 0 };
  return { n: Math.round(h / 24), unit: 'd', past: ms < 0 };
}

/** `0x1234…cdef`: an address, transaction or key, shortened. */
export const fmtHex = (h: string | null | undefined): string => (h && h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h ?? '—');

/** A model's name from its URN: the part after the last colon. */
export const modelName = (label: string): string => label.slice(label.lastIndexOf(':') + 1) || label;
