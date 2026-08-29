// SPDX-License-Identifier: Apache-2.0

/** Restart-stable authority selection for one explicitly selected CG. */
export type Rfc64CatalogRolloutModeV1 = 'legacy' | 'shadow' | 'catalog';

export interface Rfc64CatalogRolloutConfigV1 {
  /** Emergency stop for every Track-2 protocol and worker on this node. */
  readonly killSwitch?: boolean;
  /** Omitted selected CGs retain the pre-D18 catalog-authoritative behavior. */
  readonly contextGraphModes?: Readonly<Record<string, Rfc64CatalogRolloutModeV1>>;
}

/** Total immutable runtime plan: every selected graph has one explicit mode. */
export interface ResolvedRfc64CatalogRolloutConfigV1 {
  readonly killSwitch: boolean;
  readonly contextGraphModes: Readonly<Record<string, Rfc64CatalogRolloutModeV1>>;
}

const RFC64_CATALOG_ROLLOUT_FIELDS_V1 = new Set([
  'contextGraphModes',
  'killSwitch',
]);
const RFC64_CATALOG_ROLLOUT_MODES_V1 = new Set<Rfc64CatalogRolloutModeV1>([
  'legacy',
  'shadow',
  'catalog',
]);

export function resolveRfc64CatalogRolloutConfigV1(
  input: Rfc64CatalogRolloutConfigV1 | undefined,
  selectedContextGraphs: readonly string[],
  label: 'rfc64Catalog' | 'rfc64PublicCatalog',
): ResolvedRfc64CatalogRolloutConfigV1 {
  if (input !== undefined) assertRolloutInputV1(input, label);
  const selected = new Set(selectedContextGraphs);
  const suppliedModes = input?.contextGraphModes ?? {};
  for (const contextGraphId of Object.keys(suppliedModes)) {
    if (!selected.has(contextGraphId)) {
      throw new TypeError(
        `${label}.rollout.contextGraphModes contains unselected graph ${contextGraphId}`,
      );
    }
  }
  const contextGraphModes: Record<string, Rfc64CatalogRolloutModeV1> = Object.create(null);
  for (const contextGraphId of selectedContextGraphs) {
    contextGraphModes[contextGraphId] = suppliedModes[contextGraphId] ?? 'catalog';
  }
  return Object.freeze({
    killSwitch: input?.killSwitch ?? false,
    contextGraphModes: Object.freeze(contextGraphModes),
  });
}

export function mergeRfc64CatalogRolloutConfigsV1(
  catalog: ResolvedRfc64CatalogRolloutConfigV1,
  publicCatalog: ResolvedRfc64CatalogRolloutConfigV1,
): ResolvedRfc64CatalogRolloutConfigV1 {
  const contextGraphModes: Record<string, Rfc64CatalogRolloutModeV1> = Object.create(null);
  for (const rollout of [catalog, publicCatalog]) {
    for (const [contextGraphId, mode] of Object.entries(rollout.contextGraphModes)) {
      const current = contextGraphModes[contextGraphId];
      if (current !== undefined && current !== mode) {
        throw new TypeError(
          `rfc64Catalog and rfc64PublicCatalog rollout modes conflict for selected graph ${contextGraphId}`,
        );
      }
      contextGraphModes[contextGraphId] = mode;
    }
  }
  return Object.freeze({
    killSwitch: catalog.killSwitch || publicCatalog.killSwitch,
    contextGraphModes: Object.freeze(contextGraphModes),
  });
}

