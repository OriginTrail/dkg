import type { OpenClawPluginApi } from './types.js';

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const ADAPTER_PLUGIN_CONFIG_KEYS = [
  'daemonUrl',
  'dkgHome',
  'stateDir',
  'stateDirSource',
  'installedWorkspace',
  'memory',
  'channel',
] as const;

const STATE_METADATA_CONFIG_KEYS = [
  'stateDir',
  'stateDirSource',
  'installedWorkspace',
] as const;

const PARTIAL_OVERLAY_CONFIG_KEYS = [
  'daemonUrl',
  'dkgHome',
  'stateDir',
  'stateDirSource',
  'installedWorkspace',
] as const;

const PARTIAL_MODULE_CONFIG_KEYS = [
  'memory',
  'channel',
] as const;

export function looksLikeAdapterPluginConfig(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  if (
    isObjectRecord(value.plugins) ||
    isObjectRecord(value.agents) ||
    isObjectRecord(value.session) ||
    typeof value.workspace === 'string' ||
    // T364 follow-up: `workspaceDir` is route metadata (per
    // `hasRouteMetadataConfigSignal` and the setup.ts:166-190 fallback
    // chain). Pre-fix `{ workspaceDir, channel: { port: 9801 } }` or
    // `{ workspaceDir, stateDir: ... }` was misclassified as a direct
    // adapter config, so the dispatch resolver stopped layering in
    // lower-priority full configs and could drop daemonUrl /
    // memory.enabled. Excluding `workspaceDir` here aligns the
    // classifier with route-metadata recognition; consumers that need
    // to extract adapter-config keys from a mixed payload (workspaceDir
    // + memory/channel/...) call `extractAdapterPluginConfigOverlay`
    // instead, which splits route-metadata keys from adapter-config
    // keys rather than rejecting the whole object.
    typeof value.workspaceDir === 'string'
  ) {
    return false;
  }
  return ADAPTER_PLUGIN_CONFIG_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Extract an adapter-config overlay from a candidate that may be a
 * mixed payload (route metadata + adapter config). Returns just the
 * adapter-config keys (`memory`, `channel`, `daemonUrl`, …) or
 * `undefined` if the candidate carries none. Returns `undefined` for
 * merged-config-shaped objects (presence of `plugins`) — those are
 * full snapshots, not overlays.
 *
 * T364 round 6 — pre-fix the dispatch resolver and entry classifier
 * blanket-rejected any object carrying route-metadata keys
 * (`workspaceDir`, `agents`, `session`, `workspace`). For a gateway
 * payload like `{ workspaceDir, channel: { port: 9801 } }` that
 * dropped the legitimate channel override on the floor, leaving
 * bootstrap/dispatch on the previous channel/memory settings. This
 * helper lets callers split mixed payloads into the route-metadata
 * portion (handled by `resolveOpenClawRouteMetadataConfig`) and the
 * adapter-config portion (the overlay returned here).
 */
export function extractAdapterPluginConfigOverlay(value: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(value)) return undefined;
  if (isObjectRecord(value.plugins)) return undefined;
  const valueKeys = Object.keys(value);
  if (valueKeys.length === 0) return undefined;
  // Pure adapter config (no route-metadata keys mixed in) — return the
  // original reference so consumers that compare by identity (and test
  // suites that assert `toBe(candidate)`) keep working. The helper
  // only allocates a fresh overlay when the input is a mixed payload
  // that needs splitting.
  if (looksLikeAdapterPluginConfig(value)) {
    return value as Record<string, unknown>;
  }
  const overlay: Record<string, unknown> = {};
  for (const key of ADAPTER_PLUGIN_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      overlay[key] = (value as Record<string, unknown>)[key];
    }
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined;
}

export function isStateMetadataOnlyAdapterConfig(value: unknown): boolean {
  if (!isObjectRecord(value) || !looksLikeAdapterPluginConfig(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) =>
    (STATE_METADATA_CONFIG_KEYS as readonly string[]).includes(key)
  );
}

export function isPartialAdapterConfigOverlay(value: unknown): boolean {
  if (!isObjectRecord(value) || !looksLikeAdapterPluginConfig(value)) return false;
  const keys = Object.keys(value);
  if (keys.every((key) => (PARTIAL_MODULE_CONFIG_KEYS as readonly string[]).includes(key))) {
    return true;
  }
  return keys.length > 0 && keys.every((key) =>
    (PARTIAL_OVERLAY_CONFIG_KEYS as readonly string[]).includes(key) ||
    isPartialModuleConfigOverlay(key, value[key])
  );
}

function isPartialModuleConfigOverlay(key: string, value: unknown): boolean {
  return (
    (PARTIAL_MODULE_CONFIG_KEYS as readonly string[]).includes(key) &&
    isObjectRecord(value) &&
    !Object.prototype.hasOwnProperty.call(value, 'enabled')
  );
}

