import { describe, expect, it } from 'vitest';

import {
  MAX_KA_BUNDLE_BYTES_V1,
  assertOpaqueKaBundleByteLengthV1,
  calculateOpaqueKaBundleByteLengthV1,
  computeKaProjectionDigestV1,
  decodeOpaqueKaBundleV1,
  encodeOpaqueKaBundleV1,
  type KaBundleV1ErrorCode,
} from '../src/ka-bundle-v1.js';

const EMPTY_EMPTY_BUNDLE = '00000000000000000000000000000000';
const EMPTY_PROJECTION_DIGEST =
  '0x4d798c66290f2feed54b20ad25eab62df38360cab298332be5e6d921ad1b5f3c';
const EMPTY_EMPTY_BLOB_DIGEST =
  '0x83bb2c1cb5e6d45dd63f06f085d1167f0a8b8b504be1117b839c479f1546ea18';

const A_BC_BUNDLE = '00000000000000016100000000000000026263';
const A_PROJECTION_DIGEST =
  '0xdae61dbbf6d5ff323951a573fda1ec18a51c77a00811a4574adc2639e0ed72cb';
const A_BC_BLOB_DIGEST =
  '0xd632761c3a93b54f7e84ec45934bec3eb4a32508f50e8d37927f7dff0e52f17c';

