/**
 * OpenClaw plugin API types + DKG integration types.
 *
 * These mirror the OpenClaw runtime API surface that plugins interact with.
 * The full types live in the OpenClaw runtime; these are the subset needed
 * to build a DKG adapter plugin.
 *
 * Types marked "(spike)" are based on documented OpenClaw APIs but have not
 * yet been tested against a live runtime.  Spike A / B validate them.
 */

// ---------------------------------------------------------------------------
// Core OpenClaw types (verified — used by existing DkgNodePlugin)
// ---------------------------------------------------------------------------

export interface OpenClawPluginApi {
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registerTool(tool: OpenClawTool): void;
  registerHook(event: string, handler: (...args: any[]) => Promise<void>, opts?: { name: string }): void;
  on(event: string, handler: (...args: any[]) => void): void;
  logger: { info?(...args: any[]): void; warn?(...args: any[]): void; debug?(...args: any[]): void };

  // --- Extended APIs (spike — may not be available in all versions) ---

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
  properties: Record<string, { type: string; description?: string; items?: any; enum?: string[] }>;
  required?: string[];
}

export interface OpenClawToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Channel types (spike A)
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
 * Channel adapter interface (spike).
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
// Memory types (spike B)
// ---------------------------------------------------------------------------

export interface MemorySearchResult {
  /** Source identifier (file path or graph URI). */
  path: string;
  /** Matched content snippet. */
  content: string;
  /** Relevance score (0–1, higher = more relevant). */
  score?: number;
}

export interface MemorySearchOptions {
  /** Maximum results to return. */
  limit?: number;
  /** Minimum relevance score threshold. */
  threshold?: number;
}

/**
 * Memory search manager interface (spike).
 *
 * Mirrors OpenClaw's MemorySearchManager — strictly read-only.
 * Write capture is handled separately via hooks + file watchers.
 */
export interface OpenClawMemorySearchManager {
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;
  readFile(path: string): Promise<string | null>;
  status(): Promise<{ ready: boolean; indexedFiles?: number; lastSync?: number }>;
  sync?(): Promise<void>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// DKG adapter config
// ---------------------------------------------------------------------------

export interface DkgOpenClawConfig {
  /** Persistent identity / state directory. Default: `.dkg/openclaw` */
  dataDir?: string;
  /** DKG listen port. Default: random */
  listenPort?: number;
  /** Relay peer multiaddrs for NAT traversal. */
  relayPeers?: string[];
  /** Bootstrap peer multiaddrs. */
  bootstrapPeers?: string[];
  /** Agent display name (defaults to OpenClaw agent name). */
  name?: string;
  /** Agent description. */
  description?: string;
  /** On-chain config (private key via DKG_EVM_PRIVATE_KEY env var). */
  chainConfig?: {
    rpcUrl?: string;
    hubAddress?: string;
    privateKey?: string;
  };
  /** Skills this agent offers. */
  skills?: Array<{
    skillType: string;
    pricePerCall?: number;
    currency?: string;
    handler: (input: Uint8Array) => Promise<{ status: string; output?: Uint8Array; error?: string }>;
  }>;

  // --- Integration extensions ---

  /** DKG daemon HTTP URL (default: "http://127.0.0.1:9200"). */
  daemonUrl?: string;

  /** DKG memory integration config. */
  memory?: {
    enabled?: boolean;
    /**
     * Path to the memory files directory.
     * Default: auto-detected from workspace (MEMORY.md parent).
     */
    memoryDir?: string;
    /** File-watcher debounce interval in ms.  Default: 1500. */
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
