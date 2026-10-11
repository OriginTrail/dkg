import type { StorePriorityScheduler } from '../store-priority-scheduler.js';
import type { SparqlHttpManagedRecoveryV1, SparqlHttpSlowQueryEvent } from './sparql-http.js';

export type SparqlHttpConsistencyProfile =
  | 'best-effort'
  | 'atomic-update'
  | 'atomic-readback';

export interface SparqlHttpStoreOptions {
  /** SPARQL query endpoint URL (required). */
  queryEndpoint: string;
  /** SPARQL update endpoint URL. Defaults to queryEndpoint if omitted (for stores that use one URL). */
  updateEndpoint?: string;
  /** Request timeout in ms. Default 30_000. */
  timeout?: number;
  /** Optional Authorization header value (e.g. "Bearer <token>" or "Basic <base64>"). */
  auth?: string;
  /**
   * Marker used by higher-level daemon flows to distinguish daemon-owned
   * endpoints from operator-provided URLs.
   *
   * Compatibility note: direct `new SparqlHttpStore({ managedByDkg: true })`
   * callers keep the legacy adapter-local `listGraphs()` cache. The
   * `createTripleStore({ backend: 'sparql-http', options: { managedByDkg: true } })`
   * path suppresses that adapter-local cache and wraps the store in
   * GraphSetIndexStore so managed daemon flows still have a single graph-list
   * index/revalidation owner.
   */
  managedByDkg?: boolean;
  /**
   * @deprecated Ignored. Retained only so old persisted configuration fails
   * closed instead of failing boot; it never grants managed guarantees.
   */
  managedOxigraph?: boolean;
  /**
   * Runtime-only managed-server recovery capability. Both operations must be
   * present; incomplete runtime configurations are treated as unavailable.
   */
  managedRecovery?: SparqlHttpManagedRecoveryV1;
  /**
   * Certified endpoint guarantees. `atomic-update` means a whole
   * multi-operation SPARQL Update is one transaction. `atomic-readback` adds
   * that a query issued after a completed update observes that update, as
   * required by receipt-bearing CAS. Daemon-owned Oxigraph endpoints imply
   * `atomic-readback`; all other endpoints default to `best-effort`.
   */
  consistencyProfile?: SparqlHttpConsistencyProfile;
  /**
   * @deprecated Use `consistencyProfile: 'atomic-update'` instead.
   *
   * This compatibility alias preserves the pre-profile public API. It grants
   * transactional update capability only; receipt-bearing CAS still requires
   * `atomic-readback` or a daemon-certified managed Oxigraph endpoint.
   */
  atomicUpdates?: boolean;
  /**
   * Opt-in native RDF staging for atomic graph + metadata publication.
   * Requires atomic-readback AND an update endpoint that synchronously accepts
   * named N-Quads via POST. Never inferred from a URL or managed-store marker.
   * Blazegraph requires its ASCII wire dialect to preserve Unicode values.
   * Empty, oversized, or backend-ambiguous payloads retain the SPARQL path.
   */
  bulkAtomicIngest?: { format: 'n-quads' | 'blazegraph-n-quads' };
  /** Emit sampled slow-query events after this duration. Default 10_000 ms; set 0 to disable. */
  slowQueryThresholdMs?: number;
  /** Sampling rate for slow-query events, from 0 to 1. Default 1. */
  slowQuerySampleRate?: number;
  /** Optional sink for sampled slow-query events; defaults to a compact console warning. */
  onSlowQuery?: (event: SparqlHttpSlowQueryEvent) => void;
  /** Optional scheduler injection for embedded callers and adapter-boundary tests. */
  scheduler?: StorePriorityScheduler;
  /**
   * Monotonic clock for slow-query telemetry. Graph-list revalidation clocks
   * are owned by GraphSetIndexStore.
   */
  now?: () => number;
}

