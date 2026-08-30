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

/**
 * Process-local edge subscription selection over an immutable eligible-CG
 * manifest. The manifest remains the policy/provider trust root; this selector
 * decides which of those eligible graphs this edge is actively following.
 */
export interface Rfc64CatalogRuntimeSelectionV1 {
  readonly isSelected: (contextGraphId: string) => boolean;
  readonly select: (contextGraphId: string) => boolean;
  readonly deselect: (contextGraphId: string) => boolean;
  readonly snapshot: () => readonly string[];
}

export function createRfc64CatalogRuntimeSelectionV1(input: Readonly<{
  eligibleContextGraphs: readonly string[];
  initiallySelectedContextGraphs?: readonly string[];
}>): Rfc64CatalogRuntimeSelectionV1 {
  const eligible = new Set(input.eligibleContextGraphs);
  const selected = new Set(
    (input.initiallySelectedContextGraphs ?? []).filter((contextGraphId) => (
      eligible.has(contextGraphId)
    )),
  );
  return Object.freeze({
    isSelected: (contextGraphId: string) => selected.has(contextGraphId),
    select: (contextGraphId: string) => {
      if (!eligible.has(contextGraphId)) return false;
      const size = selected.size;
      selected.add(contextGraphId);
      return selected.size !== size;
    },
    deselect: (contextGraphId: string) => selected.delete(contextGraphId),
    snapshot: () => Object.freeze([...selected].sort()),
  });
}

type Rfc64CatalogAuthorityActivationV1 = Readonly<{
  enabled?: boolean;
  selectedContextGraphs: readonly string[];
  rollout: ResolvedRfc64CatalogRolloutConfigV1;
  runtimeSelection?: Rfc64CatalogRuntimeSelectionV1;
}>;

interface Rfc64CatalogAuthorityPolicyCommonV1 {
  readonly contextGraphId: string;
  readonly selected: boolean;
  readonly mode: Rfc64CatalogRolloutModeV1;
  readonly killSwitchActive: boolean;
}

/**
 * One immutable, discriminated answer for every runtime authority question
 * about one CG. Literal capabilities make contradictory combinations
 * unrepresentable at the service boundary.
 */
export type Rfc64CatalogAuthorityPolicyV1 =
  | (Rfc64CatalogAuthorityPolicyCommonV1 & Readonly<{
    reconciliationLane: 'legacy';
    mode: 'legacy';
    legacySyncAllowed: true;
    track2Enabled: false;
    authoringAllowed: false;
  }>)
  | (Rfc64CatalogAuthorityPolicyCommonV1 & Readonly<{
    reconciliationLane: 'disabled';
    mode: 'shadow' | 'catalog';
    legacySyncAllowed: boolean;
    track2Enabled: false;
    authoringAllowed: false;
  }>)
  | (Rfc64CatalogAuthorityPolicyCommonV1 & Readonly<{
    reconciliationLane: 'shadow-stage';
    mode: 'shadow';
    legacySyncAllowed: true;
    track2Enabled: true;
    authoringAllowed: true;
  }>)
  | (Rfc64CatalogAuthorityPolicyCommonV1 & Readonly<{
    reconciliationLane: 'catalog-apply';
    selected: true;
    mode: 'catalog';
    legacySyncAllowed: false;
    track2Enabled: true;
    authoringAllowed: true;
  }>)
  | (Rfc64CatalogAuthorityPolicyCommonV1 & Readonly<{
    reconciliationLane: 'catalog-apply';
    selected: false;
    mode: 'catalog';
    legacySyncAllowed: true;
    track2Enabled: true;
    authoringAllowed: true;
  }>);

