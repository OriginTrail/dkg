/**
 * OpenClaw plugin API types + DKG integration types.
 *
 * Upstream memory types in the bottom half of this file are vendored from
 * the OpenClaw source tree — `src/plugins/memory-state.ts` and
 * `packages/memory-host-sdk/src/host/types.ts` at commit
 * `dae060390b1d17aa949c4a1a0c12fbc3b1eedb79`. `@openclaw/plugin-sdk` does
 * not publicly export memory types, so they are mirrored here instead of
 * imported. Resync on OpenClaw minor-version bumps.
 */

// ---------------------------------------------------------------------------
// Core OpenClaw plugin API surface
// ---------------------------------------------------------------------------

export interface OpenClawPluginApi {
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registrationMode?: 'full' | 'setup-only' | 'setup-runtime' | 'cli-metadata';
  registerTool(tool: OpenClawTool): void;
  registerHook(event: string, handler: (...args: any[]) => Promise<void>, opts?: { name: string }): void;
  /**
   * Register a typed-hook handler. The OpenClaw upstream
   * (`openclaw/src/plugins/registry.ts:registerTypedHook` →
   * `registry.typedHooks` → `hooks.ts:runModifyingHook`) sequentially
   * awaits handlers and reads their return value: modifying hooks like
   * `before_prompt_build` honor `{ appendSystemContext, ... }`, and
   * fire-and-forget hooks like `agent_end` ignore the return.
   *
   * The signature accepts `unknown | Promise<unknown>` to match this
   * contract — the previous `=> void` was an under-specification that
   * masked the dependency on return-value propagation (R16.1).
   */
  on(event: string, handler: (...args: any[]) => unknown | Promise<unknown>): void;
  logger: { info?(...args: any[]): void; warn?(...args: any[]): void; debug?(...args: any[]): void };

  /** Register a bidirectional channel plugin. */
  registerChannel?(opts: { plugin: OpenClawChannelAdapter; dock?: unknown }): void;

  /** Register an HTTP route on the gateway. */
  registerHttpRoute?(route: {
    method: string;
    path: string;
    auth?: string;
    handler: (req: any, res: any) => Promise<void> | void;
  }): void;

