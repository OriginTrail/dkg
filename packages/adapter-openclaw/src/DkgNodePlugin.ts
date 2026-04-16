/**
 * DkgNodePlugin — OpenClaw adapter that connects any OpenClaw agent to a
 * running DKG V10 daemon.
 *
 * All tools route through DkgDaemonClient → daemon HTTP API.
 * There is no embedded DKGAgent — the daemon owns the node, triple store,
 * and P2P networking.
 *
 * Integration modules:
 *   - DKG UI channel bridge (DkgChannelPlugin)
 *   - DKG-backed memory slot plugin (DkgMemoryPlugin) — registers an
 *     upstream `MemoryPluginCapability` via `api.registerMemoryCapability`.
 *     No adapter-side write tool: memory writes flow through daemon HTTP
 *     routes documented in `packages/cli/skills/dkg-node/SKILL.md`
 *     (`POST /api/assertion/create` + `POST /api/assertion/:name/write`),
 *     which the agent reads from `GET /.well-known/skill.md` on startup.
 */
import {
  DkgDaemonClient,
  type LocalAgentIntegrationRecord,
  type LocalAgentIntegrationTransport,
} from './dkg-client.js';
import { DkgChannelPlugin } from './DkgChannelPlugin.js';
import {
  DkgMemoryPlugin,
  type DkgMemorySession,
  type DkgMemorySessionResolver,
} from './DkgMemoryPlugin.js';
import type {
  DkgOpenClawConfig,
  OpenClawPluginApi,
  OpenClawTool,
  OpenClawToolResult,
} from './types.js';

const OPENCLAW_LOCAL_AGENT_CAPABILITIES = {
  localChat: true,
  chatAttachments: true,
  connectFromUi: true,
  installNode: true,
  dkgPrimaryMemory: true,
  wmImportPipeline: true,
  nodeServedSkill: true,
} as const;

const OPENCLAW_LOCAL_AGENT_MANIFEST = {
  packageName: '@origintrail-official/dkg-adapter-openclaw',
  setupEntry: './setup-entry.mjs',
} as const;
/**
 * Base delay before the first retry of `syncLocalAgentIntegrationState`
 * after a failed daemon fetch. The retry is exponential — each failure
 * doubles the previous wait, capped at `LOCAL_AGENT_STATE_RETRY_MAX_DELAY_MS`.
 * First delay is 5 s (not 1 s) so a cold daemon has a useful grace window
 * before the first retry fires.
 */
const LOCAL_AGENT_STATE_RETRY_BASE_DELAY_MS = 5_000;
/** Cap on the retry delay growth. 60 s matches typical cold-start windows. */
const LOCAL_AGENT_STATE_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Delay before the deferred "first-failure" re-probe of the node peer ID
 * fires after `refreshMemoryResolverState` reports a missing peerId at
 * register time. Gives the daemon a grace window to finish startup when
 * the gateway registers before `/api/status` is healthy. Subsequent
 * recovery is handled by the on-demand `ensureNodePeerId` fired from the
 * resolver when an actual call needs the peerId. Codex Bug B9.
 */
const NODE_PEER_ID_DEFERRED_RETRY_DELAY_MS = 5_000;
/**
 * Wall-clock TTL for the subscribed-context-graph cache consulted by
 * `memorySessionResolver.listAvailableContextGraphs`. Once the cache is
 * older than this, the next resolver call fires a best-effort background
 * refresh so newly-created or newly-subscribed CGs flow into the
 * `needs_clarification` choices returned by `dkg_memory_import`. Set
 * conservatively: the refresh is a single `/api/context-graphs` listing,
 * cheap enough to run every few turns but not so frequent that it
 * stampedes the daemon. Codex Bug B23.
 */
const AVAILABLE_CONTEXT_GRAPH_CACHE_TTL_MS = 30_000;

export class DkgNodePlugin {
  private readonly config: DkgOpenClawConfig;

  // HTTP client to daemon — used by all tools and integration modules
  private client!: DkgDaemonClient;

