/**
 * DkgChannelPlugin — Spike A: DKG UI ↔ OpenClaw channel bridge.
 *
 * Makes the DKG Node UI a first-class OpenClaw channel.  Messages sent
 * through the Agent Hub chat go through this channel into the OpenClaw
 * gateway's session system, meaning they share the same transcript and
 * context as messages from Telegram, WhatsApp, or any other channel
 * (when `dmScope: "main"`).
 *
 * Transport: The DKG daemon exposes `/api/openclaw-channel/send` for
 * the frontend.  The daemon forwards the message to this plugin via
 * a standalone HTTP server on a dedicated port (bridge mode).
 *
 * Message routing uses OpenClaw's plugin-sdk `dispatchInboundReplyWithBase`
 * helper — the same pathway used by built-in channels (Telegram, Discord,
 * etc.).  This ensures the message enters the agent's session system with
 * full context continuity.
 */

import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ChannelOutboundReply,
  DkgOpenClawConfig,
  OpenClawPluginApi,
} from './types.js';
import type { DkgDaemonClient, OpenClawAttachmentRef } from './dkg-client.js';

export const CHANNEL_NAME = 'dkg-ui';
const DEFAULT_CHANNEL_ACCOUNT_ID = 'default';
const TURN_PERSIST_RETRY_DELAYS_MS = [250, 1_000] as const;
const CHANNEL_RESPONSE_TIMEOUT_MS = 180_000;
const STOP_DRAIN_TIMEOUT_MS = 1_500;
const NO_TEXT_RESPONSE_ERROR = 'Agent returned no text response';
const CANCELLED_TURN_MESSAGE = '[OpenClaw reply cancelled before completion]';
const FAILED_TURN_MESSAGE_PREFIX = '[OpenClaw reply failed before completion';

/** Strip identity to safe characters and cap length to prevent injection into session keys / URIs. */
function sanitizeIdentity(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
}

function finalizeAgentReplyText(text: string): string {
  if (text.trim().length === 0) {
    throw new Error(NO_TEXT_RESPONSE_ERROR);
  }
  return text;
}

function normalizeAttachmentRef(raw: unknown): OpenClawAttachmentRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const assertionUri = typeof record.assertionUri === 'string' ? record.assertionUri.trim() : '';
  const fileHash = typeof record.fileHash === 'string' ? record.fileHash.trim() : '';
  const contextGraphId = typeof record.contextGraphId === 'string' ? record.contextGraphId.trim() : '';
  const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
  if (!assertionUri || !fileHash || !contextGraphId || !fileName) return null;

  const normalized: OpenClawAttachmentRef = { assertionUri, fileHash, contextGraphId, fileName };
  if (typeof record.detectedContentType === 'string' && record.detectedContentType.trim()) {
    normalized.detectedContentType = record.detectedContentType.trim();
  }
  if (record.extractionStatus === 'completed') {
    normalized.extractionStatus = record.extractionStatus;
  } else if (record.extractionStatus !== undefined) {
    return null;
  }
  if (typeof record.tripleCount === 'number' && Number.isFinite(record.tripleCount) && record.tripleCount >= 0) {
    normalized.tripleCount = record.tripleCount;
  }
  if (typeof record.rootEntity === 'string' && record.rootEntity.trim()) {
    normalized.rootEntity = record.rootEntity.trim();
  }
  return normalized;
}

function normalizeAttachmentRefs(raw: unknown): OpenClawAttachmentRef[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const refs: OpenClawAttachmentRef[] = [];
  for (const entry of raw) {
    const normalized = normalizeAttachmentRef(entry);
    if (!normalized) return undefined;
    refs.push(normalized);
  }
  return refs;
}

function hasInboundChatTurnContent(
  text: unknown,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
): text is string {
  return typeof text === 'string' && (text.length > 0 || Boolean(attachmentRefs?.length));
}

