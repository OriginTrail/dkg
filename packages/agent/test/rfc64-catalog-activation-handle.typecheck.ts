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

// @ts-expect-error Visible resolved fields are not a resolver-issued activation handle.
const rejectedCopiedHandle: ResolvedRfc64CatalogActivationsV1 = copiedFields;
void rejectedCopiedHandle;

const rejectedCopiedConfig: DKGAgentConfig = {
  name: 'rejected-copied-handle',
  // @ts-expect-error DKGAgentConfig accepts only the opaque resolver result.
  rfc64CatalogActivations: copiedFields,
};
void rejectedCopiedConfig;

const spreadHandle = { ...resolverIssued };
// @ts-expect-error Object spread must not preserve the unnameable activation-handle brand.
const rejectedSpreadHandle: ResolvedRfc64CatalogActivationsV1 = spreadHandle;
void rejectedSpreadHandle;
