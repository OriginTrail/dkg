import { readApiPort, readPid, isProcessRunning } from './config.js';
import { loadTokens } from './auth.js';

export type QueryResult =
  | { type: 'bindings'; bindings: Array<Record<string, string>> }
  | { type: 'boolean'; value: boolean }
  | { type?: undefined; [key: string]: unknown };

export class ApiClient {
  private baseUrl: string;
  private token?: string;

  constructor(port: number, token?: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.token = token;
  }

  static async connect(): Promise<ApiClient> {
    const envPort = process.env.DKG_API_PORT
      ? parseInt(process.env.DKG_API_PORT, 10)
      : null;

    let port = envPort ?? (await readApiPort());

    if (!port) {
      const pid = await readPid();
      if (!pid || !isProcessRunning(pid)) {
        throw new Error('Daemon is not running. Start it with: dkg start');
      }
      throw new Error('Cannot read API port. Set DKG_API_PORT or restart: dkg stop && dkg start');
    }

    const tokens = await loadTokens();
    const token = tokens.size > 0 ? tokens.values().next().value : undefined;
    return new ApiClient(port, token);
  }

  async status(): Promise<{
    name: string;
    peerId: string;
    nodeRole?: string;
    networkId?: string;
    uptimeMs: number;
    connectedPeers: number;
    relayConnected: boolean;
    multiaddrs: string[];
  }> {
    return this.get('/api/status');
  }

  async agents(): Promise<{
    agents: Array<{ agentUri: string; name: string; peerId: string; framework?: string; nodeRole?: string }>;
  }> {
    return this.get('/api/agents');
  }

  async skills(): Promise<{
    skills: Array<{
      agentName: string; skillType: string;
      pricePerCall?: number; currency?: string;
    }>;
  }> {
    return this.get('/api/skills');
  }

  async sendChat(to: string, text: string): Promise<{ delivered: boolean; error?: string }> {
    return this.post('/api/chat', { to, text });
  }

  async messages(opts?: { peer?: string; since?: number; limit?: number }): Promise<{
    messages: Array<{
      ts: number; direction: 'in' | 'out';
      peer: string; peerName?: string; text: string;
    }>;
  }> {
    const params = new URLSearchParams();
    if (opts?.peer) params.set('peer', opts.peer);
    if (opts?.since) params.set('since', String(opts.since));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.get(`/api/messages${qs ? '?' + qs : ''}`);
  }

  async publish(contextGraphId: string, quads: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>, privateQuads?: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>, options?: {
    accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
    allowedPeers?: string[];
  }): Promise<{
    kcId: string;
    status: 'tentative' | 'confirmed';
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
    batchId?: string;
    publisherAddress?: string;
  }> {
    if (privateQuads?.length || options?.accessPolicy || options?.allowedPeers?.length) {
      throw new Error(
        'privateQuads, accessPolicy, and allowedPeers are not supported in the V10 SWM-first publish flow. ' +
        'Use sharedMemoryWrite() + publishFromSharedMemory() directly.',
      );
    }
    await this.sharedMemoryWrite(contextGraphId, quads);
    return this.publishFromSharedMemory(contextGraphId, 'all', true);
  }

  /** Write quads to shared memory (formerly workspace). */
  async sharedMemoryWrite(contextGraphId: string, quads: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>): Promise<{
    workspaceOperationId: string;
    paranetId: string;
    graph: string;
    triplesWritten: number;
    skolemizedBlankNodes?: number;
  }> {
    return this.post('/api/shared-memory/write', { paranetId: contextGraphId, quads });
  }

  /** @deprecated Use sharedMemoryWrite */
  async workspaceWrite(contextGraphId: string, quads: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>): Promise<{
    workspaceOperationId: string;
    paranetId: string;
    graph: string;
    triplesWritten: number;
    skolemizedBlankNodes?: number;
  }> {
    return this.sharedMemoryWrite(contextGraphId, quads);
  }

