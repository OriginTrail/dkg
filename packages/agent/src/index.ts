export { DKGAgentWallet, type AgentWallet } from './agent-wallet.js';
export { loadOpWallets, generateWallets, type OpWalletsConfig, type WalletEntry } from './op-wallets.js';
export {
  generateCustodialAgent, registerSelfSovereignAgent, agentFromPrivateKey,
  generateAgentToken, hashAgentToken,
  ensureWorkspaceEncryptionKey,
  appendCustodialWorkspaceEncryptionKey,
  revokeCustodialWorkspaceEncryptionKey,
  attachRevocationToWorkspaceEncryptionKey,
  activeWorkspaceEncryptionKeys,
  refreshDefaultEncryptionKeyView,
  migrateLegacyWorkspaceEncryptionFields,
  type AgentKeyRecord,
  type WorkspaceEncryptionKeyEntry,
  type KeystoreEntry,
} from './agent-keystore.js';
export {
  buildAgentProfile,
  canonicalAgentDidSubject,
  collectPublishableMultiaddrs,
  AGENT_REGISTRY_CONTEXT_GRAPH,
  AGENT_REGISTRY_GRAPH,
  type AgentProfileConfig,
  type SkillOfferingConfig,
} from './profile.js';
export { ProfileManager } from './profile-manager.js';
export { DiscoveryClient, type DiscoveredAgent, type DiscoveredOffering, type SkillSearchOptions } from './discovery.js';
export {
  signAgentDelegation,
  verifyAgentDelegation,
  computeDelegationDigest,
  type AgentDelegationPayload,
  type SignedAgentDelegation,
  type SignAgentDelegationParams,
  type VerifyAgentDelegationOptions,
} from './auth/agent-delegation.js';
export { encrypt, decrypt, ed25519ToX25519Private, ed25519ToX25519Public, x25519SharedSecret } from './encryption.js';
export { MessageHandler, type SkillRequest, type SkillResponse, type SkillHandler, type ChatHandler, type ChatAclCheck } from './messaging.js';
export { GossipPublishHandler, type GossipPublishHandlerCallbacks } from './gossip-publish-handler.js';
export { FinalizationHandler } from './finalization-handler.js';
export { buildEndorsementQuads, DKG_ENDORSES, DKG_ENDORSED_AT } from './endorse.js';
export {
  CclEvaluator,
  parseCclPolicy,
  validateCclPolicy,
  hashCclFacts,
  type CclFactTuple,
  type CclCanonicalPolicy,
  type CclCondition,
  type CclEvaluationResult,
  type ValidateCclPolicyOptions,
} from './ccl-evaluator.js';
export {
  buildManualCclFacts,
  resolveFactsFromSnapshot,
  type CclFactResolutionMode,
  type ManualCclFacts,
  type ResolveCclFactsFromSnapshotOptions,
  type ResolvedCclFacts,
} from './ccl-fact-resolution.js';
export {
  buildCclEvaluationQuads,
  type PublishCclEvaluationInput,
} from './ccl-evaluation-publish.js';
export {
  buildCclPolicyQuads,
  buildPolicyApprovalQuads,
  hashCclPolicy,
  type PublishCclPolicyInput,
  type CclPolicyRecord,
  type PolicyApprovalBinding,
} from './ccl-policy.js';
export { DKGAgent } from './dkg-agent.js';
export {
  verifyBatch,
  buildBatchRejectionRecord,
  type VerifyBatchInput,
  type VerifyBatchResult,
  type BatchRejectionRecord,
} from './swm/verify-batch.js';
export { createCGHostEnumerator, type CGHostEnumerator, type CGHostEnumeratorDeps } from './swm/enumerate-cg-hosts.js';
export {
  createSwmCatchupPeerSelector,
  classifySwmCatchupPeerOutcome,
  SwmCatchupPeerSelector,
  SWM_CATCHUP_FALLBACK_PROBE_LIMIT,
  SWM_CATCHUP_PEER_GOOD_TTL_MS,
  SWM_CATCHUP_PEER_NEGATIVE_TTL_MS,
  type SelectSwmCatchupPeersInput,
  type SelectSwmCatchupPeersResult,
  type SwmCatchupPeerOutcome,
  type SwmCatchupPeerSelectorOptions,
} from './swm/swm-catchup-peer-selection.js';
export {
  mintMemberAttestation,
  verifyMemberAttestation,
  computeAttestationDigest,
  validateAttestationPayload,
  type MemberAttestation,
  type MemberAttestationPayload,
  type MintMemberAttestationInput,
  type VerifyMemberAttestationInput,
  type VerifyMemberAttestationResult,
} from './swm/member-attestation.js';
export {
  ContextGraphNotFoundError,
  InvalidContentError,
  StaleSenderKeyTargetError,
  type DKGAgentConfig,
  type ContextGraphSub,
  type PublishOpts,
  type PublishAsyncContent,
  type PublishAsyncOpts,
  type PublishAsyncQuadEnvelope,
  type ContextGraphMemberPrincipalType,
  type ContextGraphMemberStatus,
  type ContextGraphMembershipRecord,
  type ContextGraphMembershipStore,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionRehydrationStatus,
  type ContextGraphSubscriptionStore,
  type ContextGraphWritePreflightProbe,
  type PeerHealth,
  type CclPublishedEvaluationRecord,
  type CclPublishedResultEntry,
  type PendingSenderKeyEntry,
  type AssertionArtifactKind,
  type ImportedArtifactByteStore,
} from './dkg-agent-types.js';
export {
  computeImportedArtifactSelector,
  IMPORTED_ARTIFACT_AUTH_PURPOSE,
  IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
  type AssertionArtifactAvailabilityParams,
  type ImportedArtifactRequest,
  type ImportedArtifactResponse,
  type ReadAssertionArtifactParams,
} from './imported-artifact.js';
export {
  bindRandomSampling,
  type RandomSamplingBindOptions,
  type RandomSamplingHandle,
  type RandomSamplingStatus,
  type AgentRole,
} from './random-sampling-bind.js';
export { monotonicTransition, versionedWrite, type MonotonicStages } from './workspace-consistency.js';
export { StaleWriteError, type CASCondition } from '@origintrail-official/dkg-publisher';
export {
  createCGMemberEnumerator,
  type CGMemberEnumerator,
  type CGMemberEnumeration,
  type CGMemberEnumeratorDeps,
  type CGMemberSource,
} from './swm/enumerate-cg-members.js';
export {
  chooseFanOutTier,
  classifySendResult,
  executeSubstrateFanOut,
  FANOUT_RESPONSE_REJECTED,
  FANOUT_RESPONSE_RETRYABLE,
  type ChooseFanOutTierInput,
  type FanOutPlan,
  type FanOutOutcome,
  type FanOutPeerRecord,
  type FanOutBookkeeper,
  type FanOutSubstrate,
  type ExecuteSubstrateFanOutInput,
  type ExecuteSubstrateFanOutResult,
} from './swm/substrate-fanout.js';
export {
  createSwmAckQuorum,
  type SwmAckQuorum,
  type SwmAckQuorumDeps,
  type SwmAckQuorumObservers,
  type SwmAckQuorumStats,
  type SubstrateTopUp,
  type TrackInput,
  type TrackedRecordSnapshot,
} from './swm/ack-quorum.js';
export {
  classifySwmFanoutPeerOutcome,
  createSwmFanoutPeerSelector,
  SWM_FANOUT_PEER_GOOD_TTL_MS,
  SWM_FANOUT_PEER_NEGATIVE_TTL_MS,
  SWM_FANOUT_UNKNOWN_PROBE_LIMIT,
  type SelectSwmFanoutPeersInput,
  type SelectSwmFanoutPeersResult,
  type SwmFanoutPeerOutcome,
  type SwmFanoutPeerSelectorOptions,
} from './swm/swm-fanout-peer-selection.js';
export * from './source-worker.js';
export * from './source-registry.js';
export * from './generic-sql-source.js';
export { KaNumberAllocator, type KaAllocation } from './allocator.js';
// OT-RFC-49 WS-D — the curated public `_catalog` floor builder. Exported on the
// public surface so off-band tooling (e.g. the devnet update-seal helper) can
// re-inject the SAME deterministic floor the producer's curated update() does,
// without deep-importing the compiled `dist/` module.
export {
  buildPublicProjection,
  type PublicProjectionInput,
} from './context-graph-public-projection.js';
