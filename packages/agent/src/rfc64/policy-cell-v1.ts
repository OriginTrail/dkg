// SPDX-License-Identifier: Apache-2.0

/**
 * Pure OT-RFC-64 D26 policy-cell classification.
 *
 * This helper deliberately does not authorize a principal. It only converts one
 * already-canonical ContextGraphPolicyV1 into the closed operation modes that
 * policy-aware transports, reconcilers, and evidence collectors must implement.
 * Signatures, policy history/finality, roster freshness, peer-to-agent binding,
 * VM inclusion-time authority, and ingress capabilities remain separate proofs.
 */

import {
  assertContextGraphPolicyV1,
  canonicalizeContextGraphPolicyPayloadV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  type ContextGraphPolicyV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

export const RFC64_POLICY_CELLS_V1 = Object.freeze([
  'public-open',
  'public-curated',
  'private-open',
  'private-curated',
] as const);

export type Rfc64PolicyCellV1 = (typeof RFC64_POLICY_CELLS_V1)[number];

export type Rfc64VmPublisherAuthorizationModeV1 =
  | 'any-wallet'
  | 'direct-eoa-or-safe'
  | 'pca-owner-or-registered-agent';

export interface Rfc64PolicyCellDescriptorV1 {
  readonly cell: Rfc64PolicyCellV1;
  readonly sharing: 'open' | 'invite-only';
  readonly contribution: 'open' | 'curated';
  /** Open sharing forbids an exhaustive member roster; invite-only requires one. */
  readonly rosterMode: 'forbidden' | 'required';
  readonly catalogDisclosure: 'open-authenticated' | 'current-member-only';
  readonly swmSubmission: 'open-authenticated' | 'current-member-only';
  readonly ordinaryPayloadFetch: 'open-authenticated' | 'current-member-only';
  readonly providerEligibility:
    | 'authenticated-exact-bundle-holder'
    | 'current-member-with-provider-role';
  readonly vmPublisherAuthorization: Rfc64VmPublisherAuthorizationModeV1;
  /** Null for open contribution; exact policy value for curated contribution. */
  readonly publishAuthority: EvmAddressV1 | null;
  readonly publishAuthorityAccountId: ContextGraphPolicyV1['publishAuthorityAccountId'];
  /** Unregistered policy has no VM expected set; a registered policy follows chain ordinals. */
  readonly vmExpectedSet: 'none-unregistered' | 'finalized-chain-ordinals';
  /**
   * The exceptional nonmember upload path. Inclusion-time policy still decides
   * eligibility, so current curated policy cannot reject a historical ordinal
   * that was finalized while contribution was open.
   */
  readonly writeOnlyVmIngress:
    | 'not-applicable-open-sharing'
    | 'not-applicable-unregistered'
    | 'finalized-open-inclusion-only'
    | 'historical-open-inclusion-only';
}

/**
 * Snapshot and classify both D26 axes without inferring either from the other.
 * The canonical round trip owns the snapshot before any field is consulted.
 */
export function classifyRfc64PolicyCellV1(
  policyInput: ContextGraphPolicyV1,
): Readonly<Rfc64PolicyCellDescriptorV1> {
  assertContextGraphPolicyV1(policyInput);
  const policy = parseCanonicalContextGraphPolicyPayloadV1(
    canonicalizeContextGraphPolicyPayloadV1(policyInput),
  );

  const openSharing = policy.accessPolicy === 0;
  const openContribution = policy.publishPolicy === 1;
  const registered = policy.source.kind === 'finalized-chain';
  const vmPublisherAuthorization: Rfc64VmPublisherAuthorizationModeV1 =
    openContribution
      ? 'any-wallet'
      : policy.publishAuthorityAccountId === '0'
        ? 'direct-eoa-or-safe'
        : 'pca-owner-or-registered-agent';

  const writeOnlyVmIngress: Rfc64PolicyCellDescriptorV1['writeOnlyVmIngress'] =
    openSharing
      ? 'not-applicable-open-sharing'
      : !registered
        ? 'not-applicable-unregistered'
        : openContribution
          ? 'finalized-open-inclusion-only'
          : 'historical-open-inclusion-only';

  return Object.freeze({
    cell: policyCell(policy.accessPolicy, policy.publishPolicy),
    sharing: openSharing ? 'open' : 'invite-only',
    contribution: openContribution ? 'open' : 'curated',
    rosterMode: openSharing ? 'forbidden' : 'required',
    catalogDisclosure: openSharing ? 'open-authenticated' : 'current-member-only',
    swmSubmission: openSharing ? 'open-authenticated' : 'current-member-only',
    ordinaryPayloadFetch: openSharing ? 'open-authenticated' : 'current-member-only',
    providerEligibility: openSharing
      ? 'authenticated-exact-bundle-holder'
      : 'current-member-with-provider-role',
    vmPublisherAuthorization,
    publishAuthority: policy.publishAuthority,
    publishAuthorityAccountId: policy.publishAuthorityAccountId,
    vmExpectedSet: registered ? 'finalized-chain-ordinals' : 'none-unregistered',
    writeOnlyVmIngress,
  });
}

function policyCell(
  accessPolicy: ContextGraphPolicyV1['accessPolicy'],
  publishPolicy: ContextGraphPolicyV1['publishPolicy'],
): Rfc64PolicyCellV1 {
  if (accessPolicy === 0) return publishPolicy === 1 ? 'public-open' : 'public-curated';
  return publishPolicy === 1 ? 'private-open' : 'private-curated';
}
