// daemon/routes/context.ts
//
// Per-request context bag passed to every route-group handler.
// Bundles the 24 parameters `handleRequest` used to take plus the 4
// derived locals (url, path, requestToken, requestAgentAddress) so
// route-group modules destructure exactly once on entry and route
// bodies can keep referring to bare names — identical to how they
// looked inside the monolithic `handleRequest`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DKGAgent, OpWalletsConfig } from '@origintrail-official/dkg-agent';
import type { ExtractionPipelineRegistry } from '@origintrail-official/dkg-core';
import type {
  ChatMemoryManager,
  DashboardDB,
  OperationTracker,
} from '@origintrail-official/dkg-node-ui';
import type { DkgConfig, loadNetworkConfig } from '../../config.js';
import type { AsyncPublisherAvailability, createPublisherControlFromStore, PublisherRuntime } from '../../publisher-runner.js';
import type { ExtractionStatusRecord } from '../../extraction-status.js';
import type { FileStore } from '../../file-store.js';
import type { VectorStore, EmbeddingProvider } from '../../vector-store.js';
import type { CatchupTracker } from '../types.js';
import type { RoutePlugin } from '../plugin-api.js';
import type { AdmissionStatsView } from '../http-utils.js';
import type { StoreRuntimeContext } from '../store-runtime.js';

export type MemoryGraphLayer = 'wm' | 'swm' | 'vm';

export interface MemoryGraphChangedEvent {
  contextGraphId: string;
  layers: MemoryGraphLayer[];
  subGraphName?: string;
  operation: string;
  source?: string;
  counts?: {
    triples?: number;
    roots?: number;
  };
  clearSharedMemoryAfter?: boolean;
  dataSynced?: unknown;
  sharedMemorySynced?: unknown;
  status?: string;
}

/**
 * Generic notifications-pane refresh signal (A5). Broadcast once per scoped
 * notification write (join_request/approved/rejected + assertion_activity) so
 * the bell pane re-fetches via a SINGLE SSE listener instead of one per type.
 * Payload is intentionally minimal — the client always re-reads the scoped
 * feed, so it only needs to know "something for this CG of kind X happened".
 */
export interface NotificationSseEvent {
  contextGraphId: string;
  type: string;
}

/**
 * Store views exposed to routes. The operator config is intentionally the only
 * config object in this shape, so a direct route harness cannot provide a
 * second, contradictory operator config through a nested store context.
 */
export interface RequestStoreContext {
  /** Operator config exactly as loaded from disk / CLI. */
  config: DkgConfig;
  /** Daemon-facing backend after defaults and acknowledged migrations. */
  effectiveStore: StoreRuntimeContext['effectiveStore'];
  /** Constructible live adapter config after managed-store materialization. */
  runtimeStore: StoreRuntimeContext['runtimeStore'];
}

export function createRequestStoreContext(storeRuntime: StoreRuntimeContext): RequestStoreContext {
  return {
    config: storeRuntime.operatorConfig,
    effectiveStore: storeRuntime.effectiveStore,
    runtimeStore: storeRuntime.runtimeStore,
  };
}

export interface RequestContext extends RequestStoreContext {
  req: IncomingMessage;
  res: ServerResponse;
  agent: DKGAgent;
  publisherControl: ReturnType<typeof createPublisherControlFromStore>;
  publisherRuntime: PublisherRuntime | null;
  /** Lifecycle-owned publisher state; optional for direct route embeddings/tests. */
  publisherAvailability?: AsyncPublisherAvailability;
  startedAt: number;
  dashDb: DashboardDB;
  opWallets: OpWalletsConfig;
  network: Awaited<ReturnType<typeof loadNetworkConfig>>;
  tracker: OperationTracker;
  memoryManager: ChatMemoryManager;
  bridgeAuthToken: string | undefined;
  nodeVersion: string;
  nodeCommit: string;
  catchupTracker: CatchupTracker;
  extractionRegistry: ExtractionPipelineRegistry;
  fileStore: FileStore;
  extractionStatus: Map<string, ExtractionStatusRecord>;
  assertionImportLocks: Map<string, Promise<void>>;
  vectorStore: VectorStore;
  embeddingProvider: EmbeddingProvider | null;
  validTokens: Set<string>;
  // API socket identity — trusted server-side state for manifestSelfClient
  // SSRF defence.
  apiHost: string;
  apiPortRef: { value: number };
  // Route plugins; dispatched by `handlePluginRoutes` before the trailing 404.
  routePlugins: RoutePlugin[];
  // Concurrency admission stats (read-only view); `/api/status` surfaces its
  // inFlight/max/rejectedTotal so operators can see whether the daemon is
  // shedding load. Deliberately the read-only `AdmissionStatsView`, not the
  // concrete limiter — plugin-facing routes must not reach tryAcquire()/release().
  admission: AdmissionStatsView;
  // Derived per-request (from req.url + headers + token). Routes read
  // `path`, `url`, `requestAgentAddress` extensively; pre-computing
  // here keeps every group on the same fast path.
  url: URL;
  path: string;
  requestToken: string | undefined;
  requestAgentAddress: string;
  emitMemoryGraphChanged?: (event: MemoryGraphChangedEvent) => void;
  /** A5: broadcast a generic `notification` SSE refresh for the bell pane. */
  emitNotification?: (event: NotificationSseEvent) => void;
}
