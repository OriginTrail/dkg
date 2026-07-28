// SPDX-License-Identifier: Apache-2.0

/**
 * Shared, package-private RFC-64 catalog transport wire primitives.
 *
 * Protocol modules retain their own typed validators, byte ceilings, and
 * public error classes. This module owns only byte-identical framing and the
 * security-sensitive scalar/proof checks that must not drift between catalog
 * protocols.
 */

import {
  computeControlSignatureVariantDigestHex,
  type EvmAddressV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  readVerifiedControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

const MAX_PEER_ID_BYTES_V1 = 256;
const UTF8 = new TextEncoder();
// Keep a leading BOM visible so canonical re-encoding rejects it.
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type Rfc64CatalogTransportWireUtilityErrorReasonV1 =
  | 'plain-object'
  | 'field-shape'
  | 'oversized'
  | 'strict-json'
  | 'exact-keys'
  | 'noncanonical'
  | 'evm-address'
  | 'peer-id-type'
  | 'peer-id-canonical'
  | 'issuer-proof-unminted'
  | 'issuer-proof-mismatch'
  | 'response-size'
  | 'response-trailing'
  | 'response-status';

export class Rfc64CatalogTransportWireUtilityErrorV1 extends Error {
  constructor(
    readonly reason: Rfc64CatalogTransportWireUtilityErrorReasonV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'Rfc64CatalogTransportWireUtilityErrorV1';
  }
}

export interface Rfc64CatalogTransportWireErrorMappingV1<Code extends string> {
  readonly code: Code;
  readonly message: string | ((cause: Rfc64CatalogTransportWireUtilityErrorV1) => string);
}

/**
 * Central adapter from package-private wire failures to one protocol's public
 * error vocabulary. Protocol modules declare a compact reason table instead
 * of duplicating catch ladders whenever the shared wire taxonomy evolves.
 */
export function rethrowRfc64CatalogTransportWireUtilityErrorV1<Code extends string>(
  cause: unknown,
  fail: (code: Code, message: string, cause?: unknown) => never,
  mappings: Partial<Record<
    Rfc64CatalogTransportWireUtilityErrorReasonV1,
    Rfc64CatalogTransportWireErrorMappingV1<Code>
  >>,
  fallback?: Rfc64CatalogTransportWireErrorMappingV1<Code>,
): never {
  if (!(cause instanceof Rfc64CatalogTransportWireUtilityErrorV1)) throw cause;
  const mapping = mappings[cause.reason] ?? fallback;
  if (mapping === undefined) throw cause;
  fail(
    mapping.code,
    typeof mapping.message === 'function' ? mapping.message(cause) : mapping.message,
    cause,
  );
}

export interface Rfc64CatalogTransportWireAdapterMessagesV1 {
  readonly encodePlainObject: string;
  readonly encodeFieldShape: string;
  readonly encodeOversized: (maxBytes: number) => string;
  readonly parseOversized: string;
  readonly parseStrictJson: string;
  readonly parsePlainObject: string;
  readonly parseExactKeys: string;
  readonly parseNoncanonical: string;
  readonly snapshot: string | ((cause: Rfc64CatalogTransportWireUtilityErrorV1) => string);
  readonly evmAddress: (label: string) => string;
  readonly peerIdType: string;
  readonly peerIdCanonical: string;
}

export interface Rfc64CatalogTransportWireAdapterV1 {
  encodeFlatCanonicalJson(value: object, maxBytes: number): Uint8Array;
  parseFlatCanonicalJson(
    input: Uint8Array,
    expectedKeys: readonly string[],
    maxBytes: number,
  ): Readonly<Record<string, unknown>>;
  snapshotExactWireRecord(
    value: unknown,
    expectedKeys: readonly string[],
  ): Readonly<Record<string, unknown>>;
  assertCanonicalEvmAddress(value: unknown, label: string): asserts value is EvmAddressV1;
  snapshotPeerId(value: unknown): string;
}

/** Build one protocol-family adapter around the shared catalog wire codec. */
export function createRfc64CatalogTransportWireAdapterV1<Code extends string>(options: {
  readonly fail: (code: Code, message: string, cause?: unknown) => never;
  readonly wireCode: Code;
  readonly inputCode: Code;
  readonly messages: Rfc64CatalogTransportWireAdapterMessagesV1;
}): Rfc64CatalogTransportWireAdapterV1 {
  const { fail, wireCode, inputCode, messages } = options;
  return Object.freeze({
    encodeFlatCanonicalJson(value: object, maxBytes: number): Uint8Array {
      try {
        return encodeRfc64FlatCanonicalJsonV1(value, maxBytes);
      } catch (cause) {
        rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {
          'plain-object': { code: wireCode, message: messages.encodePlainObject },
          'field-shape': { code: wireCode, message: messages.encodeFieldShape },
          oversized: { code: wireCode, message: messages.encodeOversized(maxBytes) },
        });
      }
    },
    parseFlatCanonicalJson(
      input: Uint8Array,
      expectedKeys: readonly string[],
      maxBytes: number,
    ): Readonly<Record<string, unknown>> {
      try {
        return parseRfc64FlatCanonicalJsonV1(input, expectedKeys, maxBytes);
      } catch (cause) {
        rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {
          oversized: { code: wireCode, message: messages.parseOversized },
          'strict-json': { code: wireCode, message: messages.parseStrictJson },
          'plain-object': { code: wireCode, message: messages.parsePlainObject },
          'exact-keys': { code: wireCode, message: messages.parseExactKeys },
          noncanonical: { code: wireCode, message: messages.parseNoncanonical },
        });
      }
    },
    snapshotExactWireRecord(
      value: unknown,
      expectedKeys: readonly string[],
    ): Readonly<Record<string, unknown>> {
      try {
        return snapshotRfc64ExactWireRecordV1(value, expectedKeys);
      } catch (cause) {
        rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {}, {
          code: wireCode,
          message: messages.snapshot,
        });
      }
    },
    assertCanonicalEvmAddress(
      value: unknown,
      label: string,
    ): asserts value is EvmAddressV1 {
      try {
        assertRfc64CanonicalEvmAddressV1(value, label);
      } catch (cause) {
        rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {}, {
          code: wireCode,
          message: messages.evmAddress(label),
        });
      }
    },
    snapshotPeerId(value: unknown): string {
      try {
        return snapshotRfc64PeerIdV1(value);
      } catch (cause) {
        rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {
          'peer-id-type': { code: inputCode, message: messages.peerIdType },
        }, {
          code: inputCode,
          message: messages.peerIdCanonical,
        });
      }
    },
  });
}

