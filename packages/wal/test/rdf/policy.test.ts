import { describe, expect, it } from 'vitest';
import { encodeProtocolTuple } from '../../src/protocol/codec.js';
import { protocolTupleId } from '../../src/protocol/hashes.js';
import { WAL_V1_ENUMS, type CborProtocolValue, type ProtocolTuple } from '../../src/protocol/schema.js';
import {
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  signThresholdProtocolTuple,
  type WalEip191Signer,
} from '../../src/protocol/signatures.js';
import { createWalObjectV1 } from '../../src/protocol/wal-object.js';
import { encodePublicDkgPayload } from '../../src/privacy/crypto.js';
import { rdfLogicalKeyV1 } from '../../src/rdf/keys.js';
import {
  admitSignedRdfPolicyV1,
  createRdfPolicyV1,
  decodeRdfPolicyV1,
  encodeRdfPolicyPayloadV1,
  encodeRdfPolicyV1,
  validateRdfPolicyV1,
} from '../../src/rdf/policy.js';
import { RDF_POLICY_MEDIA_TYPE_V1 } from '../../src/rdf/types.js';

function key(slot: number): Uint8Array {
  const value = new Uint8Array(32);
  value[31] = slot;
  return value;
}

function signer(slot: number): WalEip191Signer & { readonly address: Uint8Array } {
  const privateKey = key(slot);
  const digest = new Uint8Array(32);
  const address = recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey));
  return {
    address,
    signMessage: value => signEip191DigestWithPrivateKey(value, privateKey),
  };
}

const curator = signer(31);
const writer = signer(32);
const other = signer(33);
const namespaceId = new Uint8Array(32).fill(0x11);
const collectionId = new Uint8Array(32).fill(0x22);
const authoritySetId = new Uint8Array(32).fill(0x33);
const sharedLogicalKey = rdfLogicalKeyV1({
  contextGraphId: 'urn:cg:alpha',
  subGraphName: 'main',
  authorAddress: writer.address,
  knowledgeAssetUalOrRootEntity: 'did:dkg:otp:2043/0xabc/1',
});

function policy(overrides: Partial<Parameters<typeof createRdfPolicyV1>[0]> = {}) {
  return createRdfPolicyV1({
    allowedGraphPrefixes: ['urn:dkg:graph:'],
    maxQuadsPerMutation: 1_000n,
    maxWalObjectBytes: 1_000_000n,
    singleValuedPredicates: ['urn:p:name'],
    multiValuedPredicates: ['urn:p:tag'],
    sharedWriteLogicalKeys: [sharedLogicalKey],
    resolverAddresses: [curator.address],
    expiryAuthorityAddresses: [writer.address],
    allowedPayloadKinds: [
      BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
      BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY),
    ],
    ...overrides,
  });
}

async function signedFixture(options: {
  readonly policy?: ProtocolTuple<'RdfPolicyV1'>;
  readonly envelope?: Uint8Array;
  readonly objectNamespace?: Uint8Array;
  readonly objectWriter?: typeof writer;
  readonly memberNamespaces?: readonly Uint8Array[];
  readonly memberWriters?: readonly Uint8Array[];
  readonly membershipPolicyId?: Uint8Array;
  readonly membershipAuthorityId?: Uint8Array;
} = {}) {
  const exactPolicy = options.policy ?? policy();
  const envelope = options.envelope ?? encodeRdfPolicyPayloadV1(exactPolicy).canonicalBytes;
  const objectWriter = options.objectWriter ?? writer;
  const object = await createWalObjectV1([
    1n,
    options.objectNamespace ?? namespaceId,
    objectWriter.address,
    0n,
    0n,
    null,
    envelope,
  ], objectWriter);
  const membershipUnsigned = [
    1n,
    collectionId,
    0n,
    0n,
    1n,
    [...(options.memberWriters ?? [objectWriter.address])].sort((a, b) => Buffer.compare(a, b)),
    [],
    [],
    [...(options.memberNamespaces ?? [options.objectNamespace ?? namespaceId])]
      .sort((a, b) => Buffer.compare(a, b)),
    options.membershipPolicyId ?? object.walObjectId,
    null,
    100n,
    options.membershipAuthorityId ?? authoritySetId,
  ] satisfies readonly CborProtocolValue[];
  const membership = await signThresholdProtocolTuple(
    'MembershipCheckpointV1',
    membershipUnsigned,
    [curator],
  );
  return {
    exactPolicy,
    object,
    membership,
    membershipId: protocolTupleId('MembershipCheckpointV1', membership),
  };
}

function admissionInput(fixture: Awaited<ReturnType<typeof signedFixture>>) {
  return {
    currentMembershipCheckpoint: fixture.membership,
    expectedMembershipCheckpointId: fixture.membershipId,
    expectedAuthoritySetId: authoritySetId,
    membershipAuthority: { signerAddresses: [curator.address], threshold: 1 },
    canonicalWalObjectBytes: fixture.object.canonicalBytes,
    expectedNamespaceId: namespaceId,
  };
}

