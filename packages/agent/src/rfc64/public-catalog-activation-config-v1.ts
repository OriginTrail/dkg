// SPDX-License-Identifier: Apache-2.0

/**
 * Narrow side-effect-free package surface for daemon/operator activation.
 * Consumers that only normalize RFC-64 configuration must not import the full
 * DKGAgent runtime (which owns process-global scheduler observability).
 */
export {
  snapshotRfc64CatalogDeploymentProfileV1,
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from './catalog-authority-config-v1.js';
