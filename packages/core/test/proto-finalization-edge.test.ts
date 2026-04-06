/**
 * Finalization proto encode/decode edge cases (uint64 bounds, garbage input).
 */
import { describe, it, expect } from 'vitest';
import { encodeFinalizationMessage, decodeFinalizationMessage } from '../src/proto/finalization.js';

const MAX_UINT64 = (1n << 64n) - 1n;

function minimalFinalization(overrides: Record<string, unknown> = {}) {
  return {
    ual: 'did:dkg:evm:31337/0x0/1',
    paranetId: 'p',
    kcMerkleRoot: new Uint8Array(32),
    txHash: '0xab',
    blockNumber: 1,
    batchId: 1,
    startKAId: 1,
    endKAId: 1,
    publisherAddress: '0x1111111111111111111111111111111111111111',
    rootEntities: [] as string[],
    timestampMs: 1,
    ...overrides,
  };
}

describe('encodeFinalizationMessage uint64 bounds', () => {
  it('accepts bigint at uint64 max', () => {
    const buf = encodeFinalizationMessage(
      minimalFinalization({
        blockNumber: MAX_UINT64,
        batchId: MAX_UINT64,
        startKAId: MAX_UINT64,
        endKAId: MAX_UINT64,
        timestampMs: MAX_UINT64,
      }) as any,
    );
    const dec = decodeFinalizationMessage(buf);
    expect(BigInt(dec.blockNumber as any)).toBe(MAX_UINT64);
  });

  it('throws RangeError when any uint64 field overflows', () => {
    expect(() =>
      encodeFinalizationMessage(minimalFinalization({ batchId: MAX_UINT64 + 1n }) as any),
    ).toThrow(RangeError);
    expect(() =>
      encodeFinalizationMessage(minimalFinalization({ timestampMs: -1n }) as any),
    ).toThrow(RangeError);
  });
});

describe('decodeFinalizationMessage robustness', () => {
  it('decodes truncated buffer without throwing (protobufjs default)', () => {
    const dec = decodeFinalizationMessage(new Uint8Array([0x0a, 0x01, 0x41]));
    expect(typeof dec.ual).toBe('string');
  });

  it('round-trip preserves contextGraphId when set', () => {
    const msg = minimalFinalization({ contextGraphId: 'cg-hex' }) as any;
    const dec = decodeFinalizationMessage(encodeFinalizationMessage(msg));
    expect(dec.contextGraphId).toBe('cg-hex');
  });
});
