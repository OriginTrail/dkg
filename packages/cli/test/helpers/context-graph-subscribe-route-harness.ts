import { createServer, type Server } from 'node:http';
import type {
  CatchupJobResult,
  CatchupRunRequest,
} from '../../src/catchup-runner.js';
import { handleContextGraphRoutes } from '../../src/daemon/routes/context-graph.js';
import { handleQueryRoutes } from '../../src/daemon/routes/query.js';
import { daemonState } from '../../src/daemon/state.js';
import type { CatchupJob } from '../../src/daemon/types.js';
import { cleanEmptyResult } from './context-graph-catchup-fixtures.js';

type SyncMode = 'on-demand' | 'always-on';

export interface SubscribeRouteHarnessOptions {
  initial?: Record<string, unknown>;
  hasConfirmedMeta: boolean;
  hasConfirmedMetaAfterCatchup?: boolean;
  strictHasConfirmedMeta?: boolean;
  locallyCurated?: boolean;
  isPrivate?: boolean;
  allowedAgents?: string[];
  callerAddress?: string;
  readiness?: {
    version: number;
    durableVerified: boolean;
    sharedMemoryVerified: boolean;
    updatedAt?: number;
  };
  runner?: (
    request: CatchupRunRequest,
    callNumber: number,
  ) => Promise<CatchupJobResult> | CatchupJobResult;
}

export class ContextGraphSubscribeRouteHarness {
  readonly contextGraphId = `readiness-${Math.random().toString(36).slice(2, 8)}`;
  readonly state = new Map<string, Record<string, any>>();
  readonly patches: Array<Record<string, unknown>> = [];
  readonly runRequests: CatchupRunRequest[] = [];
  readonly subscribeCalls: Array<{
    id: string;
    options: { syncMode?: SyncMode } | undefined;
  }> = [];
  readonly metadataCheckOptions: Array<
    { rejectUnregisteredPlaceholder?: boolean } | undefined
  > = [];

  private readonly previousCatchupRunner = daemonState.catchupRunner;
  private readonly catchupTracker = {
    jobs: new Map<string, CatchupJob>(),
    latestByContextGraph: new Map<string, string>(),
    inFlightByContextGraph: new Map(),
  };
  private server: Server | undefined;
  private addressPort = 0;
  private runCallsValue = 0;
  private readinessValue:
    | {
        version: number;
        durableVerified: boolean;
        sharedMemoryVerified: boolean;
        updatedAt: number;
      }
    | undefined;

  private constructor(private readonly options: SubscribeRouteHarnessOptions) {
    if (options.initial) {
      this.state.set(this.contextGraphId, { ...options.initial });
    }
    this.readinessValue = options.readiness
      ? {
          ...options.readiness,
          updatedAt: options.readiness.updatedAt ?? Date.now(),
        }
      : undefined;
  }

  static async create(
    options: SubscribeRouteHarnessOptions,
  ): Promise<ContextGraphSubscribeRouteHarness> {
    const harness = new ContextGraphSubscribeRouteHarness(options);
    await harness.start();
    return harness;
  }

  get runCalls(): number {
    return this.runCallsValue;
  }

  get readiness(): Record<string, unknown> | undefined {
    return this.readinessValue;
  }

  async postSubscribe(input?: {
    includeSharedMemory?: boolean;
    syncMode?: unknown;
  }): Promise<{ status: number; body: any }> {
    const response = await fetch(
      `http://127.0.0.1:${this.addressPort}/api/context-graph/subscribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contextGraphId: this.contextGraphId,
          includeSharedMemory: input?.includeSharedMemory ?? true,
          ...(input?.syncMode !== undefined ? { syncMode: input.syncMode } : {}),
        }),
      },
    );
    return { status: response.status, body: await response.json() };
  }

  async waitForJob(jobId: string | undefined): Promise<CatchupJob | undefined> {
    if (!jobId) return undefined;
    for (let i = 0; i < 50; i += 1) {
      const job = this.catchupTracker.jobs.get(jobId);
      if (job?.finishedAt) return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.catchupTracker.jobs.get(jobId);
  }

  getJob(jobId: string | undefined): CatchupJob | undefined {
    return jobId ? this.catchupTracker.jobs.get(jobId) : undefined;
  }

  async getStatus(jobId: string): Promise<any> {
    return fetch(
      `http://127.0.0.1:${this.addressPort}/api/sync/catchup-status?jobId=${encodeURIComponent(jobId)}`,
    ).then((response) => response.json());
  }

  async getStatusByContextGraph(): Promise<any> {
    return fetch(
      `http://127.0.0.1:${this.addressPort}/api/sync/catchup-status?contextGraphId=${encodeURIComponent(this.contextGraphId)}`,
    ).then((response) => response.json());
  }

  setCompleteReadiness(updatedAt = Date.now()): void {
    this.readinessValue = {
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
      updatedAt,
    };
    this.state.set(this.contextGraphId, {
      ...this.state.get(this.contextGraphId),
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      pendingMeta: false,
    });
  }

