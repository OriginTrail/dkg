import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MutableSetCommitment,
  WAL_V1_ENUMS,
  canonicalizeNQuadsV1,
  compareCanonicalCbor,
  createWalObjectV1,
  encodeProtocolTuple,
  encodePublicDkgPayload,
  protocolTupleId,
  recoverEip191Address,
  selectBaselineForPeerV1,
  signEip191DigestWithPrivateKey,
  signSingleProtocolTuple,
  validateDeleteOrExpiryV1,
  verifySnapshotBaselineV1,
  verifySnapshotCustodyForGcV1,
  type ProtocolTuple,
  type WalEip191Signer,
  type WalRetentionSemanticCoreV1,
} from '../../src/index.js';
import { walObjectId } from '../../src/reconciliation/ids.js';

function bytes(label: string, length = 32): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`wal-retention-test-v1\0${label}`).digest().subarray(0, length));
}

function signer(slot: number): WalEip191Signer & { readonly address: Uint8Array } {
  const privateKey = new Uint8Array(32);
  privateKey[31] = slot;
  const digest = new Uint8Array(32);
  const address = recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey));
  return { address, signMessage: value => signEip191DigestWithPrivateKey(value, privateKey) };
}

const author = signer(1);
const custodianA = signer(2);
const custodianB = signer(3);
const namespaceId = bytes('namespace');
const policyObjectId = bytes('policy');
const liveGraph = canonicalizeNQuadsV1('<urn:s> <urn:p> "value" <urn:g> .\n');
const emptyDigest = bytes('deleted-state');

function policy(): ProtocolTuple<'RdfPolicyV1'> {
  return [1n, 1n, ['urn:'], 1_000n, 1_000_000n, [], [], [], [], [custodianA.address], [0n, 2n]];
}

function mutation(
  basis: ProtocolTuple<'DeleteBasisV1'> | null,
  parents: readonly Uint8Array[] = [bytes('parent')],
): ProtocolTuple<'DkgMutationV1'> {
  return [
    1n,
    BigInt(WAL_V1_ENUMS.mutationOperation.DELETE),
    bytes('logical-key'),
    parents,
    parents,
    policyObjectId,
    [
      1n,
      BigInt(WAL_V1_ENUMS.mutationMode.REPLACE),
      bytes('base-state'),
      canonicalizeNQuadsV1('').stateDigest,
      [],
      [],
      liveGraph.bytes,
      new Uint8Array(),
      [bytes('touched')],
      null,
    ],
    null,
    basis,
    null,
  ];
}

function semanticCore(
  decision: Awaited<ReturnType<WalRetentionSemanticCoreV1['authorizeDelete']>> = {
    status: 'accepted', evidence: { kind: 'owner' },
  },
): WalRetentionSemanticCoreV1 {
  return {
    authorizeDelete: vi.fn(async () => decision),
    validateSnapshotEntry: vi.fn(async () => true),
    validateSnapshotConflict: vi.fn(async () => true),
  };
}

