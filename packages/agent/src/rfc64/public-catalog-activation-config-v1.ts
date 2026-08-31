// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalChainId,
  assertCanonicalEvmAddress,
  assertNetworkIdV1,
  type CatalogSealDeploymentProfileV1,
  type ChainIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';

import type {
  Rfc64CatalogAutoPublishConfigV1,
  Rfc64CatalogBootstrapConfigV1,
  Rfc64PublicCatalogAutoPublishConfigV1,
  Rfc64PublicCatalogBootstrapConfigV1,
} from '../dkg-agent-types.js';
import {
  snapshotRfc64CatalogBootstrapConfigV1,
  snapshotRfc64CatalogAutoPublishConfigV1,
  snapshotRfc64CatalogDeploymentProfileV1,
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from './catalog-authority-config-v1.js';
import { snapshotRfc64PublicCatalogAnnouncementPeersV1 } from './catalog-peers-v1.js';
import {
  mergeRfc64CatalogRolloutConfigsV1,
  resolveRfc64CatalogRolloutConfigV1,
  type ResolvedRfc64CatalogRolloutConfigV1,
  type Rfc64CatalogRolloutConfigV1,
} from './catalog-rollout-authority-v1.js';

export {
  rfc64CatalogKillSwitchActiveV1,
  rfc64CatalogRolloutModeForContextGraphV1,
  rfc64LegacySyncAuthorityActiveForContextGraphV1,
  rfc64ExecutionPlanAllowsLegacySyncV1,
  resolveRfc64LegacySyncContextGraphsV1,
  resolveRfc64CatalogExecutionPlanV1,
  type Rfc64CatalogExecutionPlanV1,
  type ResolvedRfc64CatalogRolloutConfigV1,
  type Rfc64CatalogRolloutConfigV1,
  type Rfc64CatalogRolloutModeV1,
} from './catalog-rollout-authority-v1.js';

export {
  resolveRfc64CatalogAuthorityDecisionV1,
  type Rfc64CatalogAuthorityPolicyV1,
  type Rfc64CatalogReconciliationLaneV1,
} from './catalog-rollout-authority-v1.js';

const MAX_SELECTED_PUBLIC_CONTEXT_GRAPHS_V1 = 64;
const RFC64_PUBLIC_CATALOG_ACTIVATION_FIELDS_V1 = new Set([
  'autoPublish',
  'bootstrap',
  'deploymentProfile',
  'enabled',
  'rollout',
]);
const RFC64_CATALOG_ACTIVATION_FIELDS_V1 = new Set([
  'accessPolicyAuthority',
  'autoPublish',
  'bootstrap',
  'deploymentProfile',
  'enabled',
  'rollout',
]);
const ZERO_ADDRESS_V1 = `0x${'0'.repeat(40)}`;

function assertRfc64PublicCatalogActivationConfigV1(
  input: unknown,
): asserts input is Rfc64PublicCatalogActivationConfigV1 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('rfc64PublicCatalog must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('rfc64PublicCatalog must be a plain object');
  }
  if (Object.keys(input).some((key) => !RFC64_PUBLIC_CATALOG_ACTIVATION_FIELDS_V1.has(key))) {
    throw new TypeError('rfc64PublicCatalog has unknown fields');
  }
}

function assertRfc64CatalogActivationConfigV1(
  input: unknown,
): asserts input is Rfc64CatalogActivationConfigV1 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('rfc64Catalog must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('rfc64Catalog must be a plain object');
  }
  if (Object.keys(input).some((key) => !RFC64_CATALOG_ACTIVATION_FIELDS_V1.has(key))) {
    throw new TypeError('rfc64Catalog has unknown fields');
  }
}

/**
 * Narrow side-effect-free package surface for daemon/operator activation.
 * Consumers that only normalize RFC-64 configuration must not import the full
 * DKGAgent runtime (which owns process-global scheduler observability).
 */
export {
  snapshotRfc64CatalogAutoPublishConfigV1,
  snapshotRfc64CatalogBootstrapConfigV1,
  snapshotRfc64CatalogDeploymentProfileV1,
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
};

export interface Rfc64CatalogPeerAgentBindingV1 {
  readonly peerId: string;
  readonly agentAddress: EvmAddressV1;
}

/** Manual Releases 1-2 peer identity trust root. No registry inference is allowed. */
export interface Rfc64CatalogActivationAccessPolicyAuthorityV1 {
  readonly localAgentAddress: EvmAddressV1;
  readonly peerAgentBindings: readonly Rfc64CatalogPeerAgentBindingV1[];
}

/** Additive policy-neutral activation for selected public and private CGs. */
export interface Rfc64CatalogActivationConfigV1 {
  readonly enabled?: boolean;
  readonly deploymentProfile?: CatalogSealDeploymentProfileV1;
  readonly accessPolicyAuthority?: Rfc64CatalogActivationAccessPolicyAuthorityV1;
  /** Ordinary selected-CG SWM authoring. Private fan-out is narrowed to complete providers. */
  readonly autoPublish?: Rfc64CatalogAutoPublishConfigV1;
  readonly bootstrap?: Rfc64CatalogBootstrapConfigV1;
  readonly rollout?: Rfc64CatalogRolloutConfigV1;
}

export interface ResolvedRfc64CatalogActivationConfigV1 {
  readonly enabled: boolean;
  readonly selectedContextGraphs: readonly string[];
  readonly selectedPublicContextGraphs: readonly string[];
  readonly selectedPrivateContextGraphs: readonly string[];
  readonly deploymentProfile?: Readonly<CatalogSealDeploymentProfileV1>;
  readonly accessPolicyAuthority?: Readonly<{
    readonly localAgentAddress: EvmAddressV1;
    readonly peerAgentBindings: readonly Readonly<Rfc64CatalogPeerAgentBindingV1>[];
  }>;
  readonly autoPublish?: Readonly<Rfc64CatalogAutoPublishConfigV1>;
  readonly bootstrap?: Readonly<Rfc64CatalogBootstrapConfigV1>;
  /** Exact pre-compatibility authoring provenance retained across resolved-input round trips. */
  readonly selectedCatalogAuthoringControls:
    readonly ResolvedRfc64SelectedCatalogAuthoringControlV1[];
  readonly rollout: ResolvedRfc64CatalogRolloutConfigV1;
}

