// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

/** Closed artifact ceiling, including the document's single trailing LF. */
export const MAX_CANONICAL_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_CANONICAL_DEPTH = 16;
export const MAX_CANONICAL_NODES = 32_768;

const MAX_STRING_CODE_UNITS = 1_048_576;
const DIGEST32 = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_U256 =
  115_792_089_237_316_195_423_570_985_008_687_907_853_269_984_665_640_564_039_457_584_007_913_129_639_935n;

export const UTF8 = new TextEncoder();

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function isDigest32(value: unknown): value is string {
  return typeof value === 'string' && DIGEST32.test(value);
}

export function isAddress(value: unknown): value is string {
  return typeof value === 'string'
    && ADDRESS.test(value)
    && value !== `0x${'00'.repeat(20)}`;
}

export function parseCanonicalU64(value: unknown): bigint | undefined {
  return parseCanonicalDecimal(value, MAX_U64);
}

export function parseCanonicalU256(value: unknown): bigint | undefined {
  return parseCanonicalDecimal(value, MAX_U256);
}

function parseCanonicalDecimal(value: unknown, maximum: bigint): bigint | undefined {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed <= maximum ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function sha256Digest(...parts: readonly (string | Uint8Array)[]): string {
  const hasher = createHash('sha256');
  for (const part of parts) hasher.update(part);
  return `0x${hasher.digest('hex')}`;
}

export function digestBytes(digest: string): Uint8Array {
  if (!isDigest32(digest)) throw new TypeError('digest must be canonical 0x-prefixed sha-256');
  return Uint8Array.from(Buffer.from(digest.slice(2), 'hex'));
}

export function encodeU64(value: bigint | number): Uint8Array {
  let remaining = typeof value === 'number' ? BigInt(value) : value;
  if (remaining < 0n || remaining > MAX_U64) throw new RangeError('value is outside u64');
  const result = new Uint8Array(8);
  for (let index = result.length - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

/**
 * RFC 8785 JCS for the deliberately narrower evidence model (safe integers
 * only). Containers must be dense ordinary Arrays or plain data-only objects;
 * accessors are rejected and never invoked. Depth, node, string, and output
 * byte ceilings make this safe to use on a JavaScript trust boundary.
 */
export function canonicalize(value: CanonicalValue): string {
  const ancestors = new Set<object>();
  const budget = { nodes: 0, bytes: 0 };

  const accountAscii = (text: string): void => {
    budget.bytes += text.length;
    if (budget.bytes + 1 > MAX_CANONICAL_DOCUMENT_BYTES) {
      throw new RangeError('canonical document byte ceiling exceeded');
    }
  };
  const accountUtf8 = (text: string): void => {
    budget.bytes += UTF8.encode(text).byteLength;
    if (budget.bytes + 1 > MAX_CANONICAL_DOCUMENT_BYTES) {
      throw new RangeError('canonical document byte ceiling exceeded');
    }
  };

  const encode = (input: unknown, depth: number): string => {
    budget.nodes += 1;
    if (budget.nodes > MAX_CANONICAL_NODES) throw new TypeError('canonical JSON node ceiling exceeded');
    if (depth > MAX_CANONICAL_DEPTH) throw new TypeError('canonical JSON depth ceiling exceeded');

    if (input === null) {
      accountAscii('null');
      return 'null';
    }
    if (typeof input === 'boolean') {
      const encoded = input ? 'true' : 'false';
      accountAscii(encoded);
      return encoded;
    }
    if (typeof input === 'number') {
      if (!Number.isSafeInteger(input)) throw new TypeError('canonical evidence numbers must be safe integers');
      const encoded = JSON.stringify(input);
      accountAscii(encoded);
      return encoded;
    }
    if (typeof input === 'string') {
      assertIJsonString(input);
      const encoded = JSON.stringify(input);
      accountUtf8(encoded);
      return encoded;
    }
    if (typeof input !== 'object') throw new TypeError(`unsupported JSON value type: ${typeof input}`);
    if (ancestors.has(input)) throw new TypeError('cyclic values are not JSON');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) {
          throw new TypeError('only ordinary Arrays are accepted');
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
        if (
          lengthDescriptor === undefined
          || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
          || typeof lengthDescriptor.value !== 'number'
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
          || lengthDescriptor.value > MAX_CANONICAL_NODES
        ) {
          throw new TypeError('array length is not an exact bounded data field');
        }
        const length = lengthDescriptor.value;
        const keys = Reflect.ownKeys(input);
        if (
          keys.some((key) => typeof key !== 'string')
          || keys.length !== length + 1
          || !keys.includes('length')
        ) {
          throw new TypeError('arrays must be dense and contain no custom properties');
        }
        const entries: string[] = [];
        accountAscii('[]');
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (
            descriptor === undefined
            || !descriptor.enumerable
            || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          ) {
            throw new TypeError('array elements must be enumerable data properties');
          }
          if (index !== 0) accountAscii(',');
          entries.push(encode(descriptor.value, depth + 1));
        }
        return `[${entries.join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('only plain JSON objects are accepted');
      }
      const keys = Reflect.ownKeys(input);
      if (keys.length > MAX_CANONICAL_NODES || keys.some((key) => typeof key !== 'string')) {
        throw new TypeError('object keys exceed the canonical JSON boundary');
      }
      const stringKeys = keys as string[];
      for (const key of stringKeys) assertIJsonString(key);
      stringKeys.sort(); // RFC 8785 property-name order is UTF-16 code-unit order.
      const entries: string[] = [];
      accountAscii('{}');
      for (let index = 0; index < stringKeys.length; index += 1) {
        const key = stringKeys[index]!;
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ) {
          throw new TypeError('object fields must be enumerable data properties');
        }
        if (index !== 0) accountAscii(',');
        const encodedKey = JSON.stringify(key);
        accountUtf8(encodedKey);
        accountAscii(':');
        entries.push(`${encodedKey}:${encode(descriptor.value, depth + 1)}`);
      }
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(input);
    }
  };

  const result = encode(value, 0);
  return result;
}

/** Exact JCS document framing used by the contract: one and only one trailing LF. */
export function canonicalDocument(value: CanonicalValue): string {
  return `${canonicalize(value)}\n`;
}

function assertIJsonString(value: string): void {
  if (value.length > MAX_STRING_CODE_UNITS) throw new RangeError('JSON string ceiling exceeded');
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('lone high surrogate is not I-JSON');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('lone low surrogate is not I-JSON');
    }
  }
}
