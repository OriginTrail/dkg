// NSM number-display rules — implements UI-COPY.md §"Number display rules".
// One module so every surface renders money identically.

/** Reference FX rate (TRAC→USD). Live surfaces refresh this from the node's
 *  reference-rate endpoint; fixtures carry 0.28. USD is always display-only —
 *  it never enters the TRAC ledger. */
export const DEFAULT_TRAC_USD = 0.28;

export const MICRO_PER_TRAC = 1_000_000;

export function microToTrac(micro: number): number {
  return micro / MICRO_PER_TRAC;
}

/** `258 µ` — compact per-message cost chip. */
export function fmtMicro(micro: number): string {
  return `${micro.toLocaleString("en-US")} µ`;
}

/** `1.9992` — TRAC to 4 dp for balances. */
export function fmtTrac(trac: number): string {
  return trac.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/** `$0.56` / `$0.00007` — USD subtext; more precision for sub-cent values. */
export function fmtUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (Math.abs(usd) < 0.01) {
    return `$${usd.toFixed(Math.min(7, Math.max(4, -Math.floor(Math.log10(Math.abs(usd))) + 1)))}`;
  }
  return `$${usd.toFixed(2)}`;
}

export function microToUsd(micro: number, rate: number): number {
  return microToTrac(micro) * rate;
}

/** Blended USD per 1M tokens from per-token µ prices (3:1 in:out weighting —
 *  the same blend everywhere so cards and rows sort consistently).
 *  1 µ/token ≡ 1 TRAC per 1M tokens, so the arithmetic is exact. */
export function usdPer1M(inMicro: number, outMicro: number, rate: number): number {
  return ((3 * inMicro + outMicro) / 4) * rate;
}

/** `~$0.84–0.91` price range across providers (single value if equal). */
export function fmtUsdRange(values: number[]): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const f = (v: number) => v.toFixed(2);
  return lo === hi ? `~$${f(lo)}` : `~$${f(lo)}–${f(hi)}`;
}

/** `1.2M` / `240k` settled-volume compact form. */
export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** `0x633E5a7C…` — first 8 hex chars + ellipsis (digest/key/address rule). */
export function fmtHash(h: string): string {
  const stripped = h.startsWith("sha256:") ? h.slice(7) : h.startsWith("0x") ? h.slice(2) : h;
  const prefix = h.startsWith("sha256:") ? "sha256:" : h.startsWith("0x") ? "0x" : "";
  return `${prefix}${stripped.slice(0, 8)}…`;
}

/** `04:12` mm:ss countdown from milliseconds remaining (floor at 00:00). */
export function fmtCountdown(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