export type Rfc64CatalogActivationInputV1 =
  | Rfc64CatalogActivationConfigV1
  | ResolvedRfc64CatalogActivationConfigV1;

export interface ResolvedRfc64CatalogActivationsV1 {
  /** Policy-neutral union used by the Release-1 runtime. */
  readonly catalog: ResolvedRfc64CatalogActivationConfigV1;
  /** Compatibility projection used by the existing public status/producer path. */
  readonly publicCatalog: ResolvedRfc64PublicCatalogActivationConfigV1;
  /** Fully resolved unified-selection controls before compatibility manifests are unioned. */
  readonly selectedCatalogAuthoringControls:
    readonly ResolvedRfc64SelectedCatalogAuthoringControlV1[];
}

/**
 * One operator-owned selected-public activation. The accepted bootstrap
 * manifest is deliberately the only graph allowlist; auto-publish graph IDs
 * are derived from the same detached snapshot.
 */
export interface Rfc64PublicCatalogActivationConfigV1 {
  readonly enabled?: boolean;
  readonly deploymentProfile?: CatalogSealDeploymentProfileV1;
  readonly autoPublish?: Rfc64PublicCatalogAutoPublishConfigV1;
  readonly bootstrap?: Rfc64PublicCatalogBootstrapConfigV1;
  readonly rollout?: Rfc64CatalogRolloutConfigV1;
}

export interface ResolvedRfc64PublicCatalogActivationConfigV1 {
  readonly enabled: boolean;
  readonly selectedContextGraphs: readonly string[];
  readonly deploymentProfile?: Readonly<CatalogSealDeploymentProfileV1>;
  readonly autoPublish?: Readonly<Rfc64PublicCatalogAutoPublishConfigV1>;
  readonly bootstrap?: Readonly<Rfc64PublicCatalogBootstrapConfigV1>;
  readonly rollout: ResolvedRfc64CatalogRolloutConfigV1;
}

export type Rfc64PublicCatalogActivationInputV1 =
  | Rfc64PublicCatalogActivationConfigV1
  | ResolvedRfc64PublicCatalogActivationConfigV1;

export type ResolvedRfc64PublicCatalogAutoPublishPolicyV1 =
  | Readonly<{
    mode: 'all-accepted-public';
    config: Readonly<Rfc64PublicCatalogAutoPublishConfigV1>;
  }>
  | Readonly<{
    mode: 'selected-public';
    config: Readonly<Rfc64PublicCatalogAutoPublishConfigV1>;
    selectedContextGraphs: readonly string[];
  }>;

export type ResolvedRfc64SelectedCatalogAuthoringControlV1 = Readonly<{
  readonly kind: 'selected-public' | 'selected-private';
  readonly contextGraphId: string;
  readonly announcementPeers: readonly string[];
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
}>;

/**
 * One immutable authoring lookup. Unified selected-CG controls own an exact
 * graph entry and always win; the compatibility public lane is an explicit
 * fallback and can never admit a private policy.
 */
export interface ResolvedRfc64CatalogAuthoringPolicyV1 {
  readonly byContextGraph: Readonly<
    Record<string, ResolvedRfc64SelectedCatalogAuthoringControlV1>
  >;
  /** Source-compatible default for legacy public-only dynamic policy acceptance. */
  readonly publicDefault?: Readonly<{
    readonly announcementPeers: readonly string[];
    readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
    readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
  }>;
}

export interface Rfc64PublicCatalogControlInputsV1 {
  readonly activation?: ResolvedRfc64PublicCatalogActivationConfigV1;
  readonly legacyDeploymentProfile?: CatalogSealDeploymentProfileV1;
  readonly legacyAutoPublish?: Rfc64PublicCatalogAutoPublishConfigV1;
  readonly legacyBootstrap?: Rfc64PublicCatalogBootstrapConfigV1;
}

export interface ResolvedRfc64PublicCatalogControlsV1 {
  readonly deploymentProfile?: Readonly<CatalogSealDeploymentProfileV1>;
  readonly autoPublishPolicy?: ResolvedRfc64PublicCatalogAutoPublishPolicyV1;
  readonly bootstrap?: Readonly<Rfc64PublicCatalogBootstrapConfigV1>;
  readonly requiresDataDir: boolean;
}

export interface Rfc64PublicCatalogActivationChainIdentityV1 {
  /** Effective RFC-64 network identifier, for example `base:84532`. */
  readonly networkId: NetworkIdV1 | undefined;
  /** Canonical decimal EVM chain identifier, for example `84532`. */
  readonly evmChainId: ChainIdV1 | undefined;
}

/**
 * Parse the chain adapter's namespaced identifier into the two identities
 * consumed by RFC-64 activation. Keeping this grammar in one named helper
 * prevents policy network and deployment chain checks from sharing an
 * ambiguously named raw string boundary.
 */
export function resolveRfc64PublicCatalogActivationChainIdentityV1(
  networkIdInput: string | undefined,
): Rfc64PublicCatalogActivationChainIdentityV1 {
  if (networkIdInput === undefined) {
    return Object.freeze({ networkId: undefined, evmChainId: undefined });
  }
  assertNetworkIdV1(networkIdInput, 'RFC-64 activation networkId');
  const evmChainIdInput = networkIdInput.match(/:(0|[1-9][0-9]*)$/u)?.[1];
  if (evmChainIdInput === undefined) {
    return Object.freeze({ networkId: networkIdInput, evmChainId: undefined });
  }
  assertCanonicalChainId(evmChainIdInput, 'RFC-64 activation evmChainId');
  return Object.freeze({
    networkId: networkIdInput,
    evmChainId: evmChainIdInput,
  });
}