  /** Register a long-running background service. */
  registerService?(service: {
    name: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void;

  /** Route an inbound channel message through the session system. */
  routeInboundMessage?(message: ChannelInboundMessage): Promise<ChannelOutboundReply>;

  /**
   * Register the memory-slot capability. Optional on the type so adapters
   * can feature-detect older gateway versions at runtime.
   */
  registerMemoryCapability?(capability: MemoryPluginCapability): void;

  /** Workspace directory path (set by gateway). */
  workspaceDir?: string;
}

export interface OpenClawTool {
  name: string;
  description: string;
  parameters: JSONSchemaObject;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<OpenClawToolResult>;
}

export interface JSONSchemaObject {
  type: 'object';
  /**
   * Property `type` matches the JSON Schema Draft 7 shape: either a
   * single primitive type name or an array of alternative type names
   * (e.g. `['number', 'string']` for a field that accepts both a
   * numeric literal and a stringified-numeric value). Codex Bug B35
   * required the array form on the compat `dkg_memory_search` tool
   * so legacy callers passing stringified numerics can pass
   * schema-validation on hosts that actually enforce the schema.
   */
  properties: Record<
    string,
    { type: string | string[]; description?: string; items?: any; enum?: string[] }
  >;
  required?: string[];
}

export interface OpenClawToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Channel types
// ---------------------------------------------------------------------------

/** Inbound message from an external channel into OpenClaw. */
export interface ChannelInboundMessage {
  /** Channel name (e.g. "dkg-ui"). */
  channelName: string;
  /** Sender identifier within the channel. */
  senderId: string;
  /** Whether the sender is the agent owner (bypasses permission checks). */
  senderIsOwner?: boolean;
  /** Message text. */
  text: string;
  /** Correlation ID for request-reply tracking. */
  correlationId?: string;
}

/** Outbound reply from OpenClaw to an external channel. */
export interface ChannelOutboundReply {
  /** Correlation ID matching the inbound message. */
  correlationId?: string;
  /** Reply text. */
  text: string;
  /** Session-internal turn ID. */
  turnId?: string;
  /** Tool calls made during this turn. */
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
}

/**
 * Channel adapter interface.
 *
 * Mirrors OpenClaw's ChannelPlugin contract — channels are bidirectional
 * message transports.  The adapter registers one of these per channel.
 */
export interface OpenClawChannelAdapter {
  /** Channel identifier (must be unique across registered channels). */
  id: string;
  /** Display name for the channel. */
  name: string;
  /** Channel metadata. */
  meta?: { displayName?: string; [key: string]: unknown };
  /** Channel capabilities. */
  capabilities?: Record<string, unknown>;
  /** Channel account/config adapter expected by current OpenClaw runtimes. */
  config?: {
    listAccountIds(cfg: any): string[];
    resolveAccount(cfg: any, accountId?: string): Record<string, unknown>;
    defaultAccountId?(cfg: any): string;
    isEnabled?(account: Record<string, unknown>, cfg: any): boolean;
    isConfigured?(account: Record<string, unknown>, cfg: any): boolean | Promise<boolean>;
    describeAccount?(account: Record<string, unknown>, cfg: any): Record<string, unknown>;
    disabledReason?(account: Record<string, unknown>, cfg: any): string;
    unconfiguredReason?(account: Record<string, unknown>, cfg: any): string;
  };
  /** Called when the gateway starts.  Set up transport here. */
  start?(): Promise<void>;
  /** Called when the gateway stops.  Tear down transport. */
  stop?(): Promise<void>;
  /**
   * Called by the gateway when the agent produces a reply for this channel.
   * The adapter should deliver it via its transport.
   */
  onOutbound?(reply: ChannelOutboundReply): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vendored upstream memory types
// ---------------------------------------------------------------------------
// Source: `src/plugins/memory-state.ts` + `packages/memory-host-sdk/src/host/types.ts`
// at OpenClaw commit `dae060390b1d17aa949c4a1a0c12fbc3b1eedb79`.
// Resync on minor-version bumps.
// ---------------------------------------------------------------------------

/** Discriminator for where a `MemorySearchResult` originated. */
export type MemorySource = 'memory' | 'sessions';

/**
 * Narrower adapter-local discriminant identifying which of the six
 * retrieval layers produced a hit:
 *   - `agent-context-wm`: agent-context graph, working-memory view
 *   - `agent-context-swm`: agent-context graph, shared-working-memory view
 *   - `agent-context-vm`: agent-context graph, verified-memory view
 *   - `project-wm`: user-selected project graph, working-memory view
 *   - `project-swm`: user-selected project graph, shared-working-memory view
 *   - `project-vm`: user-selected project graph, verified-memory view
 *
 * Note the rename from the earlier `chat-turns-wm` layer: the slot-backed
 * fan-out no longer pins on the `chat-turns` assertion, so the layer
 * name describes the context graph + view pair rather than a specific
 * assertion. Chat-turn content still lands in `agent-context-wm` because
 * `ChatMemoryManager.storeChatExchange` writes into the `chat-turns`
 * assertion under the agent's WM namespace — it's included in the WM
 * view's graph-prefix scan along with any other literals the agent has
 * written into the agent-context graph.
 *
 * Kept as an optional, non-upstream field on `MemorySearchResult` so the
 * closed upstream `source` union (`memory | sessions`) stays intact while
 * adapter internals (trust-weighted ranking, dedup across layers, test
 * assertions) can distinguish VM from SWM from WM without re-parsing `path`.
 */
export type MemoryLayer =
  | 'agent-context-wm'
  | 'agent-context-swm'
  | 'agent-context-vm'
  | 'project-wm'
  | 'project-swm'
  | 'project-vm';

/**
 * Upstream search result shape. `path` is an opaque identifier (file path or
 * graph-backed synthetic URI). `startLine`/`endLine` are `1` for graph-backed
 * backends that have no natural line concept. `snippet` is the matched text,
 * typically truncated. `source` distinguishes per-project memory hits from
 * session-history hits. `layer` is an adapter-local, non-upstream discriminant
 * that pins the specific retrieval layer (chat-turns WM / project WM / SWM /
 * VM) — populated by `DkgMemorySearchManager` for trust-weighted ranking and
 * dedup without widening the closed upstream `source` union. `citation` is a
 * free-form string per upstream `packages/memory-host-sdk/src/host/types.ts:3-10`
 * — do not promote to a structured object without checking upstream first.
 */
export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  layer?: MemoryLayer;
  citation?: string;
}

/** Search opts the memory slot passes through. */
export interface MemorySearchOptions {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
  /**
   * T74 — Observability tag. Identifies the caller in the
   * `[dkg-memory] search fired (caller=…)` log line so operators can
   * distinguish W3 auto-recall hook firings from explicit `memory_search`
   * tool calls (and other future callers). Free-form short string;
   * defaults to `'unknown'` when not supplied.
   */
  caller?: string;
}

/**
 * Upstream `readFile` request shape. Non-nullable return per upstream contract
 * (`readFile` cannot signal "not found" structurally — callers must inspect
 * `text`). V10 memory is graph-native, so the DKG provider returns an empty
 * shell unconditionally.
 */
export interface MemoryReadFileRequest {
  relPath: string;
  from?: number;
  lines?: number;
}

export interface MemoryReadFileResult {
  text: string;
  path: string;
}

/**
 * Synchronous status block returned by `MemorySearchManager.status()`.
 * `backend` is a closed union (`"builtin" | "qmd"`) in the upstream contract;
 * the DKG provider reports `"builtin"` as a pragmatic lie because no
 * `"custom"` option exists upstream. Logged as an upstream gap.
 */
export interface MemoryProviderStatus {
  backend: 'builtin' | 'qmd';
  provider: string;
  model?: string;
  vector?: { enabled: boolean; available: boolean };
  fts?: { enabled: boolean; available: boolean };
  cache?: { enabled: boolean };
  batch?: { enabled: boolean };
  sources?: readonly MemorySource[];
  workspaceDir?: string;
  custom?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Upstream probe result shape. The only documented fields are `ok` and an
 * optional `error` string. No structured `notAvailable` field — logged as an
 * upstream gap.
 */
export interface MemoryEmbeddingProbeResult {
  ok: boolean;
  error?: string;
}

/**
 * Upstream `MemorySearchManager` contract — what `registerMemoryCapability`
 * expects from a plugin's memory runtime. The DKG provider implements this
 * against real V10 primitives (assertion-scoped WM SPARQL queries) rather
 * than the file-backed pattern `memory-core` / `memory-lancedb` use.
 *
 * NOTE on the probe return-type asymmetry: upstream declares
 * `probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>` but
 * `probeVectorAvailability(): Promise<boolean>`. Do not "normalize" the
 * shapes — a bare boolean `false` from `probeVectorAvailability` is
 * mandatory because upstream evaluates the result with `if (available) …`
 * and a `{ok:false,error:…}` object is truthy, which would silently claim
 * a vector backend is available when it is not. FAIL #2 from
 * openclaw-runtime's audit catches exactly this.
 */
export interface MemorySearchManager {
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;
  readFile(request: MemoryReadFileRequest): Promise<MemoryReadFileResult>;
  status(): MemoryProviderStatus;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  sync?(): Promise<void>;
  close?(): Promise<void>;
}

/** Factory call parameters — upstream passes cfg + agent + session. */
export interface MemoryRuntimeRequest {
  cfg?: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
  purpose?: string;
}

/**
 * Factory result — a search manager plus optional non-fatal error.
 *
 * `manager` is nullable: when the plugin cannot build a manager for a
 * given request (daemon down, session resolution failure, transient
 * dependency unavailable), upstream accepts `{ manager: null, error:
 * "..." }` and routes the caller through a fallback instead of crashing.
 * FAIL #3 from openclaw-runtime's audit: the type was previously
 * non-nullable, which would have forced a construction throw in those
 * paths rather than the documented graceful-decline contract.
 *
 * Upstream internally wraps `MemorySearchManager` as
 * `RegisteredMemorySearchManager` — openclaw-runtime hasn't traced the
 * wrapper fields yet, but the runtime contract accepts a bare
 * `MemorySearchManager` because upstream's loader wraps it. Resync this
 * type if a future audit finds the bare shape no longer satisfies the
 * registration call.
 */
export interface MemoryRuntimeResult {
  manager: MemorySearchManager | null;
  error?: string;
}

/**
 * Upstream `MemoryPluginRuntime` shape. `getMemorySearchManager` is the
 * per-(cfg, agentId, sessionKey) factory; a slot-filling plugin is expected
 * to return a manager instance or an error-wrapped null manager.
 */
export interface MemoryPluginRuntime {
  getMemorySearchManager(request: MemoryRuntimeRequest): Promise<MemoryRuntimeResult>;
  resolveMemoryBackendConfig?(request: { cfg?: Record<string, unknown>; agentId?: string }): Record<string, unknown>;
  closeAllMemorySearchManagers?(): Promise<void>;
}

/**
 * Prompt-section builder — emits the memory region of the system prompt.
 * Called synchronously during prompt assembly.
 */
export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: string;
}) => string[];

/**
 * Full capability object handed to `api.registerMemoryCapability`. All four
 * fields optional — the minimum is `{ runtime }`, which is what the DKG
 * adapter registers.
 */
export interface MemoryPluginCapability {
  runtime?: MemoryPluginRuntime;
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: (params: { cfg?: Record<string, unknown>; nowMs?: number }) => unknown;
  publicArtifacts?: { listArtifacts: (...args: any[]) => Promise<unknown> };
}

// ---------------------------------------------------------------------------
// DKG adapter config
// ---------------------------------------------------------------------------

export interface DkgOpenClawConfig {
  /** DKG daemon HTTP URL (default: "http://127.0.0.1:9200"). */
  daemonUrl?: string;