describe('signed RDF policy v1', () => {
  it('creates a deterministic sorted exact tuple and round-trips canonical bytes', () => {
    const tuple = createRdfPolicyV1({
      allowedGraphPrefixes: ['urn:z:', 'urn:a:'],
      maxQuadsPerMutation: 10n,
      maxWalObjectBytes: 20n,
      singleValuedPredicates: ['urn:p:z', 'urn:p:a'],
      multiValuedPredicates: ['urn:p:y'],
      sharedWriteLogicalKeys: [new Uint8Array(32).fill(2), new Uint8Array(32).fill(1)],
      resolverAddresses: [other.address, curator.address],
      expiryAuthorityAddresses: [writer.address],
      allowedPayloadKinds: [1n, 0n],
    });
    expect(tuple[1]).toBe(1n);
    expect(tuple[2]).toEqual(['urn:a:', 'urn:z:']);
    expect(tuple[5]).toEqual(['urn:p:a', 'urn:p:z']);
    const bytes = encodeRdfPolicyV1(tuple);
    expect(decodeRdfPolicyV1(bytes)).toEqual(tuple);
    const envelope = encodeRdfPolicyPayloadV1(tuple);
    expect(envelope.tuple.slice(0, 5)).toEqual([
      1n,
      BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY),
      BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      RDF_POLICY_MEDIA_TYPE_V1,
      null,
    ]);
  });

  it('defaults every optional policy list to an empty exact set', () => {
    const tuple = createRdfPolicyV1({
      allowedGraphPrefixes: ['urn:g:'],
      maxQuadsPerMutation: 1n,
      maxWalObjectBytes: 1n,
      allowedPayloadKinds: [BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY)],
    });
    expect(tuple.slice(5, 10)).toEqual([[], [], [], [], []]);
    expect(() => createRdfPolicyV1({
      allowedGraphPrefixes: null as never,
      maxQuadsPerMutation: 1n,
      maxWalObjectBytes: 1n,
      allowedPayloadKinds: [BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY)],
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
  });

  it('admits only the current threshold-signed membership policy object', async () => {
    const fixture = await signedFixture();
    const admitted = admitSignedRdfPolicyV1(admissionInput(fixture));
    expect(admitted.policy).toEqual(fixture.exactPolicy);
    expect(admitted.policyObjectId).toEqual(fixture.object.walObjectId);
    expect(admitted.membershipCheckpointId).toEqual(fixture.membershipId);
    expect(admitted.namespaceId).toEqual(namespaceId);
    expect(admitted.writerId).toEqual(writer.address);
    expect(admitted.canonicalWalObjectBytes).toEqual(fixture.object.canonicalBytes);
  });

  it.each([
    [{ adapterVersion: 2n }, 'WAL_RDF_ADAPTER_VERSION'],
    [{ allowedGraphPrefixes: [] }, 'WAL_RDF_POLICY_INVALID'],
    [{ allowedGraphPrefixes: Array.from({ length: 65 }, (_, index) => `urn:g:${index}:`) }, 'WAL_RDF_POLICY_INVALID'],
    [{ maxQuadsPerMutation: 0n }, 'WAL_RDF_POLICY_INVALID'],
    [{ maxQuadsPerMutation: 1_000_001n }, 'WAL_RDF_POLICY_INVALID'],
    [{ maxWalObjectBytes: 0n }, 'WAL_RDF_POLICY_INVALID'],
    [{ maxWalObjectBytes: 8_589_934_593n }, 'WAL_RDF_POLICY_INVALID'],
    [{ singleValuedPredicates: ['urn:p:x'], multiValuedPredicates: ['urn:p:x'] }, 'WAL_RDF_POLICY_INVALID'],
    [{ allowedPayloadKinds: [] }, 'WAL_RDF_POLICY_INVALID'],
    [{ allowedPayloadKinds: [65_535n] }, 'WAL_RDF_POLICY_INVALID'],
    [{ allowedGraphPrefixes: ['urn:g:', 'urn:g:'] }, 'WAL_RDF_POLICY_INVALID'],
  ] as const)('rejects invalid policy input %#', (override, code) => {
    expect(() => policy(override)).toThrow(expect.objectContaining({ code }));
  });

  it('rejects malformed policy tuples and unsupported decode versions', () => {
    expect(() => validateRdfPolicyV1([1n] as never)).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }),
    );
    expect(() => decodeRdfPolicyV1(Uint8Array.of(0xff))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }),
    );
    const tuple = policy();
    expect(() => decodeRdfPolicyV1(encodeRdfPolicyV1(tuple), [2n])).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_ADAPTER_VERSION' }),
    );
  });

  it('rejects malformed fixed-width policy principals and keys', () => {
    for (const override of [
      { sharedWriteLogicalKeys: [new Uint8Array(31)] },
      { resolverAddresses: [new Uint8Array(19)] },
      { expiryAuthorityAddresses: [new Uint8Array(21)] },
    ]) {
      expect(() => policy(override)).toThrow(
        expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }),
      );
    }
  });

  it('rejects membership, authority, policy-object, namespace, and writer substitution', async () => {
    const fixture = await signedFixture();
    const cases = [
      { expectedMembershipCheckpointId: new Uint8Array(32) },
      { expectedAuthoritySetId: new Uint8Array(32) },
      { expectedNamespaceId: new Uint8Array(32) },
    ];
    for (const override of cases) {
      expect(() => admitSignedRdfPolicyV1({ ...admissionInput(fixture), ...override }))
        .toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_SUBSTITUTION' }));
    }
    expect(() => admitSignedRdfPolicyV1({
      ...admissionInput(fixture),
      membershipAuthority: { signerAddresses: [other.address], threshold: 1 },
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));

    const wrongPolicy = await signedFixture({ membershipPolicyId: new Uint8Array(32) });
    expect(() => admitSignedRdfPolicyV1(admissionInput(wrongPolicy))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_POLICY_SUBSTITUTION' }),
    );
    const wrongNamespace = await signedFixture({ memberNamespaces: [new Uint8Array(32).fill(9)] });
    expect(() => admitSignedRdfPolicyV1({ ...admissionInput(wrongNamespace), expectedNamespaceId: undefined }))
      .toThrow(expect.objectContaining({ code: 'WAL_RDF_UNAUTHORIZED' }));
    const wrongWriter = await signedFixture({ memberWriters: [other.address] });
    expect(() => admitSignedRdfPolicyV1(admissionInput(wrongWriter))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_UNAUTHORIZED' }),
    );
  });

  it('rejects malformed, private, mislabeled, unsupported, and self-oversized policy envelopes', async () => {
    const malformed = await signedFixture({ envelope: Uint8Array.of(0xff) });
    expect(() => admitSignedRdfPolicyV1(admissionInput(malformed))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }),
    );
    const wrongKindEnvelope = encodePublicDkgPayload({
      payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
      codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      mediaType: RDF_POLICY_MEDIA_TYPE_V1,
      contentBytes: encodeRdfPolicyV1(policy()),
    }).canonicalBytes;
    const wrongKind = await signedFixture({ envelope: wrongKindEnvelope });
    expect(() => admitSignedRdfPolicyV1(admissionInput(wrongKind))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }),
    );
    const privateEnvelopeTuple: ProtocolTuple<'DkgPayloadEnvelopeV1'> = [
      1n,
      BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY),
      BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      RDF_POLICY_MEDIA_TYPE_V1,
      [0n, 0n, new Uint8Array(12), new Uint8Array(32)],
      encodeRdfPolicyV1(policy()),
    ];
    const privatePolicy = await signedFixture({
      envelope: encodeProtocolTuple('DkgPayloadEnvelopeV1', privateEnvelopeTuple),
    });
    expect(() => admitSignedRdfPolicyV1(admissionInput(privatePolicy))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }),
    );
    const noPolicyKind = await signedFixture({ policy: policy({
      allowedPayloadKinds: [BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION)],
    }) });
    expect(() => admitSignedRdfPolicyV1(admissionInput(noPolicyKind))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }),
    );
    const tiny = await signedFixture({ policy: policy({ maxWalObjectBytes: 1n }) });
    expect(() => admitSignedRdfPolicyV1(admissionInput(tiny))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_OBJECT_TOO_LARGE' }),
    );
  });

  it('enforces local admission byte bounds and canonical signed objects', async () => {
    const fixture = await signedFixture();
    for (const maximumWalObjectBytes of [0, Number.NaN, 8_589_934_593]) {
      expect(() => admitSignedRdfPolicyV1({ ...admissionInput(fixture), maximumWalObjectBytes }))
        .toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
    }
    expect(() => admitSignedRdfPolicyV1({
      ...admissionInput(fixture),
      maximumWalObjectBytes: fixture.object.canonicalBytes.length - 1,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_OBJECT_TOO_LARGE' }));
    expect(() => admitSignedRdfPolicyV1({
      ...admissionInput(fixture),
      canonicalWalObjectBytes: null as never,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
    const corrupted = new Uint8Array(fixture.object.canonicalBytes);
    corrupted[corrupted.length - 1] ^= 1;
    expect(() => admitSignedRdfPolicyV1({
      ...admissionInput(fixture),
      canonicalWalObjectBytes: corrupted,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_POLICY_INVALID' }));
  });
});