function requireRfc64PublicCatalogActivationChainIdentityV1(
  chainIdentity: Rfc64PublicCatalogActivationChainIdentityV1,
): Readonly<Required<Rfc64PublicCatalogActivationChainIdentityV1>> {
  const selectedNetworkId = chainIdentity.networkId;
  if (selectedNetworkId === undefined) {
    throw new TypeError('enabled rfc64PublicCatalog requires an effective network id');
  }
  assertNetworkIdV1(selectedNetworkId, 'RFC-64 activation networkId');
  const selectedEvmChainId = chainIdentity.evmChainId;
  if (selectedEvmChainId === undefined) {
    throw new TypeError('enabled rfc64PublicCatalog requires a numeric EVM chain id');
  }
  assertCanonicalChainId(selectedEvmChainId, 'RFC-64 activation evmChainId');
  const derived = resolveRfc64PublicCatalogActivationChainIdentityV1(selectedNetworkId);
  if (derived.evmChainId !== selectedEvmChainId) {
    throw new TypeError('RFC-64 activation network and EVM chain ids differ');
  }
  return Object.freeze({
    networkId: selectedNetworkId,
    evmChainId: selectedEvmChainId,
  });
}

function requireRfc64CatalogActivationChainIdentityV1(
  chainIdentity: Rfc64PublicCatalogActivationChainIdentityV1,
): Readonly<Required<Rfc64PublicCatalogActivationChainIdentityV1>> {
  const selectedNetworkId = chainIdentity.networkId;
  if (selectedNetworkId === undefined) {
    throw new TypeError('enabled rfc64Catalog requires an effective network id');
  }
  assertNetworkIdV1(selectedNetworkId, 'RFC-64 activation networkId');
  const selectedEvmChainId = chainIdentity.evmChainId;
  if (selectedEvmChainId === undefined) {
    throw new TypeError('enabled rfc64Catalog requires a numeric EVM chain id');
  }
  assertCanonicalChainId(selectedEvmChainId, 'RFC-64 activation evmChainId');
  const derived = resolveRfc64PublicCatalogActivationChainIdentityV1(selectedNetworkId);
  if (derived.evmChainId !== selectedEvmChainId) {
    throw new TypeError('RFC-64 activation network and EVM chain ids differ');
  }
  return Object.freeze({
    networkId: selectedNetworkId,
    evmChainId: selectedEvmChainId,
  });
}

/**
 * Resolve the complete fail-closed operator activation into exact agent
 * inputs. This function owns the cross-field invariants so every daemon uses
 * one immutable bootstrap snapshot for selection, subscription, and optional
 * auto-publication.
 */
export function resolveRfc64PublicCatalogActivationConfigV1(
  activation: Rfc64PublicCatalogActivationConfigV1 | undefined,
  chainIdentity: Rfc64PublicCatalogActivationChainIdentityV1,
): ResolvedRfc64PublicCatalogActivationConfigV1 {
  if (activation === undefined) {
    return disabledRfc64PublicCatalogActivationV1();
  }
  assertRfc64PublicCatalogActivationConfigV1(activation);
  const enabledInput = activation.enabled;
  if (enabledInput !== undefined && typeof enabledInput !== 'boolean') {
    throw new TypeError('rfc64PublicCatalog.enabled must be a boolean');
  }
  // Supplying a valid selected-public manifest is itself the operator's
  // activation decision. Keep absence and explicit `enabled: false`
  // fail-closed, while avoiding a second switch that can silently leave an
  // otherwise complete RFC-64 selection dormant.
  const enabled = enabledInput ?? true;
  const bootstrapInput = activation.bootstrap;
  const autoPublishInput = activation.autoPublish;
  const deploymentProfileInput = activation.deploymentProfile;
  if (enabled === false) {
    return disabledRfc64PublicCatalogActivationV1();
  }
  const bootstrap = snapshotRfc64PublicCatalogBootstrapConfigV1(bootstrapInput);
  if (bootstrap === undefined || bootstrap.acceptedPublicPolicies.length === 0) {
    throw new TypeError(
      'enabled rfc64PublicCatalog requires a non-empty bootstrap.acceptedPublicPolicies manifest',
    );
  }
  const {
    networkId: selectedNetworkId,
    evmChainId: selectedEvmChainId,
  } = requireRfc64PublicCatalogActivationChainIdentityV1(chainIdentity);
  for (const { policyEnvelope } of bootstrap.acceptedPublicPolicies) {
    if (policyEnvelope.payload.networkId !== selectedNetworkId) {
      throw new TypeError(
        'rfc64PublicCatalog policy network differs from the daemon effective chain id',
      );
    }
  }
  const selectedContextGraphs = bootstrap.acceptedPublicPolicies.map(
    ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId,
  );
  if (
    autoPublishInput !== undefined
    && Object.prototype.hasOwnProperty.call(autoPublishInput, 'contextGraphIds')
  ) {
    throw new TypeError(
      'rfc64PublicCatalog.autoPublish.contextGraphIds is derived from the bootstrap manifest',
    );
  }
  const deploymentProfile = snapshotRfc64CatalogDeploymentProfileV1(
    deploymentProfileInput,
  );
  if (deploymentProfile !== undefined) {
    if (deploymentProfile.networkId !== selectedNetworkId) {
      throw new TypeError(
        'rfc64PublicCatalog deployment network differs from the daemon effective chain id',
      );
    }
    if (deploymentProfile.assertedAtChainId !== selectedEvmChainId) {
      throw new TypeError(
        'rfc64PublicCatalog deployment EVM chain id differs from the daemon effective chain id',
      );
    }
  }
  const autoPublish = snapshotRfc64PublicCatalogAutoPublishConfigV1(autoPublishInput);
  const rollout = resolveRfc64CatalogRolloutConfigV1(
    activation.rollout,
    selectedContextGraphs,
    'rfc64PublicCatalog',
  );
  return Object.freeze({
    enabled: true,
    selectedContextGraphs: Object.freeze(selectedContextGraphs),
    deploymentProfile,
    autoPublish,
    bootstrap,
    rollout,
  });
}

