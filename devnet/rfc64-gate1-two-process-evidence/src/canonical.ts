import { createHash } from 'node:crypto';

// Deterministic, byte-stable encoding primitives. No clock, no host or
// environment input, no floats, no Date, no Math.random anywhere in this
// contract. Every value that reaches serialization must be an integer, a
// lowercase-hex string, a plain string, a boolean, null, an array, or a plain
// object; canonical order is imposed by sorting keys and by callers sorting any
// set-like array before it is serialized.

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** SHA-256 over the given bytes, returned as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const UTF8 = new TextEncoder();

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Serialize a value to a single canonical UTF-8 string: object keys sorted
 * ascending by code unit, no insignificant whitespace, integers only (never a
 * float or exponent), standard JSON string escaping. Arrays keep their given
 * order — callers impose canonical/sorted order on the data before calling.
 * Throws on any non-integer number, non-finite number, undefined, function,
 * bigint, or symbol so a nondeterministic value can never be silently emitted.
 */
export function canonicalize(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isFinite(value)) {
      throw new TypeError(`canonical JSON permits only finite integers, got ${String(value)}`);
    }
    // Safe integers stringify without exponent; guard the boundary explicitly.
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`canonical JSON integer is outside the safe range: ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize((value as Record<string, CanonicalValue>)[key]!)}`,
      );
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot serialize value of type ${typeof value}`);
}

/** Canonical document bytes: canonical JSON plus exactly one trailing LF. */
export function canonicalDocument(value: CanonicalValue): string {
  return `${canonicalize(value)}\n`;
}
