import type {
  AgentProfileAcceptedAuthorityStateV1,
  AgentProfileActiveHeadObjectV1,
  AgentProfileAppliedTransitionV1,
  AgentProfileAuthorityTransitionV1,
  AgentProfileClosureVerifierV1,
  AgentProfileConflictEvidenceV1,
  AgentProfileExactLinkedSubjectKindV1,
  AgentProfileForkConflictEntryV1,
  AgentProfileForkResolutionV1,
  AgentProfileHeadAdvanceEvidenceV1,
  AgentProfileHeadCommonV1,
  AgentProfileHeadObjectV1,
  AgentProfileIdentityFactV1,
  AgentProfileIdentityFactsInputV1,
  AgentProfileIdentityFactsV1,
  AgentProfileIndexedSubjectKindV1,
  AgentProfileLinkedSubjectKindV1,
  AgentProfileOwnedSubjectKindV1,
  AgentProfileProjectionQuadV1,
  AgentProfileTombstoneHeadObjectV1,
  AgentProfileTransitionConflictEntryV1,
  AgentProfileVerifiedAuthoritySummaryV1,
  CanonicalRfc3339SecondsV1,
  Digest32V1,
  NetworkIdV1,
  OwnedSubjectTableObjectV1,
  SignedAgentProfileAuthorityTransitionEnvelopeV1,
  SignedAgentProfileForkResolutionEnvelopeV1,
  SignedAgentProfileHeadEnvelopeV1,
  SignedSystemRecordEnvelopeV1,
  SignedSystemRecordRootDescriptorEnvelopeV1,
  SystemRecordAppliedStateAbsentV1,
  SystemRecordAppliedStatePresentV1,
  SystemRecordAppliedStateV1,
  SystemRecordAppliedStatusV1,
  SystemRecordAuthorityDecisionV1,
  SystemRecordCacheMetadataV1,
  SystemRecordCachePreflightInputV1,
  SystemRecordCachePreflightResultV1,
  SystemRecordCacheReferenceV1,
  SystemRecordCacheRowAccountingV1,
  SystemRecordCapacityStateV1,
  SystemRecordClosureArtifactV1,
  SystemRecordConflictIntentOperationV1,
  SystemRecordDecodedResponseFrameV1,
  SystemRecordDecodedResponseHeaderV1,
  SystemRecordEip1271EvidenceV1,
  SystemRecordErrorResponseHeaderV1,
  SystemRecordGetBundleRequestV1,
  SystemRecordGetControlObjectRequestV1,
  SystemRecordGetInventoryObjectRequestV1,
  SystemRecordGetRootRequestV1,
  SystemRecordInventoryCowUpdateAccountingV1,
  SystemRecordInventoryCowUpdateV1,
  SystemRecordInventoryCowWriteV1,
  SystemRecordInventoryInternalEntryV1,
  SystemRecordInventoryInternalObjectV1,
  SystemRecordInventoryLeafObjectV1,
  SystemRecordInventoryLoadedObjectV1,
  SystemRecordInventoryMutationV1,
  SystemRecordInventoryObjectV1,
  SystemRecordInventoryRejectedLoadV1,
  SystemRecordInventoryRowV1,
  SystemRecordInventoryStoredObjectV1,
  SystemRecordInventoryTraversalSliceResultV1,
  SystemRecordInventoryTraversalSliceV1,
  SystemRecordInventoryTraversalV1,
  SystemRecordInventoryTreeSnapshotV1,
  SystemRecordMaterializationReceiptV1,
  SystemRecordNoSignatureEvidenceV1,
  SystemRecordObjectErrorCodeV1,
  SystemRecordObjectKindV1,
  SystemRecordOkResponseHeaderV1,
  SystemRecordPeerPublicKeyV1,
  SystemRecordRebalanceChoiceV1,
  SystemRecordRequestHeaderV1,
  SystemRecordRequestOperationV1,
  SystemRecordResponseHeaderV1,
  SystemRecordResponseStatusV1,
  SystemRecordRootClaimSetV1,
  SystemRecordRootCollisionEvidenceV1,
  SystemRecordRootDescriptorObjectV1,
  SystemRecordSignatureEntryV1,
  SystemRecordSignatureRoleV1,
  SystemRecordSignatureSuiteV1,
  SystemRecordVerificationClosureObjectV1,
  SystemRecordVerificationClosureV1,
  ValidatedSystemRecordInventoryTreeV1,
  VerifySystemRecordEnvelopeOptionsV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import {
  createSystemRecordInventoryRowTraversalV1,
  type SystemRecordInventoryRowTraversalFailureV1,
  type SystemRecordInventoryRowTraversalProgressV1,
  type SystemRecordInventoryRowTraversalSliceResultV1,
  type SystemRecordInventoryRowTraversalV1,
} from '@origintrail-official/dkg-core/system-record-inventory-row-traversal-v1';

// Importing the complete type-only surface is the contract. Keep the file
// compile-only so none of these names become runtime package requirements.
declare const digest: Digest32V1;

type RowTraversalSubpathContractV1 = readonly [
  typeof createSystemRecordInventoryRowTraversalV1,
  SystemRecordInventoryRowTraversalV1,
  SystemRecordInventoryRowTraversalSliceResultV1,
  SystemRecordInventoryRowTraversalProgressV1,
  SystemRecordInventoryRowTraversalFailureV1,
];

declare const rowTraversalSubpathContract: RowTraversalSubpathContractV1;

const structuralCacheReference = {
  digest,
  cacheDigest: digest,
  objectKind: 'profile-bundle' as const,
};

// @ts-expect-error Cache references are nominal factory-only capabilities.
const forgedCacheReference: SystemRecordCacheReferenceV1 = structuralCacheReference;

// @ts-expect-error Cache metadata is a nominal factory-only capability.
const forgedCacheMetadata: SystemRecordCacheMetadataV1 = {};

void forgedCacheReference;
void forgedCacheMetadata;
void rowTraversalSubpathContract;

export {};