/** Resolve one additive public/private selection and its manual authority map. */
export function resolveRfc64CatalogActivationConfigV1(
  activation: Rfc64CatalogActivationConfigV1 | undefined,
  chainIdentity: Rfc64PublicCatalogActivationChainIdentityV1,
): ResolvedRfc64CatalogActivationConfigV1 {
  if (activation === undefined) return disabledRfc64CatalogActivationV1();
  assertRfc64CatalogActivationConfigV1(activation);
  if (activation.enabled !== undefined && typeof activation.enabled !== 'boolean') {
    throw new TypeError('rfc64Catalog.enabled must be a boolean');
  }
  if (activation.enabled === false) return disabledRfc64CatalogActivationV1();

  const bootstrap = snapshotRfc64CatalogBootstrapConfigV1(activation.bootstrap);
  if (bootstrap === undefined || bootstrap.acceptedPolicies.length === 0) {
    throw new TypeError(
      'enabled rfc64Catalog requires a non-empty bootstrap.acceptedPolicies manifest',
    );
  }
  const { networkId, evmChainId } = requireRfc64CatalogActivationChainIdentityV1(
    chainIdentity,
  );
  for (const accepted of bootstrap.acceptedPolicies) {
    if (accepted.policyEnvelope.payload.networkId !== networkId) {
      throw new TypeError(
        'rfc64Catalog policy network differs from the daemon effective chain id',
      );
    }
  }

  const deploymentProfile = snapshotRfc64CatalogDeploymentProfileV1(
    activation.deploymentProfile,
  );
  if (deploymentProfile !== undefined) {
    if (deploymentProfile.networkId !== networkId) {
      throw new TypeError(
        'rfc64Catalog deployment network differs from the daemon effective chain id',
      );
    }
    if (deploymentProfile.assertedAtChainId !== evmChainId) {
      throw new TypeError(
        'rfc64Catalog deployment EVM chain id differs from the daemon effective chain id',
      );
    }
  }

  const selectedPublicContextGraphs: string[] = [];
  const selectedPrivateContextGraphs: string[] = [];
  for (const accepted of bootstrap.acceptedPolicies) {
    const policy = accepted.policyEnvelope.payload;
    (policy.accessPolicy === 0
      ? selectedPublicContextGraphs
      : selectedPrivateContextGraphs).push(policy.contextGraphId);
  }
  const accessPolicyAuthority = snapshotRfc64CatalogActivationAccessPolicyAuthorityV1(
    activation.accessPolicyAuthority,
  );
  const autoPublish = snapshotRfc64CatalogAutoPublishConfigV1(
    activation.autoPublish,
  );
  const selectedCatalogAuthoringControls = resolveSelectedCatalogAuthoringControlsV1(
    bootstrap,
    autoPublish,
  );
  validatePrivateActivationAuthorityV1(
    bootstrap,
    selectedPrivateContextGraphs,
    accessPolicyAuthority,
  );
  const selectedContextGraphs = [
    ...selectedPublicContextGraphs,
    ...selectedPrivateContextGraphs,
  ];
  const rollout = resolveRfc64CatalogRolloutConfigV1(
    activation.rollout,
    selectedContextGraphs,
    'rfc64Catalog',
  );
  return Object.freeze({
    enabled: true,
    selectedContextGraphs: Object.freeze(selectedContextGraphs),
    selectedPublicContextGraphs: Object.freeze(selectedPublicContextGraphs),
    selectedPrivateContextGraphs: Object.freeze(selectedPrivateContextGraphs),
    deploymentProfile,
    accessPolicyAuthority,
    autoPublish,
    bootstrap,
    selectedCatalogAuthoringControls,
    rollout,
  });
}

/** Resolve raw or already-resolved additive input at the agent boundary. */
export function resolveRfc64CatalogActivationInputV1(
  input: Rfc64CatalogActivationInputV1 | undefined,
  chainIdentity: Rfc64PublicCatalogActivationChainIdentityV1,
): ResolvedRfc64CatalogActivationConfigV1 {
  if (
    input !== undefined
    && Object.prototype.hasOwnProperty.call(input, 'selectedContextGraphs')
  ) {
    const resolvedInput = input as ResolvedRfc64CatalogActivationConfigV1;
    if (resolvedInput.enabled === false) {
      const rollout = resolvedInput.rollout
        ?? resolveRfc64CatalogRolloutConfigV1(undefined, [], 'rfc64Catalog');
      if (
        resolvedInput.selectedContextGraphs.length !== 0
        || resolvedInput.selectedPublicContextGraphs.length !== 0
        || resolvedInput.selectedPrivateContextGraphs.length !== 0
        || resolvedInput.bootstrap !== undefined
        || resolvedInput.deploymentProfile !== undefined
        || resolvedInput.accessPolicyAuthority !== undefined
        || resolvedInput.autoPublish !== undefined
        || (resolvedInput.selectedCatalogAuthoringControls?.length ?? 0) !== 0
        || rollout.killSwitch
        || Object.keys(rollout.contextGraphModes).length !== 0
      ) {
        throw new TypeError('disabled rfc64Catalog activation must not carry controls');
      }
      return disabledRfc64CatalogActivationV1();
    }
    const resolved = resolveRfc64CatalogActivationConfigV1({
      enabled: resolvedInput.enabled,
      deploymentProfile: resolvedInput.deploymentProfile,
      accessPolicyAuthority: resolvedInput.accessPolicyAuthority,
      bootstrap: resolvedInput.bootstrap,
      rollout: resolvedInput.rollout,
    }, chainIdentity);
    if (
      !sameStrings(resolvedInput.selectedContextGraphs, resolved.selectedContextGraphs)
      || !sameStrings(
        resolvedInput.selectedPublicContextGraphs,
        resolved.selectedPublicContextGraphs,
      )
      || !sameStrings(
        resolvedInput.selectedPrivateContextGraphs,
        resolved.selectedPrivateContextGraphs,
      )
    ) {
      throw new TypeError('rfc64Catalog selected graphs differ from the bootstrap manifest');
    }
    const autoPublish = snapshotRfc64CatalogAutoPublishConfigV1(
      resolvedInput.autoPublish,
    );
    const selectedCatalogAuthoringControls =
      snapshotResolvedCatalogAuthoringControlsV1(
        resolvedInput.selectedCatalogAuthoringControls,
        resolved.bootstrap,
        autoPublish,
      );
    return Object.freeze({
      ...resolved,
      autoPublish,
      selectedCatalogAuthoringControls,
    });
  }
  return resolveRfc64CatalogActivationConfigV1(
    input as Rfc64CatalogActivationConfigV1 | undefined,
    chainIdentity,
  );
}

