import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GENESIS_SNAPSHOT_MEDIA_TYPE_V1,
  LEGACY_GENESIS_MEDIA_TYPE_V1,
  WAL_GENESIS_GRAPH_FAMILIES_V1,
  WAL_V1_ENUMS,
  buildWalGenesisPlanV1,
  createWalGenesisSnapshotArtifactV1,
  createWalGenesisVectorV1,
  createWalLegacyGenesisArtifactV1,
  createWalObjectV1,
  decodeDkgPayloadEnvelope,
  encodeProtocolTuple,
  encodePublicDkgPayload,
  encryptPrivateDkgPayload,
  protocolTupleId,
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  verifyLegacyGenesisV1,
  verifySnapshotBaselineV1,
  type ProtocolTuple,
  type WalEip191Signer,
  type WalGenesisGraphFamilyV1,
  type WalGenesisSourceRowV1,
  type WalMigrationSemanticCoreV1,
  type WalRetentionSemanticCoreV1,
} from '../../src/index.js';

function bytes(label: string, length = 32): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`wal-migration-test-v1\0${label}`).digest().subarray(0, length));
}

function signer(slot: number): WalEip191Signer & { readonly address: Uint8Array } {
  const privateKey = new Uint8Array(32);
  privateKey[31] = slot;
  const digest = new Uint8Array(32);
  const address = recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey));
  return { address, signMessage: value => signEip191DigestWithPrivateKey(value, privateKey) };
}

const author = signer(1);
const migrationSigner = signer(2);
const curator = signer(3);
const collectionId = bytes('collection');
const authorNamespace = bytes('author-namespace');
const legacyNamespace = bytes('legacy-namespace');
const barrierVectorId = bytes('barrier-vector');
const migrationPolicyObjectId = bytes('migration-policy');
const rdfPolicyObjectId = bytes('rdf-policy');
const chainFrontier: ProtocolTuple<'ChainFrontierV1'> = [2043n, 99n, bytes('block')];

function source(rows: readonly WalGenesisSourceRowV1[]) {
  const calls: WalGenesisGraphFamilyV1[] = [];
  return {
    calls,
    readFamily(family: WalGenesisGraphFamilyV1) {
      calls.push(family);
      return (async function* () {
        for (const row of rows) if (row.family === family) yield row;
      })();
    },
  };
}

function rows(): WalGenesisSourceRowV1[] {
  return [
    {
      family: 'SWM_CONTENT',
      collectionId,
      namespaceId: authorNamespace,
      logicalKey: bytes('live-key'),
      visibility: 'public',
      stateKind: 'LIVE',
      graphBytes: '<urn:z> <urn:p> "z" <urn:g> .\n<urn:a> <urn:p> "a" <urn:g> .\n',
      conflictDigest: bytes('conflict'),
      provenance: { kind: 'AUTHOR', writerId: author.address },
      policyObjectId: rdfPolicyObjectId,
      adapterVersion: 1n,
      chainFrontier,
    },
    {
      family: 'SWM_METADATA',
      collectionId,
      namespaceId: authorNamespace,
      logicalKey: bytes('deleted-key'),
      visibility: 'public',
      stateKind: 'TOMBSTONE',
      graphBytes: '',
      stateDigest: bytes('deleted-state'),
      provenance: { kind: 'AUTHOR', writerId: author.address },
      policyObjectId: rdfPolicyObjectId,
      adapterVersion: 1n,
      chainFrontier,
    },
    {
      family: 'VM_CONTENT',
      collectionId,
      namespaceId: legacyNamespace,
      logicalKey: bytes('legacy-key'),
      visibility: 'public',
      stateKind: 'LIVE',
      graphBytes: '<urn:legacy> <urn:p> "value" <urn:g> .\n',
      provenance: { kind: 'UNCLAIMABLE' },
      policyObjectId: rdfPolicyObjectId,
      adapterVersion: 1n,
      chainFrontier,
    },
  ];
}

function retentionCore(): WalRetentionSemanticCoreV1 {
  return {
    authorizeDelete: vi.fn(async () => ({ status: 'rejected' as const, reasonCode: 'not-used' })),
    validateSnapshotEntry: vi.fn(async () => true),
    validateSnapshotConflict: vi.fn(async () => true),
  };
}

function migrationCore(status: 'quarantined' | 'visible' | 'rejected'): WalMigrationSemanticCoreV1 {
  return {
    authorizeLegacyGenesis: vi.fn(async () => ({ status, reasonCode: `policy-${status}` })),
  };
}