export type Rfc64CatalogReconciliationLaneV1 =
  Rfc64CatalogAuthorityPolicyV1['reconciliationLane'];

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
  activation: Rfc64CatalogAuthorityActivationV1 | undefined,
  contextGraphId: string,
): Rfc64CatalogRolloutModeV1 {
  if (
    activation === undefined
    || !activation.selectedContextGraphs.includes(contextGraphId)
    || activation.runtimeSelection?.isSelected(contextGraphId) === false
  ) {
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

/** Resolve the configured mode without applying edge subscription selection. */
export function rfc64CatalogConfiguredRolloutModeForContextGraphV1(
  activation: Rfc64CatalogAuthorityActivationV1 | undefined,
  contextGraphId: string,
): Rfc64CatalogRolloutModeV1 {
  if (activation === undefined || !activation.selectedContextGraphs.includes(contextGraphId)) {
    return 'legacy';
  }
  return activation.rollout?.contextGraphModes[contextGraphId] ?? 'catalog';
}

/** Resolve the complete restart-stable capability set for one CG exactly once. */
export function resolveRfc64CatalogAuthorityDecisionV1(
  activation: Rfc64CatalogAuthorityActivationV1 | undefined,
  contextGraphId: string,
): Rfc64CatalogAuthorityPolicyV1 {
  const eligible = activation?.selectedContextGraphs.includes(contextGraphId) ?? false;
  const selected = eligible && (activation?.runtimeSelection?.isSelected(contextGraphId) ?? true);
  const mode = rfc64CatalogRolloutModeForContextGraphV1(activation, contextGraphId);
  const killSwitchActive = activation?.rollout?.killSwitch ?? false;
  // The disabled activation preserves the pre-activation direct catalog API
  // for unselected callers. Selected CGs always have exactly one authority.
  const compatibilityTrack2 = activation?.enabled === false && !selected;
  if (killSwitchActive && (compatibilityTrack2 || mode !== 'legacy')) {
    return Object.freeze({
      contextGraphId,
      selected,
      mode: mode === 'legacy' ? 'catalog' : mode,
      killSwitchActive: true,
      legacySyncAllowed: !selected || mode !== 'catalog',
      track2Enabled: false,
      authoringAllowed: false,
      reconciliationLane: 'disabled',
    });
  }
  if (compatibilityTrack2) {
    return Object.freeze({
      contextGraphId,
      selected: false,
      mode: 'catalog',
      killSwitchActive: false,
      legacySyncAllowed: true,
      track2Enabled: true,
      authoringAllowed: true,
      reconciliationLane: 'catalog-apply',
    });
  }
  if (mode === 'catalog') {
    return Object.freeze({
      contextGraphId,
      selected: true,
      mode: 'catalog',
      killSwitchActive: false,
      legacySyncAllowed: false,
      track2Enabled: true,
      authoringAllowed: true,
      reconciliationLane: 'catalog-apply',
    });
  }
  if (mode === 'shadow') {
    return Object.freeze({
      contextGraphId,
      selected,
      mode: 'shadow',
      killSwitchActive: false,
      legacySyncAllowed: true,
      track2Enabled: true,
      authoringAllowed: true,
      reconciliationLane: 'shadow-stage',
    });
  }
  return Object.freeze({
    contextGraphId,
    selected,
    mode: 'legacy',
    killSwitchActive,
    legacySyncAllowed: true,
    track2Enabled: false,
    authoringAllowed: false,
    reconciliationLane: 'legacy',
  });
}

/** Resolve provider/author authority without applying edge receiver selection. */
export function resolveRfc64CatalogConfiguredAuthorityDecisionV1(
  activation: Rfc64CatalogAuthorityActivationV1 | undefined,
  contextGraphId: string,
): Rfc64CatalogAuthorityPolicyV1 {
  if (activation === undefined || activation.runtimeSelection === undefined) {
    return resolveRfc64CatalogAuthorityDecisionV1(activation, contextGraphId);
  }
  return resolveRfc64CatalogAuthorityDecisionV1(Object.freeze({
    enabled: activation.enabled,
    selectedContextGraphs: activation.selectedContextGraphs,
    rollout: activation.rollout,
  }), contextGraphId);
}

/** Dedicated Track-2 emergency stop; it never changes a CG's persisted mode. */
export function rfc64CatalogKillSwitchActiveV1(
  activation: Readonly<{ rollout: ResolvedRfc64CatalogRolloutConfigV1 }> | undefined,
): boolean {
  return activation?.rollout?.killSwitch ?? false;
}

/** Catalog is the only mode that removes the legacy correctness authority. */
export function rfc64LegacySyncAuthorityActiveForContextGraphV1(
  activation: Rfc64CatalogAuthorityActivationV1 | undefined,
  contextGraphId: string,
): boolean {
  const runtimeSelectionApplies = activation?.selectedContextGraphs.includes(contextGraphId)
    ?? false;
  return (
    resolveRfc64CatalogAuthorityDecisionV1(activation, contextGraphId).legacySyncAllowed
    && (
      !runtimeSelectionApplies
      || (activation?.runtimeSelection?.isSelected(contextGraphId) ?? true)
    )
  );
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
