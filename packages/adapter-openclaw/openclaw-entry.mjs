import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DkgNodePlugin,
  extractAdapterPluginConfigOverlay,
  isObjectRecord,
  isPartialAdapterConfigOverlay,
  isStateMetadataOnlyAdapterConfig,
  mergeAdapterPluginConfigs,
  sameResolvedPath,
} from './dist/index.js';

/** Module-level singleton - prevents duplicate registration during gateway multi-phase init. */
let instance = null;
const lifecycleServiceApis = new WeakMap();
// Tracks api → marker so apiWorkspaceDirFrom can distinguish values
// we wrote from values the gateway/third party set. The defineProperty
// setter clears the marker on ANY third-party write (even one that
// matches the entry-assigned value), so subsequent reads correctly
// fall through to auto-detection.
const entryAssignedWorkspaceDirMarkers = new WeakMap();
// T364 round 9 — fallback value tracking for the rare future gateway
// version where api.workspaceDir is non-configurable (defineProperty
// throws). The catch branch in setEntryAssignedWorkspaceDir registers
// here instead of via the marker; apiWorkspaceDirFrom then compares
// values to detect third-party writes that change the value. Codex
// flagged that a hard defineProperty assumed the property was always
// configurable plain data — graceful degradation here means a future
// OpenClaw API that locks the property doesn't throw plugin load.
const entryAssignedWorkspaceDirValues = new WeakMap();
let lifecycleOwnerToken = null;

export default function (api) {
  const log = api.logger ?? console;
  const { config, bootstrapConfig, workspaceDir, apiWorkspaceDir, configIsPartial } = resolveEntryConfig(api, {
    hasInstance: instance !== null,
  });

  // Pass only runtime/cfg workspace evidence to the API for auto-detection.
  // `installedWorkspace` remains setup metadata consumed by DkgNodePlugin's
  // resolver; writing it onto api.workspaceDir would make it look like a live
  // runtime workspace and could mask a later higher-priority runtime value.
  if (apiWorkspaceDir) {
    setEntryAssignedWorkspaceDir(api, apiWorkspaceDir);
  } else {
    clearEntryAssignedWorkspaceDir(api);
  }

  if (instance) {
    log.info?.('[dkg-entry] Re-registering plugin surfaces (channel, memory, tools) into new registry (gateway multi-phase init)');
    if (registrationModeEnablesRuntime(api)) {
      instance.updateConfig?.(config, { partial: configIsPartial });
    } else {
      log.debug?.('[dkg-entry] Deferred singleton config update during metadata-only registration pass');
    }
    instance.register(api);
    registerLifecycleService(api, log);
    if (registrationModeEnablesRuntime(api)) {
      syncSkillToWorkspace(workspaceDir, log);
    }
    return;
  }

  log.info?.(
    `[dkg-entry] config (from OpenClaw plugin config) - daemonUrl: ${bootstrapConfig.daemonUrl ?? 'http://127.0.0.1:9200'}, `
      + `memory.enabled: ${bootstrapConfig.memory?.enabled}, `
      + `channel.enabled: ${bootstrapConfig.channel?.enabled}, `
      + `registrationMode: ${api.registrationMode ?? 'full'}`,
  );

  const dkg = new DkgNodePlugin(bootstrapConfig);
  dkg.register(api);
  instance = dkg;
  registerLifecycleService(api, log);

  // Sync SKILL.md to workspace so the agent always reads the latest version.
  // The CLI dist ships the canonical template; the workspace copy goes stale
  // after adapter/CLI upgrades unless re-synced. This runs on every plugin
  // load, is idempotent (skips when content matches), and non-fatal.
  if (registrationModeEnablesRuntime(api)) {
    syncSkillToWorkspace(workspaceDir, log);
  }

  log.info?.('[dkg-entry] DkgNodePlugin registered');
}

