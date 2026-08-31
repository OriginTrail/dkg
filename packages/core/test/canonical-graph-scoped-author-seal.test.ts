import { describe, expect, it } from 'vitest';

import * as coreBarrel from '../src/index.js';
import { ASSERTION_SEAL_PREDICATES } from '../src/assertion-seal.js';
import {
  MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1,
  CanonicalGraphScopedAuthorSealError,
  assertCanonicalGraphScopedAuthorSealCoordinateV1,
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  canonicalizeAuthorSealStoreRoundTripRowV1,
  classifyCanonicalGraphScopedAuthorSealRowsV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  decodeCanonicalGraphScopedAuthorSealRowsV1,
  decodeCanonicalGraphScopedAuthorSealRenderedRowsV1,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  parseCanonicalGraphScopedAuthorSealV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  projectCanonicalGraphScopedAuthorSealStoreRowsV1,
  renderCanonicalAuthorSealStoreRowV1,
  type CanonicalAuthorSealStoreRowV1,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
  type CanonicalGraphScopedAuthorSealRowV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '../src/canonical-graph-scoped-author-seal.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const RESERVED_KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
const SUBJECT =
  `did:dkg:context-graph:v1/root/a%2Fb/assertion/${AUTHOR}/name%20%CE%BB`;
const META_GRAPH = 'did:dkg:context-graph:v1/root/a%2Fb/_meta';
const SEAL_DIGEST =
  '0x8fc37c7f66831aea9b2a0ed35aac26bb6eec2eb3042ed0dcdd2e023d3087632a';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const CANONICAL =
  '{"assertedAtChainId":"20430","assertedAtKav10Address":"0x4444444444444444444444444444444444444444","assertionFinalizedAt":"2026-07-19T12:34:56.789Z","assertionMerkleRoot":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","assertionVersion":"2","authorAddress":"0x3333333333333333333333333333333333333333","authorAttestationR":"0x1111111111111111111111111111111111111111111111111111111111111111","authorAttestationVS":"0x2222222222222222222222222222222222222222222222222222222222222222","authorSchemeVersion":"1","contentScopeVersion":"2","kaUal":"did:dkg:otp:20430/0x3333333333333333333333333333333333333333/7","privateMerkleRoot":null,"privateTripleCount":"0","publicTripleCount":"12977","reservedKaId":"23158417847463239084714197001737581570653996933112267175388663934063917137927"}';

const EXPECTED_PREDICATES = [
  ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT,
  ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS,
  ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R,
  ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_VS,
  ASSERTION_SEAL_PREDICATES.AUTHOR_SCHEME_VERSION,
  ASSERTION_SEAL_PREDICATES.ASSERTED_AT_CHAIN_ID,
  ASSERTION_SEAL_PREDICATES.ASSERTED_AT_KAV10_ADDRESS,
  ASSERTION_SEAL_PREDICATES.RESERVED_KA_ID,
  ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT,
  ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION,
  ASSERTION_SEAL_PREDICATES.KA_UAL,
  ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
  ASSERTION_SEAL_PREDICATES.PUBLIC_TRIPLE_COUNT,
  ASSERTION_SEAL_PREDICATES.PRIVATE_TRIPLE_COUNT,
];
const EXPECTED_OBJECTS = [
  `"${'aa'.repeat(32)}"^^<${XSD}hexBinary>`,
  `"${AUTHOR}"`,
  `"${'11'.repeat(32)}"^^<${XSD}hexBinary>`,
  `"${'22'.repeat(32)}"^^<${XSD}hexBinary>`,
  `"1"^^<${XSD}integer>`,
  `"20430"^^<${XSD}integer>`,
  '"0x4444444444444444444444444444444444444444"',
  `"${RESERVED_KA_ID}"^^<${XSD}integer>`,
  `"2026-07-19T12:34:56.789Z"^^<${XSD}dateTime>`,
  `"2"^^<${XSD}integer>`,
  `<did:dkg:otp:20430/${AUTHOR}/7>`,
  `"2"^^<${XSD}integer>`,
  `"12977"^^<${XSD}integer>`,
  `"0"^^<${XSD}integer>`,
];

const PAYLOAD = validatedPayload(JSON.parse(CANONICAL));
const COORDINATE = validatedCoordinate({
  contextGraphId: 'a/b',
  subGraphName: null,
  authorAddress: AUTHOR,
  assertionCoordinate: 'name λ',
});

describe('CanonicalGraphScopedAuthorSealV1 bytes and projection', () => {
  it('pins the normative 803-byte payload, digest, placement, and ordered rows', () => {
    expect(canonicalizeCanonicalGraphScopedAuthorSealV1(PAYLOAD)).toBe(CANONICAL);
    expect(canonicalizeCanonicalGraphScopedAuthorSealBytesV1(PAYLOAD).byteLength).toBe(803);
    expect(computeCanonicalGraphScopedAuthorSealDigestV1(PAYLOAD)).toBe(SEAL_DIGEST);
    expect(parseCanonicalGraphScopedAuthorSealV1(CANONICAL)).toEqual(PAYLOAD);
    expect(deriveCanonicalGraphScopedAuthorSealPlacementV1(COORDINATE)).toEqual({
      subject: SUBJECT,
      metaGraph: META_GRAPH,
    });

    const rows = projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE);
    expect(rows).toHaveLength(14);
    expect(rows.map((row) => row.predicate)).toEqual(EXPECTED_PREDICATES);
    expect(rows.map((row) => row.object)).toEqual(EXPECTED_OBJECTS);
    expect(rows.every((row) => row.subject === SUBJECT && row.graph === META_GRAPH)).toBe(true);

    const typedRows = projectCanonicalGraphScopedAuthorSealStoreRowsV1(PAYLOAD, COORDINATE);
    expect(Object.isFrozen(typedRows)).toBe(true);
    expect(typedRows).toHaveLength(rows.length);
    expect(typedRows.map(renderCanonicalAuthorSealStoreRowV1)).toEqual(rows);
    expect(typedRows.every((row) => Object.isFrozen(row) && Object.isFrozen(row.object)))
      .toBe(true);
  });

  it('emits the optional private-root row only for positive private content', () => {
    const privatePayload = validatedPayload({
      ...PAYLOAD,
      publicTripleCount: '0',
      privateTripleCount: '1',
      privateMerkleRoot: `0x${'bb'.repeat(32)}`,
    });
    const rows = projectCanonicalGraphScopedAuthorSealRowsV1(privatePayload, COORDINATE);
    expect(rows).toHaveLength(15);
    expect(rows[14]).toEqual({
      subject: SUBJECT,
      predicate: ASSERTION_SEAL_PREDICATES.PRIVATE_MERKLE_ROOT,
      object: `"${'bb'.repeat(32)}"^^<${XSD}hexBinary>`,
      graph: META_GRAPH,
    });
    expect(decodeCanonicalGraphScopedAuthorSealRowsV1(
      toStoreRows(rows),
      COORDINATE,
    ).payload).toEqual(privatePayload);
  });

  it('canonicalizes only backend-equivalent UAL and dateTime post-read forms', () => {
    const rows = projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE);
    const ual = rows.find((row) => row.predicate === ASSERTION_SEAL_PREDICATES.KA_UAL)!;
    const finalizedAt = rows.find(
      (row) => row.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT,
    )!;
    expect(canonicalizeAuthorSealStoreRoundTripRowV1({
      ...ual,
      object: PAYLOAD.kaUal,
    })).toEqual(ual);
    expect(canonicalizeAuthorSealStoreRoundTripRowV1({
      ...finalizedAt,
      object: `"2026-07-19T13:34:56.789+01:00"^^<${XSD}dateTime>`,
    })).toEqual(finalizedAt);
    expect(canonicalizeAuthorSealStoreRoundTripRowV1({
      ...finalizedAt,
      object: `"2026-07-19T13:34:56.7890+01:00"^^<${XSD}dateTime>`,
    })).toEqual(finalizedAt);
    for (const nonEquivalent of [
      `"2026-07-19T12:34:56.7899Z"^^<${XSD}dateTime>`,
      `"2026-07-19T12:34:56.789"^^<${XSD}dateTime>`,
      `"2026-02-30T12:34:56.789Z"^^<${XSD}dateTime>`,
    ]) {
      expect(canonicalizeAuthorSealStoreRoundTripRowV1({
        ...finalizedAt,
        object: nonEquivalent,
      }).object).toBe(nonEquivalent);
    }
    expect(canonicalizeAuthorSealStoreRoundTripRowV1({
      ...finalizedAt,
      object: `"not-an-instant"^^<${XSD}dateTime>`,
    }).object).toBe(`"not-an-instant"^^<${XSD}dateTime>`);
  });

  it('derives the prefix-free tagged subgraph subject and metadata graph', () => {
    const subgraphCoordinate = validatedCoordinate({
      ...COORDINATE,
      contextGraphId: 'a',
      subGraphName: 'b',
    });
    expect(deriveCanonicalGraphScopedAuthorSealPlacementV1(subgraphCoordinate)).toEqual({
      subject: `did:dkg:context-graph:v1/subgraph/a/b/assertion/${AUTHOR}/name%20%CE%BB`,
      metaGraph: 'did:dkg:context-graph:v1/subgraph/a/b/_meta',
    });
  });
});

