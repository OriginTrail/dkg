/**
 * Thin HTTP client for the DKG daemon. Mirrors the shape of
 * `scripts/lib/dkg-daemon.mjs` (so error messages / payload shapes stay
 * consistent with our Node scripts) but is TypeScript-typed and aware
 * of the v10 endpoint naming (`/api/context-graph/*` vs legacy
 * `/api/paranet/*`).
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
  /** v10 preferred; legacy `/api/paranet/list` retained as fallback. */
  async listProjects(): Promise<ProjectRow[]> {
    try {
      const v10 = await this.request<{ contextGraphs?: ProjectRow[]; paranets?: ProjectRow[] }>(
        'GET',
        '/api/context-graph/list',
      );
      return v10.contextGraphs ?? v10.paranets ?? [];
    } catch (err) {
      if (err instanceof DkgHttpError && err.status === 404) {
        const legacy = await this.request<{ paranets?: ProjectRow[] }>(
          'GET',
          '/api/paranet/list',
        );
        return legacy.paranets ?? [];
      }
      throw err;
    }
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
  }): Promise<SparqlResult> {
    const body: Record<string, unknown> = { sparql: args.sparql };
    if (args.contextGraphId) body.contextGraphId = args.contextGraphId;
    if (args.subGraphName) body.subGraphName = args.subGraphName;
    if (args.graphSuffix) body.graphSuffix = args.graphSuffix;
    if (args.includeSharedMemory != null) body.includeSharedMemory = args.includeSharedMemory;
    if (args.view != null) body.view = args.view;
    if (args.verifiedGraph != null) body.verifiedGraph = args.verifiedGraph;
    if (args.assertionName) body.assertionName = args.assertionName;

    const r = await this.request<QueryResponse>('POST', '/api/query', body);
    return r.result ?? { bindings: [] };
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
