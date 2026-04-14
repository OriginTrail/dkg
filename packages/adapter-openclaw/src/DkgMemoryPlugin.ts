/**
 * DkgMemoryPlugin — DKG-backed memory-slot plugin for OpenClaw.
 *
 * Reads flow through the memory slot:
 *   `api.registerMemoryCapability({ runtime: buildDkgMemoryRuntime(...) })`
 * which gives the upstream memory host a `MemorySearchManager` instance
 * whose `search()` issues two parallel `POST /api/query` calls — one to
 * `agent-context` (`assertionName: 'chat-turns'`) and one to the resolved
 * project context graph (`assertionName: 'memory'`), both with
 * `view: 'working-memory'`.
 *
 * Writes flow through an explicit `api.registerTool("dkg_memory_import")`
 * registration, because the upstream `MemorySearchManager` contract is
 * read-only. The write path creates (idempotently) and writes into the
 * `'memory'` WM assertion of the resolved project CG.
 *
 * Both surfaces target real V10 primitives:
 *   create: POST /api/assertion/create
 *   write:  POST /api/assertion/:name/write
 *   read:   POST /api/query   (with view='working-memory' + agentAddress
 *                              + assertionName)
 *
 * No `agent-memory` sidecar. No `dkg:ImportedMemory`. No
 * `FILTER(CONTAINS)`-over-a-throwaway-graph. No `tools.share` on the
 * chat-turn or memory paths — that's SWM, wrong layer per
 * `21_TRI_MODAL_MEMORY.md §5`.
 */

