// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

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

type Rfc64CatalogAuthorityActivationV1 = Readonly<{
  enabled?: boolean;
  selectedContextGraphs: readonly string[];
  rollout: ResolvedRfc64CatalogRolloutConfigV1;
}>;

interface Rfc64CatalogAuthorityPolicyCommonV1 {
  readonly contextGraphId: string;
  /** @deprecated Compatibility alias for `eligible`. */
  readonly selected: boolean;
  /** The immutable manifest contains this CG. */
  readonly eligible: boolean;
  /** This operation direction is active for this CG on the current node. */
  readonly active: boolean;
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
    mode: Rfc64CatalogRolloutModeV1;
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
    eligible: true;
    active: true;
    mode: 'catalog';
    legacySyncAllowed: false;
    track2Enabled: true;
    authoringAllowed: true;
  }>)
  | (Rfc64CatalogAuthorityPolicyCommonV1 & Readonly<{
    reconciliationLane: 'catalog-apply';
    eligible: false;
    active: true;
    mode: 'catalog';
    legacySyncAllowed: true;
    track2Enabled: true;
    authoringAllowed: true;
  }>);

export interface Rfc64CatalogReceiverActivityV1 {
  /**
   * Edge nodes derive this value from the canonical subscription registry.
   * Core nodes and configured serving/authoring resolution omit it.
   */
  readonly active: boolean;
}

export type Rfc64CatalogReconciliationLaneV1 =
  Rfc64CatalogAuthorityPolicyV1['reconciliationLane'];

/** Canonical lane ownership resolved once during agent construction. */
export interface Rfc64CatalogExecutionPlanV1 {
  readonly killSwitchActive: boolean;
  /** Desired mode for lifecycle-responsible CGs that have no explicit override. */
  readonly responsibilityDefaultMode: Rfc64CatalogRolloutModeV1;
  /** Restart-stable per-CG overrides, including graphs discovered after startup. */
  readonly contextGraphModes: Readonly<Record<string, Rfc64CatalogRolloutModeV1>>;
  readonly legacyContextGraphs: readonly string[];
  readonly track2ContextGraphs: readonly string[];
  readonly selectedAuthority: Readonly<Record<string, Rfc64CatalogAuthorityPolicyV1>>;
  /** Selected authority keyed by the commitment of each cleartext CG id. */
  readonly selectedAuthorityByWireId:
    Readonly<Record<string, Rfc64CatalogAuthorityPolicyV1>>;
  /** Compatibility catalog controls remain available without selected-CG activation. */
  readonly standaloneTrack2Enabled: boolean;
}

/**
 * Read one authority answer from the construction-time execution plan.
 * Runtime services never reinterpret the raw rollout configuration.
 */
export function resolveRfc64CatalogExecutionPlanAuthorityV1(
  plan: Rfc64CatalogExecutionPlanV1,
  contextGraphId: string,
): Rfc64CatalogAuthorityPolicyV1 {
  const selected = plan.selectedAuthority[contextGraphId];
  if (selected !== undefined) return selected;
  if (plan.standaloneTrack2Enabled) {
    return Object.freeze({
      contextGraphId,
      selected: false,
      eligible: false,
      active: true,
      mode: 'catalog',
      killSwitchActive: false,
      legacySyncAllowed: true,
      track2Enabled: true,
      authoringAllowed: true,
      reconciliationLane: 'catalog-apply',
    });
  }
  return Object.freeze({
    contextGraphId,
    selected: false,
    eligible: false,
    active: true,
    mode: 'legacy',
    killSwitchActive: plan.killSwitchActive,
    legacySyncAllowed: true,
    track2Enabled: false,
    authoringAllowed: false,
    reconciliationLane: 'legacy',
  });
}

export interface Rfc64CatalogResponsibilityAuthorityInputV1 {
  readonly contextGraphId: string;
  readonly responsible: boolean;
  readonly active: boolean;
  readonly mode: Rfc64CatalogRolloutModeV1;
  readonly killSwitchActive: boolean;
}

/**
 * Convert lifecycle-derived responsibility into the single effective lane.
 * The global kill switch deliberately restores the ordinary legacy lane for
 * a responsible CG, while retaining the configured mode for status and a
 * later restart. An inactive/non-responsible CG owns no correctness lane.
 */