export function encodeRfc64FlatCanonicalJsonV1(
  value: object,
  maxBytes: number,
): Uint8Array {
  const snapshot = snapshotRfc64ExactWireRecordV1(value, undefined);
  const fields: string[] = [];
  for (const key of Object.keys(snapshot).sort()) {
    const field = snapshot[key];
    if (field !== null && typeof field !== 'string') {
      utilityFail('field-shape', 'RFC-64 flat canonical JSON accepts only string or null fields');
    }
    fields.push(`${JSON.stringify(key)}:${JSON.stringify(field)}`);
  }
  const bytes = UTF8.encode(`{${fields.join(',')}}`);
  if (bytes.byteLength > maxBytes) {
    utilityFail('oversized', `RFC-64 flat canonical JSON exceeds ${maxBytes} bytes`);
  }
  return bytes;
}

export function parseRfc64FlatCanonicalJsonV1(
  input: Uint8Array,
  expectedKeys: readonly string[],
  maxBytes: number,
): Readonly<Record<string, unknown>> {
  if (!(input instanceof Uint8Array) || input.byteLength < 2 || input.byteLength > maxBytes) {
    utilityFail('oversized', 'RFC-64 flat canonical JSON is empty or oversized');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_FATAL.decode(input));
  } catch (cause) {
    utilityFail('strict-json', 'RFC-64 flat canonical JSON is not strict UTF-8 JSON', cause);
  }
  const snapshot = snapshotRfc64ExactWireRecordV1(parsed, expectedKeys);
  if (!rfc64WireBytesEqualV1(encodeRfc64FlatCanonicalJsonV1(snapshot, maxBytes), input)) {
    utilityFail('noncanonical', 'RFC-64 flat JSON bytes are not canonical JCS');
  }
  return snapshot;
}

/**
 * Snapshot own enumerable data properties exactly once. This rejects accessor
 * and Proxy switching attacks without invoking caller-controlled getters.
 */
