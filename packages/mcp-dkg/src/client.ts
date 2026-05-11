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
    const qs = `?contextGraphId=${encodeURIComponent(contextGraphId)}`;
    const r = await this.request<{ subGraphs?: SubGraphRow[] }>('GET', `/api/sub-graph/list${qs}`);
    return r.subGraphs ?? [];
  }

  // ── Query ──────────────────────────────────────────────────────
  /**
   * Memory-layer routing is controlled by `view` + `graphSuffix`:
   *   view=undefined, graphSuffix=undefined  — WM (default, private)
   *   graphSuffix="_shared_memory"           — SWM
   *   graphSuffix="_shared_memory_meta"      — SWM metadata (UAL, owner, publisher)
   *   view="verified-memory"                 — VM (on-chain verified)
   *   includeSharedMemory=true               — WM ∪ SWM (UI default)
   *
   * `verifiedGraph` is a STRING naming a specific verified graph inside
   * VM; it narrows a `view: "verified-memory"` query to one graph. It is
   * NOT a boolean toggle — passing `verifiedGraph: true` silently failed
   * to route to VM because the query engine expects a graph name, not a
   * flag. Clients that want "give me VM" should pass `view:
   * "verified-memory"` (and optionally `verifiedGraph: "<graphName>"`).
   */
  async query(args: {
    sparql: string;
    contextGraphId?: string;
    subGraphName?: string;
    graphSuffix?: '_shared_memory' | '_shared_memory_meta';
    includeSharedMemory?: boolean;
    view?: 'working-memory' | 'shared-working-memory' | 'verified-memory';
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
     * `view: "verified-memory"`; silently ignored on WM/SWM views.
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
    if (args.contextGraphId) body.contextGraphId = args.contextGraphId;
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

  // ── Writes ─────────────────────────────────────────────────────
  /**
   * Ensure a sub-graph exists on a project. Idempotent — a pre-existing
   * sub-graph is silently reused.
   */
  async ensureSubGraph(
    contextGraphId: string,
    subGraphName: string,
  ): Promise<void> {
    try {
      await this.request('POST', '/api/sub-graph/create', {
        contextGraphId,
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
      contextGraphId: args.contextGraphId,
      quads,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    await this.request(
      'POST',
      `/api/assertion/${encodeURIComponent(args.assertionName)}/write`,
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
      contextGraphId: args.contextGraphId,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    await this.request(
      'POST',
      `/api/assertion/${encodeURIComponent(args.assertionName)}/discard`,
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
      contextGraphId: args.contextGraphId,
      entities: args.entities,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    await this.request(
      'POST',
      `/api/assertion/${encodeURIComponent(args.assertionName)}/promote`,
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
      contextGraphId: args.contextGraphId,
      name: args.assertionName,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    try {
      const response = await this.request<{ assertionUri: string }>(
        'POST',
        '/api/assertion/create',
        body,
      );
      return { assertionUri: response.assertionUri, alreadyExists: false };
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
    const body: Record<string, unknown> = {
      contextGraphId: args.contextGraphId,
    };
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    return this.request(
      'POST',
      `/api/assertion/${encodeURIComponent(args.assertionName)}/query`,
      body,
    );
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
    const params = new URLSearchParams({ contextGraphId: args.contextGraphId });
    if (args.agentAddress) params.set('agentAddress', args.agentAddress);
    if (args.subGraphName) params.set('subGraphName', args.subGraphName);
    return this.request(
      'GET',
      `/api/assertion/${encodeURIComponent(args.assertionName)}/history?${params.toString()}`,
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
    form.append('contextGraphId', args.contextGraphId);
    if (args.contentType) form.append('contentType', args.contentType);
    if (args.ontologyRef) form.append('ontologyRef', args.ontologyRef);
    if (args.subGraphName) form.append('subGraphName', args.subGraphName);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetcher(
      `${this.api}/api/assertion/${encodeURIComponent(args.assertionName)}/import-file`,
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
        `POST /api/assertion/${args.assertionName}/import-file → ${res.status}: ${text}`,
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
      contextGraphId: args.contextGraphId,
      includeSharedMemory: args.includeSharedMemory,
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
  }): Promise<{ created: string; uri: string; alreadyExists: boolean }> {
    try {
      const response = await this.request<{ created: string; uri: string }>(
        'POST',
        '/api/context-graph/create',
        {
          id: args.id,
          name: args.name,
          description: args.description,
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
   * Final canonical-flow step: publish the current contents of a context
   * graph's Shared Working Memory to Verified Memory (on-chain) and
   * (by default) clear SWM. The daemon route accepts `selection` as
   * either the literal `"all"` or an array of root entity URIs — this
   * wrapper exposes the latter as `rootEntities` and translates the
   * omit-case to `"all"` server-side.
   *
   * Default `clearAfter` is `false` for subset publishes (so unpublished
   * roots aren't dropped from SWM) and `true` for full publishes.
   * Mirrors `packages/adapter-openclaw/src/dkg-client.ts:664-680`.
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
      contextGraphId: args.contextGraphId,
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
   * verified-memory chain. The publisher forwards the seal verbatim
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
    const assertionName = `mcp-publish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const quadsWithGraph = args.quads.map((q) => ({
      subject: q.subject,
      predicate: q.predicate,
      object: q.object,
      graph: q.graph ?? `did:dkg:context-graph:${args.contextGraphId}`,
    }));
    const created = await this.request<{ assertionUri?: string; seal?: Record<string, unknown> }>(
      'POST',
      '/api/assertion/create',
      {
        contextGraphId: args.contextGraphId,
        name: assertionName,
        quads: quadsWithGraph,
        finalize: true,
        promote: true,
      },
    );
    const published = await this.request<Record<string, unknown>>(
      'POST',
      '/api/shared-memory/publish',
      {
        contextGraphId: args.contextGraphId,
        assertionName,
      },
    );
    return {
      ...published,
      ...(created.assertionUri ? { assertionUri: created.assertionUri } : {}),
      ...(created.seal ? { seal: created.seal } : {}),
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
        id: args.id,
        accessPolicy: args.accessPolicy,
      });
      return { ...response, alreadyRegistered: false };
    } catch (err) {
      // Daemon returns 409 with "already registered" body when the CG
      // is already on-chain. Surface as a typed flag so the tool layer
      // can branch on it without the locale-fragile substring match.
      if (err instanceof DkgHttpError && err.status === 409) {
        return {
          registered: args.id,
          alreadyRegistered: true,
        };
      }
      throw err;
    }
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
