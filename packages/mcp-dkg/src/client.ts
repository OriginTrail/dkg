/**
 * Thin HTTP client for the DKG daemon. Mirrors the shape of
 * `scripts/lib/dkg-daemon.mjs` (so error messages / payload shapes stay
 * consistent with our Node scripts) but is TypeScript-typed and aware
 * of the v10 endpoint naming (`/api/context-graph/*` vs legacy
 * `/api/context-graph/*`).
 */
import type { DkgConfig } from './config.js';

export interface SparqlBinding {
  [key: string]: {
    type: 'uri' | 'literal' | 'bnode' | 'typed-literal';
    value: string;
    datatype?: string;
    'xml:lang'?: string;
  } | string; // some daemons flatten to strings; we normalise downstream
}

export interface SparqlResult {
  head?: { vars?: string[] };
  bindings: SparqlBinding[];
}

export interface QueryResponse {
  result: SparqlResult;
  phases?: Record<string, number>;
}

export interface ProjectRow {
  id: string;
  name?: string;
  description?: string;
  role?: string;
  layer?: string;
  [k: string]: unknown;
}

export interface SubGraphRow {
  name: string;
  description?: string;
  entityCount?: number;
  assertions?: number;
  [k: string]: unknown;
}

export interface DkgClientOptions {
  config: DkgConfig;
  /** Optional fetch implementation (mostly here for tests). */
  fetcher?: typeof fetch;
}

const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';

function normalizeContextGraphId(contextGraphIdOrUri: string): string {
  const trimmed = contextGraphIdOrUri.trim();
  return trimmed.startsWith(CONTEXT_GRAPH_URI_PREFIX)
    ? trimmed.slice(CONTEXT_GRAPH_URI_PREFIX.length)
    : trimmed;
}

function optionalContextGraphId(contextGraphIdOrUri: string | undefined): string | undefined {
  if (typeof contextGraphIdOrUri !== 'string') return undefined;
  return normalizeContextGraphId(contextGraphIdOrUri) || undefined;
}

/**
 * Author attestation produced by an external signer. Mirrors the
 * `packages/cli/src/api-client.ts` reference so finalize / create KA flows can
 * carry a pre-built EIP-712 attestation instead of signing on the daemon.
 */
export interface PreSignedAuthorAttestationPayload {
  address: string;
  /**
   * OT-RFC-43 §F2 — the packed reservedKaId the author signed the
   * AuthorAttestation over, as a decimal string (uint256-safe over JSON).
   * Required: the daemon binds it into the digest and honours the reserved slot.
   */
  reservedKaId: string;
  signature: { r: string; vs: string };
}

/**
 * VM-publish controls for the finalized-assertion publish path. Mirrors
 * `KnowledgeAssetFinalizedPublishOptions` in `packages/cli/src/api-client.ts`.
 * MCP is JSON-facing, so large node identity ids must be passed as decimal
 * strings rather than JavaScript numbers.
 */
export interface KnowledgeAssetFinalizedPublishOptions {
  /**
   * SDK-friendly spelling for the finalized publish cleanup flag. The
   * knowledge-assets daemon route forwards `clearSharedMemoryAfter` to
   * `publishFromFinalizedAssertion`, so the client translates before POST.
   */
  clearAfter?: boolean;
  publishEpochs?: number;
  publisherNodeIdentityIdOverride?: string;
}

const FINALIZED_PUBLISH_OPTION_KEYS = new Set([
  'clearAfter',
  'publishEpochs',
  'publisherNodeIdentityIdOverride',
]);

function publisherNodeIdentityOverridePayload(value: unknown): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  throw new Error('publisherNodeIdentityIdOverride must be passed as a decimal string');
}

function assertExclusiveAuthorFields(args: {
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
}): void {
  if (args.authorAgentAddress != null && args.preSignedAuthorAttestation != null) {
    throw new Error('authorAgentAddress and preSignedAuthorAttestation are mutually exclusive');
  }
}

function assertCreateFinalizeFieldsHaveQuads(args: {
  quads?: unknown[];
  finalize?: boolean;
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
  schemeVersion?: number;
}): void {
  const hasFinalizeOnlyField =
    args.authorAgentAddress != null ||
    args.preSignedAuthorAttestation != null ||
    args.schemeVersion !== undefined;
  // These fields only take effect at finalize, so they require both non-empty
  // quads AND finalize !== false — mirrors the daemon create-route guard.
  const willFinalize = Array.isArray(args.quads) && args.quads.length > 0 && args.finalize !== false;
  if (hasFinalizeOnlyField && !willFinalize) {
    throw new Error('authorAgentAddress, preSignedAuthorAttestation, and schemeVersion require non-empty quads and finalize !== false');
  }
}

/** Translate {@link KnowledgeAssetFinalizedPublishOptions} into the daemon body. */
function finalizedPublishOptionsPayload(
  options?: KnowledgeAssetFinalizedPublishOptions,
  allowedExtraKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const unsupportedKeys = Object.keys(options).filter(
    (key) => !FINALIZED_PUBLISH_OPTION_KEYS.has(key) && !allowedExtraKeys.includes(key),
  );
  if (unsupportedKeys.length > 0) {
    throw new Error(`Unsupported finalized publish option(s): ${unsupportedKeys.join(', ')}`);
  }
  const payload: Record<string, unknown> = {};
  if (options.clearAfter !== undefined) payload.clearSharedMemoryAfter = options.clearAfter;
  if (options.publishEpochs !== undefined) payload.publishEpochs = options.publishEpochs;
  const publisherNodeIdentityIdOverride =
    (options as Record<string, unknown>).publisherNodeIdentityIdOverride;
  if (publisherNodeIdentityIdOverride !== undefined) {
    payload.publisherNodeIdentityIdOverride =
      publisherNodeIdentityOverridePayload(publisherNodeIdentityIdOverride);
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function createAlsoPublishVmPayload(
  value: unknown,
): boolean | Record<string, unknown> {
  if (typeof value === 'boolean') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).length === 0) return {};
    const payload = finalizedPublishOptionsPayload(value as KnowledgeAssetFinalizedPublishOptions);
    if (payload) return payload;
    throw new Error(
      'alsoPublishVm options object must include at least one supported option; use true to publish with defaults',
    );
  }
  throw new Error('alsoPublishVm must be a boolean or publish-options object');
}