  /**
   * Explicit DKG home directory for the daemon the adapter targets via
   * `daemonUrl`. T42 — when set, the adapter reads the agent eth address
   * from `<dkgHome>/agent-keystore.json` regardless of the gateway
   * process's own `DKG_HOME` env. This is the explicit override for
   * "localhost daemon started with `dkg start --home /custom/path`",
   * service-unit-managed daemons, or container-isolated daemons where
   * the gateway's filesystem cannot see the daemon's home dir at the
   * default path. Falls back to `process.env.DKG_HOME` when undefined.
   * Ignored when `daemonUrl` is non-localhost (the localhost gate
   * still applies — remote daemons need the `DKG_AGENT_ADDRESS` env
   * override or the future daemon endpoint).
   */
  dkgHome?: string;

  /**
   * Explicit adapter state directory for file-backed runtime state such as
   * ChatTurnWriter watermarks. Setup writes a workspace-scoped default when
   * it can discover the workspace. Runtime honors this after gateway/env
   * state sources and before falling back to `api.workspaceDir` or
   * `~/.openclaw`.
   */
  stateDir?: string;

  /** DKG memory integration config. */
  memory?: {
    enabled?: boolean;
    /**
     * @deprecated v0/Phase-0 file-watcher config. Retained for backward
     * compatibility with existing workspace configs; ignored by v1.
     */
    memoryDir?: string;
    /**
     * @deprecated v0/Phase-0 file-watcher config. Retained for backward
     * compatibility with existing workspace configs; ignored by v1.
     */
    watchDebounceMs?: number;
  };

  /** DKG UI channel bridge config. */
  channel?: {
    enabled?: boolean;
    /**
     * Port for the channel bridge HTTP server.
     * Only used if `api.registerHttpRoute` is not available.
     * Default: 9201.
     */
    port?: number;
  };
}