function sanitizeAttachmentPromptField(raw: string | undefined, fallback: string): string {
  const normalize = (value: string | undefined): string => (value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return JSON.stringify(normalize(raw) || normalize(fallback));
}

function sanitizeAttachmentContextValue(value: string | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeAttachmentRefForContext(ref: OpenClawAttachmentRef): OpenClawAttachmentRef {
  const sanitized: OpenClawAttachmentRef = {
    assertionUri: sanitizeAttachmentContextValue(ref.assertionUri),
    fileHash: sanitizeAttachmentContextValue(ref.fileHash),
    contextGraphId: sanitizeAttachmentContextValue(ref.contextGraphId),
    fileName: sanitizeAttachmentContextValue(ref.fileName),
  };
  if (ref.detectedContentType) {
    sanitized.detectedContentType = sanitizeAttachmentContextValue(ref.detectedContentType);
  }
  if (ref.extractionStatus) {
    sanitized.extractionStatus = ref.extractionStatus;
  }
  if (ref.tripleCount != null) {
    sanitized.tripleCount = ref.tripleCount;
  }
  if (ref.rootEntity) {
    sanitized.rootEntity = sanitizeAttachmentContextValue(ref.rootEntity);
  }
  return sanitized;
}

function sanitizeAttachmentRefsForContext(
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
): OpenClawAttachmentRef[] | undefined {
  return attachmentRefs?.map((ref) => sanitizeAttachmentRefForContext(ref));
}

function formatAttachmentContext(attachmentRefs: OpenClawAttachmentRef[]): string {
  const lines = attachmentRefs.map((ref) => {
    const label = sanitizeAttachmentPromptField(ref.fileName, ref.assertionUri || 'attachment');
    const graph = ref.contextGraphId ? ` in ${sanitizeAttachmentPromptField(ref.contextGraphId, 'unknown context graph')}` : '';
    const contentType = ref.detectedContentType
      ? ` [${sanitizeAttachmentPromptField(ref.detectedContentType, 'unknown content type')}]`
      : '';
    const status = ref.extractionStatus ? ` (${ref.extractionStatus})` : '';
    return `- ${label}${graph}${contentType}${status} -> ${sanitizeAttachmentPromptField(ref.assertionUri, 'unknown assertion')}`;
  });
  return ['Attached Working Memory items:', ...lines].join('\n');
}

interface ChatContextEntry {
  key: string;
  label: string;
  value: string;
}

function sanitizeChatContextEntry(entry: ChatContextEntry): ChatContextEntry {
  return {
    key: sanitizeAttachmentContextValue(entry.key),
    label: sanitizeAttachmentContextValue(entry.label),
    value: sanitizeAttachmentContextValue(entry.value),
  };
}

function sanitizeChatContextEntries(entries: ChatContextEntry[] | undefined): ChatContextEntry[] | undefined {
  return entries?.map((entry) => sanitizeChatContextEntry(entry));
}

function formatChatContext(entries: ChatContextEntry[]): string {
  const lines = entries.map((entry) => `- ${sanitizeAttachmentPromptField(entry.label, entry.key)}: ${sanitizeAttachmentPromptField(entry.value, 'unknown')}`);
  return [
    'Context for this chat turn:',
    'If "target_context_graph" is present below, treat it as authoritative for this turn unless the user explicitly overrides it in the same message.',
    ...lines,
  ].join('\n');
}

function buildAgentBody(text: string, opts?: { attachmentRefs?: OpenClawAttachmentRef[]; contextEntries?: ChatContextEntry[] }): string {
  const sections: string[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    sections.push(text);
  }
  if (opts?.contextEntries?.length) {
    sections.push(formatChatContext(opts.contextEntries));
  }
  if (opts?.attachmentRefs?.length) {
    sections.push(formatAttachmentContext(opts.attachmentRefs));
  }
  if (sections.length === 0) {
    return 'User sent an empty chat turn.';
  }
  return sections.join('\n\n');
}
const moduleRequire = createRequire(import.meta.url);

interface PendingRequest {
  resolve: (reply: ChannelOutboundReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PersistTurnOptions {
  persistenceState?: 'stored' | 'failed' | 'pending';
  failureReason?: string | null;
  attachmentRefs?: OpenClawAttachmentRef[];
}

interface InboundChatOptions {
  attachmentRefs?: OpenClawAttachmentRef[];
  contextEntries?: ChatContextEntry[];
  /**
   * UI-selected project context graph ID for this turn. The node UI stamps
   * this onto the outbound `/api/openclaw-channel/send` payload; the
   * adapter uses it to scope slot-backed memory recall and per-project
   * memory imports to the user's current project. Optional — turns that
   * arrive without it run in the documented degraded mode
   * (single-graph agent-context only, or `needs_clarification` on write).
   */
  uiContextGraphId?: string;
}

/**
 * Time a UI-selected context graph record sticks around in the channel
 * session-state map after the owning turn finishes. Long enough for
 * follow-up tool calls during the same dispatch to read it, short enough
 * that a stale entry does not leak across user sessions. Five minutes.
 */
const SESSION_STATE_TTL_MS = 5 * 60 * 1_000;

function normalizeChatContextEntry(raw: unknown): ChatContextEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const key = typeof record.key === 'string' ? record.key.trim() : '';
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  const value = typeof record.value === 'string' ? record.value.trim() : '';
  if (!key || !label || !value) return null;
  return { key, label, value };
}

function normalizeChatContextEntries(raw: unknown): ChatContextEntry[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const entries: ChatContextEntry[] = [];
  for (const entry of raw) {
    const normalized = normalizeChatContextEntry(entry);
    if (!normalized) return undefined;
    entries.push(normalized);
  }
  return entries;
}

export class DkgChannelPlugin {
  private api: OpenClawPluginApi | null = null;
  /** OpenClaw runtime — provides channel routing, session, and reply subsystems. */
  private runtime: any = null;
  /** Full OpenClawConfig — needed for agent dispatch. */
  private cfg: any = null;
  /** Plugin-sdk helpers — lazily loaded at first dispatch. */
  private sdk: any = null;
  /** True after the first loadSdk() attempt — prevents re-trying and re-logging every turn. */
  private sdkLoaded = false;
  private server: Server | null = null;
  private serverStart: Promise<void> | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingTurnPersistence = new Map<string, {
    attempt: number;
    timer: ReturnType<typeof setTimeout> | null;
    allowDuringShutdown: boolean;
  }>();
  /**
   * Per-session state populated when an inbound turn stamps the UI-selected
   * project context graph onto the dispatch. Keyed by the runtime's
   * `sessionKey` once resolved, read by `DkgMemorySearchManager.search`
   * (via the `DkgMemorySessionResolver` the node plugin injects) during
   * the same dispatch. Entries expire after SESSION_STATE_TTL_MS.
   */
  private readonly sessionState = new Map<string, {
    projectContextGraphId: string;
    expiresAt: number;
  }>();
  private readonly port: number;
  private useGatewayRoute = false;
  private channelRegistered = false;
  private gatewayRoutesRegistered = false;
  private inFlight = 0;
  private readonly maxInFlight = 3;
  private stopping = false;
  private readonly stopWaiters: Array<() => void> = [];
  private stopDrainDeadlineAt: number | null = null;

  constructor(
    private readonly config: NonNullable<DkgOpenClawConfig['channel']>,
    private readonly client: DkgDaemonClient,
  ) {
    this.port = config.port ?? 9201;
  }

  /**
   * Read the UI-selected project context graph that was stamped on the
   * dispatch for a given `sessionKey`. Used by `DkgMemorySessionResolver`
   * inside `DkgNodePlugin` to scope slot-backed memory recall to the
   * user's current project. Returns `undefined` when no state exists,
   * the state has expired, or the caller passed an empty sessionKey.
   */
  getSessionProjectContextGraphId(sessionKey: string | undefined): string | undefined {
    if (!sessionKey) return undefined;
    const entry = this.sessionState.get(sessionKey);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.sessionState.delete(sessionKey);
      return undefined;
    }
    return entry.projectContextGraphId;
  }

  /**
   * Stash the UI-selected project context graph for a `sessionKey`. Called
   * from `dispatchViaPluginSdk` once `route.sessionKey` is known and
   * before dispatching the turn so that slot-backed tool calls during the
   * same dispatch see it.
   */
  private setSessionProjectContextGraphId(sessionKey: string, projectContextGraphId: string): void {
    this.sessionState.set(sessionKey, {
      projectContextGraphId,
      expiresAt: Date.now() + SESSION_STATE_TTL_MS,
    });
    this.sweepExpiredSessionState();
  }

  /**
   * Clear any previously-stashed UI-selected project context graph for a
   * `sessionKey`. Called at the start of every dispatch when the incoming
   * turn has no `uiContextGraphId` on the envelope — either because the
   * user deselected their project in the node UI, or because the turn
   * arrived from a non-UI channel (Telegram, CLI, etc.) that never
   * populated the field. Without this call, a previous project selection
   * would persist for the full 5-minute TTL and recall would silently
   * scope to a stale project.
   */
  private clearSessionProjectContextGraphId(sessionKey: string): void {
    this.sessionState.delete(sessionKey);
    this.sweepExpiredSessionState();
  }

  private sweepExpiredSessionState(): void {
    const now = Date.now();
    for (const [key, entry] of this.sessionState) {
      if (entry.expiresAt < now) {
        this.sessionState.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  register(api: OpenClawPluginApi): void {
    this.stopping = false;
    this.stopDrainDeadlineAt = null;
    this.api = api;
    const log = api.logger;

    // Capture the runtime and config from the plugin API.
    // These are not part of the typed API surface but are available at runtime.
    this.runtime = (api as any).runtime;
    this.cfg = (api as any).cfg ?? (api as any).config ?? this.runtime?.cfg ?? this.runtime?.config;

    // Log what we found for diagnostics
    if (this.runtime?.channel) {
      log.info?.('[dkg-channel] runtime.channel available — dispatch routing enabled');
    } else {
      log.warn?.('[dkg-channel] runtime.channel not available — dispatch routing will not work');
    }
    if (this.cfg && typeof this.cfg === 'object' && Object.keys(this.cfg).length > 5) {
      log.info?.('[dkg-channel] OpenClawConfig captured');
    } else {
      // Log what we got to help debug
      const cfgKeys = this.cfg ? Object.keys(this.cfg).slice(0, 10).join(', ') : 'null';
      log.warn?.(`[dkg-channel] cfg may be incomplete (keys: ${cfgKeys})`);
      // Try additional paths
      const rt = this.runtime;
      if (rt) {
        const rtKeys = Object.keys(rt).filter(k => k.toLowerCase().includes('config') || k.toLowerCase().includes('cfg')).join(', ');
        log.info?.(`[dkg-channel] runtime config-like keys: ${rtKeys || 'none'}`);
        const allRtKeys = Object.keys(rt).sort().join(', ');
        log.info?.(`[dkg-channel] runtime all keys: ${allRtKeys}`);
      }
    }

    // --- Register as a first-class channel ---
    if (!this.channelRegistered && typeof api.registerChannel === 'function') {
      api.registerChannel({
        plugin: this.buildRegisteredChannelPlugin(),
      });
      this.channelRegistered = true;
      log.info?.('[dkg-channel] Registered as OpenClaw channel via registerChannel()');
    }

    // --- Register an HTTP route on the gateway ---
    if (!this.gatewayRoutesRegistered && typeof api.registerHttpRoute === 'function') {
      api.registerHttpRoute({
        method: 'POST',
        path: '/api/dkg-channel/inbound',
        auth: 'gateway',
        handler: (req: any, res: any) => {
          void this.handleGatewayRoute(req, res).catch((err) => {
            this.handleUnexpectedGatewayError(res, err);
          });
        },
      });
      api.registerHttpRoute({
        method: 'GET',
        path: '/api/dkg-channel/health',
        auth: 'gateway',
        handler: (_req: any, res: any) => {
          res.writeHead?.(200, { 'Content-Type': 'application/json' });
          res.end?.(JSON.stringify({ ok: true, channel: CHANNEL_NAME }));
        },
      });
      this.gatewayRoutesRegistered = true;
      this.useGatewayRoute = true;
      log.info?.('[dkg-channel] Registered HTTP routes on gateway: POST /api/dkg-channel/inbound, GET /api/dkg-channel/health');
    }

    // Start the bridge server immediately so it's ready to receive
    // inbound messages before any session exists.
    this.start().catch((err) => {
      log.warn?.(`[dkg-channel] Bridge server failed to start: ${err.message}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.server?.listening) return;
    if (this.serverStart) return this.serverStart;

    if (!this.server) {
      this.server = createServer((req, res) => {
        void this.handleHttpRequest(req, res).catch((err) => {
          this.handleUnexpectedHttpError(res, err);
        });
      });
    }

    const server = this.server;
    this.serverStart = new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('error', onError);
        this.serverStart = null;
        this.server = null;
        reject(err);
      };

      server.once('error', onError);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', onError);
        this.serverStart = null;
        const address = server.address();
        const boundPort = typeof address === 'object' && address ? address.port : this.port;
        this.api?.logger.info?.(`[dkg-channel] Bridge server listening on 127.0.0.1:${boundPort}`);
        resolve();
      });
    });

    await this.serverStart;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopDrainDeadlineAt = Date.now() + STOP_DRAIN_TIMEOUT_MS;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel shutting down'));
      this.pendingRequests.delete(id);
    }

    for (const [id, job] of this.pendingTurnPersistence) {
      if (job.allowDuringShutdown) continue;
      if (!job.timer) continue;
      clearTimeout(job.timer);
      this.deletePendingTurnPersistence(id);
    }

    if (this.serverStart) {
      await this.serverStart.catch(() => {});
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    const drained = await this.waitForStopDrain(STOP_DRAIN_TIMEOUT_MS);
    if (!drained) {
      this.api?.logger.warn?.(
        `[dkg-channel] Channel stop timed out after ${STOP_DRAIN_TIMEOUT_MS}ms waiting for turn persistence to drain; continuing shutdown`,
      );
      this.clearPendingTurnPersistence();
    }
    this.stopDrainDeadlineAt = null;
  }

  private deletePendingTurnPersistence(correlationId: string): void {
    const job = this.pendingTurnPersistence.get(correlationId);
    if (job?.timer) clearTimeout(job.timer);
    this.pendingTurnPersistence.delete(correlationId);
    this.notifyStopIdle();
  }

  private clearPendingTurnPersistence(): void {
    for (const job of this.pendingTurnPersistence.values()) {
      if (job.timer) clearTimeout(job.timer);
    }
    this.pendingTurnPersistence.clear();
    this.notifyStopIdle();
  }

  private notifyStopIdle(): void {
    if (!this.stopping || this.inFlight > 0 || this.pendingTurnPersistence.size > 0) return;
    while (this.stopWaiters.length > 0) {
      this.stopWaiters.shift()?.();
    }
  }

  private waitForStopDrain(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0 && this.pendingTurnPersistence.size === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const waiter = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.stopWaiters.indexOf(waiter);
        if (index >= 0) this.stopWaiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      this.stopWaiters.push(waiter);
      this.notifyStopIdle();
    });
  }

  private canContinuePersistenceAttempt(allowDuringShutdown: boolean): boolean {
    if (!this.stopping) return true;
    if (!allowDuringShutdown) return false;
    return (this.stopDrainDeadlineAt ?? 0) > Date.now();
  }

  // ---------------------------------------------------------------------------
  // Plugin-SDK lazy loader
  // ---------------------------------------------------------------------------

  private loadSdk(): any {
    if (this.sdk) { this.sdkLoaded = true; return this.sdk; }
    if (this.sdkLoaded) return this.sdk;
    this.sdkLoaded = true;
    const log = this.api?.logger;

    // Strategy 1: resolve from the adapter's own context (works if adapter is
    // inside the gateway's node_modules tree).
    try {
      this.sdk = moduleRequire('openclaw/plugin-sdk');
      log?.info?.('[dkg-channel] Loaded plugin-sdk via adapter context');
      return this.sdk;
    } catch { /* expected — adapter is typically loaded from an external path */ }

    // Strategy 2: resolve from the gateway's main script. process.argv[1] is
    // the gateway entry (e.g. .../openclaw/dist/index.js), so createRequire
    // from there can find openclaw's own subpath exports.
    if (process.argv[1]) {
      try {
        this.sdk = createRequire(process.argv[1])('openclaw/plugin-sdk');
        log?.info?.('[dkg-channel] Loaded plugin-sdk via gateway entry');
        return this.sdk;
      } catch { /* gateway entry might not be resolvable */ }
    }

    // Strategy 3: walk up from the adapter's location looking for
    // node_modules/openclaw/package.json, then require from there.
    // Handles global installs, monorepos, and any OS.
    try {
      const adapterDir = dirname(fileURLToPath(import.meta.url));
      let dir = adapterDir;
      for (let i = 0; i < 20; i++) {
        const candidate = join(dir, 'node_modules', 'openclaw', 'package.json');
        if (existsSync(candidate)) {
          try {
            this.sdk = createRequire(candidate)('openclaw/plugin-sdk');
            log?.info?.('[dkg-channel] Loaded plugin-sdk via node_modules walk');
            return this.sdk;
          } catch { /* broken install — keep walking */ }
        }
        const parent = dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
      }
    } catch { /* walk setup failed (e.g. fileURLToPath) */ }

    log?.warn?.('[dkg-channel] Could not load openclaw/plugin-sdk — using direct runtime dispatch');
    return this.sdk;
  }

  private buildRegisteredChannelPlugin() {
    return {
      id: CHANNEL_NAME,
      name: CHANNEL_NAME,
      meta: {
        id: CHANNEL_NAME,
        label: 'DKG UI',
        selectionLabel: 'DKG UI',
        blurb: 'Local DKG UI bridge',
        displayName: 'DKG UI',
      },
      capabilities: {
        chatTypes: ['direct'],
      },
      config: {
        listAccountIds: () => this.config.enabled === false ? [] : [DEFAULT_CHANNEL_ACCOUNT_ID],
        resolveAccount: (_cfg: any, accountId?: string) => this.resolveRegisteredAccount(accountId),
        defaultAccountId: () => DEFAULT_CHANNEL_ACCOUNT_ID,
        isEnabled: () => this.config.enabled !== false,
        isConfigured: async () => true,
        describeAccount: (account: Record<string, unknown>) => ({
          accountId: account.accountId ?? DEFAULT_CHANNEL_ACCOUNT_ID,
          name: account.name ?? 'DKG UI',
          enabled: account.enabled !== false,
          configured: true,
          linked: true,
        }),
        disabledReason: () => 'disabled',
        unconfiguredReason: () => 'not configured',
      },
      start: () => this.start(),
      stop: () => this.stop(),
      onOutbound: (reply: ChannelOutboundReply) => this.handleOutboundReply(reply),
    };
  }

  private resolveRegisteredAccount(accountId?: string): Record<string, unknown> {
    return {
      accountId: accountId ?? DEFAULT_CHANNEL_ACCOUNT_ID,
      enabled: this.config.enabled !== false,
      name: 'DKG UI',
    };
  }

  private buildStreamingReplyOptions(): Record<string, unknown> {
    // OpenClaw block streaming is off by default unless the channel opts in.
    // The DKG UI stream endpoint needs incremental block replies, not final-only output.
    return { disableBlockStreaming: false };
  }

  // ---------------------------------------------------------------------------
  // Inbound message handling  (DKG daemon → OpenClaw session)
  // ---------------------------------------------------------------------------

  /**
   * Process an inbound message from the DKG UI.
   * Routes through the OpenClaw session system and returns the agent reply.
   */
  async processInbound(
    text: string,
    correlationId: string,
    identity: string,
    opts?: InboundChatOptions,
  ): Promise<ChannelOutboundReply> {
    const api = this.api;
    if (!api) throw new Error('Channel not registered');

    const runtime = this.runtime;
    const cfg = this.cfg;
    const attachmentRefs = normalizeAttachmentRefs(opts?.attachmentRefs);
    const contextAttachmentRefs = sanitizeAttachmentRefsForContext(attachmentRefs);
    const contextEntries = normalizeChatContextEntries(opts?.contextEntries);
    const sanitizedContextEntries = sanitizeChatContextEntries(contextEntries);
    const uiContextGraphId = typeof opts?.uiContextGraphId === 'string' && opts.uiContextGraphId.trim()
      ? opts.uiContextGraphId.trim()
      : undefined;
    if (opts?.attachmentRefs != null && attachmentRefs === undefined) {
      throw new Error('Invalid attachment refs');
    }
    if (opts?.contextEntries != null && contextEntries === undefined) {
      throw new Error('Invalid context entries');
    }

    // --- Primary: dispatch via runtime channel (uses plugin-sdk when available) ---
    if (runtime?.channel && cfg) {
      api.logger.info?.(`[dkg-channel] Dispatching for: ${correlationId}`);
      try {
        const reply = await this.dispatchViaPluginSdk(text, correlationId, identity, contextAttachmentRefs, sanitizedContextEntries, uiContextGraphId);
        // Fire-and-forget: persist turn to DKG graph for Agent Hub visualization
        this.queueTurnPersistence(text, reply.text, correlationId, identity, {
          attachmentRefs,
        }, true);
        return reply;
      } catch (err: any) {
        api.logger.warn?.(`[dkg-channel] dispatchViaPluginSdk failed: ${err.message}`);
        throw err;
      }
    } else {
      api.logger.warn?.(`[dkg-channel] No runtime.channel (${!!runtime?.channel}) or cfg (${!!cfg}) — falling back`);
    }

    if (typeof api.routeInboundMessage === 'function') {
      api.logger.info?.(`[dkg-channel] Dispatching via api.routeInboundMessage for: ${correlationId}`);
      const reply = await api.routeInboundMessage({
        channelName: CHANNEL_NAME,
        senderId: identity || 'owner',
        senderIsOwner: true,
        text: buildAgentBody(text, { attachmentRefs: contextAttachmentRefs, contextEntries: sanitizedContextEntries }),
        correlationId,
      } as any);
      this.queueTurnPersistence(text, reply.text, correlationId, identity || 'owner', {
        attachmentRefs,
      }, true);
      return reply;
    }

    throw new Error(
      'No message routing mechanism available. ' +
      'The OpenClaw gateway must expose runtime.channel dispatch or api.routeInboundMessage().',
    );
  }

  /**
   * Dispatch an inbound message using OpenClaw's plugin-sdk dispatch system.
   * This is the same pathway used by Telegram, Discord, and other built-in channels.
   */
  private async dispatchViaPluginSdk(
    text: string,
    correlationId: string,
    identity: string,
    attachmentRefs?: OpenClawAttachmentRef[],
    contextEntries?: ChatContextEntry[],
    uiContextGraphId?: string,
  ): Promise<ChannelOutboundReply> {
    const log = this.api!.logger;
    const runtime = this.runtime;
    const cfg = this.cfg;
    const sdk = this.loadSdk();

    // 1. Resolve agent route (agentId + sessionKey)
    let route: any;
    try {
      const resolved = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: CHANNEL_NAME,
        accountId: 'default',
        peer: { kind: 'direct', id: identity || 'owner' },
      });
      // Clone to avoid mutating the runtime's cached route object
      route = { ...resolved };
      // Give non-owner identities (e.g. background workers) their own session
      // so they don't pollute the user's chat context.
      if (identity && identity !== 'owner') {
        route.sessionKey = `agent:${route.agentId}:${sanitizeIdentity(identity)}`;
      }
      log.info?.(`[dkg-channel] Route resolved: agent=${route.agentId}, session=${route.sessionKey}`);
    } catch (err: any) {
      log.warn?.(`[dkg-channel] resolveAgentRoute failed: ${err.message}`);
      throw err;
    }

    // Sync the UI-selected project context graph on the resolved sessionKey
    // BEFORE dispatch fires, so slot-backed tool calls (via
    // DkgMemorySearchManager.search → DkgMemorySessionResolver.getSession)
    // during this dispatch can resolve it. If the turn does not carry a
    // UI-selected CG (user deselected in the node UI, or turn arrived from
    // a non-UI channel), CLEAR any previously-stashed CG so recall does
    // not silently scope to a stale project for the full TTL window.
    // Codex Bug B4.
    if (route?.sessionKey) {
      if (uiContextGraphId) {
        this.setSessionProjectContextGraphId(route.sessionKey, uiContextGraphId);
      } else {
        this.clearSessionProjectContextGraphId(route.sessionKey);
      }
    }

    // 2. Resolve store path for session files
    const storePath = runtime.channel.session.resolveStorePath(undefined, { agentId: route.agentId });

    // 3. Build formatted envelope (what the agent sees as the message header)
    const envelopeOpts = runtime.channel.reply.resolveEnvelopeFormatOptions?.(cfg) ?? {};
    const previousTimestamp = runtime.channel.session.readSessionUpdatedAt?.({
      storePath,
      sessionKey: route.sessionKey,
    });
    const agentBody = buildAgentBody(text, { attachmentRefs, contextEntries });
    const commandBody = contextEntries?.length ? agentBody : text;
    const formattedBody = runtime.channel.reply.formatAgentEnvelope({
      channel: 'DKG UI',
      from: identity || 'Owner',
      body: agentBody,
      timestamp: Date.now(),
      previousTimestamp,
      envelope: envelopeOpts,
    });

    // 4. Build FinalizedMsgContext (the context payload for the agent)
    const ctxPayload = {
      Body: formattedBody,
      BodyForAgent: agentBody,
      RawBody: commandBody,
      CommandBody: commandBody,
      BodyForCommands: commandBody,
      ...(commandBody !== text ? { OriginalRawBody: text } : {}),
      From: identity || 'Owner',
      To: route.agentId,
      SessionKey: route.sessionKey,
      AccountId: 'default',
      Provider: CHANNEL_NAME,
      Surface: CHANNEL_NAME,
      ChatType: 'direct',
      CommandAuthorized: true,  // DKG UI user is the agent owner
      SenderId: identity || 'owner',
      SenderName: identity || 'Owner',
      Timestamp: Date.now(),
      ConversationLabel: `DKG UI (${identity || 'Owner'})`,
      ...(attachmentRefs?.length ? {
        AttachmentRefs: attachmentRefs.map((ref) => ({ ...ref })),
        AttachmentSummary: formatAttachmentContext(attachmentRefs),
      } : {}),
      ...(contextEntries?.length ? {
        ContextEntries: contextEntries.map((entry) => ({ ...entry })),
        ContextSummary: formatChatContext(contextEntries),
      } : {}),
    };

    // 5. Dispatch and collect reply
    if (sdk?.dispatchInboundReplyWithBase) {
      log.info?.('[dkg-channel] Using plugin-sdk dispatchInboundReplyWithBase');
      return this.dispatchWithSdk(sdk, cfg, route, storePath, ctxPayload, correlationId);
    }

    // 6. Direct runtime dispatch fallback (no sdk)
    log.debug?.('[dkg-channel] Using direct runtime dispatch');
    return this.dispatchWithRuntime(runtime, cfg, route, storePath, ctxPayload, correlationId);
  }

  private dispatchWithSdk(
    sdk: any,
    cfg: any,
    route: any,
    storePath: string,
    ctxPayload: any,
    correlationId: string,
  ): Promise<ChannelOutboundReply> {
    const log = this.api!.logger;
    const runtime = this.runtime;

    return new Promise<ChannelOutboundReply>((resolve, reject) => {
      const TIMEOUT_MS = CHANNEL_RESPONSE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        reject(new Error('Agent response timeout'));
      }, TIMEOUT_MS);

      const replyChunks: string[] = [];

      sdk.dispatchInboundReplyWithBase({
        cfg,
        channel: CHANNEL_NAME,
        route: { agentId: route.agentId, sessionKey: route.sessionKey },
        storePath,
        ctxPayload,
        core: this.buildSdkCore(runtime, cfg),
        deliver: async (payload: any) => {
          const text = payload?.text;
          if (text) replyChunks.push(text);
        },
        onRecordError: (err: any) => {
          log.warn?.(`[dkg-channel] Session record error: ${err}`);
        },
        onDispatchError: (err: any) => {
          log.warn?.(`[dkg-channel] Dispatch error: ${err}`);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      }).then(() => {
        clearTimeout(timer);
        const replyText = finalizeAgentReplyText(replyChunks.join('\n'));
        log.info?.(`[dkg-channel] Reply dispatched (${replyText.length} chars) for ${correlationId}`);
        resolve({ text: replyText, correlationId });
      }).catch((err: any) => {
        clearTimeout(timer);
        log.warn?.(`[dkg-channel] dispatchInboundReplyWithBase failed: ${err.message}`);
        reject(err);
      });
    });
  }

  private dispatchWithRuntime(
    runtime: any,
    cfg: any,
    route: any,
    storePath: string,
    ctxPayload: any,
    correlationId: string,
  ): Promise<ChannelOutboundReply> {
    const log = this.api!.logger;

    return new Promise<ChannelOutboundReply>((resolve, reject) => {
      const TIMEOUT_MS = CHANNEL_RESPONSE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        reject(new Error('Agent response timeout'));
      }, TIMEOUT_MS);

      const replyChunks: string[] = [];

      void this.recordRuntimeInboundSession(runtime, storePath, route, ctxPayload)
        .then(() => this.dispatchRuntimeReply(
          runtime,
          cfg,
          ctxPayload,
          {
            deliver: async (payload: any) => {
              const text = payload?.text;
              if (text) replyChunks.push(text);
            },
            onError: (err: any) => {
              log.warn?.(`[dkg-channel] Dispatch error: ${err}`);
              clearTimeout(timer);
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          },
          {},
        ))
        .then(() => {
          clearTimeout(timer);
          const replyText = finalizeAgentReplyText(replyChunks.join('\n'));
          log.info?.(`[dkg-channel] Reply dispatched (${replyText.length} chars) for ${correlationId}`);
          resolve({ text: replyText, correlationId });
        })
        .catch((err: any) => {
          clearTimeout(timer);
          log.warn?.(`[dkg-channel] dispatchReplyWithBufferedBlockDispatcher failed: ${err.message}`);
          reject(err);
        });
    });
  }

  // ---------------------------------------------------------------------------
  // Streaming dispatch — yields chunks as they arrive from the agent
  // ---------------------------------------------------------------------------

  /**
   * Stream variant of processInbound. Yields events as the agent produces them.
   * The caller is responsible for writing SSE frames and calling persistTurn after.
   */
  async *processInboundStream(
    text: string,
    correlationId: string,
    identity: string,
    opts?: InboundChatOptions,
  ): AsyncGenerator<{ type: 'text_delta'; delta: string } | { type: 'final'; text: string; correlationId: string }> {
    if (!this.api) throw new Error('Channel not registered');

    const log = this.api.logger;
    const runtime = this.runtime;
    const cfg = this.cfg;
    const attachmentRefs = normalizeAttachmentRefs(opts?.attachmentRefs);
    const contextAttachmentRefs = sanitizeAttachmentRefsForContext(attachmentRefs);
    const contextEntries = normalizeChatContextEntries(opts?.contextEntries);
    const sanitizedContextEntries = sanitizeChatContextEntries(contextEntries);
    const uiContextGraphId = typeof opts?.uiContextGraphId === 'string' && opts.uiContextGraphId.trim()
      ? opts.uiContextGraphId.trim()
      : undefined;
    if (opts?.attachmentRefs != null && attachmentRefs === undefined) {
      throw new Error('Invalid attachment refs');
    }
    if (opts?.contextEntries != null && contextEntries === undefined) {
      throw new Error('Invalid context entries');
    }

    if (!runtime?.channel || !cfg) {
      const reply = await this.processInbound(text, correlationId, identity, { attachmentRefs, contextEntries, uiContextGraphId });
      yield { type: 'final', text: reply.text, correlationId: reply.correlationId ?? correlationId };
      return;
    }

    const sdk = this.loadSdk();

    // Resolve route + build context (same as processInbound)
    const resolved = runtime.channel.routing.resolveAgentRoute({
      cfg, channel: CHANNEL_NAME, accountId: 'default',
      peer: { kind: 'direct', id: identity || 'owner' },
    });
    // Clone to avoid mutating the runtime's cached route object
    const route = { ...resolved };
    // Give non-owner identities (e.g. background workers) their own session
    // so they don't pollute the user's chat context.
    if (identity && identity !== 'owner') {
      route.sessionKey = `agent:${route.agentId}:${sanitizeIdentity(identity)}`;
    }
    // Sync the UI-selected project context graph on the resolved sessionKey
    // BEFORE dispatch fires so slot-backed tool calls during this stream
    // dispatch can resolve it via DkgMemorySessionResolver. If the turn
    // does not carry a UI-selected CG (user deselected in the node UI,
    // or turn arrived from a non-UI channel), CLEAR any previously-stashed
    // CG so recall does not silently scope to a stale project for the full
    // TTL window. Codex Bug B4 (streaming-branch variant).
    if (route?.sessionKey) {
      if (uiContextGraphId) {
        this.setSessionProjectContextGraphId(route.sessionKey, uiContextGraphId);
      } else {
        this.clearSessionProjectContextGraphId(route.sessionKey);
      }
    }
    const storePath = runtime.channel.session.resolveStorePath(undefined, { agentId: route.agentId });
    const envelopeOpts = runtime.channel.reply.resolveEnvelopeFormatOptions?.(cfg) ?? {};
    const previousTimestamp = runtime.channel.session.readSessionUpdatedAt?.({
      storePath, sessionKey: route.sessionKey,
    });
    const agentBody = buildAgentBody(text, { attachmentRefs: contextAttachmentRefs, contextEntries: sanitizedContextEntries });
    const commandBody = sanitizedContextEntries?.length ? agentBody : text;
    const formattedBody = runtime.channel.reply.formatAgentEnvelope({
      channel: 'DKG UI', from: identity || 'Owner', body: agentBody,
      timestamp: Date.now(), previousTimestamp, envelope: envelopeOpts,
    });
    const ctxPayload = {
      Body: formattedBody, BodyForAgent: agentBody, RawBody: commandBody,
      CommandBody: commandBody, BodyForCommands: commandBody,
      ...(commandBody !== text ? { OriginalRawBody: text } : {}),
      From: identity || 'Owner', To: route.agentId,
      SessionKey: route.sessionKey, AccountId: 'default',
      Provider: CHANNEL_NAME, Surface: CHANNEL_NAME, ChatType: 'direct',
      CommandAuthorized: true, SenderId: identity || 'owner',
      SenderName: identity || 'Owner', Timestamp: Date.now(),
      ConversationLabel: `DKG UI (${identity || 'Owner'})`,
      ...(contextAttachmentRefs?.length ? {
        AttachmentRefs: contextAttachmentRefs.map((ref) => ({ ...ref })),
        AttachmentSummary: formatAttachmentContext(contextAttachmentRefs),
      } : {}),
      ...(sanitizedContextEntries?.length ? {
        ContextEntries: sanitizedContextEntries.map((entry) => ({ ...entry })),
        ContextSummary: formatChatContext(sanitizedContextEntries),
      } : {}),
    };

    // Push-based async queue: deliver() pushes, generator yields
    let aborted = false;
    const queue: Array<{ type: 'text_delta'; delta: string } | { type: 'done' } | { type: 'error'; error: Error }> = [];
    let resolve: (() => void) | null = null;
    const waitForItem = () => new Promise<void>(r => { resolve = r; });
    const push = (item: typeof queue[0]) => {
      if (aborted) return; // Generator exited — discard
      queue.push(item);
      if (resolve) { const r = resolve; resolve = null; r(); }
    };

    const TIMEOUT_MS = CHANNEL_RESPONSE_TIMEOUT_MS;
    const timer = setTimeout(() => push({ type: 'error', error: new Error('Agent response timeout') }), TIMEOUT_MS);

    let replyText = '';
    let dispatchTerminal: 'done' | 'error' | null = null;
    let dispatchFailureMessage: string | null = null;
    const deliver = async (payload: any) => {
      const t = payload?.text;
      if (t) {
        replyText += t;
        push({ type: 'text_delta', delta: t });
      }
    };

    // Start dispatch (fire-and-forget — chunks come via deliver callback)
    const dispatchFn = sdk?.dispatchInboundReplyWithBase
      ? () => sdk.dispatchInboundReplyWithBase({
          cfg, channel: CHANNEL_NAME,
          route: { agentId: route.agentId, sessionKey: route.sessionKey },
          storePath, ctxPayload,
          core: this.buildSdkCore(runtime, cfg),
          deliver,
          replyOptions: this.buildStreamingReplyOptions(),
          onRecordError: (err: any) => log.warn?.(`[dkg-channel] Session record error: ${err}`),
          onDispatchError: (err: any) => push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) }),
        })
      : () => this.recordRuntimeInboundSession(runtime, storePath, route, ctxPayload).then(() =>
          this.dispatchRuntimeReply(
            runtime,
            cfg,
            ctxPayload,
            {
              deliver,
              onError: (err: any) => push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) }),
            },
            this.buildStreamingReplyOptions(),
          ),
        );

    const dispatchCompletion = dispatchFn()
      .then(() => {
        dispatchTerminal = 'done';
        push({ type: 'done' });
      })
      .catch((err: any) => {
        dispatchTerminal = 'error';
        const dispatchFailure = err instanceof Error ? err : new Error(String(err));
        dispatchFailureMessage = dispatchFailure.message;
        push({ type: 'error', error: dispatchFailure });
      });

    const persistResolvedTerminalState = (): void => {
      let resolvedTerminalState = terminalState;
      let resolvedFinalText = finalText;
      let resolvedFailureReason = failureReason;

      if (resolvedTerminalState === 'cancelled') {
        const queuedTerminal = [...queue].reverse().find(
          (item): item is { type: 'done' } | { type: 'error'; error: Error } =>
            item.type === 'done' || item.type === 'error',
        );
        if (queuedTerminal?.type === 'done' || dispatchTerminal === 'done') {
          try {
            resolvedFinalText = finalizeAgentReplyText(replyText);
            resolvedTerminalState = 'completed';
          } catch (err) {
            resolvedTerminalState = 'failed';
            resolvedFailureReason = getErrorMessage(err);
          }
        } else if (queuedTerminal?.type === 'error' || dispatchTerminal === 'error') {
          const queuedTerminalError: Error | null =
            queuedTerminal && queuedTerminal.type === 'error' ? queuedTerminal.error : null;
          resolvedTerminalState = 'failed';
          resolvedFailureReason = queuedTerminalError?.message ?? dispatchFailureMessage ?? resolvedFailureReason;
        }
      }

      if (resolvedTerminalState === 'completed' && resolvedFinalText) {
        this.queueTurnPersistence(text, resolvedFinalText, correlationId, identity, {
          attachmentRefs,
        }, true);
      } else if (resolvedTerminalState === 'failed') {
        this.queueTurnPersistence(
          text,
          this.buildFailedAssistantReply(resolvedFailureReason),
          correlationId,
          identity,
          { persistenceState: 'failed', failureReason: resolvedFailureReason, attachmentRefs },
          true,
        );
      } else {
        this.queueTurnPersistence(
          text,
          CANCELLED_TURN_MESSAGE,
          correlationId,
          identity,
          { persistenceState: 'failed', failureReason: 'cancelled', attachmentRefs },
          true,
        );
      }
    };

    // Yield events as they arrive
    let terminalState: 'cancelled' | 'completed' | 'failed' = 'cancelled';
    let finalText: string | null = null;
    let failureReason: string | null = null;
    let completed = false;
    try {
      while (true) {
        while (queue.length === 0) await waitForItem();
        const item = queue.shift()!;
        if (item.type === 'text_delta') {
          yield item;
        } else if (item.type === 'done') {
          try {
            finalText = finalizeAgentReplyText(replyText);
            terminalState = 'completed';
          } catch (err) {
            terminalState = 'failed';
            failureReason = getErrorMessage(err);
            throw err;
          }
          completed = true;
          break;
        } else if (item.type === 'error') {
          terminalState = 'failed';
          failureReason = item.error.message;
          clearTimeout(timer);
          throw item.error;
        }
      }
    } finally {
      clearTimeout(timer);
      aborted = true; // Stop dangling deliver() callbacks from queuing

      if (terminalState === 'cancelled' && dispatchTerminal == null) {
        void dispatchCompletion.finally(() => {
          persistResolvedTerminalState();
        });
        return;
      }

      persistResolvedTerminalState();
    }

    // Only yield final if the stream completed normally (not cancelled)
    if (completed && finalText) {
      yield { type: 'final', text: finalText, correlationId };
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound reply handling  (OpenClaw session → DKG daemon)
  // ---------------------------------------------------------------------------

  private async handleOutboundReply(reply: ChannelOutboundReply): Promise<void> {
    const correlationId = reply.correlationId;
    if (!correlationId) return;

    const pending = this.pendingRequests.get(correlationId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(correlationId);
      pending.resolve(reply);
    }
  }

  // ---------------------------------------------------------------------------
  // Chat turn persistence  (DKG graph for Agent Hub visualization)
  // ---------------------------------------------------------------------------

  private dispatchRuntimeReply(
    runtime: any,
    cfg: any,
    ctxPayload: any,
    dispatcherOptions: Record<string, unknown>,
    replyOptions: Record<string, unknown>,
  ): Promise<unknown> {
    const replyRuntime = runtime?.channel?.reply;
    const dispatch = replyRuntime?.dispatchReplyWithBufferedBlockDispatcher;
    if (typeof dispatch !== 'function') {
      return Promise.reject(new Error('runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher unavailable'));
    }

    // OpenClaw moved this dispatcher from positional args to a single params object.
    // Support both to keep the adapter compatible with host runtime drift.
    if (dispatch.length <= 1) {
      return dispatch.call(replyRuntime, {
        ctx: ctxPayload,
        cfg,
        dispatcherOptions,
        replyOptions,
      });
    }

    return dispatch.call(replyRuntime, ctxPayload, cfg, dispatcherOptions, replyOptions);
  }

  private buildSdkCore(runtime: any, cfg: any): {
    channel: {
      session: { recordInboundSession: (params: any) => Promise<unknown> | unknown };
      reply: { dispatchReplyWithBufferedBlockDispatcher: (params: any) => Promise<unknown> };
    };
  } {
    return {
      channel: {
        session: {
          recordInboundSession: (params: any) => runtime.channel.session.recordInboundSession(params),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: (params: any) => this.dispatchRuntimeReply(
            runtime,
            params?.cfg ?? cfg,
            params?.ctx ?? params?.ctxPayload,
            params?.dispatcherOptions ?? {},
            params?.replyOptions ?? {},
          ),
        },
      },
    };
  }

  private async recordRuntimeInboundSession(
    runtime: any,
    storePath: string,
    route: any,
    ctxPayload: any,
  ): Promise<void> {
    const log = this.api?.logger;
    const sessionRuntime = runtime?.channel?.session;
    const record = sessionRuntime?.recordInboundSession;
    if (typeof record !== 'function') return;

    try {
      await Promise.resolve(record.call(sessionRuntime, {
        storePath,
        sessionKey: route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: any) => {
          log?.warn?.(`[dkg-channel] Session record error: ${err}`);
        },
        channel: CHANNEL_NAME,
        chatType: 'direct',
        peer: { kind: 'direct', id: ctxPayload?.SenderId ?? 'owner' },
      }));
    } catch (err: any) {
      log?.warn?.(`[dkg-channel] recordInboundSession failed: ${err.message}`);
    }
  }

  private handleUnexpectedHttpError(res: ServerResponse, err: unknown): void {
    this.api?.logger.warn?.(`[dkg-channel] Unexpected bridge HTTP error: ${formatError(err)}`);
    if (res.writableEnded) return;
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal bridge error' }));
    } catch {
      // Ignore response write failures after socket teardown.
    }
  }

  private handleUnexpectedGatewayError(res: any, err: unknown): void {
    this.api?.logger.warn?.(`[dkg-channel] Unexpected gateway route error: ${formatError(err)}`);
    try {
      res.writeHead?.(500, { 'Content-Type': 'application/json' });
      res.end?.(JSON.stringify({ error: 'Internal bridge error' }));
    } catch {
      // Ignore response write failures after route teardown.
    }
  }

  /**
   * Persist a chat turn into the `'chat-turns'` Working Memory assertion of
   * the `'agent-context'` context graph via the daemon's
   * `/api/openclaw-channel/persist-turn` route. Fire-and-forget — errors
   * are logged but don't affect the reply.
   */
  private async persistTurn(
    userMessage: string,
    assistantReply: string,
    correlationId: string,
    identity: string,
    opts?: PersistTurnOptions,
  ): Promise<void> {
    // Non-owner identities (e.g. background workers) get their own session
    // so they don't pollute the user's DKG UI chat history.
    const sessionId = identity && identity !== 'owner'
      ? `openclaw:${CHANNEL_NAME}:${sanitizeIdentity(identity)}`
      : `openclaw:${CHANNEL_NAME}`;
    await this.client.storeChatTurn(
      sessionId,
      userMessage,
      assistantReply,
      {
        turnId: correlationId,
        ...(opts?.attachmentRefs?.length ? { attachmentRefs: opts.attachmentRefs.map((ref) => ({ ...ref })) } : {}),
        ...(opts?.persistenceState ? { persistenceState: opts.persistenceState } : {}),
        ...(opts?.failureReason != null ? { failureReason: opts.failureReason } : {}),
      },
    );
    this.api?.logger.info?.(`[dkg-channel] Turn persisted to DKG graph: ${correlationId}`);
  }

  private queueTurnPersistence(
    userMessage: string,
    assistantReply: string,
    correlationId: string,
    identity: string,
    opts?: PersistTurnOptions,
    allowDuringShutdown = false,
  ): void {
    if (!this.canContinuePersistenceAttempt(allowDuringShutdown) || this.pendingTurnPersistence.has(correlationId)) return;

    const attemptPersist = (attempt: number): void => {
      if (!this.canContinuePersistenceAttempt(allowDuringShutdown)) return;
      this.pendingTurnPersistence.set(correlationId, { attempt, timer: null, allowDuringShutdown });
      void this.persistTurn(userMessage, assistantReply, correlationId, identity, opts)
        .then(() => {
          this.deletePendingTurnPersistence(correlationId);
        })
        .catch((err: any) => {
          const currentJob = this.pendingTurnPersistence.get(correlationId);
          if (!currentJob) {
            return;
          }
          if (!this.canContinuePersistenceAttempt(allowDuringShutdown)) {
            this.deletePendingTurnPersistence(correlationId);
            return;
          }

          const retryDelayMs = TURN_PERSIST_RETRY_DELAYS_MS[attempt - 1];
          if (retryDelayMs == null) {
            this.deletePendingTurnPersistence(correlationId);
            this.api?.logger.warn?.(
              `[dkg-channel] Turn persistence failed permanently after ${attempt} attempt(s): ${err.message}`,
            );
            return;
          }

          this.api?.logger.warn?.(
            `[dkg-channel] Turn persistence failed (attempt ${attempt}); retrying in ${retryDelayMs}ms: ${err.message}`,
          );
          const timer = setTimeout(() => {
            if (!this.canContinuePersistenceAttempt(allowDuringShutdown)) {
              this.deletePendingTurnPersistence(correlationId);
              return;
            }
            const job = this.pendingTurnPersistence.get(correlationId);
            if (!job) return;
            this.pendingTurnPersistence.set(correlationId, { attempt: attempt + 1, timer: null, allowDuringShutdown });
            attemptPersist(attempt + 1);
          }, retryDelayMs);
          this.pendingTurnPersistence.set(correlationId, { attempt, timer, allowDuringShutdown });
        });
    };

    attemptPersist(1);
  }

  private buildFailedAssistantReply(reason?: string | null): string {
    const normalizedReason = reason?.trim();
    if (!normalizedReason || normalizedReason === 'cancelled') {
      return CANCELLED_TURN_MESSAGE;
    }
    return `${FAILED_TURN_MESSAGE_PREFIX}: ${normalizedReason}]`;
  }

  // ---------------------------------------------------------------------------
  // HTTP server handlers (standalone bridge mode)
  // ---------------------------------------------------------------------------

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/inbound') {
      await this.handleInboundHttp(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/inbound/stream') {
      await this.handleInboundStreamHttp(req, res);
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      if (!this.authorizeBridgeRequest(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel: CHANNEL_NAME }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async handleInboundHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorizeBridgeRequest(req, res)) return;
    if (this.inFlight >= this.maxInFlight) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many concurrent requests', retryAfter: 5 }));
      return;
    }

    const start = Date.now();
    this.inFlight++;
    try {
      let parsed: { text?: string; correlationId?: string; identity?: string; attachmentRefs?: unknown; contextEntries?: unknown; uiContextGraphId?: unknown };
      try {
        const body = await readBody(req);
        parsed = JSON.parse(body);
      } catch (err: any) {
        if (err.message === 'Request body too large') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      try {
        const attachmentRefs = normalizeAttachmentRefs(parsed.attachmentRefs);
        const contextEntries = normalizeChatContextEntries(parsed.contextEntries);
        if (parsed.attachmentRefs != null && attachmentRefs === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid "attachmentRefs"' }));
          return;
        }
        if (parsed.contextEntries != null && contextEntries === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid "contextEntries"' }));
          return;
        }
        const uiContextGraphId = typeof parsed.uiContextGraphId === 'string' && parsed.uiContextGraphId.trim()
          ? parsed.uiContextGraphId.trim()
          : undefined;
        const { text, correlationId, identity } = parsed;
        if (!hasInboundChatTurnContent(text, attachmentRefs) || typeof correlationId !== 'string' || correlationId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "text" or "correlationId"' }));
          return;
        }
        const reply = await this.processInbound(text, correlationId, identity ?? 'owner', { attachmentRefs, contextEntries, uiContextGraphId });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      } catch (err: any) {
        const status = err.message === 'Agent response timeout' ? 504 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } finally {
      this.inFlight--;
      this.notifyStopIdle();
      const durationMs = Date.now() - start;
      this.api?.logger.info?.(`[dkg-channel] handleInboundHttp completed in ${durationMs}ms`);
    }
  }

  /** SSE streaming handler — yields events as the agent produces them. */
  private async handleInboundStreamHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorizeBridgeRequest(req, res)) return;
    if (this.inFlight >= this.maxInFlight) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many concurrent requests', retryAfter: 5 }));
      return;
    }

    const start = Date.now();
    this.inFlight++;
    try {
      let parsed: { text?: string; correlationId?: string; identity?: string; attachmentRefs?: unknown; contextEntries?: unknown; uiContextGraphId?: unknown };
      try {
        const body = await readBody(req);
        parsed = JSON.parse(body);
      } catch (err: any) {
        if (err.message === 'Request body too large') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      const attachmentRefs = normalizeAttachmentRefs(parsed.attachmentRefs);
      const contextEntries = normalizeChatContextEntries(parsed.contextEntries);
      if (parsed.attachmentRefs != null && attachmentRefs === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid "attachmentRefs"' }));
        return;
      }
      if (parsed.contextEntries != null && contextEntries === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid "contextEntries"' }));
        return;
      }
      const uiContextGraphId = typeof parsed.uiContextGraphId === 'string' && parsed.uiContextGraphId.trim()
        ? parsed.uiContextGraphId.trim()
        : undefined;
      const { text, correlationId, identity } = parsed;
      if (!hasInboundChatTurnContent(text, attachmentRefs) || typeof correlationId !== 'string' || correlationId.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "text" or "correlationId"' }));
        return;
      }

      // Write SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      let clientDisconnected = false;
      res.on('close', () => { clientDisconnected = true; });
      res.on('error', () => { clientDisconnected = true; });

      try {
        for await (const event of this.processInboundStream(text, correlationId, identity ?? 'owner', { attachmentRefs, contextEntries, uiContextGraphId })) {
          if (clientDisconnected) break;
          const ok = res.write(`data: ${JSON.stringify(event)}\n\n`);
          if (!ok) await new Promise<void>((r) => res.once('drain', r));
        }
      } catch (err: any) {
        if (!clientDisconnected) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        }
      }
      if (!res.writableEnded) res.end();
    } finally {
      this.inFlight--;
      this.notifyStopIdle();
      const durationMs = Date.now() - start;
      this.api?.logger.info?.(`[dkg-channel] handleInboundStreamHttp completed in ${durationMs}ms`);
    }
  }

  /** Handler for api.registerHttpRoute() — same logic, different req/res shape. */
  private async handleGatewayRoute(req: any, res: any): Promise<void> {
    try {
      const body = typeof req.body === 'object' ? req.body : JSON.parse(await readBody(req));
      const attachmentRefs = normalizeAttachmentRefs(body.attachmentRefs);
      const contextEntries = normalizeChatContextEntries(body.contextEntries);
      if (body.attachmentRefs != null && attachmentRefs === undefined) {
        res.writeHead?.(400, { 'Content-Type': 'application/json' });
        res.end?.(JSON.stringify({ error: 'Invalid "attachmentRefs"' }));
        return;
      }
      if (body.contextEntries != null && contextEntries === undefined) {
        res.writeHead?.(400, { 'Content-Type': 'application/json' });
        res.end?.(JSON.stringify({ error: 'Invalid "contextEntries"' }));
        return;
      }
      const uiContextGraphId = typeof body.uiContextGraphId === 'string' && body.uiContextGraphId.trim()
        ? body.uiContextGraphId.trim()
        : undefined;
      const { text, correlationId, identity } = body;
      if (!hasInboundChatTurnContent(text, attachmentRefs) || typeof correlationId !== 'string' || correlationId.length === 0) {
        res.writeHead?.(400, { 'Content-Type': 'application/json' });
        res.end?.(JSON.stringify({ error: 'Missing "text" or "correlationId"' }));
        return;
      }

      const reply = await this.processInbound(text, correlationId, identity ?? 'owner', { attachmentRefs, contextEntries, uiContextGraphId });
      res.writeHead?.(200, { 'Content-Type': 'application/json' });
      res.end?.(JSON.stringify(reply));
    } catch (err: any) {
      const status = err.message === 'Agent response timeout' ? 504 : 500;
      res.writeHead?.(status, { 'Content-Type': 'application/json' });
      res.end?.(JSON.stringify({ error: err.message }));
    }
  }

  private authorizeBridgeRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const expectedToken = this.client.getAuthToken();
    if (!expectedToken) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bridge auth token unavailable' }));
      return false;
    }

    const rawHeader = req.headers['x-dkg-bridge-token'];
    const providedToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (providedToken !== expectedToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Public accessors (for wiring in DkgNodePlugin)
  // ---------------------------------------------------------------------------

  get bridgePort(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : this.port;
  }

  get isListening(): boolean {
    return this.server?.listening === true;
  }

  get isUsingGatewayRoute(): boolean {
    return this.useGatewayRoute;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) {
        settled = true;
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf-8')); } });
    req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
