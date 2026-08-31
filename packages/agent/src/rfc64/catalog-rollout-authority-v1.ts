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

/** Canonical lane ownership resolved once during agent construction. */
export interface Rfc64CatalogExecutionPlanV1 {
  readonly killSwitchActive: boolean;
  readonly legacyContextGraphs: readonly string[];
  readonly track2ContextGraphs: readonly string[];
  readonly selectedAuthority: Readonly<Record<string, Rfc64CatalogAuthorityPolicyV1>>;
  /** Compatibility catalog controls remain available without selected-CG activation. */
  readonly standaloneTrack2Enabled: boolean;
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

/** Resolve the complete restart-stable capability set for one CG exactly once. */
export function resolveRfc64CatalogAuthorityDecisionV1(
  activation: Readonly<{
    enabled?: boolean;
    selectedContextGraphs: readonly string[];
    rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }> | undefined,
  contextGraphId: string,
): Rfc64CatalogAuthorityPolicyV1 {
  const selected = activation?.selectedContextGraphs.includes(contextGraphId) ?? false;
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
  return resolveRfc64CatalogAuthorityDecisionV1(activation, contextGraphId).legacySyncAllowed;
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

/** Resolve legacy and Track-2 owner scopes once, before either lane starts. */
export function resolveRfc64CatalogExecutionPlanV1(input: Readonly<{
  configuredContextGraphs: readonly string[];
  activation: Readonly<{
    enabled?: boolean;
    selectedContextGraphs: readonly string[];
    selectedPublicContextGraphs: readonly string[];
    rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }>;
}>): Rfc64CatalogExecutionPlanV1 {
  const selectedAuthority: Record<string, Rfc64CatalogAuthorityPolicyV1> =
    Object.create(null);
  const track2ContextGraphs: string[] = [];
  for (const contextGraphId of input.activation.selectedContextGraphs) {
    const authority = resolveRfc64CatalogAuthorityDecisionV1(
      input.activation,
      contextGraphId,
    );
    selectedAuthority[contextGraphId] = authority;
    if (authority.track2Enabled) track2ContextGraphs.push(contextGraphId);
  }
  return Object.freeze({
    killSwitchActive: input.activation.rollout.killSwitch,
    legacyContextGraphs: resolveRfc64LegacySyncContextGraphsV1(input),
    track2ContextGraphs: Object.freeze(track2ContextGraphs),
    selectedAuthority: Object.freeze(selectedAuthority),
    standaloneTrack2Enabled: input.activation.enabled === false
      && !input.activation.rollout.killSwitch,
  });
}

/** Read the pre-resolved legacy capability; unselected CGs stay legacy-owned. */
export function rfc64ExecutionPlanAllowsLegacySyncV1(
  plan: Rfc64CatalogExecutionPlanV1,
  contextGraphId: string,
): boolean {
  return plan.selectedAuthority[contextGraphId]?.legacySyncAllowed ?? true;
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
