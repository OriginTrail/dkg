import { describe, expect, it } from 'vitest';

import {
  computeEmptyKaChunkTreeRootV1,
  computeKaChunkLeafDigestV1,
  computeKaChunkTreeRootV1,
  type KaChunkTreeV1ErrorCode,
} from '../src/ka-chunk-tree.js';

const EMPTY_EMPTY_BUNDLE = fromHex('00000000000000000000000000000000');

describe('RFC-64 dormant KA chunk tree', () => {
  it('matches the empty-tree and one-bundle-chunk conformance roots', () => {
    expect(computeEmptyKaChunkTreeRootV1()).toBe(
      '0x558df3a0a75720f66c27b95906ed3992256105f43694c9d7f592cd334662f0f1',
    );
    expect(computeKaChunkTreeRootV1(EMPTY_EMPTY_BUNDLE)).toBe(
      '0xfb8fec167dc39ee7bc316afaff45d2d259e8a183af31a97a7cb736fc41c5b12f',
    );
  });

  it('binds every leaf to its zero-based index and exact byte length', () => {
    const bytes = fromHex('616263');
    expect(computeKaChunkLeafDigestV1(0n, bytes)).toBe(
      '0xcad222080b737db774460c9e8618ff9dc4537917a44715b8804fe73915562f6c',
    );
    expect(computeKaChunkLeafDigestV1(1n, bytes)).not.toBe(
      computeKaChunkLeafDigestV1(0n, bytes),
    );
    expect(computeKaChunkLeafDigestV1(0n, fromHex('6162'))).not.toBe(
      computeKaChunkLeafDigestV1(0n, bytes),
    );
  });

  it('matches deterministic two-, three-, and five-chunk odd-tree vectors', () => {
    const chunks = Array.from({ length: 5 }, (_, index) => {
      const chunk = new Uint8Array(262_144);
      chunk.fill(index);
      return chunk;
    });
    const final = fromHex('a0a1a2a3a4a5a6');

    expect(computeKaChunkTreeRootV1(concat(chunks[0], final))).toBe(
      '0xdff4f667510303304a1fa0fab500d5f889089ce3baac72c213fdb4df9b5c5493',
    );
    expect(computeKaChunkTreeRootV1(concat(chunks[0], chunks[1], final))).toBe(
      '0x80f90776eb169f7d125c41fb842f00c8a6d08093ef522ef8c5015bf169898338',
    );
    expect(
      computeKaChunkTreeRootV1(
        concat(chunks[0], chunks[1], chunks[2], chunks[3], final),
      ),
    ).toBe('0x1177b2daacaca40ff38bc21641ae3f729956708f22c9485e9854f5343692ce2d');
  });

  it('uses exact consecutive 256 KiB slices and a shorter final chunk', () => {
    const bytes = new Uint8Array(262_145);
    bytes[262_144] = 0xff;
    const twoChunkRoot = computeKaChunkTreeRootV1(bytes);
    bytes[262_143] = 0xff;
    expect(computeKaChunkTreeRootV1(bytes)).not.toBe(twoChunkRoot);
  });

  it('rejects transfer lengths outside 16..1 GiB and empty leaves', () => {
    expectFailureCode(
      () => computeKaChunkTreeRootV1(new Uint8Array(15)),
      'chunk-tree-byte-length',
    );
    expectFailureCode(
      () => computeKaChunkLeafDigestV1(0n, new Uint8Array()),
      'chunk-byte-length',
    );
    expectFailureCode(
      () => computeKaChunkLeafDigestV1(0n, new Uint8Array(262_145)),
      'chunk-byte-length',
    );
  });

  it('rejects chunk indexes outside 0..4095', () => {
    expectFailureCode(
      () => computeKaChunkLeafDigestV1(-1n, fromHex('00')),
      'chunk-index',
    );
    expectFailureCode(
      () => computeKaChunkLeafDigestV1(4096n, fromHex('00')),
      'chunk-index',
    );
  });

  it('rejects shared or resizable backing memory before hashing', () => {
    expect(() => computeKaChunkTreeRootV1(new Uint8Array(new SharedArrayBuffer(16))))
      .toThrow(/shared backing memory/);
    expect(() => computeKaChunkLeafDigestV1(0n, new Uint8Array(new SharedArrayBuffer(1))))
      .toThrow(/shared backing memory/);

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
    expect(() => computeKaChunkTreeRootV1(new Uint8Array(backing)))
      .toThrow(/resizable backing memory/);
  });
});

function expectFailureCode(operation: () => unknown, expected: KaChunkTreeV1ErrorCode): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: unknown }).code).toBe(expected);
    return;
  }
  throw new Error(`expected operation to fail with ${expected}`);
}

function concat(...chunks: readonly Uint8Array[]): Uint8Array {
  const byteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new Error('invalid test hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
