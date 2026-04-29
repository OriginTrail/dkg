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
    // Until r10 the
    // constructor took only a port and hard-coded `http://127.0.0.1`.
    // `DKG_NODE_URL=https://remote.example:8443/api` silently
    // collapsed to `http://127.0.0.1:8443`, dropping the host, the
    // scheme, and the base path. Accept a full base URL string so
    // the caller can route to a remote daemon with HTTPS and a
    // non-root API prefix. The numeric-port form is preserved for
    // backwards compatibility (local daemons discovered via
    // `readDkgApiPort()`).
    //
    // The
    // initial r10 implementation kept any pathname verbatim, so
    // `new DkgClient('https://host/dkg')` produced `.../dkg/api/status`
    // and `new DkgClient('https://host/api')` the double-prefixed
    // `.../api/api/status`. Every request helper hard-codes the
    // `/api/...` path (see `status`/`query`/`publish` below), matching
    // the daemon's fixed mount point. Enforce origin-only base URLs so
    // the two encodings stay in sync — the caller sees a clear error
    // instead of a mysterious 404. `normalizeBaseUrl` already
    // implements the canonical "origin + explicit :port" form we want;
    // route the string branch through it so DkgClient shares a single
    // invariant with `resolveDaemonEndpoint`.
    if (typeof portOrBaseUrl === 'number') {
      this.baseUrl = `http://127.0.0.1:${portOrBaseUrl}`;
    } else {
      const normalized = normalizeBaseUrl(portOrBaseUrl);
      if (!normalized) {
        throw new Error(
          `DkgClient: invalid or unsupported base URL: ${portOrBaseUrl}. ` +
            `Expected an origin-only URL like http(s)://host:port — a path ` +
            `segment (e.g. /api or /dkg) is NOT supported because per-request ` +
            `routes already hard-code /api/... . Strip any path (and trailing ` +
            `slash) before constructing the client.`,
        );
      }
      this.baseUrl = normalized;
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
 * prefer `normalizeBaseUrl` for new
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
 * `mcp_auth`
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
  /**
   * True when `resolveDaemonEndpoint({ requireReachable: false })`
   * returned a SYNTHETIC fallback because the daemon is not running
   * (no port file / dead pid). Callers must NOT probe the
   * `baseOrPort` in this state — it's a placeholder, and any
   * unrelated process happening to listen on `127.0.0.1:7777` would
   * otherwise make `mcp_auth status` lie about liveness.
   */
  readonly daemonDown?: boolean;
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
  // `mcp_auth
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
  } else if (envUrl) {
    // if the operator SET
    // `DKG_NODE_URL` but we couldn't normalize it (malformed URL,
    // non-http(s) scheme, reverse-proxy path prefix rejected by
    // r17-4, unusable port, missing hostname), the code
    // silently fell through to the local-daemon discovery path
    // below. That was the exact footgun r17-4 meant to close: an
    // operator who configured `DKG_NODE_URL=https://proxy/dkg`
    // ended up connecting to their LOCAL `127.0.0.1:<port>` daemon
    // and every request looked like it worked (wrong data,
    // inconsistent state) instead of surfacing the misconfiguration.
    //
    // Non-empty-but-unsupported `DKG_NODE_URL` is an explicit
    // operator intent; fail fast with a diagnostic that tells them
    // exactly what the resolver saw and how to fix it. Callers that
    // only want a display string (e.g. `mcp_auth status` with
    // `requireReachable: false`) still surface the error — silently
    // lying about the endpoint would be worse than crashing the UI.
    throw new Error(
      `DKG_NODE_URL is set to "${envUrl}" but cannot be used as a daemon endpoint: ` +
        `expected an origin-only http(s) URL with an explicit or default port and no path ` +
        `(e.g. "https://host.example" or "https://host.example:8443"). ` +
        `Reverse-proxy path prefixes are not supported — point DKG_NODE_URL at the ` +
        `daemon's bare origin or unset it to use the local daemon.`,
    );
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
      // flag the endpoint as `daemonDown` so callers skip
      // probing the synthetic 127.0.0.1:7777 placeholder — a probe
      // there could hit an unrelated service and falsely report OK.
      return {
        baseOrPort: 7777,
        displayUrl: 'http://127.0.0.1:7777 (daemon not running)',
        token: envToken,
        tokenSource: envToken ? 'env' : 'none',
        urlSource: 'file',
        daemonDown: true,
      };
    }
    baseOrPort = port;
    displayUrl = `http://127.0.0.1:${port}`;
    urlSource = 'file';
  }

  let token = envToken;
  let tokenSource: 'env' | 'file' | 'none' = envToken ? 'env' : 'none';
  if (!token) {
    // Before r25-3
    // we unconditionally fell back to `loadAuthToken()` when the env
    // didn't supply a bearer. That file is the LOCAL daemon's admin
    // credential (persisted next to the local pid / port files by
    // `dkg start`) — forwarding it to a REMOTE daemon means an
    // operator who merely pointed `DKG_NODE_URL` at some remote
    // endpoint (their own hosted node, a sandbox, a malicious URL
    // pasted into their shell) would hand that remote the admin
    // credential that unlocks their LOCAL box. The remote would see
    // a valid `Authorization: Bearer …` header on every request and
    // could replay it against the operator's local daemon over
    // `127.0.0.1` if it ever got the chance. Classic credential-
    // confused-deputy exfiltration.
    //
    // Fix: only consult the local token file when the resolved
    // endpoint points at the local machine (either `urlSource ===
    // 'file'`, i.e. we discovered the port from the shared state
    // dir, or `DKG_NODE_URL` resolves to a loopback hostname). For
    // remote targets leave the token empty; the user can set
    // `DKG_NODE_TOKEN` to the *remote's* credential if they need
    // authenticated access, which is the only safe channel.
    const isLocalEndpoint = urlSource === 'file' || isLoopbackBaseUrl(baseOrPort);
    if (isLocalEndpoint) {
      const fileToken = (await loadAuthToken()) ?? '';
      if (fileToken) {
        token = fileToken;
        tokenSource = 'file';
      }
    }
  }

  return { baseOrPort, displayUrl, token, tokenSource, urlSource };
}

