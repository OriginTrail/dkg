/**
 * Thin HTTP client for the DKG daemon API (localhost:9200 by default).
 *
 * All adapter modules (channel, memory, write-capture) use this client
 * instead of embedding a second DKGAgent.  The daemon owns the agent,
 * triple store, and Node UI.
 */

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
    this.baseUrl = (opts?.baseUrl ?? 'http://127.0.0.1:9200').replace(/\/+$/, '');
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
    this.apiToken = opts?.apiToken ?? DkgDaemonClient.loadTokenFromFile();
  }

  /** Try to read the default token file (~/.dkg/auth.token). */
  private static loadTokenFromFile(): string | undefined {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const tokenPath = path.join(os.homedir(), '.dkg', 'auth.token');
      const raw: string = fs.readFileSync(tokenPath, 'utf-8');
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
