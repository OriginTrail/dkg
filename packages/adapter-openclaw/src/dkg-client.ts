/**
 * Thin HTTP client for the DKG daemon API (localhost:9200 by default).
 *
 * All adapter modules (channel, memory, write-capture) use this client
 * instead of embedding a second DKGAgent.  The daemon owns the agent,
 * triple store, and Node UI.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DkgClientOptions {
  /** Base URL of the DKG daemon (default: "http://127.0.0.1:9200"). */
  baseUrl?: string;
  /** Bearer token for daemon API auth. If omitted, tries ~/.dkg/auth.token. */
  apiToken?: string;
  /** Request timeout in ms (default: 30 000). */
  timeoutMs?: number;
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

  /** Try to read the default token file ($DKG_HOME/auth.token or ~/.dkg/auth.token). */
  private static loadTokenFromFile(): string | undefined {
    try {
      const dkgHome = process.env.DKG_HOME ?? join(homedir(), '.dkg');
      const tokenPath = join(dkgHome, 'auth.token');
      const raw = readFileSync(tokenPath, 'utf-8');
      // Token file may have comments (lines starting with #) and blank lines
      const token = raw.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
      return token || undefined;
    } catch {
      return undefined;
    }
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
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // SPARQL query
  // ---------------------------------------------------------------------------

  async query(
    sparql: string,
    opts?: { paranetId?: string; graphSuffix?: string; includeWorkspace?: boolean },
  ): Promise<any> {
    return this.post('/api/query', {
      sparql,
      paranetId: opts?.paranetId,
      graphSuffix: opts?.graphSuffix,
      includeWorkspace: opts?.includeWorkspace,
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace write
  // ---------------------------------------------------------------------------

  async writeToWorkspace(
    paranetId: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    opts?: { localOnly?: boolean },
  ): Promise<{ workspaceOperationId: string }> {
    return this.post('/api/workspace/write', { paranetId, quads, localOnly: opts?.localOnly ?? true });
  }

  // ---------------------------------------------------------------------------
  // Memory import
  // ---------------------------------------------------------------------------

  async importMemories(
    text: string,
    source: string,
    opts?: { useLlm?: boolean },
  ): Promise<{ batchId: string; memoryCount: number; tripleCount: number }> {
    return this.post('/api/memory/import', { text, source, useLlm: opts?.useLlm ?? true });
  }

  // ---------------------------------------------------------------------------
  // Chat turn persistence  (reuses the existing ChatMemoryManager pathway)
  // ---------------------------------------------------------------------------

  /**
   * Persist a chat turn to the agent-memory graph via the daemon's
   * chat-assistant persistence pathway.  This writes the same triples
   * that the built-in Agent Hub chat produces.
   */
  async storeChatTurn(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
    opts?: { turnId?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }> },
  ): Promise<void> {
    await this.post('/api/openclaw-channel/persist-turn', {
      sessionId,
      userMessage,
      assistantReply,
      turnId: opts?.turnId,
      toolCalls: opts?.toolCalls,
    });
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
  // Adapter registration
  // ---------------------------------------------------------------------------

  async registerAdapter(id: string): Promise<void> {
    await this.post('/api/register-adapter', { id });
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
    paranetId: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    privateQuads?: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    opts?: { accessPolicy?: 'public' | 'ownerOnly' | 'allowList'; allowedPeers?: string[] },
  ): Promise<any> {
    return this.post('/api/publish', {
      paranetId,
      quads,
      privateQuads,
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
    });
  }

  // ---------------------------------------------------------------------------
  // Paranets
  // ---------------------------------------------------------------------------

  async listParanets(): Promise<{ paranets: any[] }> {
    return this.get('/api/paranet/list');
  }

  async createParanet(
    id: string,
    name: string,
    description?: string,
  ): Promise<{ created: string; uri: string }> {
    return this.post('/api/paranet/create', { id, name, description });
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  async subscribe(
    paranetId: string,
    opts?: { includeWorkspace?: boolean },
  ): Promise<{ subscribed: string; catchup: { jobId: string; status: string; includeWorkspace: boolean } }> {
    return this.post('/api/subscribe', {
      paranetId,
      includeWorkspace: opts?.includeWorkspace,
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
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}
