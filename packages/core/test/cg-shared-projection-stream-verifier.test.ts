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

  it('returns caller-owned chunks that cannot mutate retained ordering state', () => {
    const verifier = createVerifier();
    const first = verifier.push(TRIPLES[0]);
    first.fill(0x7f);

    expect(() => verifier.push(TRIPLES[1])).not.toThrow();
    expect(() => verifier.finalize()).not.toThrow();
  });

  it('accepts canonical LF lines without changing their bytes and isolates ownership', () => {
    const verifier = createVerifier();
    const [first, second] = splitLines(BYTES);
    const bufferInput = Buffer.from(first);
    const accepted = verifier.pushCanonicalLine(bufferInput);

    expect(accepted).toEqual(first);
    expect(accepted).not.toBe(bufferInput);
    expect(Buffer.isBuffer(accepted)).toBe(false);
    first.fill(0x7f);
    bufferInput.fill(0x5f);
    accepted.fill(0x6f);
    expect(() => verifier.pushCanonicalLine(second)).not.toThrow();
    expect(() => verifier.finalize()).not.toThrow();
  });

  it('rejects canonical-line inputs without exactly one terminal LF', () => {
    const verifier = createVerifier();
    expect(() => verifier.pushCanonicalLine(new TextEncoder().encode(
      '<urn:a> <urn:p> "alpha" .',
    ))).toThrow(CgSharedProjectionError);
    expect(() => verifier.pushCanonicalLine(new TextEncoder().encode(
      '<urn:a> <urn:p> "alpha" .\r\n',
    ))).toThrow(CgSharedProjectionError);
  });

  it('rejects LF-terminated RDF that is not a canonical V10 fixed point', () => {
    const canonical = [{
      subject: 'urn:a',
      predicate: 'urn:p',
      object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
    }];
    const verifier = createVerifier({ triples: canonical });
    const noncanonical = new TextEncoder().encode(
      '<urn:a> <urn:p> "00000000000000000001"^^<http://www.w3.org/2001/XMLSchema#integer> .\n',
    );

    expect(() => verifier.pushCanonicalLine(noncanonical)).toThrow(
      expect.objectContaining({ code: 'projection-literal' }),
    );
  });

  it('uses the same typed projection errors for ordered-stream failures', () => {
    const verifier = createVerifier();
    verifier.push(TRIPLES[1]);
    expect(() => verifier.push(TRIPLES[0])).toThrow(CgSharedProjectionError);
  });

  it('exposes discriminated count codes without optional state', () => {
    const overflow = createVerifier({ triples: [TRIPLES[0]] });
    overflow.push(TRIPLES[0]);
    expectProjectionCountCode(
      () => overflow.push(TRIPLES[1]),
      'projection-public-count-overflow',
    );

    const mismatch = createVerifier();
    mismatch.push(TRIPLES[0]);
    expectProjectionCountCode(
      () => mismatch.finalize(),
      'projection-public-count-mismatch',
    );
  });

  it('refuses an oversized raw term before canonicalization allocation', () => {
    const verifier = createVerifier({ rawInputByteCeiling: 1024 });
    expect(() => verifier.push({
      subject: 'urn:a',
      predicate: 'urn:p',
      // Deliberately unterminated as well as oversized. If literal parsing runs
      // before the lexical resource fence this reports projection-literal,
      // so the assertion proves the raw bound wins before canonicalization.
      object: `"${'0'.repeat(2048)}`,
    })).toThrow(expect.objectContaining({ code: 'projection-resource-refused' }));
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
  rawInputByteCeiling?: number;
} = {}) {
  const triples = options.triples ?? TRIPLES;
  const bytes = encodeCanonicalCgSharedPublicRootProjectionV1(triples);
  return createCgSharedProjectionStreamVerifierV1({
    commitmentSubject: COMMITMENT,
    expectedPublicTripleCount: String(triples.length) as CountV1,
    expectedProjectionDigest: computeKaProjectionDigestV1(bytes),
    byteCeiling: options.byteCeiling ?? bytes.byteLength,
    ...(options.rawInputByteCeiling === undefined
      ? {}
      : { rawInputByteCeiling: options.rawInputByteCeiling }),
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

function splitLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(bytes.slice(start, index + 1));
    start = index + 1;
  }
  return lines;
}

function expectProjectionCountCode(
  action: () => unknown,
  code: 'projection-public-count-overflow' | 'projection-public-count-mismatch',
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CgSharedProjectionError);
    expect(error).toHaveProperty('code', code);
    expect(error).not.toHaveProperty('reason');
    return;
  }
  throw new Error(`expected ${code}`);
}
