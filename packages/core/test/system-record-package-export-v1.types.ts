import type {
  AgentProfileAcceptedAuthorityStateV1,
  AgentProfileAuthorityDispositionV1,
  AgentProfileAuthorityDispositionResultV1,
  AgentProfileUndecidedTerminalStatusV1,
  AgentProfileActiveHeadObjectV1,
  AgentProfileAppliedTransitionV1,
  AgentProfileAuthorityTransitionV1,
  AgentProfileClosureVerifierV1,
  AgentProfileConflictEvidenceV1,
  AgentProfileExactLinkedSubjectKindV1,
  AgentProfileForkConflictEntryV1,
  AgentProfileForkEvidenceClosureVerifierV1,
  AgentProfileForkResolutionV1,
  AgentProfileHeadAdvanceEvidenceV1,
  AgentProfileHeadCommonV1,
  AgentProfileHeadObjectV1,
  AgentProfileIdentityFactV1,
  AgentProfileIdentityFactsInputV1,
  AgentProfileIdentityFactsV1,
  AgentProfileIndexedSubjectKindV1,
  AgentProfileLateTombstoneEvidenceV1,
  AgentProfileLateTombstoneRetainedTransitionV1,
  AgentProfileLinkedSubjectKindV1,
  AgentProfileOwnedSubjectKindV1,
  AgentProfileProjectionQuadV1,
  AgentProfileTombstoneHeadObjectV1,
  AgentProfileTransitionConflictEntryV1,
  AgentProfileVerifiedAuthoritySummaryV1,
  AgentProfileVerifiedForkResolutionFactsV1,
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
declare const forkEvidenceClosureVerifier: AgentProfileForkEvidenceClosureVerifierV1;

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
void forkEvidenceClosureVerifier;
void rowTraversalSubpathContract;

// The storage quarantine-exit predicate compares these fork-resolution scalars
// directly against a persisted head version typed plain `string`. Both sides must
// stay strings at runtime: a branded string qualifies and is preferred, but a
// `bigint` on either side would make every comparison false, refusing every
// legitimate unquarantine while looking fail-closed.
type ForkResolutionScalarsAreStrings =
  AgentProfileVerifiedForkResolutionFactsV1['forkedVersion'] extends string
    ? AgentProfileVerifiedForkResolutionFactsV1['authoritySequence'] extends string
      ? AgentProfileVerifiedForkResolutionFactsV1['resolutionVersion'] extends string
        ? true
        : never
      : never
    : never;
const forkResolutionScalarsAreStrings: ForkResolutionScalarsAreStrings = true;
void forkResolutionScalarsAreStrings;

/*
 * THE BOUNDARY THE DISCRIMINATED RESULT BUYS, PINNED AT THE PUBLISHED SURFACE.
 *
 * The derivation returns a RESULT, not a widened disposition domain. Three
 * things must hold and none of them is a naming convention: the result is not
 * itself a disposition; its disposition cannot be read without narrowing on the
 * discriminator; and once narrowed, the decided arm is EXACTLY core's union --
 * never a superset that smuggles a non-disposition back in.
 *
 * An unused `@ts-expect-error` is itself an error, so each negative pin below
 * fails loudly if the property it denies ever becomes true.
 */
const undecidedResult: AgentProfileAuthorityDispositionResultV1 = {
  outcome: 'undecided-terminal',
  status: 'tombstone',
};
// @ts-expect-error A derivation result is not itself an authority disposition.
const forgedDisposition: AgentProfileAuthorityDispositionV1 = undecidedResult;
// @ts-expect-error The disposition is unreachable until the result is narrowed.
const forgedUnnarrowedRead: string = undecidedResult.disposition;
// @ts-expect-error An undecided result cannot populate the accepted authority state.
const forgedAcceptedState: AgentProfileAcceptedAuthorityStateV1['disposition'] = undecidedResult;

/** The decided arm carries core's union exactly -- checked in both directions. */
type DecidedDisposition =
  Extract<AgentProfileAuthorityDispositionResultV1, { outcome: 'decided' }>['disposition'];
type DECIDED_ARM_IS_EXACTLY_CORES_UNION =
  DecidedDisposition extends AgentProfileAuthorityDispositionV1
    ? AgentProfileAuthorityDispositionV1 extends DecidedDisposition ? true : never
    : never;
const decidedArmIsExactlyCoresUnion: DECIDED_ARM_IS_EXACTLY_CORES_UNION = true;

/** The undecided arm keeps the two terminal statuses separately visible. */
type UndecidedStatus =
  Extract<AgentProfileAuthorityDispositionResultV1, { outcome: 'undecided-terminal' }>['status'];
type UNDECIDED_ARM_KEEPS_BOTH_TERMINAL_STATUSES =
  UndecidedStatus extends SystemRecordAppliedStatusV1
    ? 'tombstone' extends UndecidedStatus
      ? 'dirty' extends UndecidedStatus ? true : never
      : never
    : never;
const undecidedArmKeepsBothTerminalStatuses: UNDECIDED_ARM_KEEPS_BOTH_TERMINAL_STATUSES = true;

/*
 * THE NAMED TERMINAL-STATUS TYPE IS PART OF THE PUBLISHED CONTRACT TOO.
 *
 * The other two exported types carry exactness pins; this one did not, so the
 * barrel could have stopped exporting it — or widened it — while every existing
 * assertion still compiled. Raised in review. Imported from the PUBLIC package
 * entry above, so removing the export breaks this file rather than only a
 * downstream consumer.
 *
 * Bidirectional, like its siblings: a member added AND a member removed both
 * fail. It is also checked against the arm that consumes it, so the exported
 * name and the result type cannot drift apart while each stays internally
 * consistent.
 */
type UNDECIDED_TERMINAL_STATUS_IS_EXACTLY_THE_TWO =
  AgentProfileUndecidedTerminalStatusV1 extends 'tombstone' | 'dirty'
    ? 'tombstone' | 'dirty' extends AgentProfileUndecidedTerminalStatusV1 ? true : never
    : never;
const undecidedTerminalStatusIsExactlyTheTwo: UNDECIDED_TERMINAL_STATUS_IS_EXACTLY_THE_TWO = true;

/** ...and it is the same type the undecided arm actually carries. */
type UNDECIDED_ARM_USES_THE_EXPORTED_STATUS_TYPE =
  UndecidedStatus extends AgentProfileUndecidedTerminalStatusV1
    ? AgentProfileUndecidedTerminalStatusV1 extends UndecidedStatus ? true : never
    : never;
const undecidedArmUsesTheExportedStatusType: UNDECIDED_ARM_USES_THE_EXPORTED_STATUS_TYPE = true;

void undecidedTerminalStatusIsExactlyTheTwo;
void undecidedArmUsesTheExportedStatusType;

void decidedArmIsExactlyCoresUnion;
void undecidedArmKeepsBothTerminalStatuses;
void forgedUnnarrowedRead;
void forgedDisposition;
void forgedAcceptedState;

/*
 * AXIS-EXACTNESS LIVES HERE BECAUSE THIS IS A LANE THAT COMPILES.
 *
 * These guards were originally written in the disposition vitest file, where they
 * could not work: `packages/core/tsconfig.json` includes only `src`, and vitest
 * transpiles without semantic typechecking, so a conditional type collapsing to
 * `never` was never evaluated and the runtime assertion only ever read a literal
 * `true`. Found in review. `test:system-record-export` runs
 * `tsc --noEmit --strict` over THIS file, so here the collapse is a build error.
 *
 * Both checks are bidirectional: a member ADDED to either union and a member
 * REMOVED from it both fail. A one-directional check stays green while the list
 * covers less than the union it claims to enumerate.
 *
 * The lists are duplicated from the disposition table on purpose -- these read the
 * PUBLISHED package surface, so they also catch a union that stops being exported.
 * Their runtime twin is proven separately against the applied-state codec.
 */
const APPLIED_STATUSES_V1 = ['active', 'quarantined', 'tombstone', 'dirty'] as const;
type APPLIED_STATUSES_ARE_EXACTLY_THE_UNION =
  SystemRecordAppliedStatusV1 extends (typeof APPLIED_STATUSES_V1)[number]
    ? (typeof APPLIED_STATUSES_V1)[number] extends SystemRecordAppliedStatusV1 ? true : never
    : never;
const appliedStatusesAreExactlyTheUnion: APPLIED_STATUSES_ARE_EXACTLY_THE_UNION = true;

const ACCEPTED_DISPOSITIONS_V1 = [
  'discoverable',
  'head-fork-quarantined',
  'transition-equivocation-quarantined',
] as const;
type ACCEPTED_DISPOSITIONS_ARE_EXACTLY_THE_UNION =
  AgentProfileAuthorityDispositionV1 extends (typeof ACCEPTED_DISPOSITIONS_V1)[number]
    ? (typeof ACCEPTED_DISPOSITIONS_V1)[number] extends AgentProfileAuthorityDispositionV1
      ? true : never
    : never;
const acceptedDispositionsAreExactlyTheUnion: ACCEPTED_DISPOSITIONS_ARE_EXACTLY_THE_UNION = true;

void appliedStatusesAreExactlyTheUnion;
void acceptedDispositionsAreExactlyTheUnion;

export {};
