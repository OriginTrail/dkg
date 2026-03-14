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
import type { DkgDaemonClient } from './dkg-client.js';

export const CHANNEL_NAME = 'dkg-ui';
const DEFAULT_CHANNEL_ACCOUNT_ID = 'default';

/** Strip identity to safe characters and cap length to prevent injection into session keys / URIs. */
function sanitizeIdentity(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
}
const moduleRequire = createRequire(import.meta.url);

interface PendingRequest {
  resolve: (reply: ChannelOutboundReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  private readonly port: number;
  private useGatewayRoute = false;
  private inFlight = 0;
  private readonly maxInFlight = 3;

  constructor(
    private readonly config: NonNullable<DkgOpenClawConfig['channel']>,
    private readonly client: DkgDaemonClient,
  ) {
    this.port = config.port ?? 9201;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  register(api: OpenClawPluginApi): void {
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
    if (typeof api.registerChannel === 'function') {
      api.registerChannel({
        plugin: this.buildRegisteredChannelPlugin(),
      });
      log.info?.('[dkg-channel] Registered as OpenClaw channel via registerChannel()');
    }

    // --- Register an HTTP route on the gateway ---
    if (typeof api.registerHttpRoute === 'function') {
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
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel shutting down'));
      this.pendingRequests.delete(id);
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
        blurb: 'Local DKG Agent Hub bridge',
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
  ): Promise<ChannelOutboundReply> {
    const api = this.api;
    if (!api) throw new Error('Channel not registered');

    const runtime = this.runtime;
    const cfg = this.cfg;

    // --- Primary: dispatch via runtime channel (uses plugin-sdk when available) ---
    if (runtime?.channel && cfg) {
      api.logger.info?.(`[dkg-channel] Dispatching for: ${correlationId}`);
      try {
        const reply = await this.dispatchViaPluginSdk(text, correlationId, identity);
        // Fire-and-forget: persist turn to DKG graph for Agent Hub visualization
        this.persistTurn(text, reply.text, correlationId, identity).catch((err) => {
          api.logger.warn?.(`[dkg-channel] Turn persistence failed: ${err.message}`);
        });
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
        text,
        correlationId,
      });
      this.persistTurn(text, reply.text, correlationId, identity || 'owner').catch((err) => {
        api.logger.warn?.(`[dkg-channel] Turn persistence failed: ${err.message}`);
      });
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
      // Give non-owner identities (e.g. game-autopilot) their own session
      // so they don't pollute the user's chat context.
      if (identity && identity !== 'owner') {
        route.sessionKey = `agent:${route.agentId}:${sanitizeIdentity(identity)}`;
      }
      log.info?.(`[dkg-channel] Route resolved: agent=${route.agentId}, session=${route.sessionKey}`);
    } catch (err: any) {
      log.warn?.(`[dkg-channel] resolveAgentRoute failed: ${err.message}`);
      throw err;
    }

    // 2. Resolve store path for session files
    const storePath = runtime.channel.session.resolveStorePath(undefined, { agentId: route.agentId });

    // 3. Build formatted envelope (what the agent sees as the message header)
    const envelopeOpts = runtime.channel.reply.resolveEnvelopeFormatOptions?.(cfg) ?? {};
    const previousTimestamp = runtime.channel.session.readSessionUpdatedAt?.({
      storePath,
      sessionKey: route.sessionKey,
    });
    const formattedBody = runtime.channel.reply.formatAgentEnvelope({
      channel: 'DKG UI',
      from: identity || 'Owner',
      body: text,
      timestamp: Date.now(),
      previousTimestamp,
      envelope: envelopeOpts,
    });

    // 4. Build FinalizedMsgContext (the context payload for the agent)
    const ctxPayload = {
      Body: formattedBody,
      BodyForAgent: text,
      RawBody: text,
      CommandBody: text,
      BodyForCommands: text,
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
      const TIMEOUT_MS = 120_000;
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
        const replyText = replyChunks.join('\n') || '(no response)';
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
      const TIMEOUT_MS = 120_000;
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
          const replyText = replyChunks.join('\n') || '(no response)';
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
  ): AsyncGenerator<{ type: 'text_delta'; delta: string } | { type: 'final'; text: string; correlationId: string }> {
    if (!this.api) throw new Error('Channel not registered');

    const log = this.api.logger;
    const runtime = this.runtime;
    const cfg = this.cfg;

    if (!runtime?.channel || !cfg) {
      const reply = await this.processInbound(text, correlationId, identity);
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
    // Give non-owner identities (e.g. game-autopilot) their own session
    // so they don't pollute the user's chat context.
    if (identity && identity !== 'owner') {
      route.sessionKey = `agent:${route.agentId}:${sanitizeIdentity(identity)}`;
    }
    const storePath = runtime.channel.session.resolveStorePath(undefined, { agentId: route.agentId });
    const envelopeOpts = runtime.channel.reply.resolveEnvelopeFormatOptions?.(cfg) ?? {};
    const previousTimestamp = runtime.channel.session.readSessionUpdatedAt?.({
      storePath, sessionKey: route.sessionKey,
    });
    const formattedBody = runtime.channel.reply.formatAgentEnvelope({
      channel: 'DKG UI', from: identity || 'Owner', body: text,
      timestamp: Date.now(), previousTimestamp, envelope: envelopeOpts,
    });
    const ctxPayload = {
      Body: formattedBody, BodyForAgent: text, RawBody: text,
      CommandBody: text, BodyForCommands: text,
      From: identity || 'Owner', To: route.agentId,
      SessionKey: route.sessionKey, AccountId: 'default',
      Provider: CHANNEL_NAME, Surface: CHANNEL_NAME, ChatType: 'direct',
      CommandAuthorized: true, SenderId: identity || 'owner',
      SenderName: identity || 'Owner', Timestamp: Date.now(),
      ConversationLabel: `DKG UI (${identity || 'Owner'})`,
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

    const TIMEOUT_MS = 120_000;
    const timer = setTimeout(() => push({ type: 'error', error: new Error('Agent response timeout') }), TIMEOUT_MS);

    let replyText = '';
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

    dispatchFn()
      .then(() => push({ type: 'done' }))
      .catch((err: any) => push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) }));

    // Yield events as they arrive
    let completed = false;
    try {
      while (true) {
        while (queue.length === 0) await waitForItem();
        const item = queue.shift()!;
        if (item.type === 'text_delta') {
          yield item;
        } else if (item.type === 'done') {
          completed = true;
          break;
        } else if (item.type === 'error') {
          clearTimeout(timer);
          throw item.error;
        }
      }
    } finally {
      clearTimeout(timer);
      aborted = true; // Stop dangling deliver() callbacks from queuing

      // Persist turn even if the consumer cancelled early — use accumulated text
      const persistText = replyText || '(no response)';
      this.persistTurn(text, persistText, correlationId, identity).catch(err => {
        log.warn?.(`[dkg-channel] Turn persistence failed: ${err.message}`);
      });
    }

    // Only yield final if the stream completed normally (not cancelled)
    if (completed) {
      const finalText = replyText || '(no response)';
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
   * Persist a chat turn to the DKG agent-memory graph.
   * Fire-and-forget — errors are logged but don't affect the reply.
   */
  private async persistTurn(
    userMessage: string,
    assistantReply: string,
    correlationId: string,
    identity: string,
  ): Promise<void> {
    // Non-owner identities (e.g. game-autopilot) get their own session
    // so they don't pollute the user's DKG UI chat history.
    const sessionId = identity && identity !== 'owner'
      ? `openclaw:${CHANNEL_NAME}:${sanitizeIdentity(identity)}`
      : `openclaw:${CHANNEL_NAME}`;
    await this.client.storeChatTurn(
      sessionId,
      userMessage,
      assistantReply,
      { turnId: correlationId },
    );
    this.api?.logger.info?.(`[dkg-channel] Turn persisted to DKG graph: ${correlationId}`);
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
      let parsed: { text?: string; correlationId?: string; identity?: string };
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

      const { text, correlationId, identity } = parsed;
      if (!text || !correlationId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "text" or "correlationId"' }));
        return;
      }

      try {
        const reply = await this.processInbound(text, correlationId, identity ?? 'owner');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      } catch (err: any) {
        const status = err.message === 'Agent response timeout' ? 504 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } finally {
      this.inFlight--;
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
      let parsed: { text?: string; correlationId?: string; identity?: string };
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

      const { text, correlationId, identity } = parsed;
      if (!text || !correlationId) {
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
        for await (const event of this.processInboundStream(text, correlationId, identity ?? 'owner')) {
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
      const durationMs = Date.now() - start;
      this.api?.logger.info?.(`[dkg-channel] handleInboundStreamHttp completed in ${durationMs}ms`);
    }
  }

  /** Handler for api.registerHttpRoute() — same logic, different req/res shape. */
  private async handleGatewayRoute(req: any, res: any): Promise<void> {
    try {
      const body = typeof req.body === 'object' ? req.body : JSON.parse(await readBody(req));
      const { text, correlationId, identity } = body;
      if (!text || !correlationId) {
        res.writeHead?.(400, { 'Content-Type': 'application/json' });
        res.end?.(JSON.stringify({ error: 'Missing "text" or "correlationId"' }));
        return;
      }

      const reply = await this.processInbound(text, correlationId, identity ?? 'owner');
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
