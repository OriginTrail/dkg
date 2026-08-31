// daemon/routes/context.ts
//
// Per-request context bag passed to every route-group handler.
// Bundles the 24 parameters `handleRequest` used to take plus the 4
// derived locals (url, path, authentication, requestAgentAddress) so
// route-group modules destructure exactly once on entry and route
// bodies can keep referring to bare names — identical to how they
// looked inside the monolithic `handleRequest`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DKGAgent, OpWalletsConfig } from '@origintrail-official/dkg-agent';
import type { ExtractionPipelineRegistry } from '@origintrail-official/dkg-core';
import {
  authenticatedAgentAddress,
  type AllowedHttpAuthentication,
} from '../../auth.js';
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
import type { ConfiguredSemanticRuntimeService } from '../../semantic-runtime.js';

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

declare const REQUEST_ACTOR_BRAND: unique symbol;
declare const REQUEST_CONTEXT_BRAND: unique symbol;

/**
 * The identity and authority used by one routed request. Constructed once by `handleRequest` so
 * routes cannot combine authentication from one credential with an operational identity derived
 * from another.
 */
export interface RequestActor {
  readonly [REQUEST_ACTOR_BRAND]: true;
  readonly authentication: AllowedHttpAuthentication;
  readonly authenticatedAgentAddress: string | undefined;
  readonly effectiveAgentAddress: string;
}

export function createRequestActor(
  authentication: AllowedHttpAuthentication,
  resolveEffectiveAgentAddress: (acceptedToken: string | undefined) => string,
): RequestActor {
  const agentAddress = authenticatedAgentAddress(authentication);
  return Object.freeze({
    authentication,
    authenticatedAgentAddress: agentAddress,
    effectiveAgentAddress: agentAddress
      ?? resolveEffectiveAgentAddress(authentication.acceptedToken),
  }) as RequestActor;
}

/**
 * Compatibility boundary for isolated route-handler embedders created before `RequestActor`.
 * Real daemon requests always take the first branch. In the fallback, credential identity still
 * wins over the legacy effective-address projection, so contradictory agent authority cannot be
 * assembled even by an untyped older caller.
 */
export function actorFromRequestContext(ctx: RequestContext): RequestActor {
  const actor = (ctx as RequestContext & { actor?: RequestActor }).actor;
  return actor ?? createRequestActor(
    ctx.authentication,
    () => ctx.requestAgentAddress,
  );
}

export interface RequestContext {
  /** Opaque: daemon request contexts are assembled only by the dispatch boundary. */
  readonly [REQUEST_CONTEXT_BRAND]: true;
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
  /** Opt-in WASM semantic runtime owned by the daemon lifecycle. */
  semanticRuntimeHost?: ConfiguredSemanticRuntimeService | null;
  // Derived per-request. The correlated authentication decision is carried unchanged; identity
  // and capabilities are pure projections from it rather than separately mutable context fields.
  url: URL;
  path: string;
  actor: RequestActor;
  /** @deprecated Built-in routes should use `actor.authentication`. Runtime getter only. */
  readonly authentication: AllowedHttpAuthentication;
  /** @deprecated Built-in routes should use `actor.effectiveAgentAddress`. Runtime getter only. */
  readonly requestAgentAddress: string;
  emitMemoryGraphChanged?: (event: MemoryGraphChangedEvent) => void;
  /** A5: broadcast a generic `notification` SSE refresh for the bell pane. */
  emitNotification?: (event: NotificationSseEvent) => void;
}

/** Unbranded input fields accepted only by the daemon's request-context factory. */
export type RequestContextInputFields = Omit<RequestContext, typeof REQUEST_CONTEXT_BRAND>;