export function resolveRfc64CatalogResponsibilityAuthorityV1(
  input: Rfc64CatalogResponsibilityAuthorityInputV1,
): Rfc64CatalogAuthorityPolicyV1 {
  const common = {
    contextGraphId: input.contextGraphId,
    selected: input.responsible,
    eligible: input.responsible,
    mode: input.mode,
    killSwitchActive: input.killSwitchActive,
  } as const;
  if (!input.responsible) {
    return Object.freeze({
      ...common,
      active: false,
      legacySyncAllowed: false,
      track2Enabled: false,
      authoringAllowed: false,
      reconciliationLane: 'disabled',
    });
  }
  if (input.killSwitchActive) {
    return Object.freeze({
      ...common,
      active: false,
      legacySyncAllowed: true,
      track2Enabled: false,
      authoringAllowed: false,
      reconciliationLane: 'disabled',
    });
  }
  if (!input.active) {
    return Object.freeze({
      ...common,
      active: false,
      legacySyncAllowed: false,
      track2Enabled: false,
      authoringAllowed: false,
      reconciliationLane: 'disabled',
    });
  }
  if (input.mode === 'catalog') {
    return Object.freeze({
      ...common,
      eligible: true,
      active: true,
      mode: 'catalog',
      legacySyncAllowed: false,
      track2Enabled: true,
      authoringAllowed: true,
      reconciliationLane: 'catalog-apply',
    });
  }
  if (input.mode === 'shadow') {
    return Object.freeze({
      ...common,
      active: true,
      mode: 'shadow',
      legacySyncAllowed: true,
      track2Enabled: true,
      authoringAllowed: true,
      reconciliationLane: 'shadow-stage',
    });
  }
  return Object.freeze({
    ...common,
    active: true,
    mode: 'legacy',
    legacySyncAllowed: true,
    track2Enabled: false,
    authoringAllowed: false,
    reconciliationLane: 'legacy',
  });
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
    if (label === 'rfc64PublicCatalog' && !selected.has(contextGraphId)) {
      throw new TypeError(
        `${label}.rollout.contextGraphModes contains unselected graph ${contextGraphId}`,
      );
    }
  }
  const contextGraphModes: Record<string, Rfc64CatalogRolloutModeV1> = Object.create(null);
  for (const [contextGraphId, mode] of Object.entries(suppliedModes)) {
    contextGraphModes[contextGraphId] = mode;
  }
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

/**
 * @deprecated Resolve configured authority explicitly, then project receiver
 * activity with `projectRfc64CatalogReceiverAuthorityV1` when required.
 */
export function resolveRfc64CatalogAuthorityDecisionV1(
  activation: Rfc64CatalogAuthorityActivationV1 | undefined,
  contextGraphId: string,
  receiverActivity?: Readonly<Rfc64CatalogReceiverActivityV1>,
): Rfc64CatalogAuthorityPolicyV1 {
  const configured = resolveRfc64CatalogConfiguredAuthorityDecisionV1(
    activation,
    contextGraphId,
  );
  return receiverActivity === undefined
    ? configured
    : projectRfc64CatalogReceiverAuthorityV1(configured, receiverActivity);
}

