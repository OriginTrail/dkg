export const PROTOCOL_VERSION = 1;

export const DOMAINS = Object.freeze({
  namespaceId: 'dkg-wal-namespace-v1\0',
  collectionId: 'dkg-wal-collection-v1\0',
  walObjectSignature: 'dkg-wal-object-sign-v1\0',
  walObjectId: 'dkg-wal-object-v1\0',
  checkpointSignature: 'dkg-wal-checkpoint-sign-v1\0',
  checkpointId: 'dkg-wal-checkpoint-v1\0',
  membershipSignature: 'dkg-wal-membership-sign-v1\0',
  membershipId: 'dkg-wal-membership-v1\0',
  vectorSignature: 'dkg-wal-vector-sign-v1\0',
  vectorId: 'dkg-wal-vector-v1\0',
  cutoverSignature: 'dkg-wal-cutover-sign-v1\0',
  cutoverId: 'dkg-wal-cutover-v1\0',
  authoritySignature: 'dkg-wal-authority-sign-v1\0',
  authorityId: 'dkg-wal-authority-v1\0',
  receiptSignature: 'dkg-wal-receipt-sign-v1\0',
  receiptId: 'dkg-wal-receipt-v1\0',
  bootstrapSignature: 'dkg-wal-bootstrap-sign-v1\0',
  bootstrapId: 'dkg-wal-bootstrap-v1\0',
  rollbackRecoverySignature: 'dkg-wal-rollback-recovery-sign-v1\0',
  rollbackRecoveryId: 'dkg-wal-rollback-recovery-v1\0',
  logicalKey: 'dkg-rdf-logical-key-v1\0',
  touchedKey: 'dkg-rdf-touched-key-v1\0',
  rdfState: 'dkg-rdf-state-v1\0',
  replayHeads: 'dkg-rdf-head-set-v1\0',
  replayConflict: 'dkg-rdf-conflict-v1\0',
  payloadAssociatedData: 'dkg-wal-payload-ad-v1\0',
  moveTierCommitment: 'dkg-wal-move-tier-v1\0',
  moveTierTargetMutation: 'dkg-wal-move-tier-target-mutation-v1\0',
  setEmpty: 'dkg-wal-set-empty-v1\0',
  setLeaf: 'dkg-wal-set-leaf-v1\0',
  setBranch: 'dkg-wal-set-branch-v1\0',
  ibltSeed: 'dkg-wal-iblt-seed-v1\0',
  ibltMap: 'dkg-wal-iblt-map-v1\0',
  ibltChecksum: 'dkg-wal-iblt-check-v1\0'
});

export const ENUMS = Object.freeze({
  tier: { SWM: 0, VM: 1 },
  visibility: { PUBLIC: 0, PRIVATE: 1 },
  publishMode: { OPEN: 0, CURATED: 1 },
  payloadKind: {
    DKG_MUTATION: 0,
    RDF_POLICY: 1,
    SNAPSHOT_MANIFEST: 2,
    LEGACY_GENESIS: 3,
    COLLECTION_VECTOR_MANIFEST: 4,
    CUTOVER_COHORT_MANIFEST: 5,
    MOVE_TIER_SOURCE: 6,
    MOVE_TIER_TARGET: 7
  },
  codec: { DETERMINISTIC_CBOR: 0, CANONICAL_NQUADS: 1, OPAQUE_BYTES: 2 },
  encryptionAlgorithm: { AES_256_GCM: 0 },
  mutationOperation: {
    PUT: 0,
    PATCH: 1,
    DELETE: 2,
    RESOLVE: 3,
    SNAPSHOT: 4,
    MOVE_TIER_SOURCE: 5,
    MOVE_TIER_TARGET: 6,
    LEGACY_GENESIS: 7
  },
  mutationMode: { REPLACE: 0, PATCH: 1 },
  snapshotEntryState: { LIVE: 0, TOMBSTONE: 1 },
  chainEventType: { PUBLISH: 0, UPDATE: 1 },
  authorityScope: { CURATOR: 0, NETWORK: 1 },
  errorCode: {
    UNSUPPORTED_VERSION: 0,
    UNAUTHORIZED: 1,
    STALE_HEAD: 2,
    INVALID_RANGE: 3,
    RESOURCE_LIMIT: 4,
    CANCELLED: 5,
    INTERNAL_UNAVAILABLE: 6,
    NON_CANONICAL: 7,
    INVALID_PROOF: 8
  }
});