/**
 * Per-peer diagnostic snapshot returned by `GET /api/peer-info`. Shape
 * mirrors the daemon-side `PeerDiagnostics` interface plus the legacy
 * flat fields kept for back-compat with pre-diagnostic callers (the
 * Node UI's connectivity panel was the only known consumer when this
 * was introduced).
 */
export interface PeerInfo {
  peerId: string;
  connected: boolean;
  /**
   * Number of open connections to this peer found by walking
   * `libp2p.getConnections()` and filtering by peerId — the legacy
   * count.
   */
  rawConnectionCount: number;
  /**
   * Number of connections returned by libp2p's peerId-keyed lookup
   * `libp2p.getConnections(peerId)`. When this diverges from
   * `rawConnectionCount` on an otherwise open peer, libp2p is
   * filtering out connections the raw walk can see — the Window D
   * signature documented in the May 2026 soak postmortem.
   */
  getConnectionsReturnsForPeer: number;
  connections: Array<{
    direction: 'inbound' | 'outbound';
    transport: 'direct' | 'relayed';
    /**
     * `null` when libp2p didn't expose a remote multiaddr — see the
     * `PeerConnectionSnapshot.remoteAddr` JSDoc in
     * `packages/agent/src/dkg-agent.ts` and the Codex review
     * feedback on PR #533.
     */
    remoteAddr: string | null;
    limited: boolean;
    streams: number;
    openedAt: number | null;
  }>;
  peerStore: {
    knownMultiaddrCount: number;
    multiaddrs: string[];
    protocols: string[];
  } | null;
  /**
   * Pending substrate-outbox entries for this peer.
   *
   * Top-level fields (`pendingCount`, `oldestFirstFailureAt`,
   * `attempts`) keep the rc.8 chat-only contract (chat was the
   * only protocol on the substrate before rc.9 PR-E). Existing
   * consumers that read just these fields continue to work
   * unchanged.
   *
   * {@link byProtocol} (rc.9 PR-E codex follow-up #10 — daemon
   * shipped in b3dd4db4) breaks out queued entries per libp2p
   * protocol id so the per-protocol substrate-outbox state
   * (SWM, access, future protocols) is visible to MCP consumers.
   * Raw sync catch-up state lives in `syncStatus` because sync is
   * off the substrate. Each per-protocol summary mirrors the
   * top-level shape.
   */
  outbox: {
    /** Chat-protocol pending count (rc.8 contract). */
    pendingCount: number;
    /** Chat-protocol oldest `firstFailureAt`. */
    oldestFirstFailureAt: number | null;
    /** Chat-protocol per-entry attempts. */
    attempts: number[];
    /**
     * Per-protocol pending breakdown. Empty object when this peer
     * has no pending entries on the substrate at all.
     *
     * Keys are libp2p protocol ids (e.g. `/dkg/10.0.1/message`,
     * `/dkg/10.0.1/swm-update`). Sync is off the substrate so it does
     * not appear here.
     */
    byProtocol: Record<
      string,
      {
        pendingCount: number;
        oldestFirstFailureAt: number | null;
        attempts: number[];
      }
    >;
  };
  protocols: string[];
  syncCapable: boolean;
  syncStatus?: {
    capable: boolean;
    capability?: 'supported' | 'unsupported' | 'unknown';
    lastSuccessfulSyncAt: number | null;
    stale: boolean;
    backoff: {
      failures: number;
      nextRetryAt: number;
      retryInMs: number;
    } | null;
  };
  lastSeen: number | null;
  latencyMs: number | null;
  health: {
    peerId: string;
    alive: boolean;
    latencyMs: number | null;
    lastSeen: number | null;
    lastChecked: number;
  } | null;
  // Flat per-connection projections of `connections[]`. `remoteAddrs`
  // entries are `string | null` — `null` when libp2p didn't expose a
  // multiaddr for that connection (see `PeerConnectionSnapshot.remoteAddr`
  // in `packages/agent/src/dkg-agent.ts`). User review on PR #533
  // flagged that the original `string[]` typing was a false contract:
  // TypeScript consumers could treat every entry as a `string` even
  // though the runtime JSON can contain `null`.
  connectionCount: number;
  transports: Array<'direct' | 'relayed'>;
  directions: Array<'inbound' | 'outbound'>;
  remoteAddrs: Array<string | null>;
}

export class DkgHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'DkgHttpError';
    this.status = status;
    this.body = body;
  }
}

