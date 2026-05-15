/**
 * Configuration for the Hermes Agent adapter.
 */
export interface HermesAdapterConfig {
  /** Base URL of the DKG daemon (default: "http://127.0.0.1:9200"). */
  daemonUrl?: string;
  /** Optional route-scoped token used by a Hermes local bridge. */
  bridgeToken?: string;
  /** Publish guard policy exposed to the Hermes provider/tool layer. */
  publishGuard?: HermesPublishGuardPolicy;
}

export type HermesRuntimeStatus = 'disconnected' | 'configured' | 'connecting' | 'ready' | 'degraded' | 'error';

export type HermesMemoryMode = 'provider' | 'tools-only';

export interface HermesProfileMetadata {
  profileName?: string;
  hermesHome: string;
  configPath: string;
  stateDir: string;
  memoryMode: HermesMemoryMode;
}

export interface HermesPublishGuardPolicy {
  /**
   * Default exposure for model-callable publish behavior. The adapter defaults
   * to `direct` so Hermes receives the same publish tools as the node skill;
   * operators can set this to `disabled` when they want publish hidden.
   */
  defaultToolExposure: 'disabled' | 'request-only' | 'direct';
  /** Allow direct `/api/shared-memory/publish` calls from the provider. */
  allowDirectPublish?: boolean;
  /** Require an explicit human/operator approval marker before publishing. */
  requireExplicitApproval?: boolean;
  /** Require wallet/balance check before any publish request. */
  requireWalletCheck?: boolean;
}

export interface HermesSetupState {
  managedBy: '@origintrail-official/dkg-adapter-hermes';
  version: number;
  status: HermesRuntimeStatus;
  profile: HermesProfileMetadata;
  daemonUrl: string;
  dkgHome: string;
  contextGraph: string;
  memoryAssertion: string;
  agentName?: string;
  bridge?: {
    protocol?: 'hermes-channel' | 'hermes-openai';
    url?: string;
    gatewayUrl?: string;
    healthUrl?: string;
  };
  publishGuard: HermesPublishGuardPolicy;
  installedAt: string;
  updatedAt: string;
  managedFiles: string[];
  /**
   * Captured at the first install that replaced a non-DKG memory.provider
   * in `<hermesHome>/config.yaml`. First-wins: re-runs do NOT overwrite
   * this snapshot. `restoreHermesProfile` consumes it to put the user
   * back where they started. Absent when the install never replaced a
   * provider (fresh profile, or DKG was already selected).
   *
   * Defined in S2 with the optional shape so the schema is stable across
   * S2 → S4. Populated by S4's replace-by-default logic per
   * `setup-entrypoint-contract.md` §4.
   */
  priorMemoryProvider?: {
    provider: string;
    configBackupPath: string;
    capturedAt: string;
  };
}

/**
 * `HermesSetupRequest` — the input shape for `runHermesSetup`. Both the
 * CLI (`dkg hermes setup`) and the daemon-side UI Connect handler call
 * the same entrypoint with this shape. See `setup-entrypoint-contract.md`
 * §2 for the full source-of-truth table mapping each field to its CLI /
 * UI source.
 */
export interface HermesSetupRequest {
  // Profile selection
  profile?: string;
  hermesHome?: string;

  // Daemon target
  daemonUrl?: string;
  port?: string | number;

  // Bridge / gateway transport (loopback validation per pr-315-baseline §9)
  bridgeUrl?: string;
  gatewayUrl?: string;
  bridgeHealthUrl?: string;

  // Memory mode
  memoryMode?: HermesMemoryMode | 'primary';

  // Skill content resolved by caller (CLI passes loadBundledDkgNodeSkill())
  nodeSkillContent?: string;

  // Parity flags (issue #386 acceptance)
  start?: boolean;
  fund?: boolean;
  preserveProvider?: boolean;
  dryRun?: boolean;
  verify?: boolean;

  // UI / host-only knobs
  signal?: AbortSignal;
  invokedBy?: 'cli' | 'ui';
}

