/**
 * Supported System Record V1 object surface.
 *
 * Object codecs, authority policy, closure verification, and cache accounting
 * remain independently owned internal modules. This explicit facade prevents
 * factory-only capabilities and orchestration helpers from becoming public API.
 */
export {
  assertAgentProfileAuthorityTransitionV1,
  assertAgentProfileForkResolutionV1,
  canonicalizeAgentProfileAuthorityTransitionV1,
  canonicalizeAgentProfileForkResolutionV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  parseCanonicalAgentProfileAuthorityTransitionV1,
  parseCanonicalAgentProfileForkResolutionV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileForkResolutionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordEnvelopeV1,
  type SystemRecordEip1271EvidenceV1,
  type SystemRecordNoSignatureEvidenceV1,
  type SystemRecordSignatureEntryV1,
  type SystemRecordSignatureRoleV1,
  type SystemRecordSignatureSuiteV1,
} from './system-record-agent-profile-control-codecs-v1-internal.js';

export {
  assertAgentProfileHeadObjectV1,
  canonicalizeAgentProfileHeadObjectV1,
  computeAgentProfileHeadObjectDigestV1,
  parseCanonicalAgentProfileHeadObjectV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileHeadCommonV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileTombstoneHeadObjectV1,
} from './system-record-agent-profile-head-codec-v1-internal.js';

export {
  assertAgentRootV1,
  assertCanonicalRfc3339SecondsV1,
  assertCanonicalSystemRecordPeerIdV1,
  assertSystemRecordPeerBindingV1,
  copyBoundedSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  digestSystemRecordBytesV1,
  digestSystemRecordJsonV1,
  parseCanonicalRfc3339SecondsV1,
  SystemRecordObjectErrorV1,
  type CanonicalRfc3339SecondsV1,
  type SystemRecordObjectErrorCodeV1,
  type SystemRecordPeerPublicKeyV1,
} from './system-record-agent-profile-primitives-v1-internal.js';

export {
  assertAgentProfileConflictEvidenceV1,
  canonicalizeAgentProfileConflictEvidenceV1,
  canonicalizeSystemRecordRootCollisionEvidenceV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeSystemRecordRootCollisionEvidenceDigestV1,
  parseCanonicalAgentProfileConflictEvidenceV1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileForkConflictEntryV1,
  type AgentProfileTransitionConflictEntryV1,
  type SystemRecordRootCollisionEvidenceV1,
} from './system-record-agent-profile-evidence-codecs-v1-internal.js';

export {
  AGENT_PROFILE_LINK_PREDICATES_V1,
  AGENT_PROFILE_SCHEMA_TERMS_V1,
  assertDerivedAgentEncryptionSubjectV1,
  assertOwnedSubjectTableObjectV1,
  canonicalizeOwnedSubjectTableObjectV1,
  classifyAgentProfileOwnedSubjectV1,
  computeOwnedSubjectTableDigestV1,
  deriveAgentProfileOwnedSubjectV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  isAllowedAgentProfilePredicateV1,
  parseCanonicalOwnedSubjectTableObjectV1,
  type AgentProfileExactLinkedSubjectKindV1,
  type AgentProfileIndexedSubjectKindV1,
  type AgentProfileLinkedSubjectKindV1,
  type AgentProfileOwnedSubjectKindV1,
  type OwnedSubjectTableObjectV1,
} from './system-record-owned-subject-codecs-v1-internal.js';

export {
  assertCanonicalEip191SignatureV1,
  assertSignedAgentProfileAuthorityTransitionEnvelopeV1,
  assertSignedAgentProfileForkResolutionEnvelopeV1,
  assertSignedAgentProfileHeadEnvelopeV1,
  buildSystemRecordSignatureMessageV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeSignedSystemRecordEnvelopeDigestV1,
  eip191PersonalMessageHashV1,
  parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
  parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  recoverEip191SignerV1,
  verifySignedSystemRecordEnvelopeV1,
  type VerifySystemRecordEnvelopeOptionsV1,
} from './system-record-signatures-v1-internal.js';

export {
  assertAgentProfileForkResolutionEvidenceV1,
  evaluateAgentProfileHeadAdvanceV1,
  evaluateAgentProfileLateTombstoneAdvanceV1,
  evaluateAuthorityTransitionAgainstAcceptedStateV1,
  evaluateAuthorityTransitionConflictV1,
  evaluateAuthorityTransitionV1,
  isAgentProfileHeadBoundToAcceptedTransitionV1,
  isDirectResolvingSuccessorV1,
  type AgentProfileAcceptedAuthorityStateV1,
  type AgentProfileHeadAdvanceEvidenceV1,
  type AgentProfileLateTombstoneDecisionV1,
  type AgentProfileLateTombstoneEvidenceV1,
  type AgentProfileLateTombstoneRetainedTransitionV1,
  type SystemRecordAuthorityDecisionV1,
} from './system-record-authority-v1-internal.js';

export {
  deriveAgentProfileAuthorityDispositionV1,
  type AgentProfileAuthorityDispositionResultV1,
  type AgentProfileAuthorityDispositionV1,
  type AgentProfileUndecidedTerminalStatusV1,
} from './system-record-applied-disposition-v1-internal.js';

export type { AgentProfileAppliedTransitionV1 } from './system-record-authority-types-v1-internal.js';

export {
  assertAgentProfileVerifiedAuthoritySummaryV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type AgentProfileVerifiedForkResolutionFactsV1,
} from './system-record-verification-closure-v1-internal.js';

export {
  assertSystemRecordClosureAlgebraV1,
  buildAgentProfileForkEvidenceAuthorityClosureV1,
  buildAgentProfileVerificationClosureV1,
  type AgentProfileClosureVerifierV1,
  type AgentProfileForkEvidenceClosureVerifierV1,
  type SystemRecordClosureArtifactV1,
  type SystemRecordVerificationClosureObjectV1,
  type SystemRecordVerificationClosureV1,
} from './system-record-verification-closure-v1-internal.js';

export {
  createSystemRecordCacheMetadataV1,
  createSystemRecordCacheReferenceV1,
  preflightSystemRecordCacheAccountingV1,
  type SystemRecordCacheMetadataV1,
  type SystemRecordCachePreflightInputV1,
  type SystemRecordCachePreflightResultV1,
  type SystemRecordCacheReferenceV1,
  type SystemRecordCacheRowAccountingV1,
} from './system-record-cache-accounting-v1-internal.js';
