import type { QueryResult } from '../../api-client.js';

export const DEFAULT_REPEAT = 30;
export const DEFAULT_WARMUPS = 3;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_PAYLOAD_SIZE_BYTES = 1024;
export const DEFAULT_POLL_INTERVAL_MS = 1000;

export const OPERATIONS = ['syncPublish', 'asyncEnqueue', 'asyncCompletion', 'get'] as const;
export type BenchmarkOperation = (typeof OPERATIONS)[number];

export type OutputFormat = 'json' | 'ndjson';
export type FixtureName = 'generated' | 'minimal';
export type GetView = 'working-memory' | 'shared-working-memory' | 'verified-memory';

export interface BenchmarkConfig {
  contextGraphId: string;
  repeat: number;
  warmups: number;
  timeoutMs: number;
  payloadSizeBytes: number;
  fixture: FixtureName;
  outputFormat: OutputFormat;
  namespace: string;
  scope: string;
  authorityProofRef: string;
  pollIntervalMs: number;
  asyncSuccessStatuses: string[];
  getView: GetView;
  apiPort?: number;
  apiUrl?: string;
  authToken?: string;
}

export interface BenchmarkPayload {
  rootEntity: string;
  marker: string;
  quads: Array<{ subject: string; predicate: string; object: string; graph: string }>;
}

export interface OperationTiming {
  operation: BenchmarkOperation;
  iteration: number;
  warmup: boolean;
  success: boolean;
  durationMs: number;
  error?: string;
  context: Record<string, unknown>;
}

export interface OperationSummary {
  count: number;
  successCount: number;
  failureCount: number;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  medianMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface BenchmarkFailure {
  operation: BenchmarkOperation;
  iteration: number;
  error: string;
  context: Record<string, unknown>;
}

export interface BenchmarkResult {
  benchmark: 'publish-async-get';
  startedAt: string;
  finishedAt: string;
  config: Omit<BenchmarkConfig, 'authToken'>;
  operations: OperationTiming[];
  summaries: Record<BenchmarkOperation, OperationSummary>;
  failures: BenchmarkFailure[];
}

export interface BenchmarkClient {
  status(): Promise<unknown>;
  sharedMemoryWrite(
    contextGraphId: string,
    quads: BenchmarkPayload['quads'],
  ): Promise<{ shareOperationId?: string }>;
  publishFromSharedMemory(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    clearAfter?: boolean,
  ): Promise<{ kcId?: string; status?: string; kas?: Array<{ tokenId: string; rootEntity: string }> }>;
  publisherEnqueue(request: {
    contextGraphId: string;
    shareOperationId: string;
    roots: string[];
    namespace: string;
    scope: string;
    authorityProofRef: string;
    swmId?: string;
    transitionType?: 'CREATE' | 'MUTATE' | 'REVOKE';
    authorityType?: 'owner' | 'multisig' | 'quorum' | 'capability';
  }): Promise<{ jobId?: string }>;
  publisherJob(jobId: string): Promise<{ job: { status?: string; error?: string; lastError?: string } | null }>;
  query(
    sparql: string,
    contextGraphId?: string,
    opts?: { view?: BenchmarkConfig['getView'] },
  ): Promise<{ result: QueryResult }>;
}

export interface MeasuredOperation<T> {
  ok: boolean;
  value?: T;
  timing: OperationTiming;
}
