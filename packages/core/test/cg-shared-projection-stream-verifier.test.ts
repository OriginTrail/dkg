import { describe, expect, it } from 'vitest';

import {
  CgSharedProjectionError,
  createCgSharedProjectionStreamVerifierV1,
  encodeCanonicalCgSharedPublicRootProjectionV1,
} from '../src/cg-shared-projection.js';
import { computeKaProjectionDigestV1 } from '../src/ka-bundle-v1.js';
import type { CountV1 } from '../src/sync-wire-scalars.js';

const COMMITMENT = 'did:dkg:otp:20430/0x3333333333333333333333333333333333333333/7/_cg-shared-v1';
const TRIPLES = Object.freeze([
  Object.freeze({ subject: 'urn:a', predicate: 'urn:p', object: '"alpha"' }),
  Object.freeze({ subject: 'urn:b', predicate: 'urn:p', object: '"beta"' }),
]);
const BYTES = encodeCanonicalCgSharedPublicRootProjectionV1(TRIPLES);
const DIGEST = computeKaProjectionDigestV1(BYTES);

describe('core cg-shared-v1 incremental verifier', () => {
  it('emits exactly the same canonical bytes as the buffered encoder', () => {
    const verifier = createVerifier();
    const chunks = TRIPLES.map((triple) => verifier.push(triple));
    verifier.finalize();

    expect(join(chunks)).toEqual(BYTES);
  });

  it('canonicalizes backend lexical forms before measuring the byte ceiling', () => {
    const canonical = [{
      subject: 'urn:a',
      predicate: 'urn:p',
      object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
    }];
    const bytes = encodeCanonicalCgSharedPublicRootProjectionV1(canonical);
    const verifier = createVerifier({
      triples: canonical,
      byteCeiling: bytes.byteLength,
    });

    expect(verifier.push({
      ...canonical[0],
      object: '"00000000000000000001"^^<http://www.w3.org/2001/XMLSchema#integer>',
    })).toEqual(bytes);
    expect(() => verifier.finalize()).not.toThrow();
  });

  it('snapshots options so later caller mutation cannot change verification', () => {
    const options = {
      commitmentSubject: COMMITMENT,
      expectedPublicTripleCount: '2' as CountV1,
      expectedProjectionDigest: DIGEST,
      byteCeiling: BYTES.byteLength,
    };
    const verifier = createCgSharedProjectionStreamVerifierV1(options);
    options.byteCeiling = 1;
    options.commitmentSubject = 'urn:changed';

    for (const triple of TRIPLES) verifier.push(triple);
    expect(() => verifier.finalize()).not.toThrow();
  });

  it('uses the same typed projection errors for ordered-stream failures', () => {
    const verifier = createVerifier();
    verifier.push(TRIPLES[1]);
    expect(() => verifier.push(TRIPLES[0])).toThrow(CgSharedProjectionError);
  });

  it('exposes stable count reasons without parsing diagnostic text', () => {
    const overflow = createVerifier({ triples: [TRIPLES[0]] });
    overflow.push(TRIPLES[0]);
    expectProjectionReason(
      () => overflow.push(TRIPLES[1]),
      'public-count-overflow',
    );

    const mismatch = createVerifier();
    mismatch.push(TRIPLES[0]);
    expectProjectionReason(
      () => mismatch.finalize(),
      'public-count-mismatch',
    );
  });

  it.each([
    ['blank-node subject', { subject: '_:b0', predicate: 'urn:p', object: '"x"' }, 'projection-iri'],
    ['relative subject IRI', { subject: 'relative', predicate: 'urn:p', object: '"x"' }, 'projection-iri'],
    ['malformed literal', { subject: 'urn:a', predicate: 'urn:p', object: '"unterminated' }, 'projection-literal'],
    ['embedded literal line break', { subject: 'urn:a', predicate: 'urn:p', object: '"line\nbreak"' }, 'projection-literal'],
  ] as const)('rejects %s with buffered-verifier semantic parity', (_name, triple, code) => {
    const verifier = createVerifier({ triples: [TRIPLES[0]] });
    try {
      verifier.push(triple);
    } catch (error) {
      expect(error).toBeInstanceOf(CgSharedProjectionError);
      expect(error).toHaveProperty('code', code);
      return;
    }
    throw new Error(`expected ${code}`);
  });
});

function createVerifier(options: {
  triples?: readonly { subject: string; predicate: string; object: string }[];
  byteCeiling?: number;
} = {}) {
  const triples = options.triples ?? TRIPLES;
  const bytes = encodeCanonicalCgSharedPublicRootProjectionV1(triples);
  return createCgSharedProjectionStreamVerifierV1({
    commitmentSubject: COMMITMENT,
    expectedPublicTripleCount: String(triples.length) as CountV1,
    expectedProjectionDigest: computeKaProjectionDigestV1(bytes),
    byteCeiling: options.byteCeiling ?? bytes.byteLength,
  });
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function expectProjectionReason(
  action: () => unknown,
  reason: 'public-count-overflow' | 'public-count-mismatch',
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CgSharedProjectionError);
    expect(error).toHaveProperty('code', 'projection-public-count');
    expect(error).toHaveProperty('reason', reason);
    return;
  }
  throw new Error(`expected ${reason}`);
}
