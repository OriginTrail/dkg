/**
 * Thin HTTP client for the DKG daemon API (localhost:9200 by default).
 *
 * All adapter modules (channel, memory) use this client instead of
 * embedding a second DKGAgent. The daemon owns the agent, triple store,
 * and Node UI.
 */

import { loadAuthTokenSync } from '@origintrail-official/dkg-core';

export interface DkgClientOptions {
  /** Base URL of the DKG daemon (default: "http://127.0.0.1:9200"). */
  baseUrl?: string;
  /** Bearer token for daemon API auth. If omitted, tries ~/.dkg/auth.token. */
  apiToken?: string;
  /** Request timeout in ms (default: 30 000). */
  timeoutMs?: number;
}

export interface OpenClawAttachmentRef {
  assertionUri: string;
  fileHash: string;
  contextGraphId: string;
  fileName: string;
  detectedContentType?: string;
  extractionStatus?: 'completed';
  tripleCount?: number;
  rootEntity?: string;
}

export interface LocalAgentIntegrationCapabilities {
  localChat?: boolean;
  connectFromUi?: boolean;
  installNode?: boolean;
  dkgPrimaryMemory?: boolean;
  wmImportPipeline?: boolean;
  nodeServedSkill?: boolean;
  chatAttachments?: boolean;
}

export interface LocalAgentIntegrationTransport {
  kind?: string;
  bridgeUrl?: string;
  gatewayUrl?: string;
  healthUrl?: string;
}

export interface LocalAgentIntegrationManifest {
  packageName?: string;
  version?: string;
  setupEntry?: string;
}

export interface LocalAgentIntegrationRuntime {
  status?: 'disconnected' | 'configured' | 'connecting' | 'ready' | 'degraded' | 'error';
  ready?: boolean;
  lastError?: string | null;
  updatedAt?: string;
}

export interface LocalAgentIntegrationPayload {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  transport?: LocalAgentIntegrationTransport;
  capabilities?: LocalAgentIntegrationCapabilities;
  manifest?: LocalAgentIntegrationManifest;
  setupEntry?: string;
  metadata?: Record<string, unknown>;
  runtime?: LocalAgentIntegrationRuntime;
}

export interface LocalAgentIntegrationRecord extends LocalAgentIntegrationPayload {
  status?: string;
  connectedAt?: string;
  updatedAt?: string;
}

export interface SemanticEnrichmentDescriptor {
  eventId: string;
  status: 'pending' | 'leased' | 'completed' | 'dead_letter';
  semanticTripleCount: number;
  updatedAt: string;
  lastError?: string;
}

export interface SemanticTripleInput {
  subject: string;
  predicate: string;
  object: string;
}

export interface ChatTurnSemanticEventPayload {
  kind: 'chat_turn';
  sessionId: string;
  turnId: string;
  contextGraphId: string;
  assertionName: string;
  assertionUri: string;
  sessionUri: string;
  turnUri: string;
  userMessage: string;
  assistantReply: string;
  attachmentRefs?: OpenClawAttachmentRef[];
  persistenceState: 'stored' | 'failed' | 'pending';
  failureReason?: string;
  projectContextGraphId?: string;
}

export interface FileImportSemanticEventPayload {
  kind: 'file_import';
  contextGraphId: string;
  assertionName: string;
  assertionUri: string;
  rootEntity?: string;
  fileHash: string;
  mdIntermediateHash?: string;
  detectedContentType: string;
  sourceFileName?: string;
  ontologyRef?: string;
  projectContextGraphId?: string;
}

export type SemanticEnrichmentEventPayload =
  | ChatTurnSemanticEventPayload
  | FileImportSemanticEventPayload;

export interface SemanticEnrichmentEventLease {
  id: string;
  kind: 'chat_turn' | 'file_import';
  payload: SemanticEnrichmentEventPayload;
  status: 'leased';
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  nextAttemptAt?: number;
  lastError?: string;
}