  /** Publish from shared memory (formerly enshrine from workspace). */
  async publishFromSharedMemory(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] } = 'all',
    clearAfter = true,
  ): Promise<{
    kcId: string;
    status: 'tentative' | 'confirmed';
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
  }> {
    return this.post('/api/shared-memory/publish', { paranetId: contextGraphId, selection, clearAfter });
  }

  /** @deprecated Use publishFromSharedMemory */
  async workspaceEnshrine(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] } = 'all',
    clearAfter = true,
  ): Promise<{
    kcId: string;
    status: 'tentative' | 'confirmed';
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
  }> {
    return this.publishFromSharedMemory(contextGraphId, selection, clearAfter);
  }

  async query(sparql: string, contextGraphId?: string): Promise<{ result: QueryResult }> {
    return this.post('/api/query', { sparql, paranetId: contextGraphId });
  }

  async queryRemote(peerId: string, request: {
    lookupType: string;
    paranetId?: string;
    ual?: string;
    entityUri?: string;
    rdfType?: string;
    sparql?: string;
    limit?: number;
    timeout?: number;
  }): Promise<{
    operationId: string;
    status: string;
    ntriples?: string;
    bindings?: string;
    entityUris?: string[];
    truncated: boolean;
    resultCount: number;
    gasConsumed?: number;
    error?: string;
  }> {
    return this.post('/api/query-remote', { peerId, ...request });
  }

  async subscribeToContextGraph(contextGraphId: string, options?: { includeSharedMemory?: boolean }): Promise<{
    subscribed: string;
    catchup?:
      | {
        connectedPeers: number;
        syncCapablePeers: number;
        peersTried: number;
        dataSynced: number;
        workspaceSynced: number;
      }
      | {
        status: 'queued';
        includeWorkspace: boolean;
        jobId: string;
      };
  }> {
    return this.post('/api/subscribe', { paranetId: contextGraphId, includeWorkspace: options?.includeSharedMemory });
  }

  /** @deprecated Use subscribeToContextGraph */
  async subscribe(contextGraphId: string, options?: { includeWorkspace?: boolean }): Promise<{
    subscribed: string;
    catchup?:
      | {
        connectedPeers: number;
        syncCapablePeers: number;
        peersTried: number;
        dataSynced: number;
        workspaceSynced: number;
      }
      | {
        status: 'queued';
        includeWorkspace: boolean;
        jobId: string;
      };
  }> {
    return this.subscribeToContextGraph(contextGraphId, { includeSharedMemory: options?.includeWorkspace });
  }

  async catchupStatus(contextGraphId: string): Promise<{
    jobId: string;
    paranetId: string;
    includeWorkspace: boolean;
    status: 'queued' | 'running' | 'done' | 'failed';
    queuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    result?: {
      connectedPeers: number;
      syncCapablePeers: number;
      peersTried: number;
      dataSynced: number;
      workspaceSynced: number;
    };
    error?: string;
  }> {
    return this.get(`/api/sync/catchup-status?paranetId=${encodeURIComponent(contextGraphId)}`);
  }

  async connect(multiaddr: string): Promise<{ connected: boolean }> {
    return this.post('/api/connect', { multiaddr });
  }

  async createContextGraph(id: string, name: string, description?: string): Promise<{
    created: string;
    uri: string;
  }> {
    return this.post('/api/context-graph/create', { id, name, description });
  }

  /** @deprecated Use createContextGraph */
  async createParanet(id: string, name: string, description?: string): Promise<{
    created: string;
    uri: string;
  }> {
    return this.createContextGraph(id, name, description);
  }

  async listContextGraphs(): Promise<{
    paranets: Array<{
      id: string;
      uri: string;
      name: string;
      description?: string;
      creator?: string;
      createdAt?: string;
      isSystem: boolean;
    }>;
  }> {
    return this.get('/api/context-graph/list');
  }

  /** @deprecated Use listContextGraphs */
  async listParanets(): Promise<{
    paranets: Array<{
      id: string;
      uri: string;
      name: string;
      description?: string;
      creator?: string;
      createdAt?: string;
      isSystem: boolean;
    }>;
  }> {
    return this.listContextGraphs();
  }

  async contextGraphExists(id: string): Promise<{ id: string; exists: boolean }> {
    return this.get(`/api/context-graph/exists?id=${encodeURIComponent(id)}`);
  }

  /** @deprecated Use contextGraphExists */
  async paranetExists(id: string): Promise<{ id: string; exists: boolean }> {
    return this.contextGraphExists(id);
  }

  async verify(request: {
    contextGraphId: string;
    verifiedMemoryId: string;
    batchId: string;
    timeoutMs?: number;
    requiredSignatures?: number;
  }): Promise<{ txHash: string; blockNumber: number; verifiedMemoryId: string; signers: string[] }> {
    return this.post('/api/verify', request);
  }

  async endorse(request: {
    contextGraphId: string;
    ual: string;
    agentAddress: string;
  }): Promise<{ endorsed: boolean; endorserAddress: string }> {
    return this.post('/api/endorse', request);
  }

  async publishCclPolicy(request: {
    paranetId: string;
    name: string;
    version: string;
    content: string;
    description?: string;
    contextType?: string;
    language?: string;
    format?: string;
  }): Promise<{ policyUri: string; hash: string; status: 'proposed' }> {
    return this.post('/api/ccl/policy/publish', request);
  }

  async approveCclPolicy(request: {
    paranetId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; approvedAt: string }> {
    return this.post('/api/ccl/policy/approve', request);
  }

  async revokeCclPolicy(request: {
    paranetId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; revokedAt: string; status: 'revoked' }> {
    return this.post('/api/ccl/policy/revoke', request);
  }

  async listCclPolicies(opts: {
    paranetId?: string;
    name?: string;
    contextType?: string;
    status?: string;
    includeBody?: boolean;
  } = {}): Promise<{ policies: any[] }> {
    const params = new URLSearchParams();
    if (opts.paranetId) params.set('paranetId', opts.paranetId);
    if (opts.name) params.set('name', opts.name);
    if (opts.contextType) params.set('contextType', opts.contextType);
    if (opts.status) params.set('status', opts.status);
    if (opts.includeBody) params.set('includeBody', 'true');
    const qs = params.toString();
    return this.get(`/api/ccl/policy/list${qs ? `?${qs}` : ''}`);
  }

  async resolveCclPolicy(opts: {
    paranetId: string;
    name: string;
    contextType?: string;
    includeBody?: boolean;
  }): Promise<{ policy: any | null }> {
    const params = new URLSearchParams({ paranetId: opts.paranetId, name: opts.name });
    if (opts.contextType) params.set('contextType', opts.contextType);
    if (opts.includeBody) params.set('includeBody', 'true');
    return this.get(`/api/ccl/policy/resolve?${params.toString()}`);
  }

  async evaluateCclPolicy(request: {
    paranetId: string;
    name: string;
    facts?: Array<[string, ...unknown[]]>;
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
    publishResult?: boolean;
  }): Promise<{
    policy: any;
    context: any;
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: 'manual' | 'snapshot-resolved';
    result: any;
  }> {
    return this.post('/api/ccl/eval', request);
  }

  async listCclEvaluations(opts: {
    paranetId: string;
    policyUri?: string;
    snapshotId?: string;
    view?: string;
    contextType?: string;
    resultKind?: 'derived' | 'decision';
    resultName?: string;
  }): Promise<{ evaluations: any[] }> {
    const params = new URLSearchParams({ paranetId: opts.paranetId });
    if (opts.policyUri) params.set('policyUri', opts.policyUri);
    if (opts.snapshotId) params.set('snapshotId', opts.snapshotId);
    if (opts.view) params.set('view', opts.view);
    if (opts.contextType) params.set('contextType', opts.contextType);
    if (opts.resultKind) params.set('resultKind', opts.resultKind);
    if (opts.resultName) params.set('resultName', opts.resultName);
    return this.get(`/api/ccl/results?${params.toString()}`);
  }

  async publisherEnqueue(request: Record<string, unknown>): Promise<{ jobId: string }> {
    return this.post('/api/publisher/enqueue', { request });
  }

  async publisherJobs(status?: string): Promise<{ jobs: any[] }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.get(`/api/publisher/jobs${qs}`);
  }

  async publisherJob(jobId: string): Promise<any> {
    return this.get(`/api/publisher/jobs/${encodeURIComponent(jobId)}`);
  }

  async publisherJobPayload(jobId: string): Promise<any> {
    return this.get(`/api/publisher/jobs/${encodeURIComponent(jobId)}/payload`);
  }

  async publisherStats(): Promise<Record<string, number>> {
    return this.get('/api/publisher/stats');
  }

  async shutdown(): Promise<void> {
    try {
      await this.post('/api/shutdown', {});
    } catch {
      // Connection may close before response
    }
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) return {};
    return { Authorization: `Bearer ${this.token}` };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as Record<string, unknown>).error as string ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((data as Record<string, unknown>).error as string ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }
}
