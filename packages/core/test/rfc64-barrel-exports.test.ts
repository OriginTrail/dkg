import { describe, expect, it } from 'vitest';

// Import strictly through the package barrel so this test fails if a newly
// exposed RFC-64 symbol is dropped from src/index.ts, even while the direct
// module-level behavior tests stay green.
import {
  MAX_KA_TRANSFER_BYTES_V1,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertKaTransferDescriptorV1,
  canonicalizeKaTransferDescriptorV1,
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

  it('re-exports the canonical wire scalar validators from ../src/index.js', () => {
    expect(typeof assertCanonicalDecimalU64).toBe('function');
    expect(typeof assertCanonicalDigest).toBe('function');
    expect(() => assertCanonicalDecimalU64('16', 'byteLength')).not.toThrow();
    expect(() => assertCanonicalDecimalU64('01', 'byteLength')).toThrow();
    expect(() => assertCanonicalDigest(`0x${'11'.repeat(32)}`, 'digest')).not.toThrow();
    expect(() => assertCanonicalDigest(`0x${'GG'.repeat(32)}`, 'digest')).toThrow();
  });
});