/**
 * Normalize the additive and compatibility blocks into one runtime manifest.
 * Disjoint selections are unioned. An overlap is accepted only when its policy,
 * targets, and completeness assertion are byte-for-byte equal after canonical
 * snapshotting.
 */
export function resolveRfc64CatalogActivationsV1(
  input: {
    readonly catalog?: Rfc64CatalogActivationInputV1;
    readonly publicCatalog?: Rfc64PublicCatalogActivationInputV1;
  },
  chainIdentity: Rfc64PublicCatalogActivationChainIdentityV1,
): ResolvedRfc64CatalogActivationsV1 {
  const catalog = resolveRfc64CatalogActivationInputV1(input.catalog, chainIdentity);
  const publicCatalog = resolveRfc64PublicCatalogActivationInputV1(
    input.publicCatalog,
    chainIdentity,
  );
  const selectedCatalogAuthoringControls = catalog.selectedCatalogAuthoringControls;
  if (!catalog.enabled && !publicCatalog.enabled) {
    return Object.freeze({ catalog, publicCatalog, selectedCatalogAuthoringControls });
  }

  const byGraph = new Map<string, Rfc64CatalogBootstrapConfigV1['acceptedPolicies'][number]>();
  for (const accepted of catalog.bootstrap?.acceptedPolicies ?? []) {
    byGraph.set(accepted.policyEnvelope.payload.contextGraphId, accepted);
  }
  for (const acceptedPublic of publicCatalog.bootstrap?.acceptedPublicPolicies ?? []) {
    const accepted = Object.freeze({
      policyEnvelope: acceptedPublic.policyEnvelope,
      targets: acceptedPublic.targets,
      ...(acceptedPublic.completeSwmProviders === undefined
        ? {}
        : { completeSwmProviders: acceptedPublic.completeSwmProviders }),
    });
    const contextGraphId = accepted.policyEnvelope.payload.contextGraphId;
    const current = byGraph.get(contextGraphId);
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(accepted)) {
      throw new TypeError(
        `rfc64Catalog and rfc64PublicCatalog conflict for selected graph ${contextGraphId}`,
      );
    }
    byGraph.set(contextGraphId, current ?? accepted);
  }

  const deploymentProfile = mergeDeploymentProfilesV1(
    catalog.deploymentProfile,
    publicCatalog.deploymentProfile,
  );
  const retryIntervals = [
    catalog.bootstrap?.retryIntervalMs,
    publicCatalog.bootstrap?.retryIntervalMs,
  ].filter((value): value is number => value !== undefined);
  if (new Set(retryIntervals).size > 1) {
    throw new TypeError(
      'rfc64Catalog and rfc64PublicCatalog bootstrap retry intervals conflict',
    );
  }
  // Each compatibility block is bounded when it is snapshotted above, but
  // their union must satisfy the same global limits. Re-snapshot the merged
  // manifest so two individually valid blocks cannot bypass the 64-policy or
  // 256-target activation bounds.
  const mergedBootstrap = snapshotRfc64CatalogBootstrapConfigV1({
    acceptedPolicies: [...byGraph.values()],
    retryIntervalMs: retryIntervals[0] ?? 30_000,
  });
  if (mergedBootstrap === undefined) {
    throw new TypeError('merged RFC-64 catalog bootstrap is unavailable');
  }
  const acceptedPolicies = mergedBootstrap.acceptedPolicies;
  const selectedPublicContextGraphs = acceptedPolicies
    .filter(({ policyEnvelope }) => policyEnvelope.payload.accessPolicy === 0)
    .map(({ policyEnvelope }) => policyEnvelope.payload.contextGraphId);
  const selectedPrivateContextGraphs = acceptedPolicies
    .filter(({ policyEnvelope }) => policyEnvelope.payload.accessPolicy === 1)
    .map(({ policyEnvelope }) => policyEnvelope.payload.contextGraphId);
  const rollout = mergeRfc64CatalogRolloutConfigsV1(
    catalog.rollout,
    publicCatalog.rollout,
  );
  const mergedCatalog = Object.freeze({
    enabled: true,
    selectedContextGraphs: Object.freeze([
      ...selectedPublicContextGraphs,
      ...selectedPrivateContextGraphs,
    ]),
    selectedPublicContextGraphs: Object.freeze(selectedPublicContextGraphs),
    selectedPrivateContextGraphs: Object.freeze(selectedPrivateContextGraphs),
    deploymentProfile,
    accessPolicyAuthority: catalog.accessPolicyAuthority,
    autoPublish: catalog.autoPublish,
    bootstrap: mergedBootstrap,
    selectedCatalogAuthoringControls,
    rollout,
  });
  return Object.freeze({
    catalog: mergedCatalog,
    publicCatalog,
    selectedCatalogAuthoringControls,
  });
}