describe('CanonicalGraphScopedAuthorSealV1 typed store inverse', () => {
  it('normalizes backend-neutral terms, decodes in any order, and calls #1780 once', () => {
    const projected = projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE);
    const storeRows = toStoreRows(projected).reverse();
    const decoded = decodeCanonicalGraphScopedAuthorSealRowsV1(storeRows, COORDINATE);
    expect(decoded.payload).toEqual(PAYLOAD);
    expect(new TextDecoder().decode(decoded.canonicalSealBytes)).toBe(CANONICAL);
    expect(decoded.sealDigest).toBe(SEAL_DIGEST);
    expect(decoded.rows).toEqual(projected);

    const classified = classifyCanonicalGraphScopedAuthorSealRowsV1(storeRows, COORDINATE);
    expect(classified.candidate.coordinate).toEqual({
      scope: 'v1/root/a%2Fb',
      agentAddress: AUTHOR,
      name: 'name%20%CE%BB',
    });
    expect(classified.candidate.seal).toMatchObject({
      authorAddress: AUTHOR,
      reservedKaId: BigInt(RESERVED_KA_ID),
      kaUal: `did:dkg:otp:20430/${AUTHOR}/7`,
      assertionVersion: '2',
      publicTripleCount: 12977,
      privateTripleCount: 0,
    });
  });

  it('canonicalizes EIP-55 checksummed store addresses to the lowercase seal', () => {
    // Hardhat #1 / #0 — genuine EIP-55 checksummed addresses. They contain a–f
    // digits, so the checksummed form differs from lowercase; the 0x3333…/0x4444…
    // fixtures above would make this regression vacuous (they have no letters).
    const CHECKSUMMED_AUTHOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const CHECKSUMMED_KAV10 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const lowerAuthor = CHECKSUMMED_AUTHOR.toLowerCase();
    const lowerKav10 = CHECKSUMMED_KAV10.toLowerCase();
    expect(CHECKSUMMED_AUTHOR).not.toBe(lowerAuthor);
    expect(CHECKSUMMED_KAV10).not.toBe(lowerKav10);

    const coordinate = validatedCoordinate({ ...COORDINATE, authorAddress: lowerAuthor });
    const payload = validatedPayload({
      ...PAYLOAD,
      authorAddress: lowerAuthor,
      assertedAtKav10Address: lowerKav10,
      kaUal: `did:dkg:otp:20430/${lowerAuthor}/7`,
      reservedKaId: ((BigInt(lowerAuthor) << 96n) | 7n).toString(),
    });

    const lowerRows = toStoreRows(projectCanonicalGraphScopedAuthorSealRowsV1(payload, coordinate));
    const checksummedRows = lowerRows.map((row) => {
      if (row.predicateIri === ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS) {
        return { ...row, object: toStoreObject(JSON.stringify(CHECKSUMMED_AUTHOR)) };
      }
      if (row.predicateIri === ASSERTION_SEAL_PREDICATES.ASSERTED_AT_KAV10_ADDRESS) {
        return { ...row, object: toStoreObject(JSON.stringify(CHECKSUMMED_KAV10)) };
      }
      return row;
    });

    const lower = decodeCanonicalGraphScopedAuthorSealRowsV1(lowerRows, coordinate);
    const checksummed = decodeCanonicalGraphScopedAuthorSealRowsV1(checksummedRows, coordinate);

    // Checksummed store rows decode to the identical canonical payload, seal
    // bytes, and digest as the lowercase rows — the property that matters.
    expect(checksummed.payload.authorAddress).toBe(lowerAuthor);
    expect(checksummed.payload.assertedAtKav10Address).toBe(lowerKav10);
    expect(checksummed.payload).toEqual(lower.payload);
    expect(checksummed.sealDigest).toBe(lower.sealDigest);
    expect(checksummed.canonicalSealBytes).toEqual(lower.canonicalSealBytes);
    // The PR #1780 candidate classifier still admits the checksummed rows.
    expect(() => classifyCanonicalGraphScopedAuthorSealRowsV1(checksummedRows, coordinate))
      .not.toThrow();
  });

  it('pins Oxigraph/Blazegraph typed-term parity rendering', () => {
    const base = { subjectIri: SUBJECT, predicateIri: 'urn:predicate', graphIri: META_GRAPH };
    expect(renderCanonicalAuthorSealStoreRowV1({
      ...base,
      object: {
        kind: 'named-node',
        value: `did:dkg:otp:20430/${AUTHOR}/7`,
      },
    }).object).toBe(`<did:dkg:otp:20430/${AUTHOR}/7>`);
    expect(renderCanonicalAuthorSealStoreRowV1({
      ...base,
      object: { kind: 'literal', value: '20430', datatypeIri: `${XSD}integer` },
    }).object).toBe(`"20430"^^<${XSD}integer>`);
    expect(renderCanonicalAuthorSealStoreRowV1({
      ...base,
      object: { kind: 'literal', value: AUTHOR, datatypeIri: `${XSD}string` },
    }).object).toBe(`"${AUTHOR}"`);
  });

  it('owns rendered storage-row parsing and exact seal projection in core', () => {
    const rendered = projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE);
    const decoded = decodeCanonicalGraphScopedAuthorSealRenderedRowsV1(rendered, COORDINATE);
    expect(decoded.payload).toEqual(PAYLOAD);
    expect(decoded.rows).toEqual(rendered);
    expect(() => decodeCanonicalGraphScopedAuthorSealRenderedRowsV1(
      rendered.slice(1),
      COORDINATE,
    )).toThrow(/canonical-seal-row-cardinality/u);
  });

  it('validates rendered-row cardinality and descriptors before traversal', () => {
    const rendered = projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE);

    let indexGetterInvoked = false;
    const accessorRows = [...rendered];
    Object.defineProperty(accessorRows, '0', {
      enumerable: true,
      get() {
        indexGetterInvoked = true;
        return rendered[0];
      },
    });
    expect(() => decodeCanonicalGraphScopedAuthorSealRenderedRowsV1(
      accessorRows,
      COORDINATE,
    )).toThrow(/enumerable data properties/u);
    expect(indexGetterInvoked).toBe(false);

    let customMapInvoked = false;
    const adornedRows = [...rendered];
    Object.defineProperty(adornedRows, 'map', {
      enumerable: true,
      get() {
        customMapInvoked = true;
        return () => [];
      },
    });
    expect(() => decodeCanonicalGraphScopedAuthorSealRenderedRowsV1(
      adornedRows,
      COORDINATE,
    )).toThrow(/dense and unadorned/u);
    expect(customMapInvoked).toBe(false);

    let oversizedGetterInvoked = false;
    const oversized = Array.from({ length: 16 });
    Object.defineProperty(oversized, '0', {
      enumerable: true,
      get() {
        oversizedGetterInvoked = true;
        return rendered[0];
      },
    });
    expect(() => decodeCanonicalGraphScopedAuthorSealRenderedRowsV1(
      oversized,
      COORDINATE,
    )).toThrow(/canonical-seal-row-cardinality/u);
    expect(oversizedGetterInvoked).toBe(false);
  });

  it('rejects missing, duplicate, unknown, legacy, misplaced, and noncanonical rows', () => {
    const valid = toStoreRows(projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE));
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1(valid.slice(1), COORDINATE))
      .toThrow(/canonical-seal-row-cardinality/);
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1(
      [...valid, valid[0]],
      COORDINATE,
    )).toThrow(/duplicate author-seal predicate/);
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1(
      [
        ...valid,
        {
          ...valid[0],
          object: { kind: 'literal', value: 'tampered', datatypeIri: `${XSD}string` },
        },
      ],
      COORDINATE,
    )).toThrow(/duplicate author-seal predicate/);
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1([
      ...valid.slice(0, -1),
      { ...valid.at(-1)!, predicateIri: 'http://dkg.io/ontology/unknown' },
    ], COORDINATE)).toThrow(/unknown author-seal predicate/);
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1([
      ...valid.slice(0, -1),
      {
        ...valid.at(-1)!,
        predicateIri: ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY,
      },
    ], COORDINATE)).toThrow(/unknown author-seal predicate/);
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1([
      { ...valid[0], subjectIri: `${SUBJECT}/other` },
      ...valid.slice(1),
    ], COORDINATE)).toThrow(/wrong subject or graph/);
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1([
      { ...valid[0], graphIri: `${META_GRAPH}/other` },
      ...valid.slice(1),
    ], COORDINATE)).toThrow(/wrong subject or graph/);
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1([
      ...valid.slice(0, 5),
      {
        ...valid[5],
        object: { kind: 'literal', value: '020430', datatypeIri: `${XSD}integer` },
      },
      ...valid.slice(6),
    ], COORDINATE)).toThrow(/exact xsd:integer term/);
  });

  it('rejects malformed typed adapter terms before canonical comparison', () => {
    const valid = toStoreRows(projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE));
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1([
      ...valid.slice(0, 10),
      {
        ...valid[10],
        object: { kind: 'named-node', value: `<did:dkg:otp:20430/${AUTHOR}/7>` },
      },
      ...valid.slice(11),
    ], COORDINATE)).toThrow(/bare safe IRI/);
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1([
      ...valid.slice(0, 1),
      {
        ...valid[1],
        object: { kind: 'literal', value: AUTHOR, datatypeIri: `${XSD}decimal` },
      },
      ...valid.slice(2),
    ], COORDINATE)).toThrow(/unsupported author-seal literal datatype/);
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1([
      ...valid.slice(0, 1),
      {
        ...valid[1],
        object: {
          kind: 'literal',
          value: AUTHOR,
          datatypeIri: `${XSD}string`,
          language: 'en',
        },
      } as unknown as CanonicalAuthorSealStoreRowV1,
      ...valid.slice(2),
    ], COORDINATE)).toThrow(/literal object has invalid fields/);
    const accessorObject = {} as Record<string, unknown>;
    Object.defineProperties(accessorObject, {
      kind: { enumerable: true, get: () => 'literal' },
      value: { enumerable: true, value: AUTHOR },
      datatypeIri: { enumerable: true, value: `${XSD}string` },
    });
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1([
      ...valid.slice(0, 1),
      { ...valid[1], object: accessorObject } as unknown as CanonicalAuthorSealStoreRowV1,
      ...valid.slice(2),
    ], COORDINATE)).toThrow(/kind must be a data property/);
  });

  it('rejects wrapped, whitespace, and control characters in every typed row IRI', () => {
    const base: CanonicalAuthorSealStoreRowV1 = {
      subjectIri: SUBJECT,
      predicateIri: 'urn:predicate',
      graphIri: META_GRAPH,
      object: { kind: 'literal', value: AUTHOR, datatypeIri: `${XSD}string` },
    };
    for (const field of ['subjectIri', 'predicateIri', 'graphIri'] as const) {
      for (const value of ['<urn:wrapped>', 'urn:has space', 'urn:has\u0000control']) {
        expect(() => renderCanonicalAuthorSealStoreRowV1({ ...base, [field]: value }))
          .toThrow(new RegExp(`${field} must contain one bare safe IRI`));
      }
    }
  });

  it('preserves schema-versus-term error codes for malformed typed row IRIs', () => {
    const base: CanonicalAuthorSealStoreRowV1 = {
      subjectIri: SUBJECT,
      predicateIri: 'urn:predicate',
      graphIri: META_GRAPH,
      object: { kind: 'literal', value: AUTHOR, datatypeIri: `${XSD}string` },
    };
    for (const field of ['subjectIri', 'predicateIri', 'graphIri'] as const) {
      try {
        renderCanonicalAuthorSealStoreRowV1({ ...base, [field]: 42 } as never);
        throw new Error('expected non-string IRI rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(CanonicalGraphScopedAuthorSealError);
        expect((error as CanonicalGraphScopedAuthorSealError).code)
          .toBe('canonical-seal-row-schema');
      }
      try {
        renderCanonicalAuthorSealStoreRowV1({ ...base, [field]: 'urn:has space' });
        throw new Error('expected unsafe IRI rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(CanonicalGraphScopedAuthorSealError);
        expect((error as CanonicalGraphScopedAuthorSealError).code)
          .toBe('canonical-seal-row-term');
      }
    }
  });

  it('rejects non-ordinary, accessor-backed store-row containers', () => {
    const valid = toStoreRows(projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE));
    const accessor = [...valid];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => valid[0] });
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1(accessor, COORDINATE))
      .toThrow(/enumerable data properties/);
    class RowArray extends Array<CanonicalAuthorSealStoreRowV1> {}
    expect(() => decodeCanonicalGraphScopedAuthorSealRowsV1(
      new RowArray(...valid),
      COORDINATE,
    )).toThrow(/ordinary Array/);
  });
});

