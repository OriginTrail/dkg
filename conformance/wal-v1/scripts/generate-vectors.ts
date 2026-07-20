import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareBytes, concat, equalBytes, hash, hex, utf8 } from '../src/bytes.js';
import { encodeCanonical } from '../src/cbor.js';
import { decodeDifference, deriveReconciliationSeed, encodeSymbolCbor, encodeSymbols, mappingIndexForState, mappingIndices } from '../src/iblt.js';
import {
  independentCborEncode,
  independentEncodeReplayConflictProjection,
  independentRoot,
  independentSymbols,
  independentVerifyWalObject
} from '../src/independent.js';
import {
  FIXTURE_PRIVATE_KEY,
  assertPublicMoveTierSafe,
  authorFinalityRequirement,
  collectionId,
  createWalObject,
  derivePrivateObjectKey,
  encryptAes256Gcm,
  moveTierCommitment,
  moveTierTargetMutationDigest,
  namespaceId,
  payloadAssociatedDataDigest,
  encodeReplayConflictProjection,
  sampleEnvelope,
  signTuple,
  signatureMessage,
  type ReplayConflictProjectionInput
} from '../src/reference.js';
import { createMembershipProof, setCommitmentRoot } from '../src/set-commitment.js';
import { DOMAINS, ENUMS, IBLT_ALGORITHM, LIMITS, SCHEMA } from '../src/schema.js';
import {
  independentCanonicalNQuads,
  independentRdfLogicalKey,
  independentRdfStateDigest,
  independentRdfTouchedKey
} from '../src/rdf.js';
import { decodeUnsignedVarint, encodeUnsignedVarint, encodeWireFrame } from '../src/wire.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, '../vectors/protocol-v1.json');
const schemaPath = resolve(here, '../vectors/protocol-v1.schema.json');
const normativeVectorsPath = resolve(
  here,
  '../../../docs/active-now/wal-parallel-protocol-task-pack/vectors/OT-RFC-65-protocol-v1.json'
);
const normativeSchemaPath = resolve(
  here,
  '../../../docs/active-now/wal-parallel-protocol-task-pack/vectors/OT-RFC-65-protocol-v1.schema.json'
);

function fixtureId(label: string): Uint8Array {
  return hash('dkg-wal-fixture-id-v1\0', utf8(label));
}

function byteRange(start: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 255);
}

function symbolJson(symbol: ReturnType<typeof encodeSymbols>[number]) {
  return {
    index: symbol.index,
    count: symbol.count.toString(),
    idXor: hex(symbol.idXor),
    checksumXor: hex(symbol.checksumXor),
    cbor: hex(encodeSymbolCbor(symbol))
  };
}

function proofJson(proof: ReturnType<typeof createMembershipProof>) {
  return {
    walObjectId: hex(proof.id),
    leafPrefixNibbleLength: proof.leafPrefixLength,
    leafIds: proof.leafIds.map(hex),
    path: proof.path.map((level) => ({
      parentPrefixNibbleLength: level.parentPrefixLength,
      childBitmap: level.childBitmap,
      childNibble: level.childNibble,
      siblings: level.siblings.map((sibling) => ({
        nibble: sibling.nibble,
        childCount: sibling.count,
        childHash: hex(sibling.hash)
      }))
    }))
  };
}

