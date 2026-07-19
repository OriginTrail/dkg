import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import {
  MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1,
  assertKaTransferDescriptorV1,
  canonicalizeKaTransferDescriptorBytesV1,
  canonicalizeKaTransferDescriptorV1,
  parseCanonicalKaTransferDescriptorV1,
  type KaTransferDescriptorV1,
} from '../src/ka-transfer-descriptor.js';

const ZERO_DIGEST = `0x${'00'.repeat(32)}`;
const BLOB_DIGEST = `0x${'11'.repeat(32)}`;
const CHUNK_TREE_ROOT = `0x${'22'.repeat(32)}`;

const VALID_MIN = validatedDescriptor({
  codec: 'dkg-ka-bundle-v1',
  projectionId: 'cg-shared-v1',
  projectionDigest: ZERO_DIGEST,
  byteLength: '16',
  chunkSize: '262144',
  chunkCount: '1',
  blobDigest: BLOB_DIGEST,
  chunkTreeRoot: CHUNK_TREE_ROOT,
});

// Normative RFC-64 fixture. Keep this literal independent from implementation output.
const VALID_MIN_CANONICAL =
  '{"blobDigest":"0x1111111111111111111111111111111111111111111111111111111111111111","byteLength":"16","chunkCount":"1","chunkSize":"262144","chunkTreeRoot":"0x2222222222222222222222222222222222222222222222222222222222222222","codec":"dkg-ka-bundle-v1","projectionDigest":"0x0000000000000000000000000000000000000000000000000000000000000000","projectionId":"cg-shared-v1"}';
const VALID_MIN_FIXTURE_SHA256 =
  'd3f1088dd50f7077865e8cf49e4e22d0aedba63720faa025ec8c89537cb7c80a';

