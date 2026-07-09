export const MAX_UINT72 = (1n << 72n) - 1n;
export const MAX_UINT72_DECIMAL = MAX_UINT72.toString();

export const STORAGE_ACK_MAX_STAGING_BYTES = 4 * 1024 * 1024;

export type Uint72DecimalParseResult =
  | { ok: true; value: bigint }
  | { ok: false; reason: 'format' | 'range' | 'parse'; message?: string };

export function parseUint72Decimal(raw: string): Uint72DecimalParseResult {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    return { ok: false, reason: 'format' };
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch (e: any) {
    return { ok: false, reason: 'parse', message: e?.message ?? String(e) };
  }
  if (parsed > MAX_UINT72) {
    return { ok: false, reason: 'range' };
  }
  return { ok: true, value: parsed };
}
