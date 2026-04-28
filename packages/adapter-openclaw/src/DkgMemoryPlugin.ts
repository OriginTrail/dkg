/**
 * DkgMemoryPlugin — DKG-backed memory-slot plugin for OpenClaw.
 *
 * Reads AND writes flow through the memory slot contract:
 *   `api.registerMemoryCapability({ runtime: buildDkgMemoryRuntime(...) })`
 * which hands the upstream memory host a `MemorySearchManager` instance.
 * `DkgMemorySearchManager.search()` fans out across four layers when a
 * project context graph is resolved — one `POST /api/query` to
 * `agent-context` (`assertionName: 'chat-turns'`, `view: 'working-memory'`)
 * plus three against the resolved project CG's `'memory'` assertion with
 * `view: 'working-memory' | 'shared-working-memory' | 'verified-memory'`.
 * See `DkgMemorySearchManager.search` for trust-weighted ranking and
 * cross-layer dedup.
 *
 * Writes happen through the upstream memory-host write contract on the
 * same slot registration (upstream recall orchestrates `saveMemory` /
 * `recallMemory` against the capability runtime). This adapter no longer
 * registers explicit `dkg_memory_import` / `dkg_memory_search` tools —
 * the slot is the single entry point for both directions. Programmatic
 * callers can still construct a `DkgMemorySearchManager` directly for
 * read-side access (see the barrel export in `src/index.ts`).
 *
 * Reads target real V10 primitives:
 *   read:   POST /api/query   (with view + agentAddress + assertionName)
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
  MemoryLayer,
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
  MemorySource,
  OpenClawPluginApi,
} from './types.js';

// ---------------------------------------------------------------------------
// Conventions — addresses, assertion names, RDF vocabulary
// ---------------------------------------------------------------------------

export const AGENT_CONTEXT_GRAPH = 'agent-context';
export const CHAT_TURNS_ASSERTION = 'chat-turns';
export const PROJECT_MEMORY_ASSERTION = 'memory';

function buildDkgMemoryPromptSections(): string[] {
  return [
    'DKG memory rules:',
    '- To inspect whether a project has data, check all three layers explicitly: `working-memory`, `shared-working-memory`, and `verified-memory`.',
    '- If the user asks to share a private project with a friend, prefer the full join UX: generate an invite code first, then add the friend to the allowlist when you have their agent address.',
    '- If you have both a peer ID and an agent address for a private-project share, do both automatically: return the invite code and add the participant.',
    '- If you only have an agent address, explain that allowlisting is not the full UI join flow and ask for the peer ID if the user wants a paste-into-Join invite code.',
    '- For `working-memory`, prefer the injected `current_agent_address` from the turn context when present.',
    '- If `current_agent_address` is absent, use the local node\'s default `agent_address` fallback.',
    '- Do not assume a libp2p peer ID is the correct WM identity unless the tool or graph naming proves it.',
    '- If a WM read comes back empty but the user expects data, retry with alternate identity forms before concluding the project is empty: wallet/address form first, then DID form, then peer ID if needed.',
    '- Do not claim a project is empty until you have exhausted WM identity variants and also checked SWM and VM.',
  ];
}

const NS = {
  schema: 'http://schema.org/',
};

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
  /**
   * Force a synchronous refresh of the subscribed-CG cache and return
   * the refreshed list. Optional — resolvers that cannot refresh on
   * demand (e.g. test fixtures with a fixed list, or legacy wirings
   * without network access) can omit this method and callers will
   * fall through to the synchronous `listAvailableContextGraphs()`
   * result. Codex Bug B46: `dkg_memory_import` uses this to retry
   * the subscribed-list guard against a freshly-probed cache when
   * the initial cached list does not contain a just-created CG, so
   * legitimate brand-new subscriptions are not rejected during the
   * TTL window of the cache that normally refreshes lazily.
   */
  refreshAvailableContextGraphs?(): Promise<string[]>;
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

  /**
   * Narrow recall for W3 `before_prompt_build` auto-injection. Restricted
   * to WM-only tiers (agent-context working-memory + project working-
   * memory when resolved) — see Codex feedback (R-trust-boundary):
   * SWM and VM views surface peer-authored content from other agents
   * on the network. Injecting that into every prompt's system context
   * widens the trust boundary from agent-owned WM to cross-peer memory
   * without an explicit tool call from the agent. Even with the
   * existing prompt-injection defenses (HTML-escape, untrusted-data
   * framing, sentinel-strip), implicit cross-peer injection violates
   * least-privilege.
   *
   * The agent-callable `memory_search` tool keeps the full 6-layer
   * fan-out via `search()` below — that's an explicit recall request
   * the agent has chosen to make, and the tool's response framing is
   * read as data, not as system context.
   *
   * `wmOnly: false` is exposed as an opt-out for callers that
   * explicitly want the wider scope (today only used by the existing
   * `searchNarrow` test that asserted the legacy widened scope; future
   * callers should use `search()` instead unless they have a reason
   * to share `searchNarrow`'s tighter result cap).
   */
  async searchNarrow(
    query: string,
    options?: { maxResults?: number; minScore?: number; sessionKey?: string; wmOnly?: boolean },
  ): Promise<MemorySearchResult[]> {
    const cap = options?.maxResults ?? 5;
    const wmOnly = options?.wmOnly ?? true;
    return this.runSearch(query, { ...options, maxResults: cap, wmOnly });
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return this.runSearch(query, options);
  }

  private async runSearch(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    // B37: The clamped value is interpolated directly into the SPARQL
    // `LIMIT` clause below, so it must be an integer. A fractional
    // input like `2.5` would produce `LIMIT 2.5`, which is invalid
    // SPARQL and gets swallowed by the per-query `.catch` blocks as
    // an empty result set. `Math.floor` after the clamp keeps any
    // fractional caller intent ("give me roughly 2-3 results") mapped
    // to the nearest valid integer without breaking the query.
    const limit = Math.floor(Math.max(1, Math.min(100, options?.maxResults ?? 10)));
    const minScore = options?.minScore ?? 0;
    const sessionKey = options?.sessionKey ?? this.deps.sessionKey;

    const session = this.deps.resolver.getSession(sessionKey);
    const rawAgentAddress = session?.agentAddress ?? this.deps.resolver.getDefaultAgentAddress();
    // B43: Normalize to the raw peer-ID form for WM view routing. The
    // daemon's query engine uses the raw peer ID (not the DID form)
    // when constructing assertion-graph URIs for `view: 'working-memory'`
    // reads. Resolver implementations are not contractually required
    // to strip the `did:dkg:agent:` prefix, so we do it here at the
    // consumption boundary. `toAgentPeerId` is a no-op on already-raw
    // inputs, so passing a raw peer ID through the resolver still works.
    const agentAddress = rawAgentAddress ? toAgentPeerId(rawAgentAddress) : undefined;
    const projectContextGraphId = session?.projectContextGraphId;

    // B28: Preflight the agent address BEFORE firing WM queries. The query
    // engine at `packages/query/src/dkg-query-engine.ts:47-48` throws
    // `'agentAddress is required for the working-memory view'` on every
    // view-based read when `agentAddress` is falsy. The per-call `.catch`
    // blocks below swallow that throw and convert it to empty bindings,
    // which is indistinguishable from "no memories matched" to callers.
    // `buildDkgMemoryRuntime.getMemorySearchManager` (B12) and
    // `DkgMemoryPlugin.handleLegacySearch` (B15) already preflight for
    // their respective callers — the factory returns a null manager and
    // the legacy tool returns a retryable `needs_clarification`. This
    // preflight is the innermost safety net for direct consumers of
    // `DkgMemorySearchManager.search` (re-exported from the barrel for
    // programmatic use — see B24) so those callers do not silently see
    // `[]` either. Log distinctively at warn level so the "backend not
    // ready" state is diagnosable, and return `[]` early to avoid wasted
    // network round-trips.
    if (!agentAddress) {
      this.deps.logger?.warn?.(
        '[dkg-memory] DkgMemorySearchManager.search skipped: peer ID not yet available. ' +
        'Returning empty result set for this call; lazy re-probe has been scheduled by the resolver, ' +
        'so the next search after the probe lands will proceed normally.',
      );
      return [];
    }

    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);
    if (keywords.length === 0) {
      return [];
    }
    const filter = keywords
      .map(k => `CONTAINS(LCASE(STR(?text)), "${escapeSparqlString(k)}")`)
      .join(' || ');

    // Permissive SPARQL shape: find any subject with any literal object of
    // reasonable length that contains at least one keyword. No `rdf:type`
    // constraint, no specific predicate pin. This is the whole point of
    // the broadened fan-out — agents can write memories in whatever RDF
    // shape fits their domain (schema:description, rdfs:comment, custom
    // ontology predicates, typed or untyped subjects) and slot-backed
    // recall still finds them. The 20-character floor on `STRLEN(STR(?text))`
    // excludes tiny metadata literals (boolean flags, numeric enums, short
    // tags, single-word labels) that would otherwise be noise; any coherent
    // memory statement or chat message is longer than that. ISO datetimes
    // are exactly 20 characters and technically slip through, but they
    // rarely contain search keywords, so the substring filter naturally
    // excludes them.
    const permissiveSparql = `SELECT ?uri ?pred ?text WHERE {
        ?uri ?pred ?text .
        FILTER(isLiteral(?text))
        FILTER(STRLEN(STR(?text)) >= 20)
        FILTER(${filter})
      }
      LIMIT ${limit}`;

    // Fan-out layout: 3 queries against the agent-context CG (working,
    // shared, verified views) + (when a project CG is resolved) 3
    // queries against the project CG (same three views), for 3 or 6
    // queries per turn. The `assertionName` pin from the earlier
    // design is intentionally dropped: with `view: 'working-memory'`
    // and no assertion name, the query engine at
    // `packages/query/src/dkg-query-engine.ts:46-59` returns a graph
    // prefix spanning every assertion under the agent's namespace in
    // the CG, which includes the `chat-turns` assertion (where
    // `ChatMemoryManager.storeChatExchange` writes turn content) plus
    // any other assertions the agent may have written memories into.
    // SWM and VM views don't have assertion-level sub-graphing, so
    // omitting `assertionName` is a no-op on those — the scope is
    // already the whole shared-memory / verified-memory graph for
    // the CG.
    //
    // Each layer carries a trust weight that multiplies the keyword-
    // overlap score during ranking: VM×1.3, SWM×1.15, WM×1.0. The
    // weighting nudges verified memories ahead of working drafts when
    // raw lexical overlap is comparable, without hard-preempting WM
    // (a very strong WM match can still outrank a weak VM hit). The
    // same weighting applies uniformly across both context graphs —
    // there is no inherent trust advantage of agent-context over
    // project-scoped memories at the same view tier.
    //
    // Per-query `.catch → []` preserves partial-success semantics:
    // one failing (cg, view) pair emits exactly one warn and the
    // surviving layers continue to contribute results.
    interface LayerPlan {
      layer: MemoryLayer;
      source: MemorySource;
      trustWeight: number;
      contextGraphId: string;
      view: 'working-memory' | 'shared-working-memory' | 'verified-memory';
      sparql: string;
    }
    const plans: LayerPlan[] = [
      {
        layer: 'agent-context-wm',
        source: 'sessions',
        trustWeight: 1.0,
        contextGraphId: AGENT_CONTEXT_GRAPH,
        view: 'working-memory',
        sparql: permissiveSparql,
      },
      {
        layer: 'agent-context-swm',
        source: 'sessions',
        trustWeight: 1.15,
        contextGraphId: AGENT_CONTEXT_GRAPH,
        view: 'shared-working-memory',
        sparql: permissiveSparql,
      },
      {
        layer: 'agent-context-vm',
        source: 'sessions',
        trustWeight: 1.3,
        contextGraphId: AGENT_CONTEXT_GRAPH,
        view: 'verified-memory',
        sparql: permissiveSparql,
      },
    ];
    if (projectContextGraphId) {
      plans.push(
        {
          layer: 'project-wm',
          source: 'memory',
          trustWeight: 1.0,
          contextGraphId: projectContextGraphId,
          view: 'working-memory',
          sparql: permissiveSparql,
        },
        {
          layer: 'project-swm',
          source: 'memory',
          trustWeight: 1.15,
          contextGraphId: projectContextGraphId,
          view: 'shared-working-memory',
          sparql: permissiveSparql,
        },
        {
          layer: 'project-vm',
          source: 'memory',
          trustWeight: 1.3,
          contextGraphId: projectContextGraphId,
          view: 'verified-memory',
          sparql: permissiveSparql,
        },
      );
    }

    // R-trust-boundary — when the caller is W3 auto-recall (`wmOnly:
    // true`, set by `searchNarrow`), strip SWM and VM tiers from the
    // plan list so cross-peer content is never injected into the system
    // prompt without an explicit `memory_search` tool call. Default
    // (`wmOnly: undefined` or `false`) keeps the full 6-layer fan-out
    // for the agent-callable `memory_search` path.
    const filteredPlans = options?.wmOnly === true
      ? plans.filter(p => p.view === 'working-memory')
      : plans;
    const settled = await Promise.all(
      filteredPlans.map(plan =>
        this.deps.client
          .query(plan.sparql, {
            contextGraphId: plan.contextGraphId,
            view: plan.view,
            agentAddress,
          })
          .then(r => ({ plan, bindings: extractBindings(r) }))
          .catch(err => {
            this.deps.logger?.warn?.(
              `[dkg-memory] ${plan.layer} search failed (cg=${plan.contextGraphId}, view=${plan.view}): ${errorMessage(err)}`,
            );
            return { plan, bindings: [] as any[] };
          }),
      ),
    );

    // Observability: one info-level log per search call showing the
    // query, resolved project CG, layer count, and per-layer raw hit
    // counts. This is the diagnostic we were missing during the
    // 2026-04-15 live validation — without it, a failed recall was
    // indistinguishable from "slot never called at all". The log
    // fires once per `search()` invocation regardless of whether any
    // layer returned hits, so operators can see the slot is alive
    // and reason about why specific queries aren't matching.
    const totalRawHits = settled.reduce((n, s) => n + s.bindings.length, 0);
    const perLayerBreakdown = settled
      .map(s => `${s.plan.layer}:${s.bindings.length}`)
      .join(', ');
    // Info-level log carries only counts and metadata — no user text.
    // The raw query is derived from user/assistant messages and may
    // contain secrets or PII, so it is logged at debug level only
    // (silent at default log verbosity).
    this.deps.logger?.info?.(
      `[dkg-memory] search fired: ` +
      `project=${projectContextGraphId ?? '∅'}, ` +
      `layers=${plans.length}, ` +
      `raw_hits=${totalRawHits} (${perLayerBreakdown})`,
    );
    this.deps.logger?.debug?.(
      `[dkg-memory] search query: "${truncate(query, 80)}"`,
    );

    // Dedup by (contextGraphId, uri), keeping the highest-trust layer
    // when the same memory URI surfaces through multiple views (a
    // verified memory that is still in the WM draft buffer is the
    // canonical example — it would otherwise occupy two result slots
    // with near-identical snippets). A VM hit collapses an SWM or WM
    // hit for the same URI; SWM collapses a WM hit. The weighted
    // `score * trustWeight` from the surviving layer is what ranks.
    // Trust tier is based on the view, not the context graph — a
    // verified-memory hit in agent-context ties with a verified-memory
    // hit in the project CG.
    const trustOrder: Record<MemoryLayer, number> = {
      'agent-context-vm': 3,
      'project-vm': 3,
      'agent-context-swm': 2,
      'project-swm': 2,
      'agent-context-wm': 1,
      'project-wm': 1,
    };
    const best = new Map<string, MemorySearchResult & { _rank: number }>();
    for (const { plan, bindings } of settled) {
      for (const binding of bindings) {
        const text = bindingValue(binding.text) ?? '';
        const uri = bindingValue(binding.uri) ?? '';
        if (!text) continue;
        const rawScore = computeKeywordOverlap(text, keywords);
        if (rawScore < minScore) continue;
        const weighted = rawScore * plan.trustWeight;
        const key = `${plan.contextGraphId}::${uri || hashString(text)}`;
        const candidate: MemorySearchResult & { _rank: number } = {
          path: `dkg://${plan.contextGraphId}/${plan.layer}/${hashString(uri || text)}`,
          startLine: 1,
          endLine: 1,
          score: rawScore,
          snippet: truncate(text, 500),
          source: plan.source,
          layer: plan.layer,
          _rank: weighted,
        };
        const existing = best.get(key);
        if (!existing) {
          best.set(key, candidate);
          continue;
        }
        // Higher trust layer always wins; ties broken by raw score.
        const existingTrust = trustOrder[existing.layer ?? 'project-wm'];
        const candidateTrust = trustOrder[candidate.layer ?? 'project-wm'];
        if (
          candidateTrust > existingTrust ||
          (candidateTrust === existingTrust && candidate.score > existing.score)
        ) {
          best.set(key, candidate);
        }
      }
    }

    const ranked = Array.from(best.values()).sort((a, b) => b._rank - a._rank);
    return ranked.slice(0, limit).map(({ _rank, ...rest }) => rest);
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
      //
      // B12: Pre-check the effective agent address BEFORE constructing the
      // manager. The query engine rejects working-memory reads without an
      // `agentAddress` (see packages/query/src/dkg-query-engine.ts:47-48),
      // so a manager handed back without a resolvable peer ID would turn
      // every early-turn search into a silently-caught throw and return
      // `[]` — indistinguishable from "no memories found" to the upstream
      // recall caller. Surface "backend not ready" via the null-manager
      // contract path instead so upstream uses its documented fallback.
      // `getDefaultAgentAddress()` also fires a best-effort lazy re-probe
      // (see B9's `ensureNodePeerId` wiring in DkgNodePlugin), so the
      // next dispatch recovers once the probe lands.
      const sessionAgentAddress = resolver.getSession(request.sessionKey)?.agentAddress;
      const defaultAgentAddress = resolver.getDefaultAgentAddress();
      const resolvedAgentAddress = sessionAgentAddress ?? defaultAgentAddress;
      if (!resolvedAgentAddress) {
        const error = 'peer ID not yet available — retry next dispatch';
        logger?.warn?.(
          `[dkg-memory] getMemorySearchManager returning null: ${error}. ` +
          'Upstream will use its fallback path; lazy re-probe has been scheduled.',
        );
        return { manager: null, error };
      }
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

