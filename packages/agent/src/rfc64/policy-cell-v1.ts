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

export type Rfc64VmPublisherAuthorizationModeV1 =
  | 'any-wallet'
  | 'direct-eoa-or-safe'
  | 'pca-owner-or-registered-agent';

interface Rfc64PolicyCellStaticDescriptorV1 {
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
}

interface Rfc64PolicyCellTableEntryV1 {
  readonly accessPolicy: ContextGraphPolicyV1['accessPolicy'];
  readonly publishPolicy: ContextGraphPolicyV1['publishPolicy'];
  readonly descriptor: Readonly<Rfc64PolicyCellStaticDescriptorV1>;
}

function definePolicyCellV1(
  accessPolicy: ContextGraphPolicyV1['accessPolicy'],
  publishPolicy: ContextGraphPolicyV1['publishPolicy'],
  descriptor: Rfc64PolicyCellStaticDescriptorV1,
): Readonly<Rfc64PolicyCellTableEntryV1> {
  return Object.freeze({
    accessPolicy,
    publishPolicy,
    descriptor: Object.freeze({ ...descriptor }),
  });
}

/** One closed source of truth for both D26 axes and every cell-static mode. */
const RFC64_POLICY_CELL_TABLE_V1 = Object.freeze({
  'public-open': definePolicyCellV1(0, 1, {
    sharing: 'open',
    contribution: 'open',
    rosterMode: 'forbidden',
    catalogDisclosure: 'open-authenticated',
    swmSubmission: 'open-authenticated',
    ordinaryPayloadFetch: 'open-authenticated',
    providerEligibility: 'authenticated-exact-bundle-holder',
  }),
  'public-curated': definePolicyCellV1(0, 0, {
    sharing: 'open',
    contribution: 'curated',
    rosterMode: 'forbidden',
    catalogDisclosure: 'open-authenticated',
    swmSubmission: 'open-authenticated',
    ordinaryPayloadFetch: 'open-authenticated',
    providerEligibility: 'authenticated-exact-bundle-holder',
  }),
  'private-open': definePolicyCellV1(1, 1, {
    sharing: 'invite-only',
    contribution: 'open',
    rosterMode: 'required',
    catalogDisclosure: 'current-member-only',
    swmSubmission: 'current-member-only',
    ordinaryPayloadFetch: 'current-member-only',
    providerEligibility: 'current-member-with-provider-role',
  }),
  'private-curated': definePolicyCellV1(1, 0, {
    sharing: 'invite-only',
    contribution: 'curated',
    rosterMode: 'required',
    catalogDisclosure: 'current-member-only',
    swmSubmission: 'current-member-only',
    ordinaryPayloadFetch: 'current-member-only',
    providerEligibility: 'current-member-with-provider-role',
  }),
} satisfies Record<string, Rfc64PolicyCellTableEntryV1>);

export type Rfc64PolicyCellV1 = keyof typeof RFC64_POLICY_CELL_TABLE_V1;

export const RFC64_POLICY_CELLS_V1: readonly Rfc64PolicyCellV1[] = Object.freeze(
  Object.keys(RFC64_POLICY_CELL_TABLE_V1) as Rfc64PolicyCellV1[],
);

type Rfc64PolicyAxesKeyV1 = `${ContextGraphPolicyV1['accessPolicy']}:${ContextGraphPolicyV1['publishPolicy']}`;

const RFC64_POLICY_CELL_BY_AXES_V1 = buildPolicyCellLookupV1();

export interface Rfc64PolicyCellDescriptorV1 extends Rfc64PolicyCellStaticDescriptorV1 {
  readonly cell: Rfc64PolicyCellV1;
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

  const cell = RFC64_POLICY_CELL_BY_AXES_V1[
    `${policy.accessPolicy}:${policy.publishPolicy}` as Rfc64PolicyAxesKeyV1
  ];
  const cellDescriptor = RFC64_POLICY_CELL_TABLE_V1[cell].descriptor;
  const registered = policy.source.kind === 'finalized-chain';
  const vmPublisherAuthorization: Rfc64VmPublisherAuthorizationModeV1 =
    cellDescriptor.contribution === 'open'
      ? 'any-wallet'
      : policy.publishAuthorityAccountId === '0'
        ? 'direct-eoa-or-safe'
        : 'pca-owner-or-registered-agent';

  const writeOnlyVmIngress: Rfc64PolicyCellDescriptorV1['writeOnlyVmIngress'] =
    cellDescriptor.sharing === 'open'
      ? 'not-applicable-open-sharing'
      : !registered
        ? 'not-applicable-unregistered'
        : cellDescriptor.contribution === 'open'
          ? 'finalized-open-inclusion-only'
          : 'historical-open-inclusion-only';

  return Object.freeze({
    cell,
    ...cellDescriptor,
    vmPublisherAuthorization,
    publishAuthority: policy.publishAuthority,
    publishAuthorityAccountId: policy.publishAuthorityAccountId,
    vmExpectedSet: registered ? 'finalized-chain-ordinals' : 'none-unregistered',
    writeOnlyVmIngress,
  });
}

function buildPolicyCellLookupV1(): Readonly<Record<Rfc64PolicyAxesKeyV1, Rfc64PolicyCellV1>> {
  const lookup = Object.create(null) as Record<string, Rfc64PolicyCellV1>;
  for (const cell of RFC64_POLICY_CELLS_V1) {
    const entry = RFC64_POLICY_CELL_TABLE_V1[cell];
    const key = `${entry.accessPolicy}:${entry.publishPolicy}`;
    if (Object.hasOwn(lookup, key)) {
      throw new Error(`duplicate RFC-64 policy axes in canonical table: ${key}`);
    }
    lookup[key] = cell;
  }
  return Object.freeze(lookup) as Readonly<
    Record<Rfc64PolicyAxesKeyV1, Rfc64PolicyCellV1>
  >;
}