describe('CanonicalGraphScopedAuthorSealV1 hostile payload rejection', () => {
  it('rejects missing, extra, duplicate, non-string, and noncanonical wire fields', () => {
    const missing = { ...PAYLOAD } as Record<string, unknown>;
    delete missing.reservedKaId;
    expect(() => assertCanonicalGraphScopedAuthorSealV1(missing)).toThrow(
      /canonical-seal-schema/,
    );
    expect(() => assertCanonicalGraphScopedAuthorSealV1({ ...PAYLOAD, legacy: true }))
      .toThrow(/canonical-seal-schema/);
    expect(() => parseCanonicalGraphScopedAuthorSealV1(
      CANONICAL.replace(
        '"assertionVersion":"2"',
        '"assertionVersion":"2","assertionVersion":"2"',
      ),
    )).toThrow(/canonical-seal-schema/);
    expect(() => parseCanonicalGraphScopedAuthorSealV1(
      CANONICAL.replace('"assertionVersion":"2"', '"assertionVersion":2'),
    )).toThrow(/canonical-seal-scalar/);
    expect(() => parseCanonicalGraphScopedAuthorSealV1(` ${CANONICAL}`))
      .toThrow(/canonical-seal-schema/);
    expect(() => parseCanonicalGraphScopedAuthorSealV1(
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(CANONICAL)]),
    )).toThrow(/canonical-seal-schema/);
    expect(() => parseCanonicalGraphScopedAuthorSealV1(new Uint8Array([0xff])))
      .toThrow(/canonical-seal-schema/);
    expect(() => parseCanonicalGraphScopedAuthorSealV1(
      CANONICAL.replace('"privateMerkleRoot":null', '"privateMerkleRoot":{"x":null}'),
    )).toThrow(/canonical-seal-schema/);
    expect(() => parseCanonicalGraphScopedAuthorSealV1(
      '{'.padEnd(MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1 + 1, 'x'),
    )).toThrow(/canonical-seal-too-large/);
    expectInvalid({
      kaUal: `did:dkg:${'n'.repeat(MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1)}/${AUTHOR}/7`,
    }, /canonical-seal-too-large/);
  });

  it('rejects uppercase, invalid versions/counts, empty content, and bad private branches', () => {
    expectInvalid({ authorAddress: `0x${'A'.repeat(40)}` }, /canonical-seal-scalar/);
    expectInvalid({ authorAttestationR: `0x${'AA'.repeat(32)}` }, /canonical-seal-scalar/);
    expectInvalid({ authorSchemeVersion: 1 }, /canonical-seal-schema/);
    expectInvalid({ contentScopeVersion: '1' }, /canonical-seal-schema/);
    expectInvalid({ assertionVersion: '0' }, /canonical-seal-scalar/);
    expectInvalid({ assertionVersion: '18446744073709551616' }, /canonical-seal-scalar/);
    expectInvalid({ publicTripleCount: '9007199254740992' }, /canonical-seal-count/);
    expectInvalid({ publicTripleCount: '-1' }, /canonical-seal-scalar/);
    expectInvalid({ publicTripleCount: '0' }, /canonical-seal-count/);
    expectInvalid({ privateTripleCount: '1' }, /canonical-seal-private-root/);
    expectInvalid({ privateMerkleRoot: `0x${'bb'.repeat(32)}` }, /canonical-seal-private-root/);
  });

  it('rejects noncanonical or internally inconsistent UAL identity', () => {
    expectInvalid({ kaUal: `did:dkg:otp:20430/${AUTHOR}/07` }, /canonical-seal-ual/);
    expectInvalid({
      kaUal: `did:dkg:otp:20430/0x5555555555555555555555555555555555555555/7`,
    }, /canonical-seal-binding/);
    expectInvalid({ reservedKaId: (BigInt(RESERVED_KA_ID) + 1n).toString() }, /canonical-seal-binding/);
    expectInvalid({
      kaUal: `did:dkg:otp:20430/${AUTHOR}/${1n << 96n}`,
    }, /canonical-seal-ual/);
  });

  it('rejects non-round-tripping UTC timestamps', () => {
    for (const assertionFinalizedAt of [
      '2026-02-30T12:34:56.789Z',
      '2026-07-19T12:34:60.789Z',
      '2026-07-19T12:34:56.78Z',
      '2026-07-19T12:34:56.789+00:00',
    ]) {
      expectInvalid({ assertionFinalizedAt }, /canonical-seal-timestamp/);
    }
  });

  it('rejects a payload/coordinate author disagreement', () => {
    const other = validatedCoordinate({
      ...COORDINATE,
      authorAddress: '0x5555555555555555555555555555555555555555',
    });
    expect(() => projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, other))
      .toThrow(/canonical-seal-binding/);
  });
});

