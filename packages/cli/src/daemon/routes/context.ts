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
import type { ExtractionPipelineRegistry, RequestPrincipal } from '@origintrail-official/dkg-core';
import type {
  ChatMemoryManager,
  DashboardDB,
  OperationTracker,
} from '@origintrail-official/dkg-node-ui';
import type {
  DkgConfig,
  ResolvedRfc64CatalogActivationConfig,
  ResolvedRfc64PublicCatalogActivationConfig,
  loadNetworkConfig,
} from '../../config.js';
import type { VmPublisherControl } from '@origintrail-official/dkg-publisher';
import type { PublisherState } from '../../publisher-runner.js';
import type { ExtractionStatusRecord } from '../../extraction-status.js';
import type { FileStore } from '../../file-store.js';
import type { VectorStore, EmbeddingProvider } from '../../vector-store.js';
import type { CatchupTracker } from '../types.js';
import type { RoutePlugin } from '../plugin-api.js';
import type { AdmissionStatsView } from '../http-utils.js';
import type { DaemonLocalLlmService } from '../local-llm-service.js';

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

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  agent: DKGAgent;
  publisherControl: VmPublisherControl;
  /** Lifecycle-owned runtime and readiness as one correlated state. */
  publisherState: PublisherState;
  config: DkgConfig;
  /** Immutable RFC-64 activation resolved once during daemon startup. */
  rfc64Catalog?: ResolvedRfc64CatalogActivationConfig;
  /** Compatibility projection for the selected-public operator surface. */
  rfc64PublicCatalog: ResolvedRfc64PublicCatalogActivationConfig;
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
  /** Daemon-owned, read-only local LLM session used by the Node UI. */
  localLlm?: DaemonLocalLlmService;
  // Derived per-request (from req.url + headers + token). Routes read
  // `path`, `url`, `requestAgentAddress` extensively; pre-computing
  // here keeps every group on the same fast path.
  url: URL;
  path: string;
  requestToken: string | undefined;
  /** True only when the canonical auth boundary accepted a real credential. */
  requestCredentialAuthenticated: boolean;
  requestAgentAddress: string;
  requestPrincipal: RequestPrincipal;
  emitMemoryGraphChanged?: (event: MemoryGraphChangedEvent) => void;
  /** A5: broadcast a generic `notification` SSE refresh for the bell pane. */
  emitNotification?: (event: NotificationSseEvent) => void;
}