/**
 * True iff the resolved base URL
 * (or numeric port, which is always `http://127.0.0.1:<port>` from
 * {@link DkgClient}'s constructor) points at the local machine.
 *
 * Loopback is recognised by WHATWG URL parsing — `localhost`,
 * `127.0.0.0/8`, `::1`, or any `[::1]`-bracketed form. Anything else
 * is considered remote, and the caller MUST NOT forward local
 * credentials to it.
 */
function isLoopbackBaseUrl(baseOrPort: string | number): boolean {
  if (typeof baseOrPort === 'number') return true;
  try {
    const u = new URL(baseOrPort);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost') return true;
    if (host === '::1') return true;
    if (host === '0:0:0:0:0:0:0:1') return true;
    // IPv4 loopback: 127.0.0.0/8
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4 && Number(v4[1]) === 127) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse a `DKG_NODE_URL` override into a normalized base URL
 * (scheme + host + explicit port, ORIGIN-ONLY, no path, no trailing
 * slash). Returns `undefined` when the URL is unset, malformed, uses
 * a non-http(s) scheme, or resolves to an unusable port — callers
 * then fall back to the file-derived local port.
 *
 * Unlike {@link extractPortFromUrl} this preserves the host, the
 * scheme, and the explicit port so an override like
 * `https://remote.example:8443` routes correctly instead of silently
 * collapsing to plaintext `http://127.0.0.1:8443`.
 * 
 * Earlier revisions
 * of this helper preserved the URL pathname (e.g. `/api`), but every
 * {@link DkgClient} route already starts with `/api/...`, so an
 * override of `DKG_NODE_URL=https://remote.example:8443/api` produced
 * `.../api/api/status` on the wire — the remote daemon was
 * unreachable.
 *
 * Silently dropping the pathname
 * was still a footgun: a daemon exposed behind a reverse-proxy prefix
 * like `https://host/dkg` LOOKED configured, but traffic silently
 * went to `https://host/api/...` — past the prefix. We now FAIL FAST
 * and return `undefined` for any URL whose pathname is non-trivial
 * (anything that isn't empty or `/`). That bubbles up as "daemon
 * unreachable" at `DkgClient.connect`, which surfaces the
 * misconfiguration in the operator's logs instead of producing
 * opaque 404s from the proxy. If a base-path-aware DkgClient is
 * added later, drop this guard and propagate the pathname — the
 * per-request routes would need to stop hard-coding the `/api/`
 * prefix at the same time.
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

  // reject any non-root pathname instead of silently dropping
  // it. URL normalizes a missing path to `/`, so origin-only inputs
  // like `https://host:443` parse as `u.pathname === '/'`.
  // Anything else (e.g. `/api`, `/dkg`, `/dkg/api`) would be thrown
  // away by the code, leaving the operator with a base URL
  // that looks right but silently bypasses their reverse-proxy
  // prefix. Fail-fast: return undefined so DkgClient.connect reports
  // "daemon unreachable" and the misconfiguration is visible.
  if (u.pathname && u.pathname !== '/') {
    return undefined;
  }

  // Preserve the explicit host:port even when the port is the
  // protocol default — keeping the shape deterministic makes logs
  // and test assertions easier to reason about.
  //
  // The
  // previous revision composed `${u.hostname}:${u.port}`, which
  // silently dropped the square brackets that IPv6 literals require
  // in a URL: `http://[::1]:9200` normalized to `http://::1:9200`, a
  // malformed URL that `fetch` rejects. `URL.host` preserves the
  // brackets, so prefer that and only synthesise `hostname:port` for
  // the default-port case (where `u.host` would elide the port and
  // the r17-4 contract says we keep it explicit). For IPv6 literals
  // the hostname is returned unbracketed by WHATWG URL, so re-wrap
  // when composing manually.
  // WHATWG URL preserves the brackets on `u.hostname` for IPv6
  // literals in Node ≥ 18 (`http://[::1]:9200` ⇒ `hostname === '[::1]'`).
  // Detect the bracketed form (and the unbracketed raw IPv6 form as
  // a belt-and-braces against future runtime variations) so we only
  // add brackets when they are actually missing.
  const hasBrackets = u.hostname.startsWith('[') && u.hostname.endsWith(']');
  const isRawIpv6 = !hasBrackets && u.hostname.includes(':');
  let hostPart: string;
  if (u.port) {
    // u.host already contains the brackets for IPv6 literals.
    hostPart = u.host;
  } else {
    const hostForCompose = isRawIpv6 ? `[${u.hostname}]` : u.hostname;
    hostPart = `${hostForCompose}:${explicitPort}`;
  }

  // Origin-only: DkgClient's per-request paths hard-code the
  // `/api/...` prefix (see r11-2 / r17-4 rationale above).
  return `${u.protocol}//${hostPart}`;
}
