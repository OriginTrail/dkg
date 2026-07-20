import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeProtocolTuple, encodeProtocolTuple } from '../../src/protocol/codec.js';
import { WAL_V1_ENUMS, type ProtocolTuple } from '../../src/protocol/schema.js';
import {
  deriveExplicitRdfCandidateV1,
  encodeAcceptedRdfMutationV1,
  decodeDkgMutationCandidateV1,
} from '../../src/rdf/outcome-encoder.js';
import { rdfLogicalKeyV1, rdfTouchedKeyV1 } from '../../src/rdf/keys.js';
import { canonicalizeNQuadsV1 } from '../../src/rdf/nquads.js';
import { createRdfPolicyV1 } from '../../src/rdf/policy.js';
import type { EncodeAcceptedRdfMutationInputV1 } from '../../src/rdf/types.js';

const ASSET_GRAPH = 'urn:dkg:graph:asset:1';
const META_GRAPH = 'urn:dkg:graph:metadata';
const ASSET = 'did:dkg:otp:2043/0xabc/1';
const META_SUBJECT = 'urn:dkg:metadata:asset:1';
const vectors = JSON.parse(await readFile(
  resolve(process.cwd(), '../../conformance/wal-v1/vectors/protocol-v1.json'),
  'utf8',
));

function bytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

const author = bytes(20, 0x11);
const sharedWriter = bytes(20, 0x22);
const outsider = bytes(20, 0x33);
const policyObjectId = bytes(32, 0x44);
const headA = bytes(32, 0x01);
const headB = bytes(32, 0x02);
const logicalKeyCoordinates = {
  contextGraphId: 'urn:cg:alpha',
  subGraphName: 'main',
  authorAddress: author,
  knowledgeAssetUalOrRootEntity: ASSET,
} as const;
const logicalKey = rdfLogicalKeyV1(logicalKeyCoordinates);
const baseText = [
  `<${ASSET}> <urn:p:name> "old" <${ASSET_GRAPH}> .`,
  `<${ASSET}> <urn:p:tag> "blue" <${ASSET_GRAPH}> .`,
  `<${META_SUBJECT}> <urn:p:version> "1" <${META_GRAPH}> .`,
  '',
].join('\n');

function policy(overrides: Partial<Parameters<typeof createRdfPolicyV1>[0]> = {}) {
  return createRdfPolicyV1({
    allowedGraphPrefixes: ['urn:dkg:graph:'],
    maxQuadsPerMutation: 100n,
    maxWalObjectBytes: 1_000_000n,
    singleValuedPredicates: ['urn:p:name', 'urn:p:version'],
    multiValuedPredicates: ['urn:p:tag'],
    sharedWriteLogicalKeys: [logicalKey],
    allowedPayloadKinds: [
      BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
      BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY),
    ],
    ...overrides,
  });
}

function input(overrides: Partial<EncodeAcceptedRdfMutationInputV1> = {}): EncodeAcceptedRdfMutationInputV1 {
  return {
    operation: 'PATCH',
    logicalKey: logicalKeyCoordinates,
    writerId: author,
    memberWriterIds: [author, sharedWriter],
    baseHeads: [headB, headA],
    baseNQuads: baseText,
    allowedGraphIris: [ASSET_GRAPH, META_GRAPH],
    policyObjectId,
    policy: policy(),
    source: {
      kind: 'accepted-patch',
      deletesNQuads: `<${ASSET}> <urn:p:name> "old" <${ASSET_GRAPH}> .`,
      insertsNQuads: `<${ASSET}> <urn:p:name> "new" <${ASSET_GRAPH}> .`,
    },
    ...overrides,
  };
}

function remoteInput(encoded: ReturnType<typeof encodeAcceptedRdfMutationV1>, overrides: Partial<Parameters<typeof decodeDkgMutationCandidateV1>[0]> = {}) {
  return {
    contentBytes: encoded.contentBytes,
    baseNQuads: baseText,
    expectedPolicyObjectId: policyObjectId,
    logicalKeyCoordinates,
    writerId: author,
    memberWriterIds: [author, sharedWriter],
    allowedGraphIris: [ASSET_GRAPH, META_GRAPH],
    policy: policy(),
    ...overrides,
  };
}