/**
 * `HermesRestoreRequest` — input shape for `restoreHermesProfile`.
 * Per setup-entrypoint-contract.md §6. Restore reads the captured
 * `priorMemoryProvider` snapshot from setup-state.json and attempts to
 * put `<hermesHome>/config.yaml` back to its pre-replacement state.
 */
export interface HermesRestoreRequest {
  profile?: string;
  hermesHome?: string;
  signal?: AbortSignal;
}

/**
 * `HermesRestoreResult` — output shape `restoreHermesProfile` returns.
 * Per setup-entrypoint-contract.md §6 + QA addendum §10C #1
 * (post-restore verification).
 *
 * `path` discriminator:
 *   - `'surgical'`: the active `memory.provider` line was rewritten in
 *     place to the captured provider name. Preserves any user edits to
 *     `config.yaml` made after setup.
 *   - `'backup-file'`: surgical rewrite failed (parse error, missing
 *     top-level `memory:` block, etc.); the captured backup file was
 *     atomically renamed over `config.yaml`. Loses any post-setup
 *     user edits.
 *   - `'noop'`: nothing to restore (no `priorMemoryProvider` snapshot
 *     in setup-state, or fresh install).
 *   - `'failed'`: both surgical AND backup-file paths failed (e.g.
 *     backup file deleted by user, config corrupted, post-restore
 *     verification mismatch).
 *
 * Per QA addendum §10C #1: after both surgical AND backup-file paths,
 * verify `findConfiguredMemoryProvider(post) === captured.provider`
 * before reporting success. Mismatch ⇒ `path: 'failed'`.
 */
export interface HermesRestoreResult {
  ok: boolean;
  path: 'surgical' | 'backup-file' | 'noop' | 'failed';
  /** Backup path consumed when `path === 'backup-file'`. */
  restoredFrom?: string;
  /** Captured prior provider name when `path === 'surgical'`. */
  restoredProvider?: string;
  /** Populated when `path === 'failed'`. */
  restoreError?: string;
}

/**
 * `HermesSetupResult` — the output shape `runHermesSetup` returns. The
 * daemon UI Connect handler maps `status` → `runtime.status` per
 * `setup-entrypoint-contract.md` §3 table:
 *   - `'configured'` → `runtime.status: 'ready'`
 *   - `'degraded'`   → `runtime.status: 'degraded'`
 *   - `'error'`      → `runtime.status: 'error'`
 */
export interface HermesSetupResult {
  ok: boolean;
  status: 'configured' | 'degraded' | 'error';

  /** Resolved profile (always populated, even on error). */
  profile: HermesProfileMetadata;

  /**
   * `true` ⇒ daemon was started (or confirmed already-running on the
   * resolved port). `false` when `start: false` was passed or daemon
   * start was attempted and failed.
   */
  daemonStarted: boolean;

  /**
   * Wallet addresses funded via the testnet faucet on this run. Empty
   * when `fund: false`, no faucet configured, dryRun, or the faucet
   * returned no funded wallets (the latter is best-effort, not an error).
   */
  fundedWallets: string[];

  /**
   * Convenience transport descriptor lifted from the resolved bridge
   * config. Daemon route consumers patch this straight into
   * `LocalAgentIntegrationRecord` (see `setup-entrypoint-contract.md` §3).
   */
  transport: {
    kind: 'hermes-channel' | 'hermes-openai';
    bridgeUrl?: string;
    gatewayUrl?: string;
    healthUrl?: string;
  };

  /**
   * Provider-replacement audit. Present only when this run actually
   * swapped `memory.provider`. Populated by S4's replace-by-default
   * implementation; defined here so the result shape is stable.
   */
  providerSwap?: {
    previousProvider: string | null;
    backupPath: string;
  };

  warnings: string[];
  /** Populated only on `ok: false`. */
  errors: string[];

  /**
   * Full setup-state.json snapshot for callers (UI persists for
   * inspection / restore).
   */
  state?: HermesSetupState;
}

export interface HermesChannelHealthResponse {
  ok: boolean;
  target?: 'bridge' | 'gateway';
  bridge?: HermesHealthState;
  gateway?: HermesHealthState;
  error?: string;
}