export const LIMITS = Object.freeze({
  controlFrameBytes: 1_048_576,
  reconciliationSymbolsPerResponse: 4_096,
  reconciliationSymbolsPerAttempt: 4_194_304,
  reconciliationDecodedIds: 1_000_000,
  reconciliationPeelingOperations: 67_108_864,
  fallbackIdsPerPage: 4_096,
  fallbackPagesPerAttempt: 1_048_576,
  walObjectRangeBytes: 1_048_576,
  concurrentStagedRangesPerPeer: 16,
  stagedRangePartsPerObject: 65_536,
  concurrentReconciliationsPerPeer: 4,
  concurrentObjectStreamsPerNamespacePeer: 2,
  outstandingRequestsPerPeer: 128,
  outstandingRequestsGlobal: 1_024,
  replayEntriesPerPeer: 16_384,
  replayEntriesGlobal: 131_072,
  queuedRequestsPerSchedulerKey: 16,
  inboundReadTimeoutMs: 20_000,
  requestHandlerTimeoutMs: 20_000,
  decodedCborArrayEntries: 65_536,
  decodedCborNestingDepth: 16,
  walObjectPolicyDefaultBytes: 1_073_741_824,
  walObjectHardBytes: 8_589_934_592,
  temporaryStagingBytesPerPeer: 17_179_869_184,
  parentsPerMutation: 64,
  baseHeadsPerMutation: 64,
  touchedKeysPerMutation: 4_096,
  replaceGraphsPerMutation: 64,
  replaceSubjectsPerMutation: 4_096,
  quadsPerMutation: 1_000_000,
  conflictHeadsPerLogicalKey: 32,
  authorsPerVector: 65_536,
  activeViewsPerNode: 4_096,
  causalClosureDepth: 1_000_000,
  snapshotEntries: 1_000_000,
  snapshotConflictEntries: 100_000,
  quarantinedBytesPerPeer: 268_435_456,
  quarantineRetentionMs: 86_400_000,
  requestFreshnessMs: 90_000,
  vectorValidityMs: 60_000,
  acceptedClockSkewMs: 5_000,
  peerIdBytes: 128,
  networkIdUtf8Bytes: 128,
  contextGraphIdUtf8Bytes: 512,
  subgraphNameUtf8Bytes: 128,
  mediaTypeUtf8Bytes: 128
});

export interface TupleSchema {
  readonly fields: readonly string[];
  readonly fieldTypes: readonly string[];
  readonly signed?: boolean;
  readonly identityDomain?: keyof typeof DOMAINS;
  readonly signatureDomain?: keyof typeof DOMAINS;
  readonly enumFields?: Readonly<Record<number, keyof typeof ENUMS>>;
  readonly notes?: readonly string[];
}

function tuple(
  fields: readonly string[],
  fieldTypes: readonly string[],
  options: Omit<TupleSchema, 'fields' | 'fieldTypes'> = {}
): TupleSchema {
  if (fields.length !== fieldTypes.length) throw new Error('schema arity mismatch');
  return Object.freeze({ fields, fieldTypes, ...options });
}

