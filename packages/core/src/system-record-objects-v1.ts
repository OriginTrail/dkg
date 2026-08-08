/**
 * Supported System Record V1 object surface.
 *
 * Object codecs, authority policy, closure verification, and cache accounting
 * remain independently owned internal modules. This explicit facade prevents
 * factory-only capabilities and orchestration helpers from becoming public API.
 */
export {
  AGENT_PROFILE_LINK_PREDICATES_V1,
  AGENT_PROFILE_SCHEMA_TERMS_V1,
  assertAgentProfileAuthorityTransitionV1,
  assertAgentProfileConflictEvidenceV1,
  assertAgentProfileForkResolutionV1,
  assertAgentProfileHeadObjectV1,
  assertAgentRootV1,
  assertCanonicalRfc3339SecondsV1,
  assertCanonicalSystemRecordPeerIdV1,
  assertDerivedAgentEncryptionSubjectV1,
  assertOwnedSubjectTableObjectV1,
  assertSystemRecordPeerBindingV1,
  canonicalizeAgentProfileAuthorityTransitionV1,
  canonicalizeAgentProfileConflictEvidenceV1,
  canonicalizeAgentProfileForkResolutionV1,
  canonicalizeAgentProfileHeadObjectV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSystemRecordRootCollisionEvidenceV1,
  classifyAgentProfileOwnedSubjectV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordRootCollisionEvidenceDigestV1,
  copyBoundedSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  digestSystemRecordJsonV1,
  digestSystemRecordBytesV1,
  deriveAgentProfileOwnedSubjectV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  isAllowedAgentProfilePredicateV1,
  parseCanonicalAgentProfileAuthorityTransitionV1,
  parseCanonicalAgentProfileConflictEvidenceV1,
  parseCanonicalAgentProfileForkResolutionV1,
  parseCanonicalAgentProfileHeadObjectV1,
  parseCanonicalOwnedSubjectTableObjectV1,
  parseCanonicalRfc3339SecondsV1,
  SystemRecordObjectErrorV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileExactLinkedSubjectKindV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileForkConflictEntryV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadCommonV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileIndexedSubjectKindV1,
  type AgentProfileLinkedSubjectKindV1,
  type AgentProfileOwnedSubjectKindV1,
  type AgentProfileTombstoneHeadObjectV1,
  type AgentProfileTransitionConflictEntryV1,
  type CanonicalRfc3339SecondsV1,
  type OwnedSubjectTableObjectV1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileForkResolutionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordEnvelopeV1,
  type SystemRecordEip1271EvidenceV1,
  type SystemRecordNoSignatureEvidenceV1,
  type SystemRecordObjectErrorCodeV1,
  type SystemRecordPeerPublicKeyV1,
  type SystemRecordRootCollisionEvidenceV1,
  type SystemRecordSignatureEntryV1,
  type SystemRecordSignatureRoleV1,
  type SystemRecordSignatureSuiteV1,
} from './system-record-agent-profile-codecs-v1-internal.js';

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
  evaluateAuthorityTransitionAgainstAcceptedStateV1,
  evaluateAuthorityTransitionConflictV1,
  evaluateAuthorityTransitionV1,
  isAgentProfileHeadBoundToAcceptedTransitionV1,
  isDirectResolvingSuccessorV1,
  type AgentProfileAcceptedAuthorityStateV1,
  type AgentProfileHeadAdvanceEvidenceV1,
  type SystemRecordAuthorityDecisionV1,
} from './system-record-authority-v1-internal.js';

export type { AgentProfileAppliedTransitionV1 } from './system-record-authority-types-v1-internal.js';

export {
  assertAgentProfileVerifiedAuthoritySummaryV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
} from './system-record-authority-summary-v1-internal.js';

export {
  assertSystemRecordClosureAlgebraV1,
  buildAgentProfileVerificationClosureV1,
  type AgentProfileClosureVerifierV1,
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