function expectInvalid(
  patch: Record<string, unknown>,
  expected: RegExp,
): void {
  expect(() => assertCanonicalGraphScopedAuthorSealV1({ ...PAYLOAD, ...patch }))
    .toThrow(expected);
}

function validatedPayload(value: unknown): CanonicalGraphScopedAuthorSealV1 {
  assertCanonicalGraphScopedAuthorSealV1(value);
  return value;
}

function validatedCoordinate(value: unknown): CanonicalGraphScopedAuthorSealCoordinateV1 {
  assertCanonicalGraphScopedAuthorSealCoordinateV1(value);
  return value;
}

function toStoreRows(
  rows: readonly CanonicalGraphScopedAuthorSealRowV1[],
): CanonicalAuthorSealStoreRowV1[] {
  return rows.map((row) => ({
    subjectIri: row.subject,
    predicateIri: row.predicate,
    graphIri: row.graph,
    object: toStoreObject(row.object),
  }));
}

function toStoreObject(object: string): CanonicalAuthorSealStoreRowV1['object'] {
  if (object.startsWith('<')) {
    return { kind: 'named-node', value: object.slice(1, -1) };
  }
  const typed = /^"([^"]*)"\^\^<([^>]+)>$/.exec(object);
  if (typed) {
    return { kind: 'literal', value: typed[1], datatypeIri: typed[2] };
  }
  return {
    kind: 'literal',
    value: JSON.parse(object) as string,
    datatypeIri: `${XSD}string`,
  };
}

