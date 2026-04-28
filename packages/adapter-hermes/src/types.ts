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

/**
 * Session turn payload from the Hermes Python plugin.
 */
export interface SessionTurnPayload {
  sessionId: string;
  user: string;
  assistant: string;
  turnId?: string;
  idempotencyKey?: string;
}

/**
 * Session end payload from the Hermes Python plugin.
 */
export interface SessionEndPayload {
  sessionId: string;
  turnCount?: number;
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
   * to `request-only`, which means direct VM publish is not exposed as a normal
   * tool unless a user explicitly opts in.
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
  contextGraph: string;
  agentName?: string;
  bridge?: {
    url?: string;
    healthUrl?: string;
  };
  publishGuard: HermesPublishGuardPolicy;
  installedAt: string;
  updatedAt: string;
  managedFiles: string[];
}

export interface HermesChannelHealthResponse {
  ok: boolean;
  status: HermesRuntimeStatus;
  profile?: Pick<HermesProfileMetadata, 'profileName' | 'hermesHome' | 'memoryMode'>;
  bridge?: {
    url?: string;
    sessionId?: string;
  };
  error?: string;
}

export interface HermesChannelMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  ts?: string;
}

export interface HermesChannelAttachmentRef {
  assertionUri: string;
  fileHash: string;
  contextGraphId: string;
  fileName: string;
  detectedContentType?: string;
  extractionStatus?: 'completed';
  tripleCount?: number;
  rootEntity?: string;
}

export interface HermesChannelContextEntry {
  uri?: string;
  title?: string;
  text: string;
  source?: string;
  trust?: 'working-memory' | 'shared-working-memory' | 'verified-memory';
}

export interface HermesChannelSendPayload {
  text: string;
  correlationId: string;
  sessionId?: string;
  profileName?: string;
  contextGraphId?: string;
  contextEntries?: HermesChannelContextEntry[];
  attachmentRefs?: HermesChannelAttachmentRef[];
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
  turnId: string;
  correlationId?: string;
  userMessage: string;
  assistantReply: string;
  profileName?: string;
  contextGraphId?: string;
  attachmentRefs?: HermesChannelAttachmentRef[];
  idempotencyKey: string;
  persistenceState?: 'stored' | 'failed' | 'pending';
  failureReason?: string | null;
  source?: 'hermes-provider' | 'hermes-channel';
}

export interface HermesLocalAgentIntegrationPayload {
  id: 'hermes';
  name?: string;
  description?: string;
  enabled?: boolean;
  transport?: {
    kind?: 'hermes-channel';
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