/** Resolve provider/author authority without applying edge receiver selection. */
export function resolveRfc64CatalogConfiguredAuthorityDecisionV1(
  activation: Rfc64CatalogAuthorityActivationV1 | undefined,
  contextGraphId: string,
): Rfc64CatalogAuthorityPolicyV1 {
  const eligible = activation?.selectedContextGraphs.includes(contextGraphId) ?? false;
  const mode = rfc64CatalogRolloutModeForContextGraphV1(activation, contextGraphId);
  const killSwitchActive = activation?.rollout?.killSwitch ?? false;
  // The disabled activation preserves the pre-activation direct catalog API
  // for unselected callers. Selected CGs always have exactly one authority.
  const compatibilityTrack2 = activation?.enabled === false && !eligible;
  const active = compatibilityTrack2 || eligible;
  if (killSwitchActive && (compatibilityTrack2 || mode !== 'legacy')) {
    return Object.freeze({
      contextGraphId,
      selected: eligible,
      eligible,
      active: false,
      mode: mode === 'legacy' ? 'catalog' : mode,
      killSwitchActive: true,
      legacySyncAllowed: !eligible || mode !== 'catalog',
      track2Enabled: false,
      authoringAllowed: false,
      reconciliationLane: 'disabled',
    });
  }
  if (compatibilityTrack2) {
    return Object.freeze({
      contextGraphId,
      selected: false,
      eligible: false,
      active: true,
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
      eligible: true,
      active: true,
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
      selected: eligible,
      eligible,
      active: true,
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
    selected: eligible,
    eligible,
    active,
    mode: 'legacy',
    killSwitchActive,
    legacySyncAllowed: true,
    track2Enabled: false,
    authoringAllowed: false,
    reconciliationLane: 'legacy',
  });
}

/** Apply canonical live receiver selection to an immutable configured policy. */
export function projectRfc64CatalogReceiverAuthorityV1(
  configured: Rfc64CatalogAuthorityPolicyV1,
  activity: Readonly<Rfc64CatalogReceiverActivityV1>,
): Rfc64CatalogAuthorityPolicyV1 {
  if (activity.active) return configured;
  return Object.freeze({
    contextGraphId: configured.contextGraphId,
    selected: configured.selected,
    eligible: configured.eligible,
    active: false,
    mode: configured.mode,
    killSwitchActive: configured.killSwitchActive,
    legacySyncAllowed: false,
    track2Enabled: false,
    authoringAllowed: false,
    reconciliationLane: 'disabled',
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
  activation: Rfc64CatalogAuthorityActivationV1 | undefined,
  contextGraphId: string,
  receiverActivity?: Readonly<Rfc64CatalogReceiverActivityV1>,
): boolean {
  return resolveRfc64CatalogAuthorityDecisionV1(
    activation,
    contextGraphId,
    receiverActivity,
  ).legacySyncAllowed;
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
  /** DKG 10.0.15 supplies catalog; legacy preserves explicit enabled=false. */
  responsibilityDefaultMode?: Rfc64CatalogRolloutModeV1;
  /** Legacy public bootstrap remains active beside additive catalog selection. */
  standaloneTrack2ContextGraphs?: readonly string[];
  activation: Readonly<{
    enabled?: boolean;
    selectedContextGraphs: readonly string[];
    selectedPublicContextGraphs: readonly string[];
    rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }>;
}>): Rfc64CatalogExecutionPlanV1 {
  const responsibilityDefaultMode = input.responsibilityDefaultMode ?? 'legacy';
  if (!RFC64_CATALOG_ROLLOUT_MODES_V1.has(responsibilityDefaultMode)) {
    throw new TypeError('RFC-64 responsibility default mode must be legacy, shadow, or catalog');
  }
  const selectedAuthority: Record<string, Rfc64CatalogAuthorityPolicyV1> =
    Object.create(null);
  const track2ContextGraphs: string[] = [];
  for (const contextGraphId of input.activation.selectedContextGraphs) {
    const authority = resolveRfc64CatalogConfiguredAuthorityDecisionV1(
      input.activation,
      contextGraphId,
    );
    selectedAuthority[contextGraphId] = authority;
    if (authority.track2Enabled) track2ContextGraphs.push(contextGraphId);
  }
  for (const contextGraphId of input.standaloneTrack2ContextGraphs ?? []) {
    // The direct public-catalog controls predate selected-CG activation.  They
    // retain catalog discovery while allowing legacy sync, even when another
    // graph is under an additive rollout.
    if (
      input.activation.rollout.killSwitch
      || selectedAuthority[contextGraphId] !== undefined
    ) continue;
    selectedAuthority[contextGraphId] = Object.freeze({
      contextGraphId,
      selected: false,
      eligible: false,
      active: true,
      mode: 'catalog',
      killSwitchActive: false,
      legacySyncAllowed: true,
      track2Enabled: true,
      authoringAllowed: true,
      reconciliationLane: 'catalog-apply',
    });
    track2ContextGraphs.push(contextGraphId);
  }
  const selectedAuthorityByWireId: Record<string, Rfc64CatalogAuthorityPolicyV1> =
    Object.create(null);
  for (const [contextGraphId, authority] of Object.entries(selectedAuthority)) {
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
    selectedAuthorityByWireId[wireId] = authority;
  }
  const contextGraphModes = Object.freeze({ ...input.activation.rollout.contextGraphModes });
  const legacyContextGraphs = Object.freeze([...new Set([
    ...input.configuredContextGraphs,
    ...input.activation.selectedPublicContextGraphs,
  ])].filter((contextGraphId) => {
    const configuredAuthority = selectedAuthority[contextGraphId];
    if (configuredAuthority !== undefined) {
      return configuredAuthority.legacySyncAllowed;
    }
    const mode = contextGraphModes[contextGraphId] ?? responsibilityDefaultMode;
    return input.activation.rollout.killSwitch || mode !== 'catalog';
  }));
  return Object.freeze({
    killSwitchActive: input.activation.rollout.killSwitch,
    responsibilityDefaultMode,
    contextGraphModes,
    legacyContextGraphs,
    track2ContextGraphs: Object.freeze(track2ContextGraphs),
    selectedAuthority: Object.freeze(selectedAuthority),
    selectedAuthorityByWireId: Object.freeze(selectedAuthorityByWireId),
    standaloneTrack2Enabled: input.activation.enabled === false
      && !input.activation.rollout.killSwitch,
  });
}

/** Read the pre-resolved legacy capability; unselected CGs stay legacy-owned. */
export function rfc64ExecutionPlanAllowsLegacySyncV1(
  plan: Rfc64CatalogExecutionPlanV1,
  contextGraphId: string,
): boolean {
  if (plan.killSwitchActive) return true;
  const configuredAuthority = plan.selectedAuthority[contextGraphId];
  if (configuredAuthority !== undefined) {
    return configuredAuthority.legacySyncAllowed;
  }
  return (plan.contextGraphModes[contextGraphId] ?? plan.responsibilityDefaultMode)
    !== 'catalog';
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
