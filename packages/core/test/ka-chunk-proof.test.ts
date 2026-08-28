import { describe, expect, it } from 'vitest';

import {
  MAX_KA_CHUNK_PROOF_BYTES_V1,
  assertKaChunkProofV1,
  assertValidKaChunkProofV1,
  buildKaChunkProofV1,
  buildKaChunkProofsV1,
  canonicalizeKaChunkProofV1,
  parseCanonicalKaChunkProofV1,
  type KaChunkProofV1,
  type KaChunkProofV1ErrorCode,
} from '../src/ka-chunk-proof.js';
import { computeKaChunkTreeRootV1 } from '../src/ka-chunk-tree.js';
import type { Digest32V1, IndexV1 } from '../src/sync-wire-scalars.js';

const ZERO_DIGEST = `0x${'00'.repeat(32)}` as Digest32V1;
const THREE_CHUNK_ROOT =
  '0x80f90776eb169f7d125c41fb842f00c8a6d08093ef522ef8c5015bf169898338' as Digest32V1;
const THREE_CHUNK_PROOF =
  '{"chunkIndex":"2","steps":[{"kind":"odd"},{"digest":"0x12b230a0573621cb375b62f8f3f46cc6e8c05d3d0a84a50cd5d097132f86f58e","kind":"left"}]}';