/**
 * **BREAKING API CHANGE (openclaw-dkg-primary-memory workstream)** — the
 * exported `DkgMemoryPlugin` class no longer implements the legacy
 * `OpenClawMemorySearchManager` surface, and no longer registers
 * explicit `dkg_memory_import` / `dkg_memory_search` tools. Previous
 * revisions of this class exposed `search`, `readFile`, `status`,
 * `sync`, and `close` methods directly so external consumers could
 * instantiate a plugin and query it as a search manager. Those methods
 * have moved to the new `DkgMemorySearchManager` class (exported from
 * this same module), which is instantiated internally by
 * `buildDkgMemoryRuntime` when the gateway calls
 * `api.registerMemoryCapability`. See the module-level comment at the
 * top of this file for the slot-backed reads-and-writes architecture.
 *
 * The constructor signature has also changed from `(client, config)` to
 * `(client, config, resolver)` so the change is an unavoidable compile
 * break for any TypeScript consumer — we document it here explicitly
 * rather than shipping deprecated forwarding methods. External callers
 * that need programmatic search should either:
 *   1. register the plugin through the standard `DkgNodePlugin`
 *      lifecycle so reads route through the slot-backed recall path, or
 *   2. instantiate `DkgMemorySearchManager` directly with a
 *      `DkgMemorySessionResolver`, which gives the same search semantics
 *      the slot uses.
 *
 * The only in-tree consumer of this class is `DkgNodePlugin`.
 */