  // Integration modules
  private channelPlugin: DkgChannelPlugin | null = null;
  private memoryPlugin: DkgMemoryPlugin | null = null;
  private warnedLegacyGameConfig = false;
  private localAgentIntegrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Retry attempt counter for `scheduleLocalAgentIntegrationRetry`. Used to
   * compute the exponential-backoff delay (`base * 2^attempt`, capped).
   * Reset to 0 on a successful `syncLocalAgentIntegrationState` call so
   * subsequent transient failures start from the base delay again.
   */
  private localAgentIntegrationRetryAttempt = 0;
  /**
   * Last reason string logged by the retry loop, used to dedup identical
   * warnings. One `warn` per distinct transition; repeats with the same
   * reason are logged at `debug` level instead (typically silent at
   * default log level). On success we emit one `info` line so operators
   * see the recovery.
   */
  private lastLocalAgentIntegrationWarnReason: string | null = null;
  /**
   * Most recent error message captured by `loadStoredOpenClawIntegration`.
   * Written at the catch site, read by the retry dedup logic in
   * `syncLocalAgentIntegrationState`. Null when there is no pending
   * failure or after a successful load.
   */
  private lastLocalAgentIntegrationLoadError: string | null = null;
  private nodePeerId: string | undefined;
  /**
   * In-flight handle for the node peer ID probe, used to debounce
   * concurrent `ensureNodePeerId` calls so multiple resolver fires do not
   * stampede `/api/status`. Null when no probe is running. Codex Bug B9.
   */
  private peerIdProbeInFlight: Promise<void> | null = null;
  /**
   * Timer for the one-shot deferred retry after a failed initial probe
   * at register time. Belt-and-suspenders with `ensureNodePeerId`: the
   * lazy re-probe is the primary recovery path, but the deferred retry
   * covers the case where a deployment sits idle between register and
   * the first `dkg_memory_import` / slot search call. Codex Bug B9.
   */
  private peerIdDeferredRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cached API handle used by `ensureNodePeerId` for logging. Set on register. */
  private memoryResolverApi: OpenClawPluginApi | null = null;
  /**
   * Resolver wired to the live channel-plugin session-state map + a cached
   * list of subscribed context graphs for the write-path clarification
   * response. The `getSession` lookup returns the UI-selected project CG
   * that `DkgChannelPlugin.dispatchViaPluginSdk` stashed on the resolved
   * `sessionKey` at the start of the current dispatch, or `undefined` for
   * non-UI turns / expired entries. `DkgMemorySearchManager.search` uses
   * the CG to fire a second `/api/query` against the project's `'memory'`
   * WM assertion; `dkg_memory_import` uses it as the fallback target CG
   * when the agent does not supply one explicitly.
   *
   * `getDefaultAgentAddress` fires a best-effort `ensureNodePeerId()`
   * when the cached peerId is still undefined. This keeps the B2
   * retryable-clarification loop from soft-bricking permanently when the
   * register-time probe hit a cold daemon: the next turn's resolver call
   * self-heals the state. Codex Bug B9.
   */
  private readonly memorySessionResolver: DkgMemorySessionResolver = {
    getSession: (sessionKey: string | undefined): DkgMemorySession | undefined => {
      const projectContextGraphId = this.channelPlugin?.getSessionProjectContextGraphId(sessionKey);
      if (this.nodePeerId === undefined) {
        void this.ensureNodePeerId();
      }
      return {
        projectContextGraphId,
        agentAddress: this.nodePeerId,
      };
    },
    getDefaultAgentAddress: () => {
      if (this.nodePeerId === undefined) {
        void this.ensureNodePeerId();
      }
      return this.nodePeerId;
    },
    // B17 + B23: The cache is populated fire-and-forget from
    // `refreshMemoryResolverState` at register time. Two failure modes
    // this lazy-refresh path covers:
    //
    // 1. (B17) If `dkg_memory_import` fires before the register-time
    //    probe lands, the cache is empty and the `needs_clarification`
    //    payload advertises an empty project list.
    // 2. (B23) Once the cache is populated, any context graph that
    //    gets created or subscribed later in the session (via the
    //    `/api/context-graphs/*` endpoints) never appears in the cache,
    //    so the clarification payload has stale choices until restart.
    //
    // Fix: lazy-refresh on EMPTY cache (case 1) OR on STALE cache
    // (case 2) using a wall-clock TTL. The current call still returns
    // synchronously with whatever we have; the next call sees the
    // refreshed result once the probe completes. `refreshMemoryResolverState`
    // already short-circuits concurrent calls via its own in-flight guard.
    listAvailableContextGraphs: () => {
      const now = Date.now();
      const cacheAge = now - this.availableContextGraphCacheAt;
      const shouldRefresh =
        this.availableContextGraphCache.length === 0 ||
        cacheAge >= AVAILABLE_CONTEXT_GRAPH_CACHE_TTL_MS;
      if (shouldRefresh && this.memoryResolverApi) {
        void this.refreshMemoryResolverState(this.memoryResolverApi);
      }
      return this.availableContextGraphCache;
    },
    // B46: Force a synchronous refresh of the subscribed-CG cache and
    // return the freshly-probed list. Used by
    // `DkgMemoryPlugin.handleImport`'s B42 validation guard to retry
    // against a fresh cache before hard-rejecting an explicit
    // `contextGraphId` as a typo — avoids rejecting legitimate
    // just-created CGs during the TTL window of the lazy cache.
    // No-op when `memoryResolverApi` is null (plugin not yet
    // registered, or memory module disabled).
    refreshAvailableContextGraphs: async () => {
      if (this.memoryResolverApi) {
        await this.refreshMemoryResolverState(this.memoryResolverApi);
      }
      return this.availableContextGraphCache;
    },
  };
  private availableContextGraphCache: string[] = [];
  /**
   * Wall-clock timestamp (ms epoch) of the last successful context-graph
   * cache populate. `0` means never populated. Compared against
   * `AVAILABLE_CONTEXT_GRAPH_CACHE_TTL_MS` in
   * `memorySessionResolver.listAvailableContextGraphs` to decide when to
   * fire a lazy refresh. Codex Bug B23.
   */
  private availableContextGraphCacheAt = 0;
  /**
   * In-flight handle for a `refreshMemoryResolverState` call. Concurrent
   * callers share this promise and await it instead of getting a stale
   * cache back. Codex Bug B49: the previous boolean guard returned
   * immediately on concurrent calls, so `refreshAvailableContextGraphs`
   * callers who expected a synchronous refresh could observe the
   * in-flight background refresh as "nothing to do" and see the stale
   * cache. Tracking the promise lets multiple callers share one refresh
   * while all observing the populated result.
   */
  private refreshStateInFlight: Promise<void> | null = null;

  constructor(config?: DkgOpenClawConfig) {
    this.config = { ...config };
  }

  /** Whether the base runtime (daemon client, lifecycle hooks) has been initialized. */
  private initialized = false;

  /**
   * Register the DKG plugin with an OpenClaw plugin API instance.
   * On the first call: full init (lifecycle hooks, daemon handshake, integration modules).
   * On subsequent calls (gateway multi-phase init): re-registers tools into the new registry.
   */
  register(api: OpenClawPluginApi): void {
    this.warnOnLegacyGameConfig(api);

    const registrationMode = api.registrationMode ?? 'full';
    const fullRuntime = registrationMode === 'full';
    const setupOnly = registrationMode === 'setup-only';
    const setupRuntime = registrationMode === 'setup-runtime';
    const cliMetadataOnly = registrationMode === 'cli-metadata';
    // `setup-runtime` IS a runtime mode: the OpenClaw gateway loads the
    // adapter during its own setup phase and immediately accepts turns
    // through the channel module, so integration modules must come up
    // at that point. Only `setup-only` and `cli-metadata` are true
    // metadata-only modes that skip integration wiring. The memory
    // slot's `DkgMemoryPlugin.register` is pure wiring (no network I/O
    // at register time) and the runtime factory's B12 null-manager
    // fallback handles "peer ID not yet available" gracefully on first
    // dispatch, so registering the slot early is safe even when the
    // daemon is not yet healthy.
    const runtimeEnabled = fullRuntime || setupRuntime;

    // Only expose the DKG agent tool surface during full runtime.
    if (fullRuntime) {
      for (const tool of this.tools()) {
        api.registerTool(tool);
      }
    }

    if (cliMetadataOnly) {
      return;
    }

    // Subsequent multi-phase calls should upgrade missing integrations without
    // recreating servers/watchers, then re-register any tool surfaces.
    if (this.initialized) {
      this.registerIntegrationModules(api, { enableFullRuntime: runtimeEnabled });
      if (runtimeEnabled) {
        this.registerLocalAgentIntegration(api, registrationMode);
      }
      return;
    }

    // Create daemon client — used by all tools and integration modules
    const daemonUrl = this.config.daemonUrl ?? 'http://127.0.0.1:9200';
    this.client = new DkgDaemonClient({ baseUrl: daemonUrl });
    this.initialized = true;

    api.registerHook('session_end', () => this.stop(), { name: 'dkg-node-stop' });

    // --- Cross-channel turn persistence ---
    if (runtimeEnabled) {
      this.registerCrossChannelPersistence(api);
    }

    // --- Integration modules ---
    this.registerIntegrationModules(api, { enableFullRuntime: runtimeEnabled });

    if (runtimeEnabled) {
      this.registerLocalAgentIntegration(api, registrationMode);
    }
  }