export const TUPLES = Object.freeze({
  ReplicationCollectionKeyV1: tuple(
    ['networkId', 'contextGraphId', 'subGraphNameOrNull', 'visibility'],
    ['nfc-tstr', 'nfc-tstr', 'nfc-tstr|null', 'u8-enum']
  ),
  ReplicationViewKeyV1: tuple(
    ['networkId', 'contextGraphId', 'subGraphNameOrNull', 'tier', 'visibility', 'policyEpoch', 'keyEpochOrNull'],
    ['nfc-tstr', 'nfc-tstr', 'nfc-tstr|null', 'u8-enum', 'u8-enum', 'u64', 'u64|null']
  ),
  WalObjectV1: tuple(
    ['version', 'namespaceId', 'writerId', 'writerEpoch', 'sequence', 'previousObjectIdOrNull', 'payloadBytes', 'signature'],
    ['literal-1', 'bytes32', 'address20', 'u64', 'u64', 'bytes32|null', 'bstr', 'signature65'],
    {
      signed: true,
      identityDomain: 'walObjectId',
      signatureDomain: 'walObjectSignature',
      notes: [
        'The first seven fields form the signed tuple.',
        'This complete eight-field value is the sole durable content-addressed synchronization atom.',
        'payloadBytes is inline and opaque; it has no generic payload or blob identity.'
      ]
    }
  ),
  DkgPayloadEnvelopeV1: tuple(
    ['version', 'payloadKind', 'codec', 'mediaType', 'encryptionOrNull', 'contentBytes'],
    ['literal-1', 'u16-enum', 'u16-enum', 'nfc-tstr', 'EncryptionDescriptorV1|null', 'bstr']
  ),
  EncryptionDescriptorV1: tuple(
    ['algorithm', 'keyEpoch', 'nonce', 'associatedDataDigest'],
    ['u16-enum', 'u64', 'bytes12', 'bytes32']
  ),
  DkgMutationV1: tuple(
    ['version', 'operation', 'logicalKey', 'parents', 'baseHeads', 'policyObjectId', 'rdfMutationOrNull', 'chainBindingOrNull', 'deleteBasisOrNull', 'nonConsensusTimestampMsOrNull'],
    ['literal-1', 'u16-enum', 'bytes32', 'sorted-unique<bytes32>', 'sorted-unique<bytes32>', 'bytes32', 'RdfMutationV1|null', 'ChainBindingV1|null', 'DeleteBasisV1|null', 'u64|null']
  ),
  DeleteBasisV1: tuple(
    ['expiresAtMs', 'curatorVectorIdOrNull', 'finalizedChainFrontierOrNull'],
    ['u64', 'bytes32|null', 'ChainFrontierV1|null']
  ),
  RdfMutationV1: tuple(
    ['version', 'mode', 'baseStateDigest', 'resultStateDigest', 'replaceGraphs', 'replaceSubjects', 'deleteNQuadsBytes', 'insertNQuadsBytes', 'touchedKeys', 'sourceSemanticAuditBytesOrNull'],
    ['literal-1', 'u8-enum', 'bytes32', 'bytes32', 'sorted-unique<GraphReplacementV1>', 'sorted-unique<SubjectReplacementV1>', 'bstr', 'bstr', 'sorted-unique<bytes32>', 'bstr|null']
  ),
  GraphReplacementV1: tuple(
    ['graphIri', 'canonicalNQuadsBytes', 'quadCount'],
    ['nfc-tstr', 'bstr', 'u64']
  ),
  SubjectReplacementV1: tuple(
    ['graphIri', 'subjectIri', 'canonicalNQuadsBytes', 'quadCount'],
    ['nfc-tstr', 'nfc-tstr', 'bstr', 'u64']
  ),
  RdfPolicyV1: tuple(
    ['version', 'adapterVersion', 'allowedGraphPrefixes', 'maxQuadsPerMutation', 'maxWalObjectBytes', 'singleValuedPredicates', 'multiValuedPredicates', 'sharedWriteLogicalKeys', 'resolverAddresses', 'expiryAuthorityAddresses', 'allowedPayloadKinds'],
    ['literal-1', 'u16', 'sorted-unique<nfc-tstr>', 'u64', 'u64', 'sorted-unique<nfc-tstr>', 'sorted-unique<nfc-tstr>', 'sorted-unique<bytes32>', 'sorted-unique<address20>', 'sorted-unique<address20>', 'sorted-unique<u16>']
  ),
  ChainBindingV1: tuple(
    ['chainId', 'knowledgeAssetsContract', 'contextGraphOnChainId', 'kaId', 'authorAddress', 'assertionVersion', 'merkleRoot', 'transactionHash', 'blockNumber', 'blockHash', 'transactionIndex', 'logIndex', 'eventType', 'requiredFinalityBlocks'],
    ['u64', 'address20', 'bytes32', 'bytes32', 'address20', 'u64', 'bytes32', 'bytes32', 'u64', 'bytes32', 'u64', 'u64', 'u16-enum', 'u32'],
    { enumFields: { 12: 'chainEventType' } }
  ),
  AuthorCheckpointV1: tuple(
    ['version', 'namespaceId', 'writerId', 'writerEpoch', 'checkpointNumber', 'setCommitmentVersion', 'objectSetRoot', 'objectCount', 'maxSequence', 'previousCheckpointIdOrNull', 'baselineSnapshotObjectIdOrNull', 'compactionFloor', 'signature'],
    ['literal-1', 'bytes32', 'address20', 'u64', 'u64', 'literal-1', 'bytes32', 'u64', 'u64', 'bytes32|null', 'bytes32|null', 'u64', 'signature65'],
    { signed: true, identityDomain: 'checkpointId', signatureDomain: 'checkpointSignature' }
  ),
  SignatureEntryV1: tuple(['signerAddress', 'signature'], ['address20', 'signature65']),
  AuthoritySetV1: tuple(
    ['version', 'scope', 'networkId', 'authorityEpoch', 'threshold', 'signerAddresses', 'notBeforeMs', 'expiresAtMs', 'previousAuthoritySetIdOrNull', 'emergencyRevocationIds', 'signatures'],
    ['literal-1', 'u8-enum', 'nfc-tstr', 'u64', 'u16', 'sorted-unique<address20>', 'u64', 'u64', 'bytes32|null', 'sorted-unique<bytes32>', 'sorted-unique<SignatureEntryV1>'],
    { signed: true, identityDomain: 'authorityId', signatureDomain: 'authoritySignature' }
  ),
  MembershipCheckpointV1: tuple(
    ['version', 'collectionId', 'checkpointNumber', 'policyEpoch', 'publishMode', 'writerIds', 'memberAgentAddresses', 'allowedPeerIds', 'activeNamespaceIds', 'rdfPolicyObjectId', 'previousMembershipCheckpointIdOrNull', 'issuedAtMs', 'authoritySetId', 'signatures'],
    ['literal-1', 'bytes32', 'u64', 'u64', 'u8-enum', 'sorted-unique<address20>', 'sorted-unique<address20>', 'sorted-unique<bstr>', 'sorted-unique<bytes32>', 'bytes32', 'bytes32|null', 'u64', 'bytes32', 'sorted-unique<SignatureEntryV1>'],
    { signed: true, identityDomain: 'membershipId', signatureDomain: 'membershipSignature' }
  ),
  ExpectedNamespaceV1: tuple(
    ['namespaceId', 'writerCheckpoints'],
    ['bytes32', 'sorted-unique<WriterCheckpointV1>']
  ),
  WriterCheckpointV1: tuple(['writerId', 'checkpointId'], ['address20', 'bytes32']),
  CollectionHeadVectorV1: tuple(
    ['version', 'collectionId', 'membershipCheckpointId', 'expectedNamespaces', 'vectorEpoch', 'vectorNumber', 'previousVectorIdOrNull', 'issuedAtMs', 'expiresAtMs', 'finalizedChainFrontierOrNull', 'authoritySetId', 'signatures'],
    ['literal-1', 'bytes32', 'bytes32', 'sorted-unique<ExpectedNamespaceV1>', 'u64', 'u64', 'bytes32|null', 'u64', 'u64', 'ChainFrontierV1|null', 'bytes32', 'sorted-unique<SignatureEntryV1>'],
    { signed: true, identityDomain: 'vectorId', signatureDomain: 'vectorSignature' }
  ),
  ChainFrontierV1: tuple(['chainId', 'blockNumber', 'blockHash'], ['u64', 'u64', 'bytes32']),
  NetworkWalCutoverV1: tuple(
    ['version', 'networkId', 'walProtocolVersion', 'rdfAdapterVersion', 'requiredNodeVersion', 'collectionVectorManifestObjectId', 'cohortManifestObjectId', 'cutoverEpoch', 'activation', 'legacySyncDisabled', 'authoritySetId', 'signatures'],
    ['literal-1', 'nfc-tstr', 'u16', 'u16', 'nfc-tstr', 'bytes32', 'bytes32', 'u64', 'ActivationFrontierV1', 'true', 'bytes32', 'sorted-unique<SignatureEntryV1>'],
    { signed: true, identityDomain: 'cutoverId', signatureDomain: 'cutoverSignature' }
  ),
  ActivationFrontierV1: tuple(['minimumBlockByChain', 'notBeforeMs'], ['sorted-unique<ChainFrontierV1>', 'u64']),
  RequestContextV1: tuple(
    ['issuedAtMs', 'requesterPeerId', 'targetPeerId', 'namespaceId', 'requesterAgentAddressOrNull', 'identityProofOrNull', 'privateViewProofOrNull'],
    ['u64', 'bstr', 'bstr', 'bytes32', 'address20|null', 'IdentityProofV1|null', 'PrivateViewProofV1|null']
  ),
  IdentityProofV1: tuple(
    ['agentAddress', 'peerId', 'notBeforeMs', 'expiresAtMs', 'nonce', 'signature'],
    ['address20', 'bstr', 'u64', 'u64', 'bytes16', 'signature65']
  ),
  PrivateViewProofV1: tuple(
    ['membershipCheckpointId', 'memberAgentAddress', 'transportPeerId', 'delegationOrNull'],
    ['bytes32', 'address20', 'bstr', 'PeerDelegationV1|null']
  ),
  PeerDelegationV1: tuple(
    ['collectionId', 'memberAgentAddress', 'delegatePeerId', 'notBeforeMs', 'expiresAtMs', 'nonce', 'signature'],
    ['bytes32', 'address20', 'bstr', 'u64', 'u64', 'bytes16', 'signature65']
  ),
  FrameV1: tuple(['protocolVersion', 'messageType', 'requestId', 'body'], ['literal-1', 'u16', 'bytes16', 'tuple']),
  AuthenticatedRequestV1: tuple(['context', 'request'], ['RequestContextV1', 'tuple']),
  GetCapabilitiesV1: tuple([], []),
  AckV1: tuple([], []),
  CapabilitiesV1: tuple(
    ['protocolVersions', 'adapterVersions', 'maximumControlFrameBytes', 'maximumSymbolsPerResponse', 'maximumFallbackIdsPerPage', 'maximumObjectRangeBytes', 'maximumWalObjectBytes', 'maximumConcurrentRanges'],
    ['sorted-unique<u16>', 'sorted-unique<u16>', 'u64', 'u64', 'u64', 'u64', 'u64', 'u64']
  ),
  GetHeadV1: tuple(['writerId', 'writerEpochOrNull'], ['address20', 'u64|null']),
  GetVectorV1: tuple(['collectionId'], ['bytes32']),
  GetCheckpointV1: tuple(['checkpointId'], ['bytes32']),
  AnnounceHeadV1: tuple(['checkpointId'], ['bytes32']),
  CancelV1: tuple(['cancelledRequestId'], ['bytes16']),
  GetReconciliationSymbolsV1: tuple(
    ['headId', 'reconciliationSeed', 'firstSymbolIndex', 'symbolCount'],
    ['bytes32', 'bytes32', 'u64', 'u32']
  ),
  ReconciliationSymbolsV1: tuple(
    ['headId', 'reconciliationSeed', 'firstSymbolIndex', 'symbols'],
    ['bytes32', 'bytes32', 'u64', 'array<ReconciliationSymbolV1>']
  ),
  ReconciliationSymbolV1: tuple(
    ['symbolIndex', 'count', 'idXor', 'checksumXor'],
    ['u64', 'i64', 'bytes32', 'bytes32']
  ),
  GetObjectIdsV1: tuple(['headId', 'startAfterOrNull', 'limit'], ['bytes32', 'bytes32|null', 'u32']),
  ObjectIdsPageV1: tuple(
    ['headId', 'startAfterOrNull', 'ids', 'nextStartAfterOrNull', 'done'],
    ['bytes32', 'bytes32|null', 'strictly-sorted-unique<bytes32>', 'bytes32|null', 'bool']
  ),
  GetWalObjectRangeV1: tuple(['walObjectId', 'offset', 'maximumLength'], ['bytes32', 'u64', 'u32']),
  WalObjectRangeV1: tuple(['walObjectId', 'totalObjectLength', 'offset', 'bytes'], ['bytes32', 'u64', 'u64', 'bstr']),
  ErrorV1: tuple(['code', 'retryAfterMsOrNull', 'detailCodeOrNull'], ['u16-enum', 'u64|null', 'u16|null']),
  SnapshotManifestV1: tuple(
    ['version', 'namespaceId', 'writerId', 'newWriterEpoch', 'coveredWriterEpoch', 'coveredCheckpointId', 'coveredObjectSetRoot', 'coveredObjectCount', 'compactionFloor', 'entries', 'conflicts', 'policyObjectId', 'adapterVersion', 'chainFrontierOrNull'],
    ['literal-1', 'bytes32', 'address20', 'u64', 'u64', 'bytes32', 'bytes32', 'u64', 'u64', 'sorted-unique<SnapshotEntryV1>', 'sorted-unique<SnapshotConflictV1>', 'bytes32', 'u16', 'ChainFrontierV1|null']
  ),
  SnapshotEntryV1: tuple(
    ['logicalKey', 'stateKind', 'activeHeadIds', 'stateDigest', 'canonicalGraphBytes'],
    ['bytes32', 'u8-enum', 'sorted-unique<bytes32>', 'bytes32', 'bstr'],
    { enumFields: { 1: 'snapshotEntryState' } }
  ),
  SnapshotConflictV1: tuple(
    ['logicalKey', 'externalHeadIds', 'commonBaseHeadIds', 'conflictDigest'],
    ['bytes32', 'sorted-unique<bytes32>', 'sorted-unique<bytes32>', 'bytes32']
  ),
  SnapshotCustodyReceiptV1: tuple(
    ['version', 'snapshotObjectId', 'custodianAgentAddress', 'custodianPeerId', 'membershipCheckpointId', 'notBeforeMs', 'expiresAtMs', 'nonce', 'signature'],
    ['literal-1', 'bytes32', 'address20', 'bstr', 'bytes32', 'u64', 'u64', 'bytes16', 'signature65'],
    { signed: true, identityDomain: 'receiptId', signatureDomain: 'receiptSignature' }
  ),
  LegacyGenesisV1: tuple(
    ['version', 'collectionId', 'namespaceId', 'sourceStateDigest', 'canonicalGraphBytes', 'provenanceStatus', 'migrationPolicyObjectId', 'barrierVectorId', 'createdAtMs'],
    ['literal-1', 'bytes32', 'bytes32', 'bytes32', 'bstr', 'literal-0', 'bytes32', 'bytes32', 'u64']
  ),
  SetMembershipProofV1: tuple(
    ['version', 'walObjectId', 'leafPrefixNibbleLength', 'leafIds', 'path'],
    ['literal-1', 'bytes32', 'u8', 'strictly-sorted-unique<bytes32>', 'array<SetProofLevelV1>']
  ),
  SetProofLevelV1: tuple(
    ['parentPrefixNibbleLength', 'childBitmap', 'childNibble', 'siblings'],
    ['u8', 'u16', 'u8', 'strictly-sorted-unique<SetProofSiblingV1>']
  ),
  SetProofSiblingV1: tuple(['nibble', 'childCount', 'childHash'], ['u8', 'u64', 'bytes32']),
  MoveTierSourceV1: tuple(
    ['version', 'transitionNonce', 'transitionCommitment', 'targetNamespaceId', 'targetWalObjectId', 'sourceHeads', 'sourceStateDigest', 'sourceResultDigest'],
    ['literal-1', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'sorted-unique<bytes32>', 'bytes32', 'bytes32']
  ),
  MoveTierTargetV1: tuple(
    ['version', 'transitionCommitment', 'targetMutation'],
    ['literal-1', 'bytes32', 'DkgMutationV1']
  ),
  TierTransitionReceiptV1: tuple(
    ['version', 'transitionCommitment', 'targetNamespaceId', 'targetWalObjectId', 'policyObjectId', 'curatorVectorId', 'expiresAtMs', 'authoritySetId', 'signatures'],
    ['literal-1', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'u64', 'bytes32', 'sorted-unique<SignatureEntryV1>'],
    { signed: true, identityDomain: 'receiptId', signatureDomain: 'receiptSignature' }
  ),
  ProviderEntryV1: tuple(
    ['peerId', 'agentAddress', 'endpoints', 'namespaceIds'],
    ['bstr', 'address20', 'sorted-unique<nfc-tstr>', 'sorted-unique<bytes32>']
  ),
  ProviderBootstrapManifestV1: tuple(
    ['version', 'networkId', 'collectionId', 'authorityEpoch', 'providers', 'notBeforeMs', 'expiresAtMs', 'previousManifestIdOrNull', 'authoritySetId', 'signatures'],
    ['literal-1', 'nfc-tstr', 'bytes32', 'u64', 'sorted-unique<ProviderEntryV1>', 'u64', 'u64', 'bytes32|null', 'bytes32', 'sorted-unique<SignatureEntryV1>'],
    { signed: true, identityDomain: 'bootstrapId', signatureDomain: 'bootstrapSignature' }
  ),
  PrivateBootstrapTicketV1: tuple(
    ['version', 'collectionId', 'memberAgentAddress', 'membershipCheckpointId', 'providerManifestId', 'notBeforeMs', 'expiresAtMs', 'nonce', 'ciphertext'],
    ['literal-1', 'bytes32', 'address20', 'bytes32', 'bytes32', 'u64', 'u64', 'bytes12', 'bstr']
  ),
  RollbackRecoveryV1: tuple(
    ['version', 'networkId', 'collectionId', 'minimumVectorEpoch', 'minimumVectorNumber', 'minimumVectorId', 'recoveryNonce', 'issuedAtMs', 'authoritySetId', 'signatures'],
    ['literal-1', 'nfc-tstr', 'bytes32', 'u64', 'u64', 'bytes32', 'bytes32', 'u64', 'bytes32', 'sorted-unique<SignatureEntryV1>'],
    { signed: true, identityDomain: 'rollbackRecoveryId', signatureDomain: 'rollbackRecoverySignature' }
  ),
  CutoverCohortManifestV1: tuple(
    ['version', 'networkId', 'cutoverEpoch', 'requiredNodes', 'activeAuthors', 'decommissionedPeerIds', 'minimumBootstrapVectorIds', 'createdAtMs'],
    ['literal-1', 'nfc-tstr', 'u64', 'sorted-unique<RequiredNodeV1>', 'sorted-unique<ActiveAuthorV1>', 'sorted-unique<bstr>', 'sorted-unique<bytes32>', 'u64']
  ),
  RequiredNodeV1: tuple(['peerId', 'agentAddress'], ['bstr', 'address20']),
  ActiveAuthorV1: tuple(
    ['namespaceId', 'writerId', 'writerEpoch', 'checkpointId'],
    ['bytes32', 'address20', 'u64', 'bytes32']
  )
});

