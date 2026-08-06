/**
 * Contract surface for the Prime Agent adapter.
 *
 * Deliberately mirrors `@origintrail-official/dkg-adapter-hermes` names and
 * shapes wherever the semantics are the same, so daemon-side code, the Node UI
 * and operators do not have to learn a second vocabulary. Where Prime Agent
 * genuinely differs — no memory-provider slot, no HTTP server, many concurrent
 * resident sessions — the type names say so rather than pretending parity.
 *
 * See agent-docs/adapters/prime-agent/DESIGN.md for the reasoning and
 * .ai/adr/0007-prime-agent-adapter-transport.md for the transport decision.
 */

/** Adapter-level configuration persisted by the daemon plugin. */
export interface PrimeAgentAdapterConfig {
  daemonUrl?: string;
  bridgeToken?: string;
  publishGuard?: PrimeAgentPublishGuardPolicy;
}

/** Runtime status, same vocabulary as Hermes so the UI can share components. */
export type PrimeAgentRuntimeStatus =
  | 'disconnected'
  | 'configured'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'error';

/**
 * Prime Agent has no memory-provider slot to elect, so "primary" means the
 * adapter's extension registers the recall/sync hook set. `tools-only` installs
 * the kernel skill and lifecycle tools without the hooks.
 */
export type PrimeAgentMemoryMode = 'hooks' | 'tools-only';

/**
 * Where the adapter's managed state lives. Prime Agent's config root is
 * `~/.prime/agent` (CONFIG_DIR_NAME = ".prime/agent"), with a project-local
 * `.prime/agent` variant.
 */
export interface PrimeAgentProfileMetadata {
  /** Optional label; unlike Hermes profiles this does not isolate agent state. */
  profileName?: string;
  /** Resolved agent dir, e.g. `~/.prime/agent`. */
  agentDir: string;
  /** `<agentDir>/settings.json` — owned by Prime Agent, one entry owned by us. */
  settingsPath: string;
  /** `<agentDir>/.dkg-adapter-prime-agent` — owned entirely by this adapter. */
  stateDir: string;
  /** `<stateDir>/sessions` — per-session bridge discovery files. */
  sessionsDir: string;
  memoryMode: PrimeAgentMemoryMode;
}

/**
 * Publish exposure. Defaults are deliberately at least as conservative as
 * Hermes: Prime Agent executes model-authored Python in a persistent kernel
 * with the user's own permissions and is explicitly not a sandbox, so a direct
 * publish path must be opened by an operator, never inferred.
 */
export interface PrimeAgentPublishGuardPolicy {
  defaultToolExposure: 'disabled' | 'request-only' | 'direct';
  allowDirectPublish?: boolean;
  allowContextGraphAdminTools?: boolean;
  requireExplicitApproval?: boolean;
  /** Operator-approved roots for any filesystem import. Empty means none. */
  importRoots?: string[];
}

/**
 * Snapshot of the pre-adapter state, captured BEFORE the first destructive
 * write and never overwritten afterwards (first-wins), so an interrupted setup
 * is still reversible. Hermes captures a single scalar (`memory.provider`); we
 * capture an array the user may legitimately edit between setup and disconnect,
 * which is why restore is entry-removal rather than wholesale replacement.
 */
export interface PrimeAgentPriorSettings {
  /** `settings.json.extensions` exactly as found at capture time. */
  extensionsSnapshot: string[];
  /** Absolute path of the `.bak.<unix-ms>` sibling holding the original bytes. */
  settingsBackupPath: string;
  capturedAt: string;
}

/** Persisted adapter state; the source of truth for reversal. */
export interface PrimeAgentSetupState {
  managedBy: '@origintrail-official/dkg-adapter-prime-agent';
  version: string;
  status: PrimeAgentRuntimeStatus;
  profile: PrimeAgentProfileMetadata;
  daemonUrl: string;
  dkgHome?: string;
  contextGraph: string;
  memoryAssertion: string;
  /** Absolute path of the extension file registered in settings.json. */
  extensionPath: string;
  publishGuard: PrimeAgentPublishGuardPolicy;
  installedAt: string;
  updatedAt: string;
  /** Every file this adapter created or modified, for uninstall. */
  managedFiles: string[];
  priorSettings?: PrimeAgentPriorSettings;
}

/** One live session's bridge, published by the extension, read by the daemon. */
export interface PrimeAgentSessionDescriptor {
  sessionId: string;
  /** Loopback bridge base, e.g. `http://127.0.0.1:54123`. */
  bridgeUrl: string;
  /** Owning worker pid; a descriptor whose pid is gone is stale. */
  pid: number;
  startedAt: string;
  /**
   * Re-stamped once per turn by the bridge. The election key: Prime Agent's
   * daemon resumes sessions across terminal restarts, so several live sessions
   * is a legitimate state and `startedAt` alone would follow the resumed one
   * rather than the one the operator is typing into. Absent from descriptors
   * written by older bridges, where `startedAt` substitutes.
   */
  lastActiveAt?: string;
  sessionName?: string;
}