export class DkgMemoryPlugin {
  private registeredCapability: MemoryPluginCapability | null = null;
  private registeredApi: OpenClawPluginApi | null = null;

  constructor(
    private readonly client: DkgDaemonClient,
    private readonly config: NonNullable<DkgOpenClawConfig['memory']>,
    private readonly resolver: DkgMemorySessionResolver,
  ) {}

  register(api: OpenClawPluginApi): boolean {
    return this.registerCapability(api);
  }

  /**
   * Re-assert the memory-slot capability registration. Called by the
   * channel plugin right before each inbound turn dispatch to guarantee
   * this adapter's runtime is the active one, regardless of whether
   * memory-core's dreaming sidecar overwrote it during plugin loading.
   *
   * Cost: a single property assignment on a module-scoped object in the
   * OpenClaw gateway (`memoryPluginState.capability = { ... }`). No
   * allocations, no I/O, no async operations. Safe to call on every turn.
   */
  reAssertCapability(): void {
    try {
      if (this.registeredCapability && this.registeredApi &&
          typeof this.registeredApi.registerMemoryCapability === 'function') {
        this.registeredApi.registerMemoryCapability(this.registeredCapability);
      }
    } catch {
      // Non-fatal: if the re-assert fails (gateway state mismatch,
      // plugin teardown race), the turn proceeds with whatever
      // capability was last registered. Log omitted to avoid per-turn
      // noise — the initial registration log is the diagnostic anchor.
    }
  }

