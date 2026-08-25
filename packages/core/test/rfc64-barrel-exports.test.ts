import { describe, expect, it } from 'vitest';

// Import strictly through the package barrel so this test fails if a newly
// exposed RFC-64 symbol is dropped from src/index.ts, even while the direct
// module-level behavior tests stay green.
import {
  MAX_KA_TRANSFER_BYTES_V1,
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  assertCanonicalHexBytes,
  assertCanonicalKaId,
  assertCanonicalTimestampMs,
  assertKaTransferDescriptorV1,
  canonicalizeKaTransferDescriptorV1,
  parseCanonicalDecimalU64,
  parseCanonicalDecimalU256,
  parseCanonicalKaTransferDescriptorV1,
} from '../src/index.js';

const VALID_MIN = {
  codec: 'dkg-ka-bundle-v1',
  projectionId: 'cg-shared-v1',
  projectionDigest: `0x${'00'.repeat(32)}`,
  byteLength: '16',
  chunkSize: '262144',
  chunkCount: '1',
  blobDigest: `0x${'11'.repeat(32)}`,
  chunkTreeRoot: `0x${'22'.repeat(32)}`,
};
const VALID_MIN_CANONICAL =
  '{"blobDigest":"0x1111111111111111111111111111111111111111111111111111111111111111","byteLength":"16","chunkCount":"1","chunkSize":"262144","chunkTreeRoot":"0x2222222222222222222222222222222222222222222222222222222222222222","codec":"dkg-ka-bundle-v1","projectionDigest":"0x0000000000000000000000000000000000000000000000000000000000000000","projectionId":"cg-shared-v1"}';

describe('RFC-64 transfer descriptor + wire scalars public package barrel', () => {
  it('re-exports the KA transfer descriptor API from ../src/index.js', () => {
    expect(typeof assertKaTransferDescriptorV1).toBe('function');
    expect(MAX_KA_TRANSFER_BYTES_V1).toBe(1_073_741_824n);
    expect(() => assertKaTransferDescriptorV1(VALID_MIN)).not.toThrow();
    expect(canonicalizeKaTransferDescriptorV1(VALID_MIN)).toBe(VALID_MIN_CANONICAL);
    expect(parseCanonicalKaTransferDescriptorV1(VALID_MIN_CANONICAL)).toEqual(VALID_MIN);
  });

  it('re-exports the full canonical wire scalar API from ../src/index.js', () => {
    // Export-surface check: every newly exposed scalar symbol must be present on
    // the barrel, so dropping any from src/index.ts fails here.
    for (const [name, fn] of [
      ['assertCanonicalChainId', assertCanonicalChainId],
      ['assertCanonicalDecimalU64', assertCanonicalDecimalU64],
      ['assertCanonicalDecimalU256', assertCanonicalDecimalU256],
      ['assertCanonicalDigest', assertCanonicalDigest],
      ['assertCanonicalHexBytes', assertCanonicalHexBytes],
      ['assertCanonicalKaId', assertCanonicalKaId],
      ['assertCanonicalTimestampMs', assertCanonicalTimestampMs],
      ['parseCanonicalDecimalU64', parseCanonicalDecimalU64],
      ['parseCanonicalDecimalU256', parseCanonicalDecimalU256],
    ] as const) {
      expect(typeof fn, name).toBe('function');
    }
    // Representative behavior through the barrel.
    expect(() => assertCanonicalDecimalU64('16', 'byteLength')).not.toThrow();
    expect(() => assertCanonicalDecimalU64('01', 'byteLength')).toThrow();
    expect(parseCanonicalDecimalU256('255', 'x')).toBe(255n);
    expect(() => assertCanonicalDigest(`0x${'11'.repeat(32)}`, 'digest')).not.toThrow();
    expect(() => assertCanonicalDigest(`0x${'GG'.repeat(32)}`, 'digest')).toThrow();
  });
});