function resolveEntryConfig(api, options = {}) {
  const anyApi = api;
  const runtime = anyApi?.runtime;
  const currentFullConfigCandidatesMostToLeast = [
    anyApi?.cfg,
    anyApi?.config,
  ].filter(isObjectRecord);
  const currentFullConfigCandidatesLeastToMost = [
    anyApi?.config,
    anyApi?.cfg,
  ].filter(isObjectRecord);
  const fallbackFullConfigCandidatesMostToLeast = [
    runtime?.cfg,
    runtime?.config,
  ].filter(isObjectRecord);
  const currentWorkspaceConfig = currentFullConfigCandidatesMostToLeast.find(hasWorkspaceConfig);
  const fallbackWorkspaceConfig = fallbackFullConfigCandidatesMostToLeast.find(hasWorkspaceConfig);
  const currentEntryConfigs = currentFullConfigCandidatesLeastToMost
    .map((candidate) => candidate?.plugins?.entries?.['adapter-openclaw']?.config)
    .filter(isObjectRecord);
  const fallbackConfigSources = [
    directPluginConfigFrom(runtime?.pluginConfig),
    ...adapterConfigSourcesFromFullConfig(runtime?.config),
    ...adapterConfigSourcesFromFullConfig(runtime?.cfg),
  ].filter(isObjectRecord);
  const currentDirectApiConfigs = [
    directApiConfigFrom(anyApi?.config),
    directApiConfigFrom(anyApi?.cfg),
  ].filter(isObjectRecord);
  const hasCurrentDirectApiConfig = currentDirectApiConfigs.length > 0;
  const currentPluginConfig = directPluginConfigFrom(anyApi?.pluginConfig);
  const strongestCurrentDirectApiConfig = currentDirectApiConfigs[currentDirectApiConfigs.length - 1];
  const strongestCurrentDirectApiConfigIsMetadataOnly =
    isStateMetadataOnlyAdapterConfig(strongestCurrentDirectApiConfig);
  // T364 round 12 — layer `api.pluginConfig` underneath ANY partial
  // current direct config, not only the metadata-only case. Pre-fix
  // `currentPluginConfigForMetadataDirect` was set only when the
  // strongest direct was state-metadata-only. For a mixed gateway
  // payload that extracts to a partial overlay (e.g.
  // `{ workspaceDir, channel: { port: 9801 } }` → `{ channel: { port: 9801 } }`),
  // the helper returned undefined and `currentDirectApiConfigSources`
  // collapsed to just the overlay — `api.pluginConfig`'s
  // `daemonUrl` / `memory.enabled` / `channel.enabled` were dropped on
  // the floor. Strip state metadata from `pluginConfig` only in the
  // metadata-only case (so the strongest direct's state metadata
  // wins via merge order); otherwise pass `pluginConfig` through
  // verbatim so its base values flow under the partial overlay.
  const strongestCurrentDirectApiConfigIsPartial =
    isPartialAdapterConfigOverlay(strongestCurrentDirectApiConfig);
  const currentPluginConfigForDirectLayering = strongestCurrentDirectApiConfigIsPartial
    ? (strongestCurrentDirectApiConfigIsMetadataOnly
        ? stripStateMetadataFromAdapterConfig(currentPluginConfig)
        : currentPluginConfig)
    : undefined;
  const currentDirectApiConfigSources =
    hasCurrentDirectApiConfig &&
    strongestCurrentDirectApiConfigIsPartial &&
    isObjectRecord(currentPluginConfigForDirectLayering)
      ? [
          ...(isPartialAdapterConfigOverlay(currentPluginConfigForDirectLayering)
            ? currentDirectApiConfigs.slice(0, -1)
            : currentDirectApiConfigs.slice(0, -1).filter(isStateMetadataOnlyAdapterConfig)),
          currentPluginConfigForDirectLayering,
          strongestCurrentDirectApiConfig,
        ].filter(isObjectRecord)
      : currentDirectApiConfigs;
  const strongestCurrentEntryConfig = currentEntryConfigs[currentEntryConfigs.length - 1];
  const strongestCurrentEntryConfigIsMetadataOnly =
    isStateMetadataOnlyAdapterConfig(strongestCurrentEntryConfig);
  const currentPluginConfigForMetadataEntry =
    strongestCurrentEntryConfigIsMetadataOnly
      ? stripStateMetadataFromAdapterConfig(currentPluginConfig)
      : currentPluginConfig;
  // T364 — Always layer api.pluginConfig over current entry configs, not
  // only when the entry config is metadata-only. Pre-fix the third
  // ternary returned `[]` when the current entry config was a full
  // adapter config, so a fresher api.pluginConfig with updated
  // daemonUrl / memory / channel was dropped on the floor — the
  // singleton kept the stale entry-config values until a later pass
  // rebuilt the merged snapshot. `currentPluginConfigForMetadataEntry`
  // already strips state metadata in the metadata-only-entry case
  // (line 126-129), so the merge is safe in both branches.
  const currentDirectConfigs = hasCurrentDirectApiConfig
    ? currentDirectApiConfigSources
    : [currentPluginConfigForMetadataEntry].filter(isObjectRecord);
  const currentDirectConfigsArePartialOverlays =
    currentDirectConfigs.length > 0 &&
    currentDirectConfigs.every(isPartialAdapterConfigOverlay);
  const hasCurrentConfigSource = currentEntryConfigs.length > 0 || currentDirectConfigs.length > 0;
  const currentConfigSourcesForMerge =
    !hasCurrentDirectApiConfig &&
    strongestCurrentEntryConfigIsMetadataOnly &&
    currentDirectConfigs.length > 0
      ? [
          ...(currentDirectConfigsArePartialOverlays
            ? currentEntryConfigs.slice(0, -1)
            : currentEntryConfigs.slice(0, -1).filter(isStateMetadataOnlyAdapterConfig)),
          ...currentDirectConfigs,
          strongestCurrentEntryConfig,
        ].filter(isObjectRecord)
      : [
          ...currentEntryConfigs,
          ...(currentDirectConfigs.length > 0 ? currentDirectConfigs : []),
        ];
  const configSources = hasCurrentConfigSource
    ? currentConfigSourcesForMerge
    : fallbackConfigSources;
  const config = mergeAdapterPluginConfigs(...configSources);
  const hasConfigSource = configSources.length > 0;
  const configIsPartial =
    !hasConfigSource ||
    configSources.every(isPartialAdapterConfigOverlay);
  const currentConfigSources = [
    ...currentEntryConfigs,
    ...currentDirectConfigs,
  ];
  const daemonUrlFromCurrentConfig = currentConfigSources.some((candidate) =>
    Object.prototype.hasOwnProperty.call(candidate, 'daemonUrl')
  );
  const daemonUrlFromEnv = !!process.env.DKG_DAEMON_URL;
  // T364 follow-up — pair `dkgHome` with the source that supplied the
  // winning `daemonUrl`. Pre-fix `dkgHomeFromCurrentConfig` was true
  // whenever ANY current source had `dkgHome`, even when a higher-
  // priority overlay changed only `daemonUrl` (or `DKG_DAEMON_URL`
  // overrode it). The stale lower-priority `dkgHome` then survived
  // through `mergeAdapterPluginConfigs`, leaving the client pointed
  // at the new daemon URL while still reading auth from the old home.
  // Treat `dkgHome` as "current" only when the winning daemonUrl
  // source also supplied it: env (which never supplies dkgHome) wins
  // → false; otherwise check the highest-priority current source that
  // has `daemonUrl`.
  const winningCurrentDaemonUrlSource = (() => {
    for (let i = currentConfigSources.length - 1; i >= 0; i--) {
      if (Object.prototype.hasOwnProperty.call(currentConfigSources[i], 'daemonUrl')) {
        return currentConfigSources[i];
      }
    }
    return undefined;
  })();
  const dkgHomeFromCurrentConfig =
    !daemonUrlFromEnv &&
    !!winningCurrentDaemonUrlSource &&
    Object.prototype.hasOwnProperty.call(winningCurrentDaemonUrlSource, 'dkgHome');

  if (process.env.DKG_DAEMON_URL) {
    config.daemonUrl = process.env.DKG_DAEMON_URL;
  }
  const fallbackConfig = mergeAdapterPluginConfigs(...fallbackConfigSources);
  // Reset gate fires whenever a winning `daemonUrl` is not paired with
  // a `dkgHome` from the same source. Drop the `configIsPartial`
  // precondition: a full lower-priority current entry can still carry
  // a stale `dkgHome` when a higher-priority direct overlay changes
  // only `daemonUrl`, and clamping that requires the same reset path.
  if ((daemonUrlFromEnv || daemonUrlFromCurrentConfig) && !dkgHomeFromCurrentConfig) {
    delete fallbackConfig.dkgHome;
    // Drop any lower-priority current `dkgHome` that survived the
    // current-source merge — the winning daemonUrl source did not
    // supply it, so pairing the stale value with the new daemonUrl
    // through `bootstrapConfig` would mismatch auth and daemon.
    delete config.dkgHome;
    config.dkgHome = undefined;
  }
  // T364 round 11 — carry forward setup metadata from fallback when
  // current doesn't supply it. Pre-fix a "full" current adapter config
  // like `{ daemonUrl, memory, channel }` was classified as
  // `configIsPartial = false`, so `bootstrapConfig = config` ended up
  // with no `stateDir` / `stateDirSource` / `installedWorkspace` even
  // when the fallback runtime entry had them — and
  // `DkgNodePlugin.ensureChatTurnWriter()` fell back to `~/.openclaw`
  // and persisted watermarks in the wrong place. Setup metadata is
  // orthogonal to the daemon/memory/channel adapter decisions; carry
  // it forward independent of the partial/full classification so it's
  // present on both `config` (passed to subsequent `updateConfig`) and
  // `bootstrapConfig` (passed to `new DkgNodePlugin`).
  for (const key of ['stateDir', 'stateDirSource', 'installedWorkspace']) {
    if (Object.prototype.hasOwnProperty.call(fallbackConfig, key) &&
        !Object.prototype.hasOwnProperty.call(config, key)) {
      config[key] = fallbackConfig[key];
    }
  }
  const bootstrapConfig = configIsPartial
    ? mergeAdapterPluginConfigs(fallbackConfig, config)
    : config;

  const apiWorkspaceDir = apiWorkspaceDirFrom(anyApi);
  // T364 round 9 — read setup metadata from `bootstrapConfig`, not raw
  // `config`. `config` only carries the merged CURRENT sources, so a
  // partial overlay update (e.g. `api.pluginConfig = { channel: { port: 9801 } }`)
  // has neither `installedWorkspace` nor `stateDirSource`/`stateDir`.
  // Pre-fix `currentRouteWorkspaceIsStale` then stayed false for
  // partial-overlay updates and we kept stamping/syncing against a
  // stale `api.cfg.workspace` even when fallback runtime config
  // already had the setup metadata to reject it. `bootstrapConfig`
  // merges fallback under current when partial, so partial overlays
  // inherit the fallback metadata for this stale-workspace check.
  const installedWorkspaceDir = typeof bootstrapConfig.installedWorkspace === 'string'
    ? bootstrapConfig.installedWorkspace
    : undefined;
  const currentWorkspaceDir = workspaceDirFromConfig(currentWorkspaceConfig);
  const fallbackWorkspaceDir = workspaceDirFromConfig(fallbackWorkspaceConfig);
  const currentDirectConfigMatchesInstalledWorkspace = currentDirectConfigs.some((candidate) =>
    setupDefaultStateMetadataMatchesWorkspace(candidate, installedWorkspaceDir)
  );
  // Entry setup metadata can reject stale lower-priority api.config route
  // workspaces, but it must not mark the strongest api.cfg route workspace stale.
  const currentEntryConfigMatchesInstalledWorkspace =
    currentWorkspaceConfig !== anyApi?.cfg &&
    currentEntryConfigs.some((candidate) =>
      setupDefaultStateMetadataMatchesWorkspace(candidate, installedWorkspaceDir)
    );
  const currentWorkspaceMatchesConfiguredStateDir =
    stateDirMatchesWorkspaceDefault(bootstrapConfig.stateDir, currentWorkspaceDir);
  // T364 — Gate the stale-route fallback on setup-owned stateDir values.
  // Pre-fix this check also fired for operator-owned stateDir paths
  // (custom `config.stateDir` pointing outside the workspace default).
  // For those, `stateDirMatchesWorkspaceDefault` is always false, so a
  // live `agents.defaults.workspace` would be discarded and `workspaceDir`
  // / SKILL sync would fall back to `installedWorkspace` or older runtime
  // metadata — even when the live workspace was correct. Only treat the
  // current workspace as stale when the stateDir IS a setup-owned default
  // (i.e., stateDirSource === 'setup-default'); otherwise the operator
  // owns the stateDir path and the workspace stale check shouldn't fire.
  const stateDirSourceIsSetupDefault = bootstrapConfig.stateDirSource === 'setup-default';
  const currentRouteWorkspaceIsStale =
    (currentDirectConfigMatchesInstalledWorkspace || currentEntryConfigMatchesInstalledWorkspace) &&
    !!installedWorkspaceDir &&
    !!currentWorkspaceDir &&
    stateDirSourceIsSetupDefault &&
    !currentWorkspaceMatchesConfiguredStateDir;
  const configWorkspaceDir = currentRouteWorkspaceIsStale
    ? fallbackWorkspaceDir
    : currentWorkspaceDir ?? fallbackWorkspaceDir;
  const workspaceDir = apiWorkspaceDir ?? configWorkspaceDir ?? installedWorkspaceDir;
  const apiWorkspaceDirToAssign = apiWorkspaceDir ? undefined : configWorkspaceDir;
  return { config, bootstrapConfig, workspaceDir, apiWorkspaceDir: apiWorkspaceDirToAssign, configIsPartial };
}