export class DkgClient {
  private readonly api: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(opts: DkgClientOptions) {
    this.api = opts.config.api.replace(/\/$/, '');
    this.token = opts.config.token;
    this.fetcher = opts.fetcher ?? globalThis.fetch;
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    route: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetcher(`${this.api}${route}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }
    if (!res.ok) {
      const detail = typeof parsed === 'object' && parsed && 'error' in parsed
        ? (parsed as { error: unknown }).error
        : parsed;
      throw new DkgHttpError(
        res.status,
        parsed,
        `${method} ${route} → ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
      );
    }
    return parsed as T;
  }

  // ── Listing endpoints ──────────────────────────────────────────
  async listProjects(): Promise<ProjectRow[]> {
    const response = await this.request<{ contextGraphs?: ProjectRow[] }>(
      'GET',
      '/api/context-graph/list',
    );
    return response.contextGraphs ?? [];
  }

  async listSubGraphs(contextGraphId: string): Promise<SubGraphRow[]> {
    const qs = `?contextGraphId=${encodeURIComponent(normalizeContextGraphId(contextGraphId))}`;
    const r = await this.request<{ subGraphs?: SubGraphRow[] }>('GET', `/api/sub-graph/list${qs}`);
    return r.subGraphs ?? [];
  }

  // ── Query ──────────────────────────────────────────────────────
  /**
   * Memory-layer routing is controlled by `view` + `graphSuffix`:
   *   view=undefined, graphSuffix=undefined  — WM (default, private)
   *   graphSuffix="_shared_memory"           — SWM
   *   graphSuffix="_shared_memory_meta"      — SWM metadata (UAL, owner, publisher)
   *   view="verifiable-memory"                 — VM (on-chain verified)
   *   includeSharedMemory=true               — WM ∪ SWM (UI default)
   *
   * `verifiedGraph` is a STRING naming a specific verified graph inside
   * VM; it narrows a `view: "verifiable-memory"` query to one graph. It is
   * NOT a boolean toggle — passing `verifiedGraph: true` silently failed
   * to route to VM because the query engine expects a graph name, not a
   * flag. Clients that want "give me VM" should pass `view:
   * "verifiable-memory"` (and optionally `verifiedGraph: "<graphName>"`).
   */
  async query(args: {
    sparql: string;
    contextGraphId?: string;
    subGraphName?: string;
    graphSuffix?: '_shared_memory' | '_shared_memory_meta';
    includeSharedMemory?: boolean;
    view?: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
    verifiedGraph?: string;
    assertionName?: string;
    /**
     * Required for `view: "working-memory"` reads. The daemon scopes WM
     * assertion-graph URIs to the agent's raw peer ID — DID-form values
     * route to a non-existent namespace and silently return empty
     * results. Pass the bare peer ID (strip any `did:dkg:agent:` prefix
     * at the boundary; see `dkg_memory_search` for an example).
     */
    agentAddress?: string;
    /**
     * P-13: minimum trust level to admit into results. Only meaningful for
     * `view: "verifiable-memory"`; silently ignored on WM/SWM views.
     *
     * The daemon currently implements only `SelfAttested` (0) and
     * `Endorsed` (1) — the higher tiers are tracked by Q-1 (per-graph
     * trust tagging) and will be accepted once that ships. Until then
     * the daemon returns HTTP 400 on `PartiallyVerified` / `ConsensusVerified`,
     * so the public client type only advertises the two values the
     * server actually honours to avoid documented-yet-failing inputs.
     */
    minTrust?: 'SelfAttested' | 'Endorsed' | 0 | 1;
  }): Promise<SparqlResult> {
    const body: Record<string, unknown> = { sparql: args.sparql };
    const contextGraphId = optionalContextGraphId(args.contextGraphId);
    if (contextGraphId) body.contextGraphId = contextGraphId;
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    if (args.graphSuffix) body.graphSuffix = args.graphSuffix;
    if (args.includeSharedMemory != null) body.includeSharedMemory = args.includeSharedMemory;
    if (args.view != null) body.view = args.view;
    if (args.verifiedGraph != null) body.verifiedGraph = args.verifiedGraph;
    if (args.assertionName) body.assertionName = args.assertionName;
    if (args.agentAddress) body.agentAddress = args.agentAddress;
    if (args.minTrust != null) body.minTrust = args.minTrust;

    const r = await this.request<QueryResponse>('POST', '/api/query', body);
    return r.result ?? { bindings: [] };
  }

  /**
   * Fetch the daemon's default agent identity. Used by `dkg_memory_search`
   * to resolve the agent address required for WM view routing — the
   * daemon scopes WM assertion-graph URIs to the raw peer ID, so a
   * memory-search call without it would silently route into a
   * non-existent namespace and return zero hits.
   *
   * Returns `agentAddress` (DID-form, e.g. `did:dkg:agent:<peerId>`) and
   * `peerId` (raw form). For WM view routing pass `peerId`; for
   * provenance triples (e.g. `prov:wasAttributedTo`) pass `agentAddress`.
   */
  async getAgentIdentity(): Promise<{
    agentAddress?: string;
    agentDid?: string;
    peerId?: string;
    [key: string]: unknown;
  }> {
    return this.request('GET', '/api/agent/identity');
  }

  /** List registered agents (human + AI) + their live connection health. */
  async listAgents(): Promise<unknown[]> {
    const r = await this.request<{ agents?: unknown[] }>('GET', '/api/agents');
    return r.agents ?? [];
  }

  // ── Agent-to-agent chat (Phase 1: agent debug chat RFC) ────────
  /**
   * Send an encrypted libp2p chat to another agent on the DKG network.
   * Wraps `POST /api/chat`, which performs the peerId lookup,
   * encrypted-and-signed exchange over `/dkg/message/1.0.0`, and (on
   * the receiver) a SQLite insert + notification.
   *
   * `to` accepts a peerId or a friendly node name registered in the
   * agent registry. `contextGraphId` is optional and is embedded in the
   * encrypted chat payload so a receiver running `chat.acl.mode =
   * scoped` / `shared-context-graph` can validate the sender belongs to
   * the CG (and so the receiver's SQLite notification carries the CG
   * tag).
   *
   * Returns `delivered: false` with an `error` field on any failure,
   * including ACL rejections — the daemon already surfaces the
   * receiver's `unauthorized: ...` response verbatim, so the model can
   * react ("ask the operator to whitelist us in the receiver's chat
   * ACL") without parsing.
   */
  async sendChat(args: {
    to: string;
    text: string;
    contextGraphId?: string;
  }): Promise<{
    delivered: boolean;
    /**
     * True iff `delivered=false` and the daemon enqueued the message
     * for retry in its in-memory chat outbox. Surfaced to the model so
     * it can tell the operator "queued for delivery" instead of an
     * opaque error. Added in the MessageOutbox PR.
     */
    queued?: boolean;
    /** Outbox key fragment; stable across retries. */
    messageId?: string;
    /** Number of failed attempts so far (1 on first failure). */
    attempts?: number;
    /** Epoch-ms when the next retry is due. */
    nextAttemptAtMs?: number;
    error?: string;
    phases?: Record<string, number>;
  }> {
    const body: Record<string, unknown> = { to: args.to, text: args.text };
    const contextGraphId = optionalContextGraphId(args.contextGraphId);
    if (contextGraphId) body.contextGraphId = contextGraphId;
    return this.request('POST', '/api/chat', body);
  }

  /**
   * Read this node's locally stored chat history. Backed by the
   * `chat_messages` table in `DashboardDB` — every inbound peer chat
   * lands here on receipt (after passing the ACL), and every outbound
   * chat the daemon successfully sends is logged for the operator's
   * UI. Used by `dkg_check_inbox` to surface unread peer messages.
   */
  async getMessages(args: {
    peer?: string;
    since?: number;
    /**
     * Compound-cursor secondary key — paired with `since`, makes the
     * daemon's predicate `(ts > since) OR (ts = since AND id > sinceId)`
     * so rows sharing a millisecond aren't dropped between pages.
     * (Codex PR #510 round 2.)
     */
    sinceId?: number;
    limit?: number;
    /**
     * Server-side direction filter. Applied BEFORE the daemon's LIMIT
     * cap, so inbox readers asking for `direction: 'in'` won't have
     * unread inbound messages skipped when the newest page is a burst
     * of outbound replies. See `GET /api/messages` in
     * `packages/cli/src/daemon/routes/agent-chat.ts` for the contract.
     */
    direction?: 'in' | 'out';
    /**
     * `asc` = forward pagination (oldest first). Inbox readers use this
     * so the watermark only advances past rows we have actually
     * returned. Default `desc` keeps history-view callers unchanged.
     */
    order?: 'asc' | 'desc';
  } = {}): Promise<{
    messages: Array<{
      /**
       * SQLite rowid — exposed so callers can build the next compound
       * cursor `{ since: ts, sinceId: id }`.
       */
      id: number;
      ts: number;
      direction: 'in' | 'out';
      peer: string;
      peerName?: string;
      text: string;
      delivered?: boolean;
    }>;
  }> {
    const params = new URLSearchParams();
    if (args.peer) params.set('peer', args.peer);
    if (typeof args.since === 'number') params.set('since', String(args.since));
    if (typeof args.sinceId === 'number') params.set('sinceId', String(args.sinceId));
    if (typeof args.limit === 'number') params.set('limit', String(args.limit));
    if (args.direction === 'in' || args.direction === 'out') {
      params.set('direction', args.direction);
    }
    if (args.order === 'asc' || args.order === 'desc') {
      params.set('order', args.order);
    }
    const qs = params.toString();
    return this.request('GET', `/api/messages${qs ? `?${qs}` : ''}`);
  }

  // ── Writes ─────────────────────────────────────────────────────
  /**
   * Ensure a sub-graph exists on a project. Idempotent — a pre-existing
   * sub-graph is silently reused.
   */
  async ensureSubGraph(
    contextGraphId: string,
    subGraphName: string,
  ): Promise<void> {
    const cgId = normalizeContextGraphId(contextGraphId);
    try {
      await this.request('POST', '/api/sub-graph/create', {
        contextGraphId: cgId,
        subGraphName,
      });
    } catch (err) {
      if (err instanceof DkgHttpError && /already exists/.test(String(err.message))) {
        return;
      }
      throw err;
    }
  }

  /**
   * Write a set of triples to `assertionName` under `contextGraphId`. The
   * daemon's assertion write is **additive** (`store.insert` is set-merge,
   * not replace) — two writes with the same `assertionName` land in the
   * same graph and their triples union. Callers that want *replace*
   * semantics should either:
   *   (a) mint a unique `assertionName` per write (the canonical pattern
   *       in `scripts/import-*.mjs`, where each import is a new named
   *       snapshot), or
   *   (b) call `discardAssertion` first to wipe the existing graph, then
   *       write — use this when the assertion name itself is the stable
   *       lookup key (e.g. `project-manifest`).
   */
  async writeAssertion(args: {
    contextGraphId: string;
    assertionName: string;
    subGraphName?: string;
    triples: Array<{ subject: string; predicate: string; object: string }>;
  }): Promise<void> {
    const strip = (t: string): string =>
      t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
    const quads = args.triples.map((t) => ({
      subject: strip(t.subject),
      predicate: strip(t.predicate),
      object: t.object,
    }));
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      quads,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    await this.request(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(args.assertionName)}/wm/write`,
      body,
    );
  }

  /**
   * Discard an assertion graph entirely (idempotent — a no-op on an
   * assertion that doesn't exist yet). Use this before re-writing an
   * assertion whose name you want to KEEP stable but whose contents
   * you want to *replace* rather than *merge*. Without this, the
   * daemon's `assertionWrite` is an append-only insert so predicates
   * with changing values (e.g. `publishedAt`, `supportedTools`) would
   * accumulate stale triples across republishes. See the top-of-file
   * comment on `writeAssertion`.
   */
  async discardAssertion(args: {
    contextGraphId: string;
    assertionName: string;
    subGraphName?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    await this.request(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(args.assertionName)}/wm/discard`,
      body,
    );
  }

  /** Promote specific entity URIs from WM → SWM. */
  async promoteAssertion(args: {
    contextGraphId: string;
    assertionName: string;
    subGraphName?: string;
    entities: string[];
  }): Promise<void> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      entities: args.entities,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    await this.request(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(args.assertionName)}/swm/share`,
      body,
    );
  }

  /**
   * Create an empty Working Memory assertion graph (idempotent — duplicate
   * names land as `alreadyExists: true` rather than throwing). The
   * canonical write flow is `createAssertion` → `writeAssertion` →
   * `promoteAssertion` (or `discardAssertion` to roll back).
   */
  async createAssertion(args: {
    contextGraphId: string;
    assertionName: string;
    subGraphName?: string;
  }): Promise<{ assertionUri: string | null; alreadyExists: boolean }> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      name: args.assertionName,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    try {
      // KA create (`POST /api/knowledge-assets`) is a get-or-create that
      // reports `alreadyExists` in the response body, alongside the
      // back-compat `assertionUri`. Prefer the typed flag; keep the
      // legacy error-string fallback in case an older daemon 4xx's on a
      // duplicate name instead.
      const response = await this.request<{
        assertionUri?: string;
        alreadyExists?: boolean;
      }>(
        'POST',
        '/api/knowledge-assets',
        body,
      );
      return {
        assertionUri: response.assertionUri ?? null,
        alreadyExists: response.alreadyExists === true,
      };
    } catch (err) {
      if (err instanceof DkgHttpError && /already exists/.test(String(err.message))) {
        return { assertionUri: null, alreadyExists: true };
      }
      throw err;
    }
  }

  /**
   * Dump every quad in a Working Memory assertion. Returns `{ quads, count }`.
   * Not a SPARQL endpoint — for ad-hoc filtering use `query()` with
   * `view: 'working-memory'` plus the assertion's named graph.
   */
  async queryAssertion(args: {
    contextGraphId: string;
    assertionName: string;
    subGraphName?: string;
  }): Promise<{ quads: unknown[]; count: number }> {
    // KA dump moved from POST-with-body to GET-with-querystring
    // (`GET /api/knowledge-assets/:name/wm/quads`). The `{contextGraphId,
    // subGraphName?}` body becomes query params; response `{quads,count}`
    // is unchanged.
    const params = new URLSearchParams({
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
    });
    if (args.subGraphName) params.set('subGraphName', args.subGraphName);
    return this.request(
      'GET',
      `/api/knowledge-assets/${encodeURIComponent(args.assertionName)}/wm/quads?${params.toString()}`,
    );
  }

  /** Resolve deterministic metadata for a completed imported assertion. */
  async resolveImportArtifact(args: {
    contextGraphId: string;
    assertionUri: string;
    assertionName?: string;
    fileHash?: string;
    subGraphName?: string;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
    };
    body.assertionUri = args.assertionUri;
    if (args.assertionName) body.assertionName = args.assertionName;
    if (args.fileHash) body.fileHash = args.fileHash;
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    return this.request('POST', '/api/knowledge-assets/import-artifact/resolve', body);
  }

  /** Read Markdown for a completed import via content-addressed daemon storage. */
  async readImportArtifactMarkdown(args: {
    contextGraphId: string;
    assertionUri: string;
    assertionName?: string;
    fileHash?: string;
    subGraphName?: string;
    maxBytes?: number;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
    };
    body.assertionUri = args.assertionUri;
    if (args.assertionName) body.assertionName = args.assertionName;
    if (args.fileHash) body.fileHash = args.fileHash;
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    if (args.maxBytes != null) body.maxBytes = args.maxBytes;
    return this.request('POST', '/api/knowledge-assets/import-artifact/read-markdown', body);
  }

  /** Append model-derived semantic triples to the completed imported assertion. */
  async writeSemanticEnrichment(args: {
    contextGraphId: string;
    assertionUri: string;
    assertionName?: string;
    fileHash?: string;
    subGraphName?: string;
    semanticQuads: Array<{ subject: string; predicate: string; object: string }>;
    generationMethod?: string;
    agentIdentity?: string;
    generatedAt?: string;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      semanticQuads: args.semanticQuads,
    };
    body.assertionUri = args.assertionUri;
    if (args.assertionName) body.assertionName = args.assertionName;
    if (args.fileHash) body.fileHash = args.fileHash;
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    if (args.generationMethod) body.generationMethod = args.generationMethod;
    if (args.agentIdentity) body.agentIdentity = args.agentIdentity;
    if (args.generatedAt) body.generatedAt = args.generatedAt;
    return this.request('POST', '/api/knowledge-assets/semantic-enrichment/write', body);
  }

  /**
   * Lifecycle descriptor for an assertion: author, extraction status,
   * promotion state, timestamps. Returns 404 (`DkgHttpError`) when no
   * record exists for the (contextGraphId, name, agentAddress) tuple.
   */
  async getAssertionHistory(args: {
    contextGraphId: string;
    assertionName: string;
    agentAddress?: string;
    subGraphName?: string;
  }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ contextGraphId: normalizeContextGraphId(args.contextGraphId) });
    if (args.agentAddress) params.set('agentAddress', args.agentAddress);
    if (args.subGraphName) params.set('subGraphName', args.subGraphName);
    return this.request(
      'GET',
      `/api/knowledge-assets/${encodeURIComponent(args.assertionName)}?${params.toString()}`,
    );
  }

  /**
   * Import a local document (markdown, PDF, etc.) into a WM assertion via
   * multipart/form-data. The daemon runs its extraction pipeline and writes
   * the resulting triples into the assertion's graph. text/markdown is
   * native; other types need a registered converter (extraction returns
   * `status: "skipped"` if none).
   *
   * Bypasses the JSON `request()` helper because multipart bodies need
   * `FormData` rather than `JSON.stringify`. The auth header and base URL
   * shape match `request()` so behaviour stays consistent.
   */
  async importAssertionFile(args: {
    contextGraphId: string;
    assertionName: string;
    fileBuffer: Buffer | Uint8Array;
    fileName: string;
    contentType?: string;
    ontologyRef?: string;
    subGraphName?: string;
  }): Promise<Record<string, unknown>> {
    const form = new FormData();
    // Copy into a fresh Uint8Array to satisfy TS's BlobPart union across
    // Node Buffer / SharedArrayBuffer.
    const bytes = new Uint8Array(args.fileBuffer.byteLength);
    bytes.set(args.fileBuffer);
    const blob = new Blob([bytes], {
      type: args.contentType ?? 'application/octet-stream',
    });
    form.append('file', blob, args.fileName);
    form.append('contextGraphId', normalizeContextGraphId(args.contextGraphId));
    if (args.contentType) form.append('contentType', args.contentType);
    if (args.ontologyRef) form.append('ontologyRef', args.ontologyRef);
    if (args.subGraphName) form.append('subGraphName', args.subGraphName);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetcher(
      `${this.api}/api/knowledge-assets/${encodeURIComponent(args.assertionName)}/wm/import-file`,
      {
        method: 'POST',
        headers,
        body: form,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* leave as raw text */ }
      throw new DkgHttpError(
        res.status,
        parsed,
        `POST /api/knowledge-assets/${args.assertionName}/wm/import-file → ${res.status}: ${text}`,
      );
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Node status: peer ID, connected peers, multiaddrs, wallet addresses.
   * Wraps `GET /api/status` (the same endpoint the OpenClaw adapter calls
   * at `getFullStatus`).
   */
  async getStatus(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/status');
  }

  /**
   * Per-peer diagnostic snapshot. Wraps `GET /api/peer-info?peerId=...`
   * which surfaces the full {@link PeerInfo} structure (open connections
   * with direction + transport + limited flag, peerStore contents,
   * outbox state, and the critical `getConnectionsReturnsForPeer`
   * discrepancy field that lets operators detect the Window D class of
   * libp2p asymmetric reachability bugs at a glance).
   */
  async getPeerInfo(peerId: string): Promise<PeerInfo> {
    const qs = `?peerId=${encodeURIComponent(peerId)}`;
    return this.request('GET', `/api/peer-info${qs}`);
  }

  /**
   * Per-wallet TRAC + ETH balances + chain context. Wraps
   * `GET /api/wallets/balances` — pre-publish "do I have funds" check.
   */
  async getWalletBalances(): Promise<{
    wallets: string[];
    balances: Array<{ address: string; eth: string; trac: string; symbol: string }>;
    chainId: string | null;
    rpcUrl: string | null;
    error?: string;
  }> {
    return this.request('GET', '/api/wallets/balances');
  }

  /**
   * Subscribe to a context graph so its data syncs locally. Required
   * before querying or publishing into a remotely-authored CG.
   */
  async subscribe(args: {
    contextGraphId: string;
    includeSharedMemory?: boolean;
  }): Promise<{
    subscribed: string;
    catchup?: { jobId: string; status: string; includeSharedMemory: boolean };
  }> {
    return this.request('POST', '/api/subscribe', {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      includeSharedMemory: args.includeSharedMemory,
    });
  }

  /**
   * OT-RFC-38 / LU-6 Phase B path 4 — operator-driven host-mode
   * subscribe. Asks the connected daemon (must be a core with
   * `swmHostMode` enabled) to start hosting the curated CG's opaque
   * SWM ciphertext substrate without joining as a member.
   *
   * Last-resort fallback for when none of the three automatic
   * discovery paths apply: chain-event (curator hasn't registered
   * on-chain), beacon (curator doesn't run the discovery beacon), or
   * reconciler (the local node doesn't yet know about the CG). See
   * `docs/runbooks/RUNBOOK_HOST_MODE_MANUAL_SUBSCRIBE.md` for full
   * guidance on when to reach for this.
   *
   * Idempotent: the daemon returns `{ alreadySubscribed: true }` when
   * the CG is already host-subscribed via any path. Refuses
   * (returning `memberMode: true`) when the local node is already a
   * CG member — member-mode handler takes precedence.
   */
  async requestHostMode(args: {
    contextGraphId: string;
  }): Promise<{
    contextGraphId: string;
    subscribed: boolean;
    alreadySubscribed: boolean;
    hostingEnabled: boolean;
    memberMode?: boolean;
  }> {
    return this.request('POST', '/api/shared-memory/host-mode/subscribe', {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
    });
  }

  /**
   * Create a new context graph on the DKG node. The `id` is the slug; if
   * omitted at the tool layer it should be derived from `name` before
   * being passed through. Wraps `POST /api/context-graph/create`.
   *
   * Idempotent on duplicate `id`: the daemon route returns HTTP 409 with
   * an `already exists` / `duplicate` / `conflict` body when a CG with
   * the same id already exists; this wrapper catches that 409 and returns
   * `{ alreadyExists: true, created, uri }` so callers (e.g.
   * `dkg_context_graph_create`) can surface "already existed" vs
   * "newly created" without parsing error strings. Mirrors the
   * `createAssertion` shape — same convention, same idempotency contract.
   */
  async createContextGraph(args: {
    id: string;
    name: string;
    description?: string;
    /** 0 = public/discoverable, 1 = private/curated. Forwarded to the daemon verbatim. */
    accessPolicy?: number;
    /** 0 = curated publishing, 1 = open publishing. Forwarded to the daemon verbatim. */
    publishPolicy?: number;
  }): Promise<{ created: string; uri: string; alreadyExists: boolean }> {
    try {
      const response = await this.request<{ created: string; uri: string }>(
        'POST',
        '/api/context-graph/create',
        {
          id: args.id,
          name: args.name,
          description: args.description,
          ...(args.accessPolicy !== undefined ? { accessPolicy: args.accessPolicy } : {}),
          ...(args.publishPolicy !== undefined ? { publishPolicy: args.publishPolicy } : {}),
        },
      );
      return { ...response, alreadyExists: false };
    } catch (err) {
      // Daemon returns 409 with "already exists" / "duplicate" / "conflict"
      // in the body when the id is taken; treat any of those as the
      // idempotent already-exists case rather than a hard failure.
      if (
        err instanceof DkgHttpError &&
        err.status === 409 &&
        /already exists|duplicate|conflict/i.test(String(err.message))
      ) {
        return {
          created: args.id,
          uri: `did:dkg:context-graph:${args.id}`,
          alreadyExists: true,
        };
      }
      throw err;
    }
  }

  /**
   * Final canonical-flow step: publish a single root from a context graph's
   * Shared Working Memory to Verifiable Memory (on-chain). The daemon route
   * accepts `selection` as either the literal `"all"` or an array of root
   * entity URIs, but V10 synchronous publish only proceeds when that
   * selection resolves to exactly one publishable root.
   *
   * Default `clearAfter` is `false` for subset publishes (so unpublished
   * roots aren't dropped from SWM) and `true` for omitted-root publishes.
   * Omitted roots still map to `"all"` for compatibility, but the daemon
   * rejects it when SWM contains more than one publishable root.
   */
  async publishSharedMemory(args: {
    contextGraphId: string;
    rootEntities?: string[];
    subGraphName?: string;
    clearAfter?: boolean;
  }): Promise<Record<string, unknown>> {
    const hasSubset = Array.isArray(args.rootEntities) && args.rootEntities.length > 0;
    const clearAfter = args.clearAfter ?? !hasSubset;
    return this.request('POST', '/api/shared-memory/publish', {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      selection: args.rootEntities ?? 'all',
      clearAfter,
      subGraphName: args.subGraphName,
    });
  }

  /**
   * One-shot publish helper: route through the new assertion
   * lifecycle (RFC-001 §9.x) — create a fresh assertion with an
   * auto-generated name, write the supplied quads, finalize (which
   * computes the merkle root and signs the EIP-712 AuthorAttestation
   * stored in `_meta`), promote into SWM, then publish to the
   * verifiable-memory chain. The publisher forwards the seal verbatim
   * and never re-signs.
   *
   * For step-wise control (long-running stage, late finalize, etc.)
   * use the `assertion_create` / `assertion_finalize` /
   * `shared_memory_publish` tools directly.
   *
   * Mirrors `packages/adapter-openclaw/src/dkg-client.ts:635-652`.
   */
  async publishQuads(args: {
    contextGraphId: string;
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>;
  }): Promise<Record<string, unknown>> {
    const cgId = normalizeContextGraphId(args.contextGraphId);
    const assertionName = `mcp-publish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // The write wire shape is `{subject, predicate, object}` only — the daemon
    // pins every quad to the per-KA WM graph itself, so a client-supplied
    // `graph` is ignored/overridden (CONTRACT §0 invariant 2). Auto-finalize is
    // driven purely by non-empty `quads` (CONTRACT §1 Stage1), so `finalize:true`
    // is unread and dropped. `promote:true` is kept: the create route reads it as
    // the `alsoShareSwm` alias (CONTRACT §1 Stage1). Mirrors the OpenClaw adapter.
    const wireQuads = args.quads.map((q) => ({
      subject: q.subject,
      predicate: q.predicate,
      object: q.object,
    }));
    // FIX W — wrap the create call: on a HARD failure the generated
    // `assertionName` would otherwise be lost in the throw, so a retry mints a
    // DUPLICATE if the asset was actually created (e.g. the daemon committed but
    // the HTTP response failed). Surface the name + recovery guidance.
    let created: {
      assertionUri?: string;
      // The create response carries `merkleRoot` (the seal digest), not a `seal`
      // object (knowledge-assets.ts:570).
      merkleRoot?: string;
      errors?: Array<{ phase?: string; error?: string }>;
    };
    try {
      created = await this.request(
        'POST',
        '/api/knowledge-assets',
        {
          contextGraphId: cgId,
          name: assertionName,
          quads: wireQuads,
          promote: true,
        },
      );
    } catch (e) {
      const err = new Error(
        `Create failed for one-shot publish (asset name "${assertionName}"): ${e instanceof Error ? e.message : String(e)}. ` +
        `The asset MAY have been created server-side even though the response failed. Before retrying, check via ` +
        `dkg_knowledge_asset_history for "${assertionName}" to avoid minting a DUPLICATE. A created asset is ` +
        `auto-shared to SWM (its working-memory draft is empty), so use _history (lifecycle state regardless ` +
        `of layer) for existence — NOT dkg_knowledge_asset_query, which reads the empty WM draft and would ` +
        `falsely report "not created". If it exists, re-share + publish it by name rather than re-running this tool.`,
      ) as Error & Record<string, unknown>;
      err.assertionName = assertionName;
      err.phase = 'create';
      err.cause = e;
      throw err;
    }

    // FIX A — the create route returns HTTP 207 `{ created:true, …, errors:[…] }`
    // when create+finalize succeeded but the `promote:true` share phase FAILED
    // (knowledge-assets.ts:614). `this.request` treats 207 as success (2xx, no
    // throw), so without this check we would publish an UNSHARED assertion and
    // mask the real error. If the share failed, do NOT publish — surface the
    // sealed-but-unshared asset by name so the caller can recover with the
    // lifecycle tools instead of recreating it.
    if (Array.isArray(created.errors) && created.errors.length > 0) {
      const shareErr = created.errors.find((e) => e?.phase === 'swm-share') ?? created.errors[0];
      const err = new Error(
        `Publish aborted: the asset was created + sealed in Working Memory as "${assertionName}", but ` +
        `sharing it to Shared Working Memory FAILED (${shareErr?.error ?? 'unknown error'}). The on-chain ` +
        `publish was NOT attempted. Do NOT recreate — re-share the existing sealed asset by name with ` +
        `dkg_knowledge_asset_share, then publish it with dkg_knowledge_asset_publish.`,
      ) as Error & Record<string, unknown>;
      err.assertionName = assertionName;
      err.assertionUri = created.assertionUri;
      if (created.merkleRoot) err.merkleRoot = created.merkleRoot;
      err.phase = shareErr?.phase ?? 'swm-share';
      err.partial = true;
      throw err;
    }

    // FIX B — the asset is created + sealed + shared; only the on-chain publish
    // remains. If it fails, the random `assertionName` would be lost and the next
    // dkg_publish would mint a DUPLICATE. Catch + rethrow carrying the name so the
    // caller can retry the publish of the existing asset, not recreate it.
    let published: Record<string, unknown>;
    try {
      published = await this.request<Record<string, unknown>>(
        'POST',
        '/api/shared-memory/publish',
        {
          contextGraphId: cgId,
          assertionName,
        },
      );
    } catch (e) {
      const err = new Error(
        `Publish failed for asset "${assertionName}": ${e instanceof Error ? e.message : String(e)}. The asset ` +
        `is created + sealed + shared to Shared Working Memory; only the on-chain publish failed. Do NOT ` +
        `recreate — retry the publish of this asset by name with dkg_knowledge_asset_publish.`,
      ) as Error & Record<string, unknown>;
      err.assertionName = assertionName;
      err.assertionUri = created.assertionUri;
      if (created.merkleRoot) err.merkleRoot = created.merkleRoot;
      err.phase = 'vm-publish';
      err.cause = e;
      throw err;
    }
    return {
      ...published,
      ...(created.assertionUri ? { assertionUri: created.assertionUri } : {}),
      ...(created.merkleRoot ? { merkleRoot: created.merkleRoot } : {}),
    };
  }

  /**
   * Register a context graph on-chain. Used in conjunction with
   * `publishSharedMemory({ ... })` when `register_if_needed: true`.
   * The CG must exist locally first (via `createContextGraph`).
   *
   * Idempotent on already-registered: the daemon route returns HTTP 409
   * when the CG is already on-chain; this wrapper catches that 409 and
   * returns `{ alreadyRegistered: true }` so callers can branch on a
   * typed signal rather than parsing error message text. Mirrors the
   * `createAssertion` / `createContextGraph` shape — same convention,
   * same idempotency contract.
   */
  async registerContextGraph(args: {
    id: string;
    accessPolicy?: number;
  }): Promise<{
    registered: string;
    onChainId?: string;
    txHash?: string;
    hint?: string;
    alreadyRegistered: boolean;
  }> {
    try {
      const response = await this.request<{
        registered: string;
        onChainId: string;
        txHash?: string;
        hint?: string;
      }>('POST', '/api/context-graph/register', {
        id: normalizeContextGraphId(args.id),
        accessPolicy: args.accessPolicy,
      });
      return { ...response, alreadyRegistered: false };
    } catch (err) {
      // Daemon returns 409 with "already registered" body when the CG
      // is already on-chain. Surface as a typed flag so the tool layer
      // can branch on it without the locale-fragile substring match.
      if (err instanceof DkgHttpError && err.status === 409) {
        return {
          registered: normalizeContextGraphId(args.id),
          alreadyRegistered: true,
        };
      }
      throw err;
    }
  }

  // ── OT-RFC-43 §10.5 — GitHub-shaped Knowledge Asset client ──────────────
  // Layer-explicit wrappers over the clean /api/knowledge-assets/... surface.
  // One file = one Knowledge Asset (Design B / OT-RFC-44), carrying any number
  // of member entities. WM → SWM → VM via the git-shaped verbs write →
  // finalize → share → publish. The assertion-named methods above now
  // target this same /api/knowledge-assets/... surface (the legacy
  // /api/assertion/* routes are retired); only the shared-memory/* methods
  // remain on their own routes.

  /** Create a KA + open its WM draft. Pass `quads` to atomically write+finalize. */
  async createKnowledgeAsset(args: {
    contextGraphId: string;
    name: string;
    subGraphName?: string;
    quads?: Array<{ subject: string; predicate: string; object: string; graph: string }>;
    /**
     * Seal the draft after writing `quads` (default true). `false` keeps an
     * editable WM draft that never touches the chain — the only lifecycle
     * available to local-only / on-chain-unregistered CGs. Cannot be combined
     * with `alsoShareSwm`/`alsoPublishVm` (those require a sealed assertion).
     */
    finalize?: boolean;
    authorAgentAddress?: string;
    preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
    schemeVersion?: number;
    alsoShareSwm?: boolean;
    alsoPublishVm?: boolean | KnowledgeAssetFinalizedPublishOptions;
  }): Promise<Record<string, unknown>> {
    assertExclusiveAuthorFields(args);
    assertCreateFinalizeFieldsHaveQuads(args);
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      name: args.name,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    if (args.quads) body.quads = args.quads;
    if (args.finalize !== undefined) body.finalize = args.finalize;
    if (args.authorAgentAddress) body.authorAgentAddress = args.authorAgentAddress;
    if (args.preSignedAuthorAttestation) {
      body.preSignedAuthorAttestation = args.preSignedAuthorAttestation;
    }
    if (args.schemeVersion !== undefined) body.schemeVersion = args.schemeVersion;
    if (args.alsoShareSwm !== undefined) body.alsoShareSwm = args.alsoShareSwm;
    if (args.alsoPublishVm !== undefined) {
      // Object form carries finalized-publish controls; translate to the daemon
      // body shape (mirrors the cli ApiClient). `true`/`false` pass through.
      body.alsoPublishVm = createAlsoPublishVmPayload(args.alsoPublishVm);
    }
    return this.request<Record<string, unknown>>('POST', '/api/knowledge-assets', body);
  }

  /** GET a KA's per-layer lifecycle state by name. */
  async getKnowledgeAsset(args: {
    contextGraphId: string;
    name: string;
    subGraphName?: string;
  }): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      ...(args.subGraphName ? { subGraphName: args.subGraphName } : {}),
    }).toString();
    return this.request<Record<string, unknown>>(
      'GET',
      `/api/knowledge-assets/${encodeURIComponent(args.name)}?${qs}`,
    );
  }

  /** Append quads to the KA's WM draft (git add/edit). */
  async knowledgeAssetWrite(args: {
    contextGraphId: string;
    name: string;
    // `graph` is accepted on the input for caller convenience but is STRIPPED
    // before the POST (CONTRACT §A) — the write wire shape is
    // {subject,predicate,object} only and the daemon pins every quad to the
    // per-KA WM graph (§0 invariant 2), overriding any client-supplied graph.
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>;
    subGraphName?: string;
  }): Promise<{ written: number }> {
    // Strip any per-quad `graph` at the client (CONTRACT §A) — not just the
    // tool schema — so a hand-built or normalizer-emitted `graph` can't reach
    // the wire.
    const wireQuads = args.quads.map((q) => ({
      subject: q.subject,
      predicate: q.predicate,
      object: q.object,
    }));
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      quads: wireQuads,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    return this.request<{ written: number }>(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(args.name)}/wm/write`,
      body,
    );
  }

  /** Seal the WM draft — computes the merkle root + signs the seal (git commit). */
  async knowledgeAssetFinalize(args: {
    contextGraphId: string;
    name: string;
    subGraphName?: string;
    authorAgentAddress?: string;
    preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
    schemeVersion?: number;
  }): Promise<{ merkleRoot: string; eip712Digest: string }> {
    assertExclusiveAuthorFields(args);
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    if (args.authorAgentAddress) body.authorAgentAddress = args.authorAgentAddress;
    if (args.preSignedAuthorAttestation) {
      body.preSignedAuthorAttestation = args.preSignedAuthorAttestation;
    }
    if (args.schemeVersion !== undefined) body.schemeVersion = args.schemeVersion;
    return this.request<{ merkleRoot: string; eip712Digest: string }>(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(args.name)}/wm/finalize`,
      body,
    );
  }

  /** Discard the open WM draft (git checkout -- .). */
  async knowledgeAssetDiscard(args: {
    contextGraphId: string;
    name: string;
    subGraphName?: string;
  }): Promise<{ discarded: boolean }> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    return this.request<{ discarded: boolean }>(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(args.name)}/wm/discard`,
      body,
    );
  }

  /** Seed a fresh WM draft from the file's current SWM/VM state (git checkout). */
  async knowledgeAssetPullFrom(args: {
    contextGraphId: string;
    name: string;
    layer: 'swm' | 'vm';
    subGraphName?: string;
    onConflict?: 'reject' | 'replace';
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
      layer: args.layer,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    if (args.onConflict) body.onConflict = args.onConflict;
    return this.request<Record<string, unknown>>(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(args.name)}/wm/pull-from`,
      body,
    );
  }

  /** Advance the SWM pointer (WM → SWM; git push origin <branch>). */
  async knowledgeAssetShare(args: {
    contextGraphId: string;
    name: string;
    subGraphName?: string;
    entities?: string[] | 'all';
  }): Promise<{ swmShared: boolean; promotedCount: number }> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    if (args.entities !== undefined) body.entities = args.entities;
    return this.request<{ swmShared: boolean; promotedCount: number }>(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(args.name)}/swm/share`,
      body,
    );
  }

  /** Publish to VM — mint or update on chain (git push origin main). */
  async knowledgeAssetPublish(args: {
    contextGraphId: string;
    name: string;
    subGraphName?: string;
  } & KnowledgeAssetFinalizedPublishOptions): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(args.contextGraphId),
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    const publishOptions = finalizedPublishOptionsPayload(args, ['contextGraphId', 'name', 'subGraphName']);
    if (publishOptions) body.options = publishOptions;
    return this.request<Record<string, unknown>>(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(args.name)}/vm/publish`,
      body,
    );
  }
}

/**
 * Normalise a SPARQL binding cell into a bare string, regardless of
 * whether the daemon serialises it as a full JSON-LD term or as a
 * flattened literal. All tool surfaces downstream work on strings.
 */
export function bindingValue(cell: SparqlBinding[string] | undefined): string {
  if (cell == null) return '';
  if (typeof cell === 'string') return cell;
  return cell.value ?? '';
}