describe('RFC-64 dormant opaque KA bundle framing', () => {
  it('matches the exact empty-empty conformance vector', () => {
    const encoded = encodeOpaqueKaBundleV1(new Uint8Array(), new Uint8Array());
    expect(lowerHex(encoded.bundleBytes)).toBe(EMPTY_EMPTY_BUNDLE);
    expect(encoded.projectionDigest).toBe(EMPTY_PROJECTION_DIGEST);
    expect(encoded.blobDigest).toBe(EMPTY_EMPTY_BLOB_DIGEST);

    const decoded = decodeOpaqueKaBundleV1(fromHex(EMPTY_EMPTY_BUNDLE));
    expect(decoded.projectionBytes).toEqual(new Uint8Array());
    expect(decoded.sealBytes).toEqual(new Uint8Array());
    expect(decoded.projectionDigest).toBe(EMPTY_PROJECTION_DIGEST);
    expect(decoded.blobDigest).toBe(EMPTY_EMPTY_BLOB_DIGEST);
  });

  it('matches the exact a-bc conformance vector in network byte order', () => {
    const encoded = encodeOpaqueKaBundleV1(fromHex('61'), fromHex('6263'));
    expect(lowerHex(encoded.bundleBytes)).toBe(A_BC_BUNDLE);
    expect(encoded.projectionDigest).toBe(A_PROJECTION_DIGEST);
    expect(computeKaProjectionDigestV1(fromHex('61'))).toBe(A_PROJECTION_DIGEST);
    expect(encoded.blobDigest).toBe(A_BC_BLOB_DIGEST);

    const decoded = decodeOpaqueKaBundleV1(fromHex(A_BC_BUNDLE));
    expect(lowerHex(decoded.projectionBytes)).toBe('61');
    expect(lowerHex(decoded.sealBytes)).toBe('6263');
    expect(decoded.projectionDigest).toBe(A_PROJECTION_DIGEST);
    expect(decoded.blobDigest).toBe(A_BC_BLOB_DIGEST);
  });

  it('returns zero-copy component views from a decoded bundle', () => {
    const bundle = fromHex(A_BC_BUNDLE);
    const decoded = decodeOpaqueKaBundleV1(bundle);
    expect(decoded.projectionBytes.buffer).toBe(bundle.buffer);
    expect(decoded.sealBytes.buffer).toBe(bundle.buffer);
    expect(decoded.projectionBytes.byteOffset).toBe(bundle.byteOffset + 8);
    expect(decoded.sealBytes.byteOffset).toBe(bundle.byteOffset + 17);
  });

  it('rejects shared backing memory before copying, parsing, or hashing', () => {
    const sharedProjection = new Uint8Array(new SharedArrayBuffer(1));
    sharedProjection[0] = 0x61;
    const sharedSeal = new Uint8Array(new SharedArrayBuffer(1));
    sharedSeal[0] = 0x62;
    const sharedBundle = new Uint8Array(new SharedArrayBuffer(16));

    expect(() => encodeOpaqueKaBundleV1(sharedProjection, new Uint8Array()))
      .toThrow(/shared backing memory/);
    expect(() => encodeOpaqueKaBundleV1(new Uint8Array(), sharedSeal))
      .toThrow(/shared backing memory/);
    expect(() => decodeOpaqueKaBundleV1(sharedBundle)).toThrow(/shared backing memory/);
  });

  it('rejects resizable ArrayBuffer views when the runtime supports them', () => {
    const ResizableArrayBuffer = ArrayBuffer as unknown as new (
      byteLength: number,
      options: { maxByteLength: number },
    ) => ArrayBuffer;
    let backing: ArrayBuffer;
    try {
      backing = new ResizableArrayBuffer(16, { maxByteLength: 32 });
    } catch {
      return;
    }
    if ((backing as ArrayBuffer & { readonly resizable?: boolean }).resizable !== true) return;
    expect(() => encodeOpaqueKaBundleV1(new Uint8Array(backing), new Uint8Array()))
      .toThrow(/resizable backing memory/);
    expect(() => encodeOpaqueKaBundleV1(new Uint8Array(), new Uint8Array(backing)))
      .toThrow(/resizable backing memory/);
    expect(() => decodeOpaqueKaBundleV1(new Uint8Array(backing)))
      .toThrow(/resizable backing memory/);
  });

  it('validates maximum arithmetic without allocating a 1 GiB fixture', () => {
    expect(calculateOpaqueKaBundleByteLengthV1(1_073_741_808n, 0n)).toBe(
      MAX_KA_BUNDLE_BYTES_V1,
    );
    expectFailureCode(
      () => calculateOpaqueKaBundleByteLengthV1(1_073_741_809n, 0n),
      'bundle-length-overflow',
    );
    expectFailureCode(
      () => calculateOpaqueKaBundleByteLengthV1(1_073_741_808n, 1n),
      'bundle-length-overflow',
    );
  });

  it('rejects total lengths outside 16..1 GiB before frame parsing', () => {
    expectFailureCode(
      () => assertOpaqueKaBundleByteLengthV1(15n),
      'bundle-byte-length',
    );
    expectFailureCode(
      () => assertOpaqueKaBundleByteLengthV1(1_073_741_825n),
      'bundle-byte-length',
    );
    expectFailureCode(
      () => decodeOpaqueKaBundleV1(new Uint8Array(15)),
      'bundle-byte-length',
    );
    expectFailureCode(
      () => decodeOpaqueKaBundleV1(new Uint8Array(7)),
      'bundle-byte-length',
    );
  });

  it('rejects truncated projection and seal payloads', () => {
    // projection length 1, but no projection byte plus complete second prefix
    expectFailureCode(
      () => decodeOpaqueKaBundleV1(fromHex(
        '00000000000000010000000000000000',
      )),
      'bundle-truncated',
    );

    // empty projection, declared one-byte seal, no seal payload
    expectFailureCode(
      () => decodeOpaqueKaBundleV1(fromHex(
        '00000000000000000000000000000001',
      )),
      'bundle-truncated',
    );
  });

  it('rejects projection and seal u64 declarations outside the v1 total bound', () => {
    expectFailureCode(
      () => decodeOpaqueKaBundleV1(fromHex(
        'ffffffffffffffff0000000000000000',
      )),
      'bundle-length-overflow',
    );
    expectFailureCode(
      () => decodeOpaqueKaBundleV1(fromHex(
        '0000000000000000ffffffffffffffff',
      )),
      'bundle-length-overflow',
    );
  });

  it('rejects trailing bytes and never treats them as a second record', () => {
    expectFailureCode(
      () => decodeOpaqueKaBundleV1(fromHex(`${EMPTY_EMPTY_BUNDLE}00`)),
      'bundle-trailing-bytes',
    );
    expectFailureCode(
      () => decodeOpaqueKaBundleV1(fromHex(
        `${EMPTY_EMPTY_BUNDLE}${EMPTY_EMPTY_BUNDLE}`,
      )),
      'bundle-trailing-bytes',
    );
  });

  it('never reinterprets a little-endian projection length', () => {
    expectFailureCode(
      () => decodeOpaqueKaBundleV1(fromHex(
        '01000000000000006100000000000000026263',
      )),
      'bundle-length-overflow',
    );
  });

  it('rejects non-u64 and negative component arithmetic inputs', () => {
    expectFailureCode(
      () => calculateOpaqueKaBundleByteLengthV1(-1n, 0n),
      'bundle-length-overflow',
    );
    expectFailureCode(
      () => calculateOpaqueKaBundleByteLengthV1(18_446_744_073_709_551_616n, 0n),
      'bundle-length-overflow',
    );
  });
});

function expectFailureCode(operation: () => unknown, expected: KaBundleV1ErrorCode): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: unknown }).code).toBe(expected);
    return;
  }
  throw new Error(`expected operation to fail with ${expected}`);
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new Error('invalid test hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function lowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