function apiWorkspaceDirFrom(api) {
  if (typeof api?.workspaceDir !== 'string') return undefined;
  // Primary path: marker present means we hold the defineProperty
  // accessor and no third-party write has cleared the marker. Any
  // third-party write — even one that assigns the same value — fires
  // the setter and removes the marker, so subsequent reads correctly
  // fall through to auto-detection.
  if (entryAssignedWorkspaceDirMarkers.has(api)) return undefined;
  // Fallback path: marker missing but value tracking present means the
  // defineProperty install failed (non-configurable property on a
  // future gateway) and we're tracking by value. Treat as
  // entry-assigned only if the value still matches; a third-party
  // write that changes the value clears this match. (Same-value
  // third-party writes are indistinguishable from no-op in this path,
  // which is acceptable — the marker path handles that case for the
  // common gateway shape.)
  const entryAssigned = entryAssignedWorkspaceDirValues.get(api);
  if (entryAssigned !== undefined && entryAssigned === api.workspaceDir) {
    return undefined;
  }
  return api.workspaceDir;
}

function hasWorkspaceConfig(config) {
  // T364 follow-up: include `workspaceDir` (the third entry in setup.ts's
  // recognized fallback chain `agents.defaults.workspace -> workspace ->
  // workspaceDir` at setup.ts:166-190). Pre-fix `hasWorkspaceConfig` and
  // `workspaceDirFromConfig` ignored `workspaceDir`, so cfg shapes that
  // exposed only that field never populated `api.workspaceDir` and
  // `ensureChatTurnWriter` / SKILL sync fell back to `installedWorkspace`
  // or `~/.openclaw`, writing adapter state into the wrong workspace.
  // Companion fix to the same recognition added in `openclaw-config.ts`'s
  // `hasRouteMetadataConfigSignal`.
  //
  // T364 round 10 — require non-empty trimmed values. Pre-fix an empty
  // string `workspaceDir`/`workspace` (or whitespace-only) counted as a
  // workspace signal and suppressed the fallback chain, leaving
  // `workspaceDir` empty and `syncSkillToWorkspace` writing to
  // `./skills/...` under the process CWD.
  return (
    isNonEmptyString(config?.agents?.defaults?.workspace) ||
    isNonEmptyString(config?.workspace) ||
    isNonEmptyString(config?.workspaceDir)
  );
}