/** Join source precedence once at the configuration boundary. */
export function resolveRfc64CatalogAuthoringPolicyV1(input: Readonly<{
  readonly selectedCatalogAuthoringControls:
    readonly ResolvedRfc64SelectedCatalogAuthoringControlV1[];
  readonly legacyPublicFallback?: ResolvedRfc64PublicCatalogAutoPublishPolicyV1;
  readonly acceptedPolicies: Rfc64CatalogBootstrapConfigV1['acceptedPolicies'];
}>): ResolvedRfc64CatalogAuthoringPolicyV1 | undefined {
  const byContextGraph: Record<
    string,
    ResolvedRfc64SelectedCatalogAuthoringControlV1
  > = Object.create(null) as Record<
    string,
    ResolvedRfc64SelectedCatalogAuthoringControlV1
  >;
  for (const control of input.selectedCatalogAuthoringControls) {
    if (byContextGraph[control.contextGraphId] !== undefined) {
      throw new TypeError(
        `rfc64Catalog has duplicate authoring control for ${control.contextGraphId}`,
      );
    }
    byContextGraph[control.contextGraphId] = control;
  }
  const legacy = input.legacyPublicFallback;
  const publicDefault = legacy?.mode === 'all-accepted-public'
    ? Object.freeze({
      announcementPeers: legacy.config.peers,
      catalogIssuerDelegationEffectiveAt:
        legacy.config.catalogIssuerDelegationEffectiveAt ?? ('0' as TimestampMsV1),
      catalogIssuerDelegationExpiresAt:
        legacy.config.catalogIssuerDelegationExpiresAt,
    })
    : undefined;
  if (legacy !== undefined) {
    for (const accepted of input.acceptedPolicies) {
      const policy = accepted.policyEnvelope.payload;
      if (
        policy.accessPolicy !== 0
        || byContextGraph[policy.contextGraphId] !== undefined
        || (
          legacy.mode === 'selected-public'
          && !legacy.selectedContextGraphs.includes(policy.contextGraphId)
        )
      ) continue;
      byContextGraph[policy.contextGraphId] = Object.freeze({
        kind: 'selected-public',
        contextGraphId: policy.contextGraphId,
        announcementPeers: legacy.config.peers,
        catalogIssuerDelegationEffectiveAt:
          legacy.config.catalogIssuerDelegationEffectiveAt ?? ('0' as TimestampMsV1),
        catalogIssuerDelegationExpiresAt:
          legacy.config.catalogIssuerDelegationExpiresAt,
      });
    }
  }
  if (Object.keys(byContextGraph).length === 0 && publicDefault === undefined) return undefined;
  return Object.freeze({
    byContextGraph: Object.freeze(byContextGraph),
    ...(publicDefault === undefined ? {} : { publicDefault }),
  });
}

function resolveSelectedCatalogAuthoringControlsV1(
  bootstrap: Readonly<Rfc64CatalogBootstrapConfigV1>,
  autoPublish: Readonly<Rfc64CatalogAutoPublishConfigV1> | undefined,
): readonly ResolvedRfc64SelectedCatalogAuthoringControlV1[] {
  if (autoPublish === undefined) return Object.freeze([]);
  return Object.freeze(bootstrap.acceptedPolicies.map((accepted) => {
    const policy = accepted.policyEnvelope.payload;
    const announcementPeers = accepted.completeSwmProviders;
    if (announcementPeers === undefined || announcementPeers.length === 0) {
      throw new TypeError(
        `rfc64Catalog autoPublish requires completeSwmProviders for ${policy.contextGraphId}`,
      );
    }
    return Object.freeze({
      kind: policy.accessPolicy === 0 ? 'selected-public' : 'selected-private',
      contextGraphId: policy.contextGraphId,
      announcementPeers,
      catalogIssuerDelegationEffectiveAt:
        autoPublish.catalogIssuerDelegationEffectiveAt ?? ('0' as TimestampMsV1),
      catalogIssuerDelegationExpiresAt:
        autoPublish.catalogIssuerDelegationExpiresAt,
    });
  }));
}

function snapshotResolvedCatalogAuthoringControlsV1(
  input: readonly ResolvedRfc64SelectedCatalogAuthoringControlV1[],
  bootstrap: Readonly<Rfc64CatalogBootstrapConfigV1> | undefined,
  autoPublish: Readonly<Rfc64CatalogAutoPublishConfigV1> | undefined,
): readonly ResolvedRfc64SelectedCatalogAuthoringControlV1[] {
  if (!Array.isArray(input)) {
    throw new TypeError('resolved rfc64Catalog selected authoring controls must be an array');
  }
  if (input.length > MAX_SELECTED_PUBLIC_CONTEXT_GRAPHS_V1) {
    throw new RangeError('resolved rfc64Catalog has too many selected authoring controls');
  }
  if (input.length > 0 && (bootstrap === undefined || autoPublish === undefined)) {
    throw new TypeError(
      'resolved rfc64Catalog authoring controls require bootstrap and autoPublish',
    );
  }
  const acceptedByGraph = new Map(
    (bootstrap?.acceptedPolicies ?? []).map((accepted) => [
      accepted.policyEnvelope.payload.contextGraphId,
      accepted.policyEnvelope.payload,
    ]),
  );
  const expectedEffectiveAt = autoPublish?.catalogIssuerDelegationEffectiveAt
    ?? ('0' as TimestampMsV1);
  const expectedExpiresAt = autoPublish?.catalogIssuerDelegationExpiresAt;
  const seen = new Set<string>();
  return Object.freeze(input.map((control) => {
    if (control === null || typeof control !== 'object' || Array.isArray(control)) {
      throw new TypeError('resolved rfc64Catalog authoring control must be an object');
    }
    const policy = acceptedByGraph.get(control.contextGraphId);
    if (policy === undefined || seen.has(control.contextGraphId)) {
      throw new TypeError(
        `resolved rfc64Catalog authoring control is duplicated or unselected: ${control.contextGraphId}`,
      );
    }
    seen.add(control.contextGraphId);
    const expectedKind = policy.accessPolicy === 0 ? 'selected-public' : 'selected-private';
    if (control.kind !== expectedKind) {
      throw new TypeError(
        `resolved rfc64Catalog authoring control policy kind differs for ${control.contextGraphId}`,
      );
    }
    const announcementPeers = snapshotRfc64PublicCatalogAnnouncementPeersV1(
      control.announcementPeers,
    );
    if (announcementPeers.length === 0) {
      throw new TypeError(
        `resolved rfc64Catalog authoring control has no providers for ${control.contextGraphId}`,
      );
    }
    if (
      control.catalogIssuerDelegationEffectiveAt !== expectedEffectiveAt
      || control.catalogIssuerDelegationExpiresAt !== expectedExpiresAt
    ) {
      throw new TypeError(
        `resolved rfc64Catalog authoring control delegation differs for ${control.contextGraphId}`,
      );
    }
    return Object.freeze({ ...control, announcementPeers });
  }));
}