  /**
   * Register DKG integration modules: channel and memory.
   * Each module is optional — enabled via config flags.
   */
  private registerIntegrationModules(api: OpenClawPluginApi, opts?: { enableFullRuntime?: boolean }): void {
    // --- Channel module ---
    const channelConfig = this.config.channel;
    if (channelConfig?.enabled) {
      if (!this.channelPlugin) {
        this.channelPlugin = new DkgChannelPlugin(channelConfig, this.client);
      }
      this.channelPlugin.register(api);
      api.logger.info?.('[dkg] Channel module enabled — DKG UI bridge active');
    }

    if (!opts?.enableFullRuntime) {
      api.logger.info?.('[dkg] Metadata-only OpenClaw registration — skipping memory-slot integration');
      return;
    }

    // --- Memory module ---
    const memoryConfig = this.config.memory;
    if (memoryConfig?.enabled) {
      if (!this.memoryPlugin) {
        this.memoryPlugin = new DkgMemoryPlugin(this.client, memoryConfig, this.memorySessionResolver);
      }
      const registered = this.memoryPlugin.register(api);
      if (!registered) {
        // Clear any stale re-assert callback from a previous registration
        // so the channel plugin doesn't steal the slot back from the
        // newly elected provider on subsequent turns.
        this.channelPlugin?.setMemoryReAssert(null);
        api.logger.info?.('[dkg] Memory module loaded but slot registration was skipped (see warn above for reason)');
        return;
      }
      api.logger.info?.('[dkg] Memory module enabled — DKG-backed memory slot active');

      // Wire the channel plugin to re-assert our memory-slot capability
      // before each inbound turn dispatch. This guarantees our runtime
      // handles recall even when memory-core's dreaming sidecar overwrites
      // the single-slot capability store during plugin loading.
      if (this.channelPlugin && this.memoryPlugin) {
        this.channelPlugin.setMemoryReAssert(() => this.memoryPlugin?.reAssertCapability());
      }

      // Cache the API handle so `ensureNodePeerId` can log from the lazy
      // re-probe call tree, which fires outside of any register() scope
      // when a later resolver call asks for the default agent address.
      // Codex Bug B9.
      this.memoryResolverApi = api;

      // Best-effort: populate node peer ID + subscribed context-graph cache
      // for the memory resolver. Both are non-blocking; failures just leave
      // the resolver with empty state (single-graph fallback on reads,
      // empty availableContextGraphs on the write-path clarification). Only
      // runs when memory is enabled so tool-only test setups that stub
      // `globalThis.fetch` for unrelated assertions are not polluted by a
      // surprise `/api/status` probe.
      void this.refreshMemoryResolverState(api);
    }
  }

  /**
   * Register cross-channel turn persistence hooks. Fires for ALL
   * OpenClaw channels (Telegram, WhatsApp, API, etc.) except the DKG UI
   * channel bridge (which already persists with richer data via
   * DkgChannelPlugin.queueTurnPersistence).
   *
   * Strategy: stash the user message on `message_received`, then pair
   * it with the assistant reply on `message_sent` and persist the turn
   * to the DKG via the daemon's persist-turn endpoint.
   */
  private registerCrossChannelPersistence(api: OpenClawPluginApi): void {
    const DKG_UI_CHANNEL = 'dkg-ui';
    const pendingUserMessages = new Map<string, { from: string; content: string; timestamp: number }>();
    const client = this.client;

    api.registerHook('message_received', async (event: any, ctx: any) => {
      const channelId = ctx?.channelId;
      if (!channelId || channelId === DKG_UI_CHANNEL) return;
      const key = `${channelId}:${ctx?.conversationId ?? 'default'}`;
      pendingUserMessages.set(key, {
        from: event?.from ?? 'unknown',
        content: typeof event?.content === 'string' ? event.content : '',
        timestamp: event?.timestamp ?? Date.now(),
      });
    }, { name: 'dkg-cross-channel-receive' });

    api.registerHook('message_sent', async (event: any, ctx: any) => {
      const channelId = ctx?.channelId;
      if (!channelId || channelId === DKG_UI_CHANNEL) return;
      if (!event?.success) return;
      const key = `${channelId}:${ctx?.conversationId ?? 'default'}`;
      const pending = pendingUserMessages.get(key);
      pendingUserMessages.delete(key);

      const userMessage = pending?.content ?? '';
      const assistantReply = typeof event?.content === 'string' ? event.content : '';
      if (!userMessage && !assistantReply) return;

      const sessionId = `openclaw:${channelId}:${ctx?.conversationId ?? ctx?.accountId ?? 'default'}`;

      try {
        await client.persistTurn({ sessionId, userMessage, assistantReply });
        api.logger.debug?.(`[dkg] Cross-channel turn persisted (${channelId})`);
      } catch (err: any) {
        api.logger.debug?.(`[dkg] Cross-channel persist failed: ${err.message}`);
      }
    }, { name: 'dkg-cross-channel-persist' });
  }

  private registerLocalAgentIntegration(api: OpenClawPluginApi, registrationMode: string): void {
    if (!this.config.channel?.enabled || !this.channelPlugin) {
      return;
    }

    this.clearLocalAgentIntegrationRetry();
    void this.syncLocalAgentIntegrationState(api, registrationMode);
  }

  private clearLocalAgentIntegrationRetry(): void {
    if (!this.localAgentIntegrationRetryTimer) return;
    clearTimeout(this.localAgentIntegrationRetryTimer);
    this.localAgentIntegrationRetryTimer = null;
  }

