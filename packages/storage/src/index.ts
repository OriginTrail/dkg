export {
  type Quad,
  type TripleStore,
  type QueryResult,
  type QueryOptions,
  type StoreWorkPriority,
  type StorePressureSnapshot,
  type SelectResult,
  type ConstructResult,
  type AskResult,
  type TripleStoreConfig,
  type TripleStoreBackend,
  type TripleStoreQueryOptions,
  type UpdateOptions,
  type DeleteSubjectsInput,
  type PruneRankedSubjectsInput,
  type PruneLinkedRecordClosuresInput,
  type ReplaceSubjectPredicatesInput,
  type ReplaceProjectionFromGraphInput,
  type CopySubjectProjectionInput,
  type StructuredMutation,
  type LargeLiteralStorageConfig,
  registerTripleStoreAdapter,
  createTripleStore,
  tryUpdateWithTouchedGraphs,
  tryReplaceGraphAtomically,
  tryReplaceGraphAndSubjectAtomically,
  tryReplaceSubjectAtomically,
  tryDeleteSubjects,
  tryStructuredMutation,
  tryPruneRankedSubjects,
  tryPruneLinkedRecordClosures,
  supportsReplaceSubjectPredicatesAtomically,
  tryReplaceSubjectPredicatesAtomically,
  tryReplaceProjectionFromGraphAtomically,
  supportsCopySubjectProjection,
  tryCopySubjectProjection,
  isExternalBackend,
  getSparqlEndpoint,
  type SparqlEndpoint,
} from './triple-store.js';
export {
  ATOMIC_GRAPH_REPLACE_STAGING_PREFIX,
  assertSubjectReplacementPayload,
  buildAtomicGraphAndSubjectReplaceUpdate,
  buildAtomicGraphReplaceUpdate,
  buildAtomicSubjectReplaceUpdate,
  isAtomicGraphReplaceStagingGraph,
  type AtomicGraphAndSubjectReplaceUpdate,
  type AtomicGraphReplaceUpdate,
} from './atomic-graph-replace.js';
export {
  BOUNDED_MUTATION_MAX_PRUNE_DELETE,
  chunkCopySubjectProjectionInput,
  structuredMutationMightMutate,
  structuredMutationTouchedGraphs,
} from './bounded-structured-mutation.js';
// System-record V1 (#2052 Stack B2). Default-unused: these modules perform no
// I/O, scheduling, timer, or per-store lane work until the daemon supervisor
// supplies a live ownership lease. Their fixed module-level registries remain
// dormant until then.
// Only the members with real consumers are public. `isInternalGraphUriV1` and
// `isEphemeralInternalStagingGraphUriV1` stay module-scoped (imported directly
// by tests, which pin the reserved/ephemeral partition) rather than being
// exported as API nothing calls.
export {
  RESERVED_INTERNAL_GRAPHS_V1,
  ReservedInternalGraphWriteError,
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_STATE_GRAPH,
  assertNotReservedInternalGraphV1,
  isReservedInternalGraphUriV1,
} from './internal-graph-policy.js';
export {
  MANAGED_OXIGRAPH_LEASE_OPTION_KEY,
  ManagedOxigraphBackendUnownedError,
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  extractManagedOxigraphHandoffV1,
  extractManagedOxigraphLeaseV1,
  isManagedOxigraphOwnershipLeaseV1,
  isManagedOxigraphOwnershipLiveV1,
  readManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipInvalidationV1,
  type ManagedOxigraphOwnershipLeaseV1,
  type ManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from './managed-oxigraph-ownership-v1-internal.js';
export {
  SystemRecordControllerRegistrationError,
  SystemRecordLaneActivationConflictError,
  createSystemRecordLaneControllerV1,
  releaseSystemRecordLaneControllerV1,
  type SystemRecordApplyOutcomeV1,
  type SystemRecordChildHandoffV1,
  type SystemRecordDeferralReasonV1,
  type SystemRecordLaneActivationV1,
  type SystemRecordLaneControllerDepsV1,
  // The shared deps base is deliberately NOT published: it is a factoring
  // device, not a valid factory input (no barrier of either kind), and a
  // public name for an incomplete shape is compatibility burden without use.
  type SystemRecordLaneControllerTypedDepsV1,
  type SystemRecordLaneControllerV1,
  type SystemRecordLaneSessionV1,
  type SystemRecordLaneStateV1,
  type SystemRecordLaneBarrierKindV1,
  type SystemRecordLaneBarrierResultsV1,
  type SystemRecordLaneTypedBarrierV1,
  type SystemRecordTransactionExecutorV1,
} from './system-record-materializer-v1.js';
export {
  createStoreControlBarrierKeyV1,
  type StoreControlBarrierKeyV1,
} from './store-control-barrier-key-v1.js';
export type {
  SystemRecordMaterializationEpochRotationV1,
} from './system-record-materialization-epoch-contract-v1.js';
export {
  SystemRecordLaneForwarderV1,
  type SystemRecordLaneOutcomePolicyV1,
} from './system-record-lane-forwarder-v1.js';
export {
  TRIPLE_STORE_CAPABILITY_SUPPORT,
  UnsupportedTripleStoreCapabilityError,
  supportsTripleStoreCapability,
  isTripleStoreCapabilityRefusal,
  isReplaceGraphAndSubjectCapabilityRefusal,
  isReplaceGraphCapabilityRefusal,
  isReplaceSubjectCapabilityRefusal,
  type TripleStoreCapability,
} from './unsupported-capability-error.js';
export {
  StorePriorityScheduler,
  StoreSchedulerBusyError,
  externalStorePriorityScheduler,
  getExternalStorePrioritySchedulerSnapshot,
  DEFAULT_STORE_QUEUE_LIMIT,
  DEFAULT_STORE_QUEUE_WAIT_TIMEOUT_MS,
  type StorePrioritySchedulerSnapshot,
  type StorePrioritySchedulerOptions,
  type StorePriorityQueueLimits,
  type StoreSchedulerBusyReason,
} from './store-priority-scheduler.js';
export {
  EXTERNAL_LITERAL_REF_DATATYPE,
  SHARED_MEMORY_GRAPH_SUFFIX,
  DEFAULT_LARGE_LITERAL_THRESHOLD_BYTES,
  SharedMemoryLiteralBlobStore,
  type SharedMemoryLiteralBlobStoreOptions,
} from './shared-memory-literal-blob-store.js';
export {
  DEFAULT_GRAPH_SET_REVALIDATE_MS,
  DEFAULT_GRAPH_SET_REVALIDATE_FAILURE_MAX_BACKOFF_MS,
  GraphSetIndexStore,
  type GraphSetIndexStoreOptions,
  type GraphSetMutationEvent,
  type GraphSetMutationSource,
} from './graph-set-index-store.js';
export {
  CHANGELOG_GRAPH,
  CHANGELOG_SCHEMA_VERSION,
  ChangelogStore,
  changelogSchemaQuad,
  asChangelogReader,
  type ChangeOp,
  type ChangeRecord,
  type ChangelogEraGuard,
  type ChangelogHead,
  type ChangelogReader,
  type ChangelogStoreOptions,
} from './changelog-store.js';
export {
  GraphWriteGenTracker,
  asGraphWriteGenSource,
  type GraphWriteGenSource,
} from './graph-write-gen.js';
export {
  ExactGraphReadError,
  quadToNQuad,
  quadsToNQuads,
  readExactGraphPaged,
  readExactGraphPagedWithDiscoveredCount,
  type ExactGraphReadErrorCode,
  type ExactGraphReadErrorKind,
  type ReadExactGraphPagedOptions,
} from './bounded-rdf.js';
export { StoreResponseTooLargeError } from './http-response-limit.js';
export {
  resolveGraphScopedOrLegacyMetadata,
  type GraphScopedOrLegacyMetadata,
} from './graph-knowledge-asset-metadata-loader.js';

export { OxigraphStore } from './adapters/oxigraph.js';
export { OxigraphWorkerStore } from './adapters/oxigraph-worker.js';
export {
  BlazegraphStore,
  DEFAULT_BLAZEGRAPH_OPERATION_TIMEOUT_MS,
  type BlazegraphStoreOptions,
} from './adapters/blazegraph.js';
export {
  SparqlHttpStore,
  type SparqlHttpStoreOptions,
  type SparqlHttpQueryOptions,
  type SparqlHttpSlowQueryEvent,
} from './adapters/sparql-http.js';
export {
  ContextGraphManager,
  GraphManager,
  loadSelectedSharedMemoryQuads,
  loadSharedMemoryQuadsForScope,
  loadSharedMemorySliceWithKaBoundFallback,
  canonicalSharedMemoryScopeWriteGraph,
  resolveSharedMemoryScopeGraphs,
  resolveSharedMemoryScopeWriteGraph,
  loadSelectedVerifiableMemoryQuads,
  resolveSharedMemoryReadGraphs,
  resolveVerifiableMemoryReadGraphs,
  type LoadSelectedSharedMemoryQuadsOptions,
  type SharedMemoryResultBudget,
  SharedMemoryResultBudgetError,
  type LoadSelectedVerifiableMemoryQuadsOptions,
  type NonEmptyGraphList,
  type NamedKnowledgeAssetGraphIdentity,
  type SharedMemoryReadSelection,
  type SharedMemoryGraphScope,
  type SwmKaGraphBound,
  type SwmSliceSourceTags,
  type LoadSharedMemorySliceWithKaBoundFallbackOptions,
} from './graph-manager.js';
export {
  PrivateContentStore,
  type KnowledgeAssetPrivateReadOptions,
} from './private-store.js';
export { LOCAL_TRUSTED_KA_CONTROLS_GRAPH } from './local-trusted-controls.js';
// #2079 — node-local memo of an already-verified SWM assertion graph. Read only
// AFTER a count gate has matched; see the module doc for why the count cannot
// be dropped.
export {
  SWM_MATERIALIZATION_WITNESS_GRAPH,
  swmMaterializationWitnessSubject,
  readSwmMaterializationWitness,
  writeSwmMaterializationWitness,
  invalidateSwmMaterializationWitness,
} from './swm-materialization-witness.js';

// Side-effect: register built-in adapters
import './adapters/oxigraph.js';
import './adapters/oxigraph-worker.js';
import './adapters/blazegraph.js';
import './adapters/sparql-http.js';
// `linkStoreChainV1` is deliberately NOT exported: it is an internal
// composition detail of this package's own decorators. A wrapper outside
// storage is traversable through its public `innerStore`, so publishing the
// registry would add a second traversal source for the same object without
// changing discovery.
export { StoreChainCycleError, type StoreChainNodeV1 } from './store-chain-capability.js';