describe('WAL-018 genesis migration', () => {
  it('plans deterministically from only fixed local families and creates signed genesis artifacts without pre-WAL heads', async () => {
    const firstSource = source(rows());
    const first = await buildWalGenesisPlanV1({
      collectionId,
      barrierVectorId,
      migrationPolicyObjectId,
      createdAtMs: 1_000,
      source: firstSource,
    });
    const second = await buildWalGenesisPlanV1({
      collectionId,
      barrierVectorId,
      migrationPolicyObjectId,
      createdAtMs: 1_000n,
      source: source([...rows()].reverse()),
    });
    expect(firstSource.calls).toEqual(WAL_GENESIS_GRAPH_FAMILIES_V1);
    expect(first.manifestBytes).toEqual(second.manifestBytes);
    expect(first.manifestDigest).toEqual(second.manifestDigest);
    expect(first.authorLanes).toHaveLength(1);
    expect(first.legacyLanes).toHaveLength(1);
    expect(first.authorLanes[0]!.entries.every(entry => entry[2].length === 0)).toBe(true);
    expect(first.authorLanes[0]!.conflicts[0]![1]).toEqual([]);

    const snapshot = await createWalGenesisSnapshotArtifactV1({
      lane: first.authorLanes[0]!,
      signer: author,
    });
    expect(snapshot.snapshotObject.tuple[2]).toEqual(author.address);
    expect(snapshot.snapshotObject.tuple[3]).toBe(1n);
    expect(snapshot.snapshotObject.tuple[4]).toBe(0n);
    expect(snapshot.headCheckpoint[10]).toEqual(snapshot.snapshotObject.walObjectId);
    await expect(verifySnapshotBaselineV1({
      baselineKind: 'genesis',
      snapshotObjectCanonicalBytes: snapshot.snapshotObject.canonicalBytes,
      coveredCheckpointCanonicalBytes: snapshot.coveredCheckpointBytes,
      coveredObjectIds: [],
      expectedPolicyObjectId: rdfPolicyObjectId,
      expectedAdapterVersion: 1n,
      expectedChainFrontier: chainFrontier,
      semanticCore: retentionCore(),
      externalHeadReachable: () => false,
    })).resolves.toMatchObject({
      snapshotObjectId: snapshot.snapshotObject.walObjectId,
      coveredObjectIds: [],
    });

    const entryWithFabricatedHead = [...first.authorLanes[0]!.entries[0]!] as unknown[];
    entryWithFabricatedHead[2] = [bytes('fabricated-genesis-entry-head')];
    const invalidEntrySnapshot = await createWalGenesisSnapshotArtifactV1({
      lane: {
        ...first.authorLanes[0]!,
        entries: [entryWithFabricatedHead as unknown as ProtocolTuple<'SnapshotEntryV1'>],
      },
      signer: author,
    });
    const verifyInvalidGenesis = (artifact: typeof snapshot) => verifySnapshotBaselineV1({
      baselineKind: 'genesis',
      snapshotObjectCanonicalBytes: artifact.snapshotObject.canonicalBytes,
      coveredCheckpointCanonicalBytes: artifact.coveredCheckpointBytes,
      coveredObjectIds: [],
      expectedPolicyObjectId: rdfPolicyObjectId,
      expectedAdapterVersion: 1n,
      expectedChainFrontier: chainFrontier,
      semanticCore: retentionCore(),
      externalHeadReachable: () => false,
    });
    await expect(verifyInvalidGenesis(invalidEntrySnapshot))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_CLOSURE' });

    const conflictWithFabricatedHead = [...first.authorLanes[0]!.conflicts[0]!] as unknown[];
    conflictWithFabricatedHead[1] = [bytes('fabricated-genesis-conflict-head')];
    const invalidConflictSnapshot = await createWalGenesisSnapshotArtifactV1({
      lane: {
        ...first.authorLanes[0]!,
        conflicts: [conflictWithFabricatedHead as unknown as ProtocolTuple<'SnapshotConflictV1'>],
      },
      signer: author,
    });
    await expect(verifyInvalidGenesis(invalidConflictSnapshot))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_CLOSURE' });

    const legacy = await createWalLegacyGenesisArtifactV1({
      lane: first.legacyLanes[0]!,
      barrierVectorId,
      createdAtMs: 1_000,
      migrationWriterId: migrationSigner.address,
      signer: migrationSigner,
    });
    expect(decodeDkgPayloadEnvelope(legacy.object.payloadBytes)[3]).toBe(LEGACY_GENESIS_MEDIA_TYPE_V1);
    await expect(verifyLegacyGenesisV1({
      canonicalObjectBytes: legacy.object.canonicalBytes,
      expectedCollectionId: collectionId,
      expectedNamespaceId: legacyNamespace,
      expectedMigrationPolicyObjectId: migrationPolicyObjectId,
      expectedBarrierVectorId: barrierVectorId,
      semanticCore: migrationCore('quarantined'),
    })).resolves.toMatchObject({ decision: { status: 'quarantined' } });

    const vector = await createWalGenesisVectorV1({
      plan: first,
      membershipCheckpointId: bytes('membership'),
      activeNamespaceIds: [authorNamespace, legacyNamespace],
      heads: [{
        namespaceId: authorNamespace,
        writerId: author.address,
        checkpointId: protocolTupleId('AuthorCheckpointV1', snapshot.headCheckpoint),
      }],
      vectorEpoch: 0n,
      vectorNumber: 1n,
      issuedAtMs: 1_000,
      expiresAtMs: 2_000,
      finalizedChainFrontier: chainFrontier,
      authoritySetId: bytes('authority'),
      signers: [curator],
    });
    expect(vector.vector[6]).toEqual(barrierVectorId);
    expect(protocolTupleId('CollectionHeadVectorV1', vector.vector)).toEqual(vector.vectorId);
  });

  it('requires the existing private crypto adapter and preserves encrypted visibility', async () => {
    const inputRows = rows();
    inputRows[0] = { ...inputRows[0]!, visibility: 'private' };
    inputRows[1] = { ...inputRows[1]!, visibility: 'private' };
    const plan = await buildWalGenesisPlanV1({
      collectionId,
      barrierVectorId,
      migrationPolicyObjectId,
      createdAtMs: 1_000,
      source: source(inputRows),
    });
    await expect(createWalGenesisSnapshotArtifactV1({
      lane: plan.authorLanes[0]!,
      signer: author,
    })).rejects.toMatchObject({ code: 'WAL_MIGRATION_PRIVATE_ENCODING' });

    const encoded = await createWalGenesisSnapshotArtifactV1({
      lane: plan.authorLanes[0]!,
      signer: author,
      encodePayload: value => encryptPrivateDkgPayload({
        ...value,
        codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
        epochKey: bytes('epoch-key'),
        keyEpoch: 1n,
        nonce: bytes('nonce', 12),
        nonceRegistry: { claimPrivatePayloadNonce: () => undefined },
      }).canonicalBytes,
    });
    const envelope = decodeDkgPayloadEnvelope(encoded.snapshotObject.payloadBytes);
    expect(envelope[3]).toBe(GENESIS_SNAPSHOT_MEDIA_TYPE_V1);
    expect(envelope[4]).not.toBeNull();
  });

  it('fails closed for ambiguous provenance, mixed contexts, malformed legacy bindings, and unauthorized visibility', async () => {
    const invalid = rows();
    invalid[2] = {
      ...invalid[2]!,
      stateKind: 'TOMBSTONE',
      graphBytes: '',
      stateDigest: bytes('legacy-delete'),
    };
    await expect(buildWalGenesisPlanV1({
      collectionId,
      barrierVectorId,
      migrationPolicyObjectId,
      createdAtMs: 1_000,
      source: source(invalid),
    })).rejects.toMatchObject({ code: 'WAL_MIGRATION_PROVENANCE' });

    const mixed = rows();
    mixed[1] = { ...mixed[1]!, adapterVersion: 2n };
    await expect(buildWalGenesisPlanV1({
      collectionId,
      barrierVectorId,
      migrationPolicyObjectId,
      createdAtMs: 1_000,
      source: source(mixed),
    })).rejects.toMatchObject({ code: 'WAL_MIGRATION_MIXED_CONTEXT' });

    const plan = await buildWalGenesisPlanV1({
      collectionId,
      barrierVectorId,
      migrationPolicyObjectId,
      createdAtMs: 1_000,
      source: source(rows()),
    });
    const legacy = await createWalLegacyGenesisArtifactV1({
      lane: plan.legacyLanes[0]!,
      barrierVectorId,
      createdAtMs: 1_000,
      migrationWriterId: migrationSigner.address,
      signer: migrationSigner,
    });
    await expect(verifyLegacyGenesisV1({
      canonicalObjectBytes: legacy.object.canonicalBytes,
      expectedCollectionId: collectionId,
      expectedNamespaceId: legacyNamespace,
      expectedMigrationPolicyObjectId: migrationPolicyObjectId,
      expectedBarrierVectorId: bytes('wrong-barrier'),
      semanticCore: migrationCore('visible'),
    })).rejects.toMatchObject({ code: 'WAL_MIGRATION_LEGACY_BINDING' });
    await expect(verifyLegacyGenesisV1({
      canonicalObjectBytes: legacy.object.canonicalBytes,
      expectedCollectionId: collectionId,
      expectedNamespaceId: legacyNamespace,
      expectedMigrationPolicyObjectId: migrationPolicyObjectId,
      expectedBarrierVectorId: barrierVectorId,
      semanticCore: migrationCore('rejected'),
    })).rejects.toMatchObject({ code: 'WAL_MIGRATION_UNAUTHORIZED' });
  });

  it('rejects every malformed plan coordinate, source row, provenance, duplicate, and mixed lane', async () => {
    const base = {
      collectionId,
      barrierVectorId,
      migrationPolicyObjectId,
      createdAtMs: 1_000,
      source: source(rows()),
    };
    const reject = (overrides: Record<string, unknown>, code = 'WAL_MIGRATION_INVALID') => expect(
      buildWalGenesisPlanV1({ ...base, ...overrides } as never),
    ).rejects.toMatchObject({ code });
    await reject({ collectionId: 'not-bytes' });
    await reject({ collectionId: new Uint8Array(31) });
    await reject({ barrierVectorId: new Uint8Array(31) });
    await reject({ migrationPolicyObjectId: new Uint8Array(31) });
    await reject({ createdAtMs: -1 });
    await reject({ createdAtMs: Number.MAX_SAFE_INTEGER + 1 });
    await reject({ createdAtMs: -1n });
    await reject({ createdAtMs: 0x1_0000_0000_0000_0000n });
    await reject({ source: null });
    await reject({ source: {} });
    await reject({ source: { readFamily: () => [] } });

    const invalidRow = async (
      mutate: (value: WalGenesisSourceRowV1) => WalGenesisSourceRowV1,
      code = 'WAL_MIGRATION_INVALID',
    ) => reject({ source: source([mutate(rows()[0]!)]) }, code);
    await invalidRow(value => ({ ...value, collectionId: bytes('other-collection') }), 'WAL_MIGRATION_MIXED_CONTEXT');
    await invalidRow(value => ({ ...value, namespaceId: new Uint8Array(31) }));
    await invalidRow(value => ({ ...value, logicalKey: new Uint8Array(31) }));
    await invalidRow(value => ({ ...value, policyObjectId: new Uint8Array(31) }));
    await invalidRow(value => ({ ...value, adapterVersion: -1n }));
    await invalidRow(value => ({ ...value, adapterVersion: 0x1_0000n }));
    await invalidRow(value => ({ ...value, visibility: 'unknown' as never }));
    await invalidRow(value => ({ ...value, graphBytes: '<invalid' }));
    await invalidRow(value => ({ ...value, stateDigest: bytes('wrong-live-digest') }));
    await invalidRow(value => ({ ...value, stateKind: 'TOMBSTONE', graphBytes: value.graphBytes }));
    await invalidRow(value => ({ ...value, stateKind: 'TOMBSTONE', graphBytes: '', stateDigest: undefined }));
    await invalidRow(value => ({ ...value, stateKind: 'UNKNOWN' as never }));
    await invalidRow(value => ({ ...value, provenance: { kind: 'AUTHOR', writerId: new Uint8Array(19) } }));
    await invalidRow(value => ({ ...value, provenance: { kind: 'UNKNOWN' } as never }), 'WAL_MIGRATION_PROVENANCE');

    const wrongFamilySource = {
      readFamily(family: WalGenesisGraphFamilyV1) {
        return (async function* () {
          if (family === 'SWM_CONTENT') yield { ...rows()[0]!, family: 'VM_CONTENT' as const };
        })();
      },
    };
    await reject({ source: wrongFamilySource });

    const duplicateAuthor = rows();
    duplicateAuthor.push({ ...duplicateAuthor[0]!, family: 'VM_METADATA' });
    await reject({ source: source(duplicateAuthor) }, 'WAL_MIGRATION_DUPLICATE_STATE');
    const duplicateLegacy = rows();
    duplicateLegacy.push({ ...duplicateLegacy[2]!, family: 'VM_METADATA' });
    await reject({ source: source(duplicateLegacy) }, 'WAL_MIGRATION_DUPLICATE_STATE');
    const mixedLegacy = rows();
    mixedLegacy.push({
      ...mixedLegacy[2]!, family: 'VM_METADATA', logicalKey: bytes('legacy-key-2'), visibility: 'private',
    });
    await reject({ source: source(mixedLegacy) }, 'WAL_MIGRATION_MIXED_CONTEXT');

    for (const change of [
      { visibility: 'private' as const },
      { policyObjectId: bytes('other-policy') },
      { adapterVersion: 2n },
      { chainFrontier: null },
      { chainFrontier: [2043n, 100n, bytes('other-block')] as ProtocolTuple<'ChainFrontierV1'> },
    ]) {
      const mixed = rows();
      mixed[1] = { ...mixed[1]!, ...change };
      await reject({ source: source(mixed) }, 'WAL_MIGRATION_MIXED_CONTEXT');
    }

    const multiple = rows();
    multiple.push({
      ...multiple[0]!, family: 'VM_METADATA', namespaceId: bytes('author-namespace-2'),
      logicalKey: bytes('author-key-2'), provenance: { kind: 'AUTHOR', writerId: signer(4).address },
    });
    multiple.push({
      ...multiple[2]!, family: 'VM_METADATA', namespaceId: bytes('legacy-namespace-2'),
      logicalKey: bytes('legacy-key-2'), graphBytes: '<urn:legacy2> <urn:p> "value" <urn:g> .\n',
    });
    await expect(buildWalGenesisPlanV1({ ...base, source: source(multiple) }))
      .resolves.toMatchObject({ authorLanes: expect.arrayContaining([expect.anything(), expect.anything()]) });
  });

  it('rejects invalid or mismatched payload encoders and verifies private LegacyGenesis through existing crypto', async () => {
    const plan = await buildWalGenesisPlanV1({
      collectionId, barrierVectorId, migrationPolicyObjectId, createdAtMs: 1_000, source: source(rows()),
    });
    const lane = plan.authorLanes[0]!;
    const rejectEncoder = (encodePayload: NonNullable<Parameters<typeof createWalGenesisSnapshotArtifactV1>[0]['encodePayload']>) =>
      expect(createWalGenesisSnapshotArtifactV1({ lane, signer: author, encodePayload }))
        .rejects.toMatchObject({ code: 'WAL_MIGRATION_PRIVATE_ENCODING' });
    await rejectEncoder(() => new Uint8Array());
    await rejectEncoder(value => encodePublicDkgPayload({
      payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
      codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR), mediaType: value.mediaType, contentBytes: value.plaintext,
    }).canonicalBytes);
    await rejectEncoder(value => encodePublicDkgPayload({
      payloadKind: value.payloadKind, codec: BigInt(WAL_V1_ENUMS.codec.OPAQUE_BYTES),
      mediaType: value.mediaType, contentBytes: value.plaintext,
    }).canonicalBytes);
    await rejectEncoder(value => encodePublicDkgPayload({
      payloadKind: value.payloadKind, codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      mediaType: 'application/wrong', contentBytes: value.plaintext,
    }).canonicalBytes);
    await rejectEncoder(value => encodePublicDkgPayload({
      payloadKind: value.payloadKind, codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      mediaType: value.mediaType, contentBytes: bytes('changed-plaintext'),
    }).canonicalBytes);

    const privateRows = rows().map(value => value.provenance.kind === 'UNCLAIMABLE'
      ? { ...value, visibility: 'private' as const }
      : value);
    const privatePlan = await buildWalGenesisPlanV1({
      collectionId, barrierVectorId, migrationPolicyObjectId, createdAtMs: 1_000, source: source(privateRows),
    });
    let plaintext = new Uint8Array();
    const privateArtifact = await createWalLegacyGenesisArtifactV1({
      lane: privatePlan.legacyLanes[0]!, barrierVectorId, createdAtMs: 1_000,
      migrationWriterId: migrationSigner.address, signer: migrationSigner,
      encodePayload: value => {
        plaintext = new Uint8Array(value.plaintext);
        return encryptPrivateDkgPayload({
          ...value, codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR), epochKey: bytes('legacy-epoch-key'),
          keyEpoch: 1n, nonce: bytes('legacy-nonce', 12), nonceRegistry: { claimPrivatePayloadNonce: () => undefined },
        }).canonicalBytes;
      },
    });
    const verifyPrivate = {
      canonicalObjectBytes: privateArtifact.object.canonicalBytes,
      expectedCollectionId: collectionId,
      expectedNamespaceId: legacyNamespace,
      expectedMigrationPolicyObjectId: migrationPolicyObjectId,
      expectedBarrierVectorId: barrierVectorId,
      semanticCore: migrationCore('visible'),
    };
    await expect(verifyLegacyGenesisV1(verifyPrivate))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_PRIVATE_ENCODING' });
    await expect(verifyLegacyGenesisV1({ ...verifyPrivate, decryptPrivate: async () => plaintext }))
      .resolves.toMatchObject({ decision: { status: 'visible' } });
  });

  it('rejects malformed legacy object envelopes and every genesis-vector boundary', async () => {
    const plan = await buildWalGenesisPlanV1({
      collectionId, barrierVectorId, migrationPolicyObjectId, createdAtMs: 1_000, source: source(rows()),
    });
    const legacy = await createWalLegacyGenesisArtifactV1({
      lane: plan.legacyLanes[0]!, barrierVectorId, createdAtMs: 1_000,
      migrationWriterId: migrationSigner.address, signer: migrationSigner,
    });
    const verify = (canonicalObjectBytes: Uint8Array, overrides: Record<string, unknown> = {}) => verifyLegacyGenesisV1({
      canonicalObjectBytes, expectedCollectionId: collectionId, expectedNamespaceId: legacyNamespace,
      expectedMigrationPolicyObjectId: migrationPolicyObjectId, expectedBarrierVectorId: barrierVectorId,
      semanticCore: migrationCore('visible'), ...overrides,
    } as never);
    await expect(verify(new Uint8Array([1]))).rejects.toMatchObject({ code: 'WAL_MIGRATION_LEGACY_BINDING' });
    const wrongEnvelope = encodePublicDkgPayload({
      payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
      codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      mediaType: 'application/wrong', contentBytes: encodeProtocolTuple('LegacyGenesisV1', legacy.legacyGenesis),
    });
    const wrongEnvelopeObject = await createWalObjectV1([
      1n, legacyNamespace, migrationSigner.address, 0n, 0n, null, wrongEnvelope.canonicalBytes,
    ], migrationSigner);
    await expect(verify(wrongEnvelopeObject.canonicalBytes))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_LEGACY_BINDING' });
    await expect(verify(legacy.object.canonicalBytes, { expectedCollectionId: bytes('wrong-collection') }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_LEGACY_BINDING' });
    await expect(verify(legacy.object.canonicalBytes, { expectedNamespaceId: bytes('wrong-namespace') }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_LEGACY_BINDING' });
    await expect(verify(legacy.object.canonicalBytes, { expectedMigrationPolicyObjectId: bytes('wrong-policy') }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_LEGACY_BINDING' });

    const snapshot = await createWalGenesisSnapshotArtifactV1({ lane: plan.authorLanes[0]!, signer: author });
    const baseVector = {
      plan, membershipCheckpointId: bytes('membership'), activeNamespaceIds: [authorNamespace],
      heads: [{ namespaceId: authorNamespace, writerId: author.address,
        checkpointId: protocolTupleId('AuthorCheckpointV1', snapshot.headCheckpoint) }],
      vectorEpoch: 0n, vectorNumber: 1n, issuedAtMs: 1_000, expiresAtMs: 2_000,
      finalizedChainFrontier: chainFrontier, authoritySetId: bytes('authority'), signers: [curator],
    };
    const rejectVector = (overrides: Record<string, unknown>, code = 'WAL_MIGRATION_INVALID') => expect(
      createWalGenesisVectorV1({ ...baseVector, ...overrides } as never),
    ).rejects.toMatchObject({ code });
    await rejectVector({ activeNamespaceIds: [authorNamespace, authorNamespace] }, 'WAL_MIGRATION_DUPLICATE_STATE');
    await rejectVector({ activeNamespaceIds: [new Uint8Array(31)] });
    await rejectVector({ heads: [{ ...baseVector.heads[0], namespaceId: bytes('inactive') }] }, 'WAL_MIGRATION_MIXED_CONTEXT');
    await rejectVector({ heads: [baseVector.heads[0], baseVector.heads[0]] }, 'WAL_MIGRATION_DUPLICATE_STATE');
    await rejectVector({ issuedAtMs: 2_000, expiresAtMs: 2_000 });
    await rejectVector({ issuedAtMs: -1 });
    await rejectVector({ vectorEpoch: -1n });
  });
});
