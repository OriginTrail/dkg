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
 *     (`POST /api/knowledge-assets` + `POST /api/knowledge-assets/:name/wm/write`),
 *     which the agent reads from `GET /.well-known/skill.md` on startup.
 */
import {
  GET_VIEWS,
  type GetView,
  createDkgPublisherExtension,
  type DkgPublisherExtension,
  escapeDkgRdfLiteral,
  normalizeDkgPublisherQuads,
  resolveDkgHome,
  toEip55Checksum,
  validateAssertionName,
} from '@origintrail-official/dkg-core';
import {
  DkgDaemonClient,
  DkgDaemonHttpError,
  normalizeContextGraphId,
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
import { join } from 'node:path';
import {
  canonicalPathForCompare,
  defaultStateDirForWorkspace,
  legacyStateDirForWorkspace,
  workspaceDirForDefaultStateDir,
  type ChatTurnWriterStateLayout,
} from './state-dir-path.js';
import { mergeAdapterPluginConfigs } from './openclaw-config.js';

import {
  CONTEXT_GRAPH_QUERY_SUBGRAPH,
  USER_QUERY_CATALOG_SLUG,
  USER_QUERY_CATALOG_NAME,
  USER_QUERY_CATALOG_DESCRIPTION,
  buildQueryCatalogSaveWrite,
  filterContextGraphsForScope,
  normalizeQueryCatalogItems,
  normalizeSemanticEnrichmentQuads,
  optionalString,
  queryCatalogSlug,
  readOnlySparqlOperation,
} from './dkg-node-plugin-query-catalog.js';
import {
  channelConfigFingerprint,
  extractUserTextFromContent,
  formatRecalledMemoryBlock,
  inferContentTypeFromExtension,
  isValidEthAddressString,
  pickShareableMultiaddr,
  slugify,
} from './dkg-node-plugin-helpers.js';
import {
  AUTO_RECALL_QUERY_MAX_CHARS,
  AVAILABLE_CONTEXT_GRAPH_CACHE_TTL_MS,
  DEFAULT_DAEMON_URL,
  LOCAL_AGENT_STATE_RETRY_BASE_DELAY_MS,
  LOCAL_AGENT_STATE_RETRY_MAX_DELAY_MS,
  NODE_PEER_ID_DEFERRED_RETRY_DELAY_MS,
  OPENCLAW_LOCAL_AGENT_CAPABILITIES,
  OPENCLAW_LOCAL_AGENT_MANIFEST,
  STATE_DIR_SOURCE_PRIORITY,
  type ChatTurnWriterStateDirSource,
} from './dkg-node-plugin-constants.js';
import type { DkgToolHost } from './tools/tool-host.js';
import { buildNodeTools } from './tools/node-tools.js';
import { buildContextGraphTools } from './tools/context-graph-tools.js';
import { buildQueryTools } from './tools/query-tools.js';
import { rawFindAgentsQuery,  buildMessagingTools } from './tools/messaging-tools.js';
import { buildAssertionTools } from './tools/assertion-tools.js';
import { buildMemoryTools } from './tools/memory-tools.js';

// #1116 share-outcome warnings. These three constants + classifyShareWarning are
// duplicated byte-identical across the MCP, OpenClaw, and Hermes adapters. There
// is intentionally NO shared runtime module: MCP has no dkg-core dependency
// (dependency-light by design) and OpenClaw cannot import from dkg-mcp, so the
// only "shared home" would be a new package (out of scope). Drift is caught by a
// TEST: this adapter's suite asserts these values are byte-identical to the
// canonical fixture at `tests/fixtures/share-seal-warnings.json`. Update the
// fixture + all three adapters together; the parity tests flag any mismatch.

// Defensive mixed-version warning for a non-ready atomic share.
export const SHARE_NOT_PUBLISH_READY_WARNING =
  'The atomic SWM share did not become publish-ready (sealed:false). Keep the ' +
  'Working Memory draft and retry the complete Knowledge Asset share; do not publish it.';

// Defensive mixed-version classification for a legacy partial-share outcome.
export const SHARE_SUBSET_NOT_PUBLISH_READY_WARNING =
  'A legacy partial-share outcome was reported. Root-scoped subsets are read-only ' +
  'and not publishable; model the intended data as its own Knowledge Asset and share it atomically.';

// A sealed atomic share can still report incomplete delivery; retry from WM.
export const SHARE_INCOMPLETE_PROMOTE_WARNING =
  'The complete sealed Knowledge Asset did not reach SWM and is not publish-ready; ' +
  'keep the Working Memory draft and retry the atomic share.';

export const ATOMIC_SHARE_SIGNING_RECOVERY =
  'Resolve the local signing capability, then retry the complete atomic ' +
  'Knowledge Asset share from Working Memory.';

/**
 * #1116: pick the not-publish-ready share warning from the share outcome. Returns
 * `undefined` when the share IS publish-ready (no warning). Precedence:
 *  1. sealed:true + publishReady:false → incomplete atomic delivery.
 *  2. sealed:false + legacy subset response → legacy read-only warning.
 *  3. sealed:false + atomic response → retry the complete share from WM.
 * Duplicated byte-identical on MCP (TS) + Hermes (Python).
 */
export function classifyShareWarning(outcome: {
  sealed?: boolean;
  publishReady?: boolean;
  isSubset: boolean;
}): string | undefined {
  if (outcome.publishReady !== false) return undefined;
  if (outcome.sealed === true) return SHARE_INCOMPLETE_PROMOTE_WARNING;
  if (outcome.isSubset) return SHARE_SUBSET_NOT_PUBLISH_READY_WARNING;
  return SHARE_NOT_PUBLISH_READY_WARNING;
}

/**
 * #1116: normalize a 409 UNSEALED_SHARE_BLOCKED share failure to the
 * supported atomic recovery. The DkgDaemonClient throws a typed {@link DkgDaemonHttpError}
 * carrying the response `status` and parsed JSON `body`, so branch structurally
 * on the status + body code (no JSON-from-message parsing). Returns undefined
 * for any other error (caller falls back to the generic daemonError).
 */
function extractUnsealedShareRecovery(err: unknown): string | undefined {
  if (
    err instanceof DkgDaemonHttpError &&
    err.status === 409 &&
    typeof err.body === 'object' &&
    err.body !== null
  ) {
    const body = err.body as { code?: string };
    if (body.code === 'UNSEALED_SHARE_BLOCKED') {
      return ATOMIC_SHARE_SIGNING_RECOVERY;
    }
  }
  return undefined;
}

export class DkgNodePlugin {
  private config: DkgOpenClawConfig;

  // Resolved DKG home directory. Computed once at register() time via
  // `resolveDkgHome` so DkgDaemonClient reads the node-level `auth.token`
  // from the same home directory the running daemon selected.
  private dkgHome!: string;

  // HTTP client to daemon — used by all tools and integration modules
  private client!: DkgDaemonClient;
  private daemonClientGeneration = 0;
  private publisher!: DkgPublisherExtension;

  // Integration modules
  private channelPlugin: DkgChannelPlugin | null = null;
  private channelPluginConfigFingerprint: string | null = null;
  private channelPluginStopInFlight: Promise<boolean> | null = null;
  private channelPluginStartQueued = false;
  private pendingChannelStartApi: OpenClawPluginApi | null = null;
  private pendingChannelStartRegistrationMode: string | null = null;
  private pendingChannelStartFingerprint: string | null = null;
  private memoryPlugin: DkgMemoryPlugin | null = null;
  private hookSurface: HookSurface | null = null;
  private hookSurfaceApi: OpenClawPluginApi | null = null;
  /**
   * T31 — Every HookSurface this plugin has built across its lifetime,
   * keyed only by insertion (Set, not WeakSet — explicit `stop()` is
   * the lifecycle anchor). Multi-phase init can hand the plugin a new
   * `api` registry on every inbound turn (`Re-registering plugin
   * surfaces … into new registry` in operator logs); the gateway then
   * dispatches `before_prompt_build` against whichever registry it
   * decides to use, which is not necessarily the latest one we hold.
   * Destroying the old surface on `apiChanged` (the previous behavior)
   * orphaned all handlers bound to the prior api — `fireCount=0` even
   * after multiple chats. Now we keep every surface live so whichever
   * api the gateway emits against has a bound handler; `stop()`
   * destroys them all together.
   */
  private allHookSurfaces: Set<HookSurface> = new Set();
  /**
   * T34 — Install timestamp per surface. Used by `evictStaleHookSurfaces`
   * to bound the surface set's growth in long-lived processes that get
   * many `apiChanged` re-registrations: surfaces that have lived past a
   * grace window without firing are presumed orphaned by the gateway and
   * are destroyed + dropped. The latest surface (`this.hookSurface`) is
   * always preserved regardless of age. WeakMap so a destroyed surface
   * that escapes our explicit `delete` can still be GC'd via natural
   * reachability rules.
   */
  private hookSurfaceInstalledAt: WeakMap<HookSurface, number> = new WeakMap();
  private typedHookFireSeq = 0;
  private typedHookFireGeneration: Map<string, number> = new Map();
  /**
   * Grace window before a never-fired surface becomes evictable. Long
   * enough that a slow gateway dispatch path doesn't trigger spurious
   * eviction (typed `before_prompt_build` typically fires within seconds
   * of register; 5 minutes is a 60×+ safety margin), short enough that
   * a process re-registered hundreds of times still bounds the set's
   * memory footprint within an hour.
   */
  private static readonly HOOK_SURFACE_STALE_THRESHOLD_MS = 5 * 60_000;
  // T11 — Idempotency flag for `registerMemoryPromptSection`. The first
  // register() call under setup-runtime skips the install (`isFullMode`
  // is false); on a same-api `setup-runtime → full` upgrade the retry
  // branch must install it then. Without this flag a `full → full`
  // re-register would double-install the prompt section.
  // T12 — Lifecycle of the flag is tied to the api object: the prompt
  // section is registered against a specific `api` registry, so on an
  // api swap (apiChanged in `installHooksIfNeeded`) or a `stop() ->
  // register()` cycle the flag must be reset so the new gateway
  // instance gets the section installed too.
  private promptSectionInstalled = false;
  // T13 — Single-flight guard for W3 `before_prompt_build` auto-recall.
  // Keyed by `sessionKey`. The 250ms `Promise.race` timeout below stops
  // *waiting* for the SPARQL fan-out, but doesn't cancel it — without
  // backpressure a slow daemon would accumulate overlapping background
  // queries every turn and amplify its own load. While a recall is
  // in flight for a session, subsequent `before_prompt_build` fires
  // for that session skip the recall (return undefined). The set
  // entry is cleared when the underlying `searchNarrow()` actually
  // settles (success OR error), not when the timeout fires.
  // Plan N4 will additionally thread an AbortSignal through
  // `client.query()` so the daemon-side queries can be cancelled.
  private autoRecallInFlight: Set<string> = new Set();
  private chatTurnWriter: ChatTurnWriter | null = null;
  // T18 — Track the resolved stateDir so a later register() can detect
  // when a better (workspace-scoped) path becomes available and rebuild
  // the writer at the upgraded location.
  private chatTurnWriterStateDir: string | null = null;
  private chatTurnWriterStateDirSource: ChatTurnWriterStateDirSource | null = null;
  private chatTurnWriterStateLayout: ChatTurnWriterStateLayout | null = null;
  // T24 — Tracks the target stateDir of an in-flight async migration.
  // The migration is fire-and-forget from `register()` so we need a
  // separate flag from `chatTurnWriterStateDir` (which only flips on
  // SUCCESS) to suppress re-trigger on concurrent register() calls.
  // Cleared on success or failure of the migration's `setStateDir`
  // promise. If the migration fails, `chatTurnWriterStateDir` stays
  // at the old value, so a future register() can retry.
  private chatTurnWriterMigrationTarget: string | null = null;
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
  /**
   * Serial promise chain for local-agent integration HTTP mutations.
   * T364 round 13 — pre-fix `clearLocalAgentChannelIntegration` and
   * `syncLocalAgentIntegrationState` both guarded `channel.enabled` /
   * `daemonClientGeneration` only BEFORE their HTTP write, so a config
   * flip while either request was awaiting the daemon could leave the
   * daemon record in the wrong state: an older
   * `connectLocalAgentIntegration({ enabled: true })` resolving AFTER
   * a newer disable write would re-enable the integration even though
   * the channel was already off. Serializing every integration write
   * onto a single chain ensures only one HTTP mutation is in flight
   * at a time, and each operation re-checks generation + channel state
   * inside the serialized step (so the latest config wins regardless
   * of write ordering on the wire).
   */
  private localAgentIntegrationWriteChain: Promise<void> = Promise.resolve();
  private nodePeerId: string | undefined;
  /**
   * In-flight handle for the node peer ID probe, used to debounce
   * concurrent `ensureNodePeerId` calls so multiple resolver fires do not
   * stampede `/api/status`. Null when no probe is running. Codex Bug B9.
   */
  private peerIdProbeInFlight: Promise<void> | null = null;
  /**
   * Node agent address returned by `/api/agent/identity`. The daemon resolves
   * the adapter's node-level Bearer token to its default agent address, which
   * is the WM namespace used by default-agent assertion writes.
   */
  private nodeAgentAddress: string | undefined;
  /**
   * Debounces concurrent `ensureNodeAgentAddress` calls so a burst of
   * resolver fires collapses to one daemon identity probe. Mirrors the
   * `peerIdProbeInFlight` pattern. Null when no probe is running.
   */
  private agentAddressProbeInFlight: Promise<void> | null = null;
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
      // Resolve the daemon's default WM identity lazily. Until the identity
      // probe lands, `resolveDefaultAgentAddress` keeps the historical peerId
      // fallback so callers can still make progress during startup.
      if (this.nodeAgentAddress === undefined) {
        void this.ensureNodeAgentAddress();
      }
      return {
        projectContextGraphId,
        // Mirror the daemon's writer-side priority:
        // default agent address when known, otherwise the node peerId.
        agentAddress: this.resolveDefaultAgentAddress(),
      };
    },
    getDefaultAgentAddress: () => {
      if (this.nodeAgentAddress === undefined) {
        void this.ensureNodeAgentAddress();
      }
      return this.resolveDefaultAgentAddress();
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

  updateConfig(config?: DkgOpenClawConfig, options: { partial?: boolean } = {}): void {
    if (!config || typeof config !== 'object') return;
    const previousConfig = this.config;
    this.config = options.partial
      ? mergeAdapterPluginConfigs(
        this.config as unknown as Record<string, unknown>,
        config as unknown as Record<string, unknown>,
      ) as unknown as DkgOpenClawConfig
      : { ...config };
    this.refreshDaemonClientForConfigUpdate(previousConfig);
  }

  private resolveDaemonClientOptions(config: DkgOpenClawConfig): { daemonUrl: string; dkgHome: string } {
    const daemonUrl = config.daemonUrl ?? DEFAULT_DAEMON_URL;
    return {
      daemonUrl,
      dkgHome: config.dkgHome ?? resolveDkgHome({ daemonUrl }),
    };
  }

  private refreshDaemonClientForConfigUpdate(previousConfig: DkgOpenClawConfig): void {
    if (!this.initialized) return;
    const previous = this.resolveDaemonClientOptions(previousConfig);
    const next = this.resolveDaemonClientOptions(this.config);
    if (previous.daemonUrl === next.daemonUrl && previous.dkgHome === next.dkgHome) return;

    this.daemonClientGeneration += 1;
    this.resetDaemonScopedCachesForClientChange();
    this.dkgHome = next.dkgHome;
    this.client = new DkgDaemonClient({ baseUrl: next.daemonUrl, dkgHome: next.dkgHome });
    this.publisher = createDkgPublisherExtension(this.client);
    this.chatTurnWriter?.setClient(this.client);
    this.channelPlugin?.setClient(this.client);
    this.memoryPlugin?.setClient(this.client, { reRegister: this.config.memory?.enabled === true });
  }

  private resetDaemonScopedCachesForClientChange(): void {
    this.nodePeerId = undefined;
    this.peerIdProbeInFlight = null;
    this.nodeAgentAddress = undefined;
    this.agentAddressProbeInFlight = null;
    this.availableContextGraphCache = [];
    this.availableContextGraphCacheAt = 0;
    this.refreshStateInFlight = null;
    if (this.peerIdDeferredRetryTimer) {
      clearTimeout(this.peerIdDeferredRetryTimer);
      this.peerIdDeferredRetryTimer = null;
    }
    this.clearLocalAgentIntegrationRetry();
    this.localAgentIntegrationRetryAttempt = 0;
    this.lastLocalAgentIntegrationWarnReason = null;
    this.lastLocalAgentIntegrationLoadError = null;
    // T364 round 13 — reset the serial integration write chain so a
    // brand-new client generation isn't artificially blocked behind
    // an orphaned in-flight write from the previous client. Orphaned
    // writes themselves are no-ops (each serialized step re-checks
    // generation), but freeing the chain lets the next operation run
    // immediately instead of waiting for the prior fetch to settle.
    this.localAgentIntegrationWriteChain = Promise.resolve();
  }

  /**
   * T364 round 13 — chain `work` onto the serial integration write
   * pipeline. Each operation runs after the previous one settles
   * (success or failure) and re-checks generation + channel state
   * inside its own body, so an older enable that was queued before a
   * disable cannot resolve after the disable's HTTP write and re-flip
   * the daemon record.
   */
  private serializeLocalAgentIntegrationWrite(work: () => Promise<void>): Promise<void> {
    const next = this.localAgentIntegrationWriteChain
      // Don't propagate a prior write's rejection to the next op;
      // each work() handles its own errors.
      .catch(() => undefined)
      .then(() => work());
    this.localAgentIntegrationWriteChain = next;
    return next;
  }

  /** Whether the base runtime (daemon client, lifecycle hooks) has been initialized. */
  private initialized = false;
  /**
   * Counter for registration-mode probe diagnostics. Incremented on each
   * register() call when DKG_PROBE_REGISTRATION_MODE=1 for sequencing logs.
   */
  private probeRegisterCallCount = 0;
  // Track which (api, mechanism, event) tuples have already had probe
  // handlers installed. Per-mechanism granularity is load-bearing: same-
  // object setup-runtime → full upgrades flip `api.on` from `undefined`
  // to a function on the second call, and a per-api-only gate would
  // miss the typed-hook surface that became available post-upgrade
  // (T25 regression fix). The api registries themselves are still
  // referenced by WeakMap keys so map entries collect when the gateway
  // tears down an api. Per-event Sets inside each entry let us install
  // only the mechanism+event tuples not already bound on this api.
  private probeApiInstalls = new WeakMap<OpenClawPluginApi, { typed: Set<string>; hooks: Set<string> }>();
  // R15.4 — Track which internal events have already had a probe handler
  // pushed into the process-global `globalThis.openclaw.internalHookHandlers`
  // map. The map outlives any individual `api` registry, so the per-`api`
  // WeakSet above doesn't prevent duplicate probe handlers across multi-
  // phase init (setup-runtime → full upgrade). Without per-event tracking,
  // each internal fire would log twice and the diagnostic counts would drift.
  private probeInternalEventsInstalled = new Set<string>();
  // R21.3 — Mutable ref to the most-recent register() call's api and
  // registration mode. Probe handlers (installed once per event into the
  // process-global hook map) read from this on each fire, so a
  // `setup-runtime → full` upgrade correctly logs the new mode + new
  // logger AT THE TIME of the fire instead of staying frozen on the
  // closure captured at first-install time.
  private probeCurrent: { api: OpenClawPluginApi; mode: string } | null = null;
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
      if (runtimeEnabled) {
        // Retry typed-hook installs if the first register() call used a
        // setup-runtime api where api.on was undefined. HookSurface records
        // those as installedVia='none' with installError set; we detect
        // that and re-install against the current (possibly full-mode)
        // api.
        //
        // R17.2 follow-up — `setup-only → full` re-entry: the first call
        // skipped `ChatTurnWriter` construction (no FS work in metadata-
        // only mode), so we MUST construct it now before installing
        // hooks. Without this, `installHooksIfNeeded` early-returns on
        // null `chatTurnWriter` and W3/W4a/W4b silently never install.
        this.ensureChatTurnWriter(api);
      }
      this.registerIntegrationModules(api, { enableFullRuntime: runtimeEnabled, registrationMode });
      if (runtimeEnabled) {
        this.registerLocalAgentIntegration(api, registrationMode);
      }
      // T52 — Always run installHooksIfNeeded so the legacy
      // `session_end` cleanup is wired even in setup-only re-entry.
      // The runtime flag gates the W3/W4a/W4b installs below the
      // surface build inside the helper.
      this.installHooksIfNeeded(api, { runtimeHooksEnabled: runtimeEnabled });
      return;
    }

    // Create daemon client — used by all tools and integration modules
    const daemonUrl = this.config.daemonUrl ?? DEFAULT_DAEMON_URL;

    // Resolve the DKG home directory once for this plugin's lifetime so the
    // client loads the same node-level auth.token the running daemon uses.
    // `config.dkgHome` remains an explicit auth-token home override for
    // custom `dkg start --home` deployments; it is no longer used for
    // agent-keystore identity probing.
    this.dkgHome = this.config.dkgHome ?? resolveDkgHome({ daemonUrl });

    // Pass the resolved home to the client so its `auth.token` fallback
    // reads from the right dir. Pre-loading `apiToken` here would not be
    // sufficient: an absent `auth.token` in the resolved home would yield
    // `apiToken: undefined`, and the constructor's `?? loadTokenFromFile()`
    // default would silently fall back to `~/.dkg/auth.token` — picking
    // up a stale npm-side token while the live daemon is at `~/.dkg-dev`
    // (the very bug T70 set out to fix). Threading `dkgHome` through
    // `DkgClientOptions` plugs that hole.
    this.client = new DkgDaemonClient({ baseUrl: daemonUrl, dkgHome: this.dkgHome });
    this.publisher = createDkgPublisherExtension(this.client);
    this.initialized = true;
    // R17.2 — Defer `ChatTurnWriter` construction to runtime-enabled
    // modes. The constructor calls `mkdirSync` + reads the watermark
    // file via `initFromFile`; doing that at `setup-only` load
    // time is filesystem work in what should be a side-effect-free
    // metadata scan (and can warn/throw against read-only workspaces).
    // Idempotent helper — the re-entry branch above also calls it for
    // the `setup-only → full` upgrade case.
    if (runtimeEnabled) {
      this.ensureChatTurnWriter(api);
    }
    // T52 — Always install hooks (with the runtime flag gating
    // W3/W4a/W4b inside). `setup-only` mode still gets `session_end`
    // wired so the channel bridge's HTTP server (registered below by
    // `registerIntegrationModules` whenever `channel.enabled`) has a
    // shutdown path. The R14.3 invariant — setup-only must not wire
    // prompt-injection / turn-persistence — is preserved by the
    // `runtimeHooksEnabled: false` flag short-circuiting the W3/W4
    // installs inside `installHooksIfNeeded`.
    this.installHooksIfNeeded(api, { runtimeHooksEnabled: runtimeEnabled });

    // --- Integration modules ---
    this.registerIntegrationModules(api, { enableFullRuntime: runtimeEnabled, registrationMode });

    if (runtimeEnabled) {
      this.registerLocalAgentIntegration(api, registrationMode);
    }
  }

  /**
   * Idempotent constructor for `ChatTurnWriter`. Resolves the per-workspace
   * `stateDir` (R16.2) and creates the writer if it doesn't exist yet.
   * Called from BOTH:
   *   - First-time path inside the `runtimeEnabled` branch.
   *   - Re-entry path before `installHooksIfNeeded`, to cover the
   *     `setup-only → full` upgrade where the first call skipped
   *     construction (R17.2 + qa-engineer follow-up).
   *
   * T18 — Re-resolves stateDir on every call. If the writer was
   * previously constructed with the home-dir fallback because no
   * better path was available (typically during early
   * `setup-runtime` when `runtime.state.resolveStateDir()` /
   * `api.workspaceDir` haven't been wired yet), and a better path
   * is now available, rebuild the writer at the new location and
   * best-effort migrate the watermark file. Without this, the
   * fallback path is permanent and a later workspace-scoped resolve
   * never takes effect.
   */
  private ensureChatTurnWriter(api: OpenClawPluginApi): void {
    if (!this.client) return;
    // R16.2 — Watermark file MUST live in a per-workspace location.
    // `ChatTurnWriter` persists session watermarks across restarts; if two
    // workspaces on the same machine share `~/.openclaw/dkg-adapter/chat-turn-watermarks.json`,
    // one workspace can skip/backfill turns based on the other's session
    // state. Fall back order:
    //   1. `runtime.state.resolveStateDir()` — gateway-provided, workspace-scoped.
    //   2. `OPENCLAW_STATE_DIR` env override — operator-controlled, opt-in.
    //   3. explicit `config.stateDir` — user-controlled config override.
    //   4. `api.workspaceDir + .dkg-adapter` — gateway-provided current workspace.
    //   5. setup-owned `config.stateDir` — fallback for older gateways.
    //   6. `~/.openclaw` — last resort; logged as a warning so ops can fix.
    const workspaceDir = (api as any)?.workspaceDir;
    const homeDir = join(homedir(), '.openclaw');
    // T26 — Normalize each source through trim+non-empty before the
    // `??` chain. Pre-fix `??` treated empty string as a real value,
    // so an accidentally-empty `OPENCLAW_STATE_DIR=''` (or whitespace-
    // only, or an empty return from `resolveStateDir()`) would
    // short-circuit the chain and leave `ChatTurnWriter` reading
    // `./dkg-adapter/chat-turn-watermarks.json` from the process CWD —
    // a hard-to-diagnose state leak across workspaces.
    const trimmedNonEmpty = (s: unknown): string | undefined => {
      if (typeof s !== 'string') return undefined;
      const t = s.trim();
      return t.length > 0 ? t : undefined;
    };
    const trimmedWorkspaceDir = trimmedNonEmpty(workspaceDir);
    const configuredStateDir = trimmedNonEmpty(this.config.stateDir);
    const configuredStateDirSource = trimmedNonEmpty(this.config.stateDirSource);
    const configuredHasSetupDefaultSource = configuredStateDirSource === 'setup-default';
    const setupWorkspaceDir = trimmedNonEmpty(this.config.installedWorkspace);
    const setupDefaultStateDir = setupWorkspaceDir ? defaultStateDirForWorkspace(setupWorkspaceDir) : undefined;
    const legacySetupDefaultStateDir = setupWorkspaceDir ? legacyStateDirForWorkspace(setupWorkspaceDir) : undefined;
    const matchesPath = (a: string | undefined, b: string | undefined): boolean =>
      !!a && !!b && canonicalPathForCompare(a) === canonicalPathForCompare(b);
    const configuredDefaultWorkspaceDir =
      configuredStateDir ? workspaceDirForDefaultStateDir(configuredStateDir) : undefined;
    const configuredIsSetupDefault =
      configuredHasSetupDefaultSource &&
      !!configuredStateDir &&
      (
        matchesPath(configuredStateDir, setupDefaultStateDir) ||
        matchesPath(configuredStateDir, legacySetupDefaultStateDir) ||
        (!setupWorkspaceDir && !!configuredDefaultWorkspaceDir)
      );
    const workspaceStateDir = trimmedWorkspaceDir ? defaultStateDirForWorkspace(trimmedWorkspaceDir) : undefined;
    const runtimeStateDirRaw = trimmedNonEmpty((api as any)?.runtime?.state?.resolveStateDir?.());
    // T29 — Some OpenClaw gateway versions (observed on 2026.4.15)
    // expose the gateway's own `~/.openclaw` config root via
    // `runtime.state.resolveStateDir()`. That value is NOT workspace-
    // scoped despite the API contract — trusting it would write
    // per-workspace adapter state into the shared gateway home and
    // conflate every workspace's chat-turn watermarks. Reject the
    // value when it canonicalizes to the gateway homedir root and
    // fall through to the workspace-derived branches that ARE
    // workspace-scoped. Operators can still pin a custom state dir
    // explicitly via `OPENCLAW_STATE_DIR` (envStateDir) or
    // `config.stateDir` — those branches are not filtered.
    const runtimeStateDir = (runtimeStateDirRaw &&
      canonicalPathForCompare(runtimeStateDirRaw) !== canonicalPathForCompare(homeDir))
      ? runtimeStateDirRaw
      : undefined;
    if (runtimeStateDirRaw && !runtimeStateDir) {
      api.logger.debug?.(
        `[dkg] Ignoring runtime.state.resolveStateDir()='${runtimeStateDirRaw}' — ` +
        `it is the gateway homedir root, not a workspace-scoped state dir. ` +
        `Falling through to workspace / setup-default resolution.`,
      );
    }
    const runtimeWorkspaceDir = runtimeStateDir ? workspaceDirForDefaultStateDir(runtimeStateDir) : undefined;
    const envStateDir = trimmedNonEmpty(process.env.OPENCLAW_STATE_DIR);
    const envWorkspaceDir = envStateDir ? workspaceDirForDefaultStateDir(envStateDir) : undefined;
    const configuredSetupWorkspaceDir =
      configuredIsSetupDefault ? setupWorkspaceDir ?? configuredDefaultWorkspaceDir : undefined;
    let stateDir = homeDir;
    let stateDirSource: ChatTurnWriterStateDirSource = 'home';
    if (runtimeStateDir) {
      stateDir = runtimeStateDir;
      stateDirSource = 'runtime';
    } else if (envStateDir) {
      stateDir = envStateDir;
      stateDirSource = 'env';
    } else if (!configuredHasSetupDefaultSource && configuredStateDir) {
      stateDir = configuredStateDir;
      stateDirSource = 'config';
    } else if (workspaceStateDir) {
      stateDir = workspaceStateDir;
      stateDirSource = 'workspace';
    } else if (configuredIsSetupDefault && setupDefaultStateDir) {
      stateDir = setupDefaultStateDir;
      stateDirSource = 'setup-default';
    } else if (!configuredStateDir && configuredHasSetupDefaultSource && setupDefaultStateDir) {
      stateDir = setupDefaultStateDir;
      stateDirSource = 'setup-default';
    } else if (configuredStateDir) {
      stateDir = configuredStateDir;
      stateDirSource = configuredIsSetupDefault ? 'setup-default' : 'config';
    }

    const workspaceDerivedStateDirs =
      stateDirSource === 'config' || stateDirSource === 'home'
        ? []
        : [
          runtimeWorkspaceDir ? defaultStateDirForWorkspace(runtimeWorkspaceDir) : undefined,
          envWorkspaceDir ? defaultStateDirForWorkspace(envWorkspaceDir) : undefined,
          configuredSetupWorkspaceDir ? defaultStateDirForWorkspace(configuredSetupWorkspaceDir) : undefined,
          workspaceStateDir,
          setupDefaultStateDir,
        ].filter((candidate): candidate is string => !!candidate);
    const stateDirIsKnownWorkspaceDefault = workspaceDerivedStateDirs.some((candidate) =>
      matchesPath(stateDir, candidate),
    );
    const stateLayout: ChatTurnWriterStateLayout =
      stateDirIsKnownWorkspaceDefault ? 'direct' : 'nested';
    const legacyStateDirs = (
      stateDirSource === 'config' || stateDirSource === 'home'
        ? []
        : [
          runtimeWorkspaceDir,
          envWorkspaceDir,
          configuredSetupWorkspaceDir,
          trimmedWorkspaceDir,
          setupWorkspaceDir,
        ]
    )
      .filter((candidate): candidate is string => !!candidate)
      .filter((candidate) => matchesPath(stateDir, defaultStateDirForWorkspace(candidate)))
      .map((candidate) => legacyStateDirForWorkspace(candidate))
      .filter((candidate, index, all) =>
        all.findIndex((other) => matchesPath(other, candidate)) === index,
      );

    const inferCurrentStateDirSource = (currentStateDir: string): ChatTurnWriterStateDirSource => {
      const current = canonicalPathForCompare(currentStateDir);
      const matches = (candidate: string | undefined): boolean =>
        !!candidate && current === canonicalPathForCompare(candidate);
      if (matches(runtimeStateDir)) return 'runtime';
      if (matches(envStateDir)) return 'env';
      if (matches(setupDefaultStateDir)) return 'setup-default';
      if (matches(configuredStateDir)) return configuredHasSetupDefaultSource ? 'setup-default' : 'config';
      if (matches(workspaceStateDir)) return 'workspace';
      if (current === canonicalPathForCompare(homeDir)) return 'home';
      return 'config';
    };
    const canMigrateWithinSource = (source: ChatTurnWriterStateDirSource): boolean =>
      source === 'runtime' || source === 'env' || source === 'workspace' || source === 'setup-default';
    const stateDirSourceLabel = (source: ChatTurnWriterStateDirSource, currentStateDir: string): string => {
      if (source === 'home') return `fallback '${homeDir}'`;
      if (source === 'setup-default') return `setup-owned '${currentStateDir}'`;
      return `${source} '${currentStateDir}'`;
    };

    if (this.chatTurnWriter) {
      // T18 — Already constructed. If a better stateDir is now
      // available, in-place migrate the writer to the new location.
      // Migrate only when the newly resolved source outranks the source that
      // created the writer, or when the same dynamic source changed value.
      // Same-path is a no-op, with canonical comparison covering symlink
      // aliases.
      const currentStateDir = this.chatTurnWriterStateDir;
      if (!currentStateDir) return;
      const currentCanonicalStateDir = canonicalPathForCompare(currentStateDir);
      const nextCanonicalStateDir = canonicalPathForCompare(stateDir);
      const currentStateLayout = this.chatTurnWriterStateLayout ?? 'nested';
      const sameStateFile =
        currentCanonicalStateDir === nextCanonicalStateDir &&
        currentStateLayout === stateLayout;
      if (sameStateFile) return;
      // T24 — Suppress re-trigger when an async migration to this
      // exact stateDir is already in flight. Without this, two
      // concurrent register() calls before the migration settles
      // would launch two `setStateDir` promises racing on the same
      // writer state.
      if (
        this.chatTurnWriterMigrationTarget &&
        canonicalPathForCompare(this.chatTurnWriterMigrationTarget) === nextCanonicalStateDir
      ) return;
      const currentStateDirSource =
        this.chatTurnWriterStateDirSource ?? inferCurrentStateDirSource(currentStateDir);
      const isSameDirLayoutMigration =
        currentCanonicalStateDir === nextCanonicalStateDir &&
        currentStateLayout !== stateLayout &&
        stateDirSource !== 'home';
      const isUpgrade =
        isSameDirLayoutMigration ||
        ((
          STATE_DIR_SOURCE_PRIORITY[stateDirSource] < STATE_DIR_SOURCE_PRIORITY[currentStateDirSource] ||
          (
            stateDirSource === currentStateDirSource &&
            canMigrateWithinSource(stateDirSource)
          )
        ) &&
        stateDirSource !== 'home');
      if (!isUpgrade) return; // Don't downgrade or sidestep.
      const sourceLabel = stateDirSourceLabel(currentStateDirSource, currentStateDir);
      api.logger.info?.(
        `[dkg] Migrating ChatTurnWriter stateDir from ${sourceLabel} to '${stateDir}'.`,
      );
      // T21/T22 — `setStateDir` is async: it `await flush()`s
      // in-flight persists/resets/chains BEFORE swapping paths
      // (T21 regression fix — pre-fix the rebuild used `flushSync()`
      // and lost in-flight `storeChatTurn` work), and it MERGES
      // destination state per-session via max(w)/max(b) instead of
      // overwriting (T22 regression fix — pre-fix the migration
      // unconditionally copied, which rolled back newer workspace
      // state from a prior run). Fire-and-forget — register() must
      // remain side-effect-safe to gateway init, so we cannot await.
      // T24 — `chatTurnWriterStateDir` is updated ONLY on success.
      // On failure, `chatTurnWriterMigrationTarget` is cleared and
      // `chatTurnWriterStateDir` stays at the fallback so a future
      // register() can retry the migration. Without this, a
      // transient migration failure (e.g., destination disk full)
      // would suppress all future retries because the field would
      // already match the desired target.
      this.chatTurnWriterMigrationTarget = stateDir;
      this.chatTurnWriter.setStateDir(stateDir, { stateLayout, legacyStateDirs }).then(
        () => {
          this.chatTurnWriterStateDir = stateDir;
          this.chatTurnWriterStateDirSource = stateDirSource;
          this.chatTurnWriterStateLayout = stateLayout;
          this.chatTurnWriterMigrationTarget = null;
        },
        (err: any) => {
          api.logger.warn?.(`[dkg] ChatTurnWriter stateDir migration failed: ${err?.message ?? err}`);
          this.chatTurnWriterMigrationTarget = null;
          // Leave chatTurnWriterStateDir untouched so a future
          // register() with the same target re-attempts the migration.
        },
      );
      return;
    }

    if (stateDirSource === 'home') {
      api.logger.warn?.(
        '[dkg] Could not resolve a workspace-scoped state dir (api.runtime.state.resolveStateDir / OPENCLAW_STATE_DIR / config.stateDir / api.workspaceDir all unavailable); ' +
        `falling back to '${homeDir}'. Two workspaces on the same machine will share chat-turn watermarks. ` +
        'Set config.stateDir or OPENCLAW_STATE_DIR explicitly to silence this.',
      );
    }
    this.chatTurnWriter = new ChatTurnWriter({
      client: this.client,
      logger: api.logger,
      stateDir,
      stateLayout,
      legacyStateDirs,
    });
    this.chatTurnWriterStateDir = stateDir;
    this.chatTurnWriterStateDirSource = stateDirSource;
    this.chatTurnWriterStateLayout = stateLayout;
    this.channelPlugin?.setChatTurnWriter(this.chatTurnWriter);
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
  private installHooksIfNeeded(
    api: OpenClawPluginApi,
    opts?: { runtimeHooksEnabled?: boolean },
  ): void {
    // T52 — Default keeps existing call sites working (they all expect
    // runtime hooks). Setup-only callers pass `false` to wire ONLY the
    // legacy `session_end` cleanup hook so the channel HTTP server
    // (registered unconditionally by `registerIntegrationModules` when
    // `channel.enabled`) has a shutdown path. Without this, a
    // setup-only register would bring up port 9201 with no
    // `session_end` listener — gateway shutdown would leak the bound
    // port and any stale bridge state into the next runtime upgrade.
    const runtimeHooks = opts?.runtimeHooksEnabled ?? true;
    // T52 — `chatTurnWriter` is required for W4a/W4b but NOT for the
    // session_end cleanup. In setup-only mode the writer is never
    // constructed (R17.2 — no FS work for metadata-only loads), so
    // the prior unconditional `if (!chatTurnWriter) return` short-
    // circuited the entire install path and stranded the channel
    // server with no shutdown hook. Allow the setup path through;
    // the W4 install lines below are gated on `runtimeHooks` and
    // never dereference a null writer.
    if (runtimeHooks && !this.chatTurnWriter) return;

    if (this.hookSurface) {
      const stats = this.hookSurface.getDispatchStats();
      const apiChanged = this.hookSurfaceApi !== api;
      if (apiChanged) {
        // T31 — DO NOT destroy the old surface. Multi-phase init dispatches
        // typed events against an arbitrary api in the chain (not always
        // the latest), and our prior destroy-and-rebuild left every old
        // wrapper orphaned. Build a NEW surface for the new api below
        // (fall through), and keep the old one live so whichever api the
        // gateway picks for emit, a wrapped handler is reachable. R21.1
        // soft-destroyed flag still gates post-`stop()` dispatch — we
        // destroy ALL surfaces in `stop()`. The `allHookSurfaces` set
        // owns the lifecycle.
        this.hookSurface = null;
        this.hookSurfaceApi = null;
        // T12 — Prompt section was registered against the old api;
        // the new api gets a fresh registry, so the install must
        // re-run. Reset the idempotency flag so the rebuild path
        // below installs the section against the new api too.
        this.promptSectionInstalled = false;
      } else {
        // Same api. Retry INTERNAL hook installs that previously failed
        // (e.g. gateway hadn't created the internal-hook map yet at
        // first register()). The "don't re-run typed installs on same
        // api" rule applies only to PREVIOUSLY-SUCCESSFUL installs —
        // `api.on(...)` has no unsubscribe, so re-running over a live
        // typed handler would leave the old one bound and double-fire.
        // BUT if a previous typed install RETURNED `installedVia: 'none'`
        // (because `api.on` was undefined at first register()), there
        // is no live handler to double-up; retrying when api.on has
        // since become available is safe and is the only way to recover
        // from a `setup-runtime → full` upgrade on the same api object
        // where typed-hook surface flips from absent to present (T6).
        // T59 — "Needs install" covers BOTH the explicit-failure
        // retry case (`installedVia === 'none'`, surfaces from
        // `setup-runtime → full` upgrades on the same api where
        // `api.on` was undefined at first-call) AND the
        // never-attempted case (`stats[key] === undefined`, which
        // happens when the first register was `setup-only` and
        // skipped W3/W4/internal entirely). Without the
        // never-attempted branch, a `setup-only → full` upgrade on
        // the SAME api would leave the runtime hooks permanently
        // uninstalled — the surface exists from the setup-only
        // pass, the apiChanged check is false, and the retry
        // predicates only fired on explicit failures. Treat absent
        // stats as a first-time install when the corresponding
        // dispatch primitive is now available.
        const internalNeedsRetry = (event: string) => {
          const s = stats[`internal:${event}`];
          return s === undefined || s.installedVia === 'none' || !this.internalHookEventIsLive(event);
        };
        const typedNeedsRetry = (event: string) => {
          const s = stats[`typed:${event}`];
          return (s === undefined || s.installedVia === 'none') &&
            typeof api.on === 'function';
        };
        const legacyNeedsRetry = (event: string) => {
          const s = stats[`legacy:${event}`];
          return (s === undefined || s.installedVia === 'none') &&
            typeof api.registerHook === 'function';
        };
        // T52 — runtime-hook retries depend on a constructed
        // chatTurnWriter (W4a/W4b dispatch into it). In setup-only re-
        // entry the writer is still null; skip the runtime block
        // entirely and let the legacy session_end retry below run.
        if (runtimeHooks && this.chatTurnWriter) {
          // Use the SAME wrapped-handler factories as the initial install
          // below so a late retry preserves the mode-independent slot
          // re-assert anchor. Without the wrapper, turn persistence would
          // recover but slot ownership wouldn't bounce back per-message.
          if (internalNeedsRetry('message:received')) {
            this.hookSurface.install('internal', 'message:received', this.makeMessageReceivedHandler(), { rareFireExpected: true });
          }
          if (internalNeedsRetry('message:sent')) {
            this.hookSurface.install('internal', 'message:sent', this.makeMessageSentHandler(), { rareFireExpected: true });
          }
          // T6 — Typed hook retries for setup-runtime → full upgrades on
          // the SAME api object. Without these, `before_prompt_build` and
          // `agent_end` would stay permanently uninstalled because the
          // first register() found `api.on === undefined` and recorded
          // `installedVia: 'none'`. The `installedVia: 'none'` precondition
          // guarantees we're not double-binding a live handler.
          if (typedNeedsRetry('before_prompt_build')) {
            this.hookSurface.install(
              'typed',
              'before_prompt_build',
              this.observedTypedHandler('before_prompt_build', (ev, ctx) => this.handleBeforePromptBuild(ev, ctx)),
              this.observedTypedOptions('before_prompt_build'),
            );
          }
          if (typedNeedsRetry('agent_end')) {
            this.hookSurface.install(
              'typed',
              'agent_end',
              this.observedTypedHandler('agent_end', (ev, ctx) => this.chatTurnWriter!.onAgentEnd(ev, ctx)),
              this.observedTypedOptions('agent_end'),
            );
          }
          if (typedNeedsRetry('before_compaction')) {
            this.hookSurface.install(
              'typed',
              'before_compaction',
              this.observedTypedHandler('before_compaction', (ev, ctx) => this.chatTurnWriter!.onBeforeCompaction(ev, ctx)),
              this.observedTypedOptions('before_compaction', { rareFireExpected: true }),
            );
          }
          if (typedNeedsRetry('before_reset')) {
            this.hookSurface.install(
              'typed',
              'before_reset',
              this.observedTypedHandler('before_reset', (ev, ctx) => this.chatTurnWriter!.onBeforeReset(ev, ctx)),
              this.observedTypedOptions('before_reset', { rareFireExpected: true }),
            );
          }
        }
        // T7 — Legacy `session_end` retry. Same logic: only retry if the
        // previous install recorded `installedVia: 'none'` (i.e. registerHook
        // was unavailable at first register()). The destroyed-flag short-
        // circuit (R21.1) prevents double-fires when the previous install
        // succeeded.
        if (legacyNeedsRetry('session_end')) {
          this.hookSurface.install('legacy', 'session_end', () => this.stop(), { rareFireExpected: true });
        }
        // T11 — Re-evaluate prompt-section install on same-api re-register.
        // The first call under setup-runtime had `isFullMode === false` and
        // skipped the install; if the api has since flipped to full mode
        // (the same trigger as T6 typed-hook retries), install the guidance
        // now. `tryInstallPromptSection` is idempotent via
        // `promptSectionInstalled` so a `full → full` re-register is a no-op.
        this.tryInstallPromptSection(api);
        return;
      }
    }

    // T34 — Reap any surfaces that have lived past the stale grace
    // window without firing. Long-lived processes that get many
    // `apiChanged` re-registrations would otherwise grow this set
    // unbounded. Runs at every register, before adding the new
    // surface, so eviction work is bounded to the multi-phase init
    // cadence (no separate timer / no event-loop pressure).
    this.evictStaleHookSurfaces();
    // T31 — Internal hooks (`message:received` / `message:sent`) live
    // in a process-global Map<event, HookHandler[]> and would double-
    // fire if every surface pushed its own wrapper. T32 — but gating
    // on "first surface only" breaks the retry path: if the FIRST
    // register fired before `globalThis[…internalHookHandlers]` was
    // created (e.g., gateway boot order), surface #1 records
    // `installedVia: 'none'` and surface #2's `size !== 0` skip would
    // leave W4b persistence permanently disabled. Gate instead on
    // "has any prior surface SUCCESSFULLY installed internal hooks"
    // (`installedVia === 'globalThis'`). If yes, skip — already live.
    // If no, retry on the new surface; the global map may have
    // appeared between the prior register and this one.
    this.hookSurface = new HookSurface(api, api.logger);
    this.hookSurfaceApi = api;
    this.allHookSurfaces.add(this.hookSurface);
    this.hookSurfaceInstalledAt.set(this.hookSurface, Date.now());
    // T7 — Route `session_end` through HookSurface instead of calling
    // `api.registerHook` directly. `api.registerHook` has no unsubscribe
    // primitive, so the prior direct-registration path accumulated
    // handlers across `stop() → register()` cycles on the same api: one
    // shutdown event would fire `stop()` once per accumulated handler.
    // Routing through `HookSurface.install('legacy', ...)` gives the
    // wrapper the soft-destroyed gate (R21.1) so old wrappers
    // short-circuit after `stop()` has already torn the surface down.
    this.hookSurface.install('legacy', 'session_end', () => this.stop(), { rareFireExpected: true });

    // T52 — Runtime-only hooks (W3 auto-recall, W4a LLM turn capture,
    // W4b non-LLM channel capture) gate on `runtimeHooks`. In setup-
    // only mode we install ONLY `session_end` above so the channel
    // bridge's HTTP server has a shutdown path. Returning here when
    // `runtimeHooks === false` skips the prompt-section install too,
    // matching the existing R14.3 invariant ("setup-only must not
    // wire prompt injection").
    if (!runtimeHooks) return;

    // W3 — auto-recall every turn via before_prompt_build typed hook
    this.hookSurface.install(
      'typed',
      'before_prompt_build',
      this.observedTypedHandler('before_prompt_build', (ev, ctx) => this.handleBeforePromptBuild(ev, ctx)),
      this.observedTypedOptions('before_prompt_build'),
    );

    // W4a — LLM-driven turn capture via typed hooks. `before_compaction`
    // and `before_reset` are rare on healthy gateways; tag them so the
    // HookSurface commit-by-timeout warn downgrades to debug (otherwise
    // they false-positive within 30s of startup every time).
    this.hookSurface.install(
      'typed',
      'agent_end',
      this.observedTypedHandler('agent_end', (ev, ctx) => this.chatTurnWriter!.onAgentEnd(ev, ctx)),
      this.observedTypedOptions('agent_end'),
    );
    this.hookSurface.install(
      'typed',
      'before_compaction',
      this.observedTypedHandler('before_compaction', (ev, ctx) => this.chatTurnWriter!.onBeforeCompaction(ev, ctx)),
      this.observedTypedOptions('before_compaction', { rareFireExpected: true }),
    );
    this.hookSurface.install(
      'typed',
      'before_reset',
      this.observedTypedHandler('before_reset', (ev, ctx) => this.chatTurnWriter!.onBeforeReset(ev, ctx)),
      this.observedTypedOptions('before_reset', { rareFireExpected: true }),
    );

    // W4b — non-LLM channel capture via internal-hook map (PR #216 mechanism).
    // Internal hooks fire across both `full` and `setup-runtime` modes, so
    // we tack a memory-slot re-assert onto each fire as the mode-independent
    // ownership anchor. Cheap (one property assignment) and keeps the slot
    // honest even when `before_prompt_build` (full-only) and the
    // `memory_search` tool path don't run.
    //
    // T31 — Internal hooks live in the process-global
    // `globalThis[Symbol.for('openclaw.internalHookHandlers')]` map; every
    // surface that calls `install('internal', …)` pushes ANOTHER wrapper
    // into the same `HookHandler[]` for that event. With the multi-phase
    // init re-bind fix above, each subsequent surface would push a new
    // wrapper and every internal event would fire 2× / 3× / Nx where N is
    // the number of surfaces ever built. T32 — gate on "any prior surface
    // already succeeded" rather than "first surface" so a failed initial
    // install (globalThis hook map not yet created at first-register time)
    // still gets retried on the next surface.
    if (!this.internalHookEventIsLive('message:received')) {
      this.hookSurface.install('internal', 'message:received', this.makeMessageReceivedHandler(), { rareFireExpected: true });
    }
    if (!this.internalHookEventIsLive('message:sent')) {
      this.hookSurface.install('internal', 'message:sent', this.makeMessageSentHandler(), { rareFireExpected: true });
    }

    // I8 — tool-selection guidance injected into the system prompt every turn.
    // Reaches the agent model directly (unlike SKILL.md which only reaches
    // doc-readers). Feature-detected: no-op on gateways that haven't wired it.
    //
    // R24.2 — Gate the prompt-section install on actual tool availability:
    //   1. `fullRuntime` — `memory_search` / `dkg_query` are registered only
    //      in full mode (the tool registration loop in `register()` is
    //      `if (fullRuntime)`-gated). Installing the "Prefer `memory_search`"
    //      guidance under setup-runtime would tell the model to use a tool
    //      that does not exist on this gateway phase.
    //   2. `this.config.memory?.enabled` — when memory is config-disabled,
    //      `memory_search` returns a "memory unavailable" error and the
    //      guidance is misleading.
    // We don't gate on `memoryPlugin?.isRegistered()` here because
    // `registerIntegrationModules` runs AFTER this method on the first-time
    // path; the prompt section would be missing when registration succeeded
    // later. Slot-ownership lost mid-session is a rarer state that the
    // tool's own runtime check already handles by returning "memory
    // unavailable" from `memory_search`.
    this.tryInstallPromptSection(api);
  }

  /**
   * T11 — Idempotent prompt-section install. Called from both the
   * first-time `register()` path AND the same-api retry branch so a
   * `setup-runtime → full` upgrade (where the first call had
   * `isFullMode === false` and skipped the install) installs the
   * "Prefer memory_search" guidance once the api flips to full mode.
   * The `promptSectionInstalled` flag prevents a double-install on
   * subsequent same-api re-registers.
   */
  private tryInstallPromptSection(api: OpenClawPluginApi): void {
    if (this.promptSectionInstalled) return;
    const isFullMode = api.registrationMode === 'full' || api.registrationMode === undefined;
    const memoryEnabled = !!this.config.memory?.enabled;
    const registerPromptSection = (api as any).registerMemoryPromptSection as
      | ((section: { title: string; body: string }) => void)
      | undefined;
    if (!isFullMode || !memoryEnabled || typeof registerPromptSection !== 'function') return;
    try {
      registerPromptSection({
        title: 'DKG Memory',
        body:
          'Prefer `memory_search` for free-text recall across your DKG memory ' +
          '(fan-outs WM/SWM/VM, trust-weighted, deduped). Use `dkg_query` only ' +
          'when you need precise SPARQL control over a known graph pattern.',
      });
      this.promptSectionInstalled = true;
    } catch (err: any) {
      api.logger.debug?.(`[dkg] registerMemoryPromptSection failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Internal-hook handler factories. Both the initial install and the
   * same-api retry path use these so the mode-independent re-assert
   * wrapper is consistent across paths. A late retry that recovered turn
   * persistence WITHOUT the wrapper would silently lose slot-ownership
   * defense-in-depth on every internal-hook fire.
   */
  private makeMessageReceivedHandler() {
    return (ev: any) => {
      try { this.memoryPlugin?.reAssertCapability(); } catch { /* non-fatal */ }
      return this.chatTurnWriter!.onMessageReceived(ev);
    };
  }

  private makeMessageSentHandler() {
    return (ev: any) => {
      try { this.memoryPlugin?.reAssertCapability(); } catch { /* non-fatal */ }
      return this.chatTurnWriter!.onMessageSent(ev);
    };
  }

  /**
   * True only when a retained surface still owns the adapter wrapper for
   * this internal event in the current global hook map.
   */
  private internalHookEventIsLive(event: string): boolean {
    for (const surface of this.allHookSurfaces) {
      if (surface.ownsCurrentInternalHook(event)) return true;
    }
    return false;
  }

  private recordTypedHookFire(event: string): void {
    this.typedHookFireSeq += 1;
    this.typedHookFireGeneration.set(event, this.typedHookFireSeq);
  }

  private observedTypedHookSinceInstall(event: string): () => boolean {
    const generationAtInstall = this.typedHookFireGeneration.get(event) ?? 0;
    return () => (this.typedHookFireGeneration.get(event) ?? 0) > generationAtInstall;
  }

  private observedTypedOptions(
    event: string,
    opts: { rareFireExpected?: boolean } = {},
  ): { rareFireExpected?: boolean; observedFireSinceInstall: () => boolean } {
    return {
      ...opts,
      observedFireSinceInstall: this.observedTypedHookSinceInstall(event),
    };
  }

  private observedTypedHandler(
    event: string,
    handler: (...args: any[]) => unknown,
  ): (...args: any[]) => unknown {
    return (...args: any[]) => {
      this.recordTypedHookFire(event);
      return handler(...args);
    };
  }

  /**
   * T34 — Bounded-retention eviction for `allHookSurfaces`. Multi-phase
   * init can hand the plugin a fresh `api` on every inbound turn, so
   * over hours a long-lived process accumulates surface objects that the
   * gateway will never dispatch against again. Eviction policy:
   *
   *   * NEVER evict the latest surface (`this.hookSurface`) — even if
   *     idle for now, it's the most recent target the gateway might
   *     have switched to and we don't want to disable freshly-installed
   *     handlers.
   *   * For older surfaces: evict if `installedAt` is more than
   *     `HOOK_SURFACE_STALE_THRESHOLD_MS` ago AND aggregate `fireCount`
   *     across all events on that surface is 0. A surface that has
   *     fired even once might still be a live dispatch target (the
   *     gateway can keep dispatching against an api long after we got
   *     a new one, depending on internal routing); preserving it costs
   *     a few closures and is the safer default.
   *
   * The grace window is wide enough that legitimate slow first-fires
   * (e.g., a setup-runtime → full transition where typed hooks only
   * dispatch after the first non-trivial inbound turn) won't trigger
   * spurious eviction. Surfaces that NEVER fire over multiple minutes
   * are presumed orphaned by the gateway and reclaimed.
   */
  private evictStaleHookSurfaces(): void {
    const now = Date.now();
    for (const surface of this.allHookSurfaces) {
      if (surface === this.hookSurface) continue;
      const installedAt = this.hookSurfaceInstalledAt.get(surface) ?? now;
      if (now - installedAt < DkgNodePlugin.HOOK_SURFACE_STALE_THRESHOLD_MS) continue;
      const stats = surface.getDispatchStats();
      // T36 — Exempt the surface that currently owns the live process-
      // global internal-hook registration. New surfaces skip installing
      // internal hooks via adapter-owned live-wrapper checks, so destroying
      // the only owner — even if its typed/legacy hooks have never
      // fired — would unsubscribe the global wrappers and silently
      // disable W4b cross-channel persistence permanently. The
      // owning surface is never the latest one when it gets here
      // (the latest is exempted above), so the only way to release
      // the global registration is via `stop()`, which destroys all
      // surfaces deliberately.
      if (
        surface.ownsCurrentInternalHook('message:received') ||
        surface.ownsCurrentInternalHook('message:sent')
      ) {
        continue;
      }
      let totalFires = 0;
      for (const stat of Object.values(stats)) {
        totalFires += stat.fireCount ?? 0;
      }
      if (totalFires === 0) {
        try { surface.destroy(); } catch { /* best effort */ }
        this.allHookSurfaces.delete(surface);
        this.hookSurfaceInstalledAt.delete(surface);
      }
    }
  }

  /**
   * Register DKG integration modules: channel and memory.
   * Each module is optional — enabled via config flags.
   */
  private startChannelPlugin(api: OpenClawPluginApi): boolean {
    const channelConfig = this.config.channel;
    if (!channelConfig?.enabled) return false;
    const nextChannelFingerprint = channelConfigFingerprint(channelConfig);
    if (!this.channelPlugin) {
      this.channelPlugin = new DkgChannelPlugin(channelConfig, this.client);
      this.channelPluginConfigFingerprint = nextChannelFingerprint;
    }
    this.channelPlugin.setChatTurnWriter(this.chatTurnWriter);
    const memoryPlugin = this.memoryPlugin;
    if (memoryPlugin?.isRegistered()) {
      this.channelPlugin.setPreDispatchReAssert(() => memoryPlugin.reAssertCapability());
    }
    this.channelPlugin.register(api);
    api.logger.info?.('[dkg] Channel module enabled — DKG UI bridge active');
    return true;
  }

  private stopChannelPluginForReconfigure(
    api: OpenClawPluginApi,
    options: {
      updateGatewayStatus?: boolean;
      clearLocalAgentIntegration?: boolean;
      registrationMode?: string;
    } = {},
  ): void {
    const channelPlugin = this.channelPlugin;
    if (!channelPlugin) return;
    if (this.channelPluginStopInFlight) return;
    channelPlugin.setPreDispatchReAssert(null);
    const stopWork = Promise.resolve(channelPlugin.stop({
      updateGatewayStatus: options.updateGatewayStatus,
    }))
      .then(
        () => {
          if (this.channelPlugin === channelPlugin) {
            this.channelPlugin = null;
            this.channelPluginConfigFingerprint = null;
          }
          if (options.clearLocalAgentIntegration) {
            this.clearLocalAgentChannelIntegration(api, options.registrationMode);
          }
          return true;
        },
        (err: any) => {
          api.logger.warn?.(`[dkg] Channel module reconfiguration stop failed: ${err?.message ?? err}`);
          const memoryPlugin = this.memoryPlugin;
          if (this.channelPlugin === channelPlugin && memoryPlugin?.isRegistered()) {
            channelPlugin.setPreDispatchReAssert(() => memoryPlugin.reAssertCapability());
          }
          return false;
        },
      )
      .finally(() => {
        if (this.channelPluginStopInFlight === stopWork) {
          this.channelPluginStopInFlight = null;
        }
      });
    this.channelPluginStopInFlight = stopWork;
  }

  private queueChannelPluginStartAfterStop(api: OpenClawPluginApi, registrationMode?: string): void {
    this.pendingChannelStartApi = api;
    this.pendingChannelStartRegistrationMode = registrationMode ?? null;
    this.pendingChannelStartFingerprint = channelConfigFingerprint(this.config.channel);
    if (this.channelPluginStartQueued) return;
    const stopWork = this.channelPluginStopInFlight;
    if (!stopWork) {
      this.startChannelPlugin(api);
      this.pendingChannelStartApi = null;
      this.pendingChannelStartRegistrationMode = null;
      this.pendingChannelStartFingerprint = null;
      return;
    }
    this.channelPluginStartQueued = true;
    void stopWork.then((stopped) => {
      this.channelPluginStartQueued = false;
      const pendingApi = this.pendingChannelStartApi;
      const pendingRegistrationMode = this.pendingChannelStartRegistrationMode;
      const pendingFingerprint = this.pendingChannelStartFingerprint;
      this.pendingChannelStartApi = null;
      this.pendingChannelStartRegistrationMode = null;
      this.pendingChannelStartFingerprint = null;
      const currentChannelFingerprint = channelConfigFingerprint(this.config.channel);
      if (
        !stopped ||
        !pendingApi ||
        !this.config.channel?.enabled ||
        currentChannelFingerprint !== pendingFingerprint
      ) {
        return;
      }
      const registered = this.startChannelPlugin(pendingApi);
      if (registered && pendingRegistrationMode) {
        this.registerLocalAgentIntegration(pendingApi, pendingRegistrationMode);
      }
    });
  }

  private registerIntegrationModules(
    api: OpenClawPluginApi,
    opts?: { enableFullRuntime?: boolean; registrationMode?: string },
  ): void {
    // T58 — Gate channel registration on `enableFullRuntime`. The
    // file header (line 432-436) explicitly documents `setup-only`
    // and `cli-metadata` as "true metadata-only modes that skip
    // integration wiring", but the channel module's
    // `DkgChannelPlugin.register()` calls `createServer().listen(port,
    // ...)` (default 9201) — a real network side effect. Pre-fix
    // setup-only register bound the port even when the gateway was
    // only doing setup-time discovery and might never upgrade to
    // full runtime, leaking a listening server into ambient state.
    // Re-aligns the integration-modules contract with the documented
    // metadata-only intent.
    if (!opts?.enableFullRuntime) {
      api.logger.info?.('[dkg] Metadata-only OpenClaw registration — skipping channel + memory-slot integration');
      return;
    }

    // --- Channel module ---
    const channelConfig = this.config.channel;
    const nextChannelFingerprint = channelConfigFingerprint(channelConfig);
    const channelDisabled = channelConfig?.enabled !== true;
    const hasChannelDisableSignal =
      channelConfig !== undefined ||
      this.channelPlugin !== null ||
      this.channelPluginStopInFlight !== null;
    if (channelDisabled && hasChannelDisableSignal) {
      this.pendingChannelStartApi = null;
      this.pendingChannelStartRegistrationMode = null;
      this.pendingChannelStartFingerprint = null;
      const stopInFlight = this.channelPluginStopInFlight;
      if (stopInFlight) {
        const stopForDisable = this.channelPlugin
          ? Promise.resolve(this.channelPlugin.stop({ updateGatewayStatus: true })).then(() => true)
          : stopInFlight;
        void stopForDisable.then(
          (stopped) => {
            if (stopped) this.clearLocalAgentChannelIntegration(api, opts?.registrationMode);
          },
          (err: any) => {
            api.logger.warn?.(`[dkg] Channel module disable status update failed: ${err?.message ?? err}`);
          },
        );
      } else if (!this.channelPlugin) {
        this.clearLocalAgentChannelIntegration(api, opts?.registrationMode);
      }
    }
    if (this.channelPlugin && this.channelPluginConfigFingerprint !== nextChannelFingerprint) {
      this.stopChannelPluginForReconfigure(api, {
        updateGatewayStatus: !channelConfig?.enabled,
        clearLocalAgentIntegration: !channelConfig?.enabled,
        registrationMode: opts?.registrationMode,
      });
    }
    if (channelConfig?.enabled) {
      if (this.channelPluginStopInFlight) {
        this.queueChannelPluginStartAfterStop(api, opts?.registrationMode);
      } else {
        this.startChannelPlugin(api);
      }
    }

    // --- Memory module ---
    const memoryConfig = this.config.memory;
    if (!memoryConfig?.enabled && this.memoryPlugin) {
      this.channelPlugin?.setPreDispatchReAssert(null);
      const disabledCapabilityRegistered = this.memoryPlugin.disable(api);
      void this.memoryPlugin.close();
      this.memoryPlugin = null;
      this.memoryResolverApi = null;
      if (disabledCapabilityRegistered) {
        api.logger.info?.('[dkg] Memory module disabled — registered inactive memory capability to clear the previous DKG runtime');
      }
    }
    if (memoryConfig?.enabled) {
      if (!this.memoryPlugin) {
        this.memoryPlugin = new DkgMemoryPlugin(this.client, memoryConfig, this.memorySessionResolver);
      }
      const registered = this.memoryPlugin.register(api);

      // Resolver state (peer ID, subscribed CG cache, api handle) is
      // ALWAYS bootstrapped when memory is enabled — even when slot
      // registration was skipped. The `memory_search` tool runs against
      // the daemon directly and doesn't depend on slot ownership; without
      // resolver state it would degrade into a permanent "backend not
      // ready" response in workspaces where another plugin owns the
      // slot. Bootstrapping here keeps the read path useful in that
      // configuration.
      this.memoryResolverApi = api;
      void this.refreshMemoryResolverState(api);

      const memoryPlugin = this.memoryPlugin;
      if (!registered) {
        // Slot is owned by a different plugin (or registration is
        // intentionally disabled). Clear all paths that could re-assert
        // ownership and steal the slot back from the new owner:
        //   1. Channel plugin pre-dispatch callback (per-turn anchor).
        //   2. The memory plugin's CACHED capability+api — without this,
        //      `before_prompt_build` / `message:received` / `message:sent`
        //      / `memory_search` would all still call `reAssertCapability()`
        //      and re-stamp the cached entry, silently overwriting the
        //      newly elected provider on every turn.
        if (this.channelPlugin) {
          this.channelPlugin.setPreDispatchReAssert(null);
        }
        memoryPlugin?.invalidateRegistration();
        api.logger.info?.('[dkg] Memory module loaded but slot registration was skipped (see warn above for reason)');
        return;
      }
      api.logger.info?.('[dkg] Memory module enabled — DKG-backed memory slot active');

      // Mode-independent memory-slot re-assert anchor. The channel plugin
      // calls this once per inbound dispatch, before the message reaches
      // the memory host. Covers `setup-runtime` and write-only flows that
      // never reach the W3 (`before_prompt_build`) or `memory_search`
      // anchors, so a different plugin reclaiming the slot mid-session
      // gets bounced back before our recall/persist runs.
      if (memoryPlugin && this.channelPlugin && !this.channelPluginStopInFlight) {
        this.channelPlugin.setPreDispatchReAssert(() => memoryPlugin.reAssertCapability());
      }
    }
  }

  private registerLocalAgentIntegration(api: OpenClawPluginApi, registrationMode: string): void {
    if (!this.config.channel?.enabled || !this.channelPlugin) {
      return;
    }

    this.clearLocalAgentIntegrationRetry();
    if (this.channelPluginStopInFlight) {
      return;
    }
    void this.syncLocalAgentIntegrationState(api, registrationMode, this.daemonClientGeneration);
  }

  private clearLocalAgentChannelIntegration(api: OpenClawPluginApi, registrationMode = 'full'): void {
    this.clearLocalAgentIntegrationRetry();
    const generation = this.daemonClientGeneration;
    const client = this.client;
    const disabledChannelCapabilities = (): Record<keyof typeof OPENCLAW_LOCAL_AGENT_CAPABILITIES, boolean> => {
      const memoryActive = this.config.memory?.enabled === true && this.memoryPlugin?.isRegistered() === true;
      return {
        ...OPENCLAW_LOCAL_AGENT_CAPABILITIES,
        localChat: false,
        chatAttachments: false,
        connectFromUi: false,
        dkgPrimaryMemory: memoryActive,
        wmImportPipeline: memoryActive,
      };
    };
    const channelEnabled = () => this.config.channel?.enabled === true;
    void Promise.resolve().then(async () => {
      if (generation !== this.daemonClientGeneration) return;
      if (channelEnabled()) return;
      const existing = await this.loadStoredOpenClawIntegration(api, generation, client);
      if (generation !== this.daemonClientGeneration) return;
      if (channelEnabled()) return;
      if (existing === undefined) {
        const reason = this.lastLocalAgentIntegrationLoadError ?? 'fetch failed';
        const retryMessage =
          '[dkg] Stored OpenClaw integration state could not be loaded; retrying disabled-channel status update to preserve any persisted disconnect state' +
          ` (reason: ${reason})`;
        if (this.lastLocalAgentIntegrationWarnReason !== reason) {
          api.logger.warn?.(retryMessage);
          this.lastLocalAgentIntegrationWarnReason = reason;
        } else {
          api.logger.debug?.(retryMessage);
        }
        this.scheduleLocalAgentIntegrationRetry(api, registrationMode, generation, 'clear-disabled-channel');
        return;
      }
      this.clearLocalAgentIntegrationRetry();
      const retryAttempt = this.localAgentIntegrationRetryAttempt;
      if (existing === null) {
        if (retryAttempt > 0) {
          api.logger.info?.(
            `[dkg] No stored OpenClaw integration state found for disabled-channel cleanup after ${retryAttempt} retry attempt(s); nothing to clear`,
          );
        } else {
          api.logger.debug?.('[dkg] No stored OpenClaw integration state found for disabled-channel cleanup; nothing to clear');
        }
        this.localAgentIntegrationRetryAttempt = 0;
        this.lastLocalAgentIntegrationWarnReason = null;
        this.lastLocalAgentIntegrationLoadError = null;
        return;
      }
      if (retryAttempt > 0) {
        api.logger.info?.(
          `[dkg] Stored OpenClaw integration state loaded for disabled-channel cleanup after ${retryAttempt} retry attempt(s)`,
        );
      }
      this.localAgentIntegrationRetryAttempt = 0;
      this.lastLocalAgentIntegrationWarnReason = null;
      this.lastLocalAgentIntegrationLoadError = null;
      if (this.wasOpenClawExplicitlyUserDisconnected(existing)) {
        api.logger.info?.('[dkg] Stored OpenClaw integration was explicitly disconnected by the user; skipping disabled-channel status update');
        return;
      }
      // T364 round 13 — serialize the disable HTTP write so it can't
      // resolve out of order with an in-flight enable from
      // syncLocalAgentIntegrationState. Re-check inside the serialized
      // step too: if the channel got re-enabled while we were queued,
      // skip the disable entirely.
      await this.serializeLocalAgentIntegrationWrite(async () => {
        if (generation !== this.daemonClientGeneration) return;
        if (channelEnabled()) return;
        await client.updateLocalAgentIntegration('openclaw', {
          enabled: false,
          description: 'Connect a local OpenClaw agent through the DKG node.',
          transport: { kind: 'openclaw-channel' },
          capabilities: disabledChannelCapabilities(),
          manifest: OPENCLAW_LOCAL_AGENT_MANIFEST,
          setupEntry: OPENCLAW_LOCAL_AGENT_MANIFEST.setupEntry,
          metadata: {
            channelId: 'dkg-ui',
            registrationMode,
            transportMode: 'disabled',
          },
          runtime: {
            status: 'configured',
            ready: false,
            lastError: 'DKG UI channel disabled by adapter config',
          },
        });
      });
    }).catch((err: any) => {
      api.logger.warn?.(`[dkg] Local agent channel disable status update failed: ${err?.message ?? err}`);
    });
  }

  private clearLocalAgentIntegrationRetry(): void {
    if (!this.localAgentIntegrationRetryTimer) return;
    clearTimeout(this.localAgentIntegrationRetryTimer);
    this.localAgentIntegrationRetryTimer = null;
  }

  private scheduleLocalAgentIntegrationRetry(
    api: OpenClawPluginApi,
    registrationMode: string,
    generation = this.daemonClientGeneration,
    retryAction: 'sync' | 'clear-disabled-channel' = 'sync',
  ): void {
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
      if (generation !== this.daemonClientGeneration) return;
      if (retryAction === 'clear-disabled-channel') {
        this.clearLocalAgentChannelIntegration(api, registrationMode);
        return;
      }
      void this.syncLocalAgentIntegrationState(api, registrationMode, generation);
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

  private async syncLocalAgentIntegrationState(
    api: OpenClawPluginApi,
    registrationMode: string,
    generation = this.daemonClientGeneration,
  ): Promise<void> {
    if (generation !== this.daemonClientGeneration) return;
    // T364 round 6 — re-check `channel.enabled` at every yield, not
    // only `daemonClientGeneration`. A config flip from
    // `channel.enabled=true→false` does NOT bump the daemon-client
    // generation, so an in-flight sync that started while the channel
    // was enabled and is now awaiting `getLocalAgentIntegration()` or
    // `channelPlugin.start()` could otherwise continue to call
    // `connectLocalAgentIntegration({ enabled: true })` AFTER the
    // disable path (`clearLocalAgentChannelIntegration`) has already
    // cleared the OpenClaw record — silently re-enabling it. Mirror
    // the `channelEnabled()` guards in the disable path here.
    if (this.config.channel?.enabled !== true) return;
    const client = this.client;
    // Skip the retry loop entirely when the adapter has no runtime
    // integrations to sync. The stored-integration fetch is a no-op for
    // metadata-only loads and used to burn a 1 Hz warn loop on cold
    // daemons for no operator benefit.
    const anyIntegrationEnabled =
      this.config.memory?.enabled === true || this.config.channel?.enabled === true;
    if (!anyIntegrationEnabled) {
      return;
    }

    const existing = await this.loadStoredOpenClawIntegration(api, generation, client);
    if (generation !== this.daemonClientGeneration) return;
    if (this.config.channel?.enabled !== true) return;
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
      this.scheduleLocalAgentIntegrationRetry(api, registrationMode, generation);
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
    if (generation !== this.daemonClientGeneration) return;
    // Final guard immediately before sending the enabled payload. A
    // disable that happened during channelPlugin.start() above must not
    // be undone by this in-flight sync.
    if (this.config.channel?.enabled !== true) return;

    const bridgeReady = this.channelPlugin?.isListening === true && !startError;
    // T30 — Derive memory-related capability flags from actual
    // registration state, not the static manifest constant. When the
    // memory slot is owned by another plugin (or memory is config-
    // disabled), `memoryPlugin.isRegistered()` returns false and we
    // must NOT advertise `dkgPrimaryMemory: true` / `wmImportPipeline:
    // true` — otherwise UI/daemon consumers would offer DKG-backed
    // memory actions that the slot's actual owner can't honour. The
    // remaining capabilities (localChat, chatAttachments, connectFromUi,
    // installNode, nodeServedSkill) are independent of slot ownership
    // and stay statically true.
    const memoryActive = this.memoryPlugin?.isRegistered() === true;
    const capabilities = {
      ...OPENCLAW_LOCAL_AGENT_CAPABILITIES,
      dkgPrimaryMemory: memoryActive,
      wmImportPipeline: memoryActive,
    };
    const basePayload = {
      id: 'openclaw',
      enabled: true,
      description: 'Connect a local OpenClaw agent through the DKG node.',
      transport: this.buildOpenClawTransport(existing?.transport, api),
      capabilities,
      manifest: OPENCLAW_LOCAL_AGENT_MANIFEST,
      setupEntry: OPENCLAW_LOCAL_AGENT_MANIFEST.setupEntry,
      metadata,
    };

    try {
      // T364 round 13 — serialize the enable HTTP write so it can't
      // resolve out of order with an in-flight disable from
      // clearLocalAgentChannelIntegration. Re-check inside the
      // serialized step too: a disable that fired while this op was
      // queued must not be undone by a stale enable resolving after
      // it. The pre-write rechecks earlier in this function close
      // the await-yield window; this final check inside the
      // serialized step closes the in-flight-HTTP window.
      await this.serializeLocalAgentIntegrationWrite(async () => {
        if (generation !== this.daemonClientGeneration) return;
        if (this.config.channel?.enabled !== true) return;
        await client.connectLocalAgentIntegration({
          ...basePayload,
          runtime: {
            status: startError ? 'error' : bridgeReady ? 'ready' : 'connecting',
            ready: bridgeReady,
            lastError: startError ? startError.message : null,
          },
        });
      });
    } catch (err: any) {
      api.logger.warn?.(`[dkg] Local agent registration failed (will retry on next gateway start): ${err.message}`);
      return;
    }
  }

  private async loadStoredOpenClawIntegration(
    api: OpenClawPluginApi,
    generation = this.daemonClientGeneration,
    client = this.client,
  ): Promise<LocalAgentIntegrationRecord | null | undefined> {
    try {
      const result = await client.getLocalAgentIntegration('openclaw');
      if (generation !== this.daemonClientGeneration) return undefined;
      // Clear any stale error from an earlier failed attempt so the
      // retry dedup logic in `syncLocalAgentIntegrationState` can
      // distinguish a fresh failure reason from the previous one.
      this.lastLocalAgentIntegrationLoadError = null;
      return result;
    } catch (err: any) {
      if (generation !== this.daemonClientGeneration) return undefined;
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
    // R19.2 — Tear hooks down BEFORE draining persists. A late
    // `agent_end` / `message:sent` arriving during shutdown would
    // otherwise schedule a new persist job after `flush()` snapshots
    // the in-flight set, and `stop()` would return without awaiting
    // it. By destroying the hook surface first, no NEW handler
    // invocations dispatch; the loop in `flush()` then waits out the
    // handlers that were already in flight when `destroy()` ran.
    // T31 — Destroy ALL surfaces (multi-phase init may have built one
    // per api). The original `hookSurface` field tracks the latest, but
    // the `allHookSurfaces` set holds every surface ever built since
    // last `stop()`. Destroying just the latest would leave older
    // surfaces' typed-hook wrappers reachable from the old api objects
    // (until those apis themselves get garbage-collected by the
    // gateway), and their internal-hook globalThis-map entries (only
    // the FIRST surface's, but still) would survive. The R21.1 / R23.1
    // soft-destroyed flag short-circuits late dispatches against any
    // destroyed surface.
    for (const surface of this.allHookSurfaces) {
      try { surface.destroy(); } catch { /* best effort */ }
    }
    this.allHookSurfaces.clear();
    // R23.2 — Null out the hook-surface refs after destroy. Without this,
    // a later `register()` on the same plugin instance with the same `api`
    // object hits the existing-surface fast path in `installHooksIfNeeded()`
    // and skips the rebuild. The old surface is permanently inert
    // (`destroyed=true`, internal handlers removed from the globalThis
    // map), so W3 / W4a / W4b would silently never re-install. Clearing
    // both refs forces the next `installHooksIfNeeded()` call to rebuild
    // the surface from scratch.
    this.hookSurface = null;
    this.hookSurfaceApi = null;
    // T12 — Reset the prompt-section idempotency flag so a later
    // `register()` after this `stop()` re-installs the section
    // against the new (or same) api registry. Without this, a
    // gateway restart cycle leaves the new instance without the
    // DKG Memory prompt guidance.
    this.promptSectionInstalled = false;
    // T13 — Drop any in-flight auto-recall reservations. The hook
    // surface is destroyed; no new prompt-build fires can land,
    // and clearing the set means a future `register()` doesn't
    // start with stale entries that would suppress the first turn.
    this.autoRecallInFlight.clear();
    // `flush()` (vs `flushSync()`) awaits in-flight `storeChatTurn` jobs
    // and any pending session resets before committing the watermark
    // file. Without the await, a shutdown immediately after a reply
    // could exit while the final turn's network persist is still in
    // flight and the turn is silently lost.
    try { await this.chatTurnWriter?.flush(); } catch { /* best effort */ }
    this.clearLocalAgentIntegrationRetry();
    this.pendingChannelStartApi = null;
    this.pendingChannelStartRegistrationMode = null;
    this.pendingChannelStartFingerprint = null;
    if (this.peerIdDeferredRetryTimer) {
      clearTimeout(this.peerIdDeferredRetryTimer);
      this.peerIdDeferredRetryTimer = null;
    }
    await this.channelPluginStopInFlight;
    await this.channelPlugin?.stop();
    this.channelPlugin = null;
    this.channelPluginConfigFingerprint = null;
    try { await this.chatTurnWriter?.flush(); } catch { /* best effort */ }
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

    const generation = this.daemonClientGeneration;
    const run = async (): Promise<void> => {
      try {
        // Route through `ensureNodePeerId` so the in-flight promise
        // guard is populated while this probe runs. Any resolver call
        // that fires concurrently (e.g., a memory slot search during
        // the same tick) will await the same peer-ID promise instead
        // of firing a duplicate /api/status call. Codex Bug B9.
        await this.ensureNodePeerId();
        // Resolve the daemon's default agent identity through
        // `/api/agent/identity` using the node-level Bearer token already
        // loaded by DkgDaemonClient. Same debouncing pattern as
        // `ensureNodePeerId`; runs sequentially after it but neither blocks
        // the other on retry. Probe completion is awaited so the resolver
        // cache is warm by the time the first slot-backed search /
        // dkg_query / before_prompt_build hook fires.
        await this.ensureNodeAgentAddress();
        if (generation !== this.daemonClientGeneration) return;
        try {
          const result = await this.client.listContextGraphs();
          if (generation !== this.daemonClientGeneration) return;
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
            // graph the node knows about — including system contextGraphs
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
            //     correctly excluded system contextGraphs and discovered-not-
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
            // contextGraphs also have `synced: true` but are filtered by the
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
        if (generation === this.daemonClientGeneration && this.nodePeerId === undefined) {
          this.schedulePeerIdDeferredRetry(api);
        }
      }
    };

    const tracked = run().finally(() => {
      // Clear the slot only if we're still the tracked promise — a
      // concurrent caller that started after us would have taken
      // over, though the guard above prevents that in practice.
      if (generation === this.daemonClientGeneration && this.refreshStateInFlight === tracked) {
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
  private async probeNodePeerIdOnce(
    api: OpenClawPluginApi,
    generation = this.daemonClientGeneration,
  ): Promise<void> {
    try {
      const status = await this.client.getStatus();
      if (generation !== this.daemonClientGeneration) return;
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

    const generation = this.daemonClientGeneration;
    const probe = this.probeNodePeerIdOnce(api, generation).finally(() => {
      if (generation === this.daemonClientGeneration) {
        this.peerIdProbeInFlight = null;
      }
    });
    this.peerIdProbeInFlight = probe;
    return probe;
  }

  /**
   * Single-shot HTTP probe of the daemon's default agent identity.
   *
   * Uses the DkgDaemonClient constructor-loaded node-level Bearer token.
   * The daemon maps that token to its default agent address and returns the
   * canonical WM namespace identifier used for default-agent writes.
   *
   * Does NOT debounce; caller (`ensureNodeAgentAddress`) handles concurrent
   * call dedup via the in-flight promise guard.
   */
  private async probeNodeAgentAddressOnce(
    api: OpenClawPluginApi,
    generation = this.daemonClientGeneration,
  ): Promise<void> {
    const httpResult = await this.client.getAgentIdentity();
    if (generation !== this.daemonClientGeneration) return;
    if (httpResult.ok && httpResult.identity?.agentAddress) {
      this.nodeAgentAddress = httpResult.identity.agentAddress;
      return;
    }

    api.logger.warn?.(
      `[dkg-memory] Daemon /api/agent/identity probe failed: ${httpResult.error ?? 'identity response missing agentAddress'}. ` +
      'Working-memory reads will use the node peer ID fallback until the next identity probe lands. ' +
      'This is normal during daemon startup; if it persists, check the daemon is healthy and the node API token is valid.',
    );
  }

  /**
   * Resolve the WM identifier for default-agent self-reads.
   * Mirrors the daemon writer-side priority: default agent address when the
   * identity endpoint has resolved it, otherwise the node peerId fallback.
   */
  private resolveDefaultAgentAddress(): string | undefined {
    return this.nodeAgentAddress ?? this.nodePeerId;
  }
  private ensureNodeAgentAddress(): Promise<void> {
    if (this.nodeAgentAddress !== undefined) return Promise.resolve();
    const api = this.memoryResolverApi;
    if (!api) return Promise.resolve();
    if (this.agentAddressProbeInFlight) return this.agentAddressProbeInFlight;

    const generation = this.daemonClientGeneration;
    const probe = this.probeNodeAgentAddressOnce(api, generation).finally(() => {
      if (generation === this.daemonClientGeneration) {
        this.agentAddressProbeInFlight = null;
      }
    });
    this.agentAddressProbeInFlight = probe;
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
    const generation = this.daemonClientGeneration;
    this.peerIdDeferredRetryTimer = setTimeout(() => {
      this.peerIdDeferredRetryTimer = null;
      if (generation !== this.daemonClientGeneration) return;
      if (this.nodePeerId !== undefined) return;
      void this.probeNodePeerIdOnce(api, generation);
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

  /**
   * Register a context graph on-chain, tolerating the idempotent
   * "already registered" case (returns `undefined` so callers don't claim a
   * fresh registration). Any OTHER failure rethrows — the caller surfaces it as
   * a tool error and must NOT proceed. Used by handleAssertionPublish (CONTRACT
   * §G) for the register-then-publish path of the canonical per-KA publish tool.
   */
  private async registerContextGraphIfNeeded(
    contextGraphId: string,
    accessPolicy?: number,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.client.registerContextGraph(contextGraphId, { accessPolicy });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (message.includes('already registered')) {
        return undefined;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  /**
   * Exposes the tool-handler surface to the out-of-class `build*Tools` helpers
   * without leaking the handlers into the public `DkgNodePlugin` type. The
   * `handle*` methods stay `private`; this returns bound references that the
   * builders delegate to via the {@link DkgToolHost} structural contract.
   */
  private toolHost(): DkgToolHost {
    return {
      handleStatus: this.handleStatus.bind(this),
      handleWalletBalances: this.handleWalletBalances.bind(this),
      handleListContextGraphs: this.handleListContextGraphs.bind(this),
      handleContextGraphCreate: this.handleContextGraphCreate.bind(this),
      handleContextGraphInvite: this.handleContextGraphInvite.bind(this),
      handleParticipantAdd: this.handleParticipantAdd.bind(this),
      handleParticipantRemove: this.handleParticipantRemove.bind(this),
      handleParticipantList: this.handleParticipantList.bind(this),
      handleJoinRequestList: this.handleJoinRequestList.bind(this),
      handleJoinRequestApprove: this.handleJoinRequestApprove.bind(this),
      handleJoinRequestReject: this.handleJoinRequestReject.bind(this),
      handleSubscribe: this.handleSubscribe.bind(this),
      handleQuery: this.handleQuery.bind(this),
      handleQueryCatalogList: this.handleQueryCatalogList.bind(this),
      handleQueryCatalogRun: this.handleQueryCatalogRun.bind(this),
      handleQueryCatalogSave: this.handleQueryCatalogSave.bind(this),
      handleFindAgents: this.handleFindAgents.bind(this),
      handleSendMessage: this.handleSendMessage.bind(this),
      handleReadMessages: this.handleReadMessages.bind(this),
      handleInvokeSkill: this.handleInvokeSkill.bind(this),
      handleAssertionCreate: this.handleAssertionCreate.bind(this),
      handleAssertionWrite: this.handleAssertionWrite.bind(this),
      handleAssertionFinalize: this.handleAssertionFinalize.bind(this),
      handleAssertionPromote: this.handleAssertionPromote.bind(this),
      handleAssertionPublish: this.handleAssertionPublish.bind(this),
      handleAssertionPullFrom: this.handleAssertionPullFrom.bind(this),
      handleAssertionDiscard: this.handleAssertionDiscard.bind(this),
      handleAssertionImportFile: this.handleAssertionImportFile.bind(this),
      handleAssertionQuery: this.handleAssertionQuery.bind(this),
      handleImportArtifactResolve: this.handleImportArtifactResolve.bind(this),
      handleImportArtifactReadMarkdown: this.handleImportArtifactReadMarkdown.bind(this),
      handleSemanticEnrichmentWrite: this.handleSemanticEnrichmentWrite.bind(this),
      handleAssertionHistory: this.handleAssertionHistory.bind(this),
      handleSubGraphCreate: this.handleSubGraphCreate.bind(this),
      handleSubGraphList: this.handleSubGraphList.bind(this),
      handleMemorySearch: this.handleMemorySearch.bind(this),
    };
  }

  private tools(): OpenClawTool[] {
    // Tool definitions are grouped into cohesive `build*Tools` modules under
    // `./tools/`. Order is load-bearing (some hosts surface tools in array
    // order), so the spreads below preserve the original sequence exactly.
    const host = this.toolHost();
    return [
      ...buildNodeTools(host),
      ...buildContextGraphTools(host),
      ...buildQueryTools(host),
      ...buildMessagingTools(host),
      ...buildAssertionTools(host),
      ...buildMemoryTools(host),
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
    // T31/T39 (Bug B diagnostic) — Distinguish "hook never fires"
    // from "hook fires but exits early." Logged at `debug` so a busy
    // gateway doesn't drown out warnings (info-per-turn for every
    // active chat materially increases volume). Operators chasing
    // the rollout can flip log level to debug for verification; if
    // this line is ABSENT at debug level despite turn traffic, the
    // hook isn't bound to the dispatch surface the gateway uses —
    // fall through to the multi-phase-init re-binding fix in
    // `installHooksIfNeeded`'s apiChanged branch.
    this.memoryResolverApi?.logger.debug?.(
      `[dkg] before_prompt_build fired (sessionKey=${ctx?.sessionKey ?? '∅'})`,
    );
    // Gate on slot ownership — without this, the hook would inject DKG
    // recall on every turn even when another plugin owns
    // `plugins.slots.memory`, silently bypassing the elected provider
    // (R14.2). `memoryPlugin` exists whenever memory is config-enabled,
    // but `isRegistered()` flips false when `register()` returned false
    // because the slot is owned by someone else, OR after
    // `invalidateRegistration()` is called on a later re-entry.
    if (!this.memoryPlugin || !this.memoryPlugin.isRegistered()) return undefined;

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

    const rawQuery = extractUserTextFromContent(lastUser.content);
    if (!rawQuery || rawQuery.length < 2) return undefined;
    // R16.3 — Cap the auto-recall query to bound SPARQL fan-out cost.
    // `DkgMemorySearchManager.runSearch` expands every 2+ char token into
    // the SPARQL filter; a pasted log/code block (multi-KB) would generate
    // a massive 6-query fan-out on every turn. The 250ms `Promise.race`
    // below only stops *waiting* — the queries keep running daemon-side
    // after timeout (no AbortSignal threading yet — plan N4). Truncating
    // here keeps the daemon's per-turn compute budget bounded.
    const query =
      rawQuery.length > AUTO_RECALL_QUERY_MAX_CHARS
        ? rawQuery.slice(0, AUTO_RECALL_QUERY_MAX_CHARS)
        : rawQuery;

    // T13 — Single-flight guard. If a previous turn's auto-recall is
    // still running on the daemon (the 250ms race below stopped *waiting*
    // but the underlying SPARQL queries kept executing), skip this turn's
    // recall to avoid amplifying load. The next turn that fires after
    // the in-flight recall settles gets fresh recall.
    // T14 — Key by the full conversation identity, not just sessionKey.
    // Channels can multiplex multiple conversations under one
    // sessionKey (the same composite identity that `ChatTurnWriter`
    // uses to keep per-conversation FIFO queues). Keying single-flight
    // on raw `sessionKey` would suppress recall in unrelated threads
    // when one slow conversation has work in flight. JSON.stringify
    // gives a deterministic, collision-safe key without coupling to
    // ChatTurnWriter's internal encoding.
    // T20 — Include the resolved project context graph in the key.
    // `searchNarrow` fans out across project-WM/SWM/VM and the resolver
    // returns whichever project the user has currently selected. If
    // the user switches projects mid-conversation while a recall is
    // still hanging on the daemon, the next turn must NOT be
    // suppressed under the old key — it would lose project-scoped
    // recall for the new project.
    const projectCgForKey =
      this.memorySessionResolver.getSession(ctx?.sessionKey)?.projectContextGraphId ?? '';
    const recallSessionKey = JSON.stringify([
      ctx?.channelId ?? 'unknown',
      ctx?.accountId ?? '',
      ctx?.conversationId ?? '',
      ctx?.sessionKey ?? '__default__',
      projectCgForKey,
    ]);
    if (this.autoRecallInFlight.has(recallSessionKey)) return undefined;

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
      // T13 — The single-flight set entry is held until the underlying
      // `searchNarrow` ACTUALLY settles, not until the 250ms race
      // completes. This is what bounds amplification — without
      // tracking the underlying promise, two consecutive turns with
      // sub-250ms gaps could both bypass the guard and pile on the
      // daemon.
      const recallPromise = manager.searchNarrow(query, { maxResults: 5, caller: 'hook' });
      this.autoRecallInFlight.add(recallSessionKey);
      // Fire-and-forget cleanup tied to the underlying promise. Survives
      // success, timeout, AND error.
      recallPromise
        .catch(() => undefined)
        .finally(() => { this.autoRecallInFlight.delete(recallSessionKey); });

      const hits = await Promise.race([
        recallPromise.catch(() => null),
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
    if (query.length < 2) {
      // The internal SPARQL builder strips keywords shorter than 2 chars,
      // so a 1-char query would silently return [] (looks like "no
      // results found" to the agent). Reject explicitly with the same
      // shape the tool contract documents.
      return this.error('"query" is required (non-empty string, ≥2 chars)');
    }
    const rawLimit = typeof args.limit === 'string' ? Number(args.limit) : args.limit;
    const limit = Number.isFinite(rawLimit)
      ? Math.floor(Math.max(1, Math.min(100, rawLimit as number)))
      : 20;

    // Mode-independent slot re-assertion anchor. `before_prompt_build`
    // (the W3 anchor) only fires in `full` registration mode, which means
    // a setup-runtime gateway never re-asserts. Tool execution is one of
    // the few mechanisms that DOES fire in setup-runtime, so we do an
    // opportunistic re-assert here too — cheap (one property assignment)
    // and guarantees a recently-reclaimed slot bounces back before this
    // call's read path runs.
    try { this.memoryPlugin?.reAssertCapability(); } catch { /* non-fatal */ }

    // Distinguish "memory backend not ready yet" from "no hits found".
    // `DkgMemorySearchManager.search` returns [] in BOTH cases, but they
    // mean very different things to the agent: a not-ready response
    // should prompt a retry, an empty-result response should prompt a
    // different query. The WM read path keys by the daemon's default
    // agent identity. Mirror `dkg_query`: first await the identity probe,
    // then give the peerId fallback a chance if the default identity is
    // still unavailable.
    if (this.nodeAgentAddress === undefined) {
      await this.ensureNodeAgentAddress().catch(() => {});
    }
    if (this.resolveDefaultAgentAddress() === undefined) {
      await this.ensureNodePeerId().catch(() => {});
    }
    const session = this.memorySessionResolver.getSession(undefined);
    const agentAddress = session?.agentAddress ?? this.memorySessionResolver.getDefaultAgentAddress();
    if (!agentAddress) {
      return this.error(
        'memory_search backend not ready: the node\'s agent identity has not been ' +
        'resolved yet. Retry shortly. This is normal for the first few seconds after ' +
        'gateway start while the daemon identity and peer ID probes settle. If it ' +
        'persists, check that the daemon is healthy and the node API token is valid.',
      );
    }

    try {
      const manager = new DkgMemorySearchManager({
        client: this.client,
        resolver: this.memorySessionResolver,
        logger: this.memoryResolverApi?.logger,
      });
      const hits = await manager.search(query, { maxResults: limit, caller: 'tool' });
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

  private async handleListContextGraphs(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const scope = typeof args.scope === 'string' && args.scope.trim() ? args.scope.trim() : 'mine';
      if (scope !== 'mine' && scope !== 'all') {
        return this.error('"scope" must be "mine" or "all".');
      }
      const result = await this.client.listContextGraphs();
      const graphs = filterContextGraphsForScope(result.contextGraphs ?? [], scope);
      return this.json({ contextGraphs: graphs, count: graphs.length, scope });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleQuery(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const sparql = String(args.sparql);
      // V10 is the first product launch — no v9 back-compat. Reject `contextGraph_id`
      // explicitly rather than silently widening it to `context_graph_id`, so
      // stale v9 agent code surfaces its wrong assumption instead of sending
      // an empty/garbage value that the daemon would then ignore.
      if (args.contextGraph_id !== undefined) {
        return this.error('"contextGraph_id" is not a supported parameter. Use "context_graph_id".');
      }
      // `include_shared_memory` was removed in favor of `view`. There is no
      // one-line replacement: the legacy `true` path unioned the data graph
      // with SWM (`DKGQueryEngine.query`, line ~229 — wraps the sparql in
      // both graphs and merges), while `false` used the legacy data-graph
      // path alone. `view: "shared-working-memory"` reads ONLY SWM and
      // would drop data-graph-only triples for `true` callers; `view:
      // "verifiable-memory"` has different semantics entirely. Surface the
      // break explicitly rather than pretending a clean migration exists.
      if (args.include_shared_memory !== undefined) {
        return this.error(
          '"include_shared_memory" is no longer supported. There is no exact `view` replacement ' +
            'for the legacy union-semantics: `true` previously queried the data graph ∪ SWM ' +
            '(no single `view` reproduces this union). Closest-intent replacements: omit `view` ' +
            'for the legacy data-graph path, or `view: "shared-working-memory"` for SWM-only, or ' +
            '`view: "verifiable-memory"` for on-chain data. If you need the original union exactly, ' +
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
        // Mirror the daemon's writer-side `defaultAgentAddress ?? peerId`
        // priority. First try the identity endpoint; if it has not resolved
        // yet, ensure the peerId fallback has had a chance to populate.
        if (this.nodeAgentAddress === undefined) {
          await this.ensureNodeAgentAddress().catch(() => {});
        }
        agentAddress = this.resolveDefaultAgentAddress();
        if (agentAddress === undefined) {
          await this.ensureNodePeerId().catch(() => {});
          agentAddress = this.resolveDefaultAgentAddress();
        }
        if (agentAddress === undefined) {
          return this.error(
            '"view: working-memory" requires an agent identity. Supply `agent_address` explicitly, ' +
              "or retry once the node's agent address or peer ID is available.",
          );
        }
      }
      if (view === 'working-memory' && agentAddress !== undefined) {
        // T48/T53 — `toAgentPeerId` strips the legacy `did:dkg:agent:`
        // prefix (raw eth and raw peerId are pass-through). The daemon's
        // own contract (`packages/agent/src/dkg-agent.ts:2647-2696`)
        // accepts BOTH self-aliases for the default agent: when the
        // keystore is present, writes go to `defaultAgentAddress` (eth)
        // and reads must use eth; on fresh/auth-disabled/no-keystore
        // nodes, the daemon's writer-side resolves to `peerId` and reads
        // must use peerId. Don't hard-reject non-eth values — that
        // would break legitimate WM reads on no-keystore nodes.
        const stripped = toAgentPeerId(agentAddress);
        // T65 — If the post-strip value is eth-shaped, normalize to
        // EIP-55 checksum form. The daemon stores chat-turn graph URIs
        // under `agent.defaultAgentAddress` which ethers `verifyWallet
        // .address` produces in EIP-55 form, and SPARQL graph URIs are
        // case-sensitive. A caller-supplied lowercase wallet address
        // would otherwise miss the daemon's checksum-case URI prefix
        // and silently return zero bindings even when data exists.
        // Non-eth-shaped values (peerIds, anything else) pass through
        // verbatim — daemon contract still accepts them as self-aliases.
        agentAddress = isValidEthAddressString(stripped)
          ? toEip55Checksum(stripped)
          : stripped;
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

  private async handleQueryCatalogList(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = normalizeContextGraphId(String(args.context_graph_id ?? ''));
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      const response = await this.client.readQueryCatalog(contextGraphId);
      const items = normalizeQueryCatalogItems(response);
      return this.json({
        contextGraphId,
        count: items.length,
        items,
      });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleQueryCatalogRun(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = normalizeContextGraphId(String(args.context_graph_id ?? ''));
      const selector = String(args.query ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!selector) return this.error('"query" is required.');

      const response = await this.client.readQueryCatalog(contextGraphId);
      const items = normalizeQueryCatalogItems(response);
      const slugMatches = items.filter((item) => item.slug === selector);
      const nameMatches = slugMatches.length > 0
        ? []
        : items.filter((item) => item.name === selector);
      const matches = slugMatches.length > 0 ? slugMatches : nameMatches;
      if (matches.length === 0) {
        return this.error(
          `Saved query not found: ${selector}. Available queries: ${
            items.map((item) => `${item.slug} (${item.name})`).join(', ') || 'none'
          }`,
        );
      }
      if (matches.length > 1) {
        return this.error(
          `Saved query selector is ambiguous: ${selector}. Matching slugs: ${
            matches.map((item) => item.slug).join(', ')
          }`,
        );
      }

      const savedQuery = matches[0];
      const queryOpts = savedQuery.subGraph && savedQuery.subGraph !== CONTEXT_GRAPH_QUERY_SUBGRAPH
        ? { contextGraphId, subGraphName: savedQuery.subGraph }
        : { contextGraphId };
      const result = await this.client.query(savedQuery.sparql, queryOpts);
      return this.json({
        contextGraphId,
        savedQuery,
        result,
      });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleQueryCatalogSave(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = normalizeContextGraphId(String(args.context_graph_id ?? ''));
      const name = String(args.name ?? '').trim();
      const sparql = String(args.sparql ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      if (!sparql) return this.error('"sparql" is required.');

      const operation = readOnlySparqlOperation(sparql);
      if (!operation) {
        return this.error(
          '"sparql" must be a read-only query starting with SELECT, ASK, CONSTRUCT, or DESCRIBE ' +
            'after optional PREFIX/BASE declarations.',
        );
      }

      const description = optionalString(args.description);
      const subGraph = optionalString(args.sub_graph) ?? CONTEXT_GRAPH_QUERY_SUBGRAPH;
      const catalogSlug = queryCatalogSlug(optionalString(args.catalog_slug) ?? USER_QUERY_CATALOG_SLUG);
      const catalogName = optionalString(args.catalog_name) ?? USER_QUERY_CATALOG_NAME;
      const catalogDescription = optionalString(args.catalog_description) ?? USER_QUERY_CATALOG_DESCRIPTION;
      const resultColumn = optionalString(args.result_column)?.replace(/^\?/, '');
      const rank = Date.now();
      const { savedQuery, quads } = buildQueryCatalogSaveWrite({
        contextGraphId,
        name,
        description,
        sparql,
        subGraph,
        catalogSlug,
        catalogName,
        catalogDescription,
        resultColumn,
        rank,
        catalogRank: 50,
      });
      const write = await this.client.writeQueryCatalog(contextGraphId, quads);
      return this.json({
        contextGraphId,
        operation,
        savedQuery,
        write,
      });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleFindAgents(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      // ONE boundary policy for every filter: forward the model's value
      // VERBATIM and let the daemon validate — it 400s on bad values and
      // unknown names, and that 400 comes back through daemonError() as the
      // caller's signal. Raw values go through the query escape hatch, NOT
      // through the strictly-typed getAgents(): coercing (parseInt, boolean
      // folding) or dropping a bad value would turn the daemon's 400 into a
      // silently different query — `limit: 0` becoming "no limit" is the
      // full ~150 KB registry.
      const result = await this.client.getAgentsByQuery(rawFindAgentsQuery(args));
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
      // Privacy-by-default: when `public` is omitted or false, the context
      // graph is curated (`accessPolicy: 1`). The agent's createContextGraph
      // flow auto-includes the creator's address in the allowlist (see
      // `packages/agent/src/dkg-agent.ts:3962-3973`), so the creator can
      // immediately read/write the curated CG without a self-invite step.
      // Round 2 — strict type validation on `public`. Non-boolean values
      // (e.g. `"yes"`, `1`, `null`) silently became `false` previously,
      // producing curated CGs when the LLM intended public — the opposite
      // of the agent's intent. Reject explicitly so the agent gets a
      // clear correction instead of silent miscategorization.
      const rawPublic = args.public;
      if (rawPublic !== undefined && typeof rawPublic !== 'boolean') {
        return this.error(
          `"public" must be a boolean (true or false). Got: ${typeof rawPublic}.`,
        );
      }
      const isPublic = rawPublic === true;
      // Round 2 — strict allowed_agents validation. Previously we
      // silently dropped non-string / blank entries, which hides
      // LLM-generated mistakes (e.g. `["0x1234...", 42]` would create a
      // curated graph WITHOUT 42's intended owner ever knowing they
      // were excluded). Fail fast on every malformed entry with a
      // precise index-scoped error so the agent can correct.
      let allowedAgents: string[] | undefined;
      if (!isPublic && args.allowed_agents !== undefined) {
        if (!Array.isArray(args.allowed_agents)) {
          return this.error(
            `"allowed_agents" must be an array of strings. Got: ${typeof args.allowed_agents}.`,
          );
        }
        const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
        const cleaned: string[] = [];
        for (let i = 0; i < args.allowed_agents.length; i++) {
          const entry = args.allowed_agents[i];
          if (typeof entry !== 'string') {
            return this.error(
              `"allowed_agents[${i}]" must be a string. Got: ${entry === null ? 'null' : typeof entry}.`,
            );
          }
          const trimmed = entry.trim();
          if (!trimmed) {
            return this.error(
              `"allowed_agents[${i}]" is empty or whitespace-only. ` +
              'Each entry must be a 0x-prefixed 40-hex-char Ethereum address.',
            );
          }
          if (!ethAddrRe.test(trimmed)) {
            return this.error(
              `Invalid Ethereum address in "allowed_agents[${i}]": "${entry}". ` +
              'Each entry must be a 0x-prefixed 40-hex-char string ' +
              '(e.g. "0x1234567890abcdef1234567890abcdef12345678").',
            );
          }
          cleaned.push(trimmed);
        }
        if (cleaned.length > 0) {
          allowedAgents = cleaned;
        }
      }
      const opts: { accessPolicy?: number; allowedAgents?: string[] } = {};
      if (!isPublic) {
        opts.accessPolicy = 1;
      }
      if (allowedAgents && allowedAgents.length > 0) {
        opts.allowedAgents = allowedAgents;
      }
      const result = await this.client.createContextGraph(id, name, description, opts);
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
    // R21.3 — Refresh the probe's mutable api+mode ref BEFORE the
    // install gates below. Internal-hook probe handlers were installed
    // once per event into the process-global map and closed over the
    // first `api`/`mode` they saw; after a `setup-runtime → full`
    // upgrade they continued logging via the stale logger and stale
    // mode label, exactly when the diagnostic was supposed to confirm
    // the upgrade. Reading from `this.probeCurrent` at fire time fixes
    // that without re-installing duplicate handlers.
    this.probeCurrent = { api, mode };
    const hasOn = typeof api.on === 'function';
    const hasRegisterHook = typeof api.registerHook === 'function';
    const hasGlobalHookMap = !!(globalThis as any)[Symbol.for('openclaw.internalHookHandlers')];

    api.logger.info?.(
      '[dkg-probe] register() called: mode=' + mode + ', call#=' + this.probeRegisterCallCount + ', ' +
      'api.on=' + (hasOn ? 'function' : 'undefined') + ', api.registerHook=' + (hasRegisterHook ? 'function' : 'undefined') + ', ' +
      'globalThis-hook-map=' + (hasGlobalHookMap ? 'present' : 'absent'),
    );

    // T25 — Per-api per-(mechanism, event) gating. Multi-phase init
    // hands either a fresh registry (setup-runtime → full with new api)
    // OR the SAME api with `api.on` flipped from undefined to a function
    // (in-place upgrade). Pre-fix the probe gated on api identity alone
    // and short-circuited the second case — typed-hook installs that
    // saw `hasOn === false` on call 1 stayed permanently un-installed
    // even when the upgraded api exposed `api.on` on call 2. The
    // installs map below tracks WHICH mechanism/event tuples have
    // already been bound on each api so the install loop below can
    // retry the missing tuples on later calls.
    let installs = this.probeApiInstalls.get(api);
    if (!installs) {
      installs = { typed: new Set(), hooks: new Set() };
      this.probeApiInstalls.set(api, installs);
    }

    // Helper to make a probe handler factory.
    // R21.3 — Read api+mode from `this.probeCurrent` at fire time
    // (NOT from the closure-captured `api` / `mode` at install time).
    // The internal-hook probe handlers are installed once per event
    // into the process-global hook map and survive
    // `setup-runtime → full` upgrades — without this indirection the
    // post-upgrade probe would log via the original (stale) api logger
    // and mode label, defeating the diagnostic purpose.
    const makeProbeHandler = (eventName: string, via: string) => {
      return () => {
        const key = eventName + ':' + via;
        const count = (this.probeHookFireCounts.get(key) ?? 0) + 1;
        this.probeHookFireCounts.set(key, count);
        const current = this.probeCurrent;
        const currentApi = current?.api ?? api;
        const currentMode = current?.mode ?? mode;
        currentApi.logger.info?.(
          '[dkg-probe] HOOK FIRED: event=' + eventName + ' via=' + via + ' mode=' + currentMode + ' fire#=' + count,
        );
      };
    };

    // Typed probe candidates intentionally mirror accepted lifecycle hooks.
    // Dotted aliases and typed message_* names were rejected or silent on
    // OpenClaw 2026.4.15, so probing them only adds startup warning noise.
    const typedEvents = [
      'before_prompt_build',
      'agent_end',
      'before_compaction',
      'before_reset',
    ];
    // Internal-hook map (globalThis symbol) uses colon-separated names per
    // openclaw/src/infra/outbound/deliver.ts — probing the underscore form
    // here would never observe the real internal dispatch path and would
    // falsely drive the Branch A / No-Go decision.
    const internalEvents = ['message:received', 'message:sent'];

    for (const eventName of typedEvents) {
      // T25 — Skip mechanism+event tuples already bound on this api
      // (don't double-install on re-entry). Install only what's missing,
      // which lets the second call after a setup-runtime → full upgrade
      // bind the typed-hook surface that was unavailable on call 1.
      if (hasOn && !installs.typed.has(eventName)) {
        try {
          (api as any).on(eventName, makeProbeHandler(eventName, 'api.on'));
          installs.typed.add(eventName);
        } catch (err: any) {
          api.logger.debug?.(
            '[dkg-probe] api.on(' + eventName + ') threw: ' + (err?.message ?? 'unknown error'),
          );
        }
      }
      if (hasRegisterHook && !installs.hooks.has(eventName)) {
        try {
          (api as any).registerHook(eventName, makeProbeHandler(eventName, 'api.registerHook'), { name: 'dkg-probe-' + eventName });
          installs.hooks.add(eventName);
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
            // R15.4 — Skip if this internal event already has a probe
            // handler from a prior register() call. The hook map is
            // process-global and survives api-registry rebuilds, so a
            // setup-runtime → full upgrade would otherwise install a
            // second handler and double-log every internal fire.
            if (this.probeInternalEventsInstalled.has(eventName)) {
              continue;
            }
            if (!hookMap.has(eventName)) {
              hookMap.set(eventName, []);
            }
            hookMap.get(eventName)!.push(makeProbeHandler(eventName, 'globalThis'));
            this.probeInternalEventsInstalled.add(eventName);
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
      // Validate against the daemon's ACTUAL rule (`validateAssertionName`,
      // core/src/constants.ts) — any IRI-safe name up to 256 chars, NOT a
      // lowercase-hyphen slug. Fail fast at the boundary with the daemon's exact
      // reason rather than letting the daemon 400.
      const nameValidation = validateAssertionName(name);
      if (!nameValidation.valid) {
        return this.error(`"name" is invalid: ${nameValidation.reason}`);
      }
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;

      // [D3] One-shot path: when `quads` are supplied, create → write → seal in a
      // single call via the combined KA route, optionally sharing to SWM. Stops at
      // a sealed WM draft by default; `also_share_swm:true` lands a publish-ready KA
      // in SWM. This NEVER mints to VM — there is no `alsoPublishVm` here (publish is
      // the separate dkg_knowledge_asset_publish step).
      // Validate also_share_swm's shape uniformly (parity with MCP + Hermes) — even on the
      // bare-create path where it is IGNORED — since the shared tool schema advertises a
      // boolean. Done BEFORE the quads branch so the runtime contract is consistent.
      if (args.also_share_swm !== undefined && typeof args.also_share_swm !== 'boolean') {
        return this.error('"also_share_swm" must be a boolean.');
      }
      const rawQuads = args.quads;
      if (rawQuads !== undefined) {
        if (!Array.isArray(rawQuads) || rawQuads.length === 0) {
          return this.error('"quads" must be a non-empty array of {subject, predicate, object} objects.');
        }
        // Default FALSE, passed EXPLICITLY so the createKnowledgeAsset client helper's
        // internal seal-true default (dkg-client.ts) cannot leak and silently auto-share.
        const alsoShareSwm = args.also_share_swm === true;
        // Strip surrounding <…> on subject/predicate/object before normalizing (parity
        // with the MCP + Hermes create one-shots) so a bracketed URI stays a URI rather
        // than being quoted as a literal. Then auto-type objects + pin the per-KA `graph`
        // via normalizeDkgPublisherQuads, so a one-shot create lands identical triples
        // across all three adapters.
        const stripBrackets = (t: unknown): unknown =>
          typeof t === 'string' && t.length >= 2 && t.startsWith('<') && t.endsWith('>')
            ? t.slice(1, -1)
            : t;
        const strippedQuads = (rawQuads as Array<Record<string, unknown>>).map((q) => ({
          ...q,
          subject: stripBrackets(q.subject),
          predicate: stripBrackets(q.predicate),
          object: stripBrackets(q.object),
        }));
        const quads = normalizeDkgPublisherQuads(
          strippedQuads as Parameters<typeof normalizeDkgPublisherQuads>[0],
        );
        const result = await this.client.createKnowledgeAsset(contextGraphId, name, {
          subGraphName,
          quads,
          alsoShareSwm,
        });
        // The daemon returns 207 + errors:[{phase:'swm-share'}] when create+seal lands
        // but the opt-in SWM share fails; the client treats 207 as success. Judge from
        // the OUTCOME, not the requested flag, so agents don't publish an asset that
        // never reached SWM (parity with the MCP adapter's 207 handling).
        const r = result as Record<string, unknown>;
        const resultErrors = Array.isArray(r.errors)
          ? (r.errors as Array<{ phase?: string; error?: string }>)
          : [];
        const shareError = resultErrors.find((e) => e?.phase === 'swm-share');
        if (alsoShareSwm && (shareError || r.publishReady === false)) {
          return this.error(
            `Created and sealed knowledge asset "${name}" in "${contextGraphId}", but the opt-in ` +
            `Shared Working Memory share FAILED${shareError?.error ? `: ${shareError.error}` : ''}. ` +
            `The asset did NOT reach Shared Working Memory and is NOT publish-ready — do not publish yet; ` +
            `retry the share with dkg_knowledge_asset_share, then publish.`,
          );
        }
        return this.json(result);
      }

      // No quads → the unchanged bare create. Stays on the legacy assertion route: it
      // preserves the `{ assertionUri, alreadyExists }` contract and name validation
      // that the KA create route (an idempotent get-or-create) can't yet provide.
      const result = await this.publisher.createLocalWorkspace({
        contextGraphId,
        assertionName: name,
        subGraphName,
      });
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
      // Append to the KA's WM draft (the draft must already exist — same as
      // the legacy createIfMissing:false write). Normalize the quads (N-Triples
      // ECHAR escaping of literal objects) exactly as the legacy publisher path
      // did before handing off to the daemon.
      const result = await this.client.knowledgeAssetWrite(
        contextGraphId,
        name,
        normalizeDkgPublisherQuads(rawQuads as Parameters<typeof normalizeDkgPublisherQuads>[0]),
        { subGraphName },
      );
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleAssertionFinalize(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      if (args.layer === 'swm') {
        return this.error('Legacy root-scoped Knowledge Assets are read-only.');
      }
      if (args.layer !== undefined && args.layer !== 'wm') {
        return this.error('Only Working Memory finalization is supported.');
      }
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      const authorAgentAddress = args.author_agent_address ? String(args.author_agent_address) : undefined;
      // CONTRACT §C: present-but-invalid is a tool error, never silent-default.
      // `scheme_version` must be a POSITIVE integer (daemon Number.isInteger && >= 1).
      let schemeVersion: number | undefined;
      if (args.scheme_version !== undefined) {
        const raw = typeof args.scheme_version === 'string' ? Number(args.scheme_version.trim()) : args.scheme_version;
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
          return this.error('"scheme_version" must be a positive integer.');
        }
        schemeVersion = raw;
      }
      // Seal the WHOLE WM draft (CONTRACT §1 Stage3 — there is no subset scope on
      // finalize). The author defaults to the request token's agent when
      // `author_agent_address` is omitted; pre-signed attestations are not surfaced
      // on this tool (they require the packed reservedKaId — out of scope here).
      const result = await this.client.knowledgeAssetFinalize(contextGraphId, name, {
        subGraphName,
        authorAgentAddress,
        schemeVersion,
      });
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
      if (Array.isArray(args.entities)) {
        return this.error('Knowledge Assets are shared atomically; root-entity selection is not supported.');
      }
      if (args.entities !== undefined && args.entities !== 'all') {
        return this.error('"entities" is retired; omit it to share the complete Knowledge Asset.');
      }
      if (args.skip_seal === true) {
        return this.error('Knowledge Assets are always sealed before sharing.');
      }
      if (args.skip_seal !== undefined && args.skip_seal !== false) {
        return this.error('"skip_seal" must be a boolean when supplied.');
      }
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      const result = await this.client.knowledgeAssetShare(contextGraphId, name, {
        subGraphName,
      });
      const seal = result as { publishReady?: boolean; sealed?: boolean };
      const warning = result
        ? classifyShareWarning({ sealed: seal.sealed, publishReady: seal.publishReady, isSubset: false })
        : undefined;
      if (warning) {
        return this.json({ ...result, warning });
      }
      return this.json(result);
    } catch (err: any) {
      // #1116: a default (sealing) share that cannot seal fails CLOSED — the
      // daemon returns 409 UNSEALED_SHARE_BLOCKED with a recovery hint and WM
      // preserved. Normalize old-daemon hints that recommend retired
      // skipSeal/SWM-write modes to the supported atomic recovery.
      const recovery = extractUnsealedShareRecovery(err);
      if (recovery) return this.error(recovery);
      return this.daemonError(err);
    }
  }

  private async handleAssertionPublish(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;

      // CONTRACT §C: a present-but-invalid numeric is a tool error, never a
      // silent default. `publish_epochs` must be a POSITIVE integer (daemon
      // /^[1-9]\d*$/ + MAX_PUBLISH_EPOCHS cap).
      let publishEpochs: number | undefined;
      if (args.publish_epochs !== undefined) {
        const raw = typeof args.publish_epochs === 'string' ? Number(args.publish_epochs.trim()) : args.publish_epochs;
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
          return this.error('"publish_epochs" must be a positive integer.');
        }
        publishEpochs = raw;
      }
      // CONTRACT §C: `publisher_node_identity_id_override` must be a NON-NEGATIVE
      // integer (daemon /^\d+$/). BigInt() alone accepts "-1" / "0x.." — validate
      // explicitly first, then carry as a bigint.
      let publisherNodeIdentityIdOverride: bigint | undefined;
      if (args.publisher_node_identity_id_override !== undefined) {
        const raw = String(args.publisher_node_identity_id_override).trim();
        if (!/^\d+$/.test(raw)) {
          return this.error('"publisher_node_identity_id_override" must be a non-negative integer (decimal string).');
        }
        publisherNodeIdentityIdOverride = BigInt(raw);
      }

      // CONTRACT §D: `clear_shared_memory_after` is NOT exposed on the per-asset
      // publish tool — on vm/publish it is graph-wide destructive (wipes every
      // other agent's unpublished SWM in the CG/sub-graph). The this-asset SWM
      // cleanup runs unconditionally regardless; there is no agent-facing CG-wide
      // SWM clear (the legacy bridge tools that carried it were removed in #1087).

      if (args.register_if_needed !== undefined && typeof args.register_if_needed !== 'boolean') {
        return this.error('"register_if_needed" must be a boolean.');
      }
      const registerIfNeeded = args.register_if_needed === true;
      if (args.access_policy !== undefined && args.access_policy !== 0 && args.access_policy !== 1) {
        return this.error('"access_policy" must be 0 (open) or 1 (private).');
      }
      // FIX S: `access_policy` only applies when registering the CG — reject it
      // (rather than silently drop the privacy setting) when register_if_needed
      // is not true.
      if (args.access_policy !== undefined && !registerIfNeeded) {
        return this.error('"access_policy" requires "register_if_needed": true — it only applies when registering the context graph.');
      }

      // CONTRACT §G: vm/publish AUTO-registers an unregistered CG transparently
      // (#1116) at gas/TRAC cost regardless of `register_if_needed`. When
      // `register_if_needed` is true we run an EXPLICIT register first (idempotent —
      // "already registered" is success) so the caller can choose the registration's
      // access_policy. A hard registration failure is a tool error: do NOT publish.
      // When false/omitted, publish directly — the daemon auto-registers and defaults
      // the policy.
      const registration = registerIfNeeded
        ? await this.registerContextGraphIfNeeded(contextGraphId, args.access_policy as number | undefined)
        : undefined;

      // Per-KA sealed publish (CONTRACT §1 Stage5). The seal selects the author and
      // the whole asset, so author/selection overrides are never sent. The daemon
      // returns the UAL plus kaId/txHash/status/kas; 409 VM_PUBLISH_PRECONDITION
      // (not finalized / empty SWM) and 502 (on-chain not-confirmed) surface
      // verbatim through daemonError.
      const result = await this.client.knowledgeAssetPublish(contextGraphId, name, {
        subGraphName,
        publishEpochs,
        publisherNodeIdentityIdOverride,
      });
      const merged = registration ? { ...result, registration } : result;

      // CONTRACT §1 Stage5 / §7: vm/publish returns HTTP 207 (treated as success by
      // the HTTP client) when the KA minted on-chain but the context-graph binding
      // FAILED — `contextGraphError` is present in the body. The UAL/kaId are valid
      // and the asset IS published on-chain, so this is NOT a hard failure and must
      // NOT be reported as full success — but the agent must NOT re-publish: a
      // confirmed publish clears SWM, so a re-publish 409s VM_PUBLISH_PRECONDITION
      // (and never re-binds the CG). The CG-binding retry is an operator/daemon
      // concern; surface the partial for a human to follow up.
      const contextGraphError =
        merged && typeof merged === 'object'
          ? (merged as Record<string, unknown>).contextGraphError
          : undefined;
      if (typeof contextGraphError === 'string' && contextGraphError.length > 0) {
        return this.json({
          ...(merged as Record<string, unknown>),
          partial: true,
          warning:
            'Partial publish: the knowledge asset IS published on-chain (the UAL/kaId are valid and final) ' +
            `— only the context-graph binding failed (${contextGraphError}). Do NOT re-publish: the asset is ` +
            'already minted, the publish cleared Shared Working Memory, and a retry will fail the VM ' +
            'precondition without re-binding the context graph. Surface this to the operator to re-attempt the ' +
            'context-graph binding.',
        });
      }
      return this.json(merged);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleAssertionPullFrom(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      const name = String(args.name ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      if (!name) return this.error('"name" is required.');
      const layer = String(args.layer ?? '').trim();
      if (layer !== 'swm' && layer !== 'vm') {
        return this.error('"layer" is required and must be "swm" or "vm".');
      }
      let onConflict: 'reject' | 'replace' | undefined;
      if (args.on_conflict !== undefined) {
        const raw = String(args.on_conflict).trim();
        if (raw !== 'reject' && raw !== 'replace') {
          return this.error('"on_conflict" must be "reject" or "replace".');
        }
        onConflict = raw;
      }
      const subGraphName = args.sub_graph_name ? String(args.sub_graph_name) : undefined;
      // Seed a fresh WM draft from SWM/VM (CONTRACT §1 side-verbs). A dirty draft
      // → 409 WM_DRAFT_CONFLICT, surfaced verbatim through daemonError; the agent
      // can retry with on_conflict:"replace".
      const result = await this.client.knowledgeAssetPullFrom(contextGraphId, name, layer, {
        subGraphName,
        onConflict,
      });
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
      const result = await this.client.knowledgeAssetDiscard(contextGraphId, name, {
        subGraphName,
      });
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

  private async handleImportArtifactResolve(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      const assertionUri = String(args.assertion_uri ?? args.source_assertion_uri ?? '').trim() || undefined;
      const assertionName = String(args.assertion_name ?? '').trim() || undefined;
      if (!assertionUri) return this.error('"assertion_uri" is required.');
      const result = await this.client.resolveImportArtifact({
        contextGraphId,
        assertionUri,
        assertionName,
        fileHash: String(args.file_hash ?? '').trim() || undefined,
        subGraphName: String(args.sub_graph_name ?? '').trim() || undefined,
      });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleImportArtifactReadMarkdown(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      const assertionUri = String(args.assertion_uri ?? args.source_assertion_uri ?? '').trim() || undefined;
      const assertionName = String(args.assertion_name ?? '').trim() || undefined;
      if (!assertionUri) return this.error('"assertion_uri" is required.');
      let maxBytes: number | undefined;
      if (args.max_bytes !== undefined) {
        const rawMaxBytes = typeof args.max_bytes === 'string' && args.max_bytes.trim()
          ? Number(args.max_bytes.trim())
          : args.max_bytes;
        if (typeof rawMaxBytes !== 'number' || !Number.isInteger(rawMaxBytes) || rawMaxBytes <= 0) {
          return this.error('"max_bytes" must be a positive integer.');
        }
        maxBytes = rawMaxBytes;
      }
      const result = await this.client.readImportArtifactMarkdown({
        contextGraphId,
        assertionUri,
        assertionName,
        fileHash: String(args.file_hash ?? '').trim() || undefined,
        subGraphName: String(args.sub_graph_name ?? '').trim() || undefined,
        maxBytes,
      });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleSemanticEnrichmentWrite(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? '').trim();
      if (!contextGraphId) return this.error('"context_graph_id" is required.');
      const assertionUri = String(args.assertion_uri ?? args.source_assertion_uri ?? '').trim() || undefined;
      const assertionName = String(args.assertion_name ?? '').trim() || undefined;
      if (!assertionUri) return this.error('"assertion_uri" is required.');
      if (
        args.name !== undefined ||
        args.semanticAssertionName !== undefined ||
        args.semantic_assertion_name !== undefined
      ) {
        return this.error('Semantic enrichment is written into the source import assertion; target assertion names are not supported.');
      }
      const normalized = normalizeSemanticEnrichmentQuads(args.semantic_quads);
      if (normalized.error || !normalized.quads) return this.error(normalized.error ?? '"semantic_quads" is invalid.');
      const result = await this.client.writeSemanticEnrichment({
        contextGraphId,
        assertionUri,
        assertionName,
        fileHash: String(args.file_hash ?? '').trim() || undefined,
        semanticQuads: normalized.quads,
        generationMethod: String(args.generation_method ?? '').trim() || undefined,
        agentIdentity: String(args.agent_identity ?? '').trim() || undefined,
        generatedAt: String(args.generated_at ?? '').trim() || undefined,
        subGraphName: String(args.sub_graph_name ?? '').trim() || undefined,
      });
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
      // Read stays on the legacy assertion route: the KA GET surface is keyed
      // by (contextGraph, name) only and cannot resolve another author's
      // history, so keep `agent_address` author-scoping here.
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
}