  async close(): Promise<void> {
    daemonState.catchupRunner = this.previousCatchupRunner;
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async start(): Promise<void> {
    daemonState.catchupRunner = {
      run: async (request) => {
        this.runCallsValue += 1;
        this.runRequests.push(request);
        return this.options.runner?.(request, this.runCallsValue) ?? cleanEmptyResult();
      },
      close: async () => {},
    };

    const agent = {
      getContextGraphAllowedAgents: async () => this.options.allowedAgents ?? [],
      getSubscribedContextGraphs: () => this.state,
      subscribeToContextGraph: (
        id: string,
        options?: { syncMode?: SyncMode },
      ) => {
        this.subscribeCalls.push({ id, options });
        const previous = this.state.get(id);
        const effectiveSyncMode = previous?.subscribed && previous.syncMode === 'always-on'
          ? 'always-on'
          : options?.syncMode ?? previous?.syncMode ?? 'always-on';
        const applied = {
          ...previous,
          subscribed: true,
          synced: previous?.synced ?? false,
          syncMode: effectiveSyncMode,
        };
        this.state.set(id, applied);
        return applied;
      },
      markContextGraphSubscriptionState: (
        id: string,
        patch: Record<string, unknown>,
      ) => {
        this.patches.push({ ...patch });
        this.state.set(id, { ...this.state.get(id), ...patch });
      },
      hasConfirmedMetaState: async (
        _id: string,
        options?: { rejectUnregisteredPlaceholder?: boolean },
      ) => {
        this.metadataCheckOptions.push(options);
        if (
          options?.rejectUnregisteredPlaceholder === true &&
          this.options.strictHasConfirmedMeta !== undefined
        ) {
          return this.options.strictHasConfirmedMeta;
        }
        return this.runCallsValue > 0
          ? this.options.hasConfirmedMetaAfterCatchup ?? this.options.hasConfirmedMeta
          : this.options.hasConfirmedMeta;
      },
      isCuratorOf: async () => this.options.locallyCurated ?? false,
      isPrivateContextGraph: async () => this.options.isPrivate ?? false,
      resolveAgentByToken: () => undefined,
      getDefaultAgentAddress: () =>
        this.options.callerAddress ?? '0x0000000000000000000000000000000000000001',
    };

    this.server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const routeContext = {
        req: request,
        res: response,
        agent,
        publisherControl: {},
        publisherRuntime: null,
        config: { auth: { enabled: false } },
        startedAt: Date.now(),
        dashDb: {
          getContextGraphReadinessProvenance: () => this.readinessValue ?? null,
          setContextGraphReadinessProvenance: (
            _id: string,
            next: {
              version: number;
              durableVerified: boolean;
              sharedMemoryVerified: boolean;
            },
          ) => {
            this.readinessValue = { ...next, updatedAt: Date.now() };
          },
        },
        opWallets: {},
        network: {},
        tracker: {},
        memoryManager: {},
        bridgeAuthToken: undefined,
        nodeVersion: 'test',
        nodeCommit: 'test',
        catchupTracker: this.catchupTracker,
        extractionRegistry: {},
        fileStore: {},
        extractionStatus: new Map(),
        assertionImportLocks: new Map(),
        vectorStore: {},
        embeddingProvider: null,
        validTokens: new Set(),
        apiHost: '127.0.0.1',
        apiPortRef: { value: 0 },
        routePlugins: [],
        url,
        path: url.pathname,
        requestToken: undefined,
        requestAgentAddress: undefined,
      } as any;
      await handleContextGraphRoutes(routeContext);
      if (!response.writableEnded) await handleQueryRoutes(routeContext);
      if (!response.writableEnded) {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('route test server did not bind');
    }
    this.addressPort = address.port;
  }
}

export interface RunSubscribeScenarioOptions
  extends Omit<SubscribeRouteHarnessOptions, 'runner'> {
  result?: CatchupJobResult;
  includeSharedMemory?: boolean;
  syncMode?: unknown;
}

export async function runSubscribeScenario(
  options: RunSubscribeScenarioOptions,
): Promise<{
  response: any;
  responseStatus: number;
  job: CatchupJob | undefined;
  runCalls: number;
  runRequests: CatchupRunRequest[];
  subscribeCalls: ContextGraphSubscribeRouteHarness['subscribeCalls'];
  state: Record<string, any>;
  patches: Array<Record<string, unknown>>;
  readiness: Record<string, unknown> | undefined;
  statusResponse: any;
  metadataCheckOptions: ContextGraphSubscribeRouteHarness['metadataCheckOptions'];
}> {
  const harness = await ContextGraphSubscribeRouteHarness.create({
    ...options,
    runner: () => options.result ?? cleanEmptyResult(),
  });
  try {
    const posted = await harness.postSubscribe({
      includeSharedMemory: options.includeSharedMemory,
      syncMode: options.syncMode,
    });
    const jobId = posted.body.catchup?.jobId as string | undefined;
    const job = await harness.waitForJob(jobId);
    return {
      response: posted.body,
      responseStatus: posted.status,
      job,
      runCalls: harness.runCalls,
      runRequests: [...harness.runRequests],
      subscribeCalls: [...harness.subscribeCalls],
      state: harness.state.get(harness.contextGraphId) ?? {},
      patches: [...harness.patches],
      readiness: harness.readiness,
      statusResponse: jobId ? await harness.getStatus(jobId) : null,
      metadataCheckOptions: [...harness.metadataCheckOptions],
    };
  } finally {
    await harness.close();
  }
}
