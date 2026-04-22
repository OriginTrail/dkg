import {
  readDaemonPid,
  isProcessAlive,
  readDkgApiPort,
  loadAuthToken,
} from '@origintrail-official/dkg-core';

export class DkgClient {
  private baseUrl: string;
  private token?: string;

  constructor(port: number, token?: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.token = token;
  }

  static async connect(): Promise<DkgClient> {
    // PR #229 bot review round 9 (mcp-server/index.ts:441): `mcp_auth
    // set` mutates `process.env.DKG_NODE_TOKEN` and clears the cached
    // client so the NEXT invocation reconnects — but the reconnect
    // path used to read ONLY from the local auth-token file
    // (`loadAuthToken()`), silently ignoring the MCP-side override.
    // A host that called `mcp_auth op=set` would see `mcp_auth status`
    // report the new credential while real `dkg_*` tool calls kept
    // using the stale file-derived token, so rotation was effectively
    // a no-op for tool traffic. Prefer `DKG_NODE_TOKEN` when set (the
    // mutable mcp_auth channel) and fall back to the file-derived
    // token otherwise, so both the status surface and the tool
    // traffic resolve to the same credential after `mcp_auth set`.
    const envToken = (process.env.DKG_NODE_TOKEN ?? '').trim();

    // Same rationale applies to the daemon endpoint: mcp_auth status
    // resolves `DKG_NODE_URL` for display, so honoring the same
    // override here keeps the displayed + used endpoint consistent
    // after a rotation. The URL must look like `http(s)://host:port`
    // and produce a parseable port; anything else falls back to the
    // standard file-derived port so a malformed env var never
    // silently misroutes tool traffic.
    const envUrl = (process.env.DKG_NODE_URL ?? '').trim();
    const envPort = extractPortFromUrl(envUrl);
    const port = envPort ?? (await readDkgApiPort());

    if (!port) {
      const pid = await readDaemonPid();
      if (!pid || !isProcessAlive(pid)) {
        throw new Error('DKG daemon is not running. Start it with: dkg start');
      }
      throw new Error('Cannot read API port. Set DKG_API_PORT or restart: dkg stop && dkg start');
    }

    const token = envToken.length > 0 ? envToken : await loadAuthToken();
    return new DkgClient(port, token);
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

  async status() {
    return this.get<{
      name: string;
      peerId: string;
      nodeRole?: string;
      networkId?: string;
      uptimeMs: number;
      connectedPeers: number;
      relayConnected: boolean;
      multiaddrs: string[];
    }>('/api/status');
  }

  async query(sparql: string, contextGraphId?: string) {
    return this.post<{ result: unknown }>('/api/query', { sparql, contextGraphId });
  }

  async publish(contextGraphId: string, quads: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>) {
    await this.post<any>('/api/shared-memory/write', { contextGraphId, quads });
    return this.post<{
      kcId: string;
      status: string;
      kas: Array<{ tokenId: string; rootEntity: string }>;
      txHash?: string;
    }>('/api/shared-memory/publish', { contextGraphId, selection: 'all', clearAfter: true });
  }

  async listContextGraphs() {
    return this.get<{
      contextGraphs: Array<{
        id: string; uri: string; name: string;
        description?: string; creator?: string;
        createdAt?: string; isSystem: boolean;
      }>;
    }>('/api/context-graph/list');
  }

  async createContextGraph(id: string, name: string, description?: string) {
    return this.post<{ created: string; uri: string }>(
      '/api/context-graph/create', { id, name, description },
    );
  }

  async agents() {
    return this.get<{
      agents: Array<{
        agentUri: string; name: string; peerId: string;
        framework?: string; nodeRole?: string;
      }>;
    }>('/api/agents');
  }

  async subscribe(contextGraphId: string) {
    return this.post<{ subscribed: string }>('/api/subscribe', { contextGraphId });
  }
}

/**
 * Extract the port from a `DKG_NODE_URL` env override. Returns
 * `undefined` if the URL is unset, malformed, uses a non-http(s)
 * protocol, or has no parseable port — the caller then falls back to
 * the file-derived port. Exported for test coverage from
 * `test/connection-env-override.test.ts`.
 * (PR #229 bot review round 9.)
 */
export function extractPortFromUrl(raw: string): number | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const explicit = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!Number.isFinite(explicit) || explicit <= 0 || explicit > 65535) return undefined;
    return explicit;
  } catch {
    return undefined;
  }
}
