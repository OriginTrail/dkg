// SPDX-License-Identifier: Apache-2.0

import { ASSET_NUMBERS } from './fixture.mjs';
import {
  assertExactKeysV1,
  boundedArrayV1,
  isDigestV1,
  parseCanonicalDecimalV1,
  plainRecordV1,
  stableJsonV1,
} from './gate-artifact-codec-primitives.mjs';
import {
  decodePrivateGateRpcEvidenceV1,
} from './gate-artifact-rpc-codec.mjs';
import {
  decodePrivateGateRevokedReceiverStateV1,
} from './gate-artifact-state-codecs.mjs';

const LOCAL_ROSTER_VERSION_RADIX_V1 = 10_000_000_000_000n;
const MAX_U64_V1 = (1n << 64n) - 1n;

const EXPECTED_PRIVATE_DENIAL_CLASSIFICATIONS_V1 = Object.freeze([
  Object.freeze([
    'Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1',
    'catalog-discovery-policy-denied',
  ]),
  Object.freeze([
    'Rfc64PublicCatalogNativeTransportErrorV1',
    'catalog-native-policy-denied',
  ]),
]);

/** Decode pre-application denial plus the proof that no private graph leaked. */
export function decodePrivateGateOutsiderDenialEvidenceV1(
  value,
  catalog,
  topology,
  expectedKaNumbers,
) {
  const outsider = plainRecordV1(value, 'RFC-64 private gate outsider evidence');
  assertExactKeysV1(outsider, [
    'agentAddress',
    'appliedHeadDigest',
    'catalogScopeDigest',
    'denied',
    'failureClass',
    'failureCode',
    'graphCounts',
    'providerVisibleVmBindings',
    'rpc',
  ], 'RFC-64 private gate outsider evidence');
  assertDenialClassificationV1(outsider, 'RFC-64 private gate outsider denial');
  if (
    outsider.agentAddress !== topology.unauthorizedNode.agentAddress
    || outsider.catalogScopeDigest !== catalog.scopeDigest
    || outsider.appliedHeadDigest !== null
    || outsider.providerVisibleVmBindings !== 0
  ) {
    throw new TypeError('RFC-64 private gate outsider denial applied a catalog head');
  }
  const rpc = decodePrivateGateRpcEvidenceV1(
    outsider.rpc,
    'RFC-64 private gate outsider RPC evidence',
  );
  const graphCounts = boundedArrayV1(
    outsider.graphCounts,
    'RFC-64 private gate outsider graph evidence',
  );
  const seen = new Set();
  for (const [index, entry] of graphCounts.entries()) {
    const row = plainRecordV1(entry, `RFC-64 private gate outsider graph ${index}`);
    assertExactKeysV1(
      row,
      ['kaNumber', 'swm', 'vm'],
      `RFC-64 private gate outsider graph ${index}`,
    );
    if (
      !Number.isSafeInteger(row.kaNumber)
      || row.kaNumber < 0
      || seen.has(row.kaNumber)
      || row.swm !== 0
      || row.vm !== 0
    ) {
      throw new TypeError('RFC-64 private gate outsider graph evidence is not empty and unique');
    }
    seen.add(row.kaNumber);
  }
  if (
    graphCounts.length !== Number(BigInt(catalog.inventoryRowCount))
    || stableJsonV1([...seen].sort((left, right) => left - right))
      !== stableJsonV1(expectedKaNumbers)
    || stableJsonV1(expectedKaNumbers) !== stableJsonV1(ASSET_NUMBERS)
  ) {
    throw new TypeError('RFC-64 private gate outsider graph inventory is not catalog-bound');
  }
  return rpc;
}