  /**
   * Invalidate the cached capability + api so subsequent
   * `reAssertCapability()` calls become no-ops.
   *
   * Called by `DkgNodePlugin` whenever a later `register()` call returns
   * `false` (slot ownership lost to another plugin). Without this clear,
   * the cached capability would persist and per-turn re-assert anchors
   * (`before_prompt_build`, `message:received`/`sent`, `memory_search`)
   * would silently steal the slot back from the newly elected provider.
   */
  invalidateRegistration(): void {
    this.registeredCapability = null;
    this.registeredApi = null;
  }

  /**
   * Whether this adapter currently owns the gateway memory slot. Returns
   * `false` when `registerCapability()` was skipped (e.g. another plugin
   * owns `plugins.slots.memory`) or after `invalidateRegistration()` is
   * called. Per-turn anchors (`before_prompt_build`, `memory_search`)
   * use this to avoid injecting DKG recall when the elected provider is
   * a different plugin.
   */
  isRegistered(): boolean {
    return this.registeredCapability !== null;
  }

  /**
   * Registers the memory-slot capability. Two gates must pass:
   *
   * 1. The gateway must expose `api.registerMemoryCapability` — older
   *    gateways predate the memory-slot contract and have no entry
   *    point to call.
   *
   * 2. The workspace config must have elected this adapter into the
   *    memory slot (`plugins.slots.memory === 'adapter-openclaw'`).
   *    Merely loading the plugin must not silently override whatever
   *    memory provider the operator elected via `dkg setup`; if the
   *    slot points at another plugin (or is unset), this adapter
   *    no-ops the registration and logs a diagnostic so the operator
   *    can rerun setup if they meant to elect it.
   */
  private registerCapability(api: OpenClawPluginApi): boolean {
    if (typeof api.registerMemoryCapability !== 'function') {
      api.logger.warn?.(
        '[dkg-memory] api.registerMemoryCapability is not available — gateway is older than the memory-slot contract. ' +
        'The adapter no longer ships a compatibility `dkg_memory_search` tool; upgrade the gateway to restore recall.',
      );
      return false;
    }

    if (!isMemorySlotOwnedByThisAdapter(api)) {
      api.logger.warn?.(
        '[dkg-memory] plugins.slots.memory is not set to "adapter-openclaw" in the workspace config — ' +
        'skipping memory-capability registration so this adapter does not silently override the elected ' +
        'memory provider. Rerun `dkg setup` to elect adapter-openclaw into the memory slot if that was the intent.',
      );
      return false;
    }

    const capability: MemoryPluginCapability = {
      promptBuilder: () => buildDkgMemoryPromptSections(),
      runtime: buildDkgMemoryRuntime(this.client, this.resolver, api.logger),
    };
    api.registerMemoryCapability(capability);
    this.registeredCapability = capability;
    this.registeredApi = api;
    const modeLabel = (api.registrationMode ?? 'full');
    api.logger.info?.(`[dkg-memory] registerMemoryCapability called (registrationMode=${modeLabel})`);
    return true;
  }
}

