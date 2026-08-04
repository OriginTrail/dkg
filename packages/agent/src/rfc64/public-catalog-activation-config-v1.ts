// SPDX-License-Identifier: Apache-2.0

import type { CatalogSealDeploymentProfileV1 } from '@origintrail-official/dkg-core';

import type {
  Rfc64PublicCatalogAutoPublishConfigV1,
  Rfc64PublicCatalogBootstrapConfigV1,
} from '../dkg-agent-types.js';
import {
  snapshotRfc64CatalogDeploymentProfileV1,
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from './catalog-authority-config-v1.js';

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
  readonly autoPublish?: Omit<Rfc64PublicCatalogAutoPublishConfigV1, 'contextGraphIds'>;
  readonly bootstrap?: Rfc64PublicCatalogBootstrapConfigV1;
}

export interface ResolvedRfc64PublicCatalogActivationConfigV1 {
  readonly enabled: boolean;
  readonly selectedContextGraphs: readonly string[];
  readonly deploymentProfile?: Readonly<CatalogSealDeploymentProfileV1>;
  readonly autoPublish?: Readonly<Rfc64PublicCatalogAutoPublishConfigV1>;
  readonly bootstrap?: Readonly<Rfc64PublicCatalogBootstrapConfigV1>;
}

export interface Rfc64PublicCatalogActivationChainIdentityV1 {
  /** Effective chain-adapter network identifier, for example `base:84532`. */
  readonly chainId: string | undefined;
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
  if (activation === undefined || activation.enabled === false) {
    return Object.freeze({
      enabled: false,
      selectedContextGraphs: Object.freeze([]),
    });
  }
  if (activation.enabled !== true) {
    throw new TypeError('rfc64PublicCatalog.enabled must be a boolean');
  }
  const bootstrap = snapshotRfc64PublicCatalogBootstrapConfigV1(activation.bootstrap);
  if (bootstrap === undefined || bootstrap.acceptedPublicPolicies.length === 0) {
    throw new TypeError(
      'enabled rfc64PublicCatalog requires a non-empty bootstrap.acceptedPublicPolicies manifest',
    );
  }
  const selectedNetworkId = chainIdentity.chainId;
  if (typeof selectedNetworkId !== 'string' || selectedNetworkId.length === 0) {
    throw new TypeError('enabled rfc64PublicCatalog requires an effective chain id');
  }
  const selectedEvmChainId = selectedNetworkId.match(/:(0|[1-9][0-9]*)$/u)?.[1];
  if (selectedEvmChainId === undefined) {
    throw new TypeError(
      'enabled rfc64PublicCatalog requires a namespaced numeric EVM chain id',
    );
  }
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
    activation.autoPublish !== undefined
    && Object.prototype.hasOwnProperty.call(activation.autoPublish, 'contextGraphIds')
  ) {
    throw new TypeError(
      'rfc64PublicCatalog.autoPublish.contextGraphIds is derived from the bootstrap manifest',
    );
  }
  const deploymentProfile = snapshotRfc64CatalogDeploymentProfileV1(
    activation.deploymentProfile,
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
  const autoPublish = activation.autoPublish === undefined
    ? undefined
    : snapshotRfc64PublicCatalogAutoPublishConfigV1({
        ...activation.autoPublish,
        contextGraphIds: selectedContextGraphs,
      });
  return Object.freeze({
    enabled: true,
    selectedContextGraphs: Object.freeze(selectedContextGraphs),
    deploymentProfile,
    autoPublish,
    bootstrap,
  });
}
