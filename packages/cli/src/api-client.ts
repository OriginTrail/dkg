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

  async publish(paranetId: string, quads: Array<{
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
    return this.post('/api/publish', { paranetId, quads, privateQuads, ...options });
  }

  async workspaceWrite(paranetId: string, quads: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>): Promise<{
    workspaceOperationId: string;
    paranetId: string;
    graph: string;
    triplesWritten: number;
    skolemizedBlankNodes?: number;
  }> {
    return this.post('/api/workspace/write', { paranetId, quads });
  }

  async workspaceEnshrine(
    paranetId: string,
    selection: 'all' | { rootEntities: string[] } = 'all',
    clearAfter = true,
  ): Promise<{
    kcId: string;
    status: 'tentative' | 'confirmed';
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
  }> {
    return this.post('/api/workspace/enshrine', { paranetId, selection, clearAfter });
  }

  async workspaceRoots(paranetId: string, workspaceOperationId?: string): Promise<{
    operations: Array<{
      workspaceOperationId: string;
      publisherPeerId: string;
      publishedAt: string;
      roots: string[];
    }>;
  }> {
    const params = new URLSearchParams({ paranetId });
    if (workspaceOperationId) {
      params.set('workspaceOperationId', workspaceOperationId);
    }
    return this.get(`/api/workspace/roots?${params.toString()}`);
  }

  async publisherEnqueue(request: {
    workspaceId: string;
    workspaceOperationId: string;
    roots: string[];
    paranetId: string;
    namespace: string;
    scope: string;
    transitionType: 'CREATE' | 'MUTATE' | 'REVOKE';
    authority: { type: 'owner' | 'multisig' | 'quorum' | 'capability'; proofRef: string };
    priorVersion?: string;
  }): Promise<{ jobId: string }> {
    return this.post('/api/publisher/enqueue', request);
  }

  async publisherJobs(status?: string): Promise<{ jobs: any[] }> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const qs = params.toString();
    return this.get(`/api/publisher/jobs${qs ? `?${qs}` : ''}`);
  }

  async publisherJob(jobId: string): Promise<{ job: any }> {
    return this.get(`/api/publisher/job?id=${encodeURIComponent(jobId)}`);
  }

  async publisherJobPayload(jobId: string): Promise<any> {
    return this.get(`/api/publisher/job/payload?id=${encodeURIComponent(jobId)}`);
  }

  async query(sparql: string, paranetId?: string): Promise<{ result: QueryResult }> {
    return this.post('/api/query', { sparql, paranetId });
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

  async subscribe(paranetId: string, options?: { includeWorkspace?: boolean }): Promise<{
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
    return this.post('/api/subscribe', { paranetId, ...options });
  }

  async catchupStatus(paranetId: string): Promise<{
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
    return this.get(`/api/sync/catchup-status?paranetId=${encodeURIComponent(paranetId)}`);
  }

  async connect(multiaddr: string): Promise<{ connected: boolean }> {
    return this.post('/api/connect', { multiaddr });
  }

  async createParanet(id: string, name: string, description?: string): Promise<{
    created: string;
    uri: string;
  }> {
    return this.post('/api/paranet/create', { id, name, description });
  }

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
    return this.get('/api/paranet/list');
  }

  async paranetExists(id: string): Promise<{ id: string; exists: boolean }> {
    return this.get(`/api/paranet/exists?id=${encodeURIComponent(id)}`);
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