/**
 * Reads the workspace-config memory-slot owner and returns `true` only
 * when the slot is explicitly pointing at this adapter's plugin id
 * (`'adapter-openclaw'`, matching the manifest and the value setup.ts
 * writes during slot election).
 *
 * Some OpenClaw gateway versions expose the merged config on `api.cfg`
 * instead of `api.config` — `DkgChannelPlugin.register` already handles
 * this divergence, so mirror the same fallback order here to avoid
 * false negatives on those runtimes.
 */
function isMemorySlotOwnedByThisAdapter(api: OpenClawPluginApi): boolean {
  const anyApi = api as any;
  const runtime = anyApi?.runtime;
  const mergedConfig =
    (anyApi?.cfg as Record<string, unknown> | undefined) ??
    (anyApi?.config as Record<string, unknown> | undefined) ??
    (runtime?.cfg as Record<string, unknown> | undefined) ??
    (runtime?.config as Record<string, unknown> | undefined);
  const plugins = mergedConfig?.plugins as Record<string, unknown> | undefined;
  const slots = plugins?.slots as Record<string, unknown> | undefined;
  return slots?.memory === 'adapter-openclaw';
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBindings(result: any): any[] {
  return result?.result?.bindings ?? result?.results?.bindings ?? result?.bindings ?? [];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The DKG V10 agent identity shows up in two representations in this
 * package — the daemon's working-memory view routing uses the raw peer
 * ID (an alphanumeric/hex node fingerprint) for assertion-graph URI
 * scoping, while provenance triples (e.g. `schema:creator`) use the
 * canonical `did:dkg:agent:<peerId>` DID form. A consumer that passes
 * either representation into the resolver / tool surface must have
 * both forms normalized before being used at each site — otherwise
 * a DID-form input gets double-prefixed into
 * `did:dkg:agent:did:dkg:agent:...` for the creator triple, or the
 * WM view routing looks in an assertion graph scoped to a literal DID
 * string and finds nothing. Normalize once at the boundary and use
 * the correct form at each consumption site. Codex Bug B43.
 */
export const AGENT_DID_PREFIX = 'did:dkg:agent:';

/**
 * Return the raw peer-ID form used for WM view routing. Exported so
 * `DkgNodePlugin.handleQuery` can apply the same B43 normalization
 * before forwarding `agent_address` / the node peerId fallback to the
 * daemon (DID-form values otherwise route to a non-existent namespace
 * and return empty results).
 */
export function toAgentPeerId(agentAddress: string): string {
  return agentAddress.startsWith(AGENT_DID_PREFIX)
    ? agentAddress.slice(AGENT_DID_PREFIX.length)
    : agentAddress;
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