function disabledRfc64CatalogActivationV1(): ResolvedRfc64CatalogActivationConfigV1 {
  return Object.freeze({
    enabled: false,
    selectedContextGraphs: Object.freeze([]),
    selectedPublicContextGraphs: Object.freeze([]),
    selectedPrivateContextGraphs: Object.freeze([]),
    selectedCatalogAuthoringControls: Object.freeze([]),
    rollout: resolveRfc64CatalogRolloutConfigV1(undefined, [], 'rfc64Catalog'),
  });
}

function disabledRfc64PublicCatalogActivationV1(
): ResolvedRfc64PublicCatalogActivationConfigV1 {
  return Object.freeze({
    enabled: false,
    selectedContextGraphs: Object.freeze([]),
    rollout: resolveRfc64CatalogRolloutConfigV1(undefined, [], 'rfc64PublicCatalog'),
  });
}

function snapshotRfc64CatalogActivationAccessPolicyAuthorityV1(
  input: Rfc64CatalogActivationAccessPolicyAuthorityV1 | undefined,
): ResolvedRfc64CatalogActivationConfigV1['accessPolicyAuthority'] {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('rfc64Catalog.accessPolicyAuthority must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('rfc64Catalog.accessPolicyAuthority must be a plain object');
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 2
    || keys[0] !== 'localAgentAddress'
    || keys[1] !== 'peerAgentBindings'
  ) {
    throw new TypeError('rfc64Catalog.accessPolicyAuthority has unknown or missing fields');
  }
  assertCanonicalEvmAddress(input.localAgentAddress, 'localAgentAddress');
  if (input.localAgentAddress === ZERO_ADDRESS_V1) {
    throw new TypeError('rfc64Catalog.accessPolicyAuthority.localAgentAddress must be nonzero');
  }
  if (!Array.isArray(input.peerAgentBindings)) {
    throw new TypeError('rfc64Catalog.accessPolicyAuthority.peerAgentBindings must be an array');
  }
  const seenPeers = new Set<string>();
  const peerAgentBindings = input.peerAgentBindings.map((binding, index) => {
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new TypeError(`rfc64Catalog peerAgentBindings[${index}] must be a plain object`);
    }
    const bindingPrototype = Object.getPrototypeOf(binding);
    const bindingKeys = Object.keys(binding).sort();
    if (
      (bindingPrototype !== Object.prototype && bindingPrototype !== null)
      || bindingKeys.length !== 2
      || bindingKeys[0] !== 'agentAddress'
      || bindingKeys[1] !== 'peerId'
    ) {
      throw new TypeError(
        `rfc64Catalog peerAgentBindings[${index}] has unknown or missing fields`,
      );
    }
    const [peerId] = snapshotRfc64PublicCatalogAnnouncementPeersV1([binding.peerId]);
    assertCanonicalEvmAddress(binding.agentAddress, `peerAgentBindings[${index}].agentAddress`);
    if (binding.agentAddress === ZERO_ADDRESS_V1) {
      throw new TypeError('rfc64Catalog peer binding agentAddress must be nonzero');
    }
    if (seenPeers.has(peerId!)) {
      throw new TypeError('rfc64Catalog peerAgentBindings must be unique by peerId');
    }
    seenPeers.add(peerId!);
    return Object.freeze({ peerId: peerId!, agentAddress: binding.agentAddress });
  });
  return Object.freeze({
    localAgentAddress: input.localAgentAddress,
    peerAgentBindings: Object.freeze(peerAgentBindings),
  });
}

function validatePrivateActivationAuthorityV1(
  bootstrap: Readonly<Rfc64CatalogBootstrapConfigV1>,
  selectedPrivateContextGraphs: readonly string[],
  authority: ResolvedRfc64CatalogActivationConfigV1['accessPolicyAuthority'],
): void {
  if (selectedPrivateContextGraphs.length === 0) {
    if (authority !== undefined) {
      throw new TypeError(
        'rfc64Catalog.accessPolicyAuthority requires at least one selected private policy',
      );
    }
    return;
  }
  if (authority === undefined) {
    throw new TypeError('selected private rfc64Catalog requires accessPolicyAuthority');
  }
  const bindings = new Map(
    authority.peerAgentBindings.map(({ peerId, agentAddress }) => [peerId, agentAddress]),
  );
  const usedPeers = new Set<string>();
  const currentMemberAddresses = new Set<EvmAddressV1>();
  for (const accepted of bootstrap.acceptedPolicies) {
    if (accepted.policyEnvelope.payload.accessPolicy !== 1) continue;
    const roster = accepted.rosterEnvelope!.payload;
    const members = new Map(roster.members.map((member) => [member.agentAddress, member]));
    for (const member of roster.members) currentMemberAddresses.add(member.agentAddress);
    if (!members.has(authority.localAgentAddress)) {
      throw new TypeError(
        'rfc64Catalog localAgentAddress is not a current member of every selected private CG',
      );
    }
    const providers = new Set([
      ...(accepted.completeSwmProviders ?? []),
      ...accepted.targets.flatMap((target) => target.providers),
    ]);
    for (const peerId of providers) {
      usedPeers.add(peerId);
      const agentAddress = bindings.get(peerId);
      if (agentAddress === undefined) {
        throw new TypeError(
          `rfc64Catalog private provider ${peerId} has no exact peerAgentBinding`,
        );
      }
      if (!members.get(agentAddress)?.roles.includes('provider')) {
        throw new TypeError(
          `rfc64Catalog private provider ${peerId} is not a current roster provider`,
        );
      }
    }
  }
  for (const [peerId, agentAddress] of bindings) {
    if (!usedPeers.has(peerId) && !currentMemberAddresses.has(agentAddress)) {
      throw new TypeError(
        `rfc64Catalog peerAgentBinding ${peerId} is not a current member of any selected private CG`,
      );
    }
  }
}