export function mergeAdapterPluginConfigs<T extends Record<string, unknown>>(
  ...configs: Array<T | undefined>
): T {
  const merged: Record<string, unknown> = {};
  for (const config of configs) {
    if (!isObjectRecord(config)) continue;
    const priorMemory = isObjectRecord(merged.memory) ? merged.memory : undefined;
    const priorChannel = isObjectRecord(merged.channel) ? merged.channel : undefined;
    const nextMemory = isObjectRecord(config.memory) ? config.memory : undefined;
    const nextChannel = isObjectRecord(config.channel) ? config.channel : undefined;
    Object.assign(merged, config);
    if (priorMemory || nextMemory) {
      if (nextMemory) {
        merged.memory = { ...(priorMemory ?? {}), ...nextMemory };
      } else if (!Object.prototype.hasOwnProperty.call(config, 'memory')) {
        merged.memory = priorMemory;
      }
    }
    if (priorChannel || nextChannel) {
      if (nextChannel) {
        merged.channel = { ...(priorChannel ?? {}), ...nextChannel };
      } else if (!Object.prototype.hasOwnProperty.call(config, 'channel')) {
        merged.channel = priorChannel;
      }
    }
  }
  return merged as T;
}

function hasMergedPluginConfigSignal(value: Record<string, unknown>): boolean {
  return isObjectRecord(value.plugins);
}

