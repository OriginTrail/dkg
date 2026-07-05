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
import type { createPublisherControlFromStore, PublisherRuntime } from '../../publisher-runner.js';
import type { ExtractionStatusRecord } from '../../extraction-status.js';
import type { FileStore } from '../../file-store.js';
import type { VectorStore, EmbeddingProvider } from '../../vector-store.js';
import type { CatchupTracker } from '../types.js';
import type { RoutePlugin } from '../plugin-api.js';
import type { AdmissionStatsView } from '../http-utils.js';
import type { RequestAuthContext } from '../../auth.js';
import type { RouteRequestIdentity } from '../route-request-identity.js';

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
  publisherControl: ReturnType<typeof createPublisherControlFromStore>;
  publisherRuntime: PublisherRuntime | null;
  config: DkgConfig;
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
  // Derived per-request route identity. New route code should use
  // `requestIdentity` so all auth sources flow through one boundary.
  url: URL;
  path: string;
  requestIdentity: RouteRequestIdentity;
  // Compatibility aliases for route modules that still need token-backed
  // self-calls or node-admin checks. Keep these derived from
  // `requestIdentity`; do not treat them as independent auth models.
  requestAuth?: RequestAuthContext;
  requestToken: string | undefined;
  requestAgentAddress: string;
  emitMemoryGraphChanged?: (event: MemoryGraphChangedEvent) => void;
  /** A5: broadcast a generic `notification` SSE refresh for the bell pane. */
  emitNotification?: (event: NotificationSseEvent) => void;
}