  private scheduleLocalAgentIntegrationRetry(api: OpenClawPluginApi, registrationMode: string): void {
    if (this.localAgentIntegrationRetryTimer) return;
    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped). On every
    // successful sync `localAgentIntegrationRetryAttempt` resets to 0
    // so transient failures after a healthy period start from the
    // base delay again rather than inheriting the old cadence.
    const attempt = this.localAgentIntegrationRetryAttempt;
    const delay = Math.min(
      LOCAL_AGENT_STATE_RETRY_BASE_DELAY_MS * 2 ** attempt,
      LOCAL_AGENT_STATE_RETRY_MAX_DELAY_MS,
    );
    this.localAgentIntegrationRetryAttempt = attempt + 1;
    this.localAgentIntegrationRetryTimer = setTimeout(() => {
      this.localAgentIntegrationRetryTimer = null;
      void this.syncLocalAgentIntegrationState(api, registrationMode);
    }, delay);
  }

  private warnOnLegacyGameConfig(api: OpenClawPluginApi): void {
    if (this.warnedLegacyGameConfig) return;
    const legacyGameConfig = (this.config as Record<string, unknown> | undefined)?.game as { enabled?: boolean } | undefined;
    if (legacyGameConfig?.enabled) {
      this.warnedLegacyGameConfig = true;
      api.logger.warn?.(
        '[dkg] Legacy dkg-node.game.enabled is no longer supported in the V10 OpenClaw adapter path; OriginTrail Game tools were intentionally removed.',
      );
    }
  }

  private async syncLocalAgentIntegrationState(api: OpenClawPluginApi, registrationMode: string): Promise<void> {
    // Skip the retry loop entirely when the adapter has no runtime
    // integrations to sync. The stored-integration fetch is a no-op for
    // metadata-only loads and used to burn a 1 Hz warn loop on cold
    // daemons for no operator benefit.
    const anyIntegrationEnabled =
      this.config.memory?.enabled === true || this.config.channel?.enabled === true;
    if (!anyIntegrationEnabled) {
      return;
    }

    const existing = await this.loadStoredOpenClawIntegration(api);
    if (existing === undefined) {
      // Log dedup: emit exactly one `warn` per distinct failure reason,
      // then downgrade repeats of the same reason to `debug` (silent at
      // default log level) until either the reason changes or the load
      // succeeds. Prevents a cold daemon from flooding the gateway log
      // with identical lines on every retry tick.
      const reason = this.lastLocalAgentIntegrationLoadError ?? 'fetch failed';
      const retryMessage =
        '[dkg] Stored OpenClaw integration state could not be loaded; aborting startup re-registration to preserve any persisted disconnect state' +
        ` (reason: ${reason})`;
      if (this.lastLocalAgentIntegrationWarnReason !== reason) {
        api.logger.warn?.(retryMessage);
        this.lastLocalAgentIntegrationWarnReason = reason;
      } else {
        api.logger.debug?.(retryMessage);
      }
      this.scheduleLocalAgentIntegrationRetry(api, registrationMode);
      return;
    }
    // Successful load — reset dedup + retry counter and log recovery once
    // if we were previously retrying, so operators see the transition.
    this.clearLocalAgentIntegrationRetry();
    if (this.localAgentIntegrationRetryAttempt > 0) {
      api.logger.info?.(
        `[dkg] Stored OpenClaw integration state loaded after ${this.localAgentIntegrationRetryAttempt} retry attempt(s)`,
      );
    }
    this.localAgentIntegrationRetryAttempt = 0;
    this.lastLocalAgentIntegrationWarnReason = null;
    this.lastLocalAgentIntegrationLoadError = null;
    if (this.wasOpenClawExplicitlyUserDisconnected(existing)) {
      api.logger.info?.('[dkg] Stored OpenClaw integration was explicitly disconnected by the user; skipping startup re-registration');
      return;
    }

    const metadata = {
      channelId: 'dkg-ui',
      registrationMode,
      transportMode: this.channelPlugin?.isUsingGatewayRoute ? 'gateway+bridge' : 'bridge',
    };
    const bridgeAlreadyReady = this.channelPlugin?.isListening === true;
    const basePayload = {
      id: 'openclaw',
      enabled: true,
      description: 'Connect a local OpenClaw agent through the DKG node.',
      transport: this.buildOpenClawTransport(existing?.transport, api),
      capabilities: OPENCLAW_LOCAL_AGENT_CAPABILITIES,
      manifest: OPENCLAW_LOCAL_AGENT_MANIFEST,
      setupEntry: OPENCLAW_LOCAL_AGENT_MANIFEST.setupEntry,
      metadata,
    };

    try {
      await this.client.connectLocalAgentIntegration({
        ...basePayload,
        runtime: {
          status: bridgeAlreadyReady ? 'ready' : 'connecting',
          ready: bridgeAlreadyReady,
          lastError: null,
        },
      });
    } catch (err: any) {
      api.logger.warn?.(`[dkg] Local agent registration failed (will retry on next gateway start): ${err.message}`);
      return;
    }

    if (bridgeAlreadyReady || !this.channelPlugin) {
      return;
    }

    void this.channelPlugin.start()
      .then(() => this.client.updateLocalAgentIntegration('openclaw', {
        ...basePayload,
        transport: this.buildOpenClawTransport(existing?.transport, api),
        runtime: {
          status: 'ready',
          ready: true,
          lastError: null,
        },
      }))
      .catch(async (err: any) => {
        api.logger.warn?.(`[dkg] OpenClaw channel startup did not reach ready state: ${err.message}`);
        try {
          await this.client.updateLocalAgentIntegration('openclaw', {
            ...basePayload,
            transport: this.buildOpenClawTransport(existing?.transport, api),
            runtime: {
              status: 'error',
              ready: false,
              lastError: err.message ?? String(err),
            },
          });
        } catch (updateErr: any) {
          api.logger.warn?.(`[dkg] Failed to persist OpenClaw channel error state: ${updateErr.message}`);
        }
      });
  }

  private async loadStoredOpenClawIntegration(api: OpenClawPluginApi): Promise<LocalAgentIntegrationRecord | null | undefined> {
    try {
      const result = await this.client.getLocalAgentIntegration('openclaw');
      // Clear any stale error from an earlier failed attempt so the
      // retry dedup logic in `syncLocalAgentIntegrationState` can
      // distinguish a fresh failure reason from the previous one.
      this.lastLocalAgentIntegrationLoadError = null;
      return result;
    } catch (err: any) {
      const reason = typeof err?.message === 'string' && err.message.length > 0 ? err.message : String(err);
      this.lastLocalAgentIntegrationLoadError = reason;
      // Emit the underlying fetch error at `debug` level on every
      // attempt (silent at default log level). The caller in
      // `syncLocalAgentIntegrationState` emits the one operator-visible
      // warn with dedup semantics.
      api.logger.debug?.(`[dkg] Failed to load stored OpenClaw integration state: ${reason}`);
      return undefined;
    }
  }

  private wasOpenClawExplicitlyUserDisconnected(existing: LocalAgentIntegrationRecord | null): boolean {
    if (!existing) return false;
    if (existing.metadata?.userDisabled === true) return true;
    return Boolean(existing.connectedAt && existing.enabled === false && existing.runtime?.status === 'disconnected');
  }

  private buildOpenClawTransport(
    existing?: LocalAgentIntegrationTransport,
    api?: OpenClawPluginApi,
  ): LocalAgentIntegrationTransport {
    const transport: LocalAgentIntegrationTransport = { kind: 'openclaw-channel' };
    if (!this.channelPlugin) return transport;

    const gatewayBaseUrl = this.resolveGatewayBaseUrl(
      api,
      this.channelPlugin.isUsingGatewayRoute ? undefined : existing?.gatewayUrl,
    );
    if (this.channelPlugin.isUsingGatewayRoute && gatewayBaseUrl) {
      transport.gatewayUrl = gatewayBaseUrl;
    }

    const bridgePort = this.channelPlugin.bridgePort;
    if (bridgePort > 0) {
      transport.bridgeUrl = `http://127.0.0.1:${bridgePort}`;
      transport.healthUrl = `${transport.bridgeUrl}/health`;
    } else {
      const existingBridgeUrl = existing?.bridgeUrl?.trim();
      const existingHealthUrl = existing?.healthUrl?.trim();
      if (existingBridgeUrl) {
        transport.bridgeUrl = existingBridgeUrl;
      }
      if (existingHealthUrl) {
        transport.healthUrl = existingHealthUrl;
      }
    }

    return transport;
  }

  private resolveGatewayBaseUrl(api?: OpenClawPluginApi, existingGatewayUrl?: string): string | undefined {
    const rawGateway = api?.config && typeof api.config === 'object'
      ? (api.config as Record<string, unknown>).gateway
      : undefined;
    const gateway = rawGateway && typeof rawGateway === 'object'
      ? rawGateway as Record<string, unknown>
      : undefined;
    const rawPort = gateway?.port ?? process.env.OPENCLAW_GATEWAY_PORT;
    const tls = gateway?.tls && typeof gateway.tls === 'object'
      ? gateway.tls as Record<string, unknown>
      : undefined;
    const hasCurrentGatewayConfig = this.hasGatewayConfig(gateway, rawPort, tls);
    if (!hasCurrentGatewayConfig && existingGatewayUrl?.trim()) {
      return existingGatewayUrl.trim();
    }

    const port = this.normalizePort(rawPort) ?? 18789;
    const rawCustomHost = typeof gateway?.customBindHost === 'string' ? gateway.customBindHost.trim() : '';
    const configuredHost = rawCustomHost || '127.0.0.1';
    const host = this.normalizeGatewayHost(configuredHost);
    const protocol = tls?.enabled === true ? 'https' : 'http';
    return this.formatGatewayBaseUrl(protocol, host, port);
  }

  private hasGatewayConfig(
    gateway: Record<string, unknown> | undefined,
    rawPort: unknown,
    tls: Record<string, unknown> | undefined,
  ): boolean {
    if (rawPort !== undefined && rawPort !== null && String(rawPort).trim() !== '') {
      return true;
    }
    if (!gateway) return false;
    const hasCustomBindHost = typeof gateway.customBindHost === 'string' && gateway.customBindHost.trim() !== '';
    if (hasCustomBindHost) return true;
    if (!tls) return false;
    const tlsKeys = Object.keys(tls);
    if (tlsKeys.length === 0) return false;
    if (tlsKeys.length === 1 && tls.enabled === false) return false;
    return true;
  }

  private formatGatewayBaseUrl(protocol: 'http' | 'https', host: string, port: number): string {
    const formattedHost = host.includes(':') && !host.startsWith('[')
      ? `[${host}]`
      : host;
    const url = new URL(`${protocol}://${formattedHost}`);
    url.port = String(port);
    return url.toString().replace(/\/$/, '');
  }

  private normalizePort(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  }

  private normalizeGatewayHost(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::' || trimmed === '[::]') {
      return '127.0.0.1';
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  async stop(): Promise<void> {
    // Stop integration modules
    this.clearLocalAgentIntegrationRetry();
    if (this.peerIdDeferredRetryTimer) {
      clearTimeout(this.peerIdDeferredRetryTimer);
      this.peerIdDeferredRetryTimer = null;
    }
    await this.channelPlugin?.stop();
  }

  getClient(): DkgDaemonClient {
    if (!this.client) throw new Error('DkgNodePlugin.getClient() called before register()');
    return this.client;
  }

  /**
   * Populate the memory resolver's node-peer-ID + subscribed context-graph
   * cache from the daemon. Non-blocking; failures warn and leave caches
   * empty so the resolver falls back to single-graph reads and an empty
   * needs_clarification list on writes.
   *
   * When the peer-ID probe leaves `nodePeerId` undefined (daemon startup
   * race, `/api/status` 5xx, network flap), schedules a deferred one-shot
   * retry so a gateway that sits idle until the first `dkg_memory_import`
   * call still recovers. The primary recovery path is the on-demand
   * `ensureNodePeerId` fired by the resolver. Codex Bug B9.
   */
  private refreshMemoryResolverState(api: OpenClawPluginApi): Promise<void> {
    // B49: Concurrent callers share one in-flight refresh. The previous
    // boolean guard (`availableContextGraphsRefreshing`) returned
    // immediately when a background refresh was already running, so
    // `refreshAvailableContextGraphs()` awaiters could observe
    // "nothing to do" and return against the still-stale cache. Track
    // the promise instead so all awaiters block on the same refresh
    // and see the populated cache when it settles.
    if (this.refreshStateInFlight) {
      return this.refreshStateInFlight;
    }

    const run = async (): Promise<void> => {
      try {
        // Route through `ensureNodePeerId` so the in-flight promise
        // guard is populated while this probe runs. Any resolver call
        // that fires concurrently (e.g., a memory slot search during
        // the same tick) will await the same peer-ID promise instead
        // of firing a duplicate /api/status call. Codex Bug B9.
        await this.ensureNodePeerId();
        try {
          const result = await this.client.listContextGraphs();
          const graphs = Array.isArray(result?.contextGraphs) ? result.contextGraphs : [];
          const ids: string[] = [];
          for (const entry of graphs) {
            const id = typeof entry?.id === 'string'
              ? entry.id
              : typeof entry?.contextGraphId === 'string'
                ? entry.contextGraphId
                : undefined;
            if (!id || id === 'agent-context') continue;
            // B51 + B54: `agent.listContextGraphs()` returns every context
            // graph the node knows about — including system paranets
            // (ontology, agents registry), locally-created private CGs,
            // public local CGs, subscribed gossip CGs, and discovered-
            // but-not-subscribed ontology entries. Each entry carries
            // `subscribed: boolean`, `synced: boolean`, and
            // `isSystem: boolean` flags (per
            // `packages/agent/src/dkg-agent.ts:3541-3620`).
            //
            // This cache is the `needs_clarification` availability list
            // AND the B42 / B46 / B48 subscribed-project allowlist for
            // `dkg_memory_import`, so the filter shape matters:
            //
            //   - B51 (initial filter) used `subscribed === true`, which
            //     correctly excluded system paranets and discovered-not-
            //     subscribed entries.
            //   - B54 (this fix) discovered that `createContextGraph({
            //     private: true })` records local private CGs as
            //     `subscribed: false` (see dkg-agent.ts:2041-2045, the
            //     `subscribed: !opts.private` line). My strict B51 filter
            //     therefore dropped private CGs from the allowlist, and
            //     `dkg_memory_import` hard-rejected them as "not in the
            //     subscribed project list" even though they are the most
            //     obvious legitimate write target for a local agent.
            //
            // Relax the filter to `synced === true && !isSystem`. Every
            // locally usable CG — public subscribed, local public,
            // local private — has `synced: true` in the listing. System
            // paranets also have `synced: true` but are filtered by the
            // `isSystem` check. Discovered-but-not-yet-synced gossip
            // entries (subscribed via `subscribe()` but not yet
            // data-synced) have `synced: false` and are excluded until
            // sync lands.
            //
            // Tradeoff: this is more permissive than B51 and could
            // include discovered-but-not-subscribed ontology entries
            // that happen to have triples locally. The alternative
            // (restricting to `subscribed: true`) is strictly worse
            // because it creates a correctness regression for private
            // local CGs — a first-class feature, not an edge case.
            // Discovered-but-not-subscribed writes either succeed at
            // the daemon layer (local-only assertion) or fail with a
            // daemon error, neither of which is as bad as a hard-block
            // on legitimate private writes.
            if (entry?.synced !== true) continue;
            if (entry?.isSystem === true) continue;
            ids.push(id);
          }
          this.availableContextGraphCache = ids;
          // B23: record the successful-populate wall-clock time so the
          // resolver's lazy-refresh path can TTL-check staleness.
          this.availableContextGraphCacheAt = Date.now();
        } catch (err: any) {
          api.logger.debug?.(`[dkg-memory] Could not refresh context-graph cache: ${err?.message ?? err}`);
        }
      } finally {
        // Schedule the deferred retry inside the promise body so every
        // caller (including the one that triggered the refresh and any
        // concurrent awaiters) observes the retry scheduling through
        // the shared finally chain.
        if (this.nodePeerId === undefined) {
          this.schedulePeerIdDeferredRetry(api);
        }
      }
    };

    const tracked = run().finally(() => {
      // Clear the slot only if we're still the tracked promise — a
      // concurrent caller that started after us would have taken
      // over, though the guard above prevents that in practice.
      if (this.refreshStateInFlight === tracked) {
        this.refreshStateInFlight = null;
      }
    });
    this.refreshStateInFlight = tracked;
    return tracked;
  }

  /**
   * Single-shot `/api/status` call that updates `nodePeerId` on success
   * and logs on failure. Pulled out of `refreshMemoryResolverState` so it
   * can be reused by `ensureNodePeerId` without dragging the CG cache
   * refresh along. Does NOT debounce — callers are responsible for
   * preventing concurrent calls (see `ensureNodePeerId`'s in-flight
   * promise guard).
   */
  private async probeNodePeerIdOnce(api: OpenClawPluginApi): Promise<void> {
    try {
      const status = await this.client.getStatus();
      if (status.ok && status.peerId) {
        this.nodePeerId = status.peerId;
        return;
      }
      // B30: `DkgDaemonClient.getStatus()` already converts transport /
      // HTTP failures into `{ ok: false, error }`, so the `catch` block
      // below almost never runs — the previous implementation's log
      // message was effectively dead code and peer-ID probe failures
      // were silent. Log the non-ok branch explicitly at warn level so
      // operators can diagnose why every memory call is falling back
      // to `needs_clarification`. The `status.ok && status.peerId`
      // check above handles the successful-but-no-peerId edge case
      // (daemon not yet fully initialized) — fall through to the same
      // warn log so it too is visible.
      if (!status.ok) {
        const reason = (status as any).error ?? 'unknown error';
        api.logger.warn?.(
          `[dkg-memory] Node peer ID probe failed — daemon /api/status returned not-ok: ${reason}. ` +
          'Working-memory reads and writes will return needs_clarification until the next retry lands.',
        );
      } else {
        api.logger.warn?.(
          '[dkg-memory] Node peer ID probe returned ok but no peerId — daemon is up but has not yet ' +
          'published a peer identity. Retrying on the next lazy-probe tick.',
        );
      }
    } catch (err: any) {
      // Defense-in-depth: `getStatus()` catches its own transport errors,
      // but a future refactor might throw (e.g. from a JSON parse in the
      // client layer). Keep the catch so that path is also diagnosed.
      api.logger.warn?.(
        `[dkg-memory] Node peer ID probe threw unexpectedly: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * On-demand best-effort re-probe of the node peer ID, fired by the
   * memory resolver when a caller asks for the default agent address and
   * the cached peerId is still undefined. Debounced via
   * `peerIdProbeInFlight`: concurrent callers share the same promise so
   * a burst of resolver fires collapses to one `/api/status` call.
   *
   * Returns immediately without firing if:
   * - `nodePeerId` is already populated (no-op),
   * - the memory resolver API was never cached (register() hasn't run or
   *   memory module was disabled — nothing to probe against),
   * - a probe is already in flight.
   *
   * Codex Bug B9 — fixes the "register-time one-shot probe fails →
   * permanent soft-brick" case where every subsequent turn got B2's
   * retryable clarification with no actual retry path.
   */
  private ensureNodePeerId(): Promise<void> {
    if (this.nodePeerId !== undefined) return Promise.resolve();
    const api = this.memoryResolverApi;
    if (!api) return Promise.resolve();
    if (this.peerIdProbeInFlight) return this.peerIdProbeInFlight;

    const probe = this.probeNodePeerIdOnce(api).finally(() => {
      this.peerIdProbeInFlight = null;
    });
    this.peerIdProbeInFlight = probe;
    return probe;
  }

  /**
   * Schedules a one-shot deferred retry of the peer-ID probe. Cheap
   * belt-and-suspenders for the case where a gateway registers against a
   * daemon that is still booting and then sits idle for seconds before
   * the first resolver call would fire `ensureNodePeerId` lazily. No-op
   * if a retry is already scheduled or if `nodePeerId` has already been
   * populated by a concurrent lazy probe. Codex Bug B9.
   */
  private schedulePeerIdDeferredRetry(api: OpenClawPluginApi): void {
    if (this.peerIdDeferredRetryTimer) return;
    this.peerIdDeferredRetryTimer = setTimeout(() => {
      this.peerIdDeferredRetryTimer = null;
      if (this.nodePeerId !== undefined) return;
      void this.probeNodePeerIdOnce(api);
    }, NODE_PEER_ID_DEFERRED_RETRY_DELAY_MS);
    // Node's `Timer.unref()` keeps the deferred retry from holding the
    // event loop open past shutdown. Missing on some non-Node runtimes
    // (e.g. browser fakes), so guard with optional chaining.
    (this.peerIdDeferredRetryTimer as any)?.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private json(data: unknown): OpenClawToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data };
  }

  private error(message: string): OpenClawToolResult {
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], details: { error: message } };
  }

  private daemonError(err: any): OpenClawToolResult {
    const msg = err.message ?? String(err);
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
      return this.error(
        'DKG daemon is not reachable. Make sure the daemon is running (dkg start) ' +
        `and accessible at ${this.client.baseUrl}.`,
      );
    }
    return this.error(msg);
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private tools(): OpenClawTool[] {
    return [
      {
        name: 'dkg_status',
        description:
          'Show DKG node status: peer ID, connected peers, multiaddrs, and wallet addresses. ' +
          'Call this to verify the daemon is running and to diagnose connectivity issues.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_toolCallId, _params) => this.handleStatus(),
      },
      {
        name: 'dkg_wallet_balances',
        description:
          'Check TRAC and ETH token balances for the node\'s operational wallets. ' +
          'Use this before publishing to verify sufficient funds. Returns per-wallet balances, ' +
          'chain ID, and RPC URL.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_toolCallId, _params) => this.handleWalletBalances(),
      },
      {
        name: 'dkg_list_context_graphs',
        description:
          'List all contextGraphs this node knows about. Returns context graph IDs, names, subscription status, ' +
          'and sync status. Use this to discover available contextGraphs before publishing or querying.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_toolCallId, _params) => this.handleListContextGraphs(),
      },
      {
        name: 'dkg_context_graph_create',
        description:
          'Create a new context graph on the DKG node. A context graph is a scoped knowledge domain ' +
          'that organizes published knowledge. Use dkg_list_context_graphs first to check if the ' +
          'context graph already exists. Returns the context graph ID and URI (did:dkg:context-graph:<id>). ' +
          'The ID is auto-generated from the name if not provided.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Human-readable context graph name (e.g. "My Research Context Graph")',
            },
            description: {
              type: 'string',
              description: 'Optional description of what this context graph contains',
            },
            id: {
              type: 'string',
              description: 'Optional custom context graph ID slug. Auto-generated from name if omitted (e.g. "My Research" → "my-research").',
            },
          },
          required: ['name'],
        },
        execute: async (_toolCallId, args) => this.handleContextGraphCreate(args),
      },
      {
        name: 'dkg_subscribe',
        description:
          'Subscribe to a context graph to receive its data and updates. Subscription is immediate; ' +
          'data sync from connected peers happens in the background and may take time depending on ' +
          'the context graph size. Use dkg_list_context_graphs to check sync status afterward.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: {
              type: 'string',
              description: 'Context Graph ID to subscribe to (e.g. "my-research")',
            },
            include_shared_memory: {
              type: 'string',
              description: 'Set to "false" to skip syncing shared memory data. Default: true.',
            },
          },
          required: ['context_graph_id'],
        },
        execute: async (_toolCallId, args) => this.handleSubscribe(args),
      },
      {
        name: 'dkg_publish',
        description:
          'Publish knowledge to a DKG context graph as an array of quads (subject/predicate/object). ' +
          'Data is first written to Shared Working Memory, then published to Verified Memory on-chain. ' +
          'Object values that look like URIs (http://, https://, urn:, did:) are treated as URIs; ' +
          'all other values become string literals automatically.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID (e.g. "testing", "my-research")' },
            quads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  subject: { type: 'string', description: 'Subject URI (e.g. "https://example.org/wine/cabernet")' },
                  predicate: { type: 'string', description: 'Predicate URI (e.g. "https://schema.org/name")' },
                  object: { type: 'string', description: 'Object — URI or plain literal value (e.g. "Cabernet Sauvignon" or "https://schema.org/Product")' },
                  graph: { type: 'string', description: 'Optional named graph URI' },
                },
                required: ['subject', 'predicate', 'object'],
              },
              description:
                'Array of quads to publish. Each quad has subject (URI), predicate (URI), and object (URI or literal string). ' +
                'URIs are auto-detected by prefix (http://, https://, urn:, did:); everything else becomes a literal.',
            },
          },
          required: ['context_graph_id', 'quads'],
        },
        execute: async (_toolCallId, args) => this.handlePublish(args),
      },
      {
        name: 'dkg_query',
        description:
          'Run a read-only SPARQL query (SELECT, CONSTRUCT, ASK, DESCRIBE) against the local DKG triple store. ' +
          'Use GRAPH ?g { ... } to match across named graphs. ' +
          'Queries are local and fast — no network round-trip.',
        parameters: {
          type: 'object',
          properties: {
            sparql: { type: 'string', description: 'SPARQL query string (SELECT, CONSTRUCT, ASK, or DESCRIBE)' },
            context_graph_id: { type: 'string', description: 'Optional context graph scope — omit to query all data' },
            include_shared_memory: { type: 'string', description: 'Set to "true" to also search shared memory (working/ephemeral) data. Default: false.' },
          },
          required: ['sparql'],
        },
        execute: async (_toolCallId, args) => this.handleQuery(args),
      },
      {
        name: 'dkg_find_agents',
        description:
          'Discover DKG agents on the network. Call with no parameters to list all known agents. ' +
          'Filter by framework (e.g. "OpenClaw", "ElizaOS") or by skill_type URI to find agents offering a specific capability.',
        parameters: {
          type: 'object',
          properties: {
            framework: { type: 'string', description: 'Filter by framework name (e.g. "OpenClaw", "ElizaOS")' },
            skill_type: { type: 'string', description: 'Filter by skill type URI (e.g. "ImageAnalysis")' },
          },
          required: [],
        },
        execute: async (_toolCallId, args) => this.handleFindAgents(args),
      },
      {
        name: 'dkg_send_message',
        description:
          'Send an end-to-end encrypted chat message to another DKG agent by their peer ID or name. ' +
          'Both agents must be online. Use dkg_find_agents first to discover peer IDs.',
        parameters: {
          type: 'object',
          properties: {
            peer_id: { type: 'string', description: 'Recipient peer ID (starts with 12D3KooW...) or agent name' },
            text: { type: 'string', description: 'Message text to send' },
          },
          required: ['peer_id', 'text'],
        },
        execute: async (_toolCallId, args) => this.handleSendMessage(args),
      },
      {
        name: 'dkg_read_messages',
        description:
          'Read P2P messages received from other DKG agents. Returns both sent and received messages. ' +
          'Filter by peer ID/name, limit results, or fetch messages since a timestamp.',
        parameters: {
          type: 'object',
          properties: {
            peer: { type: 'string', description: 'Filter by peer ID or agent name (optional)' },
            limit: { type: 'string', description: 'Maximum number of messages to return (default: 100)' },
            since: { type: 'string', description: 'Only return messages after this timestamp in ms (optional)' },
          },
          required: [],
        },
        execute: async (_toolCallId, args) => this.handleReadMessages(args),
      },
      {
        name: 'dkg_invoke_skill',
        description:
          'Invoke a remote agent\'s skill over the DKG network. ' +
          'Use dkg_find_agents with skill_type first to discover which agents offer the skill you need.',
        parameters: {
          type: 'object',
          properties: {
            peer_id: { type: 'string', description: 'Target agent peer ID (starts with 12D3KooW...) or agent name' },
            skill_uri: { type: 'string', description: 'Skill URI to invoke (e.g. "ImageAnalysis")' },
            input: { type: 'string', description: 'Input data as UTF-8 text' },
          },
          required: ['peer_id', 'skill_uri', 'input'],
        },
        execute: async (_toolCallId, args) => this.handleInvokeSkill(args),
      },

      // Legacy V9 tool name aliases for backward compatibility with existing agents/prompts
      {
        name: 'dkg_list_paranets',
        description: '[Deprecated: use dkg_list_context_graphs] List all context graphs (formerly paranets).',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_toolCallId, _params) => this.handleListContextGraphs(),
      },
      {
        name: 'dkg_paranet_create',
        description: '[Deprecated: use dkg_context_graph_create] Create a new context graph (formerly paranet).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Context graph name' },
            description: { type: 'string', description: 'Optional description' },
            paranet_id: { type: 'string', description: 'Optional custom ID slug' },
          },
          required: ['name'],
        },
        execute: async (_toolCallId, args) =>
          this.handleContextGraphCreate({ ...args, id: args.paranet_id ?? args.id }),
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Handlers — all route through DkgDaemonClient → daemon HTTP API
  // ---------------------------------------------------------------------------

  private async handleStatus(): Promise<OpenClawToolResult> {
    try {
      const [status, wallets] = await Promise.all([
        this.client.getFullStatus(),
        this.client.getWallets().catch(() => ({ wallets: [] })),
      ]);
      return this.json({ ...status, walletAddresses: wallets.wallets });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleListContextGraphs(): Promise<OpenClawToolResult> {
    try {
      const result = await this.client.listContextGraphs();
      const graphs = result.contextGraphs;
      return this.json({ contextGraphs: graphs, count: graphs.length });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handlePublish(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? args.paranet_id ?? '');
      const rawQuads = args.quads;

      if (!Array.isArray(rawQuads) || rawQuads.length === 0) {
        return this.error('"quads" must be a non-empty array of {subject, predicate, object} objects.');
      }

      // Convert agent-friendly quads to daemon format:
      // - subject/predicate: plain URI strings (passed as-is)
      // - object: auto-detect URI vs literal — URIs passed as-is, literals wrapped in ""
      const quads = rawQuads.map((q: any) => {
        const objVal = String(q.object ?? '');
        return {
          subject: String(q.subject ?? ''),
          predicate: String(q.predicate ?? ''),
          object: isUri(objVal) ? objVal : `"${objVal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
          graph: q.graph ? String(q.graph) : '',
        };
      });

      const result = await this.client.publish(contextGraphId, quads);
      return this.json({ kcId: result.kcId, kaCount: result.kas?.length ?? 0, quadsPublished: quads.length });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleQuery(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const sparql = String(args.sparql);
      const contextGraphId = (args.context_graph_id ?? args.paranet_id) ? String(args.context_graph_id ?? args.paranet_id) : undefined;
      const includeSharedMemory = args.include_shared_memory === 'true' || args.include_shared_memory === true;
      const result = await this.client.query(sparql, {
        contextGraphId,
        includeSharedMemory: includeSharedMemory || undefined,
      });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleFindAgents(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const filter: { framework?: string; skill_type?: string } = {};
      if (args.framework) filter.framework = String(args.framework);
      if (args.skill_type) filter.skill_type = String(args.skill_type);
      const result = await this.client.getAgents(Object.keys(filter).length ? filter : undefined);
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleSendMessage(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const result = await this.client.sendChat(String(args.peer_id), String(args.text));
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleReadMessages(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const opts: { peer?: string; limit?: number; since?: number } = {};
      if (args.peer) opts.peer = String(args.peer);
      if (args.limit) {
        const n = parseInt(String(args.limit), 10);
        if (!isNaN(n) && n > 0) opts.limit = Math.min(n, 1000);
      }
      if (args.since) {
        const n = parseInt(String(args.since), 10);
        if (!isNaN(n)) opts.since = n;
      }
      const result = await this.client.getMessages(opts);
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleInvokeSkill(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const result = await this.client.invokeSkill(
        String(args.peer_id),
        String(args.skill_uri),
        String(args.input),
      );
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleContextGraphCreate(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const name = String(args.name ?? '').trim();
      if (!name) {
        return this.error('"name" is required.');
      }
      const explicitId = args.id != null && String(args.id).trim();
      const id = explicitId || slugify(name);
      if (!id) {
        return this.error('Could not derive a valid context graph ID from the name. Provide an explicit "id".');
      }
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
        return this.error(
          `Invalid context graph ID "${id}". Use lowercase letters, numbers, and hyphens (e.g. "my-research"). ` +
          'Must start and end with a letter or number.',
        );
      }
      const description = args.description ? String(args.description).trim() : undefined;
      const result = await this.client.createContextGraph(id, name, description);
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleSubscribe(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? args.paranet_id ?? '').trim();
      if (!contextGraphId) {
        return this.error('"context_graph_id" is required.');
      }
      const includeSharedMemory = args.include_shared_memory === 'false' ? false : undefined;
      const result = await this.client.subscribe(contextGraphId, {
        includeSharedMemory,
      });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleWalletBalances(): Promise<OpenClawToolResult> {
    try {
      const result = await this.client.getWalletBalances();
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }
}

/** Convert a human-readable name into a URL-safe slug (e.g. "My Research Context Graph" → "my-research-context-graph"). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // replace non-alphanumeric runs with a single hyphen
    .replace(/^-+|-+$/g, '');      // strip leading/trailing hyphens
}

/** Check if a value looks like a URI (starts with a known scheme). */
function isUri(value: string): boolean {
  return /^(?:https?:\/\/|urn:|did:)/i.test(value);
}