/** Decode the finalized roster transition, denial, and retained receiver state. */
export function decodePrivateGateRevokedReceiverDenialEvidenceV1(
  value,
  catalog,
  topology,
) {
  const revoked = plainRecordV1(value, 'RFC-64 private gate revoked-receiver evidence');
  assertExactKeysV1(revoked, [
    'authority',
    'denial',
    'revokedAgentAddress',
    'rosterVersion',
    'state',
  ], 'RFC-64 private gate revoked-receiver evidence');
  const denial = plainRecordV1(revoked.denial, 'RFC-64 private gate revoked-receiver denial');
  assertExactKeysV1(
    denial,
    ['denied', 'failureClass', 'failureCode'],
    'RFC-64 private gate revoked-receiver denial',
  );
  assertDenialClassificationV1(denial, 'RFC-64 private gate revoked-receiver denial');

  const authority = plainRecordV1(
    revoked.authority,
    'RFC-64 private gate revoked-receiver authority',
  );
  assertExactKeysV1(
    authority,
    ['ownerMutation', 'providerObservation', 'schema'],
    'RFC-64 private gate revoked-receiver authority',
  );
  if (authority.schema !== 'dkg-rfc64-private-authorization-transition-v1') {
    throw new TypeError('RFC-64 private gate revoked-receiver authority schema is invalid');
  }
  const owner = plainRecordV1(
    authority.ownerMutation,
    'RFC-64 private gate owner revocation',
  );
  assertExactKeysV1(
    owner,
    ['chainRosterVersion', 'policyDigest', 'previousChainRosterVersion', 'revokedAgentAddress'],
    'RFC-64 private gate owner revocation',
  );
  const provider = plainRecordV1(
    authority.providerObservation,
    'RFC-64 private gate provider revocation',
  );
  assertExactKeysV1(provider, [
    'chainRosterVersion',
    'curatorMetadataRefreshed',
    'effectiveRosterVersion',
    'localRosterVersion',
    'policyDigest',
    'previousChainRosterVersion',
    'providerMutationDenied',
    'revokedAgentAddress',
  ], 'RFC-64 private gate provider revocation');
  const addresses = [
    revoked.revokedAgentAddress,
    owner.revokedAgentAddress,
    provider.revokedAgentAddress,
  ];
  const ownerPrevious = parseCanonicalDecimalV1(owner.previousChainRosterVersion, true);
  const ownerCurrent = parseCanonicalDecimalV1(owner.chainRosterVersion, false);
  const providerPrevious = parseCanonicalDecimalV1(provider.previousChainRosterVersion, true);
  const providerCurrent = parseCanonicalDecimalV1(provider.chainRosterVersion, false);
  const providerLocal = parseCanonicalDecimalV1(provider.localRosterVersion, false);
  const providerEffective = parseCanonicalDecimalV1(provider.effectiveRosterVersion, false);
  const current = parseCanonicalDecimalV1(revoked.rosterVersion, false);
  let composedProviderVersion = null;
  try {
    composedProviderVersion = composeRegisteredRosterVersionV1(
      provider.chainRosterVersion,
      provider.localRosterVersion,
    );
  } catch {
    // The common inconsistency error below keeps persisted diagnostics bounded.
  }
  if (
    provider.curatorMetadataRefreshed !== true
    || provider.providerMutationDenied !== true
    || !addresses.every((address) => (
      typeof address === 'string'
      && /^0x[0-9a-f]{40}$/u.test(address)
      && address === addresses[0]
    ))
    || addresses[0] !== topology.authorizedReceiver.agentAddress
    || ownerPrevious === null
    || ownerCurrent === null
    || providerPrevious === null
    || providerCurrent === null
    || current === null
    || revoked.rosterVersion !== provider.effectiveRosterVersion
    || ownerPrevious !== providerPrevious
    || ownerCurrent <= ownerPrevious
    || providerCurrent <= providerPrevious
    || providerCurrent !== ownerCurrent
    || providerLocal === null
    || providerEffective === null
    || composedProviderVersion !== provider.effectiveRosterVersion
    || !isDigestV1(owner.policyDigest)
    || owner.policyDigest !== catalog.policyDigest
    || provider.policyDigest !== owner.policyDigest
  ) {
    throw new TypeError('RFC-64 private gate revoked-receiver authority evidence is inconsistent');
  }
  return decodePrivateGateRevokedReceiverStateV1(revoked.state, catalog, topology);
}

function composeRegisteredRosterVersionV1(chainRosterVersion, localRosterVersion) {
  const chain = parseCanonicalDecimalV1(chainRosterVersion, true);
  const local = parseCanonicalDecimalV1(localRosterVersion, true);
  if (
    chain === null
    || local === null
    || local >= LOCAL_ROSTER_VERSION_RADIX_V1
  ) throw new TypeError('RFC-64 private gate roster generation is invalid');
  const combined = chain * LOCAL_ROSTER_VERSION_RADIX_V1 + local;
  if (combined > MAX_U64_V1) {
    throw new TypeError('RFC-64 private gate roster generation exceeds uint64');
  }
  return combined.toString(10);
}

function assertDenialClassificationV1(value, label) {
  if (
    value.denied !== true
    || !EXPECTED_PRIVATE_DENIAL_CLASSIFICATIONS_V1.some(
      ([failureClass, failureCode]) => (
        value.failureClass === failureClass && value.failureCode === failureCode
      ),
    )
  ) {
    throw new TypeError(`${label} is not a typed RFC-64 policy denial`);
  }
}