function withDkgMutation(
  encoded: ReturnType<typeof encodeAcceptedRdfMutationV1>,
  transform: (tuple: unknown[]) => void,
): Uint8Array {
  const tuple = [...decodeProtocolTuple('DkgMutationV1', encoded.contentBytes)] as unknown[];
  transform(tuple);
  return encodeProtocolTuple('DkgMutationV1', tuple as unknown as ProtocolTuple<'DkgMutationV1'>);
}

describe('accepted semantic-outcome RDF encoder', () => {
  it('matches the independent protocol-v1 publish replacement vector byte for byte', () => {
    const rdf = vectors.rdfAdapter;
    const exactPolicy = createRdfPolicyV1({
      adapterVersion: BigInt(rdf.policy.adapterVersion),
      allowedGraphPrefixes: rdf.policy.allowedGraphPrefixes,
      maxQuadsPerMutation: BigInt(rdf.policy.maxQuadsPerMutation),
      maxWalObjectBytes: BigInt(rdf.policy.maxWalObjectBytes),
      singleValuedPredicates: rdf.policy.singleValuedPredicates,
      multiValuedPredicates: rdf.policy.multiValuedPredicates,
      allowedPayloadKinds: rdf.policy.allowedPayloadKinds.map(BigInt),
    });
    const encoded = encodeAcceptedRdfMutationV1({
      operation: 'PUT',
      logicalKey: {
        contextGraphId: rdf.logicalKey.contextGraphId,
        subGraphName: rdf.logicalKey.subGraphName,
        authorAddress: new Uint8Array(Buffer.from(rdf.logicalKey.authorAddress, 'hex')),
        knowledgeAssetUalOrRootEntity: rdf.logicalKey.knowledgeAssetUalOrRootEntity,
      },
      writerId: new Uint8Array(Buffer.from(rdf.logicalKey.authorAddress, 'hex')),
      memberWriterIds: [new Uint8Array(Buffer.from(rdf.logicalKey.authorAddress, 'hex'))],
      baseHeads: [],
      baseNQuads: '',
      allowedGraphIris: [rdf.publishReplace.graphIri],
      policyObjectId: new Uint8Array(Buffer.from(rdf.publishReplace.policyObjectId, 'hex')),
      policy: exactPolicy,
      source: {
        kind: 'replace',
        graphs: [{ graphIri: rdf.publishReplace.graphIri, nquads: rdf.canonicalization.input }],
      },
    });
    expect(Buffer.from(encodeProtocolTuple('RdfPolicyV1', exactPolicy)).toString('hex'))
      .toBe(rdf.policy.canonicalBytes);
    expect(Buffer.from(encoded.rdfMutation[3]).toString('hex')).toBe(rdf.publishReplace.resultStateDigest);
    expect(encoded.rdfMutation[8].map(value => Buffer.from(value).toString('hex')))
      .toEqual(rdf.publishReplace.touchedKeys);
    expect(Buffer.from(encodeProtocolTuple('RdfMutationV1', encoded.rdfMutation)).toString('hex'))
      .toBe(rdf.publishReplace.rdfMutationBytes);
    expect(Buffer.from(encoded.contentBytes).toString('hex')).toBe(rdf.publishReplace.dkgMutationBytes);
  });

  it('encodes graph-scoped PUT into one exact REPLACE and applies identical bytes remotely', () => {
    const encoded = encodeAcceptedRdfMutationV1(input({
      operation: 'PUT',
      baseHeads: [],
      baseNQuads: '',
      source: {
        kind: 'replace',
        graphs: [{
          graphIri: ASSET_GRAPH,
          nquads: [
            `<${ASSET}> <urn:p:tag> "blue" <${ASSET_GRAPH}> .`,
            `<${ASSET}> <urn:p:name> "published" <${ASSET_GRAPH}> .`,
          ].join('\n'),
        }],
      },
    }));
    expect(encoded.dkgMutation[1]).toBe(BigInt(WAL_V1_ENUMS.mutationOperation.PUT));
    expect(encoded.dkgMutation[3]).toEqual([]);
    expect(encoded.rdfMutation[1]).toBe(BigInt(WAL_V1_ENUMS.mutationMode.REPLACE));
    expect(encoded.rdfMutation[4]).toHaveLength(1);
    expect(encoded.rdfMutation[6]).toHaveLength(0);
    expect(encoded.rdfMutation[7]).toHaveLength(0);
    expect(encoded.result.quadCount).toBe(2);
    const remote = decodeDkgMutationCandidateV1(remoteInput(encoded, { baseNQuads: '' }));
    expect(remote.result.bytes).toEqual(encoded.result.bytes);
  });

  it('encodes a metadata subject replacement without disturbing the asset graph', () => {
    const encoded = encodeAcceptedRdfMutationV1(input({
      source: {
        kind: 'replace',
        subjects: [{
          graphIri: META_GRAPH,
          subjectIri: META_SUBJECT,
          nquads: `<${META_SUBJECT}> <urn:p:version> "2" <${META_GRAPH}> .`,
        }],
      },
    }));
    expect(encoded.rdfMutation[5]).toHaveLength(1);
    expect(encoded.result.text).toContain('"2"');
    expect(encoded.result.text).not.toContain('"1"');
    expect(encoded.result.text).toContain('"old"');
    expect(deriveExplicitRdfCandidateV1({
      rdfMutation: encoded.rdfMutation,
      baseNQuads: baseText,
    }).bytes).toEqual(encoded.result.bytes);
  });

  it('encodes an accepted explicit patch, freezes causal inputs, and never executes audit bytes remotely', () => {
    const encoded = encodeAcceptedRdfMutationV1(input({
      source: {
        kind: 'accepted-patch',
        deletesNQuads: `<${ASSET}> <urn:p:name> "old" <${ASSET_GRAPH}> .`,
        insertsNQuads: `<${ASSET}> <urn:p:name> "new" <${ASSET_GRAPH}> .`,
        sourceAuditBytes: new TextEncoder().encode('existing semantic-core receipt'),
      },
    }));
    expect(encoded.dkgMutation[3]).toEqual([headA, headB]);
    expect(encoded.dkgMutation[4]).toEqual([headA, headB]);
    expect(encoded.rdfMutation[1]).toBe(BigInt(WAL_V1_ENUMS.mutationMode.PATCH));
    expect(new TextDecoder().decode(encoded.rdfMutation[9]!)).toContain('semantic-core receipt');
    expect(encoded.result.text).toContain('"new"');
    expect(encoded.result.text).not.toContain('"old"');
    const maliciousAudit = new TextEncoder().encode('DROP ALL');
    const mutation = [...encoded.rdfMutation] as unknown[];
    mutation[9] = maliciousAudit;
    const applied = deriveExplicitRdfCandidateV1({
      rdfMutation: mutation as unknown as ProtocolTuple<'RdfMutationV1'>,
      baseNQuads: baseText,
    });
    expect(applied.bytes).toEqual(encoded.result.bytes);
    expect(() => encodeAcceptedRdfMutationV1(input({
      source: {
        kind: 'accepted-patch',
        deletesNQuads: '',
        insertsNQuads: '',
        sourceAuditBytes: 'not-bytes' as unknown as Uint8Array,
      },
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
  });

  it('encodes DELETE as the exact whole-logical-key tombstone mutation', () => {
    const encoded = encodeAcceptedRdfMutationV1(input({
      operation: 'DELETE',
      source: { kind: 'delete-logical-key' },
      chainBinding: null,
      nonConsensusTimestampMs: 123n,
    }));
    expect(encoded.dkgMutation[1]).toBe(BigInt(WAL_V1_ENUMS.mutationOperation.DELETE));
    expect(encoded.dkgMutation[8]).toBe(123n);
    expect(encoded.rdfMutation[1]).toBe(BigInt(WAL_V1_ENUMS.mutationMode.PATCH));
    expect(encoded.rdfMutation[6]).toEqual(encoded.base.bytes);
    expect(encoded.rdfMutation[7]).toHaveLength(0);
    expect(encoded.result.quadCount).toBe(0);
    expect(decodeDkgMutationCandidateV1(remoteInput(encoded)).result.quadCount).toBe(0);
  });

  it('authorizes a current member on an explicitly shared logical key only', () => {
    expect(() => encodeAcceptedRdfMutationV1(input({ writerId: sharedWriter }))).not.toThrow();
    expect(() => encodeAcceptedRdfMutationV1(input({
      writerId: outsider,
      memberWriterIds: [author, sharedWriter],
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_UNAUTHORIZED' }));
    expect(() => encodeAcceptedRdfMutationV1(input({
      writerId: sharedWriter,
      policy: policy({ sharedWriteLogicalKeys: [] }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_UNAUTHORIZED' }));
    expect(() => encodeAcceptedRdfMutationV1(input({ writerId: new Uint8Array(19) }))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }),
    );
    expect(() => encodeAcceptedRdfMutationV1(input({ policyObjectId: new Uint8Array(31) }))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }),
    );
  });

  it('rejects malformed logical-key coordinates before encoding any mutation', () => {
    const cases = [
      { contextGraphId: '' },
      { contextGraphId: 'Cafe\u0301' },
      { contextGraphId: 'x'.repeat(513) },
      { subGraphName: 'x'.repeat(129) },
      { authorAddress: new Uint8Array(19) },
    ];
    for (const override of cases) {
      expect(() => encodeAcceptedRdfMutationV1(input({
        logicalKey: { ...logicalKeyCoordinates, ...override },
      }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
    }
  });

  it('freezes base/result digests and exact touched graph-subject-predicate keys', () => {
    const encoded = encodeAcceptedRdfMutationV1(input());
    expect(encoded.rdfMutation[2]).toEqual(canonicalizeNQuadsV1(baseText).stateDigest);
    expect(encoded.rdfMutation[3]).toEqual(encoded.result.stateDigest);
    expect(encoded.rdfMutation[8]).toEqual([
      rdfTouchedKeyV1(ASSET_GRAPH, ASSET, 'urn:p:name'),
    ]);
    expect(encoded.logicalKey).toEqual(logicalKey);
    expect(rdfLogicalKeyV1({ ...logicalKeyCoordinates, subGraphName: null })).toHaveLength(32);
  });

  it('rejects invalid causal relations and encoding-source/operation combinations', () => {
    const cases: Array<[Partial<EncodeAcceptedRdfMutationInputV1>, string]> = [
      [{ parents: [headA] }, 'WAL_RDF_CAUSAL_RELATION'],
      [{ baseHeads: [headA, headA] }, 'WAL_RDF_CAUSAL_RELATION'],
      [{ baseHeads: Array.from({ length: 65 }, (_, index) => bytes(32, index)) }, 'WAL_RDF_LIMIT_EXCEEDED'],
      [{ baseHeads: null as never }, 'WAL_RDF_CAUSAL_RELATION'],
      [{ operation: 'DELETE', source: { kind: 'replace', graphs: [] } }, 'WAL_RDF_POLICY_INVALID'],
      [{ operation: 'PUT', source: {
        kind: 'accepted-patch',
        deletesNQuads: '',
        insertsNQuads: '',
      } }, 'WAL_RDF_POLICY_INVALID'],
      [{ operation: 'PUT', source: { kind: 'delete-logical-key' } }, 'WAL_RDF_POLICY_INVALID'],
    ];
    for (const [override, code] of cases) {
      expect(() => encodeAcceptedRdfMutationV1(input(override))).toThrow(expect.objectContaining({ code }));
    }
  });

  it('rejects replacement overlap, duplicate/empty/escaping scopes, and graph policy escape', () => {
    const cases = [
      { kind: 'replace', graphs: [] },
      { kind: 'replace', graphs: [
        { graphIri: ASSET_GRAPH, nquads: '' },
        { graphIri: ASSET_GRAPH, nquads: '' },
      ] },
      { kind: 'replace', graphs: [{ graphIri: ASSET_GRAPH, nquads: `<urn:s> <urn:p> "x" <${META_GRAPH}> .` }] },
      { kind: 'replace', graphs: [{ graphIri: 'urn:outside', nquads: '' }] },
      { kind: 'replace', graphs: [{ graphIri: ASSET_GRAPH, nquads: '' }], subjects: [
        { graphIri: ASSET_GRAPH, subjectIri: ASSET, nquads: '' },
      ] },
      { kind: 'replace', subjects: [
        { graphIri: META_GRAPH, subjectIri: META_SUBJECT, nquads: '' },
        { graphIri: META_GRAPH, subjectIri: META_SUBJECT, nquads: '' },
      ] },
      { kind: 'replace', subjects: [{
        graphIri: META_GRAPH,
        subjectIri: META_SUBJECT,
        nquads: `<urn:other> <urn:p> "x" <${META_GRAPH}> .`,
      }] },
    ] as const;
    for (const source of cases) {
      expect(() => encodeAcceptedRdfMutationV1(input({ source }))).toThrow();
    }
    expect(() => encodeAcceptedRdfMutationV1(input({ allowedGraphIris: [] }))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }),
    );
    expect(() => encodeAcceptedRdfMutationV1(input({ allowedGraphIris: [ASSET_GRAPH, ASSET_GRAPH] }))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }),
    );
    expect(() => encodeAcceptedRdfMutationV1(input({
      policy: policy({ allowedGraphPrefixes: ['urn:unrelated:'] }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_UNAUTHORIZED' }));
    const tooManyGraphs = Array.from(
      { length: 65 },
      (_, index) => `urn:dkg:graph:${String(index).padStart(2, '0')}`,
    );
    expect(() => encodeAcceptedRdfMutationV1(input({ allowedGraphIris: tooManyGraphs }))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }),
    );
    expect(() => encodeAcceptedRdfMutationV1(input({
      source: {
        kind: 'replace',
        graphs: Array.from({ length: 65 }, () => ({ graphIri: ASSET_GRAPH, nquads: '' })),
      },
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
    expect(() => encodeAcceptedRdfMutationV1(input({
      source: {
        kind: 'replace',
        subjects: Array.from({ length: 4_097 }, (_, index) => ({
          graphIri: META_GRAPH,
          subjectIri: `urn:subject:${index}`,
          nquads: '',
        })),
      },
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
  });

  it('enforces signed payload kind, mutation quad, touched-key, and byte limits', () => {
    expect(() => encodeAcceptedRdfMutationV1(input({
      policy: policy({ allowedPayloadKinds: [BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY)] }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_UNAUTHORIZED' }));
    expect(() => encodeAcceptedRdfMutationV1(input({
      policy: policy({ maxQuadsPerMutation: 1n }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
    const twoAssetQuads = [
      `<${ASSET}> <urn:p:a> "a" <${ASSET_GRAPH}> .`,
      `<${ASSET}> <urn:p:b> "b" <${ASSET_GRAPH}> .`,
    ].join('\n');
    expect(() => encodeAcceptedRdfMutationV1(input({
      operation: 'PUT',
      baseHeads: [],
      baseNQuads: '',
      policy: policy({ maxQuadsPerMutation: 1n }),
      source: { kind: 'replace', graphs: [{ graphIri: ASSET_GRAPH, nquads: twoAssetQuads }] },
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
    const twoMetadataQuads = [
      `<${META_SUBJECT}> <urn:p:a> "a" <${META_GRAPH}> .`,
      `<${META_SUBJECT}> <urn:p:b> "b" <${META_GRAPH}> .`,
    ].join('\n');
    expect(() => encodeAcceptedRdfMutationV1(input({
      policy: policy({ maxQuadsPerMutation: 1n }),
      source: { kind: 'replace', subjects: [{
        graphIri: META_GRAPH,
        subjectIri: META_SUBJECT,
        nquads: twoMetadataQuads,
      }] },
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
    expect(() => encodeAcceptedRdfMutationV1(input({
      operation: 'DELETE',
      source: { kind: 'delete-logical-key' },
      policy: policy({ maxQuadsPerMutation: 2n }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
    expect(() => encodeAcceptedRdfMutationV1(input({
      baseHeads: [],
      baseNQuads: '',
      operation: 'PUT',
      policy: policy({ maxWalObjectBytes: 1n }),
      source: { kind: 'replace', graphs: [{ graphIri: ASSET_GRAPH, nquads: '' }] },
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_OBJECT_TOO_LARGE' }));
    expect(() => encodeAcceptedRdfMutationV1(input({
      nonConsensusTimestampMs: 0x1_0000_0000_0000_0000n,
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));

    const manyTouched = Array.from({ length: 4_097 }, (_, index) =>
      `<${ASSET}> <urn:p:${String(index).padStart(4, '0')}> "x" <${ASSET_GRAPH}> .`).join('\n');
    expect(() => encodeAcceptedRdfMutationV1(input({
      operation: 'PUT',
      baseHeads: [],
      baseNQuads: '',
      policy: policy({ maxQuadsPerMutation: 5_000n, maxWalObjectBytes: 10_000_000n }),
      source: { kind: 'replace', graphs: [{ graphIri: ASSET_GRAPH, nquads: manyTouched }] },
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
  });

  it('rejects remote policy/logical-key/causal substitution and unsupported operation payloads', () => {
    const encoded = encodeAcceptedRdfMutationV1(input());
    expect(() => decodeDkgMutationCandidateV1(remoteInput(encoded, {
      expectedPolicyObjectId: bytes(32, 9),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_SUBSTITUTION' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(encoded, {
      logicalKeyCoordinates: { ...logicalKeyCoordinates, contextGraphId: 'urn:cg:other' },
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(encoded, {
      contentBytes: withDkgMutation(encoded, tuple => { tuple[3] = []; }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_CAUSAL_RELATION' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(encoded, {
      contentBytes: withDkgMutation(encoded, tuple => { tuple[1] = 3n; }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(encoded, {
      contentBytes: withDkgMutation(encoded, tuple => { tuple[6] = null; }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(encoded, {
      policy: policy({ allowedPayloadKinds: [BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY)] }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_UNAUTHORIZED' }));
  });

  it('rejects remote digest, touched-key, mode, deletion, graph, and canonical-byte tampering', () => {
    const patch = encodeAcceptedRdfMutationV1(input());
    const mutations: Array<[Uint8Array, string]> = [
      [withDkgMutation(patch, tuple => { (tuple[6] as unknown[])[2] = bytes(32, 7); }), 'WAL_RDF_BASE_MISMATCH'],
      [withDkgMutation(patch, tuple => { (tuple[6] as unknown[])[3] = bytes(32, 7); }), 'WAL_RDF_RESULT_MISMATCH'],
      [withDkgMutation(patch, tuple => { (tuple[6] as unknown[])[8] = []; }), 'WAL_RDF_TOUCHED_KEYS_MISMATCH'],
      [withDkgMutation(patch, tuple => { (tuple[6] as unknown[])[4] = [[ASSET_GRAPH, new Uint8Array(), 0n]]; }), 'WAL_RDF_NON_CANONICAL'],
    ];
    for (const [contentBytes, code] of mutations) {
      expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, { contentBytes })))
        .toThrow(expect.objectContaining({ code }));
    }
    expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, {
      allowedGraphIris: [META_GRAPH],
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, {
      contentBytes: new Uint8Array([...patch.contentBytes, 0]),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_NON_CANONICAL' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, {
      allowedGraphIris: [],
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, {
      allowedGraphIris: [ASSET_GRAPH, ASSET_GRAPH],
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, {
      allowedGraphIris: Array.from(
        { length: 65 },
        (_, index) => `urn:dkg:graph:${String(index).padStart(2, '0')}`,
      ),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));

    const put = encodeAcceptedRdfMutationV1(input({
      operation: 'PUT', baseHeads: [], baseNQuads: '',
      source: { kind: 'replace', graphs: [{ graphIri: ASSET_GRAPH, nquads: '' }] },
    }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(put, {
      baseNQuads: '',
      contentBytes: withDkgMutation(put, tuple => {
        const rdf = tuple[6] as unknown[];
        rdf[1] = BigInt(WAL_V1_ENUMS.mutationMode.PATCH);
        rdf[4] = [];
      }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));

    const deletion = encodeAcceptedRdfMutationV1(input({ operation: 'DELETE', source: { kind: 'delete-logical-key' } }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(deletion, {
      contentBytes: withDkgMutation(deletion, tuple => {
        (tuple[6] as unknown[])[6] = new Uint8Array();
      }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(deletion, {
      contentBytes: withDkgMutation(deletion, tuple => {
        (tuple[6] as unknown[])[1] = BigInt(WAL_V1_ENUMS.mutationMode.REPLACE);
      }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
  });

  it('rejects malformed explicit mutation tuples, replacement counts/scopes, and policy limits', () => {
    const encoded = encodeAcceptedRdfMutationV1(input({
      source: { kind: 'replace', subjects: [{
        graphIri: META_GRAPH,
        subjectIri: META_SUBJECT,
        nquads: `<${META_SUBJECT}> <urn:p:version> "2" <${META_GRAPH}> .`,
      }] },
    }));
    expect(() => deriveExplicitRdfCandidateV1({ rdfMutation: [1n] as never, baseNQuads: baseText }))
      .toThrow(expect.objectContaining({ code: 'WAL_RDF_NON_CANONICAL' }));
    const badCount = [...encoded.rdfMutation] as unknown[];
    badCount[5] = [[META_GRAPH, META_SUBJECT, encoded.rdfMutation[5][0]![2], 2n]];
    expect(() => deriveExplicitRdfCandidateV1({
      rdfMutation: badCount as unknown as ProtocolTuple<'RdfMutationV1'>,
      baseNQuads: baseText,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_RESULT_MISMATCH' }));
    const escaped = [...encoded.rdfMutation] as unknown[];
    escaped[5] = [[META_GRAPH, 'urn:wrong', encoded.rdfMutation[5][0]![2], 1n]];
    expect(() => deriveExplicitRdfCandidateV1({
      rdfMutation: escaped as unknown as ProtocolTuple<'RdfMutationV1'>,
      baseNQuads: baseText,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }));

    const patchBytes = [...encoded.rdfMutation] as unknown[];
    patchBytes[7] = new TextEncoder().encode(`<urn:s> <urn:p> "x" <${META_GRAPH}> .\n`);
    expect(() => deriveExplicitRdfCandidateV1({
      rdfMutation: patchBytes as unknown as ProtocolTuple<'RdfMutationV1'>,
      baseNQuads: baseText,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_NON_CANONICAL' }));

    const noScope = [...encoded.rdfMutation] as unknown[];
    noScope[4] = [];
    noScope[5] = [];
    expect(() => deriveExplicitRdfCandidateV1({
      rdfMutation: noScope as unknown as ProtocolTuple<'RdfMutationV1'>,
      baseNQuads: baseText,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_NON_CANONICAL' }));

    const graphAndSubject = [...encoded.rdfMutation] as unknown[];
    graphAndSubject[4] = [[META_GRAPH, new Uint8Array(), 0n]];
    expect(() => deriveExplicitRdfCandidateV1({
      rdfMutation: graphAndSubject as unknown as ProtocolTuple<'RdfMutationV1'>,
      baseNQuads: baseText,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }));

    const graphCompiled = encodeAcceptedRdfMutationV1(input({
      operation: 'PUT',
      baseHeads: [],
      baseNQuads: '',
      source: { kind: 'replace', graphs: [{ graphIri: ASSET_GRAPH, nquads: '' }] },
    }));
    const duplicateGraph = [...graphCompiled.rdfMutation] as unknown[];
    duplicateGraph[4] = [
      [ASSET_GRAPH, new Uint8Array(), 0n],
      [ASSET_GRAPH, new TextEncoder().encode(`<urn:s> <urn:p> "x" <${ASSET_GRAPH}> .\n`), 1n],
    ];
    expect(() => deriveExplicitRdfCandidateV1({
      rdfMutation: duplicateGraph as unknown as ProtocolTuple<'RdfMutationV1'>,
      baseNQuads: '',
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }));
  });

  it('enforces remote replacement-list, explicit-quad, result, and payload bounds', () => {
    const patch = encodeAcceptedRdfMutationV1(input());
    const graphReplacements: ProtocolTuple<'GraphReplacementV1'>[] = Array.from(
      { length: 65 },
      (_, index) => [`urn:dkg:graph:${String(index).padStart(2, '0')}`, new Uint8Array(), 0n],
    );
    expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, {
      contentBytes: withDkgMutation(patch, tuple => {
        (tuple[6] as unknown[])[4] = graphReplacements;
      }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));

    const subjectReplacements: ProtocolTuple<'SubjectReplacementV1'>[] = Array.from(
      { length: 4_097 },
      (_, index) => [META_GRAPH, `urn:s:${String(index).padStart(4, '0')}`, new Uint8Array(), 0n],
    );
    expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, {
      contentBytes: withDkgMutation(patch, tuple => {
        (tuple[6] as unknown[])[5] = subjectReplacements;
      }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));

    expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, {
      policy: policy({ maxQuadsPerMutation: 1n }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));

    const subject = encodeAcceptedRdfMutationV1(input({
      source: { kind: 'replace', subjects: [{
        graphIri: META_GRAPH,
        subjectIri: META_SUBJECT,
        nquads: `<${META_SUBJECT}> <urn:p:version> "2" <${META_GRAPH}> .`,
      }] },
    }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(subject, {
      policy: policy({ maxQuadsPerMutation: 2n }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
    expect(() => decodeDkgMutationCandidateV1(remoteInput(patch, {
      policy: policy({ maxWalObjectBytes: 1n }),
    }))).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
  });
});