/** Resolve one selected CG's restart-stable authority mode. */
export function rfc64CatalogRolloutModeForContextGraphV1(
  activation: Readonly<{
    selectedContextGraphs: readonly string[];
    rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }> | undefined,
  contextGraphId: string,
): Rfc64CatalogRolloutModeV1 {
  if (activation === undefined || !activation.selectedContextGraphs.includes(contextGraphId)) {
    return 'legacy';
  }
  // Resolved activations produced by this release always carry a total plan.
  // Retain the pre-D18 catalog default for older direct JS callers that pass a
  // previously resolved activation shape across the package boundary.
  const mode = activation.rollout?.contextGraphModes[contextGraphId] ?? 'catalog';
  if (mode === undefined) {
    throw new Error(`resolved RFC-64 rollout plan is missing selected graph ${contextGraphId}`);
  }
  return mode;
}

/**
 * Preserve the pre-activation catalog API while applying selected-CG rollout
 * only after the new activation block is explicitly enabled.
 */
export function rfc64CatalogTrack2ModeForContextGraphV1(
  activation: Readonly<{
    enabled: boolean;
    selectedContextGraphs: readonly string[];
    rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }> | undefined,
  contextGraphId: string,
): Rfc64CatalogRolloutModeV1 {
  if (activation?.enabled === false) return 'catalog';
  return rfc64CatalogRolloutModeForContextGraphV1(activation, contextGraphId);
}

/** Dedicated Track-2 emergency stop; it never changes a CG's persisted mode. */
export function rfc64CatalogKillSwitchActiveV1(
  activation: Readonly<{ rollout: ResolvedRfc64CatalogRolloutConfigV1 }> | undefined,
): boolean {
  return activation?.rollout?.killSwitch ?? false;
}

/** Catalog is the only mode that removes the legacy correctness authority. */
export function rfc64LegacySyncAuthorityActiveForContextGraphV1(
  activation: Readonly<{
    selectedContextGraphs: readonly string[];
    rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }> | undefined,
  contextGraphId: string,
): boolean {
  return rfc64CatalogRolloutModeForContextGraphV1(activation, contextGraphId) !== 'catalog';
}

/** One deterministic no-dual-authority projection for the legacy sync scope. */
export function resolveRfc64LegacySyncContextGraphsV1(input: Readonly<{
  configuredContextGraphs: readonly string[];
  activation: Readonly<{
    selectedContextGraphs: readonly string[];
    selectedPublicContextGraphs: readonly string[];
    rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }>;
}>): readonly string[] {
  return Object.freeze([...new Set([
    ...input.configuredContextGraphs,
    ...input.activation.selectedPublicContextGraphs,
  ])].filter((contextGraphId) => rfc64LegacySyncAuthorityActiveForContextGraphV1(
    input.activation,
    contextGraphId,
  )));
}

function assertRolloutInputV1(
  input: Rfc64CatalogRolloutConfigV1,
  label: 'rfc64Catalog' | 'rfc64PublicCatalog',
): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label}.rollout must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label}.rollout must be a plain object`);
  }
  if (Object.keys(input).some((key) => !RFC64_CATALOG_ROLLOUT_FIELDS_V1.has(key))) {
    throw new TypeError(`${label}.rollout has unknown fields`);
  }
  if (input.killSwitch !== undefined && typeof input.killSwitch !== 'boolean') {
    throw new TypeError(`${label}.rollout.killSwitch must be a boolean`);
  }
  const modeInput = input.contextGraphModes;
  if (
    modeInput !== undefined
    && (
      modeInput === null
      || typeof modeInput !== 'object'
      || Array.isArray(modeInput)
      || (
        Object.getPrototypeOf(modeInput) !== Object.prototype
        && Object.getPrototypeOf(modeInput) !== null
      )
    )
  ) {
    throw new TypeError(`${label}.rollout.contextGraphModes must be a plain object`);
  }
  for (const [contextGraphId, mode] of Object.entries(modeInput ?? {})) {
    if (!RFC64_CATALOG_ROLLOUT_MODES_V1.has(mode as Rfc64CatalogRolloutModeV1)) {
      throw new TypeError(
        `${label}.rollout.contextGraphModes.${contextGraphId} must be legacy, shadow, or catalog`,
      );
    }
  }
}