function mergeDeploymentProfilesV1(
  left: Readonly<CatalogSealDeploymentProfileV1> | undefined,
  right: Readonly<CatalogSealDeploymentProfileV1> | undefined,
): Readonly<CatalogSealDeploymentProfileV1> | undefined {
  if (left !== undefined && right !== undefined && JSON.stringify(left) !== JSON.stringify(right)) {
    throw new TypeError('rfc64Catalog and rfc64PublicCatalog deployment profiles conflict');
  }
  return left ?? right;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Re-snapshot a caller-supplied resolved activation at the agent boundary.
 * The selected graph list must exactly equal the manifest-derived list, so a
 * direct `DKGAgent.create()` caller cannot express split selection.
 */
export function snapshotResolvedRfc64PublicCatalogActivationConfigV1(
  input: ResolvedRfc64PublicCatalogActivationConfigV1 | undefined,
  chainIdentity: Rfc64PublicCatalogActivationChainIdentityV1,
): ResolvedRfc64PublicCatalogActivationConfigV1 | undefined {
  if (input === undefined) return undefined;
  const enabled = input.enabled;
  const selectedContextGraphsInput = input.selectedContextGraphs;
  const deploymentProfileInput = input.deploymentProfile;
  const autoPublishInput = input.autoPublish;
  const bootstrapInput = input.bootstrap;
  const rolloutInput = input.rollout
    ?? resolveRfc64CatalogRolloutConfigV1(undefined, [], 'rfc64PublicCatalog');
  if (
    !Array.isArray(selectedContextGraphsInput)
    || selectedContextGraphsInput.length > MAX_SELECTED_PUBLIC_CONTEXT_GRAPHS_V1
  ) {
    throw new TypeError(
      'rfc64PublicCatalogActivation selected graphs must be a bounded array',
    );
  }
  const selectedContextGraphs = [...selectedContextGraphsInput];
  if (enabled === false) {
    if (
      selectedContextGraphs.length !== 0
      || deploymentProfileInput !== undefined
      || autoPublishInput !== undefined
      || bootstrapInput !== undefined
      || rolloutInput.killSwitch
      || Object.keys(rolloutInput.contextGraphModes).length !== 0
    ) {
      throw new TypeError('disabled rfc64PublicCatalogActivation must not carry controls');
    }
    return disabledRfc64PublicCatalogActivationV1();
  }
  if (enabled !== true) {
    throw new TypeError('rfc64PublicCatalogActivation.enabled must be a boolean');
  }
  const resolved = resolveRfc64PublicCatalogActivationConfigV1({
    enabled: true,
    deploymentProfile: deploymentProfileInput,
    autoPublish: autoPublishInput,
    bootstrap: bootstrapInput,
    rollout: rolloutInput,
  }, chainIdentity);
  if (
    selectedContextGraphs.length !== resolved.selectedContextGraphs.length
    || selectedContextGraphs.some(
      (contextGraphId, index) => contextGraphId !== resolved.selectedContextGraphs[index],
    )
  ) {
    throw new TypeError(
      'rfc64PublicCatalogActivation selected graphs differ from the bootstrap manifest',
    );
  }
  return resolved;
}

/** Resolve raw operator input, while preserving compatibility with the short-lived resolved input. */
export function resolveRfc64PublicCatalogActivationInputV1(
  input: Rfc64PublicCatalogActivationInputV1 | undefined,
  chainIdentity: Rfc64PublicCatalogActivationChainIdentityV1,
): ResolvedRfc64PublicCatalogActivationConfigV1 {
  if (
    input !== undefined
    && Object.prototype.hasOwnProperty.call(input, 'selectedContextGraphs')
  ) {
    return snapshotResolvedRfc64PublicCatalogActivationConfigV1(
      input as ResolvedRfc64PublicCatalogActivationConfigV1,
      chainIdentity,
    )!;
  }
  return resolveRfc64PublicCatalogActivationConfigV1(
    input as Rfc64PublicCatalogActivationConfigV1 | undefined,
    chainIdentity,
  );
}

/**
 * Normalize selected activation and legacy catalog controls into one internal
 * runtime contract before DKGAgent construction begins. The hot publication
 * path consumes only `autoPublishPolicy`; it never interprets sibling public
 * config fields to decide whether graph selection is bounded or legacy-wide.
 */
export function resolveRfc64PublicCatalogControlsV1(
  input: Rfc64PublicCatalogControlInputsV1,
  chainIdentity: Rfc64PublicCatalogActivationChainIdentityV1,
): ResolvedRfc64PublicCatalogControlsV1 {
  if (
    input.activation !== undefined
    && (
      input.legacyDeploymentProfile !== undefined
      || input.legacyAutoPublish !== undefined
      || input.legacyBootstrap !== undefined
    )
  ) {
    throw new TypeError(
      'rfc64PublicCatalogActivation is mutually exclusive with legacy catalog controls',
    );
  }
  const activation = snapshotResolvedRfc64PublicCatalogActivationConfigV1(
    input.activation,
    chainIdentity,
  );
  const deploymentProfile = activation?.deploymentProfile
    ?? snapshotRfc64CatalogDeploymentProfileV1(input.legacyDeploymentProfile);
  const legacyAutoPublish = activation === undefined
    ? snapshotRfc64PublicCatalogAutoPublishConfigV1(input.legacyAutoPublish)
    : undefined;
  const autoPublishPolicy = activation?.autoPublish === undefined
    ? (legacyAutoPublish === undefined
      ? undefined
      : Object.freeze({
        mode: 'all-accepted-public' as const,
        config: legacyAutoPublish,
      }))
    : Object.freeze({
      mode: 'selected-public' as const,
      config: activation.autoPublish,
      selectedContextGraphs: activation.selectedContextGraphs,
    });
  const bootstrap = activation?.bootstrap
    ?? snapshotRfc64PublicCatalogBootstrapConfigV1(input.legacyBootstrap);
  return Object.freeze({
    deploymentProfile,
    autoPublishPolicy,
    bootstrap,
    requiresDataDir: bootstrap !== undefined,
  });
}
