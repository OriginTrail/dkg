import {
  readDaemonPid,
  isProcessAlive,
  readDkgApiPort,
  loadAuthToken,
} from '@origintrail-official/dkg-core';

export class DkgClient {
  private baseUrl: string;
  private token?: string;

  constructor(portOrBaseUrl: number | string, token?: string) {
    // PR #229 bot review round 10 (connection.ts:13). Until r10 the
    // constructor took only a port and hard-coded `http://127.0.0.1`.
    // `DKG_NODE_URL=https://remote.example:8443/api` silently
    // collapsed to `http://127.0.0.1:8443`, dropping the host, the
    // scheme, and the base path. Accept a full base URL string so
    // the caller can route to a remote daemon with HTTPS and a
    // non-root API prefix. The numeric-port form is preserved for
    // backwards compatibility (local daemons discovered via
    // `readDkgApiPort()`).
    if (typeof portOrBaseUrl === 'number') {
      this.baseUrl = `http://127.0.0.1:${portOrBaseUrl}`;
    } else {
      // Strip trailing slash so path concatenation stays clean:
      // base `http://host:p/api` + path `/status` → `http://host:p/api/status`.
      this.baseUrl = portOrBaseUrl.replace(/\/+$/, '');
    }
    this.token = token;
  }

  static async connect(): Promise<DkgClient> {
    const resolved = await resolveDaemonEndpoint({ requireReachable: true });
    return new DkgClient(resolved.baseOrPort, resolved.token);
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
 * protocol, or has no parseable port.
 *
 * PR #229 bot review round 10: prefer `normalizeBaseUrl` for new
 * call sites — this helper only returns the port and silently drops
 * host/scheme/path. Kept exported for regression-test coverage of
 * the pre-round-10 behavior.
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

/**
 * Resolved daemon endpoint information for consumers that need to
 * mirror `DkgClient.connect()`'s discovery path (notably
 * `mcp_auth status` / `mcp_auth whoami`).
 *
 * PR #229 bot review round 10 (mcp-server/index.ts:449). `mcp_auth`
 * used to resolve URL + credential from env vars only — so a normal
 * install with no env overrides reported `127.0.0.1:7777` with an
 * empty bearer and "auth broken" even though the tool channel could
 * still talk to the daemon through `readDkgApiPort()` +
 * `loadAuthToken()`. Using the SAME resolver for both surfaces
 * keeps the displayed state and the actual traffic consistent.
 */
export interface ResolvedDaemonEndpoint {
  /** What the DkgClient constructor should use (base URL or port). */
  readonly baseOrPort: string | number;
  /** Human-readable URL for display / logging. */
  readonly displayUrl: string;
  /** Resolved bearer token (may be empty string when unauthenticated). */
  readonly token: string;
  /** Where `token` came from — `'env'`, `'file'`, or `'none'`. */
  readonly tokenSource: 'env' | 'file' | 'none';
  /** Where `baseOrPort` came from — `'env'` or `'file'`. */
  readonly urlSource: 'env' | 'file';
}

export async function resolveDaemonEndpoint(options: {
  /**
   * When `true`, throws a diagnostic error if no daemon port can be
   * resolved (matches the legacy `DkgClient.connect()` behaviour).
   * `mcp_auth` callers pass `false` so they can still render a
   * useful "not running" status line instead of crashing the tool.
   */
  readonly requireReachable: boolean;
} = { requireReachable: true }): Promise<ResolvedDaemonEndpoint> {
  // PR #229 bot review round 9 (mcp-server/index.ts:441): `mcp_auth
  // set` mutates `process.env.DKG_NODE_TOKEN` and clears the cached
  // client so the NEXT invocation reconnects — but the reconnect
  // path used to read ONLY from the local auth-token file
  // (`loadAuthToken()`), silently ignoring the MCP-side override.
  // Prefer `DKG_NODE_TOKEN` when set (the mutable mcp_auth channel)
  // and fall back to the file-derived token otherwise.
  const envToken = (process.env.DKG_NODE_TOKEN ?? '').trim();
  const envUrl = (process.env.DKG_NODE_URL ?? '').trim();
  const envBaseUrl = normalizeBaseUrl(envUrl);

  let baseOrPort: string | number;
  let displayUrl: string;
  let urlSource: 'env' | 'file';

  if (envBaseUrl !== undefined) {
    baseOrPort = envBaseUrl;
    displayUrl = envBaseUrl;
    urlSource = 'env';
  } else {
    const port = await readDkgApiPort();
    if (!port) {
      if (options.requireReachable) {
        const pid = await readDaemonPid();
        if (!pid || !isProcessAlive(pid)) {
          throw new Error('DKG daemon is not running. Start it with: dkg start');
        }
        throw new Error('Cannot read API port. Set DKG_API_PORT or restart: dkg stop && dkg start');
      }
      // Best-effort fallback for display so `mcp_auth status` can
      // still render something useful when the daemon is not up.
      return {
        baseOrPort: 7777,
        displayUrl: 'http://127.0.0.1:7777 (daemon not running)',
        token: envToken,
        tokenSource: envToken ? 'env' : 'none',
        urlSource: 'file',
      };
    }
    baseOrPort = port;
    displayUrl = `http://127.0.0.1:${port}`;
    urlSource = 'file';
  }

  let token = envToken;
  let tokenSource: 'env' | 'file' | 'none' = envToken ? 'env' : 'none';
  if (!token) {
    const fileToken = (await loadAuthToken()) ?? '';
    if (fileToken) {
      token = fileToken;
      tokenSource = 'file';
    }
  }

  return { baseOrPort, displayUrl, token, tokenSource, urlSource };
}

/**
 * Parse a `DKG_NODE_URL` override into a normalized base URL
 * (scheme + host + explicit port + base path, no trailing slash).
 * Returns `undefined` when the URL is unset, malformed, uses a
 * non-http(s) scheme, or resolves to an unusable port — callers
 * then fall back to the file-derived local port.
 *
 * Unlike {@link extractPortFromUrl} this preserves the host, the
 * scheme, and the base path so an override like
 * `https://remote.example:8443/api` routes correctly instead of
 * silently collapsing to plaintext `http://127.0.0.1:8443`.
 * (PR #229 bot review round 10.)
 */
export function normalizeBaseUrl(raw: string): string | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const explicitPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!Number.isFinite(explicitPort) || explicitPort <= 0 || explicitPort > 65535) return undefined;
  if (!u.hostname) return undefined;

  // Preserve the explicit host:port even when the port is the
  // protocol default — keeping the shape deterministic makes logs
  // and test assertions easier to reason about.
  const hostPart = u.port
    ? `${u.hostname}:${u.port}`
    : `${u.hostname}:${explicitPort}`;

  // Strip trailing slashes from the pathname so concatenation is
  // clean: `/api/` + `/status` -> `/api/status`. An empty path maps
  // to "" (not "/") because DkgClient paths start with `/`.
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${hostPart}${path}`;
}