export class DkgDaemonClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiToken: string | undefined;

  constructor(opts?: DkgClientOptions) {
    this.baseUrl = stripTrailingSlashes(opts?.baseUrl ?? 'http://127.0.0.1:9200');
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
    this.apiToken = opts?.apiToken ?? DkgDaemonClient.loadTokenFromFile();
  }

  private static loadTokenFromFile(): string | undefined {
    return loadAuthTokenSync();
  }

  private authHeaders(): Record<string, string> {
    if (!this.apiToken) return {};
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  getAuthToken(): string | undefined {
    return this.apiToken;
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<{ ok: boolean; peerId?: string; error?: string }> {
    try {
      const data = await this.get<Record<string, unknown>>('/api/status');
      return { ok: true, peerId: data.peerId as string | undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // SPARQL query
  // ---------------------------------------------------------------------------

  /**
   * Run a SPARQL query against the daemon. Forwards the full V10 field set
   * the `/api/query` route accepts — `view` (`'working-memory' | 'shared-working-memory' | 'verified-memory'`),
   * `agentAddress` (required for WM reads), `assertionName` (scopes WM reads
   * to a single per-agent assertion), `subGraphName`, `verifiedGraph`,
   * `graphSuffix`, `includeSharedMemory`.
   */
  async query(
    sparql: string,
    opts?: {
      contextGraphId?: string;
      graphSuffix?: string;
      includeSharedMemory?: boolean;
      view?: 'working-memory' | 'shared-working-memory' | 'verified-memory';
      agentAddress?: string;
      assertionName?: string;
      subGraphName?: string;
      verifiedGraph?: string;
    },
  ): Promise<any> {
    return this.post('/api/query', {
      sparql,
      contextGraphId: opts?.contextGraphId,
      graphSuffix: opts?.graphSuffix,
      includeSharedMemory: opts?.includeSharedMemory,
      view: opts?.view,
      agentAddress: opts?.agentAddress,
      assertionName: opts?.assertionName,
      subGraphName: opts?.subGraphName,
      verifiedGraph: opts?.verifiedGraph,
    });
  }

  // ---------------------------------------------------------------------------
  // Shared memory write (SWM layer — NOT used by v1 chat-turn / memory paths)
  // ---------------------------------------------------------------------------

  /**
   * Write quads to a context graph's Shared Working Memory graph. Retained
   * as a general primitive for callers that deliberately want SWM semantics
   * (e.g. user-initiated promotion). v1 chat-turn and per-project memory
   * writes use `writeAssertion` instead — SWM is the wrong layer for private
   * per-agent memory per `21_TRI_MODAL_MEMORY.md §5`.
   */
  async share(
    contextGraphId: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    opts?: { localOnly?: boolean; subGraphName?: string },
  ): Promise<{ shareOperationId: string }> {
    return this.post('/api/shared-memory/write', {
      contextGraphId,
      quads,
      localOnly: opts?.localOnly ?? true,
      subGraphName: opts?.subGraphName,
    });
  }

  // ---------------------------------------------------------------------------
  // Working Memory — assertion lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create a per-agent Working Memory assertion graph inside a context graph.
   * Idempotent on the client side: 400 `"already exists"` errors from the
   * daemon are swallowed and returned as `{ assertionUri: null, alreadyExists: true }`.
   * Any other error surfaces normally.
   */
  async createAssertion(
    contextGraphId: string,
    name: string,
    opts?: { subGraphName?: string },
  ): Promise<{ assertionUri: string | null; alreadyExists: boolean }> {
    try {
      const response = await this.post<{ assertionUri: string }>(
        '/api/assertion/create',
        { contextGraphId, name, subGraphName: opts?.subGraphName },
      );
      return { assertionUri: response.assertionUri, alreadyExists: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        return { assertionUri: null, alreadyExists: true };
      }
      throw err;
    }
  }

  /**
   * Append quads into an existing Working Memory assertion. The assertion
   * must have been created first — callers that create-then-write in a
   * single call should use `ensureAssertion` + `writeAssertion` together,
   * with `createAssertion` swallowing duplicates.
   */
  async writeAssertion(
    contextGraphId: string,
    name: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    opts?: { subGraphName?: string },
  ): Promise<{ written: number }> {
    return this.post(`/api/assertion/${encodeURIComponent(name)}/write`, {
      contextGraphId,
      quads,
      subGraphName: opts?.subGraphName,
    });
  }

  // ---------------------------------------------------------------------------
  // Chat turn persistence  (reuses the existing ChatMemoryManager pathway)
  // ---------------------------------------------------------------------------

  /**
   * Persist a chat turn through the daemon's `/api/openclaw-channel/persist-turn`
   * route, which delegates to `ChatMemoryManager.storeChatExchange`. As of
   * v1 of the openclaw-dkg-primary-memory work the downstream writer targets
   * the `'chat-turns'` Working Memory assertion of the `'agent-context'`
   * context graph via `agent.assertion.write`, not `agent.share`.
   */
  async storeChatTurn(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
    opts?: {
      turnId?: string;
      toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
      attachmentRefs?: OpenClawAttachmentRef[];
      persistenceState?: 'stored' | 'failed' | 'pending';
      failureReason?: string | null;
      projectContextGraphId?: string;
    },
  ): Promise<{ ok: boolean; turnId?: string; semanticEnrichment?: SemanticEnrichmentDescriptor }> {
    return this.post('/api/openclaw-channel/persist-turn', {
      sessionId,
      userMessage,
      assistantReply,
      turnId: opts?.turnId,
      toolCalls: opts?.toolCalls,
      attachmentRefs: opts?.attachmentRefs,
      persistenceState: opts?.persistenceState,
      failureReason: opts?.failureReason,
      projectContextGraphId: opts?.projectContextGraphId,
    });
  }

  async claimSemanticEnrichmentEvent(leaseOwner: string): Promise<{ event: SemanticEnrichmentEventLease | null }> {
    return this.post('/api/semantic-enrichment/events/claim', { leaseOwner });
  }

  async renewSemanticEnrichmentEvent(eventId: string, leaseOwner: string): Promise<{ renewed: boolean }> {
    return this.post('/api/semantic-enrichment/events/renew', { eventId, leaseOwner });
  }

  async appendSemanticEnrichmentEvent(
    eventId: string,
    leaseOwner: string,
    triples: SemanticTripleInput[],
  ): Promise<{
    applied: boolean;
    alreadyApplied?: boolean;
    completed: boolean;
    semanticEnrichment: SemanticEnrichmentDescriptor;
  }> {
    return this.post('/api/semantic-enrichment/events/append', {
      eventId,
      leaseOwner,
      triples,
    });
  }

  async completeSemanticEnrichmentEvent(
    eventId: string,
    leaseOwner: string,
    semanticTripleCount = 0,
  ): Promise<{ completed: boolean; semanticEnrichment?: SemanticEnrichmentDescriptor }> {
    return this.post('/api/semantic-enrichment/events/complete', {
      eventId,
      leaseOwner,
      semanticTripleCount,
    });
  }

  async failSemanticEnrichmentEvent(
    eventId: string,
    leaseOwner: string,
    error: string,
  ): Promise<{ status: 'pending' | 'dead_letter' | null; semanticEnrichment?: SemanticEnrichmentDescriptor }> {
    return this.post('/api/semantic-enrichment/events/fail', {
      eventId,
      leaseOwner,
      error,
    });
  }

  async fetchFileText(hash: string, contentType?: string): Promise<string> {
    const normalizedHash = hash.startsWith('sha256:') || hash.startsWith('keccak256:')
      ? hash
      : `sha256:${hash}`;
    const suffix = contentType ? `?contentType=${encodeURIComponent(contentType)}` : '';
    return this.getText(`/api/file/${encodeURIComponent(normalizedHash)}${suffix}`);
  }

  // ---------------------------------------------------------------------------
  // Memory stats
  // ---------------------------------------------------------------------------

  async getMemoryStats(): Promise<{ initialized: boolean; messageCount: number; totalTriples: number }> {
    return this.get('/api/memory/stats');
  }

  // ---------------------------------------------------------------------------
  // Node status (full)
  // ---------------------------------------------------------------------------

  async getFullStatus(): Promise<Record<string, unknown>> {
    return this.get('/api/status');
  }

  // ---------------------------------------------------------------------------
  // Local agent integration registration
  // ---------------------------------------------------------------------------

  async registerAdapter(id: string): Promise<void> {
    await this.connectLocalAgentIntegration({ id });
  }

  async connectLocalAgentIntegration(payload: LocalAgentIntegrationPayload): Promise<Record<string, unknown>> {
    return this.post('/api/local-agent-integrations/connect', payload);
  }

  async getLocalAgentIntegration(id: string): Promise<LocalAgentIntegrationRecord | null> {
    try {
      const response = await this.get<{ integration?: LocalAgentIntegrationRecord }>(
        `/api/local-agent-integrations/${encodeURIComponent(id)}`,
      );
      return response.integration ?? null;
    } catch (err) {
      if (err instanceof Error && err.message.includes('responded 404')) {
        return null;
      }
      throw err;
    }
  }

  async updateLocalAgentIntegration(
    id: string,
    payload: Omit<LocalAgentIntegrationPayload, 'id'>,
  ): Promise<Record<string, unknown>> {
    return this.put(`/api/local-agent-integrations/${encodeURIComponent(id)}`, payload);
  }

  // ---------------------------------------------------------------------------
  // Agents & skills discovery
  // ---------------------------------------------------------------------------

  async getAgents(filter?: { framework?: string; skill_type?: string }): Promise<{ agents: any[] }> {
    const params = new URLSearchParams();
    if (filter?.framework) params.set('framework', filter.framework);
    if (filter?.skill_type) params.set('skill_type', filter.skill_type);
    const qs = params.toString();
    return this.get(`/api/agents${qs ? `?${qs}` : ''}`);
  }

  async getSkills(filter?: { skillType?: string }): Promise<{ skills: any[] }> {
    const params = new URLSearchParams();
    if (filter?.skillType) params.set('skillType', filter.skillType);
    const qs = params.toString();
    return this.get(`/api/skills${qs ? `?${qs}` : ''}`);
  }

  // ---------------------------------------------------------------------------
  // P2P messaging
  // ---------------------------------------------------------------------------

  async sendChat(to: string, text: string): Promise<any> {
    return this.post('/api/chat', { to, text });
  }

  async getMessages(opts?: { peer?: string; limit?: number; since?: number }): Promise<{ messages: any[] }> {
    const params = new URLSearchParams();
    if (opts?.peer) params.set('peer', opts.peer);
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.since != null) params.set('since', String(opts.since));
    const qs = params.toString();
    return this.get(`/api/messages${qs ? `?${qs}` : ''}`);
  }

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------

  async publish(
    contextGraphId: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    privateQuads?: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    opts?: { accessPolicy?: 'public' | 'ownerOnly' | 'allowList'; allowedPeers?: string[] },
  ): Promise<any> {
    if (privateQuads?.length || opts?.accessPolicy || opts?.allowedPeers?.length) {
      throw new Error(
        'privateQuads, accessPolicy, and allowedPeers are not supported in V10 SWM-first publish',
      );
    }
    await this.post('/api/shared-memory/write', { contextGraphId, quads });
    return this.post('/api/shared-memory/publish', {
      contextGraphId,
      selection: 'all',
      clearAfter: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Context Graphs
  // ---------------------------------------------------------------------------

  async listContextGraphs(): Promise<{ contextGraphs: any[] }> {
    return this.get('/api/context-graph/list');
  }

  async createContextGraph(
    id: string,
    name: string,
    description?: string,
  ): Promise<{ created: string; uri: string }> {
    return this.post('/api/context-graph/create', { id, name, description });
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  async subscribe(
    contextGraphId: string,
    opts?: { includeSharedMemory?: boolean },
  ): Promise<{ subscribed: string; catchup: { jobId: string; status: string; includeSharedMemory: boolean } }> {
    return this.post('/api/subscribe', {
      contextGraphId,
      includeSharedMemory: opts?.includeSharedMemory,
    });
  }

  // ---------------------------------------------------------------------------
  // Wallet balances
  // ---------------------------------------------------------------------------

  async getWalletBalances(): Promise<{
    wallets: string[];
    balances: Array<{ address: string; eth: string; trac: string; symbol: string }>;
    chainId: string | null;
    rpcUrl: string | null;
    error?: string;
  }> {
    return this.get('/api/wallets/balances');
  }

  // ---------------------------------------------------------------------------
  // Skill invocation
  // ---------------------------------------------------------------------------

  async invokeSkill(peerId: string, skillUri: string, input?: string): Promise<any> {
    return this.post('/api/invoke-skill', { peerId, skillUri, input });
  }

  // ---------------------------------------------------------------------------
  // Wallets
  // ---------------------------------------------------------------------------

  async getWallets(): Promise<{ wallets: string[] }> {
    return this.get('/api/wallets');
  }

  // ---------------------------------------------------------------------------
  // HTTP primitives
  // ---------------------------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json', ...this.authHeaders() },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DKG daemon ${path} responded ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async getText(path: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DKG daemon ${path} responded ${res.status}: ${body}`);
    }
    return res.text();
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DKG daemon ${path} responded ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DKG daemon ${path} responded ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}
