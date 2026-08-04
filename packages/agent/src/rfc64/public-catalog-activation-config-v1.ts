// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalChainId,
  assertNetworkIdV1,
  type CatalogSealDeploymentProfileV1,
  type ChainIdV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';

import type {
  Rfc64PublicCatalogAutoPublishConfigV1,
  Rfc64PublicCatalogBootstrapConfigV1,
} from '../dkg-agent-types.js';
import {
  snapshotRfc64CatalogDeploymentProfileV1,
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from './catalog-authority-config-v1.js';

const MAX_SELECTED_PUBLIC_CONTEXT_GRAPHS_V1 = 64;
const RFC64_PUBLIC_CATALOG_ACTIVATION_FIELDS_V1 = new Set([
  'autoPublish',
  'bootstrap',
  'deploymentProfile',
  'enabled',
]);

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

/**
 * Narrow side-effect-free package surface for daemon/operator activation.
 * Consumers that only normalize RFC-64 configuration must not import the full
 * DKGAgent runtime (which owns process-global scheduler observability).
 */
export {
  snapshotRfc64CatalogDeploymentProfileV1,
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
};

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
}

export interface ResolvedRfc64PublicCatalogActivationConfigV1 {
  readonly enabled: boolean;
  readonly selectedContextGraphs: readonly string[];
  readonly deploymentProfile?: Readonly<CatalogSealDeploymentProfileV1>;
  readonly autoPublish?: Readonly<Rfc64PublicCatalogAutoPublishConfigV1>;
  readonly bootstrap?: Readonly<Rfc64PublicCatalogBootstrapConfigV1>;
}

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
    return Object.freeze({
      enabled: false,
      selectedContextGraphs: Object.freeze([]),
    });
  }
  assertRfc64PublicCatalogActivationConfigV1(activation);
  const enabled = activation.enabled;
  const bootstrapInput = activation.bootstrap;
  const autoPublishInput = activation.autoPublish;
  const deploymentProfileInput = activation.deploymentProfile;
  if (enabled === false) {
    return Object.freeze({
      enabled: false,
      selectedContextGraphs: Object.freeze([]),
    });
  }
  if (enabled !== true) {
    throw new TypeError('rfc64PublicCatalog.enabled must be a boolean');
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
  return Object.freeze({
    enabled: true,
    selectedContextGraphs: Object.freeze(selectedContextGraphs),
    deploymentProfile,
    autoPublish,
    bootstrap,
  });
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
    ) {
      throw new TypeError('disabled rfc64PublicCatalogActivation must not carry controls');
    }
    return Object.freeze({
      enabled: false,
      selectedContextGraphs: Object.freeze([]),
    });
  }
  if (enabled !== true) {
    throw new TypeError('rfc64PublicCatalogActivation.enabled must be a boolean');
  }
  const resolved = resolveRfc64PublicCatalogActivationConfigV1({
    enabled: true,
    deploymentProfile: deploymentProfileInput,
    autoPublish: autoPublishInput,
    bootstrap: bootstrapInput,
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