describe('CanonicalGraphScopedAuthorSealV1 public package barrel', () => {
  it('re-exports the codec API from ../src/index.js and behaves identically', () => {
    // Verifies the consumer-facing import contract: a regression that dropped
    // the seal export block from src/index.ts would make these barrel symbols
    // undefined and fail here, even though the direct-module tests stay green.
    expect(typeof coreBarrel.canonicalizeCanonicalGraphScopedAuthorSealV1).toBe('function');
    expect(typeof coreBarrel.computeCanonicalGraphScopedAuthorSealDigestV1).toBe('function');
    expect(typeof coreBarrel.projectCanonicalGraphScopedAuthorSealRowsV1).toBe('function');
    expect(typeof coreBarrel.decodeCanonicalGraphScopedAuthorSealRowsV1).toBe('function');
    expect(typeof coreBarrel.decodeCanonicalGraphScopedAuthorSealRenderedRowsV1).toBe('function');
    expect(typeof coreBarrel.CanonicalGraphScopedAuthorSealError).toBe('function');
    expect(coreBarrel.MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1)
      .toBe(MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1);

    expect(coreBarrel.canonicalizeCanonicalGraphScopedAuthorSealV1(PAYLOAD)).toBe(CANONICAL);
    expect(coreBarrel.computeCanonicalGraphScopedAuthorSealDigestV1(PAYLOAD)).toBe(SEAL_DIGEST);

    const rows = toStoreRows(
      coreBarrel.projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE),
    );
    expect(coreBarrel.decodeCanonicalGraphScopedAuthorSealRowsV1(rows, COORDINATE).payload)
      .toEqual(PAYLOAD);
  });
});
