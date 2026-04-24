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
import type { createPublisherControlFromStore } from '../../publisher-runner.js';
import type { ExtractionStatusRecord } from '../../extraction-status.js';
import type { FileStore } from '../../file-store.js';
import type { VectorStore, EmbeddingProvider } from '../../vector-store.js';
import type { CatchupTracker } from '../types.js';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  agent: DKGAgent;
  publisherControl: ReturnType<typeof createPublisherControlFromStore>;
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
  // Derived per-request (from req.url + headers + token). Routes read
  // `path`, `url`, `requestAgentAddress` extensively; pre-computing
  // here keeps every group on the same fast path.
  url: URL;
  path: string;
  requestToken: string | undefined;
  requestAgentAddress: string;
}