export interface PrimeAgentSetupRequest {
  profile?: string;
  agentDir?: string;
  daemonUrl?: string;
  /** Explicit DKG home used to source the daemon auth token. */
  dkgHome?: string;
  /** Injectable bridge token; normally sourced from the DKG auth token. */
  bridgeToken?: string;
  port?: number;
  memoryMode?: PrimeAgentMemoryMode;
  contextGraph?: string;
  memoryAssertion?: string;
  /** Skip mutating settings.json when a conflicting DKG entry already exists. */
  preserveSettings?: boolean;
  dryRun?: boolean;
  verify?: boolean;
  signal?: AbortSignal;
  invokedBy?: 'cli' | 'ui';
}

export interface PrimeAgentRestoreRequest {
  profile?: string;
  agentDir?: string;
  signal?: AbortSignal;
}

export interface PrimeAgentRestoreResult {
  ok: boolean;
  /** `surgical` removes our entry; `backup-file` renames the .bak over it. */
  path: 'surgical' | 'backup-file' | 'noop' | 'failed';
  restoredFrom?: string;
  /** User-owned settings preserved before a backup-file recovery. */
  rejectedPath?: string;
  restoreError?: string;
}

export interface PrimeAgentSetupPlanAction {
  type: 'create' | 'update' | 'remove' | 'skip';
  path: string;
  reason: string;
}

export interface PrimeAgentSetupPlan {
  dryRun: boolean;
  profile: PrimeAgentProfileMetadata;
  actions: PrimeAgentSetupPlanAction[];
  warnings: string[];
  state: PrimeAgentSetupState;
}

export interface PrimeAgentVerifyResult {
  ok: boolean;
  status: 'configured' | 'degraded' | 'error';
  profile: PrimeAgentProfileMetadata;
  warnings: string[];
  errors: string[];
  /** Live sessions discovered at verify time. */
  sessions: PrimeAgentSessionDescriptor[];
  state?: PrimeAgentSetupState;
}

export interface PrimeAgentSetupResult {
  ok: boolean;
  status: 'configured' | 'degraded' | 'error';
  profile: PrimeAgentProfileMetadata;
  transport: {
    kind: 'prime-agent-channel';
    /** Absent until a session is live — this is a normal state, not an error. */
    bridgeUrl?: string;
    healthUrl?: string;
  };
  settingsPatched: boolean;
  warnings: string[];
  errors: string[];
  state?: PrimeAgentSetupState;
}

/* ── channel payloads (wire-compatible with the Hermes channel) ───────────── */

export interface PrimeAgentChannelMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  ts?: number;
}

export interface PrimeAgentChannelSendPayload {
  text: string;
  correlationId: string;
  sessionId?: string;
  contextGraphId?: string;
  identity?: string;
  persistUserMessage?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PrimeAgentChannelSendResponse {
  text: string;
  correlationId: string;
  sessionId?: string;
  turnId?: string;
}

export type PrimeAgentChannelStreamEvent =
  | { type: 'delta'; text: string; correlationId: string }
  | { type: 'final'; text: string; correlationId: string; sessionId?: string; turnId?: string; timedOut?: boolean }
  | { type: 'error'; error: string; correlationId?: string };

export interface PrimeAgentChannelHealthResponse {
  ok: boolean;
  /** Which session answered; lets the daemon detect a recycled port. */
  sessionId?: string;
  sessions?: PrimeAgentSessionDescriptor[];
  error?: string;
}

/** Registry payload for `LOCAL_AGENT_INTEGRATION_DEFINITIONS`. */
export interface PrimeAgentLocalAgentIntegrationPayload {
  id: 'prime-agent';
  name?: string;
  description?: string;
  enabled?: boolean;
  transport?: {
    kind?: 'prime-agent-channel';
    bridgeUrl?: string;
    healthUrl?: string;
  };
  capabilities?: {
    localChat?: boolean;
    chatAttachments?: boolean;
    connectFromUi?: boolean;
    installNode?: boolean;
    dkgPrimaryMemory?: boolean;
    wmImportPipeline?: boolean;
    nodeServedSkill?: boolean;
  };
  manifest?: {
    packageName?: string;
    version?: string;
    setupEntry?: string;
  };
  metadata?: Record<string, unknown>;
  runtime?: {
    status?: PrimeAgentRuntimeStatus;
    ready?: boolean;
    lastError?: string | null;
    updatedAt?: string;
  };
}

/** Minimal daemon plugin API surface this adapter uses. */
export interface DaemonPluginApi {
  registerHttpRoute(route: {
    method: 'GET' | 'POST';
    path: string;
    handler: (req: unknown, res: unknown) => void | Promise<void>;
  }): void;
  registerHook(event: string, handler: (...args: unknown[]) => unknown, opts?: { name?: string }): void;
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; debug?: (...a: unknown[]) => void };
  config?: Record<string, unknown>;
}
