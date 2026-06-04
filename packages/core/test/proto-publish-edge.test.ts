/**
 * Publish proto encode/decode edge cases for precision-sensitive uint64 fields.
 */
import { describe, expect, it } from 'vitest';
import { decodePublishRequest, encodePublishRequest } from '../src/proto/publish.js';

const ABOVE_MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER) + 123n;

function minimalPublish(overrides: Record<string, unknown> = {}) {
  return {
    ual: 'did:dkg:evm:31337/0x0/1',
    nquads: new TextEncoder().encode('<urn:root> <urn:p> "v" .'),
    contextGraphId: 'cg',
    kas: [
      {
        tokenId: 1,
        rootEntity: 'urn:root',
        privateMerkleRoot: new Uint8Array(32),
        privateTripleCount: 0,
      },
    ],
    publisherIdentity: new Uint8Array(32),
    publisherAddress: '0x1111111111111111111111111111111111111111',
    startKAId: 1,
    endKAId: 1,
    chainId: '31337',
    publisherSignatureR: new Uint8Array(32),
    publisherSignatureVs: new Uint8Array(32),
    ...overrides,
  };
}

describe('encodePublishRequest uint64 precision', () => {
  it('round-trips kas.tokenId/startKAId/endKAId above Number.MAX_SAFE_INTEGER', () => {
    const tokenId = ABOVE_MAX_SAFE_INTEGER;
    const startKAId = ABOVE_MAX_SAFE_INTEGER + 1n;
    const endKAId = ABOVE_MAX_SAFE_INTEGER + 2n;
    const blockNumber = ABOVE_MAX_SAFE_INTEGER + 3n;
    const encoded = encodePublishRequest(
      minimalPublish({
        kas: [
          {
            tokenId,
            rootEntity: 'urn:root',
            privateMerkleRoot: new Uint8Array(32),
            privateTripleCount: 0,
          },
        ],
        startKAId,
        endKAId,
        blockNumber,
      }) as any,
    );

    const decoded = decodePublishRequest(encoded);
    expect(BigInt(decoded.kas[0].tokenId as any)).toBe(tokenId);
    expect(BigInt(decoded.startKAId as any)).toBe(startKAId);
    expect(BigInt(decoded.endKAId as any)).toBe(endKAId);
    expect(BigInt(decoded.blockNumber as any)).toBe(blockNumber);
  });

  it('rejects unsafe JS number inputs before they can be serialized lossy', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 2;
    expect(() => encodePublishRequest(minimalPublish({ startKAId: unsafe }) as any)).toThrow(RangeError);
    expect(() => encodePublishRequest(minimalPublish({ endKAId: unsafe }) as any)).toThrow(RangeError);
    expect(() =>
      encodePublishRequest(
        minimalPublish({
          kas: [
            {
              tokenId: unsafe,
              rootEntity: 'urn:root',
              privateMerkleRoot: new Uint8Array(32),
              privateTripleCount: 0,
            },
          ],
        }) as any,
      ),
    ).toThrow(RangeError);
  });
});