function workspaceDirFromConfig(config) {
  // T364 round 10 — only return a non-empty trimmed string per alias.
  // Empty / whitespace-only values fall through to the next alias so the
  // resolver chain `agents.defaults.workspace -> workspace -> workspaceDir`
  // never lands on an empty workspace.
  if (isNonEmptyString(config?.agents?.defaults?.workspace)) {
    return config.agents.defaults.workspace;
  }
  if (isNonEmptyString(config?.workspace)) return config.workspace;
  if (isNonEmptyString(config?.workspaceDir)) return config.workspaceDir;
  return undefined;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stateDirMatchesWorkspaceDefault(stateDir, workspaceDir) {
  if (typeof stateDir !== 'string' || typeof workspaceDir !== 'string') return false;
  // T364 follow-up: use canonical-path comparison so symlinked
  // workspaces and macOS realpath aliases compare equal. Pre-fix the
  // raw `normalizePath` only handled separators / trailing slashes,
  // so the same workspace exposed via a symlink would fail the match
  // and the live route workspace would be treated as stale —
  // pushing SKILL sync / watermark state back to `installedWorkspace`
  // even when the live workspace was correct. `sameResolvedPath`
  // (re-exported from state-dir-path.ts) wraps `realpathSync` with
  // missing-parts tolerance and platform-aware case normalization.
  return (
    sameResolvedPath(stateDir, join(workspaceDir, '.dkg-adapter')) ||
    sameResolvedPath(stateDir, join(workspaceDir, '.openclaw'))
  );
}

function setupDefaultStateMetadataMatchesWorkspace(config, workspaceDir) {
  return (
    config?.stateDirSource === 'setup-default' &&
    config?.installedWorkspace === workspaceDir &&
    stateDirMatchesWorkspaceDefault(config?.stateDir, workspaceDir)
  );
}

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function setEntryAssignedWorkspaceDir(api, workspaceDir) {
  // T364 round 9 — try `Object.defineProperty` first (preserves the
  // pre-existing same-value third-party write detection via the
  // setter callback) and fall back to plain assignment + value
  // tracking when the property is non-configurable on a future
  // gateway. Codex flagged that a hard defineProperty assumed the
  // property was always a configurable plain data property; the
  // try/catch here makes the install graceful so plugin load doesn't
  // throw if a future OpenClaw API exposes `workspaceDir` via a
  // non-configurable own property or its own accessor.
  const marker = {};
  let currentValue = workspaceDir;
  entryAssignedWorkspaceDirMarkers.set(api, marker);
  try {
    Object.defineProperty(api, 'workspaceDir', {
      configurable: true,
      enumerable: true,
      get() {
        return currentValue;
      },
      set(value) {
        currentValue = value;
        if (entryAssignedWorkspaceDirMarkers.get(api) === marker) {
          entryAssignedWorkspaceDirMarkers.delete(api);
        }
      },
    });
    // Marker path is in effect; clear any stale value-track entry from
    // a previous fallback round so apiWorkspaceDirFrom doesn't double-count.
    entryAssignedWorkspaceDirValues.delete(api);
  } catch {
    // Property is non-configurable (or has its own non-overridable
    // accessor) on this gateway. Drop the marker — the setter we
    // tried to install isn't there to clear it — and switch to value
    // tracking. If the plain assignment also throws (read-only),
    // accept the existing api.workspaceDir as the resolver answer.
    entryAssignedWorkspaceDirMarkers.delete(api);
    try {
      api.workspaceDir = workspaceDir;
    } catch { /* read-only — accept existing value */ }
    entryAssignedWorkspaceDirValues.set(api, workspaceDir);
  }
}

function clearEntryAssignedWorkspaceDir(api) {
  const hadMarker = entryAssignedWorkspaceDirMarkers.has(api);
  const hadValue = entryAssignedWorkspaceDirValues.has(api);
  if (!hadMarker && !hadValue) return;
  entryAssignedWorkspaceDirMarkers.delete(api);
  const trackedValue = entryAssignedWorkspaceDirValues.get(api);
  entryAssignedWorkspaceDirValues.delete(api);
  // Marker path: defineProperty installed; safely delete the
  // descriptor we own. Value-track path: only delete if the property
  // still holds the value we wrote — a third-party write to a
  // different value would otherwise be silently dropped.
  if (hadMarker || trackedValue === undefined || api.workspaceDir === trackedValue) {
    try {
      delete api.workspaceDir;
    } catch { /* non-configurable — best-effort */ }
  }
}

function directApiConfigFrom(config) {
  // T364 round 6 — extract just the adapter-config keys (memory,
  // channel, daemonUrl, ...) from a candidate that may be a mixed
  // gateway payload (route metadata + adapter overlay). Pre-fix this
  // helper rejected the whole object whenever any route-metadata key
  // (`workspaceDir`, `agents`, `session`, `workspace`) was present, so
  // a payload like `{ workspaceDir, channel: { port: 9801 } }` lost
  // the legitimate channel override on the floor and bootstrap kept
  // stale daemon/channel/memory settings on the first runtime pass.
  // The shared `extractAdapterPluginConfigOverlay` helper splits the
  // overlay from the route metadata (which is handled separately by
  // route-metadata recognition) and returns just the adapter-config
  // keys, or `undefined` if the candidate carries none.
  return extractAdapterPluginConfigOverlay(config);
}

function registrationModeEnablesRuntime(api) {
  const mode = api?.registrationMode ?? 'full';
  return mode !== 'setup-only' && mode !== 'cli-metadata';
}

function directPluginConfigFrom(config) {
  // T364 round 6 — same mixed-payload semantics as `directApiConfigFrom`.
  // `api.pluginConfig` is typically a pure adapter config, but this
  // helper is also fed `runtime.pluginConfig` and other less-strict
  // sources. Extract just the adapter-config keys so a mixed gateway
  // payload contributes its overlay rather than being rejected wholesale.
  return extractAdapterPluginConfigOverlay(config);
}

function adapterConfigSourcesFromFullConfig(config) {
  if (!isObjectRecord(config)) return [];
  return [
    config.plugins?.entries?.['adapter-openclaw']?.config,
    directPluginConfigFrom(config),
  ].filter(isObjectRecord);
}

function stripStateMetadataFromAdapterConfig(config) {
  if (!isObjectRecord(config)) return undefined;
  const {
    stateDir: _stateDir,
    stateDirSource: _stateDirSource,
    installedWorkspace: _installedWorkspace,
    ...rest
  } = config;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function syncSkillToWorkspace(workspaceDir, log) {
  try {
    // Try both monorepo and npm-installed relative paths. The CLI
    // package ships `skills/` in its `files` array. In the monorepo the
    // directory is named `cli`; on npm it's `dkg` (the package name).
    const candidates = [
      fileURLToPath(new URL('../cli/skills/dkg-node/SKILL.md', import.meta.url)),
      fileURLToPath(new URL('../dkg/skills/dkg-node/SKILL.md', import.meta.url)),
    ];
    const skillSrc = candidates.find(p => existsSync(p));
    if (workspaceDir && skillSrc) {
      const skillDest = join(workspaceDir, 'skills', 'dkg-node', 'SKILL.md');
      const srcContent = readFileSync(skillSrc, 'utf-8');
      if (!existsSync(skillDest) || readFileSync(skillDest, 'utf-8') !== srcContent) {
        mkdirSync(dirname(skillDest), { recursive: true });
        writeFileSync(skillDest, srcContent, 'utf-8');
        log.info?.('[dkg-entry] SKILL.md synced to workspace');
      }
    }
  } catch (err) {
    log.debug?.(`[dkg-entry] SKILL.md sync skipped: ${err.message}`);
  }
}

function registerLifecycleService(api, log) {
  if (!instance || typeof api.registerService !== 'function') return;
  if (lifecycleServiceApis.get(api) === instance) return;

  const serviceInstance = instance;
  const serviceToken = {};
  try {
    api.registerService({
      name: 'dkg-adapter-openclaw-runtime',
      start: async () => {},
      stop: async () => {
        if (lifecycleOwnerToken !== serviceToken) return;
        lifecycleOwnerToken = null;
        try {
          await serviceInstance.stop();
        } finally {
          if (instance === serviceInstance) {
            instance = null;
          }
        }
      },
    });
    lifecycleServiceApis.set(api, serviceInstance);
    lifecycleOwnerToken = serviceToken;
  } catch (err) {
    log.debug?.(`[dkg-entry] lifecycle service registration skipped: ${err.message}`);
  }
}
