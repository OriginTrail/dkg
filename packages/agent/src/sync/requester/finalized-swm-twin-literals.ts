// SPDX-License-Identifier: Apache-2.0

/** The literal readers of the finalized-twin proof (`finalized-swm-twin-reconciliation.ts`). */

export function parseInteger(value: string | undefined): bigint | null {
  if (!value) return null;
  const match = /^"?([0-9]+)"?(?:\^\^<[^>]+>)?$/.exec(value);
  if (!match?.[1]) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}

export function parseSafeCount(value: string | undefined): number | null {
  const parsed = parseInteger(value);
  if (parsed === null || parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(parsed);
}

export function literalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^<[^>]+>|@[A-Za-z0-9-]+)?$/.exec(value);
  return match?.[1] ?? value;
}

export function normalizeHex32(value: string): string {
  const raw = literalValue(value)?.trim().replace(/^0x/i, '').toLowerCase();
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) throw new Error('Expected a 32-byte hexadecimal value');
  return `0x${raw}`;
}

export function optionalHex32(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeHex32(value);
  } catch {
    return undefined;
  }
}