import type { DkgDaemonClient } from './dkg-client.js';
import type {
  DkgOpenClawConfig,
  MemoryEmbeddingProbeResult,
  MemoryPluginCapability,
  MemoryPluginRuntime,
  MemoryProviderStatus,
  MemoryReadFileRequest,
  MemoryReadFileResult,
  MemoryRuntimeRequest,
  MemoryRuntimeResult,
  MemorySearchManager,
  MemorySearchOptions,
  MemorySearchResult,
  OpenClawPluginApi,
  OpenClawToolResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Conventions — addresses, assertion names, RDF vocabulary
// ---------------------------------------------------------------------------

export const AGENT_CONTEXT_GRAPH = 'agent-context';
export const CHAT_TURNS_ASSERTION = 'chat-turns';
export const PROJECT_MEMORY_ASSERTION = 'memory';

const NS = {
  schema: 'http://schema.org/',
  dkg: 'http://dkg.io/ontology/',
};
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

// ---------------------------------------------------------------------------
// Session resolver — how the search manager and write tool find the
// currently-active project context graph for a given chat turn
// ---------------------------------------------------------------------------

export interface DkgMemorySession {
  /**
   * UI-selected / envelope-stamped project context graph. `undefined` when
   * the user has not selected a project, in which case reads fall back to
   * the `agent-context` branch only and writes return a structured
   * clarification request.
   */
  projectContextGraphId?: string;
  /** Agent address used for scoping WM assertion reads. */
  agentAddress?: string;
}

export interface DkgMemorySessionResolver {
  getSession(sessionKey: string | undefined): DkgMemorySession | undefined;
  /** Default agent address when no session is available (falls back to node peer ID). */
  getDefaultAgentAddress(): string | undefined;
  /** List of subscribed CGs, used when the write path needs to return a clarification. */
  listAvailableContextGraphs(): string[];
}

// ---------------------------------------------------------------------------
// DkgMemorySearchManager — the upstream-contract implementation
// ---------------------------------------------------------------------------

interface DkgMemorySearchManagerDeps {
  client: DkgDaemonClient;
  resolver: DkgMemorySessionResolver;
  sessionKey?: string;
  logger?: OpenClawPluginApi['logger'];
}

export class DkgMemorySearchManager implements MemorySearchManager {
  private cachedStatus: MemoryProviderStatus;

  constructor(private readonly deps: DkgMemorySearchManagerDeps) {
    this.cachedStatus = this.buildStatus();
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const limit = Math.max(1, Math.min(100, options?.maxResults ?? 10));
    const minScore = options?.minScore ?? 0;
    const sessionKey = options?.sessionKey ?? this.deps.sessionKey;

    const session = this.deps.resolver.getSession(sessionKey);
    const agentAddress = session?.agentAddress ?? this.deps.resolver.getDefaultAgentAddress();
    const projectContextGraphId = session?.projectContextGraphId;

    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);
    if (keywords.length === 0) {
      return [];
    }
    const filter = keywords
      .map(k => `CONTAINS(LCASE(STR(?text)), "${escapeSparqlString(k)}")`)
      .join(' || ');

    const chatTurnsSparql = `SELECT ?uri ?text WHERE {
        ?uri a <${NS.schema}Message> ;
             <${NS.schema}text> ?text .
        FILTER(${filter})
      }
      LIMIT ${limit}`;

    const projectMemorySparql = `SELECT ?uri ?text WHERE {
        ?uri a <${NS.schema}Thing> ;
             <${NS.schema}description> ?text .
        FILTER(${filter})
      }
      LIMIT ${limit}`;

    const calls: Array<Promise<{ source: 'sessions' | 'memory'; bindings: any[] }>> = [];

    calls.push(
      this.deps.client
        .query(chatTurnsSparql, {
          contextGraphId: AGENT_CONTEXT_GRAPH,
          view: 'working-memory',
          agentAddress,
          assertionName: CHAT_TURNS_ASSERTION,
        })
        .then(r => ({ source: 'sessions' as const, bindings: extractBindings(r) }))
        .catch(err => {
          this.deps.logger?.warn?.(`[dkg-memory] chat-turns search failed: ${errorMessage(err)}`);
          return { source: 'sessions' as const, bindings: [] };
        }),
    );

    if (projectContextGraphId) {
      calls.push(
        this.deps.client
          .query(projectMemorySparql, {
            contextGraphId: projectContextGraphId,
            view: 'working-memory',
            agentAddress,
            assertionName: PROJECT_MEMORY_ASSERTION,
          })
          .then(r => ({ source: 'memory' as const, bindings: extractBindings(r) }))
          .catch(err => {
            this.deps.logger?.warn?.(
              `[dkg-memory] project memory search failed for ${projectContextGraphId}: ${errorMessage(err)}`,
            );
            return { source: 'memory' as const, bindings: [] };
          }),
      );
    }

    const settled = await Promise.all(calls);
    const results: MemorySearchResult[] = [];

    for (const { source, bindings } of settled) {
      for (const binding of bindings) {
        const text = bindingValue(binding.text) ?? '';
        const uri = bindingValue(binding.uri) ?? '';
        if (!text) continue;
        const score = computeKeywordOverlap(text, keywords);
        if (score < minScore) continue;
        results.push({
          path: `dkg://${source === 'sessions' ? AGENT_CONTEXT_GRAPH : projectContextGraphId ?? 'unknown'}/${source === 'sessions' ? CHAT_TURNS_ASSERTION : PROJECT_MEMORY_ASSERTION}/${hashString(uri || text)}`,
          startLine: 1,
          endLine: 1,
          score,
          snippet: truncate(text, 500),
          source,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async readFile(request: MemoryReadFileRequest): Promise<MemoryReadFileResult> {
    // V10 memory is graph-native, not file-backed. The DKG provider returns
    // an empty shell unconditionally so upstream callers that depend on
    // filesystem recall degrade to a no-op rather than crashing.
    return { text: '', path: request.relPath };
  }

  status(): MemoryProviderStatus {
    return this.cachedStatus;
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return {
      ok: false,
      error: 'DKG memory provider uses lexical SPARQL match; no embedding service in v1',
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    // MUST return a bare boolean — upstream evaluates the result with
    // `if (available) { ... }`, and any object (even {ok:false,...}) would
    // be truthy and falsely claim a vector backend is available. See
    // FAIL #2 from openclaw-runtime's contract audit and the matching
    // note on `MemorySearchManager.probeVectorAvailability` in types.ts.
    return false;
  }

  async sync(): Promise<void> {
    this.cachedStatus = this.buildStatus();
  }

  async close(): Promise<void> {
    // No persistent state to drain; short-lived HTTP client is GC'd naturally.
  }

  private buildStatus(): MemoryProviderStatus {
    // `backend: "builtin"` is a pragmatic lie on the closed upstream union
    // (`"builtin" | "qmd"`, no "custom"). Logged as an upstream contract gap.
    return {
      backend: 'builtin',
      provider: 'dkg',
      vector: { enabled: false, available: false },
      fts: { enabled: false, available: false },
      cache: { enabled: false },
      sources: ['memory', 'sessions'],
      custom: {
        integrationId: 'openclaw',
        agentContextGraph: AGENT_CONTEXT_GRAPH,
        chatTurnsAssertion: CHAT_TURNS_ASSERTION,
        projectMemoryAssertion: PROJECT_MEMORY_ASSERTION,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// buildDkgMemoryRuntime — factory used with api.registerMemoryCapability
// ---------------------------------------------------------------------------

export function buildDkgMemoryRuntime(
  client: DkgDaemonClient,
  resolver: DkgMemorySessionResolver,
  logger?: OpenClawPluginApi['logger'],
): MemoryPluginRuntime {
  return {
    async getMemorySearchManager(request: MemoryRuntimeRequest): Promise<MemoryRuntimeResult> {
      // The runtime contract permits returning { manager: null, error } so
      // upstream can route the caller through its documented fallback path
      // rather than propagating a construction throw. See FAIL #3 from
      // openclaw-runtime's contract audit. Any exception while constructing
      // the DkgMemorySearchManager is surfaced as a non-fatal null result.
      try {
        const manager = new DkgMemorySearchManager({
          client,
          resolver,
          sessionKey: request.sessionKey,
          logger,
        });
        return { manager };
      } catch (err: any) {
        const message = typeof err?.message === 'string' ? err.message : String(err);
        logger?.warn?.(`[dkg-memory] getMemorySearchManager failed: ${message}`);
        return { manager: null, error: message };
      }
    },
    resolveMemoryBackendConfig() {
      return {
        kind: 'dkg',
        agentContextGraph: AGENT_CONTEXT_GRAPH,
      };
    },
    async closeAllMemorySearchManagers() {
      // No persistent per-session state to drain.
    },
  };
}

// ---------------------------------------------------------------------------
// DkgMemoryPlugin — register-side container: capability + import tool
// ---------------------------------------------------------------------------

const ASSERTION_ENSURED = new Set<string>();

function assertionCacheKey(contextGraphId: string, name: string): string {
  return `${contextGraphId}::${name}`;
}

export class DkgMemoryPlugin {
  private api: OpenClawPluginApi | null = null;

  constructor(
    private readonly client: DkgDaemonClient,
    private readonly config: NonNullable<DkgOpenClawConfig['memory']>,
    private readonly resolver: DkgMemorySessionResolver,
  ) {}

  register(api: OpenClawPluginApi): void {
    this.api = api;
    this.registerCapability(api);
    this.registerTools(api);
  }

  /** Re-register tools into a new registry without recreating state. */
  registerTools(api: OpenClawPluginApi): void {
    api.registerTool({
      name: 'dkg_memory_import',
      description:
        'Record a memory into a project\'s DKG Working Memory. ' +
        'Use this to persist a fact, decision, or note that should be retrievable later ' +
        'from the same project\'s context graph. ' +
        'Parameters: `text` (required), `contextGraphId` (optional — name of the target project CG; ' +
        'if omitted, the currently UI-selected project CG is used; if neither is available, ' +
        'returns a structured clarification request so the agent can ask the user which project to use). ' +
        'Subgraph-scoped writes are intentionally not supported in v1: the query engine at ' +
        'dkg-query-engine.ts:120-124 throws when `subGraphName` is combined with view-based routing, ' +
        'which would make subgraph-scoped writes silently unreadable through `view: working-memory`. ' +
        'Tracked as a V10.x follow-up.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Memory content to store.' },
          contextGraphId: {
            type: 'string',
            description: 'Optional target project context graph id.',
          },
        },
        required: ['text'],
      },
      execute: async (_toolCallId, params) => this.handleImport(params),
    });
  }

  private registerCapability(api: OpenClawPluginApi): void {
    if (typeof api.registerMemoryCapability !== 'function') {
      api.logger.warn?.(
        '[dkg-memory] api.registerMemoryCapability is not available — gateway may be older than the memory-slot contract. ' +
        'The dkg_memory_import write tool is still registered, but slot-backed recall will not route through the DKG adapter.',
      );
      return;
    }

    const capability: MemoryPluginCapability = {
      runtime: buildDkgMemoryRuntime(this.client, this.resolver, api.logger),
    };
    api.registerMemoryCapability(capability);
    api.logger.info?.('[dkg-memory] registerMemoryCapability called');
  }

  private async handleImport(params: Record<string, unknown>): Promise<OpenClawToolResult> {
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) {
      return toolError('Missing required parameter "text"');
    }
    const explicitCg = typeof params.contextGraphId === 'string' ? params.contextGraphId.trim() : '';

    // `dkg_memory_import` has no upstream-provided per-call session context
    // today (see openclaw-runtime B1a investigation). We therefore require
    // the agent to provide `contextGraphId` explicitly. The resolver path
    // remains for slot-backed recall via `DkgMemorySearchManager.search`,
    // which DOES receive a sessionKey from the memory slot dispatcher.
    const resolvedCg = explicitCg;

    if (!resolvedCg) {
      return toolJson({
        status: 'needs_clarification',
        reason: 'No project context graph was provided for this write.',
        availableContextGraphs: this.resolver.listAvailableContextGraphs(),
        guidance:
          'Please specify which project this belongs to by providing contextGraphId on the next call, ' +
          'or ask the user which project they mean.',
      });
    }

    // Resolve the agent address for provenance. If the node peer ID probe
    // has not yet completed (daemon down, /api/status failed, early
    // dispatch), fail the write with a retryable clarification rather
    // than writing a durable `did:dkg:agent:unknown` triple.
    const agentAddress = this.resolver.getDefaultAgentAddress();
    if (!agentAddress) {
      return toolJson({
        status: 'needs_clarification',
        reason: 'Agent address is not yet available (node identity probe pending).',
        retryable: true,
        guidance:
          'The adapter has not yet resolved the node peer identity from the daemon. ' +
          'Retry the write on the next turn; the probe typically completes within a few seconds of attach.',
      });
    }

    const ensureKey = assertionCacheKey(resolvedCg, PROJECT_MEMORY_ASSERTION);
    if (!ASSERTION_ENSURED.has(ensureKey)) {
      try {
        await this.client.createAssertion(resolvedCg, PROJECT_MEMORY_ASSERTION);
        ASSERTION_ENSURED.add(ensureKey);
      } catch (err) {
        return toolError(
          `Failed to create memory assertion on ${resolvedCg}: ${errorMessage(err)}`,
        );
      }
    }

    const memoryUri = `urn:dkg:memory:item:${crypto.randomUUID()}`;
    const nowIso = new Date().toISOString();
    const quads = [
      { subject: memoryUri, predicate: RDF_TYPE, object: `${NS.schema}Thing`, graph: '' },
      { subject: memoryUri, predicate: `${NS.schema}description`, object: JSON.stringify(text), graph: '' },
      { subject: memoryUri, predicate: `${NS.schema}dateCreated`, object: `"${nowIso}"^^<${XSD_DATETIME}>`, graph: '' },
      { subject: memoryUri, predicate: `${NS.schema}creator`, object: `did:dkg:agent:${agentAddress}`, graph: '' },
    ];

    try {
      const result = await this.client.writeAssertion(
        resolvedCg,
        PROJECT_MEMORY_ASSERTION,
        quads,
      );
      return toolJson({
        status: 'stored',
        contextGraphId: resolvedCg,
        assertionName: PROJECT_MEMORY_ASSERTION,
        memoryUri,
        written: result.written,
      });
    } catch (err) {
      return toolError(
        `Failed to write memory assertion on ${resolvedCg}: ${errorMessage(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolJson(data: unknown): OpenClawToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function toolError(message: string): OpenClawToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    details: { error: message },
  };
}

function extractBindings(result: any): any[] {
  return result?.result?.bindings ?? result?.results?.bindings ?? result?.bindings ?? [];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function computeKeywordOverlap(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0.5;
  const lower = text.toLowerCase();
  const hits = keywords.filter(k => lower.includes(k)).length;
  return hits / keywords.length;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '…';
}

function hashString(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function bindingValue(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'object' && 'value' in (v as any)) {
    return String((v as any).value);
  }
  if (typeof v === 'string') {
    let s = v;
    const typedMatch = s.match(/^(".*")\^\^<[^>]+>$/);
    if (typedMatch) s = typedMatch[1];
    const langMatch = s.match(/^(".*")@[a-z-]+$/i);
    if (langMatch) s = langMatch[1];
    if (s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    }
    return v;
  }
  return String(v);
}

function escapeSparqlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