describe('RFC-64 dormant KA chunk proof codec', () => {
  it('builds and verifies the canonical single-chunk empty proof', () => {
    const bundle = new Uint8Array(16);
    const root = computeKaChunkTreeRootV1(bundle);
    const proof = buildKaChunkProofV1(bundle, 0n);
    expect(canonicalizeKaChunkProofV1(proof, 1n))
      .toBe('{"chunkIndex":"0","steps":[]}');
    expect(proof).toEqual({ chunkIndex: '0', steps: [] });
    const parsed = parseCanonicalKaChunkProofV1('{"chunkIndex":"0","steps":[]}', 1n);
    expect(() => assertValidKaChunkProofV1(parsed, bundle, 16n, root)).not.toThrow();
  });

  it('builds, canonicalizes, parses, and verifies the exact three-chunk vector', () => {
    const bundle = fixtureBundle(3);
    const proof = buildKaChunkProofV1(bundle, 2n);
    expect(canonicalizeKaChunkProofV1(proof, 3n)).toBe(THREE_CHUNK_PROOF);
    expect(new TextEncoder().encode(THREE_CHUNK_PROOF).byteLength).toBe(137);
    expect(computeKaChunkTreeRootV1(bundle)).toBe(THREE_CHUNK_ROOT);

    const parsed = parseCanonicalKaChunkProofV1(THREE_CHUNK_PROOF, 3n);
    expect(parsed).toEqual(proof);
    expect(() => assertValidKaChunkProofV1(
      parsed,
      finalChunk(),
      524_295n,
      THREE_CHUNK_ROOT,
    )).not.toThrow();
  });

  it('builds and verifies every leaf in two-, three-, and five-chunk trees', () => {
    for (const chunkCount of [2, 3, 5]) {
      const bundle = fixtureBundle(chunkCount);
      const root = computeKaChunkTreeRootV1(bundle);
      const proofs = buildKaChunkProofsV1(
        bundle,
        Array.from({ length: chunkCount }, (_, index) => BigInt(index)),
      );
      for (let index = 0; index < chunkCount; index += 1) {
        const proof = proofs[index];
        const chunk = index + 1 === chunkCount ? finalChunk() : fullChunk(index);
        expect(() => assertValidKaChunkProofV1(
          proof,
          chunk,
          BigInt(bundle.byteLength),
          root,
        )).not.toThrow();
      }
    }
  });

  it('requires a bounded strictly increasing unique logical index request', () => {
    const bundle = fixtureBundle(5);
    expectFailureCode(() => buildKaChunkProofsV1(bundle, []), 'proof-request-indexes');
    expectFailureCode(
      () => buildKaChunkProofsV1(bundle, [0n, 0n]),
      'proof-request-indexes',
    );
    expectFailureCode(
      () => buildKaChunkProofsV1(bundle, [1n, 0n]),
      'proof-request-indexes',
    );
    expectFailureCode(
      () => buildKaChunkProofsV1(bundle, [0n, 5n]),
      'proof-request-indexes',
    );
    const many = new Uint8Array(17 * 262_144);
    expectFailureCode(
      () => buildKaChunkProofsV1(many, Array.from({ length: 17 }, (_, index) => BigInt(index))),
      'proof-request-indexes',
    );
  });

  it('rejects custom or symbolic array properties in the closed schema', () => {
    const proof = parseCanonicalKaChunkProofV1(THREE_CHUNK_PROOF, 3n);
    const steps = [...proof.steps] as KaChunkProofV1['steps'] & { extra?: boolean };
    steps.extra = true;
    expectFailureCode(
      () => assertKaChunkProofV1({ ...proof, steps }, 3n),
      'proof-schema',
    );
    const symbolic = [...proof.steps];
    Object.defineProperty(symbolic, Symbol('extra'), { value: true });
    expectFailureCode(
      () => assertKaChunkProofV1({ ...proof, steps: symbolic }, 3n),
      'proof-schema',
    );
  });

  it('rejects inherited iterators that differ from the validated indexed elements', () => {
    const proof = parseCanonicalKaChunkProofV1(THREE_CHUNK_PROOF, 3n);
    const indexedSteps = [
      { kind: 'odd' as const },
      { kind: 'left' as const, digest: ZERO_DIGEST },
    ];
    Object.setPrototypeOf(indexedSteps, {
      *[Symbol.iterator]() {
        yield* proof.steps;
      },
    });
    expectFailureCode(
      () => assertValidKaChunkProofV1(
        { ...proof, steps: indexedSteps },
        finalChunk(),
        524_295n,
        THREE_CHUNK_ROOT,
      ),
      'proof-schema',
    );

    const indexes = [1n, 0n];
    Object.setPrototypeOf(indexes, {
      *[Symbol.iterator]() {
        yield 0n;
        yield 1n;
      },
    });
    expectFailureCode(
      () => buildKaChunkProofsV1(fixtureBundle(3), indexes),
      'proof-request-indexes',
    );
  });

  it('requires topology-derived kind, direction, and exact step count', () => {
    const valid = parseCanonicalKaChunkProofV1(THREE_CHUNK_PROOF, 3n);
    const reversed = { ...valid, steps: [...valid.steps].reverse() };
    expectFailureCode(() => assertKaChunkProofV1(reversed, 3n), 'proof-schema');
    expectFailureCode(
      () => assertKaChunkProofV1({ ...valid, steps: valid.steps.slice(0, 1) }, 3n),
      'proof-topology',
    );
    expectFailureCode(
      () => assertKaChunkProofV1({
        ...valid,
        steps: [{ kind: 'odd' }, { kind: 'right', digest: valid.steps[1].kind === 'left'
          ? valid.steps[1].digest
          : ZERO_DIGEST }],
      }, 3n),
      'proof-topology',
    );
    expectFailureCode(
      () => assertKaChunkProofV1({ ...valid, steps: [...valid.steps, { kind: 'odd' }] }, 3n),
      'proof-topology',
    );
  });

  it('rejects odd steps with a digest and sibling steps without one', () => {
    expectFailureCode(
      () => assertKaChunkProofV1({
        chunkIndex: '2',
        steps: [{ kind: 'odd', digest: ZERO_DIGEST }, { kind: 'left', digest: ZERO_DIGEST }],
      }, 3n),
      'proof-schema',
    );
    expectFailureCode(
      () => assertKaChunkProofV1({
        chunkIndex: '1',
        steps: [{ kind: 'left' }, { kind: 'right', digest: ZERO_DIGEST }],
      }, 3n),
      'proof-schema',
    );
  });

  it('rejects wrong bytes, root, index, and final-chunk length', () => {
    const proof = parseCanonicalKaChunkProofV1(THREE_CHUNK_PROOF, 3n);
    const wrongBytes = finalChunk();
    wrongBytes[0] ^= 0xff;
    expectFailureCode(
      () => assertValidKaChunkProofV1(proof, wrongBytes, 524_295n, THREE_CHUNK_ROOT),
      'proof-root-mismatch',
    );
    expectFailureCode(
      () => assertValidKaChunkProofV1(proof, finalChunk(), 524_295n, ZERO_DIGEST),
      'proof-root-mismatch',
    );
    expectFailureCode(
      () => assertKaChunkProofV1({ ...proof, chunkIndex: '3' }, 3n),
      'proof-chunk-index',
    );
    expectFailureCode(
      () => assertValidKaChunkProofV1(
        proof,
        new Uint8Array(262_144),
        524_295n,
        THREE_CHUNK_ROOT,
      ),
      'proof-chunk-byte-length',
    );
  });

  it('rejects noncanonical/unknown fields and inputs over the proof byte cap', () => {
    expectFailureCode(
      () => parseCanonicalKaChunkProofV1(` ${THREE_CHUNK_PROOF}`, 3n),
      'proof-schema',
      /not RFC 8785 canonical/,
    );
    expectFailureCode(
      () => assertKaChunkProofV1({
        chunkIndex: '00',
        steps: [{ kind: 'odd' }, { kind: 'left', digest: ZERO_DIGEST }],
      }, 3n),
      'proof-chunk-index',
    );
    expectFailureCode(
      () => assertKaChunkProofV1({
        chunkIndex: '2',
        steps: [{ kind: 'odd' }, { kind: 'left', digest: ZERO_DIGEST, extra: true }],
      }, 3n),
      'proof-schema',
    );
    expectFailureCode(
      () => parseCanonicalKaChunkProofV1('x'.repeat(MAX_KA_CHUNK_PROOF_BYTES_V1 + 1), 1n),
      'proof-object-too-large',
    );
  });

  it('accepts the largest topology under the 1,280-byte proof cap', () => {
    const proof: KaChunkProofV1 = {
      chunkIndex: '4095' as IndexV1,
      steps: Array.from({ length: 12 }, () => ({ kind: 'left', digest: ZERO_DIGEST })),
    };
    assertKaChunkProofV1(proof, 4096n);
    const canonical = canonicalizeKaChunkProofV1(proof, 4096n);
    expect(new TextEncoder().encode(canonical).byteLength).toBe(1159);
    expect(parseCanonicalKaChunkProofV1(canonical, 4096n)).toEqual(proof);
  });

  it('rejects invalid chunk-count bounds and hostile backing memory', () => {
    expectFailureCode(
      () => assertKaChunkProofV1({ chunkIndex: '0', steps: [] }, 0n),
      'proof-chunk-count',
    );
    expectFailureCode(
      () => assertKaChunkProofV1({ chunkIndex: '0', steps: [] }, 4097n),
      'proof-chunk-count',
    );
    const shared = new Uint8Array(new SharedArrayBuffer(7));
    expect(() => assertValidKaChunkProofV1(
      parseCanonicalKaChunkProofV1(THREE_CHUNK_PROOF, 3n),
      shared,
      524_295n,
      THREE_CHUNK_ROOT,
    )).toThrow(/shared backing memory/);
  });
});

function fixtureBundle(chunkCount: number): Uint8Array {
  const chunks = Array.from({ length: chunkCount - 1 }, (_, index) => fullChunk(index));
  chunks.push(finalChunk());
  return concat(...chunks);
}

function fullChunk(index: number): Uint8Array {
  const chunk = new Uint8Array(262_144);
  chunk.fill(index);
  return chunk;
}

function finalChunk(): Uint8Array {
  return fromHex('a0a1a2a3a4a5a6');
}

function concat(...chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function expectFailureCode(
  operation: () => unknown,
  expected: KaChunkProofV1ErrorCode,
  message?: RegExp,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (message?.test((error as Error).message)) return;
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