export type HermesHealthState = Record<string, unknown> & {
  ok: boolean;
  channel?: string;
  error?: string;
};

export interface HermesChannelMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  ts?: string;
}

export interface HermesChannelAttachmentRef {
  assertionUri: string;
  assertionName?: string;
  fileHash: string;
  contextGraphId: string;
  fileName: string;
  detectedContentType?: string;
  extractionStatus?: 'completed';
  tripleCount?: number;
  rootEntity?: string;
  mdIntermediateHash?: string;
  markdownHash?: string;
  markdownForm?: string;
}

export interface HermesChannelAttachmentImportResult {
  assertionUri: string;
  assertionName?: string;
  fileHash: string;
  contextGraphId: string;
  fileName: string;
  detectedContentType: string;
  extractionStatus: 'skipped';
  pipelineUsed?: string | null;
  tripleCount?: number;
  rootEntity?: string;
  mdIntermediateHash?: string;
  error?: string;
}

export interface HermesChannelContextEntry {
  key: string;
  label: string;
  value: string;
}

export interface HermesChannelSendPayload {
  text: string;
  correlationId: string;
  sessionId?: string;
  profile?: string;
  contextGraphId?: string;
  currentAgentAddress?: string;
  identity?: string;
  persistUserMessage?: string;
  contextEntries?: HermesChannelContextEntry[];
  attachmentRefs?: HermesChannelAttachmentRef[];
  attachmentImportResults?: HermesChannelAttachmentImportResult[];
  metadata?: Record<string, unknown>;
}

export interface HermesChannelSendResponse {
  text: string;
  correlationId: string;
  sessionId?: string;
  turnId?: string;
}

export type HermesChannelStreamEvent =
  | { type: 'delta'; text: string; correlationId: string }
  | { type: 'final'; text: string; correlationId: string; sessionId?: string; turnId?: string }
  | { type: 'error'; error: string; correlationId?: string };

export interface HermesChannelPersistTurnPayload {
  sessionId: string;
  turnId?: string;
  correlationId?: string;
  userMessage: string;
  assistantReply: string;
  profile?: string;
  contextGraphId?: string;
  attachmentRefs?: HermesChannelAttachmentRef[];
  idempotencyKey?: string;
  currentAgentAddress?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  metadata?: Record<string, unknown>;
  persistenceState?: 'stored' | 'failed' | 'pending';
  failureReason?: string;
}

export interface HermesLocalAgentIntegrationPayload {
  id: 'hermes';
  name?: string;
  description?: string;
  enabled?: boolean;
  transport?: {
    kind?: 'hermes-channel' | 'hermes-openai';
    bridgeUrl?: string;
    gatewayUrl?: string;
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
    status?: HermesRuntimeStatus;
    ready?: boolean;
    lastError?: string | null;
    updatedAt?: string;
  };
}

/**
 * Daemon plugin API — the interface the daemon provides to adapters
 * for registering HTTP routes and lifecycle hooks.
 *
 * This mirrors the OpenClaw adapter pattern but is framework-agnostic.
 */
export interface DaemonPluginApi {
  /** Register an HTTP route on the daemon server. */
  registerHttpRoute(route: {
    method: 'GET' | 'POST';
    path: string;
    handler: (req: any, res: any) => Promise<void>;
  }): void;

  /** Register a lifecycle hook. */
  registerHook(event: string, handler: () => Promise<void>, opts?: { name?: string }): void;

  /** Logger. */
  logger: {
    info?(...args: any[]): void;
    warn?(...args: any[]): void;
    debug?(...args: any[]): void;
  };

  /** Access to the DKG agent instance running in the daemon. */
  agent: {
    query(sparql: string, opts?: { contextGraphId?: string }): Promise<any>;
    share(contextGraphId: string, quads: any[], opts?: any): Promise<any>;
    importMemories?(text: string, source?: string): Promise<any>;
    storeChatTurn?(
      sessionId: string,
      user: string,
      assistant: string,
      opts?: { turnId?: string; idempotencyKey?: string; source?: string },
    ): Promise<any>;
  };
}
