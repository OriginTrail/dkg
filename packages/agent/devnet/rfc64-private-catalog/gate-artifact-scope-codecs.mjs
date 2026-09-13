// SPDX-License-Identifier: Apache-2.0

import { computeAuthorCatalogScopeDigestV1 } from '@origintrail-official/dkg-core';

import {
  ASSET_NUMBERS,
  createPrivateCatalogScope,
  createPrivatePolicyAndRoster,
  roleAgentAddress,
} from './fixture.mjs';
import {
  assertExactKeysV1,
  isAddressV1,
  isDigestV1,
  parseCanonicalDecimalV1,
  plainRecordV1,
} from './gate-artifact-codec-primitives.mjs';

/** Decode the deterministic two-asset catalog identity used by this gate. */
export function decodePrivateGateCatalogEvidenceV1(value) {
  const catalog = plainRecordV1(value, 'RFC-64 private gate catalog evidence');
  assertExactKeysV1(catalog, [
    'catalogVersion',
    'headObjectDigest',
    'inventoryRowCount',
    'policyDigest',
    'scopeDigest',
  ], 'RFC-64 private gate catalog evidence');
  const expectedScopeDigest = computeAuthorCatalogScopeDigestV1(
    createPrivateCatalogScope(),
  );
  const expectedPolicyDigest = createPrivatePolicyAndRoster().policyDigest;
  if (
    !isDigestV1(catalog.headObjectDigest)
    || !isDigestV1(catalog.policyDigest)
    || !isDigestV1(catalog.scopeDigest)
    || parseCanonicalDecimalV1(catalog.catalogVersion, false) === null
    || parseCanonicalDecimalV1(catalog.inventoryRowCount, false) === null
    || catalog.catalogVersion !== '4'
    || catalog.inventoryRowCount !== ASSET_NUMBERS.length.toString()
    || catalog.scopeDigest !== expectedScopeDigest
    || catalog.policyDigest !== expectedPolicyDigest
  ) {
    throw new TypeError('RFC-64 private gate catalog evidence is malformed or not fixture-bound');
  }
  return catalog;
}

/** Decode the four fixed daemon identities and their unique peer bindings. */
export function decodePrivateGateTopologyEvidenceV1(value) {
  const topology = plainRecordV1(value, 'RFC-64 private gate topology evidence');
  assertExactKeysV1(topology, [
    'authorizedProviderReceiver',
    'authorizedReceiver',
    'ownerProvider',
    'unauthorizedNode',
  ], 'RFC-64 private gate topology evidence');
  const roles = Object.fromEntries(Object.entries(topology).map(([key, roleValue]) => {
    const role = plainRecordV1(roleValue, `RFC-64 private gate topology ${key}`);
    assertExactKeysV1(
      role,
      ['agentAddress', 'agentClass', 'peerId'],
      `RFC-64 private gate topology ${key}`,
    );
    if (
      !isAddressV1(role.agentAddress)
      || role.agentClass !== 'DKGAgent'
      || typeof role.peerId !== 'string'
      || role.peerId.length < 1
      || role.peerId.length > 256
    ) {
      throw new TypeError(`RFC-64 private gate topology ${key} is malformed`);
    }
    return [key, role];
  }));
  if (
    new Set(Object.values(roles).map(({ agentAddress }) => agentAddress)).size !== 4
    || new Set(Object.values(roles).map(({ peerId }) => peerId)).size !== 4
  ) {
    throw new TypeError('RFC-64 private gate topology identities are not unique');
  }
  const expectedAddresses = {
    authorizedProviderReceiver: roleAgentAddress('provider2'),
    authorizedReceiver: roleAgentAddress('receiver'),
    ownerProvider: roleAgentAddress('owner'),
    unauthorizedNode: roleAgentAddress('outsider'),
  };
  if (Object.entries(expectedAddresses).some(([key, address]) => (
    roles[key].agentAddress !== address
  ))) throw new TypeError('RFC-64 private gate topology is not fixture-bound');
  return roles;
}