async function snapshotFixture() {
  const oldA = await createWalObjectV1([
    1n, namespaceId, author.address, 4n, 0n, null, bytes('old-a'),
  ], author);
  const oldB = await createWalObjectV1([
    1n, namespaceId, author.address, 4n, 1n, oldA.walObjectId, bytes('old-b'),
  ], author);
  const coveredIds = [oldA.walObjectId, oldB.walObjectId].map(walObjectId);
  const set = new MutableSetCommitment(coveredIds);
  const checkpoint = await signSingleProtocolTuple('AuthorCheckpointV1', [
    1n, namespaceId, author.address, 4n, 1n, 1n, set.root, 2n, 1n, bytes('previous-checkpoint'), null, 0n,
  ], author);
  const checkpointId = protocolTupleId('AuthorCheckpointV1', checkpoint);
  const externalHead = bytes('external-head');
  const entries = ([
    [bytes('live-key'), BigInt(WAL_V1_ENUMS.snapshotEntryState.LIVE), [oldA.walObjectId], liveGraph.stateDigest, liveGraph.bytes],
    [bytes('tombstone-key'), BigInt(WAL_V1_ENUMS.snapshotEntryState.TOMBSTONE), [oldB.walObjectId], emptyDigest, new Uint8Array()],
  ] satisfies ProtocolTuple<'SnapshotEntryV1'>[]).sort(compareCanonicalCbor);
  const conflicts = ([
    [entries[0]![0], [externalHead], [oldA.walObjectId], bytes('conflict-digest')],
  ] satisfies ProtocolTuple<'SnapshotConflictV1'>[]).sort(compareCanonicalCbor);
  const frontier: ProtocolTuple<'ChainFrontierV1'> = [2043n, 99n, bytes('block')];
  const manifest: ProtocolTuple<'SnapshotManifestV1'> = [
    1n,
    namespaceId,
    author.address,
    5n,
    4n,
    checkpointId,
    set.root,
    2n,
    2n,
    entries,
    conflicts,
    policyObjectId,
    1n,
    frontier,
  ];
  const envelope = encodePublicDkgPayload({
    payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.SNAPSHOT_MANIFEST),
    codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
    mediaType: 'application/vnd.origintrail.wal-snapshot-manifest+cbor',
    contentBytes: encodeProtocolTuple('SnapshotManifestV1', manifest),
  });
  const snapshot = await createWalObjectV1([
    1n, namespaceId, author.address, 5n, 0n, null, envelope.canonicalBytes,
  ], author);
  return { oldA, oldB, coveredIds, checkpoint, checkpointId, manifest, frontier, snapshot, externalHead };
}

type SnapshotFixture = Awaited<ReturnType<typeof snapshotFixture>>;

async function snapshotForManifest(
  value: SnapshotFixture,
  manifest: ProtocolTuple<'SnapshotManifestV1'>,
  options: {
    readonly envelope?: ProtocolTuple<'DkgPayloadEnvelopeV1'>;
    readonly sequence?: bigint;
    readonly previousObjectId?: Uint8Array | null;
  } = {},
) {
  const envelope = options.envelope ?? encodePublicDkgPayload({
    payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.SNAPSHOT_MANIFEST),
    codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
    mediaType: 'application/vnd.origintrail.wal-snapshot-manifest+cbor',
    contentBytes: encodeProtocolTuple('SnapshotManifestV1', manifest),
  }).tuple;
  return createWalObjectV1([
    1n,
    namespaceId,
    author.address,
    manifest[3],
    options.sequence ?? 0n,
    options.previousObjectId ?? null,
    encodeProtocolTuple('DkgPayloadEnvelopeV1', envelope),
  ], author);
}

function snapshotVerificationInput(value: SnapshotFixture) {
  return {
    snapshotObjectCanonicalBytes: value.snapshot.canonicalBytes,
    coveredCheckpointCanonicalBytes: encodeProtocolTuple('AuthorCheckpointV1', value.checkpoint),
    coveredObjectIds: value.coveredIds,
    expectedPolicyObjectId: policyObjectId,
    expectedAdapterVersion: 1n,
    expectedChainFrontier: value.frontier,
    semanticCore: semanticCore(),
    externalHeadReachable: async () => true,
  } as const;
}

