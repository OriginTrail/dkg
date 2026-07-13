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
  type TripleStoreFactoryConfig,
  type TripleStoreQueryOptions,
  type UpdateOptions,
  type LargeLiteralStorageConfig,
  registerTripleStoreAdapter,
  createTripleStore,
  toTripleStoreBackend,
  tryUpdateWithTouchedGraphs,
  getSparqlEndpoint,
  type SparqlEndpoint,
  type SparqlEndpointStoreConfig,
} from './triple-store.js';
export {
  STORAGE_ADAPTERS,
  classifyTripleStoreBackend,
  customTripleStoreBackend,
  getStorageAdapterPolicy,
  isExternalBackend,
  isStorageAdapterBackend,
  storageAdapterNames,
  type ClassifiedTripleStoreBackend,
  type CustomTripleStoreBackend,
  type ExternalStoreBackend,
  type LocalStoreBackend,
  type StorageAdapterBackend,
  type StorageAdapterKind,
  type StorageAdapterOfKind,
  type StorageAdapterPolicy,
} from './store-backends.js';
export {
  StorePriorityScheduler,
  externalStorePriorityScheduler,
  getExternalStorePrioritySchedulerSnapshot,
  type StorePrioritySchedulerSnapshot,
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

export { OxigraphStore } from './adapters/oxigraph.js';
export { BlazegraphStore } from './adapters/blazegraph.js';
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
  loadSharedMemorySliceWithKaBoundFallback,
  loadSelectedVerifiableMemoryQuads,
  resolveSharedMemoryReadGraphs,
  resolveVerifiableMemoryReadGraphs,
  type LoadSelectedSharedMemoryQuadsOptions,
  type LoadSelectedVerifiableMemoryQuadsOptions,
  type NonEmptyGraphList,
  type SharedMemoryReadSelection,
  type SwmKaGraphBound,
  type SwmSliceSourceTags,
} from './graph-manager.js';
export { PrivateContentStore } from './private-store.js';

// Side-effect: register built-in adapters
import './adapters/oxigraph.js';
import './adapters/blazegraph.js';
import './adapters/sparql-http.js';