function hasRouteMetadataConfigSignal(value: Record<string, unknown>): boolean {
  // T364 — `workspaceDir` is a recognized cfg shape (`setup.ts:166-190` reads
  // the fallback chain `agents.defaults.workspace → workspace → workspaceDir`
  // when discovering the workspace path). Pre-fix `hasRouteMetadataConfigSignal`
  // omitted it, so a runtime cfg carrying ONLY `workspaceDir` was dropped from
  // dispatch route metadata and `resolveChannelDispatchConfig` lost the
  // workspace path entirely. Including it keeps setup-time and runtime
  // recognition aligned across the same openclaw.json layouts.
  //
  // T364 round 10 — require workspace aliases to be non-empty after
  // trimming. Pre-fix an empty-string `workspaceDir`/`workspace` would
  // count as a route-metadata signal and suppress the fallback chain,
  // so the resolver could land on an empty workspace and
  // `syncSkillToWorkspace` would write to `./skills/...` under the
  // process CWD instead of an actual workspace.
  return (
    isObjectRecord(value.agents) ||
    isObjectRecord(value.session) ||
    isNonEmptyString(value.workspace) ||
    isNonEmptyString(value.workspaceDir)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveOpenClawMergedConfig(api: OpenClawPluginApi): Record<string, unknown> | undefined {
  const anyApi = api as any;
  const runtime = anyApi?.runtime;
  const candidates = [
    anyApi?.cfg,
    anyApi?.config,
    runtime?.cfg,
    runtime?.config,
  ].filter((candidate) =>
    isObjectRecord(candidate) &&
    !looksLikeAdapterPluginConfig(candidate) &&
    hasMergedPluginConfigSignal(candidate)
  );
  return candidates[0];
}

export function resolveOpenClawRouteMetadataConfig(api: OpenClawPluginApi): Record<string, unknown> | undefined {
  const anyApi = api as any;
  const runtime = anyApi?.runtime;
  const candidates = [
    runtime?.config,
    runtime?.cfg,
    anyApi?.config,
    anyApi?.cfg,
  ].filter((candidate) =>
    isObjectRecord(candidate) &&
    !looksLikeAdapterPluginConfig(candidate) &&
    !hasMergedPluginConfigSignal(candidate) &&
    hasRouteMetadataConfigSignal(candidate)
  ) as Record<string, unknown>[];
  // T364 round 6 — extract just the route-metadata keys from each
  // candidate before merging. A mixed gateway payload like
  // `{ workspaceDir, channel: { port: 9801 } }` has both route metadata
  // (workspaceDir) AND adapter overlay (channel); the adapter portion
  // is handled by `extractAdapterPluginConfigOverlay` separately, so
  // route-metadata extraction must drop adapter keys here to avoid
  // leaking them into the route layer (and overriding the merged
  // adapter config that gets nested under `plugins.entries`).
  // Pre-fix `mergeRouteMetadataConfigs` did `Object.assign(merged, config)`
  // verbatim, so `channel: { port: 9801 }` would leak into the route
  // metadata top level when the mixed payload was the only candidate.
  return candidates.length > 0
    ? mergeRouteMetadataConfigs(...candidates.map(extractRouteMetadataKeys))
    : undefined;
}

const ROUTE_METADATA_KEYS = ['workspace', 'workspaceDir', 'agents', 'session'] as const;

function extractRouteMetadataKeys(value: Record<string, unknown>): Record<string, unknown> {
  const extracted: Record<string, unknown> = {};
  for (const key of ROUTE_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      extracted[key] = value[key];
    }
  }
  return extracted;
}

function mergeRouteMetadataConfigs(
  ...configs: Record<string, unknown>[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const config of configs) {
    const priorAgents = isObjectRecord(merged.agents) ? merged.agents : undefined;
    const priorSession = isObjectRecord(merged.session) ? merged.session : undefined;
    const nextAgents = isObjectRecord(config.agents) ? config.agents : undefined;
    const nextSession = isObjectRecord(config.session) ? config.session : undefined;
    // T364 round 8 — when this newer config asserts ANY workspace
    // signal (across the documented `agents.defaults.workspace ->
    // workspace -> workspaceDir` fallback chain), scrub older aliases
    // from the merged snapshot first. Pre-fix `Object.assign` kept
    // every older alias in place, so an older
    // `agents.defaults.workspace` / `workspace` would survive
    // alongside a newer-only `workspaceDir` and the resolver chain
    // (which prefers `agents.defaults.workspace`) would pick the
    // stale value — silently ignoring the newer route's intent.
    scrubStaleWorkspaceAliases(merged, config);
    Object.assign(merged, config);
    if (priorAgents || nextAgents) {
      merged.agents = { ...(priorAgents ?? {}), ...(nextAgents ?? {}) };
      const priorDefaults = isObjectRecord(priorAgents?.defaults) ? priorAgents.defaults : undefined;
      const nextDefaults = isObjectRecord(nextAgents?.defaults) ? nextAgents.defaults : undefined;
      if (priorDefaults || nextDefaults) {
        (merged.agents as Record<string, unknown>).defaults = {
          ...(priorDefaults ?? {}),
          ...(nextDefaults ?? {}),
        };
      }
      // The agents.defaults assignment above re-introduces any prior
      // `agents.defaults.workspace` that was scrubbed before
      // `Object.assign`. Re-scrub after the deep-merge so the rule
      // (newer workspace signal wins consistently) holds for the
      // nested alias too.
      scrubStaleAgentsDefaultsWorkspace(merged, config);
    }
    if (priorSession || nextSession) {
      merged.session = { ...(priorSession ?? {}), ...(nextSession ?? {}) };
    }
  }
  return merged;
}

/**
 * The documented setup-side resolver picks the first alias to define
 * a workspace from `agents.defaults.workspace -> workspace ->
 * workspaceDir`. When merging route-metadata snapshots the resolver
 * must see a single coherent answer, so any newer config that asserts
 * a workspace signal (in any of those three slots) supersedes the
 * older aliases entirely — otherwise an older alias survives and the
 * resolver picks it ahead of the newer value.
 *
 * T364 round 8 — exported for `mergeRouteMetadataWithMergedConfig` in
 * `DkgChannelPlugin.ts` so dispatch-side and resolve-side route merges
 * share one normalization rule.
 */
export function scrubStaleWorkspaceAliases(
  merged: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  const supplied = workspaceAliasesSuppliedBy(next);
  if (supplied.size === 0) return;
  if (!supplied.has('workspace') && Object.prototype.hasOwnProperty.call(merged, 'workspace')) {
    delete merged.workspace;
  }
  if (!supplied.has('workspaceDir') && Object.prototype.hasOwnProperty.call(merged, 'workspaceDir')) {
    delete merged.workspaceDir;
  }
  scrubStaleAgentsDefaultsWorkspace(merged, next);
}

function scrubStaleAgentsDefaultsWorkspace(
  merged: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  const supplied = workspaceAliasesSuppliedBy(next);
  if (supplied.size === 0) return;
  if (supplied.has('agents.defaults.workspace')) return;
  const mergedAgents = isObjectRecord(merged.agents) ? merged.agents : undefined;
  if (!mergedAgents) return;
  const mergedDefaults = isObjectRecord(mergedAgents.defaults) ? mergedAgents.defaults : undefined;
  if (!mergedDefaults) return;
  if (!Object.prototype.hasOwnProperty.call(mergedDefaults, 'workspace')) return;
  // T364 round 8 — clone the agents → defaults path before deleting so
  // we never mutate a caller-owned shared reference. `merged` in
  // `mergeRouteMetadataWithMergedConfig` may be a shallow spread whose
  // nested `agents`/`defaults` are still pointers into live runtime
  // state (`runtime.config`). Mutating those would surface to other
  // dispatches/observers as a delete-on-input side-effect.
  const clonedDefaults: Record<string, unknown> = { ...mergedDefaults };
  delete clonedDefaults.workspace;
  merged.agents = { ...mergedAgents, defaults: clonedDefaults };
}

function workspaceAliasesSuppliedBy(config: Record<string, unknown>): Set<string> {
  // T364 round 10 — count an alias as "supplied" only when it carries
  // a non-empty trimmed string. An empty / whitespace-only value is
  // not a real workspace and must not suppress fallbacks (or trigger
  // a stale-alias scrub) on its own.
  const supplied = new Set<string>();
  if (isNonEmptyString(config.workspace)) supplied.add('workspace');
  if (isNonEmptyString(config.workspaceDir)) supplied.add('workspaceDir');
  const agents = isObjectRecord(config.agents) ? config.agents : undefined;
  const defaults = isObjectRecord(agents?.defaults) ? agents.defaults : undefined;
  if (defaults && isNonEmptyString((defaults as Record<string, unknown>).workspace)) {
    supplied.add('agents.defaults.workspace');
  }
  return supplied;
}
