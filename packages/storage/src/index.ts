export {
  type Quad,
  type TripleStore,
  type QueryResult,
  type QueryOptions,
  type SelectResult,
  type ConstructResult,
  type AskResult,
  type TripleStoreConfig,
  type TripleStoreBackend,
  type TripleStoreQueryOptions,
  type LargeLiteralStorageConfig,
  registerTripleStoreAdapter,
  createTripleStore,
  isExternalBackend,
  getSparqlEndpoint,
  type SparqlEndpoint,
} from './triple-store.js';
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

export { OxigraphStore } from './adapters/oxigraph.js';
export { OxigraphWorkerStore } from './adapters/oxigraph-worker.js';
export { BlazegraphStore } from './adapters/blazegraph.js';
export {
  SparqlHttpStore,
  type SparqlHttpStoreOptions,
  type SparqlHttpQueryOptions,
  type SparqlHttpSlowQueryEvent,
} from './adapters/sparql-http.js';
export { ContextGraphManager, GraphManager } from './graph-manager.js';
export { PrivateContentStore } from './private-store.js';

// Side-effect: register built-in adapters
import './adapters/oxigraph.js';
import './adapters/oxigraph-worker.js';
import './adapters/blazegraph.js';
import './adapters/sparql-http.js';