async function buildVectors() {
  const mappingBoundaryInputs = [
    { name: 'zero-state', state: 0n, index: 0 },
    { name: 'exact-square-root-four', state: 3n, index: 0 },
    { name: 'exact-square-root-sixteen', state: 15n, index: 1 },
    { name: 'below-binary64-integer-rounding-boundary', state: 9_007_199_254_740_991n, index: 0 },
    { name: 'at-binary64-integer-rounding-boundary', state: 9_007_199_254_740_992n, index: 1 },
    { name: 'first-rounded-u64', state: 9_007_199_254_740_993n, index: 1_048_576 },
    { name: 'high-bit-u64', state: 9_223_372_036_854_775_807n, index: 1_048_576 },
    { name: 'maximum-u64-minus-one', state: 18_446_744_073_709_551_614n, index: 4_294_967_296 },
    { name: 'maximum-u64-high-index', state: 18_446_744_073_709_551_615n, index: Number.MAX_SAFE_INTEGER - 2 }
  ];
  const collectionKey = ['otp:2043', 'urn:dkg:cg:wal-fixture', null, BigInt(ENUMS.visibility.PUBLIC)] as const;
  const viewKey = [
    'otp:2043',
    'urn:dkg:cg:wal-fixture',
    null,
    BigInt(ENUMS.tier.SWM),
    BigInt(ENUMS.visibility.PUBLIC),
    7n,
    null
  ] as const;
  const collection = collectionId(collectionKey);
  const namespace = namespaceId(viewKey);
  const rdfCanonicalInput = '  <urn:s:z> <urn:p:name> "Cafe\\u0301"@EN <urn:g> .\r\n'
    + '<urn:s:a> <urn:p:link> <urn:o> <urn:g> .\n'
    + '<urn:s:z> <urn:p:name> "Caf\\u00E9"@en <urn:g> . # duplicate\n';
  const rdfCanonical = independentCanonicalNQuads(rdfCanonicalInput);
  const rdfAuthorAddress = byteRange(0xa0, 20);
  const rdfLogicalCoordinates = {
    contextGraphId: 'urn:cg:fixture',
    subGraphName: 'main',
    authorAddress: rdfAuthorAddress,
    entity: 'did:dkg:otp:2043/0xabc/1'
  } as const;
  const rdfLogicalKey = independentRdfLogicalKey(rdfLogicalCoordinates);
  const rdfTouchedKeys = [
    independentRdfTouchedKey('urn:g', 'urn:s:a', 'urn:p:link'),
    independentRdfTouchedKey('urn:g', 'urn:s:z', 'urn:p:name')
  ].sort(compareBytes);
  const rdfPolicyObjectId = fixtureId('rdf-policy-v1');
  const rdfPolicy = [
    1n,
    1n,
    ['urn:g'],
    100n,
    1_000_000n,
    ['urn:p:name'],
    ['urn:p:link'],
    [],
    [],
    [],
    [BigInt(ENUMS.payloadKind.DKG_MUTATION), BigInt(ENUMS.payloadKind.RDF_POLICY)]
  ] as const;
  const rdfResultDigest = independentRdfStateDigest(rdfCanonical);
  const rdfReplaceMutation = [
    1n,
    BigInt(ENUMS.mutationMode.REPLACE),
    independentRdfStateDigest(new Uint8Array()),
    rdfResultDigest,
    [['urn:g', rdfCanonical, 2n]],
    [],
    new Uint8Array(),
    new Uint8Array(),
    rdfTouchedKeys,
    null
  ] as const;
  const rdfDkgMutation = [
    1n,
    BigInt(ENUMS.mutationOperation.PUT),
    rdfLogicalKey,
    [],
    [],
    rdfPolicyObjectId,
    rdfReplaceMutation,
    null,
    null,
    null
  ] as const;
  const logicalKey = fixtureId('logical-key');
  const policyObjectId = fixtureId('rdf-policy');
  const baseStateDigest = fixtureId('base-state');
  const resultStateDigest = fixtureId('result-state');
  const touchedKey = fixtureId('touched-key/name');
  const insertNQuads = utf8('<urn:dkg:s> <urn:dkg:p:name> "Alice" <urn:dkg:g> .\n');
  const rdfMutation = [
    1n,
    BigInt(ENUMS.mutationMode.PATCH),
    baseStateDigest,
    resultStateDigest,
    [],
    [],
    new Uint8Array(),
    insertNQuads,
    [touchedKey],
    utf8('INSERT DATA { GRAPH <urn:dkg:g> { <urn:dkg:s> <urn:dkg:p:name> "Alice" } }')
  ] as const;
  const mutation = [
    1n,
    BigInt(ENUMS.mutationOperation.PATCH),
    logicalKey,
    [],
    [],
    policyObjectId,
    rdfMutation,
    null,
    null,
    1_750_000_000_000n
  ] as const;
  const payload = sampleEnvelope(encodeCanonical(mutation));
  const firstObject = createWalObject({
    namespaceId: namespace,
    writerEpoch: 3n,
    sequence: 0n,
    previousObjectId: null,
    payloadBytes: payload
  });
  const changedObject = createWalObject({
    namespaceId: namespace,
    writerEpoch: 3n,
    sequence: 0n,
    previousObjectId: null,
    payloadBytes: concat(payload, Uint8Array.of(0))
  });
  const secondObject = createWalObject({
    namespaceId: namespace,
    writerEpoch: 3n,
    sequence: 1n,
    previousObjectId: firstObject.id,
    payloadBytes: sampleEnvelope(encodeCanonical([1n, 'second']))
  });

  const decodedByIndependent = independentVerifyWalObject(firstObject.canonicalBytes);
  if (!equalBytes(decodedByIndependent.id, firstObject.id)) throw new Error('independent WalObjectId mismatch');
  if (!equalBytes(independentCborEncode([
    1n,
    firstObject.namespaceId,
    firstObject.writerId,
    firstObject.writerEpoch,
    firstObject.sequence,
    firstObject.previousObjectId,
    firstObject.payloadBytes,
    firstObject.signature
  ]), firstObject.canonicalBytes)) throw new Error('independent CBOR mismatch');

  const unsigned = [
    1n,
    firstObject.namespaceId,
    firstObject.writerId,
    firstObject.writerEpoch,
    firstObject.sequence,
    firstObject.previousObjectId,
    firstObject.payloadBytes
  ] as const;
  const fullTuple = [...unsigned, firstObject.signature];
  const missingField = encodeCanonical(fullTuple.slice(0, 7));
  const extraField = encodeCanonical([...fullTuple, null]);
  const nonShortestVersion = concat(Uint8Array.of(0x88, 0x18, 0x01), firstObject.canonicalBytes.slice(2));
  const indefiniteTuple = concat(Uint8Array.of(0x9f), firstObject.canonicalBytes.slice(1), Uint8Array.of(0xff));
  const reorderedTuple = encodeCanonical([
    1n,
    firstObject.writerId,
    firstObject.namespaceId,
    firstObject.writerEpoch,
    firstObject.sequence,
    firstObject.previousObjectId,
    firstObject.payloadBytes,
    firstObject.signature
  ]);
  const changedUnsignedOriginalSignature = encodeCanonical([
    ...unsigned.slice(0, 6),
    concat(firstObject.payloadBytes, Uint8Array.of(0)),
    firstObject.signature
  ]);

  const objectLength = firstObject.canonicalBytes.length;
  const cutA = Math.floor(objectLength / 3);
  const cutB = Math.floor(objectLength * 2 / 3);
  const range = (offset: number, end: number) => ({
    walObjectId: hex(firstObject.id),
    totalObjectLength: objectLength.toString(),
    offset: offset.toString(),
    bytes: hex(firstObject.canonicalBytes.slice(offset, end)),
    cbor: hex(encodeCanonical([firstObject.id, BigInt(objectLength), BigInt(offset), firstObject.canonicalBytes.slice(offset, end)]))
  });

  const commitmentIds = Array.from({ length: 257 }, (_, index) => fixtureId(`set/${index.toString().padStart(3, '0')}`));
  const emptyRoot = setCommitmentRoot([]);
  const oneRoot = setCommitmentRoot([commitmentIds[0]]);
  const splitRoot = setCommitmentRoot(commitmentIds);
  if (!equalBytes(splitRoot, independentRoot(commitmentIds))) throw new Error('independent set root mismatch');
  const proofTarget = [...commitmentIds].sort(compareBytes)[128];
  const membershipProof = createMembershipProof(commitmentIds, proofTarget);

  const receiverIds = [fixtureId('iblt/common-a'), fixtureId('iblt/common-b'), fixtureId('iblt/receiver-only')];
  const providerIds = [fixtureId('iblt/common-a'), fixtureId('iblt/common-b'), fixtureId('iblt/provider-only-a'), fixtureId('iblt/provider-only-b')];
  const requesterHeadId = fixtureId('requester-head');
  const providerHeadId = fixtureId('provider-head');
  const requesterNonce = fixtureId('requester-nonce');
  const reconciliationSeed = deriveReconciliationSeed(requesterHeadId, providerHeadId, requesterNonce);
  let symbolCount = 1;
  let providerSymbols = encodeSymbols(providerIds, reconciliationSeed, symbolCount);
  let decode = decodeDifference(providerSymbols, receiverIds, reconciliationSeed);
  while (!decode.complete && symbolCount < 512) {
    symbolCount += 1;
    providerSymbols = encodeSymbols(providerIds, reconciliationSeed, symbolCount);
    decode = decodeDifference(providerSymbols, receiverIds, reconciliationSeed);
  }
  if (!decode.complete) throw new Error('IBLT fixture failed to peel');
  const independentSymbolOutput = independentSymbols(providerIds, reconciliationSeed, symbolCount);
  if (providerSymbols.some((symbol, index) => !equalBytes(encodeSymbolCbor(symbol), encodeSymbolCbor(independentSymbolOutput[index])))) {
    throw new Error('independent IBLT symbols mismatch');
  }

  const encryptionEpochKey = byteRange(0, 32);
  const encryptionNonce = byteRange(32, 12);
  const encryptionFields = {
    namespaceId: namespace,
    writerId: firstObject.writerId,
    writerEpoch: firstObject.writerEpoch,
    sequence: 2n,
    envelopeVersion: 1 as const,
    payloadKind: ENUMS.payloadKind.DKG_MUTATION,
    codec: ENUMS.codec.DETERMINISTIC_CBOR,
    mediaType: 'application/vnd.origintrail.dkg-mutation+cbor',
    keyEpoch: 9n,
    nonce: encryptionNonce
  };
  const associatedDataDigest = payloadAssociatedDataDigest(encryptionFields);
  const encryptionObjectKey = derivePrivateObjectKey(encryptionEpochKey, encryptionFields);
  const plaintext = encodeCanonical([1n, 'private mutation', fixtureId('private-state')]);
  const ciphertext = encryptAes256Gcm(encryptionObjectKey, encryptionNonce, plaintext, associatedDataDigest);
  const encryptedEnvelope = encodeCanonical([
    1n,
    BigInt(encryptionFields.payloadKind),
    BigInt(encryptionFields.codec),
    encryptionFields.mediaType,
    [BigInt(ENUMS.encryptionAlgorithm.AES_256_GCM), encryptionFields.keyEpoch, encryptionNonce, associatedDataDigest],
    ciphertext
  ]);

  const sourceNamespaceId = fixtureId('private-source-namespace');
  const targetNamespaceId = fixtureId('public-target-namespace');
  const transitionNonce = fixtureId('transition-nonce');
  const sourceState = fixtureId('source-state');
  const sourceResult = fixtureId('source-result');
  const sourceCausalOpening = fixtureId('private-source-causal-opening');
  const sourceGraphName = 'urn:dkg:private-source-graph';
  const sourceKeyEpoch = 987_654_321n;
  const sourceActivityCount = 123_456_789n;
  const targetRdfMutation = [
    ...rdfMutation.slice(0, 9),
    null
  ] as const;
  const targetChainBinding = [
    2043n,
    byteRange(0x40, 20),
    fixtureId('target-context-graph-on-chain'),
    fixtureId('target-ka-id'),
    byteRange(0x60, 20),
    1n,
    resultStateDigest,
    fixtureId('target-transaction'),
    21_000_000n,
    fixtureId('target-block'),
    2n,
    3n,
    BigInt(ENUMS.chainEventType.PUBLISH),
    64n
  ] as const;
  const targetDkgMutation = [
    1n,
    BigInt(ENUMS.mutationOperation.MOVE_TIER_TARGET),
    logicalKey,
    [],
    [],
    policyObjectId,
    targetRdfMutation,
    targetChainBinding,
    null,
    null
  ] as const;
  const targetMutationDigest = moveTierTargetMutationDigest(targetDkgMutation);
  const transitionCommitment = moveTierCommitment({
    nonce: transitionNonce,
    sourceNamespaceId,
    targetNamespaceId,
    targetMutationDigest,
    sourceStateDigest: sourceState,
    sourceResultDigest: sourceResult
  });
  const publicMoveTier = encodeCanonical([1n, transitionCommitment, targetDkgMutation]);
  const privateMoveTier = encodeCanonical([
    1n,
    transitionNonce,
    transitionCommitment,
    targetNamespaceId,
    secondObject.id,
    [firstObject.id],
    sourceState,
    sourceResult
  ]);
  assertPublicMoveTierSafe(publicMoveTier, [sourceNamespaceId, transitionNonce, firstObject.id, sourceState, sourceResult]);

  const snapshotEntry = [
    logicalKey,
    BigInt(ENUMS.snapshotEntryState.LIVE),
    [secondObject.id],
    resultStateDigest,
    insertNQuads
  ] as const;
  const snapshotTombstone = [
    fixtureId('deleted-logical-key'),
    BigInt(ENUMS.snapshotEntryState.TOMBSTONE),
    [fixtureId('delete-head')],
    independentRdfStateDigest(new Uint8Array()),
    new Uint8Array()
  ] as const;
  const snapshotEntries = [snapshotEntry, snapshotTombstone]
    .sort((left, right) => compareBytes(encodeCanonical(left), encodeCanonical(right)));
  const snapshotManifest = [
    1n,
    namespace,
    firstObject.writerId,
    4n,
    3n,
    fixtureId('covered-checkpoint'),
    setCommitmentRoot([firstObject.id, secondObject.id]),
    2n,
    2n,
    snapshotEntries,
    [],
    policyObjectId,
    1n,
    null
  ] as const;
  const snapshotBytes = encodeCanonical(snapshotManifest);
  const receiptUnsigned = [
    1n,
    fixtureId('snapshot-object'),
    firstObject.writerId,
    utf8('fixture-custodian-peer'),
    fixtureId('membership-checkpoint'),
    1_750_000_000_000n,
    1_752_678_400_000n,
    byteRange(80, 16)
  ] as const;
  const receiptSignature = signTuple(DOMAINS.receiptSignature, receiptUnsigned);
  const custodyReceiptBytes = encodeCanonical([...receiptUnsigned, receiptSignature]);

  const idA = fixtureId('replay-conflict/a');
  const idB = fixtureId('replay-conflict/b');
  const idBase = fixtureId('replay-conflict/base');
  const replayConflictCases: ReplayConflictProjectionInput[] = [
    { name: 'semantic-core-causal-successor', semanticStatus: 'apply', semanticActiveHeads: [idBase], semanticConflictHeads: [] },
    { name: 'semantic-core-disjoint-patches', semanticStatus: 'merge', semanticActiveHeads: [idA, idB], semanticConflictHeads: [] },
    { name: 'semantic-core-overlapping-patches', semanticStatus: 'conflict', semanticActiveHeads: [idBase], semanticConflictHeads: [idA, idB] },
    { name: 'semantic-core-replace-versus-patch', semanticStatus: 'conflict', semanticActiveHeads: [idBase], semanticConflictHeads: [idA, idB] },
    { name: 'semantic-core-delete-versus-update', semanticStatus: 'conflict', semanticActiveHeads: [idBase], semanticConflictHeads: [idA, idB] },
    { name: 'semantic-core-complete-resolution', semanticStatus: 'apply', semanticActiveHeads: [idBase], semanticConflictHeads: [] },
    { name: 'semantic-core-incomplete-resolution', semanticStatus: 'conflict', semanticActiveHeads: [idBase], semanticConflictHeads: [idA, idB] },
    { name: 'semantic-core-tier-pending', semanticStatus: 'pending', semanticActiveHeads: [idBase], semanticConflictHeads: [] },
    { name: 'semantic-core-tier-active', semanticStatus: 'apply', semanticActiveHeads: [idBase], semanticConflictHeads: [] }
  ];
  const replayConflictVectors = replayConflictCases.map((item) => {
    const reference = encodeReplayConflictProjection(item);
    const independent = independentEncodeReplayConflictProjection(item);
    if (
      reference.status !== independent.status ||
      !equalBytes(reference.headDigest, independent.headDigest) ||
      !equalBytes(reference.conflictDigest, independent.conflictDigest)
    ) throw new Error(`independent replay-conflict mismatch for ${item.name}`);
    return {
      name: item.name,
      input: {
        semanticStatus: item.semanticStatus,
        semanticActiveHeads: item.semanticActiveHeads.map(hex),
        semanticConflictHeads: item.semanticConflictHeads.map(hex)
      },
      expected: {
        status: reference.status,
        activeHeads: reference.activeHeads.map(hex),
        conflictHeads: reference.conflictHeads.map(hex),
        headDigest: hex(reference.headDigest),
        conflictDigest: hex(reference.conflictDigest)
      }
    };
  });

  const signatureEntryBytes = (signature: Uint8Array) => [firstObject.writerId, signature] as const;
  const authorityUnsigned = [
    1n,
    BigInt(ENUMS.authorityScope.CURATOR),
    'otp:2043',
    1n,
    1n,
    [firstObject.writerId],
    1_750_000_000_000n,
    1_800_000_000_000n,
    null,
    []
  ] as const;
  const authoritySignature = signTuple(DOMAINS.authoritySignature, authorityUnsigned);
  const authorityBytes = encodeCanonical([...authorityUnsigned, [signatureEntryBytes(authoritySignature)]]);
  const authoritySetId = hash(DOMAINS.authorityId, authorityBytes);
  const objectSetRoot = setCommitmentRoot([firstObject.id, secondObject.id]);
  const checkpointUnsigned = [
    1n,
    namespace,
    firstObject.writerId,
    3n,
    2n,
    1n,
    objectSetRoot,
    2n,
    1n,
    null,
    null,
    0n
  ] as const;
  const checkpointSignature = signTuple(DOMAINS.checkpointSignature, checkpointUnsigned);
  const checkpointBytes = encodeCanonical([...checkpointUnsigned, checkpointSignature]);
  const checkpointId = hash(DOMAINS.checkpointId, checkpointBytes);
  const membershipUnsigned = [
    1n,
    collection,
    1n,
    7n,
    BigInt(ENUMS.publishMode.OPEN),
    [firstObject.writerId],
    [],
    [],
    [namespace],
    policyObjectId,
    null,
    1_750_000_005_000n,
    authoritySetId
  ] as const;
  const membershipSignature = signTuple(DOMAINS.membershipSignature, membershipUnsigned);
  const membershipBytes = encodeCanonical([...membershipUnsigned, [signatureEntryBytes(membershipSignature)]]);
  const membershipId = hash(DOMAINS.membershipId, membershipBytes);
  const vectorUnsigned = [
    1n,
    collection,
    membershipId,
    [[namespace, [[firstObject.writerId, checkpointId]]]],
    1n,
    1n,
    null,
    1_750_000_005_000n,
    1_750_000_065_000n,
    null,
    authoritySetId
  ] as const;
  const vectorSignature = signTuple(DOMAINS.vectorSignature, vectorUnsigned);
  const vectorBytes = encodeCanonical([...vectorUnsigned, [signatureEntryBytes(vectorSignature)]]);
  const vectorId = hash(DOMAINS.vectorId, vectorBytes);
  const expiryDeleteRdfMutation = [
    1n,
    BigInt(ENUMS.mutationMode.PATCH),
    rdfResultDigest,
    independentRdfStateDigest(new Uint8Array()),
    [],
    [],
    rdfCanonical,
    new Uint8Array(),
    rdfTouchedKeys,
    null
  ] as const;
  const expiryDeleteBasis = [1_750_000_004_000n, vectorId, null] as const;
  const expiryDeleteMutation = [
    1n,
    BigInt(ENUMS.mutationOperation.DELETE),
    rdfLogicalKey,
    [firstObject.id],
    [firstObject.id],
    rdfPolicyObjectId,
    expiryDeleteRdfMutation,
    null,
    expiryDeleteBasis,
    null
  ] as const;
  const tierReceiptUnsigned = [
    1n,
    transitionCommitment,
    targetNamespaceId,
    secondObject.id,
    policyObjectId,
    vectorId,
    1_750_000_065_000n,
    authoritySetId
  ] as const;
  const tierReceiptSignature = signTuple(DOMAINS.receiptSignature, tierReceiptUnsigned);
  const tierReceiptBytes = encodeCanonical([
    ...tierReceiptUnsigned,
    [signatureEntryBytes(tierReceiptSignature)]
  ]);
  const downgradedVectorUnsigned = [
    ...vectorUnsigned.slice(0, 4),
    0n,
    9n,
    vectorId,
    1_750_000_010_000n,
    1_750_000_070_000n,
    null,
    authoritySetId
  ] as const;
  const downgradedVectorSignature = signTuple(DOMAINS.vectorSignature, downgradedVectorUnsigned);
  const downgradedVectorBytes = encodeCanonical([
    ...downgradedVectorUnsigned,
    [signatureEntryBytes(downgradedVectorSignature)]
  ]);
  const cutoverUnsigned = [
    1n,
    'otp:2043',
    1n,
    1n,
    '10.2.0',
    fixtureId('collection-vector-manifest-object'),
    fixtureId('cutover-cohort-manifest-object'),
    5n,
    [[[2043n, 21_000_000n, fixtureId('activation-block')]], 1_760_000_000_000n],
    true,
    authoritySetId
  ] as const;
  const cutoverAuthoritySignature = signTuple(DOMAINS.cutoverSignature, cutoverUnsigned);
  const cutoverBytes = encodeCanonical([...cutoverUnsigned, [signatureEntryBytes(cutoverAuthoritySignature)]]);
  const cutoverId = hash(DOMAINS.cutoverId, cutoverBytes);
  const unsafeCutoverUnsigned = [
    ...cutoverUnsigned.slice(0, 9),
    false,
    authoritySetId
  ] as const;
  const unsafeCutoverSignature = signTuple(DOMAINS.cutoverSignature, unsafeCutoverUnsigned);
  const unsafeCutoverBytes = encodeCanonical([
    ...unsafeCutoverUnsigned,
    [signatureEntryBytes(unsafeCutoverSignature)]
  ]);

  const sortedProviderIds = [...providerIds].sort(compareBytes);
  const fallbackPages = [
    sortedProviderIds.slice(0, 2),
    sortedProviderIds.slice(2)
  ].map((ids, index, pages) => ({
    headId: hex(providerHeadId),
    startAfter: index === 0 ? null : hex(pages[index - 1].at(-1)!),
    ids: ids.map(hex),
    nextStartAfter: index === pages.length - 1 ? null : hex(ids.at(-1)!),
    done: index === pages.length - 1
  }));

  const wireRequesterPeerId = utf8('12D3KooWProtocolV1Requester');
  const wireProviderPeerId = utf8('12D3KooWProtocolV1Provider');
  const wireIssuedAtMs = 1_750_000_010_000n;
  const wireContext = [wireIssuedAtMs, wireRequesterPeerId, wireProviderPeerId, namespace, null, null, null] as const;
  const wireRequestId = (index: number) => byteRange(0x40 + index, 16);
  const wireRequest = (messageType: number, requestId: Uint8Array, body: readonly any[]) =>
    encodeWireFrame({ protocolVersion: 1n, messageType: BigInt(messageType), requestId, body: [wireContext, body] });
  const wireResponse = (messageType: number, requestId: Uint8Array, body: readonly any[]) =>
    encodeWireFrame({ protocolVersion: 1n, messageType: BigInt(messageType), requestId, body });
  const rawWireFrame = (version: bigint, messageType: bigint, requestId: Uint8Array, body: readonly any[]) => {
    const cbor = encodeCanonical([version, messageType, requestId, body]);
    return concat(encodeUnsignedVarint(cbor.length), cbor);
  };
  const capabilities = [[1n], [1n], 1_048_576n, 4_096n, 4_096n, 1_048_576n, 1_073_741_824n, 16n] as const;
  const wireMethods = [
    ['control', 'GET_CAPABILITIES', 0, 1, [], capabilities],
    ['control', 'GET_HEAD', 2, 3, [firstObject.writerId, 3n], [...checkpointUnsigned, checkpointSignature]],
    ['control', 'GET_VECTOR', 4, 5, [collection], [...vectorUnsigned, [signatureEntryBytes(vectorSignature)]]],
    ['control', 'GET_CHECKPOINT', 6, 7, [checkpointId], [...checkpointUnsigned, checkpointSignature]],
    ['control', 'ANNOUNCE_HEAD', 8, 9, [checkpointId], []],
    ['control', 'CANCEL', 10, 9, [wireRequestId(31)], []],
    ['reconcile', 'GET_RECONCILIATION_SYMBOLS', 0, 1,
      [providerHeadId, reconciliationSeed, 0n, 2n],
      [providerHeadId, reconciliationSeed, 0n, providerSymbols.slice(0, 2).map((symbol) => [BigInt(symbol.index), symbol.count, symbol.idXor, symbol.checksumXor])]],
    ['reconcile', 'GET_OBJECT_IDS', 2, 3,
      [providerHeadId, null, 2n],
      [providerHeadId, null, sortedProviderIds.slice(0, 2), sortedProviderIds[1], false]],
    ['reconcile', 'CANCEL', 10, 9, [wireRequestId(32)], []],
    ['object', 'GET_OBJECT_RANGE', 0, 1,
      [firstObject.id, 0n, BigInt(cutA)],
      [firstObject.id, BigInt(objectLength), 0n, firstObject.canonicalBytes.slice(0, cutA)]],
    ['object', 'CANCEL', 10, 9, [wireRequestId(33)], []],
  ] as const;
  const wireMethodFrames = wireMethods.map(([family, name, requestType, responseType, requestBody, responseBody], index) => {
    const id = wireRequestId(index);
    return {
      family,
      name,
      requestType,
      responseType,
      requestId: hex(id),
      requestBodyCbor: hex(encodeCanonical(requestBody)),
      responseBodyCbor: hex(encodeCanonical(responseBody)),
      requestFrame: hex(wireRequest(requestType, id, requestBody)),
      responseFrame: hex(wireResponse(responseType, id, responseBody)),
      invalidRequestFrame: hex(rawWireFrame(1n, BigInt(requestType), id, [wireContext, [...requestBody, null]])),
    };
  });
  const wireErrors = Object.entries(ENUMS.errorCode).map(([name, code], index) => {
    const id = wireRequestId(40 + index);
    const body = [BigInt(code), code === ENUMS.errorCode.RESOURCE_LIMIT ? 250n : null, code === ENUMS.errorCode.NON_CANONICAL ? 0n : null] as const;
    return {
      name,
      code,
      requestId: hex(id),
      bodyCbor: hex(encodeCanonical(body)),
      frame: hex(wireResponse(255, id, body)),
      invalidFrame: hex(rawWireFrame(1n, 255n, id, [...body, null])),
    };
  });
  const wireBoundaries = [
    { name: 'one-byte-length-prefix', requestId: wireRequestId(60), paddingBytes: 0 },
    { name: 'two-byte-length-prefix', requestId: wireRequestId(61), paddingBytes: 128 },
    { name: 'three-byte-length-prefix', requestId: wireRequestId(62), paddingBytes: 16_384 },
  ].map(({ name, requestId, paddingBytes }) => {
    const frame = wireResponse(9, requestId, [new Uint8Array(paddingBytes)]);
    const prefix = decodeUnsignedVarint(frame);
    return { name, requestId: hex(requestId), cborLength: prefix.value, prefixLength: prefix.byteLength, frame: hex(frame) };
  });
  const canonicalRequest = wireRequest(0, wireRequestId(70), []);
  const canonicalPrefix = decodeUnsignedVarint(canonicalRequest);
  const canonicalPrefixBytes = canonicalRequest.slice(0, canonicalPrefix.byteLength);
  canonicalPrefixBytes[canonicalPrefixBytes.length - 1] |= 0x80;
  const nonShortestPrefix = concat(canonicalPrefixBytes, Uint8Array.of(0));
  const invalidNonCanonicalCbor = Uint8Array.of(0x84, 0x18, 0x01, 0, 0x50, ...wireRequestId(71), 0x80);
  const invalidWireFrames = [
    { name: 'non-shortest-varint', expected: 'NON_CANONICAL', frame: hex(concat(nonShortestPrefix, canonicalRequest.subarray(canonicalPrefix.byteLength))) },
    { name: 'truncated-frame', expected: 'NON_CANONICAL', frame: hex(canonicalRequest.slice(0, -1)) },
    { name: 'trailing-byte', expected: 'NON_CANONICAL', frame: hex(concat(canonicalRequest, Uint8Array.of(0))) },
    { name: 'declared-over-hard-cap', expected: 'RESOURCE_LIMIT', frame: hex(encodeUnsignedVarint(LIMITS.controlFrameBytes + 1)) },
    { name: 'non-canonical-cbor', expected: 'NON_CANONICAL', frame: hex(concat(encodeUnsignedVarint(invalidNonCanonicalCbor.length), invalidNonCanonicalCbor)) },
    { name: 'unsupported-version', expected: 'UNSUPPORTED_VERSION', frame: hex(rawWireFrame(2n, 0n, wireRequestId(72), [wireContext, []])) },
  ];

  const vectors = {
    schema: 'dkg-wal-protocol-v1-conformance-v1',
    protocolVersion: 1,
    soleSynchronizationAtom: 'WalObjectV1',
    reconciledSetElement: 'WalObjectId',
    forbiddenIndependentIdentities: SCHEMA.atom.forbiddenIndependentIdentities,
    fixturePrivateKey: FIXTURE_PRIVATE_KEY,
    wire: {
      framing: 'unsigned-varint(length(canonical-cbor(FrameV1))) || canonical-cbor(FrameV1)',
      protocolIds: SCHEMA.protocolIds,
      messageTypes: SCHEMA.messageTypes,
      methods: wireMethodFrames,
      errors: wireErrors,
      boundaries: wireBoundaries,
      invalid: invalidWireFrames,
    },
    collection: {
      keyCbor: hex(encodeCanonical(collectionKey)),
      collectionId: hex(collection)
    },
    namespace: {
      keyCbor: hex(encodeCanonical(viewKey)),
      namespaceId: hex(namespace)
    },
    rdfAdapter: {
      canonicalization: {
        input: rdfCanonicalInput,
        canonical: new TextDecoder().decode(rdfCanonical),
        canonicalBytes: hex(rdfCanonical),
        stateDigest: hex(rdfResultDigest)
      },
      logicalKey: {
        contextGraphId: rdfLogicalCoordinates.contextGraphId,
        subGraphName: rdfLogicalCoordinates.subGraphName,
        authorAddress: hex(rdfLogicalCoordinates.authorAddress),
        knowledgeAssetUalOrRootEntity: rdfLogicalCoordinates.entity,
        digest: hex(rdfLogicalKey)
      },
      touchedKeys: [
        { graphIri: 'urn:g', subjectIri: 'urn:s:a', predicateIri: 'urn:p:link' },
        { graphIri: 'urn:g', subjectIri: 'urn:s:z', predicateIri: 'urn:p:name' }
      ].map((value) => ({ ...value, digest: hex(independentRdfTouchedKey(value.graphIri, value.subjectIri, value.predicateIri)) })),
      policy: {
        adapterVersion: '1',
        allowedGraphPrefixes: ['urn:g'],
        maxQuadsPerMutation: '100',
        maxWalObjectBytes: '1000000',
        singleValuedPredicates: ['urn:p:name'],
        multiValuedPredicates: ['urn:p:link'],
        allowedPayloadKinds: [ENUMS.payloadKind.DKG_MUTATION, ENUMS.payloadKind.RDF_POLICY],
        canonicalBytes: hex(encodeCanonical(rdfPolicy))
      },
      publishReplace: {
        operation: 'PUT',
        graphIri: 'urn:g',
        policyObjectId: hex(rdfPolicyObjectId),
        resultStateDigest: hex(rdfResultDigest),
        touchedKeys: rdfTouchedKeys.map(hex),
        rdfMutationBytes: hex(encodeCanonical(rdfReplaceMutation)),
        dkgMutationBytes: hex(encodeCanonical(rdfDkgMutation))
      },
      expiryDelete: {
        expiresAtMs: expiryDeleteBasis[0].toString(),
        curatorVectorId: hex(vectorId),
        finalizedChainFrontier: null,
        deleteBasisBytes: hex(encodeCanonical(expiryDeleteBasis)),
        dkgMutationBytes: hex(encodeCanonical(expiryDeleteMutation)),
        invalid: ['both-vector-and-chain', 'neither-vector-nor-chain', 'local-wall-time-only']
      }
    },
    walObjects: {
      first: {
        unsignedTupleCbor: hex(encodeCanonical(unsigned)),
        signatureDigest: hex(signatureMessage(DOMAINS.walObjectSignature, unsigned)),
        signature: hex(firstObject.signature),
        canonicalBytes: hex(firstObject.canonicalBytes),
        walObjectId: hex(firstObject.id),
        writerId: hex(firstObject.writerId),
        payloadBytes: hex(firstObject.payloadBytes)
      },
      second: {
        canonicalBytes: hex(secondObject.canonicalBytes),
        walObjectId: hex(secondObject.id),
        previousObjectId: hex(firstObject.id)
      },
      onePayloadByteChanged: {
        canonicalBytes: hex(changedObject.canonicalBytes),
        walObjectId: hex(changedObject.id),
        differsFromFirst: !equalBytes(firstObject.id, changedObject.id)
      }
    },
    invalidWalObjects: [
      { name: 'missing-field', bytes: hex(missingField), error: 'ARITY' },
      { name: 'extra-field', bytes: hex(extraField), error: 'ARITY' },
      { name: 'non-shortest-version', bytes: hex(nonShortestVersion), error: 'NON_CANONICAL' },
      { name: 'indefinite-array', bytes: hex(indefiniteTuple), error: 'NON_CANONICAL' },
      { name: 'map-instead-of-tuple', bytes: 'a0', error: 'TYPE' },
      { name: 'reordered-fields', bytes: hex(reorderedTuple), error: 'FIELD_TYPE' },
      { name: 'changed-payload-original-signature', bytes: hex(changedUnsignedOriginalSignature), error: 'SIGNATURE' }
    ],
    signedControl: {
      authoritySet: {
        unsignedTupleCbor: hex(encodeCanonical(authorityUnsigned)),
        signature: hex(authoritySignature),
        canonicalBytes: hex(authorityBytes),
        authoritySetId: hex(authoritySetId)
      },
      authorCheckpoint: {
        unsignedTupleCbor: hex(encodeCanonical(checkpointUnsigned)),
        signature: hex(checkpointSignature),
        canonicalBytes: hex(checkpointBytes),
        checkpointId: hex(checkpointId),
        objectSetRoot: hex(objectSetRoot)
      },
      membershipCheckpoint: {
        unsignedTupleCbor: hex(encodeCanonical(membershipUnsigned)),
        signature: hex(membershipSignature),
        canonicalBytes: hex(membershipBytes),
        membershipCheckpointId: hex(membershipId)
      },
      collectionHeadVector: {
        unsignedTupleCbor: hex(encodeCanonical(vectorUnsigned)),
        signature: hex(vectorSignature),
        canonicalBytes: hex(vectorBytes),
        vectorId: hex(vectorId),
        validEvaluationTimeMs: '1750000030000',
        expiredEvaluationTimeMs: '1750000070000'
      },
      invalid: {
        vectorEpochDowngrade: {
          canonicalBytes: hex(downgradedVectorBytes),
          previousAcceptedVectorId: hex(vectorId),
          previousAcceptedEpoch: '1',
          attemptedEpoch: '0'
        }
      }
    },
    ranges: {
      requestShape: ['walObjectId', 'offset', 'maximumLength'],
      responseShape: ['walObjectId', 'totalObjectLength', 'offset', 'bytes'],
      valid: {
        first: range(0, cutA),
        middle: range(cutA, cutB),
        final: range(cutB, objectLength),
        eof: range(objectLength, objectLength),
        outOfOrderAssembly: ['final', 'first', 'middle'],
        duplicateAssembly: ['first', 'middle', 'middle', 'final'],
        overlappingAssembly: ['first', 'middle', 'final'],
        crossProviderAssembly: [
          { provider: 'peer-a', range: 'first' },
          { provider: 'peer-b', range: 'final' },
          { provider: 'peer-c', range: 'middle' }
        ],
        interruptedResume: { beforeRestart: ['first'], afterRestart: ['middle', 'final'] }
      },
      invalid: [
        { name: 'zero-before-eof', total: objectLength.toString(), offset: '0', length: 0 },
        { name: 'dishonest-total-length', total: String(objectLength + 1), offset: '0', length: cutA },
        { name: 'offset-out-of-bounds', total: objectLength.toString(), offset: String(objectLength + 1), length: 0 },
        { name: 'range-overflow', total: '18446744073709551615', offset: '18446744073709551615', length: 1 },
        { name: 'range-too-large', total: String(LIMITS.walObjectRangeBytes + 1), offset: '0', length: LIMITS.walObjectRangeBytes + 1 },
        { name: 'overlap-byte-mismatch', total: objectLength.toString(), offset: '0', length: cutA }
      ]
    },
    setCommitments: {
      empty: { ids: [], root: hex(emptyRoot) },
      one: { ids: [hex(commitmentIds[0])], root: hex(oneRoot) },
      split257: { ids: commitmentIds.map(hex), root: hex(splitRoot) },
      oddNibbleProof: proofJson(membershipProof),
      invalidProofs: ['duplicate-leaf-id', 'unsorted-leaf-id', 'unused-low-nibble-nonzero', 'missing-sibling', 'extra-sibling', 'bitmap-mismatch', 'wrong-child-count', 'wrong-root']
    },
    iblt: {
      algorithm: IBLT_ALGORITHM,
      requesterHeadId: hex(requesterHeadId),
      providerHeadId: hex(providerHeadId),
      requesterNonce: hex(requesterNonce),
      reconciliationSeed: hex(reconciliationSeed),
      receiverIds: receiverIds.map(hex),
      providerIds: providerIds.map(hex),
      receiverRoot: hex(setCommitmentRoot(receiverIds)),
      providerRoot: hex(setCommitmentRoot(providerIds)),
      binary64MappingBoundaryCases: mappingBoundaryInputs.map(({ name, state, index }) => ({
        name,
        state: state.toString(),
        index,
        nextIndex: mappingIndexForState(state, index)
      })),
      firstMappingIndices: providerIds.map((id) => ({ id: hex(id), indices: mappingIndices(reconciliationSeed, id, symbolCount - 1) })),
      minimumCompleteSymbolCount: symbolCount,
      providerSymbols: providerSymbols.map(symbolJson),
      expectedProviderOnly: decode.providerOnly.map(hex),
      expectedReceiverOnly: decode.receiverOnly.map(hex),
      peelTrace: decode.peelTrace,
      invalid: ['non-contiguous-window', 'signed-count-overflow', 'checksum-mismatch', 'residual-core', 'duplicate-decoded-id', 'root-mismatch', 'count-mismatch', 'symbol-budget', 'peeling-budget'],
      fallbackPages
    },
    encryption: {
      algorithm: 'AES-256-GCM',
      namespaceId: hex(encryptionFields.namespaceId),
      writerId: hex(encryptionFields.writerId),
      writerEpoch: encryptionFields.writerEpoch.toString(),
      sequence: encryptionFields.sequence.toString(),
      keyEpoch: encryptionFields.keyEpoch.toString(),
      payloadKind: encryptionFields.payloadKind,
      codec: encryptionFields.codec,
      mediaType: encryptionFields.mediaType,
      epochKey: hex(encryptionEpochKey),
      objectKey: hex(encryptionObjectKey),
      nonce: hex(encryptionNonce),
      associatedDataDigest: hex(associatedDataDigest),
      plaintext: hex(plaintext),
      ciphertextAndTag: hex(ciphertext),
      envelopeBytes: hex(encryptedEnvelope),
      invalid: ['wrong-key-epoch', 'wrong-nonce', 'wrong-associated-data', 'truncated-tag', 'modified-ciphertext']
    },
    snapshot: {
      manifestBytes: hex(snapshotBytes),
      custodyReceiptBytes: hex(custodyReceiptBytes),
      envelopePayloadKind: ENUMS.payloadKind.SNAPSHOT_MANIFEST,
      envelopeCodec: ENUMS.codec.DETERMINISTIC_CBOR,
      mediaType: 'application/vnd.origintrail.wal-snapshot-manifest+cbor',
      entryStates: { LIVE: ENUMS.snapshotEntryState.LIVE, TOMBSTONE: ENUMS.snapshotEntryState.TOMBSTONE },
      baselineRule: 'A SNAPSHOT starts the new writer epoch at sequence zero with previousObjectId null; the signed manifest and covered checkpoint close the compacted lane.',
      externalConflictRule: 'External conflict heads must remain available through their own current checkpoint or baseline and are never re-authored by the snapshot author.'
    },
    moveTier: {
      transitionCommitment: hex(transitionCommitment),
      targetMutationDigest: hex(targetMutationDigest),
      publicTargetPayload: hex(publicMoveTier),
      privateSourcePayload: hex(privateMoveTier),
      tierTransitionReceipt: hex(tierReceiptBytes),
      forbiddenPublicValues: [
        sourceNamespaceId, transitionNonce, firstObject.id, sourceState, sourceResult, sourceCausalOpening
      ].map(hex),
      forbiddenPublicText: [sourceGraphName],
      forbiddenPublicScalarCbor: [sourceKeyEpoch, sourceActivityCount].map((value) => hex(encodeCanonical(value)))
    },
    replayConflict: replayConflictVectors,
    finality: [
      { authorRequested: 0, networkMinimum: 64, effective: authorFinalityRequirement(0, 64) },
      { authorRequested: 128, networkMinimum: 64, effective: authorFinalityRequirement(128, 64) },
      { authorRequested: 64, networkMinimum: 128, effective: authorFinalityRequirement(64, 128) }
    ],
    cutover: {
      unsignedTupleCbor: hex(encodeCanonical(cutoverUnsigned)),
      signature: hex(cutoverAuthoritySignature),
      canonicalBytes: hex(cutoverBytes),
      cutoverId: hex(cutoverId),
      authoritySetId: hex(authoritySetId),
      legacySyncDisabled: true,
      invalidLegacySyncEnabledBytes: hex(unsafeCutoverBytes),
      invalid: ['missing-cohort-manifest', 'unknown-required-node', 'stale-vector-manifest', 'authority-downgrade', 'legacy-sync-enabled', 'cutover-id-mismatch']
    },
    authorityLifecycle: {
      vectorEpochTransition: 'A changed curator AuthoritySetId increments vectorEpoch, resets vectorNumber to zero, and links previousVectorId.',
      rollbackGuardLoss: 'Fail closed until a current-threshold RollbackRecoveryV1 at or above the fleet high-water is durably installed.',
      staleAndDowngradeCases: ['expired-authority-set', 'revoked-signer', 'insufficient-threshold', 'old-authority-after-transition', 'vector-number-rollback', 'vector-epoch-downgrade'],
      expiredAuthorityEvaluationTimeMs: '1800000000001',
      authorityExpiresAtMs: '1800000000000',
      vectorEpochDowngradeBytes: hex(downgradedVectorBytes)
    }
  };

  return {
    schemaText: `${JSON.stringify(SCHEMA, null, 2)}\n`,
    vectorsText: `${JSON.stringify(vectors, null, 2)}\n`
  };
}

const { schemaText, vectorsText } = await buildVectors();
const check = process.argv.includes('--check');
if (check) {
  const [existingSchema, existingVectors, normativeSchema, normativeVectors] = await Promise.all([
    readFile(schemaPath, 'utf8'),
    readFile(vectorsPath, 'utf8'),
    readFile(normativeSchemaPath, 'utf8'),
    readFile(normativeVectorsPath, 'utf8')
  ]);
  if (
    existingSchema !== schemaText
    || existingVectors !== vectorsText
    || normativeSchema !== schemaText
    || normativeVectors !== vectorsText
  ) {
    throw new Error('checked-in WAL protocol v1 schema or vectors are stale');
  }
} else {
  await Promise.all([
    writeFile(schemaPath, schemaText),
    writeFile(vectorsPath, vectorsText),
    writeFile(normativeSchemaPath, schemaText),
    writeFile(normativeVectorsPath, vectorsText)
  ]);
}
