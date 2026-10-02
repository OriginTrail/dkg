// SPDX-License-Identifier: Apache-2.0

import {
  resolveRfc64CatalogActivationsV1,
  resolveRfc64PublicCatalogActivationChainIdentityV1,
  type DKGAgentConfig,
  type ResolvedRfc64CatalogActivationsV1,
} from '../src/index.js';

const resolverIssued = resolveRfc64CatalogActivationsV1(
  { catalog: { enabled: false } },
  resolveRfc64PublicCatalogActivationChainIdentityV1(undefined),
);

const acceptedConfig: DKGAgentConfig = {
  name: 'accepted-resolver-handle',
  rfc64CatalogActivations: resolverIssued,
};
void acceptedConfig;

const copiedFields = {
  catalog: resolverIssued.catalog,
  publicCatalog: resolverIssued.publicCatalog,
  selectedCatalogAuthoringControls: resolverIssued.selectedCatalogAuthoringControls,
  activationState: resolverIssued.activationState,
};

const acceptedCopiedSnapshot: ResolvedRfc64CatalogActivationsV1 = copiedFields;
void acceptedCopiedSnapshot;

const acceptedCopiedConfig: DKGAgentConfig = {
  name: 'accepted-copied-snapshot',
  rfc64CatalogActivations: copiedFields,
};
void acceptedCopiedConfig;

const spreadHandle = { ...resolverIssued };
const acceptedSpreadSnapshot: ResolvedRfc64CatalogActivationsV1 = spreadHandle;
void acceptedSpreadSnapshot;
