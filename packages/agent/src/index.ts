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
export {
  DiscoveryClient,
  discoveredAgentIdentityKey,
  discoveredAgentRowKey,
  groupDiscoveredAgentIdentityRows,
  type DiscoveredAgent,
  type DiscoveredAgentIdentityRows,
  type DiscoveredOffering,
  type SkillSearchOptions,
} from './discovery.js';
export {
  signAgentDelegation,
  verifyAgentDelegation,
  computeDelegationDigest,
  type AgentDelegationPayload,
  type SignedAgentDelegation,
  type SignAgentDelegationParams,
  type VerifyAgentDelegationOptions,
} from './auth/agent-delegation.js';
export * from './rfc64/catalog-row-authorship.js';
export * from './rfc64/finalized-vm-composer-v1.js';
export {
  RecoverableAuthorAttestationErrorV1,
} from './rfc64/recoverable-author-attestation-v1.js';
export * from './rfc64/author-catalog-producer.js';
export * from './rfc64/swm-author-inventory-producer-v1.js';
export * from './rfc64/swm-inventory-catalog-reconciler-v1.js';
export * from './rfc64/public-catalog-transport-v1.js';
export * from './rfc64/public-catalog-current-head-discovery-v1.js';
export * from './rfc64/open-catalog-policy-v1.js';
export * from './rfc64/public-catalog-receiver-v1.js';
export * from './rfc64/public-catalog-service-v1.js';
export * from './rfc64/public-catalog-issuer-delegation-v1.js';
export * from './rfc64/public-catalog-native-transport-v1.js';
export * from './rfc64/public-catalog-native-receiver-v1.js';
export {
  computeRfc64AppliedInventoryDigestV1,
  type ComputeRfc64AppliedInventoryDigestInputV1,
  type Rfc64AppliedInventoryDigestRowV1,
} from './rfc64/public-catalog-inventory-completeness-v1.js';
export * from './rfc64/public-catalog-successor-producer-v1.js';
export * from './rfc64/public-open-catalog-scope-v1.js';
export * from './rfc64/public-catalog-native-reconciler-v1.js';
export * from './rfc64/public-catalog-activation-config-v1.js';
export * from './rfc64/policy-cell-v1.js';
export { encrypt, decrypt, ed25519ToX25519Private, ed25519ToX25519Public, x25519SharedSecret } from './encryption.js';
export { MessageHandler, type SkillRequest, type SkillResponse, type SkillHandler, type ChatHandler, type ChatAclCheck } from './messaging.js';
export {
  NetworkAdmissionService,
  type NetworkAdmissionOptions,
  type NetworkAdmissionSnapshot,
} from './p2p/network-admission.js';
export {
  peerIdsFromMultiaddr,
  peerIdsFromMultiaddrs,
  targetPeerIdFromMultiaddr,
} from './p2p/multiaddr-peer-target.js';
export { GossipPublishHandler, type GossipPublishHandlerCallbacks } from './gossip-publish-handler.js';
export { FinalizationHandler } from './finalization-handler.js';
export {
  VmReconcileDispatcher,
} from './chain-reconciler.js';
export { resolveSyncReconcilerEnabled } from './sync/backpressure.js';
export {
  classifySharedMemoryFreshness,
  type SelectedSharedMemorySyncResult,
  type SharedMemoryFreshnessSummary,
} from './sync/shared-memory-freshness.js';
export {
  type Rfc64SelectedSwmGraphSyncStatus,
} from './sync/selected-swm-graph-sync-status.js';
export {
  ContextGraphOnChainIdUnresolvedError,
  VmReconcileQueueClosedError,
  VmReconcileQueueFullError,
  VmReconcileShutdownTimeoutError,
  VM_RECONCILE_SHUTDOWN_TIMEOUT_ERROR_CODE,
  VmReconcileUnavailableError,
  type ContextGraphReconcileResult,
  type ContextGraphReconcileStatus,
  type VmReconcileSource,
} from './vm-reconcile-service.js';
export {
  ContextGraphAssetFetchConflictError,
  ContextGraphAssetFetchValidationError,
  ExactAssetFetchLifecycleClosedError,
  MAX_CONTEXT_GRAPH_ASSET_FETCH_PEERS,
  runExactAssetFetch,
  type ContextGraphAssetFetchItemResult,
  type ContextGraphAssetFetchItemStatus,
  type ContextGraphAssetFetchResult,
  type ExactAssetChainSnapshot,
  type ExactAssetFetchDependencies,
  type ExactAssetFetchEvidence,
  type ExactAssetLocalState,
} from './sync/exact-asset-fetch.js';
export {
  ContextGraphMembershipPersistQueueClosedError,
  ContextGraphMembershipPersistQueueFullError,
  ContextGraphMembershipPersistShutdownTimeoutError,
  CONTEXT_GRAPH_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT_ERROR_CODE,
} from './context-graph-membership-persist-scheduler.js';
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
  CclResourceNotFoundError,
  type PublishCclPolicyInput,
  type CclPolicyRecord,
  type CclMissingResource,
  type PolicyApprovalBinding,
} from './ccl-policy.js';
export { ContextGraphPolicyAuthorizationError } from './dkg-agent-ownership.js';
export { DKGAgent } from './dkg-agent.js';
export type {
  ConfiguredContextGraphMetadataReconciliationDiagnostic,
  ConfiguredContextGraphMetadataReconciliationResult,
} from './configured-context-graph-metadata-reconciliation.js';
export type {
  AcceptRfc64CatalogAccessSnapshotParamsV1,
  PublishAuthorCatalogExactSetSuccessorParamsV1,
  PublishAuthorCatalogExactSetSuccessorResultV1,
  PublishAuthorCatalogGenesisParamsV1,
  Rfc64CatalogAuthorSignerV1,
  Rfc64CatalogRuntimeSelectionStatusV1,
} from './dkg-agent-rfc64-catalog.js';
export type {
  ReconcileRfc64PublicRootCatalogExactSetParamsV1,
  ReconcileRfc64PublicRootCatalogExactSetResultV1,
} from './dkg-agent-rfc64-catalog-upsert.js';
export type {
  ReconcileRfc64PublicCatalogFromSwmInventoryParamsV1,
  ReconcileRfc64PublicCatalogFromSwmInventoryResultV1,
} from './dkg-agent-rfc64-swm-catalog-projection.js';
export type {
  Rfc64PublicCatalogAuthorRepairOutcomeV1,
  Rfc64PublicCatalogAuthorRepairStatusV1,
  Rfc64SwmCatalogProjectionSupervisorStatusV1,
} from './dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
export type {
  Rfc64PublicCatalogBootstrapStatusV1,
} from './dkg-agent-rfc64-catalog-bootstrap.js';
export type {
  AcceptedRfc64CatalogAccessSnapshotV1,
} from './rfc64/catalog-access-policy-v1.js';
export {
  Rfc64CatalogReconciliationTerminalErrorV1,
  type Rfc64CatalogReconciliationFailureCompletionV1,
  type Rfc64CatalogReconciliationFailureOutcomeV1,
  type Rfc64CatalogReconciliationTerminalReasonV1,
} from './rfc64/public-catalog-reconciliation-failure-v1.js';
export {
  Rfc64CatalogSynchronizationErrorV1,
} from './rfc64/catalog-synchronization-error-v1.js';
export {
  RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_OUTCOMES_V1,
  RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1,
  RFC64_PUBLIC_CATALOG_RECONCILIATION_SUCCESS_OUTCOMES_V1,
  isRfc64CatalogReconciliationFailureOutcomeV1,
  isRfc64CatalogReconciliationSuccessOutcomeV1,
  isRfc64PublicCatalogReceiverFailureCompletionV1,
  isRfc64PublicCatalogReceiverSuccessCompletionV1,
  type Rfc64CatalogReconciliationSuccessOutcomeV1,
  type Rfc64PublicCatalogReceiverCompletionOutcomeV1,
  type Rfc64PublicCatalogReceiverCompletionV1,
  type Rfc64PublicCatalogReceiverFailureCompletionV1,
  type Rfc64PublicCatalogReceiverSuccessCompletionV1,
} from './rfc64/public-catalog-reconciliation-outcome-v1.js';
export {
  DEFAULT_SYSTEM_CONTEXT_GRAPH_PRIORITY,
  SYNC_ADMISSION_SOURCES,
  contextGraphPriority,
  countSyncPriorityClasses,
  normalizeSyncAdmissionSource,
  normalizeSyncContextGraphPriorities,
  orderContextGraphIdsByPriority,
  resolveSyncContextGraphPriorities,
  syncPriorityClass,
  validateSyncResponderSnapshotLimitsConfig,
  type SyncAdmissionSource,
  type SyncAdmissionConfig,
  type SyncContextGraphPriorityConfig,
  type SyncPriorityClass,
  type SyncResponderSnapshotLimitsConfig,
  type SyncSchedulerLane,
} from './sync/policy.js';
export type { PcaConfirmationOutcome } from './dkg-agent-pca-confirmation.js';
export {
  verifyBatch,
  buildBatchRejectionRecord,
  batchRejectionAssertionName,
  batchRejectionRecordToQuads,
  type VerifyBatchInput,
  type VerifyBatchResult,
  type BatchRejectionRecord,
} from './swm/verify-batch.js';
export {
  reportBatchRejectionWithLifecycle,
  type BatchRejectionReporterAgent,
  type BatchRejectionAgentLaneOptions,
  type BatchRejectionAuthorLaneOptions,
  type ReportBatchRejectionInput,
  type ReportBatchRejectionResult,
} from './swm/batch-rejection-reporter.js';
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
  ROOTLESS_UPDATE_ERROR_CODES,
  RootlessUpdateError,
  isRootlessUpdateError,
  type RootlessUpdateErrorCode,
} from './rootless-update-error.js';
export {
  ContextGraphNotFoundError,
  InvalidContentError,
  StaleSenderKeyTargetError,
  type DKGAgentConfig,
  type ReplicationEvent,
  type Rfc64CatalogAccessPolicyAuthorityConfigV1,
  type Rfc64CatalogBootstrapConfigV1,
  type Rfc64CatalogBootstrapPolicyV1,
  type DKGAgentACKTransportOptions,
  type ContextGraphSub,
  type ContextGraphSyncMode,
  type ContextGraphDiscoveryMetadata,
  type ContextGraphDiscoveryOptions,
  type PublishOpts,
  type PublishAsyncContent,
  type PublishAsyncOpts,
  type PublishAsyncQuadEnvelope,
  type ContextGraphMemberPrincipalType,
  type ContextGraphMemberStatus,
  type ContextGraphMembershipRecord,
  type ContextGraphMembershipStore,
  type ContextGraphJoinPolicyMode,
  type ContextGraphJoinPolicyRecord,
  type ContextGraphJoinPolicyAuditEventType,
  type ContextGraphJoinPolicyAuditEvent,
  type ContextGraphJoinPolicyRateReservation,
  type ContextGraphJoinPolicyStore,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionRehydrationStatus,
  type ContextGraphSubscriptionStore,
  type VmReconcileNegativeRecord,
  type VmReconcilePeerTopology,
  type VmReconcilePeerTopologyEvidence,
  type VmReconcilePeerTopologyPeer,
  type SelectedVmReconcileCursorStore,
  type SelectedVmReconcileCursorRecord,
  type ContextGraphWritePreflightProbe,
  type PeerHealth,
  type CclPublishedEvaluationRecord,
  type CclPublishedResultEntry,
  type PendingSenderKeyEntry,
  type AssertionArtifactKind,
  type ImportedArtifactByteStore,
  type DurableSyncDiagnostics,
  type DurableSyncResult,
  type SharedMemorySyncDiagnostics,
  type SharedMemorySyncResult,
  type SwmSnapshotCoverage,
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
  RandomSamplingShutdownTimeoutError,
  RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_ERROR_CODE,
  stopRandomSamplingHandleWithin,
  type RandomSamplingBindOptions,
  type RandomSamplingDisabledReason,
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
// 2026-07-07 sync-storm mitigation (C-1) — the bounded catch-up fan-out mapper
// and its shared cap (DKG_CATCHUP_MAX_CONCURRENT_PEERS, default 4). Exported on
// the public surface because the CLI daemon's Worker-based catch-up runner
// (`/api/context-graph/subscribe` → `catchup-runner-worker-impl`) runs the same
// registry-scale per-peer fan-out and must be bounded by the SAME knob, without
// deep-importing the compiled `dist/` module.
export { mapWithConcurrency } from './map-with-concurrency.js';
export {
  createVmReconcilePeerTopology,
  createVmReconcileCleanMissPeerIds,
  encodeLegacyVmReconcilePeerTopologyKey,
  isVmReconcilePeerTopology,
  parseLegacyVmReconcilePeerTopologyKey,
  parseVmReconcileCleanMissPeerIds,
  parseVmReconcilePeerTopology,
} from './vm-reconcile-peer-topology.js';
export {
  CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
  CATCHUP_STOP_ON_PROOF,
  catchupWaveSizes,
} from './sync/catchup-concurrency.js';
// Only what a cross-package consumer genuinely needs. The CLI daemon's Worker
// catch-up runner drives the same plane policy and must not deep-import the
// compiled `dist/`; everything else here — the backoff curve, the env parser,
// the injected clock seams — is retry-policy internals, and in-package tests
// import those from `./sync/catchup-policy.js` directly rather than pinning
// them to the published surface.
export {
  CATCHUP_BACKPRESSURE_MAX_WAIT_MS,
  FOREGROUND_CATCHUP_SYNC_PRIORITY,
  catchupAdmissionSource,
  catchupPriorityForMode,
  catchupSourceForMode,
  runCatchupPlaneWithPolicy,
  runCatchupPlanesWithPolicy,
  type CatchupAdmissionSource,
  type CatchupBackpressureRetryPolicy,
  type CatchupMode,
  type CatchupPlaneContext,
  type CatchupPlanePolicyClock,
  type CatchupPlanePolicyOptions,
  type CatchupPlanePolicyResult,
  type CatchupPlaneSourceOverride,
  type CatchupPlaneResult,
} from './sync/catchup-policy.js';
// #2050 — the bounded repeat of the public SWM peer walk. Both drivers of that
// walk call the same stop rule, and one of them is the CLI daemon's Worker
// runner, so the rule and the operator-facing bounds it reads must be on the
// published surface. The env PARSERS stay in-package for the same reason the
// retry policy's do: in-package tests import them from
// `./sync/catchup-pass-policy.js` directly rather than pinning them here.
export {
  DEFAULT_SWM_CATCHUP_MAX_PASSES,
  DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS,
  SwmCatchupPassTracker,
  catchupPassNowMs,
  resolveSwmCatchupPassConfig,
  shouldRunAnotherCatchupPass,
  type CatchupPassConfig,
  type CatchupPassCoverage,
  type CatchupPassDecision,
  type CatchupPassDecisionReason,
  type CatchupPassPolicyInput,
} from './sync/catchup-pass-policy.js';
// Which peer may let one answer stand for a WHOLE Context Graph is the load-
// bearing distinction of the foreground catch-up walk (#2006), and the walk
// lives in the CLI's worker. Publishing the model — rather than letting the
// bridge re-shape it into a bare string — is what keeps the two sides from
// drifting: adding or renaming a provenance value must break the consumer, not
// silently downgrade it to "not authoritative".
export {
  authoritativeSyncPeerId,
  type SyncPeerResolution,
} from './dkg-agent-cg-resolve.js';
export {
  classifyDurableProgress,
  createFailedPeerDurableSyncResult,
  isDurableSyncComplete,
  normalizeDurableSyncResult,
  type DurableProgressClassification,
  type DurableProgressClassificationOptions,
  type DurableProgressSummary,
} from './sync/durable-progress.js';
export {
  DurableRecoveryCoordinator,
  classifyDurableRecoverySlice,
  rankDurableRecoveryPeers,
  selectCanonicalDurableRecoveryManifest,
  type DurableRecoveryContinuationOutcome,
  type DurableRecoveryOwnerControl,
  type DurableRecoveryPeerCandidate,
  type DurableRecoveryPeerHealth,
  type DurableRecoverySliceEvidence,
} from './sync/durable-recovery-coordinator.js';
// The ONE reduction for `SwmSnapshotCoverage`. Exported so the CLI catch-up
// walk reduces across peers with the same rule the agent uses across Context
// Graphs — two implementations is how a numerator and a denominator end up
// coming from different peers.
export { selectSwmSnapshotCoverage } from './sync/requester/shared-memory-sync.js';
// 2026-07-08 sync-storm mitigation (#1233) — resolve the opt-in `agents/_meta`
// fetch flag. Exported on the public surface so the CLI daemon lifecycle resolves
// it identically to the in-agent lifecycle, without deep-importing `dist/`.
// `parseBooleanEnv` is part of the shipped public surface (#1526) — keep it
// exported. The serve-side resolver `shouldWithholdAgentsDurableMeta` stays
// internal; only the in-agent lifecycle (at its env boundary) + tests use it.
export { resolveSyncAgentsMeta, parseBooleanEnv } from './sync/agents-meta-policy.js';
