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
import { GET_VIEWS, type GetView } from '@origintrail-official/dkg-core';
import {
  DkgDaemonClient,
  type LocalAgentIntegrationRecord,
  type LocalAgentIntegrationTransport,
} from './dkg-client.js';
import { DkgChannelPlugin } from './DkgChannelPlugin.js';
import { HookSurface } from './HookSurface.js';
import { ChatTurnWriter } from './ChatTurnWriter.js';
import {
  DkgMemoryPlugin,
  DkgMemorySearchManager,
  toAgentPeerId,
  type DkgMemorySession,
  type DkgMemorySessionResolver,
} from './DkgMemoryPlugin.js';
import type {
  DkgOpenClawConfig,
  OpenClawPluginApi,
  OpenClawTool,
  OpenClawToolResult,
} from './types.js';
import { homedir } from 'node:os';

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
  private hookSurface: HookSurface | null = null;
  private hookSurfaceApi: OpenClawPluginApi | null = null;
  private chatTurnWriter: ChatTurnWriter | null = null;
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
   * Counter for registration-mode probe diagnostics. Incremented on each
   * register() call when DKG_PROBE_REGISTRATION_MODE=1 for sequencing logs.
   */
  private probeRegisterCallCount = 0;
  /**
   * Track hook fires per (event, mechanism) for the registration-mode probe.
   * Maps "event:via" to fire count.
   */
  private probeHookFireCounts = new Map<string, number>();

  /**
   * Register the DKG plugin with an OpenClaw plugin API instance.
   * On the first call: full init (lifecycle hooks, daemon handshake, integration modules).
   * On subsequent calls (gateway multi-phase init): re-registers tools into the new registry.
   */
  register(api: OpenClawPluginApi): void {

    // --- Env-gated registration-mode probe ---
    if (process.env.DKG_PROBE_REGISTRATION_MODE === '1') {
      this.runRegistrationModeProbe(api);
    }

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
      // Retry typed-hook installs if the first register() call used a
      // setup-runtime api where api.on was undefined. HookSurface records
      // those as installedVia='none' with installError set; we detect that
      // and re-install against the current (possibly full-mode) api.
      this.installHooksIfNeeded(api);
      return;
    }

    // Create daemon client — used by all tools and integration modules
    const daemonUrl = this.config.daemonUrl ?? 'http://127.0.0.1:9200';
    this.client = new DkgDaemonClient({ baseUrl: daemonUrl });
    this.initialized = true;
    const stateDir = (api as any)?.runtime?.state?.resolveStateDir?.()
      ?? process.env.OPENCLAW_STATE_DIR
      ?? `${homedir()}/.openclaw`;
    this.chatTurnWriter = new ChatTurnWriter({ client: this.client, logger: api.logger, stateDir });
    this.installHooksIfNeeded(api);

    api.registerHook('session_end', () => this.stop(), { name: 'dkg-node-stop' });

    // --- Integration modules ---
    this.registerIntegrationModules(api, { enableFullRuntime: runtimeEnabled });

    if (runtimeEnabled) {
      this.registerLocalAgentIntegration(api, registrationMode);
    }
  }

  /**
   * Install the 5 W4a/W4b hooks via HookSurface, supporting multi-phase
   * init. Rebuild the surface when:
   *   (a) ANY prior install recorded a failure (`installedVia === 'none'`),
   *       whether typed (api.on was undefined at first-call) or internal
   *       (globalThis hook map not created yet); OR
   *   (b) the gateway passed a new `api` instance on re-entry
   *       (`openclaw-entry.mjs` reuses the singleton across new
   *       registries, so typed hooks bound to the previous api object
   *       would otherwise never fire against the new one).
   * Retrying on internal-hook failures too is load-bearing: if the first
   * register() call runs before the gateway sets up the internal-hook map,
   * cross-channel persistence (W4b) would otherwise stay dead forever
   * even after the map appears on a later re-entry.
   */
  private installHooksIfNeeded(api: OpenClawPluginApi): void {
    if (!this.chatTurnWriter) return;

    if (this.hookSurface) {
      const stats = this.hookSurface.getDispatchStats();
      const apiChanged = this.hookSurfaceApi !== api;
      if (apiChanged) {
        // New api instance — typed hooks bound to the old api won't fire
        // against it. Destroy and rebuild everything.
        this.hookSurface.destroy();
        this.hookSurface = null;
        this.hookSurfaceApi = null;
      } else {
        // Same api. Only retry INTERNAL hook installs that previously
        // failed (e.g. gateway hadn't created the internal-hook map yet
        // at first register()). Do NOT re-run typed installs on the same
        // api — `api.on(...)` has no unsubscribe, so a rebuild would
        // leave the old typed handlers bound and `before_prompt_build` /
        // `agent_end` would fire twice per turn.
        const internalNeedsRetry = (event: string) =>
          stats[`internal:${event}`]?.installedVia === 'none';
        if (internalNeedsRetry('message:received')) {
          this.hookSurface.install('internal', 'message:received', (ev) => this.chatTurnWriter!.onMessageReceived(ev));
        }
        if (internalNeedsRetry('message:sent')) {
          this.hookSurface.install('internal', 'message:sent', (ev) => this.chatTurnWriter!.onMessageSent(ev));
        }
        return;
      }
    }

    this.hookSurface = new HookSurface(api, api.logger);
    this.hookSurfaceApi = api;

    // W3 — auto-recall every turn via before_prompt_build typed hook
    this.hookSurface.install('typed', 'before_prompt_build', (ev, ctx) => this.handleBeforePromptBuild(ev, ctx));

    // W4a — LLM-driven turn capture via typed hooks. `before_compaction`
    // and `before_reset` are rare on healthy gateways; tag them so the
    // HookSurface commit-by-timeout warn downgrades to debug (otherwise
    // they false-positive within 30s of startup every time).
    this.hookSurface.install('typed', 'agent_end',        (ev, ctx) => this.chatTurnWriter!.onAgentEnd(ev, ctx));
    this.hookSurface.install('typed', 'before_compaction', (ev, ctx) => this.chatTurnWriter!.onBeforeCompaction(ev, ctx), { rareFireExpected: true });
    this.hookSurface.install('typed', 'before_reset',      (ev, ctx) => this.chatTurnWriter!.onBeforeReset(ev, ctx), { rareFireExpected: true });

    // W4b — non-LLM channel capture via internal-hook map (PR #216 mechanism)
    this.hookSurface.install('internal', 'message:received', (ev) => this.chatTurnWriter!.onMessageReceived(ev));
    this.hookSurface.install('internal', 'message:sent',     (ev) => this.chatTurnWriter!.onMessageSent(ev));

    // I8 — tool-selection guidance injected into the system prompt every turn.
    // Reaches the agent model directly (unlike SKILL.md which only reaches
    // doc-readers). Feature-detected: no-op on gateways that haven't wired it.
    const registerPromptSection = (api as any).registerMemoryPromptSection as
      | ((section: { title: string; body: string }) => void)
      | undefined;
    if (typeof registerPromptSection === 'function') {
      try {
        registerPromptSection({
          title: 'DKG Memory',
          body:
            'Prefer `memory_search` for free-text recall across your DKG memory ' +
            '(fan-outs WM/SWM/VM, trust-weighted, deduped). Use `dkg_query` only ' +
            'when you need precise SPARQL control over a known graph pattern.',
        });
      } catch (err: any) {
        api.logger.debug?.(`[dkg] registerMemoryPromptSection failed: ${err?.message ?? err}`);
      }
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
        api.logger.info?.('[dkg] Memory module loaded but slot registration was skipped (see warn above for reason)');
        return;
      }
      api.logger.info?.('[dkg] Memory module enabled — DKG-backed memory slot active');

      // Wire the channel plugin to re-assert our memory-slot capability
      // before each inbound turn dispatch. This guarantees our runtime
      // handles recall even when memory-core's dreaming sidecar overwrites
      // the single-slot capability store during plugin loading.
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

    // Wait for the standalone bridge to bind BEFORE the connect call so the
    // daemon never sees a ready=true integration whose transport.bridgeUrl
    // isn't actually serving yet. start() is idempotent (no-op if already
    // listening) and falls back to an OS-allocated port if the configured one
    // is taken (issue #272), so it resolves quickly in both 2026.3.31 (gateway
    // holds 9201 → fallback) and 2026.4.15 (port free → configured). Without
    // this await, getOpenClawChannelTargets in the daemon would synthesize a
    // default-9201 bridge target or a gateway target with no bridgeUrl and
    // race UI probes / send-forwarding against the bridge bind.
    let startError: Error | null = null;
    if (this.channelPlugin) {
      try {
        await this.channelPlugin.start();
      } catch (err: any) {
        startError = err instanceof Error ? err : new Error(String(err));
        api.logger.warn?.(`[dkg] OpenClaw channel bridge failed to start: ${startError.message}`);
      }
    }

    const bridgeReady = this.channelPlugin?.isListening === true && !startError;
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
          status: startError ? 'error' : bridgeReady ? 'ready' : 'connecting',
          ready: bridgeReady,
          lastError: startError ? startError.message : null,
        },
      });
    } catch (err: any) {
      api.logger.warn?.(`[dkg] Local agent registration failed (will retry on next gateway start): ${err.message}`);
      return;
    }
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
    try { this.chatTurnWriter?.flushSync(); } catch { /* best effort */ }
    try { this.hookSurface?.destroy(); } catch { /* best effort */ }
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
        name: 'dkg_context_graph_invite',
        description:
          'Invite a peer to a context graph using their peer ID. For "share this project with my friend" ' +
          'requests, this is the primary user-facing deliverable because it returns a ready-to-share invite code ' +
          'that the friend can paste into Join. Use this when you have a peer ID but not the friend\'s agent ' +
          'address, or alongside `dkg_participant_add` when you have both identifiers for a private project.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            peer_id: { type: 'string', description: 'Target peer ID (12D3KooW...).' },
          },
          required: ['context_graph_id', 'peer_id'],
        },
        execute: async (_toolCallId, args) => this.handleContextGraphInvite(args),
      },
      {
        name: 'dkg_participant_add',
        description:
          'Add an agent address to a curated/private context graph allowlist. Use this when you know the ' +
          'friend\'s DKG agent address. For "share with my friend" requests on private projects, prefer ' +
          'returning an invite code too when you also have their peer ID, because allowlisting alone is not the ' +
          'full UI join flow.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            agent_address: { type: 'string', description: 'Friend\'s DKG agent address (0x...).' },
          },
          required: ['context_graph_id', 'agent_address'],
        },
        execute: async (_toolCallId, args) => this.handleParticipantAdd(args),
      },
      {
        name: 'dkg_participant_remove',
        description:
          'Remove an agent address from a curated/private context graph allowlist.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            agent_address: { type: 'string', description: 'Agent address to remove (0x...).' },
          },
          required: ['context_graph_id', 'agent_address'],
        },
        execute: async (_toolCallId, args) => this.handleParticipantRemove(args),
      },
      {
        name: 'dkg_participant_list',
        description:
          'List the allowed agent addresses for a context graph.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
          },
          required: ['context_graph_id'],
        },
        execute: async (_toolCallId, args) => this.handleParticipantList(args),
      },
      {
        name: 'dkg_join_request_list',
        description:
          'List pending join requests for a context graph so the curator can review them.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
          },
          required: ['context_graph_id'],
        },
        execute: async (_toolCallId, args) => this.handleJoinRequestList(args),
      },
      {
        name: 'dkg_join_request_approve',
        description:
          'Approve a pending join request for the given agent address.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            agent_address: { type: 'string', description: 'Requesting agent address (0x...).' },
          },
          required: ['context_graph_id', 'agent_address'],
        },
        execute: async (_toolCallId, args) => this.handleJoinRequestApprove(args),
      },
      {
        name: 'dkg_join_request_reject',
        description:
          'Reject a pending join request for the given agent address.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            agent_address: { type: 'string', description: 'Requesting agent address (0x...).' },
          },
          required: ['context_graph_id', 'agent_address'],
        },
        execute: async (_toolCallId, args) => this.handleJoinRequestReject(args),
      },
      {
        name: 'dkg_subscribe',
        description:
          'Subscribe to a context graph to receive its data from peers. Call once before querying or publishing ' +
          'a remotely-authored CG.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Context graph ID (e.g. "my-research").' },
            include_shared_memory: {
              type: 'boolean',
              description: 'Also sync Shared Working Memory. Default: true.',
            },
          },
          required: ['context_graph_id'],
        },
        execute: async (_toolCallId, args) => this.handleSubscribe(args),
      },
      {
        name: 'dkg_publish',
        description:
          'One-shot write + publish helper: writes the supplied quads to Shared Working Memory, then publishes ' +
          'all SWM in the CG to Verified Memory (on-chain) and clears SWM. For the canonical stepwise flow ' +
          '(write → promote → publish) use `dkg_assertion_create/write/promote` followed by ' +
          '`dkg_shared_memory_publish`.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            quads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  subject: { type: 'string', description: 'Subject URI.' },
                  predicate: { type: 'string', description: 'Predicate URI.' },
                  object: { type: 'string', description: 'Object — URI or literal (URI auto-detected by prefix).' },
                  graph: { type: 'string', description: 'Optional named graph URI.' },
                },
                required: ['subject', 'predicate', 'object'],
              },
              description:
                'Quads to publish. Example: `[{ subject: "https://example.org/a", predicate: "https://schema.org/name", object: "Alpha" }]`. ' +
                'Object values starting with http://, https://, urn:, did: are passed as URIs; anything else becomes a literal.',
            },
          },
          required: ['context_graph_id', 'quads'],
        },
        execute: async (_toolCallId, args) => this.handlePublish(args),
      },
      {
        name: 'dkg_query',
        description:
          'Read-only SPARQL query against the local triple store. Pass `view` to pick which memory ' +
          'layer to read: `working-memory` (WM — per-agent), `shared-working-memory` (SWM — gossip-' +
          'replicated), or `verified-memory` (VM — on-chain anchored); when `view` is supplied, ' +
          '`context_graph_id` is also required. For WM reads, `agent_address` selects whose WM to ' +
          'read; prefer the injected `current_agent_address` from turn context when present. If a WM ' +
          'read looks unexpectedly empty, retry alternate identity forms before concluding there is no ' +
          'WM data. It defaults to this node\'s agent address (the same default the adapter uses for ' +
          'memory-plugin reads). Omit `view` for a cross-graph query routed via the legacy data-' +
          'graph path (unscoped, or scoped when `context_graph_id` is set); use `GRAPH ?g { ... }` ' +
          'for named-graph targeting in that mode.',
        parameters: {
          type: 'object',
          properties: {
            sparql: { type: 'string', description: 'SPARQL SELECT, CONSTRUCT, ASK, or DESCRIBE.' },
            context_graph_id: {
              type: 'string',
              description:
                'CG scope. Optional when `view` is omitted (unscoped cross-graph query); required ' +
                'when `view` is set (view-based routing always targets a single CG).',
            },
            view: {
              type: 'string',
              description:
                'Memory layer to read. Accepted values: `working-memory` (per-agent WM; uses ' +
                '`agent_address` or falls back to this node\'s agent address), `shared-working-memory` ' +
                '(provisional, gossip-replicated), or `verified-memory` (on-chain anchored). Omit to ' +
                'use the legacy cross-graph data-path routing (not layer-scoped). Validation is ' +
                'handler-side (not a JSON-schema enum) so strict-schema hosts still surface the ' +
                'tailored migration guidance on invalid values.',
            },
            agent_address: {
              type: 'string',
              description:
                "Optional target for `view: \"working-memory\"` reads — defaults to this node's " +
                'agent address (matches the default the memory plugin uses for its own WM reads). ' +
                'Prefer the injected `current_agent_address` from chat context when available. Accepts ' +
                'wallet/address form, raw peer ID, or DID form. Ignored for non-WM views. Supply an ' +
                'explicit value to read another local agent\'s WM namespace in multi-agent deployments.',
            },
          },
          required: ['sparql'],
        },
        execute: async (_toolCallId, args) => this.handleQuery(args),
      },
      {
        name: 'dkg_find_agents',
        description:
          'List DKG agents known to this node — combines the local registry (this node + cached peers from the ' +
          'identity layer) with live P2P connection status. Works offline: returns locally-known agents with ' +
          'their last-seen `connectionStatus` even when no peers are currently reachable.',
        parameters: {
          type: 'object',
          properties: {
            framework: { type: 'string', description: 'Filter by framework (e.g. "OpenClaw", "ElizaOS").' },
            skill_type: { type: 'string', description: 'Filter by skill type URI (e.g. "ImageAnalysis").' },
          },
          required: [],
        },
        execute: async (_toolCallId, args) => this.handleFindAgents(args),
      },
      {
        name: 'dkg_send_message',
        description:
          'Send an end-to-end encrypted chat message to another DKG agent. Use dkg_find_agents first to ' +
          'discover peer IDs. Fails when the target is offline or the P2P network is unavailable.',
        parameters: {
          type: 'object',
          properties: {
            peer_id: { type: 'string', description: 'Recipient peer ID (12D3KooW…) or agent name.' },
            text: { type: 'string', description: 'Message text.' },
          },
          required: ['peer_id', 'text'],
        },
        execute: async (_toolCallId, args) => this.handleSendMessage(args),
      },
      {
        name: 'dkg_read_messages',
        description:
          'Read locally-persisted chat history (messages sent + received through the DKG node). Backed by the ' +
          'node\'s local message store, so it returns full history offline. Optional filters: `peer` (peer ID or ' +
          'agent name), `limit`, `since` (Unix-ms cutoff).',
        parameters: {
          type: 'object',
          properties: {
            peer: { type: 'string', description: 'Filter by peer ID or agent name.' },
            limit: { type: 'string', description: 'Max messages (default 100, max 1000).' },
            since: { type: 'string', description: 'Only messages after this Unix-ms timestamp.' },
          },
          required: [],
        },
        execute: async (_toolCallId, args) => this.handleReadMessages(args),
      },
      {
        name: 'dkg_invoke_skill',
        description:
          "Invoke a remote agent's skill over the DKG network. Use dkg_find_agents with skill_type first. " +
          'Fails when the peer is offline or the P2P network is unavailable.',
        parameters: {
          type: 'object',
          properties: {
            peer_id: { type: 'string', description: 'Target peer ID (12D3KooW…) or agent name.' },
            skill_uri: { type: 'string', description: 'Skill URI (e.g. "ImageAnalysis").' },
            input: { type: 'string', description: 'UTF-8 input (skill-specific semantics).' },
          },
          required: ['peer_id', 'skill_uri', 'input'],
        },
        execute: async (_toolCallId, args) => this.handleInvokeSkill(args),
      },

      // ── Assertion lifecycle (Working Memory) ───────────────────────────────
      {
        name: 'dkg_assertion_create',
        description:
          'Step 1 of the canonical flow. Create a per-agent Working Memory assertion graph. Idempotent: a ' +
          'duplicate name returns `{ assertionUri: null, alreadyExists: true }`.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            name: { type: 'string', description: 'Assertion name (lowercase letters, digits, hyphens).' },
            sub_graph_name: { type: 'string', description: 'Optional sub-graph (must be pre-registered).' },
          },
          required: ['context_graph_id', 'name'],
        },
        execute: async (_toolCallId, args) => this.handleAssertionCreate(args),
      },
      {
        name: 'dkg_assertion_write',
        description:
          'Step 2 of the canonical flow. Append quads to an existing assertion. Object values are auto-typed as ' +
          'URI or literal. Example: `{ subject: "https://example.org/a", predicate: "https://schema.org/name", object: "Alpha" }`.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            name: { type: 'string', description: 'Assertion name (must already exist).' },
            quads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  subject: { type: 'string', description: 'Subject URI.' },
                  predicate: { type: 'string', description: 'Predicate URI.' },
                  object: { type: 'string', description: 'Object URI or literal.' },
                  graph: { type: 'string', description: 'Optional named graph URI.' },
                },
                required: ['subject', 'predicate', 'object'],
              },
              description: 'Non-empty array of quads to append.',
            },
            sub_graph_name: { type: 'string', description: 'Must match the one used at create time.' },
          },
          required: ['context_graph_id', 'name', 'quads'],
        },
        execute: async (_toolCallId, args) => this.handleAssertionWrite(args),
      },
      {
        name: 'dkg_assertion_promote',
        description:
          'Step 3 of the canonical flow. Promote an assertion (or selected root entities) from Working Memory ' +
          'into Shared Working Memory. Finalize with dkg_shared_memory_publish (NOT dkg_publish — that helper ' +
          'expects fresh quads and would append duplicates to SWM).',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            name: { type: 'string', description: 'Assertion name to promote.' },
            entities: {
              type: 'array',
              items: { type: 'string', description: 'Root entity URI.' },
              description:
                'Root entity URIs to promote. Omit to promote every root entity in the assertion (default). ' +
                'When provided, must be a non-empty array of URIs that already exist in the assertion.',
            },
            sub_graph_name: { type: 'string', description: 'Must match the one used at write time.' },
          },
          required: ['context_graph_id', 'name'],
        },
        execute: async (_toolCallId, args) => this.handleAssertionPromote(args),
      },
      {
        name: 'dkg_assertion_discard',
        description:
          'Discard a Working Memory assertion without promoting it. Errors (400) if the assertion is missing.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            name: { type: 'string', description: 'Assertion name to discard.' },
            sub_graph_name: { type: 'string', description: 'Must match the one used at create time.' },
          },
          required: ['context_graph_id', 'name'],
        },
        execute: async (_toolCallId, args) => this.handleAssertionDiscard(args),
      },
      {
        name: 'dkg_assertion_import_file',
        description:
          'Import a local document (markdown, PDF, etc.) into an assertion: the daemon runs its extraction ' +
          'pipeline and writes the resulting triples. text/markdown is native; other types need a registered ' +
          'converter (extraction returns `status: "skipped"` if none).',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            name: { type: 'string', description: 'Target assertion name.' },
            file_path: { type: 'string', description: 'Absolute local path to the file to import.' },
            content_type: { type: 'string', description: 'MIME override (e.g. "text/markdown", "application/pdf"). Inferred from extension when omitted — covers .md/.markdown/.pdf/.docx/.html/.htm/.txt/.csv; other extensions fall through to application/octet-stream.' },
            ontology_ref: { type: 'string', description: "Optional ontology URI to guide extraction (e.g. the CG's `_ontology`)." },
            sub_graph_name: { type: 'string', description: 'Optional sub-graph (must be pre-registered).' },
          },
          required: ['context_graph_id', 'name', 'file_path'],
        },
        execute: async (_toolCallId, args) => this.handleAssertionImportFile(args),
      },
      {
        name: 'dkg_assertion_query',
        description:
          'Dump every quad in an assertion as `{ quads, count }`. NOT a SPARQL endpoint — use dkg_query for ' +
          'ad-hoc SPARQL.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            name: { type: 'string', description: 'Assertion name to dump.' },
            sub_graph_name: { type: 'string', description: 'Must match the one used at write time.' },
          },
          required: ['context_graph_id', 'name'],
        },
        execute: async (_toolCallId, args) => this.handleAssertionQuery(args),
      },
      {
        name: 'dkg_assertion_history',
        description:
          'Fetch an assertion\'s lifecycle descriptor (author, extraction status, promotion state). ' +
          'Returns 404 if no record exists.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            name: { type: 'string', description: 'Assertion name.' },
            agent_address: { type: 'string', description: "Optional author — defaults to this node's agent address." },
            sub_graph_name: { type: 'string', description: 'Must match the one used at write time.' },
          },
          required: ['context_graph_id', 'name'],
        },
        execute: async (_toolCallId, args) => this.handleAssertionHistory(args),
      },

      // ── Sub-graph management ──────────────────────────────────────────────
      {
        name: 'dkg_sub_graph_create',
        description:
          'Create a named sub-graph inside a context graph (optional partition for scoped assertions).',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Parent context graph ID.' },
            sub_graph_name: { type: 'string', description: 'Sub-graph name (lowercase letters, digits, hyphens; must not start with "_").' },
          },
          required: ['context_graph_id', 'sub_graph_name'],
        },
        execute: async (_toolCallId, args) => this.handleSubGraphCreate(args),
      },
      {
        name: 'dkg_sub_graph_list',
        description:
          'List sub-graphs in a context graph with best-effort entity / triple counts.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Parent context graph ID.' },
          },
          required: ['context_graph_id'],
        },
        execute: async (_toolCallId, args) => this.handleSubGraphList(args),
      },

      // ── Shared Working Memory → Verified Memory publish (canonical step 4) ─
      {
        name: 'dkg_shared_memory_publish',
        description:
          'Final step of the canonical flow. Publish all Shared Working Memory in a context graph to Verified ' +
          'Memory (on-chain) and clear SWM. Use after `dkg_assertion_promote` to finalize promoted data. ' +
          'If the context graph is still local-only/unregistered, set `register_if_needed: true` to explicitly ' +
          'upgrade it to on-chain registration before publishing.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID.' },
            root_entities: {
              type: 'array',
              items: { type: 'string', description: 'Root entity URI to publish.' },
              description: 'Optional filter — publish only these root entities. Omit to publish all SWM in the CG.',
            },
            sub_graph_name: {
              type: 'string',
              description: 'Optional sub-graph scope. Must match the sub-graph used during create/write/promote. Cannot be combined with a cross-CG publish target.',
            },
            register_if_needed: {
              type: 'boolean',
              description: 'When true, explicitly register the context graph on-chain before publishing if needed. This may spend gas/TRAC; it is opt-in and not the default.',
            },
            reveal_on_chain: {
              type: 'boolean',
              description: 'Deprecated compatibility no-op. V10 context graph registration ignores metadata reveal.',
            },
            access_policy: {
              type: 'number',
              description: 'Optional registration access policy used only when `register_if_needed` is true: `0` for open, `1` for private.',
            },
          },
          required: ['context_graph_id'],
        },
        execute: async (_toolCallId, args) => this.handleSharedMemoryPublish(args),
      },
      {
        name: 'memory_search',
        description:
          'Search your DKG-backed memory across all trust tiers (Working Memory drafts, ' +
          'Shared Working Memory, and on-chain Verified Memory) in both your agent-context ' +
          'graph and the currently-selected project context graph. Returns the top-N most ' +
          'relevant memory snippets with trust-weighted ranking (VM > SWM > WM). Prefer this ' +
          'over dkg_query for free-text recall; use dkg_query only when you need precise ' +
          'SPARQL control over a known graph pattern.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Free-text search query. Case-insensitive keyword match (≥2 chars).',
            },
            limit: {
              type: ['number', 'string'],
              description: 'Max hits to return. Integer in [1, 100]. Default 20.',
            },
          },
          required: ['query'],
        },
        execute: async (_toolCallId, args) => this.handleMemorySearch(args),
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

  /**
   * W3 — auto-recall handler for the `before_prompt_build` typed hook.
   *
   * Fires every turn. Takes the last user message from the run, calls
   * `DkgMemorySearchManager.searchNarrow` (WM-only, top 5, 250ms budget
   * via `Promise.race`), and returns an `appendSystemContext` block that
   * OpenClaw merges into the system prompt.
   *
   * Returns `undefined` (not `{}` or empty string) on any of:
   *   - no memoryPlugin registered
   *   - no user message in event.messages
   *   - query shorter than 2 chars
   *   - timeout exceeded
   *   - zero hits returned
   *
   * Per plan v2.1 A2: empty-string returns break prompt caching. Every
   * early-return path must return `undefined`.
   */
  private async handleBeforePromptBuild(
    event: any,
    ctx: any,
  ): Promise<{ appendSystemContext: string } | undefined> {
    if (!this.memoryPlugin) return undefined;

    // Per-turn re-assertion of the memory-slot capability. Cheap (one
    // property assignment per DkgMemoryPlugin.reAssertCapability docstring)
    // and runs before every prompt build, so if another plugin reclaims
    // `memoryPluginState.capability` after startup, DKG memory re-asserts
    // ownership before slot-backed recall runs. Replaces the retired
    // PR #211 per-turn re-assert wiring with a lighter, channel-agnostic
    // variant keyed to where it actually matters (recall-time).
    try {
      this.memoryPlugin.reAssertCapability();
    } catch {
      /* non-fatal; retained by DkgMemoryPlugin itself */
    }

    const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    if (!lastUser) return undefined;

    const query = extractUserTextFromContent(lastUser.content);
    if (!query || query.length < 2) return undefined;

    try {
      const manager = new DkgMemorySearchManager({
        client: this.client,
        resolver: this.memorySessionResolver,
        sessionKey: ctx?.sessionKey,
        logger: this.memoryResolverApi?.logger,
      });

      // 250ms budget. Racing with setTimeout means the underlying SPARQL
      // queries may complete in the background after we've returned —
      // acceptable v1 trade-off; tighter AbortSignal threading is a
      // follow-up (plan N4 would thread through client.query).
      const hits = await Promise.race([
        manager.searchNarrow(query, { maxResults: 5 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      if (!hits || hits.length === 0) return undefined;

      const block = formatRecalledMemoryBlock(
        hits.map((h) => ({ snippet: h.snippet, layer: String(h.layer ?? 'unknown'), score: h.score })),
      );
      return { appendSystemContext: block };
    } catch {
      // Never throw out of a prompt-build handler — return undefined so
      // OpenClaw's prompt-merge step sees no-op and the turn proceeds.
      return undefined;
    }
  }

  /**
   * Agent-callable recall button. Runs the full 6-layer SPARQL fan-out
   * (agent-context WM/SWM/VM + project CG WM/SWM/VM when resolved) via
   * `DkgMemorySearchManager`, returns trust-weighted ranked hits.
   */
  private async handleMemorySearch(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    if (!this.memoryPlugin) {
      return this.error('memory_search unavailable: memory module is disabled in adapter config');
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return this.error('"query" is required (non-empty string, ≥2 chars)');
    }
    const rawLimit = typeof args.limit === 'string' ? Number(args.limit) : args.limit;
    const limit = Number.isFinite(rawLimit)
      ? Math.floor(Math.max(1, Math.min(100, rawLimit as number)))
      : 20;

    try {
      const manager = new DkgMemorySearchManager({
        client: this.client,
        resolver: this.memorySessionResolver,
        logger: this.memoryResolverApi?.logger,
      });
      const hits = await manager.search(query, { maxResults: limit });
      const session = this.memorySessionResolver.getSession(undefined);
      return this.json({
        query,
        count: hits.length,
        scope: session?.projectContextGraphId ?? null,
        hits: hits.map((h) => ({
          snippet: h.snippet,
          layer: h.layer,
          source: h.source,
          score: h.score,
          path: h.path,
        })),
      });
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
      const contextGraphId = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      if (!contextGraphId) {
        return this.error('"context_graph_id" is required.');
      }
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
          object: isUri(objVal) ? objVal : `"${escapeRdfLiteral(objVal)}"`,
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
      // V10 is the first product launch — no v9 back-compat. Reject `paranet_id`
      // explicitly rather than silently widening it to `context_graph_id`, so
      // stale v9 agent code surfaces its wrong assumption instead of sending
      // an empty/garbage value that the daemon would then ignore.
      if (args.paranet_id !== undefined) {
        return this.error('"paranet_id" is not a supported parameter. Use "context_graph_id".');
      }
      // `include_shared_memory` was removed in favor of `view`. There is no
      // one-line replacement: the legacy `true` path unioned the data graph
      // with SWM (`DKGQueryEngine.query`, line ~229 — wraps the sparql in
      // both graphs and merges), while `false` used the legacy data-graph
      // path alone. `view: "shared-working-memory"` reads ONLY SWM and
      // would drop data-graph-only triples for `true` callers; `view:
      // "verified-memory"` has different semantics entirely. Surface the
      // break explicitly rather than pretending a clean migration exists.
      if (args.include_shared_memory !== undefined) {
        return this.error(
          '"include_shared_memory" is no longer supported. There is no exact `view` replacement ' +
            'for the legacy union-semantics: `true` previously queried the data graph ∪ SWM ' +
            '(no single `view` reproduces this union). Closest-intent replacements: omit `view` ' +
            'for the legacy data-graph path, or `view: "shared-working-memory"` for SWM-only, or ' +
            '`view: "verified-memory"` for on-chain data. If you need the original union exactly, ' +
            'call POST /api/query directly with `includeSharedMemory: true`.',
        );
      }
      // `context_graph_id` is optional on this tool (omit → unscoped query
      // across all subscribed CGs). Trim whitespace so that
      // `{ context_graph_id: "   " }` behaves like an omission rather than
      // matching a CG whose id is the literal whitespace string.
      const trimmed = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      const contextGraphId = trimmed || undefined;
      // Handler-side view validation (no JSON-schema enum, so strict-schema
      // hosts still surface these tailored errors). Use the shared
      // `GET_VIEWS` constant from `@origintrail-official/dkg-core` as the
      // single source of truth — maintaining a local mirror invited drift
      // whenever a view was added/removed upstream.
      let view: GetView | undefined;
      if (args.view !== undefined) {
        if (typeof args.view !== 'string' || !(GET_VIEWS as readonly string[]).includes(args.view)) {
          return this.error(
            `"view" must be one of: ${GET_VIEWS.join(', ')}.`,
          );
        }
        view = args.view as GetView;
      }
      // When a `view` is requested, the daemon requires `context_graph_id`
      // to scope the view resolution (`DKGQueryEngine.query` throws
      // "view '…' requires a contextGraphId"). Reject locally so the caller
      // sees a clear, tool-shaped error instead of a cryptic 500 after a
      // daemon round-trip.
      if (view !== undefined && contextGraphId === undefined) {
        return this.error(
          `"view: ${view}" requires "context_graph_id". View-based routing always targets a ` +
            'single CG; omit `view` for an unscoped cross-graph query.',
        );
      }
      // For WM reads the daemon requires an agentAddress (see
      // `resolveViewGraphs:60`). Accept an explicit `agent_address` on the
      // tool and fall back to this node's agent address — the same default
      // the memory plugin uses for its own WM reads (see
      // `memorySessionResolver.getDefaultAgentAddress` above). Without the
      // fallback, callers without an explicit address would get "agentAddress
      // is required for the working-memory view" from the engine.
      //
      // B43: normalize DID-form addresses (`did:dkg:agent:<peerId>`) to raw
      // peer IDs for WM routing, same as `DkgMemoryPlugin` does at its
      // boundary. The daemon's WM view scopes graphs by the bare peer ID;
      // forwarding a DID-prefixed value lands the query in a non-existent
      // namespace and returns empty bindings. Apply to both the explicit
      // arg and the node-peerId fallback (the latter is typically already
      // bare, but normalize defensively in case the source ever changes).
      // Strict validation on `agent_address`: anything *present but bogus*
      // (non-string, or empty/whitespace-only) must fail fast, not silently
      // fall through to the node-peerId default. A caller intending a
      // cross-agent WM read with a malformed value would otherwise get the
      // node's own WM back — wrong namespace, wrong data, no error.
      // `undefined` (field genuinely absent) still takes the default.
      if (args.agent_address !== undefined) {
        if (typeof args.agent_address !== 'string') {
          return this.error('"agent_address" must be a string.');
        }
        if (args.agent_address.trim() === '') {
          return this.error('"agent_address" must be a non-empty string.');
        }
      }
      let agentAddress = typeof args.agent_address === 'string'
        ? args.agent_address.trim()
        : undefined;
      if (view === 'working-memory' && agentAddress === undefined) {
        if (this.nodePeerId === undefined) {
          await this.ensureNodePeerId().catch(() => {});
        }
        agentAddress = this.nodePeerId;
        if (agentAddress === undefined) {
          return this.error(
            '"view: working-memory" requires an agent identity. Supply `agent_address` explicitly, ' +
              "or retry once the node's agent address is available.",
          );
        }
      }
      if (view === 'working-memory' && agentAddress !== undefined) {
        agentAddress = toAgentPeerId(agentAddress);
      }
      const result = await this.client.query(sparql, {
        contextGraphId,
        view,
        agentAddress,
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

  private async handleContextGraphInvite(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      const peerId = typeof args.peer_id === 'string' ? args.peer_id.trim() : '';
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!peerId) return this.error('"peer_id" is required.');
      const [result, status] = await Promise.all([
        this.client.inviteToContextGraph(contextGraphId, peerId),
        this.client.getFullStatus().catch(() => null),
      ]);
      const multiaddrs = Array.isArray(status?.multiaddrs)
        ? status.multiaddrs.filter((value): value is string => typeof value === 'string')
        : [];
      const curatorMultiaddr = pickShareableMultiaddr(multiaddrs);
      const inviteCode = curatorMultiaddr ? `${contextGraphId}\n${curatorMultiaddr}` : contextGraphId;
      return this.json({
        ...result,
        peerId,
        curatorMultiaddr,
        inviteCode,
      });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleParticipantAdd(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      const agentAddress = typeof args.agent_address === 'string' ? args.agent_address.trim() : '';
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!agentAddress) return this.error('"agent_address" is required.');
      return this.json(await this.client.addParticipant(contextGraphId, agentAddress));
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleParticipantRemove(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      const agentAddress = typeof args.agent_address === 'string' ? args.agent_address.trim() : '';
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!agentAddress) return this.error('"agent_address" is required.');
      return this.json(await this.client.removeParticipant(contextGraphId, agentAddress));
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleParticipantList(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      return this.json(await this.client.listParticipants(contextGraphId));
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleJoinRequestList(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      return this.json(await this.client.listJoinRequests(contextGraphId));
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleJoinRequestApprove(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      const agentAddress = typeof args.agent_address === 'string' ? args.agent_address.trim() : '';
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!agentAddress) return this.error('"agent_address" is required.');
      return this.json(await this.client.approveJoinRequest(contextGraphId, agentAddress));
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleJoinRequestReject(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      const agentAddress = typeof args.agent_address === 'string' ? args.agent_address.trim() : '';
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!agentAddress) return this.error('"agent_address" is required.');
      return this.json(await this.client.rejectJoinRequest(contextGraphId, agentAddress));
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleSubscribe(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = typeof args.context_graph_id === 'string' ? args.context_graph_id.trim() : '';
      if (!contextGraphId) {
        return this.error('"context_graph_id" is required.');
      }
      // Schema declares include_shared_memory as boolean. Reject non-boolean
      // explicitly (same rationale as handleQuery): silent coercion to the
      // daemon default would make callers quietly miss SWM data they asked
      // for. `undefined` is the only non-boolean we accept — it maps to the
      // daemon's default.
      if (args.include_shared_memory !== undefined && typeof args.include_shared_memory !== 'boolean') {
        return this.error('"include_shared_memory" must be a boolean.');
      }
      const includeSharedMemory =
        args.include_shared_memory === false ? false : args.include_shared_memory === true ? true : undefined;
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

  /**
   * Env-gated diagnostic probe for registration-mode behavior.
   * Fires only when DKG_PROBE_REGISTRATION_MODE=1. Logs:
   *   - Each register() call with mode, call count, and API surface availability
   *   - Each hook dispatch with event name, registration mechanism, and mode
   */
  private runRegistrationModeProbe(api: OpenClawPluginApi): void {
    this.probeRegisterCallCount++;
    const mode = api.registrationMode ?? 'full';
    const hasOn = typeof api.on === 'function';
    const hasRegisterHook = typeof api.registerHook === 'function';
    const hasGlobalHookMap = !!(globalThis as any)[Symbol.for('openclaw.internalHookHandlers')];

    api.logger.info?.(
      '[dkg-probe] register() called: mode=' + mode + ', call#=' + this.probeRegisterCallCount + ', ' +
      'api.on=' + (hasOn ? 'function' : 'undefined') + ', api.registerHook=' + (hasRegisterHook ? 'function' : 'undefined') + ', ' +
      'globalThis-hook-map=' + (hasGlobalHookMap ? 'present' : 'absent'),
    );

    // Helper to make a probe handler factory
    const makeProbeHandler = (eventName: string, via: string) => {
      return () => {
        const key = eventName + ':' + via;
        const count = (this.probeHookFireCounts.get(key) ?? 0) + 1;
        this.probeHookFireCounts.set(key, count);
        api.logger.info?.(
          '[dkg-probe] HOOK FIRED: event=' + eventName + ' via=' + via + ' mode=' + mode + ' fire#=' + count,
        );
      };
    };

    // Typed hooks (api.on / api.registerHook) use underscore-separated names.
    const typedEvents = ['before_prompt_build', 'agent_end', 'before_compaction', 'before_reset', 'message_received', 'message_sent'];
    // Internal-hook map (globalThis symbol) uses colon-separated names per
    // openclaw/src/infra/outbound/deliver.ts — probing the underscore form
    // here would never observe the real internal dispatch path and would
    // falsely drive the Branch A / No-Go decision.
    const internalEvents = ['message:received', 'message:sent'];

    for (const eventName of typedEvents) {
      if (hasOn) {
        try {
          (api as any).on(eventName, makeProbeHandler(eventName, 'api.on'));
        } catch (err: any) {
          api.logger.debug?.(
            '[dkg-probe] api.on(' + eventName + ') threw: ' + (err?.message ?? 'unknown error'),
          );
        }
      }
      if (hasRegisterHook) {
        try {
          (api as any).registerHook(eventName, makeProbeHandler(eventName, 'api.registerHook'), { name: 'dkg-probe-' + eventName });
        } catch (err: any) {
          api.logger.debug?.(
            '[dkg-probe] api.registerHook(' + eventName + ') threw: ' + (err?.message ?? 'unknown error'),
          );
        }
      }
    }

    if (hasGlobalHookMap) {
      const hookKey = Symbol.for('openclaw.internalHookHandlers');
      const hookMap = (globalThis as any)[hookKey] as Map<string, Array<() => void>> | undefined;
      for (const eventName of internalEvents) {
        try {
          if (hookMap) {
            if (!hookMap.has(eventName)) {
              hookMap.set(eventName, []);
            }
            hookMap.get(eventName)!.push(makeProbeHandler(eventName, 'globalThis'));
          }
        } catch (err: any) {
          api.logger.debug?.(
            '[dkg-probe] globalThis-hook-map insertion for ' + eventName + ' threw: ' + (err?.message ?? 'unknown error'),
          );
        }
      }
    }

    api.logger.debug?.('[dkg-probe] Probe handlers registered for all mechanisms and events');
  }

  // ── Assertion lifecycle handlers ────────────────────────────────────────

  private async handleAssertionCreate(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      const result = await this.client.createAssertion(contextGraphId, name, { subGraphName });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleAssertionWrite(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      const rawQuads = args.quads;
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      if (!Array.isArray(rawQuads) || rawQuads.length === 0) {
        return this.error('"quads" must be a non-empty array of {subject, predicate, object} objects.');
      }
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      // Mirror dkg_publish: auto-detect URI vs literal for the object so agents can pass
      // raw values without manually wrapping string literals in quotes.
      const quads = rawQuads.map((q: any) => {
        const objVal = String(q.object ?? '');
        return {
          subject: String(q.subject ?? ''),
          predicate: String(q.predicate ?? ''),
          object: isUri(objVal) ? objVal : `"${escapeRdfLiteral(objVal)}"`,
          graph: q.graph ? String(q.graph) : '',
        };
      });
      const result = await this.client.writeAssertion(contextGraphId, name, quads, { subGraphName });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleAssertionPromote(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      // Public contract: omit `entities` → promote everything (daemon defaults `entities ?? "all"`).
      // Provided → must be a non-empty array of URIs. The previous string-"all" shortcut was dropped
      // because strict JSON-schema validators rejected it (schema says `type: 'array'`) while
      // `entities: ["all"]` would silently 400 at the daemon — a confusing no-signal failure mode.
      let entities: string[] | undefined;
      const raw = args.entities;
      if (raw === undefined || raw === null) {
        entities = undefined;
      } else if (Array.isArray(raw) && raw.length > 0 && raw.every((e) => typeof e === 'string')) {
        entities = raw.map((e) => String(e));
      } else {
        return this.error('"entities" must be omitted or a non-empty array of root entity URIs.');
      }
      const result = await this.client.promoteAssertion(contextGraphId, name, { entities, subGraphName });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleAssertionDiscard(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      const result = await this.client.discardAssertion(contextGraphId, name, { subGraphName });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleAssertionImportFile(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      const filePath = String(args.file_path ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      if (!filePath) return this.error('"file_path" is required.');
      let contentType = args.content_type ? String(args.content_type) : undefined;
      const ontologyRef = args.ontology_ref ? String(args.ontology_ref) : undefined;
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;

      // Extension-based MIME inference so agents can pass a path without thinking about
      // MIME types. Without this, the daemon receives `application/octet-stream`, finds no
      // converter for that type, and returns `extraction.status: "skipped"` with no
      // triples written — a silent-looking success. Covers the common document formats
      // the daemon has (or is likely to register) converters for. Unmatched extensions
      // fall through to octet-stream; callers can still override via `content_type`.
      if (!contentType) {
        contentType = inferContentTypeFromExtension(filePath);
      }

      let buffer: Buffer;
      let fileName: string;
      try {
        const { readFile } = await import('node:fs/promises');
        const { basename } = await import('node:path');
        buffer = await readFile(filePath);
        fileName = basename(filePath);
      } catch (err: any) {
        return this.error(`Failed to read file at "${filePath}": ${err.message ?? String(err)}`);
      }

      const result = await this.client.importAssertionFile(contextGraphId, name, buffer, fileName, {
        contentType,
        ontologyRef,
        subGraphName,
      });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleAssertionQuery(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      const result = await this.client.queryAssertion(contextGraphId, name, { subGraphName });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleAssertionHistory(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      const agentAddress = args.agent_address ? String(args.agent_address) : undefined;
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      const result = await this.client.getAssertionHistory(contextGraphId, name, { agentAddress, subGraphName });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleSubGraphCreate(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const subGraphName = String(args.sub_graph_name ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!subGraphName) return this.error('"sub_graph_name" is required.');
      const result = await this.client.createSubGraph(contextGraphId, subGraphName);
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleSubGraphList(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      const result = await this.client.listSubGraphs(contextGraphId);
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleSharedMemoryPublish(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      // Mirror handleAssertionPromote's `entities` validation shape: omit → daemon-side default
      // (selection="all"), explicit array → must be non-empty and all strings. No other values
      // allowed; a bogus scalar would silently 400 at the daemon.
      const raw = args.root_entities;
      let rootEntities: string[] | undefined;
      if (raw === undefined || raw === null) {
        rootEntities = undefined;
      } else if (Array.isArray(raw) && raw.length > 0 && raw.every((e) => typeof e === 'string')) {
        rootEntities = raw.map((e) => String(e));
      } else {
        return this.error('"root_entities" must be omitted or a non-empty array of root entity URIs.');
      }
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      const registerIfNeeded = args.register_if_needed === true;
      if (args.register_if_needed !== undefined && typeof args.register_if_needed !== 'boolean') {
        return this.error('"register_if_needed" must be a boolean.');
      }
      if (args.reveal_on_chain !== undefined && typeof args.reveal_on_chain !== 'boolean') {
        return this.error('"reveal_on_chain" must be a boolean.');
      }
      if (args.access_policy !== undefined && args.access_policy !== 0 && args.access_policy !== 1) {
        return this.error('"access_policy" must be 0 (open) or 1 (private).');
      }
      let registration: Record<string, unknown> | undefined;
      if (registerIfNeeded) {
        try {
          registration = await this.client.registerContextGraph(contextGraphId, {
            accessPolicy: args.access_policy as number | undefined,
          });
        } catch (err: any) {
          const message = err?.message ?? String(err);
          if (!message.includes('already registered')) {
            throw err;
          }
        }
      }
      const result = await this.client.publishSharedMemory(contextGraphId, { rootEntities, subGraphName });
      return this.json(registration ? { ...result, registration } : result);
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

function pickShareableMultiaddr(addrs: string[]): string | null {
  if (addrs.length === 0) return null;
  const ranked = [...addrs].sort((a, b) => scoreMultiaddr(b) - scoreMultiaddr(a));
  return ranked[0] ?? null;
}

function scoreMultiaddr(addr: string): number {
  if (addr.includes('/p2p-circuit/')) return 100;
  const ipv4 = addr.match(/\/ip4\/([^/]+)/)?.[1];
  if (!ipv4) return 50;
  if (isLoopbackIPv4(ipv4)) return 0;
  if (isPrivateIPv4(ipv4)) return 10;
  return 80;
}

function isLoopbackIPv4(ip: string): boolean {
  return ip.startsWith('127.');
}

function isPrivateIPv4(ip: string): boolean {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const second = Number.parseInt(m[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Extract user-visible text from a message's `content` field. Handles
 * both plain string and multi-modal array forms. Filters to text parts
 * only — image/tool-use parts contribute nothing to the recall query.
 */
function extractUserTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === 'text' && typeof p?.text === 'string')
      .map((p: any) => p.text)
      .join(' ')
      .trim();
  }
  return '';
}

/**
 * Format the top-N memory hits as a `<recalled-memory>` block for the
 * W3 auto-recall handler to return via `appendSystemContext`. The tag
 * shape is load-bearing for `ChatTurnWriter.stripRecalledMemory` —
 * keep in sync.
 *
 * Snippet and layer text is user/agent-authored, so both are HTML-entity
 * escaped before interpolation. A snippet containing `</recalled-memory>`
 * would otherwise terminate the wrapper early (escaping arbitrary content
 * into the prompt and bypassing the strip regex).
 */
function formatRecalledMemoryBlock(
  hits: ReadonlyArray<{ snippet: string; layer: string; score: number }>,
): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    '<recalled-memory>',
    'The snippets below were retrieved automatically from your DKG-backed memory',
    '(your agent-context graph + the active project graph, across Working Memory,',
    'Shared Working Memory, and Verified Memory). They are NOT user input — they',
    'are auto-recalled context for the current turn, ranked by trust tier:',
    'verified-memory > shared-working-memory > working-memory. The `layer` tag',
    'tells you which tier the snippet came from. Use them as background; if you',
    'need more, call the `memory_search` tool for a wider recall (default 20 hits).',
    ...hits.map(
      (h, i) => `  [${i + 1}] (${escape(h.layer)}, score=${h.score.toFixed(2)}) ${escape(h.snippet)}`,
    ),
    '</recalled-memory>',
  ];
  return lines.join('\n');
}

/**
 * Escape a plain-text string for use as an RDF/N-Triples literal body.
 * Covers every ECHAR escape the N-Triples spec defines (\\, ", \n, \r, \t,
 * \b, \f); returns only the escaped body (caller wraps in `"..."`).
 * Without these, agents writing strings that happen to contain a raw
 * form-feed, backspace, or tab would produce malformed RDF literals that
 * strict triple-store parsers reject.
 * Backslash MUST be replaced first so the later inserted escape sequences
 * don't get re-escaped on subsequent passes.
 */
function escapeRdfLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\x08/g, '\\b');
}

/**
 * Infer the MIME type from a file path's extension. Covers the common document
 * formats the daemon's import-file pipeline has (or is likely to register)
 * converters for. Returns `undefined` for anything else — callers should fall
 * through to `application/octet-stream` in that case, which the daemon accepts
 * and degrades to `extraction.status: "skipped"`.
 *
 * Mirrors the extension → MIME lookup in `packages/node-ui/src/ui/api.ts`
 * (`detectContentType`), which the UI uses for the same reason.
 */
/**
 * Extension → MIME lookup used by `handleAssertionImportFile`. Kept in sync
 * with `UPLOAD_CONTENT_TYPES` in `packages/cli/src/api-client.ts` so agents
 * uploading via the tool surface and users uploading via the CLI see the same
 * detected content type for a given filename. `adapter-openclaw` can't import
 * from `@origintrail-official/dkg` directly (circular workspace dep), so we
 * mirror the table here until a shared upload module lives in `dkg-core`.
 * Update both tables together when adding a new format.
 */
const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.epub': 'application/epub+zip',
};

function inferContentTypeFromExtension(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  for (const [ext, ct] of Object.entries(UPLOAD_CONTENT_TYPES)) {
    if (lower.endsWith(ext)) return ct;
  }
  return undefined;
}