export function snapshotRfc64ExactWireRecordV1(
  value: unknown,
  expectedKeys: readonly string[] | undefined,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    utilityFail('plain-object', 'RFC-64 wire value must be a plain object');
  }
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch (cause) {
    utilityFail('exact-keys', 'RFC-64 wire fields could not be inspected', cause);
  }
  if (ownKeys.some((key) => typeof key !== 'string')) {
    utilityFail('exact-keys', 'RFC-64 wire value has symbol fields');
  }
  const actual = [...ownKeys as readonly string[]].sort();
  const expected = expectedKeys === undefined ? undefined : [...expectedKeys].sort();
  if (
    expected !== undefined
    && (
      actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])
    )
  ) {
    utilityFail('exact-keys', 'RFC-64 wire value has missing or unknown fields');
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of actual) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch (cause) {
      utilityFail('exact-keys', 'RFC-64 wire field descriptor could not be inspected', cause);
    }
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      utilityFail('exact-keys', 'RFC-64 wire fields must be enumerable data properties');
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

export function assertRfc64CanonicalEvmAddressV1(
  value: unknown,
  label: string,
): asserts value is EvmAddressV1 {
  if (
    typeof value !== 'string'
    || !/^0x[0-9a-f]{40}$/.test(value)
    || value === '0x0000000000000000000000000000000000000000'
  ) {
    utilityFail(
      'evm-address',
      `${label} must be a canonical lowercase nonzero EVM address`,
    );
  }
}

export function snapshotRfc64PeerIdV1(value: unknown): string {
  if (typeof value !== 'string') {
    utilityFail('peer-id-type', 'remotePeerId must be a string');
  }
  const byteLength = UTF8.encode(value).byteLength;
  if (byteLength < 1 || byteLength > MAX_PEER_ID_BYTES_V1 || value.trim() !== value) {
    utilityFail('peer-id-canonical', 'remotePeerId is empty, oversized, or noncanonical');
  }
  return value;
}

export function assertRfc64ExactIssuerSignatureProofV1(
  envelope: SignedControlEnvelopeV1,
  proof: VerifiedControlEnvelopeIssuerSignatureV1,
): void {
  let snapshot;
  try {
    snapshot = readVerifiedControlEnvelopeIssuerSignatureV1(proof);
  } catch (cause) {
    utilityFail('issuer-proof-unminted', 'issuer signature proof was not minted by the verifier', cause);
  }
  const expectedVariant = computeControlSignatureVariantDigestHex(
    envelope.objectDigest,
    envelope.signature,
  );
  if (
    snapshot.objectDigest !== envelope.objectDigest
    || snapshot.signatureVariantDigest !== expectedVariant
    || snapshot.issuer !== envelope.issuer
    || snapshot.signatureSuite !== envelope.signatureSuite
  ) {
    utilityFail('issuer-proof-mismatch', 'issuer signature proof is not bound to the exact envelope');
  }
}

export function encodeRfc64FoundStatusResponseV1(
  payload: Uint8Array,
  maxBytes?: number,
): Uint8Array {
  const result = new Uint8Array(payload.byteLength + 1);
  result[0] = 1;
  result.set(payload, 1);
  if (maxBytes !== undefined && result.byteLength > maxBytes) {
    utilityFail('response-size', 'RFC-64 found response exceeds its byte ceiling');
  }
  return result;
}

export type Rfc64StatusResponsePayloadV1 =
  | { readonly status: 'not-found' }
  | { readonly status: 'found'; readonly payload: Uint8Array }
  | { readonly status: 'denied' };

export function parseRfc64StatusResponsePayloadV1(
  input: Uint8Array,
  maxBytes: number,
): Rfc64StatusResponsePayloadV1 {
  if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > maxBytes) {
    utilityFail('response-size', 'RFC-64 status response is empty or oversized');
  }
  const status = input[0];
  if (status === 0 || status === 2) {
    if (input.byteLength !== 1) {
      utilityFail('response-trailing', 'RFC-64 status-only response has trailing bytes');
    }
    return Object.freeze({ status: status === 0 ? 'not-found' : 'denied' });
  }
  if (status !== 1 || input.byteLength === 1) {
    utilityFail('response-status', 'RFC-64 status response has an invalid status');
  }
  return Object.freeze({ status: 'found', payload: input.subarray(1) });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (cause) {
    utilityFail('plain-object', 'RFC-64 wire value prototype could not be inspected', cause);
  }
  return prototype === Object.prototype || prototype === null;
}

function rfc64WireBytesEqualV1(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function utilityFail(
  reason: Rfc64CatalogTransportWireUtilityErrorReasonV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64CatalogTransportWireUtilityErrorV1(
    reason,
    message,
    cause === undefined ? {} : { cause },
  );
}
