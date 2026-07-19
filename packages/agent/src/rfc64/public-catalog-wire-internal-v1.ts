// SPDX-License-Identifier: Apache-2.0

/**
 * Internal RFC-64 public-catalog wire primitives.
 *
 * The public/open catalog protocols each carried their own copy of the same
 * flat-JCS codec, peer-id snapshot, and EVM validator, so a canonicalization or
 * hardening change had to be made in several places and kept behaviourally
 * identical by hand. These helpers are the shared implementation.
 *
 * Every helper that can reject takes a {@link Rfc64WireFailV1}. Each protocol
 * keeps its own error class and code union, so sharing the logic must not share
 * the failure type: the caller binds its own `fail` and the thrown error is
 * exactly what it was before. Diagnostic text is passed in for the same reason —
 * the protocols word these messages differently and the wording is observable.
 *
 * Deliberately NOT shared: per-protocol key lists, typed field validators, and
 * key-presence checking. The current-head discovery protocol validates keys
 * through a strict own-descriptor snapshot that rejects switching Proxies and
 * accessors, while the catalog transport uses a plain key comparison. Folding
 * those together would silently change one protocol's admitted inputs, so
 * {@link parseFlatCanonicalJsonV1} takes the key check as a callback instead.
 */

import type { EvmAddressV1 } from '@origintrail-official/dkg-core';

const UTF8 = new TextEncoder();
// Keep a leading BOM visible so canonical re-encoding rejects it.
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Maximum accepted peer-id length. Identical across every RFC-64 transport. */
export const RFC64_WIRE_MAX_PEER_ID_BYTES_V1 = 256;

/** Raise the calling protocol's own wire error. Never returns. */
export type Rfc64WireFailV1 = (message: string, cause?: unknown) => never;

/** Exact diagnostic text for the flat-JCS codec, supplied per protocol. */
export interface Rfc64FlatWireDiagnosticsV1 {
  readonly notPlainObject: string;
  readonly nonStringField: string;
  readonly exceedsMaxBytes: (maxBytes: number) => string;
  readonly emptyOrOversized: string;
  readonly notStrictUtf8Json: string;
  readonly notPlainJsonObject: string;
  readonly notCanonical: string;
}

export function isPlainRecordV1(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function bytesEqualV1(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function snapshotWirePeerIdV1(value: unknown, fail: Rfc64WireFailV1): string {
  if (typeof value !== 'string') {
    fail('remotePeerId must be a string');
  }
  const byteLength = UTF8.encode(value).byteLength;
  if (
    byteLength < 1
    || byteLength > RFC64_WIRE_MAX_PEER_ID_BYTES_V1
    || value.trim() !== value
  ) {
    fail('remotePeerId is empty, oversized, or noncanonical');
  }
  return value;
}

export function assertCanonicalWireEvmAddressV1(
  value: unknown,
  label: string,
  fail: Rfc64WireFailV1,
): asserts value is EvmAddressV1 {
  if (
    typeof value !== 'string'
    || !/^0x[0-9a-f]{40}$/.test(value)
    || value === '0x0000000000000000000000000000000000000000'
  ) {
    fail(`${label} must be a canonical lowercase nonzero EVM address`);
  }
}

export function encodeFlatCanonicalJsonV1(
  value: object,
  maxBytes: number,
  diagnostics: Rfc64FlatWireDiagnosticsV1,
  fail: Rfc64WireFailV1,
): Uint8Array {
  if (!isPlainRecordV1(value)) {
    fail(diagnostics.notPlainObject);
  }
  const fields: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const field = value[key];
    if (field !== null && typeof field !== 'string') {
      fail(diagnostics.nonStringField);
    }
    fields.push(`${JSON.stringify(key)}:${JSON.stringify(field)}`);
  }
  const bytes = UTF8.encode(`{${fields.join(',')}}`);
  if (bytes.byteLength > maxBytes) {
    fail(diagnostics.exceedsMaxBytes(maxBytes));
  }
  return bytes;
}

/**
 * Parse exactly-canonical flat JCS bytes.
 *
 * `assertExactKeys` is the caller's key check, kept local because the protocols
 * differ on how strictly a record's own properties are inspected.
 */
export function parseFlatCanonicalJsonV1(
  input: Uint8Array,
  maxBytes: number,
  diagnostics: Rfc64FlatWireDiagnosticsV1,
  fail: Rfc64WireFailV1,
  assertExactKeys: (value: Record<string, unknown>) => void,
): Record<string, unknown> {
  if (!(input instanceof Uint8Array) || input.byteLength < 2 || input.byteLength > maxBytes) {
    fail(diagnostics.emptyOrOversized);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_FATAL.decode(input));
  } catch (cause) {
    fail(diagnostics.notStrictUtf8Json, cause);
  }
  if (!isPlainRecordV1(parsed)) {
    fail(diagnostics.notPlainJsonObject);
  }
  assertExactKeys(parsed);
  if (!bytesEqualV1(encodeFlatCanonicalJsonV1(parsed, maxBytes, diagnostics, fail), input)) {
    fail(diagnostics.notCanonical);
  }
  return parsed;
}