export const MESSAGE_TYPES = Object.freeze({
  walControl: {
    GET_CAPABILITIES: 0,
    CAPABILITIES: 1,
    GET_HEAD: 2,
    HEAD: 3,
    GET_VECTOR: 4,
    VECTOR: 5,
    GET_CHECKPOINT: 6,
    CHECKPOINT: 7,
    ANNOUNCE_HEAD: 8,
    ACK: 9,
    CANCEL: 10,
    ERROR: 255
  },
  walReconcile: {
    GET_RECONCILIATION_SYMBOLS: 0,
    RECONCILIATION_SYMBOLS: 1,
    GET_OBJECT_IDS: 2,
    OBJECT_IDS_PAGE: 3,
    CANCEL: 10,
    ERROR: 255
  },
  walObject: {
    GET_OBJECT_RANGE: 0,
    OBJECT_RANGE: 1,
    CANCEL: 10,
    ERROR: 255
  }
});

export const PROTOCOL_IDS = Object.freeze({
  walControl: '/dkg/10.1.0/wal-control',
  walReconcile: '/dkg/10.1.0/wal-reconcile',
  walObject: '/dkg/10.1.0/wal-object'
});

export const IBLT_ALGORITHM = Object.freeze({
  name: 'ProtocolV1IbltReconciliationAlgorithm',
  version: 1,
  multiplierHex: 'da942042e4dd58b5',
  initialSymbolIndex: 0,
  arithmetic: 'IEEE-754 binary64',
  uint64Conversion: 'roundTiesToEven',
  operationRounding: 'roundTiesToEven-after-each-operation',
  squareRoot: 'correctly-rounded-roundTiesToEven',
  inverseSquareRootNumerator: '4294967296',
  indexOffset: 1.5,
  reassociation: false,
  extendedPrecisionIntermediates: false,
  mappingSeedEndian: 'little',
  countEncoding: 'signed-i64',
  peelOrder: 'lowest-symbol-index-first'
});

export const SCHEMA = Object.freeze({
  schema: 'dkg-wal-protocol-v1-schema-v1',
  protocolVersion: PROTOCOL_VERSION,
  atom: {
    tuple: 'WalObjectV1',
    id: 'WalObjectId',
    setElement: 'WalObjectId',
    forbiddenIndependentIdentities: ['PayloadId', 'BlobId', 'ChunkId', 'RangeId', 'IbltSymbolId']
  },
  canonicalCbor: {
    profile: 'RFC 8949 deterministic encoding',
    exactArityArrays: true,
    definiteLengthsOnly: true,
    shortestIntegersAndLengths: true,
    nfcText: true,
    maps: false,
    floats: false,
    tags: false,
    undefined: false
  },
  domains: DOMAINS,
  enums: ENUMS,
  limits: LIMITS,
  protocolIds: PROTOCOL_IDS,
  messageTypes: MESSAGE_TYPES,
  iblt: IBLT_ALGORITHM,
  tuples: TUPLES
});