describe('WAL-v1 delete and policy expiry admission', () => {
  it('accepts an owner delete only through the shared semantic core', async () => {
    const core = semanticCore();
    await expect(validateDeleteOrExpiryV1({
      namespaceId, writerId: author.address, mutation: mutation(null), policy: policy(), semanticCore: core,
    })).resolves.toMatchObject({ evidence: { kind: 'owner' } });
    expect(core.authorizeDelete).toHaveBeenCalledOnce();
  });

  it('accepts exact signed-vector or finalized-chain evidence at or after expiry', async () => {
    const vectorId = bytes('vector');
    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: custodianA.address,
      mutation: mutation([5_000n, vectorId, null]),
      policy: policy(),
      semanticCore: semanticCore({
        status: 'accepted', evidence: { kind: 'curator-vector', vectorId, issuedAtMs: 5_000n },
      }),
    })).resolves.toMatchObject({ evidence: { kind: 'curator-vector' } });

    const frontier: ProtocolTuple<'ChainFrontierV1'> = [1n, 77n, bytes('expiry-block')];
    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: custodianA.address,
      mutation: mutation([5_000n, null, frontier]),
      policy: policy(),
      semanticCore: semanticCore({
        status: 'accepted',
        evidence: { kind: 'finalized-chain-frontier', frontier, blockTimestampMs: 5_001n },
      }),
    })).resolves.toMatchObject({ evidence: { kind: 'finalized-chain-frontier' } });
  });

  it('rejects local-clock-only, stale, mismatched, unauthorized, and non-causal expiry', async () => {
    const vectorId = bytes('vector-stale');
    const staleCore = semanticCore({
      status: 'accepted', evidence: { kind: 'curator-vector', vectorId, issuedAtMs: 4_999n },
    });
    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: custodianA.address,
      mutation: mutation([5_000n, vectorId, null]),
      policy: policy(),
      semanticCore: staleCore,
      // No now/local-clock field exists by design.
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_EXPIRY_EVIDENCE' });

    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: custodianA.address,
      mutation: mutation([5_000n, vectorId, null]),
      policy: policy(),
      semanticCore: semanticCore({ status: 'rejected', reasonCode: 'NOT_EXPIRY_AUTHORITY' }),
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_UNAUTHORIZED' });

    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: author.address,
      mutation: mutation(null, []),
      policy: policy(),
      semanticCore: semanticCore(),
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_DELETE_CAUSAL' });
  });

  it('fails closed for malformed/non-delete tuples and mismatched semantic evidence kinds', async () => {
    const malformed = [...mutation(null)] as unknown[];
    malformed[0] = 2n;
    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: author.address,
      mutation: malformed as unknown as ProtocolTuple<'DkgMutationV1'>,
      policy: policy(),
      semanticCore: semanticCore(),
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_INVALID' });

    const put = [...mutation(null)] as unknown[];
    put[1] = BigInt(WAL_V1_ENUMS.mutationOperation.PUT);
    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: author.address,
      mutation: put as unknown as ProtocolTuple<'DkgMutationV1'>,
      policy: policy(),
      semanticCore: semanticCore(),
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_INVALID' });

    const vectorId = bytes('evidence-kind-vector');
    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: author.address,
      mutation: mutation(null),
      policy: policy(),
      semanticCore: semanticCore({
        status: 'accepted', evidence: { kind: 'curator-vector', vectorId, issuedAtMs: 9_000n },
      }),
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_EXPIRY_EVIDENCE' });
    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: author.address,
      mutation: mutation([5_000n, vectorId, null]),
      policy: policy(),
      semanticCore: semanticCore(),
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_EXPIRY_EVIDENCE' });

    const signedFrontier: ProtocolTuple<'ChainFrontierV1'> = [1n, 77n, bytes('signed-frontier')];
    const otherFrontier: ProtocolTuple<'ChainFrontierV1'> = [1n, 78n, bytes('other-frontier')];
    await expect(validateDeleteOrExpiryV1({
      namespaceId,
      writerId: custodianA.address,
      mutation: mutation([5_000n, null, signedFrontier]),
      policy: policy(),
      semanticCore: semanticCore({
        status: 'accepted',
        evidence: { kind: 'finalized-chain-frontier', frontier: otherFrontier, blockTimestampMs: 5_001n },
      }),
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_EXPIRY_EVIDENCE' });
  });
});

describe('WAL-v1 author snapshot baseline', () => {
  it('verifies authorship, checkpoint/root, inline live state, tombstone, conflict, policy, adapter, and VM frontier', async () => {
    const value = await snapshotFixture();
    const core = semanticCore();
    const verified = await verifySnapshotBaselineV1({
      snapshotObjectCanonicalBytes: value.snapshot.canonicalBytes,
      coveredCheckpointCanonicalBytes: encodeProtocolTuple('AuthorCheckpointV1', value.checkpoint),
      coveredObjectIds: value.coveredIds,
      expectedPolicyObjectId: policyObjectId,
      expectedAdapterVersion: 1n,
      expectedChainFrontier: value.frontier,
      semanticCore: core,
      externalHeadReachable: id => Buffer.from(id).equals(Buffer.from(value.externalHead)),
    });
    expect(verified.snapshotObjectId).toEqual(value.snapshot.walObjectId);
    expect(core.validateSnapshotEntry).toHaveBeenCalledTimes(2);
    expect(core.validateSnapshotConflict).toHaveBeenCalledOnce();
  });

  it('requires baseline installation below the floor and allows delta reconciliation at/above it', async () => {
    const value = await snapshotFixture();
    expect(selectBaselineForPeerV1({
      manifest: value.manifest,
      snapshotObjectId: value.snapshot.walObjectId,
      retainedWriterEpoch: null,
      retainedCoveredEpochObjectCount: 0n,
    })).toMatchObject({ action: 'install-baseline' });
    expect(selectBaselineForPeerV1({
      manifest: value.manifest,
      snapshotObjectId: value.snapshot.walObjectId,
      retainedWriterEpoch: 4n,
      retainedCoveredEpochObjectCount: 1n,
    })).toMatchObject({ action: 'install-baseline' });
    expect(selectBaselineForPeerV1({
      manifest: value.manifest,
      snapshotObjectId: value.snapshot.walObjectId,
      retainedWriterEpoch: 4n,
      retainedCoveredEpochObjectCount: 2n,
    })).toEqual({ action: 'reconcile-delta' });
  });

  it('fails closed for stale policy/frontier, wrong closure, non-canonical state, unreachable conflict, or semantic rejection', async () => {
    const value = await snapshotFixture();
    const base = {
      snapshotObjectCanonicalBytes: value.snapshot.canonicalBytes,
      coveredCheckpointCanonicalBytes: encodeProtocolTuple('AuthorCheckpointV1', value.checkpoint),
      coveredObjectIds: value.coveredIds,
      expectedPolicyObjectId: policyObjectId,
      expectedAdapterVersion: 1n,
      expectedChainFrontier: value.frontier,
      semanticCore: semanticCore(),
      externalHeadReachable: async () => true,
    } as const;
    await expect(verifySnapshotBaselineV1({ ...base, expectedPolicyObjectId: bytes('wrong-policy') }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_BINDING' });
    await expect(verifySnapshotBaselineV1({ ...base, coveredObjectIds: [value.oldA.walObjectId] }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_CLOSURE' });
    await expect(verifySnapshotBaselineV1({ ...base, externalHeadReachable: async () => false }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_CLOSURE' });
    const rejecting = semanticCore();
    vi.mocked(rejecting.validateSnapshotEntry).mockResolvedValue(false);
    await expect(verifySnapshotBaselineV1({ ...base, semanticCore: rejecting }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_UNAUTHORIZED' });
  });

  it('rejects every malformed snapshot binding, state, and conflict boundary', async () => {
    const value = await snapshotFixture();
    const base = snapshotVerificationInput(value);
    const liveIndex = value.manifest[9].findIndex(
      entry => entry[1] === BigInt(WAL_V1_ENUMS.snapshotEntryState.LIVE),
    );
    const tombstoneIndex = value.manifest[9].findIndex(
      entry => entry[1] === BigInt(WAL_V1_ENUMS.snapshotEntryState.TOMBSTONE),
    );
    const verifyManifest = async (
      manifest: ProtocolTuple<'SnapshotManifestV1'>,
      overrides: Record<string, unknown> = {},
    ) => verifySnapshotBaselineV1({
      ...base,
      snapshotObjectCanonicalBytes: (await snapshotForManifest(value, manifest)).canonicalBytes,
      ...overrides,
    });

    await expect(verifySnapshotBaselineV1({ ...base, baselineKind: 'unsupported' as never }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_INVALID' });
    await expect(verifySnapshotBaselineV1({ ...base, baselineKind: 'genesis' }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_BINDING' });

    const wrongEnvelope = encodePublicDkgPayload({
      payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
      codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      mediaType: 'application/vnd.origintrail.wal-dkg-mutation+cbor',
      contentBytes: encodeProtocolTuple('SnapshotManifestV1', value.manifest),
    }).tuple;
    const wrongEnvelopeObject = await snapshotForManifest(value, value.manifest, { envelope: wrongEnvelope });
    await expect(verifySnapshotBaselineV1({
      ...base,
      snapshotObjectCanonicalBytes: wrongEnvelopeObject.canonicalBytes,
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_BINDING' });
    await expect(verifySnapshotBaselineV1({
      ...base,
      coveredCheckpointCanonicalBytes: bytes('bad-checkpoint', 8),
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_BINDING' });

    const wrongSequence = await snapshotForManifest(value, value.manifest, {
      sequence: 1n,
      previousObjectId: bytes('snapshot-previous'),
    });
    await expect(verifySnapshotBaselineV1({
      ...base,
      snapshotObjectCanonicalBytes: wrongSequence.canonicalBytes,
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_BINDING' });

    const wrongFloor = [...value.manifest] as unknown[];
    wrongFloor[8] = 1n;
    await expect(verifyManifest(wrongFloor as unknown as ProtocolTuple<'SnapshotManifestV1'>))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_BINDING' });
    await expect(verifySnapshotBaselineV1({ ...base, expectedAdapterVersion: 2n }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_BINDING' });
    await expect(verifySnapshotBaselineV1({ ...base, expectedChainFrontier: null }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_BINDING' });
    await expect(verifySnapshotBaselineV1({
      ...base,
      coveredObjectIds: [value.oldA.walObjectId, value.oldA.walObjectId],
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_CLOSURE' });

    const duplicateEntries = [...value.manifest] as unknown[];
    const repeatedKeyEntryMutable = [...value.manifest[9][0]!] as unknown[];
    repeatedKeyEntryMutable[3] = bytes('different-digest-same-key');
    const repeatedKeyEntry = repeatedKeyEntryMutable as unknown as ProtocolTuple<'SnapshotEntryV1'>;
    duplicateEntries[9] = [value.manifest[9][0], repeatedKeyEntry].sort(compareCanonicalCbor);
    await expect(verifyManifest(duplicateEntries as unknown as ProtocolTuple<'SnapshotManifestV1'>))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_STATE' });
    const uncoveredHead = [...value.manifest] as unknown[];
    const uncoveredEntries = value.manifest[9].map(entry => [...entry]) as unknown[][];
    uncoveredEntries[0]![2] = [bytes('uncovered-head')];
    uncoveredHead[9] = uncoveredEntries;
    await expect(verifyManifest(uncoveredHead as unknown as ProtocolTuple<'SnapshotManifestV1'>))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_CLOSURE' });

    const nonCanonical = [...value.manifest] as unknown[];
    const nonCanonicalEntries = value.manifest[9].map(entry => [...entry]) as unknown[][];
    nonCanonicalEntries[liveIndex]![4] = new TextEncoder().encode('<urn:s> <urn:p> "z" <urn:g> .\n<urn:a> <urn:p> "a" <urn:g> .\n');
    nonCanonical[9] = nonCanonicalEntries;
    await expect(verifyManifest(nonCanonical as unknown as ProtocolTuple<'SnapshotManifestV1'>))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_STATE' });

    const badDigest = [...value.manifest] as unknown[];
    const badDigestEntries = value.manifest[9].map(entry => [...entry]) as unknown[][];
    badDigestEntries[liveIndex]![3] = bytes('wrong-state-digest');
    badDigest[9] = badDigestEntries;
    await expect(verifyManifest(badDigest as unknown as ProtocolTuple<'SnapshotManifestV1'>))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_STATE' });

    const tombstoneBytes = [...value.manifest] as unknown[];
    const tombstoneEntries = value.manifest[9].map(entry => [...entry]) as unknown[][];
    tombstoneEntries[tombstoneIndex]![4] = new TextEncoder().encode('not-empty');
    tombstoneBytes[9] = tombstoneEntries;
    await expect(verifyManifest(tombstoneBytes as unknown as ProtocolTuple<'SnapshotManifestV1'>))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_STATE' });

    const unknownConflictKey = [...value.manifest] as unknown[];
    const conflicts = value.manifest[10].map(conflict => [...conflict]) as unknown[][];
    conflicts[0]![0] = bytes('unknown-conflict-key');
    unknownConflictKey[10] = conflicts;
    await expect(verifyManifest(unknownConflictKey as unknown as ProtocolTuple<'SnapshotManifestV1'>))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_CLOSURE' });

    const conflictRejecting = semanticCore();
    vi.mocked(conflictRejecting.validateSnapshotConflict).mockResolvedValue(false);
    await expect(verifySnapshotBaselineV1({ ...base, semanticCore: conflictRejecting }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_UNAUTHORIZED' });
  });

  it('requires authenticated private decryption and accepts its verified manifest bytes', async () => {
    const value = await snapshotFixture();
    const base = snapshotVerificationInput(value);
    const manifestBytes = encodeProtocolTuple('SnapshotManifestV1', value.manifest);
    const privateEnvelope: ProtocolTuple<'DkgPayloadEnvelopeV1'> = [
      1n,
      BigInt(WAL_V1_ENUMS.payloadKind.SNAPSHOT_MANIFEST),
      BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      'application/vnd.origintrail.wal-snapshot-manifest+cbor',
      [BigInt(WAL_V1_ENUMS.encryptionAlgorithm.AES_256_GCM), 1n, bytes('nonce', 12), bytes('aad')],
      bytes('ciphertext'),
    ];
    const privateObject = await snapshotForManifest(value, value.manifest, { envelope: privateEnvelope });
    await expect(verifySnapshotBaselineV1({
      ...base,
      snapshotObjectCanonicalBytes: privateObject.canonicalBytes,
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_SNAPSHOT_BINDING' });
    await expect(verifySnapshotBaselineV1({
      ...base,
      snapshotObjectCanonicalBytes: privateObject.canonicalBytes,
      decryptPrivateManifest: async () => manifestBytes,
    })).resolves.toMatchObject({ snapshotObjectId: privateObject.walObjectId });
  });
});

async function receipt(
  custodian: WalEip191Signer & { readonly address: Uint8Array },
  snapshotObjectId: Uint8Array,
  membershipId: Uint8Array,
  peer: string,
  expiresAtMs = 40_000n,
): Promise<ProtocolTuple<'SnapshotCustodyReceiptV1'>> {
  return signSingleProtocolTuple('SnapshotCustodyReceiptV1', [
    1n,
    snapshotObjectId,
    custodian.address,
    new TextEncoder().encode(peer),
    membershipId,
    1_000n,
    expiresAtMs,
    bytes(`nonce:${peer}`, 16),
  ], custodian);
}

describe('WAL-v1 snapshot custody and GC gate', () => {
  it('requires a vector, elapsed grace, and two distinct current durable custodians', async () => {
    const snapshotObjectId = bytes('snapshot');
    const membershipId = bytes('membership');
    const receipts = await Promise.all([
      receipt(custodianA, snapshotObjectId, membershipId, 'peer-a'),
      receipt(custodianB, snapshotObjectId, membershipId, 'peer-b'),
    ]);
    const verified = await verifySnapshotCustodyForGcV1({
      snapshotObjectId,
      authorAddress: author.address,
      currentMembershipCheckpointId: membershipId,
      receipts,
      graceStartedAtMs: 1_000n,
      retentionGraceMs: 30_000n,
      evaluatedAtMs: 31_000n,
      newEpochCheckpointVectorBound: true,
      validateCurrentCustodian: async () => ({
        current: true, authorized: true, peerMatchesAgent: true, removedOrRevoked: false,
      }),
    });
    expect(verified.receiptIds).toHaveLength(2);
  });

  it('rejects early GC, missing vector, insufficient, expired, removed, duplicate, or forged receipts', async () => {
    const snapshotObjectId = bytes('snapshot-negative');
    const membershipId = bytes('membership-negative');
    const a = await receipt(custodianA, snapshotObjectId, membershipId, 'peer-a');
    const b = await receipt(custodianB, snapshotObjectId, membershipId, 'peer-b');
    const base = {
      snapshotObjectId,
      authorAddress: author.address,
      currentMembershipCheckpointId: membershipId,
      receipts: [a, b],
      graceStartedAtMs: 1_000n,
      retentionGraceMs: 30_000n,
      evaluatedAtMs: 31_000n,
      newEpochCheckpointVectorBound: true,
      validateCurrentCustodian: async () => ({
        current: true, authorized: true, peerMatchesAgent: true, removedOrRevoked: false,
      }),
    } as const;
    await expect(verifySnapshotCustodyForGcV1({ ...base, evaluatedAtMs: 30_999n }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_GRACE_ACTIVE' });
    await expect(verifySnapshotCustodyForGcV1({ ...base, newEpochCheckpointVectorBound: false }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_VECTOR_REQUIRED' });
    await expect(verifySnapshotCustodyForGcV1({ ...base, receipts: [a] }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_CUSTODY_INSUFFICIENT' });
    await expect(verifySnapshotCustodyForGcV1({
      ...base,
      validateCurrentCustodian: async () => ({
        current: false, authorized: false, peerMatchesAgent: true, removedOrRevoked: true,
      }),
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_CUSTODY_INVALID' });
    await expect(verifySnapshotCustodyForGcV1({ ...base, receipts: [a, a] }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_CUSTODY_INVALID' });
    const forged = [...a] as unknown[];
    forged[8] = new Uint8Array(a[8]);
    (forged[8] as Uint8Array)[0] ^= 1;
    await expect(verifySnapshotCustodyForGcV1({
      ...base,
      receipts: [forged as unknown as ProtocolTuple<'SnapshotCustodyReceiptV1'>, b],
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_CUSTODY_INVALID' });
  });

  it('rejects invalid thresholds, negative times, and receipt bindings outside the retention interval', async () => {
    const snapshotObjectId = bytes('snapshot-input-negative');
    const membershipId = bytes('membership-input-negative');
    const receipts = await Promise.all([
      receipt(custodianA, snapshotObjectId, membershipId, 'peer-a'),
      receipt(custodianB, snapshotObjectId, membershipId, 'peer-b'),
    ]);
    const base = {
      snapshotObjectId,
      authorAddress: author.address,
      currentMembershipCheckpointId: membershipId,
      receipts,
      graceStartedAtMs: 1_000n,
      retentionGraceMs: 30_000n,
      evaluatedAtMs: 31_000n,
      newEpochCheckpointVectorBound: true,
      validateCurrentCustodian: async () => ({
        current: true, authorized: true, peerMatchesAgent: true, removedOrRevoked: false,
      }),
    } as const;
    await expect(verifySnapshotCustodyForGcV1({ ...base, minimumAdditionalCustodians: 0 }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_INVALID' });
    await expect(verifySnapshotCustodyForGcV1({ ...base, retentionGraceMs: -1n }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_INVALID' });
    await expect(verifySnapshotCustodyForGcV1({ ...base, snapshotObjectId: bytes('wrong-snapshot') }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_CUSTODY_INVALID' });
    await expect(verifySnapshotCustodyForGcV1({ ...base, evaluatedAtMs: 40_001n }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_CUSTODY_INVALID' });
  });
});