describe('KaTransferDescriptorV1', () => {
  it('pins the exact canonical valid-min fixture and independent fixture digest', () => {
    expect(canonicalizeKaTransferDescriptorV1(VALID_MIN)).toBe(VALID_MIN_CANONICAL);
    const bytes = canonicalizeKaTransferDescriptorBytesV1(VALID_MIN);
    expect(bytes.byteLength).toBe(369);
    expect(lowerHex(sha256(bytes))).toBe(VALID_MIN_FIXTURE_SHA256);
    expect(parseCanonicalKaTransferDescriptorV1(bytes)).toEqual(VALID_MIN);
  });

  it.each([
    ['minimum', '16', '1', 369],
    ['last byte of first chunk', '262144', '1', 373],
    ['first byte of second chunk', '262145', '2', 373],
    ['maximum', '1073741824', '4096', 380],
  ])('accepts the %s boundary', (_name, byteLength, chunkCount, canonicalLength) => {
    const descriptor = { ...VALID_MIN, byteLength, chunkCount };
    assertKaTransferDescriptorV1(descriptor);
    expect(canonicalizeKaTransferDescriptorV1(descriptor).length).toBe(canonicalLength);
  });

  it('strictly accepts canonical bytes only', () => {
    expect(parseCanonicalKaTransferDescriptorV1(VALID_MIN_CANONICAL)).toEqual(VALID_MIN);
    expect(() => parseCanonicalKaTransferDescriptorV1(` ${VALID_MIN_CANONICAL}`)).toThrow(
      /not RFC 8785 canonical/,
    );
    const reordered = JSON.stringify(VALID_MIN);
    expect(reordered).not.toBe(VALID_MIN_CANONICAL);
    expect(() => parseCanonicalKaTransferDescriptorV1(reordered)).toThrow(
      /not RFC 8785 canonical/,
    );
  });

  it.each([
    ['under-min', '15', '1'],
    ['over-max', '1073741825', '4097'],
  ])('rejects the %s byte-length boundary', (_name, byteLength, chunkCount) => {
    expect(() => assertKaTransferDescriptorV1({
      ...VALID_MIN,
      byteLength,
      chunkCount,
    })).toThrow(/descriptor-byte-length/);
  });

  it.each([
    ['262145', '1'],
    ['16', '0'],
    ['1073741824', '4095'],
    ['1073741824', '4097'],
  ])('rejects byteLength=%s with chunkCount=%s', (byteLength, chunkCount) => {
    expect(() => assertKaTransferDescriptorV1({
      ...VALID_MIN,
      byteLength,
      chunkCount,
    })).toThrow(/descriptor-chunk-count/);
  });

  it.each([
    ['byteLength', 16],
    ['byteLength', '016'],
    ['byteLength', '+16'],
    ['byteLength', '18446744073709551616'],
    ['chunkCount', 1],
    ['chunkCount', '01'],
  ])('rejects noncanonical unsigned %s=%j', (field, value) => {
    expect(() => assertKaTransferDescriptorV1({
      ...VALID_MIN,
      [field]: value,
    })).toThrow(/noncanonical-unsigned-integer/);
  });

  it.each(['262143', 262144, null])('rejects noncanonical chunkSize=%j', (chunkSize) => {
    expect(() => assertKaTransferDescriptorV1({
      ...VALID_MIN,
      chunkSize,
    })).toThrow(/descriptor-chunk-size/);
  });

  it('rejects malformed digest strings but permits the all-zero structural digest', () => {
    expect(() => assertKaTransferDescriptorV1(VALID_MIN)).not.toThrow();
    expect(() => assertKaTransferDescriptorV1({
      ...VALID_MIN,
      projectionDigest: `0x${'AA'.repeat(32)}`,
    })).toThrow(/noncanonical-digest/);
    expect(() => assertKaTransferDescriptorV1({
      ...VALID_MIN,
      projectionDigest: `0x${'00'.repeat(31)}`,
    })).toThrow(/noncanonical-digest/);
    expect(() => assertKaTransferDescriptorV1({
      ...VALID_MIN,
      blobDigest: null,
    })).toThrow(/descriptor-schema/);
  });

  it('rejects missing, extra, objectType, wrapper, accessor, and symbol fields', () => {
    const missing = { ...VALID_MIN } as Partial<KaTransferDescriptorV1>;
    delete missing.blobDigest;
    expect(() => assertKaTransferDescriptorV1(missing)).toThrow(/descriptor-schema/);
    expect(() => assertKaTransferDescriptorV1({ ...VALID_MIN, extra: true })).toThrow(
      /descriptor-schema/,
    );
    expect(() => assertKaTransferDescriptorV1({
      ...VALID_MIN,
      objectType: 'KaTransferDescriptorV1',
    })).toThrow(/descriptor-schema/);
    expect(() => assertKaTransferDescriptorV1({ transfer: VALID_MIN })).toThrow(
      /descriptor-schema/,
    );

    const accessor = { ...VALID_MIN };
    Object.defineProperty(accessor, 'blobDigest', {
      enumerable: true,
      get: () => BLOB_DIGEST,
    });
    expect(() => assertKaTransferDescriptorV1(accessor)).toThrow(/descriptor-schema/);

    const symbol = { ...VALID_MIN } as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;
    expect(() => assertKaTransferDescriptorV1(symbol)).toThrow(/descriptor-schema/);
  });

  it('rejects a 513-byte input before attempting JSON materialization', () => {
    const hostile = '{'.padEnd(MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1 + 1, 'x');
    expect(new TextEncoder().encode(hostile).byteLength).toBe(513);
    expect(() => parseCanonicalKaTransferDescriptorV1(hostile)).toThrow(/object-too-large/);
  });

  it('enforces the flat-object depth cap before schema validation', () => {
    expect(() => parseCanonicalKaTransferDescriptorV1('{"nested":{}}')).toThrow(
      /nesting exceeds 1/,
    );
  });
});

function lowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validatedDescriptor(value: unknown): KaTransferDescriptorV1 {
  assertKaTransferDescriptorV1(value);
  return value;
}
