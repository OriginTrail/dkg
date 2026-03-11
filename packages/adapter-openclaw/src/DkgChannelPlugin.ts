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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  ChannelOutboundReply,
  DkgOpenClawConfig,
  OpenClawPluginApi,
} from './types.js';
import type { DkgDaemonClient } from './dkg-client.js';

export const CHANNEL_NAME = 'dkg-ui';

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
  private server: Server | null = null;
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
        plugin: {
          id: CHANNEL_NAME,
          name: CHANNEL_NAME,
          meta: { displayName: 'DKG UI' },
          capabilities: {},
          start: () => this.start(),
          stop: () => this.stop(),
          onOutbound: (reply) => this.handleOutboundReply(reply),
        },
      });
      log.info?.('[dkg-channel] Registered as OpenClaw channel via registerChannel()');
    }

    // --- Register an HTTP route on the gateway ---
    if (typeof api.registerHttpRoute === 'function') {
      api.registerHttpRoute({
        method: 'POST',
        path: '/api/dkg-channel/inbound',
        auth: 'gateway',
        handler: (req: any, res: any) => this.handleGatewayRoute(req, res),
      });
      this.useGatewayRoute = true;
      log.info?.('[dkg-channel] Registered HTTP route on gateway: POST /api/dkg-channel/inbound');
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
    if (this.server) return;

    this.server = createServer((req, res) => this.handleHttpRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.api?.logger.info?.(`[dkg-channel] Bridge server listening on 127.0.0.1:${this.port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel shutting down'));
      this.pendingRequests.delete(id);
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
    if (this.sdk) return this.sdk;
    try {
      // In-process: the OpenClaw gateway already has this module loaded
      this.sdk = require('openclaw/plugin-sdk');
    } catch {
      // Fallback: resolve via module.createRequire from the OpenClaw install
      try {
        const { createRequire } = require('node:module');
        const ocMain = require.resolve('openclaw');
        const ocRequire = createRequire(ocMain);
        this.sdk = ocRequire('./plugin-sdk');
      } catch {
        this.api?.logger.warn?.('[dkg-channel] Could not load openclaw/plugin-sdk — dispatch unavailable');
      }
    }
    return this.sdk;
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

    // --- Primary: dispatch via plugin-sdk (same as Telegram/Discord) ---
    if (runtime?.channel && cfg) {
      api.logger.info?.(`[dkg-channel] Dispatching via plugin-sdk for: ${correlationId}`);
      try {
        const reply = await this.dispatchViaPluginSdk(text, correlationId, identity);
        // Fire-and-forget: persist turn to DKG graph for Agent Hub visualization
        this.persistTurn(text, reply.text, correlationId).catch((err) => {
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

    // --- Fallback: pending request waiting for onOutbound callback ---
    if (typeof (api as any).registerChannel === 'function') {
      return new Promise<ChannelOutboundReply>((resolve, reject) => {
        const TIMEOUT_MS = 120_000;
        const timer = setTimeout(() => {
          this.pendingRequests.delete(correlationId);
          reject(new Error('Agent response timeout'));
        }, TIMEOUT_MS);

        this.pendingRequests.set(correlationId, { resolve, reject, timer });
      });
    }

    throw new Error(
      'No message routing mechanism available. ' +
      'The OpenClaw gateway must support runtime.channel dispatch or registerChannel().',
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
      route = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: CHANNEL_NAME,
        accountId: 'default',
        peer: { kind: 'direct', id: identity || 'owner' },
      });
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
    log.info?.('[dkg-channel] Falling back to direct runtime dispatch');
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
        core: {
          channel: {
            session: { recordInboundSession: runtime.channel.session.recordInboundSession },
            reply: { dispatchReplyWithBufferedBlockDispatcher: runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher },
          },
        },
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

      // Record inbound session
      try {
        runtime.channel.session.recordInboundSession({
          storePath,
          sessionKey: route.sessionKey,
          channel: CHANNEL_NAME,
          chatType: 'direct',
          peer: { kind: 'direct', id: 'owner' },
        });
      } catch (err: any) {
        log.warn?.(`[dkg-channel] recordInboundSession failed: ${err.message}`);
      }

      // Dispatch via the buffered block dispatcher
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher(
        ctxPayload,
        cfg,
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
        {},  // replyOptions
      ).then(() => {
        clearTimeout(timer);
        const replyText = replyChunks.join('\n') || '(no response)';
        log.info?.(`[dkg-channel] Reply dispatched (${replyText.length} chars) for ${correlationId}`);
        resolve({ text: replyText, correlationId });
      }).catch((err: any) => {
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
    if (!this.api || !this.runtime) throw new Error('Channel not registered');

    const log = this.api.logger;
    const runtime = this.runtime;
    const cfg = this.cfg;
    const sdk = this.loadSdk();

    // Resolve route + build context (same as processInbound)
    const route = runtime.channel.routing.resolveAgentRoute({
      cfg, channel: CHANNEL_NAME, accountId: 'default',
      peer: { kind: 'direct', id: identity || 'owner' },
    });
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
    const queue: Array<{ type: 'text_delta'; delta: string } | { type: 'done' } | { type: 'error'; error: Error }> = [];
    let resolve: (() => void) | null = null;
    const waitForItem = () => new Promise<void>(r => { resolve = r; });
    const push = (item: typeof queue[0]) => {
      queue.push(item);
      if (resolve) { const r = resolve; resolve = null; r(); }
    };

    const TIMEOUT_MS = 120_000;
    const timer = setTimeout(() => push({ type: 'error', error: new Error('Agent response timeout') }), TIMEOUT_MS);

    const replyChunks: string[] = [];
    const deliver = async (payload: any) => {
      const t = payload?.text;
      if (t) {
        replyChunks.push(t);
        push({ type: 'text_delta', delta: t });
      }
    };

    // Start dispatch (fire-and-forget — chunks come via deliver callback)
    const dispatchFn = sdk?.dispatchInboundReplyWithBase
      ? () => sdk.dispatchInboundReplyWithBase({
          cfg, channel: CHANNEL_NAME,
          route: { agentId: route.agentId, sessionKey: route.sessionKey },
          storePath, ctxPayload,
          core: {
            channel: {
              session: { recordInboundSession: runtime.channel.session.recordInboundSession },
              reply: { dispatchReplyWithBufferedBlockDispatcher: runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher },
            },
          },
          deliver,
          onRecordError: (err: any) => log.warn?.(`[dkg-channel] Session record error: ${err}`),
          onDispatchError: (err: any) => push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) }),
        })
      : () => {
          try {
            runtime.channel.session.recordInboundSession({
              storePath, sessionKey: route.sessionKey, channel: CHANNEL_NAME,
              chatType: 'direct', peer: { kind: 'direct', id: 'owner' },
            });
          } catch (err: any) {
            log.warn?.(`[dkg-channel] recordInboundSession failed: ${err.message}`);
          }
          return runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher(
            ctxPayload, cfg,
            {
              deliver,
              onError: (err: any) => push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) }),
            },
            {},
          );
        };

    dispatchFn()
      .then(() => push({ type: 'done' }))
      .catch((err: any) => push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) }));

    // Yield events as they arrive
    try {
      while (true) {
        while (queue.length === 0) await waitForItem();
        const item = queue.shift()!;
        if (item.type === 'text_delta') {
          yield item;
        } else if (item.type === 'done') {
          break;
        } else if (item.type === 'error') {
          clearTimeout(timer);
          throw item.error;
        }
      }
    } finally {
      clearTimeout(timer);
    }

    const finalText = replyChunks.join('\n') || '(no response)';
    yield { type: 'final', text: finalText, correlationId };

    // Fire-and-forget: persist turn to DKG graph
    this.persistTurn(text, finalText, correlationId).catch(err => {
      log.warn?.(`[dkg-channel] Turn persistence failed: ${err.message}`);
    });
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

  /**
   * Persist a chat turn to the DKG agent-memory graph.
   * Fire-and-forget — errors are logged but don't affect the reply.
   */
  private async persistTurn(
    userMessage: string,
    assistantReply: string,
    correlationId: string,
  ): Promise<void> {
    await this.client.storeChatTurn(
      `openclaw:${CHANNEL_NAME}`,
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
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
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
      res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel: CHANNEL_NAME }));
      return;
    }

    res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async handleInboundHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.inFlight >= this.maxInFlight) {
      res.writeHead(429, { ...corsHeaders(), 'Content-Type': 'application/json' });
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
          res.writeHead(413, { ...corsHeaders(), 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }
        res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      const { text, correlationId, identity } = parsed;
      if (!text || !correlationId) {
        res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "text" or "correlationId"' }));
        return;
      }

      try {
        const reply = await this.processInbound(text, correlationId, identity ?? 'owner');

        res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      } catch (err: any) {
        const status = err.message === 'Agent response timeout' ? 504 : 500;
        res.writeHead(status, { ...corsHeaders(), 'Content-Type': 'application/json' });
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
    if (this.inFlight >= this.maxInFlight) {
      res.writeHead(429, { ...corsHeaders(), 'Content-Type': 'application/json' });
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
          res.writeHead(413, { ...corsHeaders(), 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }
        res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      const { text, correlationId, identity } = parsed;
      if (!text || !correlationId) {
        res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "text" or "correlationId"' }));
        return;
      }

      // Write SSE headers
      res.writeHead(200, {
        ...corsHeaders(),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      try {
        for await (const event of this.processInboundStream(text, correlationId, identity ?? 'owner')) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (err: any) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      }
      res.end();
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

  // ---------------------------------------------------------------------------
  // Public accessors (for wiring in DkgNodePlugin)
  // ---------------------------------------------------------------------------

  get bridgePort(): number {
    return this.port;
  }

  get isUsingGatewayRoute(): boolean {
    return this.useGatewayRoute;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
}

function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
