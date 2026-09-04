// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  computeContextGraphPolicyObjectDigestV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type DecimalU64V1,
  type DecimalU256V1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
  type NetworkIdV1,
  type TimestampMsV1,
  type UnsignedContextGraphPolicyEnvelopeV1,
} from '@origintrail-official/dkg-core';
import type { ContextGraphAuthoritySnapshot } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

const ZERO_U64 = '0' as DecimalU64V1;
const ZERO_U256 = '0' as DecimalU256V1;
const ZERO_TIMESTAMP = '0' as TimestampMsV1;
const LOCAL_ROSTER_VERSION_RADIX_V1 = 10_000_000_000_000n;
const MAX_U64_V1 = (1n << 64n) - 1n;

/**
 * Combine the finalized-chain roster generation with the curator-authored
 * lifecycle generation carried by authenticated CG metadata. The chain lane
 * occupies the high-order radix so either a chain membership event or a later
 * local invite/removal strictly advances the RFC-64 roster high-water.
 */
export function composeRfc64RegisteredRosterVersionV1(
  chainRosterVersion: string,
  localRosterVersion: string,
): DecimalU64V1 {
  const chain = canonicalNonNegativeIntegerV1(chainRosterVersion, 'chain roster version');
  const local = canonicalNonNegativeIntegerV1(localRosterVersion, 'local roster version');
  if (local >= LOCAL_ROSTER_VERSION_RADIX_V1) {
    throw new Error('local roster version exceeds its registered RFC-64 generation lane');
  }
  const combined = chain * LOCAL_ROSTER_VERSION_RADIX_V1 + local;
  if (combined > MAX_U64_V1) {
    throw new Error('combined registered RFC-64 roster version exceeds uint64');
  }
  return combined.toString(10) as DecimalU64V1;
}

export interface Rfc64ReleaseNativeAuthoritySnapshotV1 {
  readonly policy: Readonly<ContextGraphPolicyV1>;
  readonly policyDigest: Digest32V1;
  readonly roster: Readonly<MemberRosterV1> | null;
  readonly source: 'finalized-chain' | 'owner-signed-unregistered';
}

export interface Rfc64UnregisteredAuthorityInputV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly ownerAddress: EvmAddressV1;
  readonly accessPolicy: 0 | 1;
  readonly publishPolicy: 0 | 1;
  readonly publishAuthorityAccountId: string;
  readonly memberAddresses: readonly EvmAddressV1[];
  readonly rosterVersion: string;
}

/** Compose a deterministic policy/roster generation from finalized chain evidence. */
export function composeRfc64FinalizedCatalogAuthorityV1(input: Readonly<{
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly snapshot: Readonly<ContextGraphAuthoritySnapshot>;
}>): Rfc64ReleaseNativeAuthoritySnapshotV1 {
  const { snapshot } = input;
  const policy: ContextGraphPolicyV1 = Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: snapshot.chainId as ContextGraphPolicyV1['governanceChainId'],
    governanceContractAddress:
      snapshot.governanceContract as ContextGraphPolicyV1['governanceContractAddress'],
    ownershipTransitionDigest: ownershipTransitionDigestV1(
      input.contextGraphId,
      snapshot.owner,
      snapshot.ownershipEra,
    ),
    era: snapshot.ownershipEra as DecimalU64V1,
    version: snapshot.policyVersion as DecimalU64V1,
    previousPolicyDigest: null,
    accessPolicy: snapshot.accessPolicy as ContextGraphPolicyV1['accessPolicy'],
    publishPolicy: snapshot.publishPolicy as ContextGraphPolicyV1['publishPolicy'],
    publishAuthority:
      snapshot.publishAuthority as ContextGraphPolicyV1['publishAuthority'],
    publishAuthorityAccountId:
      snapshot.publishAuthorityAccountId as ContextGraphPolicyV1['publishAuthorityAccountId'],
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: Object.freeze({
      kind: 'finalized-chain',
      chainId: snapshot.chainId,
      contractAddress: snapshot.governanceContract,
      blockNumber: snapshot.sourceBlockNumber,
      blockHash: snapshot.sourceBlockHash,
    }) as ContextGraphPolicyV1['source'],
    effectiveAt: ZERO_TIMESTAMP,
    issuedAt: ZERO_TIMESTAMP,
  });
  return finishAuthorityV1(
    policy,
    snapshot.owner as EvmAddressV1,
    snapshot.accessPolicy === 1
      ? snapshot.participantAgents.map((address) => address as EvmAddressV1)
      : [],
    snapshot.rosterVersion as DecimalU64V1,
    'finalized-chain',
  );
}

/** Compose the owner-signed release-native generation for a local unregistered CG. */
export function composeRfc64UnregisteredCatalogAuthorityV1(
  input: Rfc64UnregisteredAuthorityInputV1,
): Rfc64ReleaseNativeAuthoritySnapshotV1 {
  const rosterVersion = canonicalU64V1(input.rosterVersion, 'unregistered roster version');
  const publishAuthority = input.publishPolicy === 0 ? input.ownerAddress : null;
  const policy: ContextGraphPolicyV1 = Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: ZERO_U64,
    version: ZERO_U64,
    previousPolicyDigest: null,
    accessPolicy: input.accessPolicy,
    publishPolicy: input.publishPolicy,
    publishAuthority,
    publishAuthorityAccountId: input.publishPolicy === 0
      ? input.publishAuthorityAccountId as ContextGraphPolicyV1['publishAuthorityAccountId']
      : ZERO_U256,
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: Object.freeze({
      kind: 'owner-signed-unregistered',
      ownerAddress: input.ownerAddress,
      ownerAuthorityEra: ZERO_U64,
    }),
    effectiveAt: ZERO_TIMESTAMP,
    issuedAt: ZERO_TIMESTAMP,
  });
  return finishAuthorityV1(
    policy,
    input.ownerAddress,
    input.accessPolicy === 1 ? input.memberAddresses : [],
    rosterVersion,
    'owner-signed-unregistered',
  );
}

function finishAuthorityV1(
  policy: ContextGraphPolicyV1,
  issuer: EvmAddressV1,
  memberAddresses: readonly EvmAddressV1[],
  rosterVersion: DecimalU64V1,
  source: Rfc64ReleaseNativeAuthoritySnapshotV1['source'],
): Rfc64ReleaseNativeAuthoritySnapshotV1 {
  const envelope = {
    issuer,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: policy,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedContextGraphPolicyEnvelopeV1;
  const policyDigest = computeContextGraphPolicyObjectDigestV1(envelope);
  const roster = policy.accessPolicy === 0
    ? null
    : Object.freeze({
      networkId: policy.networkId,
      contextGraphId: policy.contextGraphId,
      ownershipTransitionDigest: policy.ownershipTransitionDigest,
      era: policy.era,
      version: rosterVersion,
      previousRosterDigest: null,
      policyDigest,
      administrativeDelegationDigest: policy.administrativeDelegationDigest,
      // Policy issuance and private read membership are independent chain
      // authorities: ownership must not grant holder/provider access unless
      // the finalized participant roster names that same address.
      members: Object.freeze([...new Set(memberAddresses)]
        .map((address) => address.toLowerCase() as EvmAddressV1)
        .sort()
        .map((agentAddress) => Object.freeze({
          agentAddress,
          roles: Object.freeze(['holder', 'provider'] as const),
        }))),
      issuedAt: ZERO_TIMESTAMP,
    } satisfies MemberRosterV1);
  return Object.freeze({ policy, policyDigest, roster, source });
}

function ownershipTransitionDigestV1(
  contextGraphId: ContextGraphIdV1,
  ownerAddress: string,
  ownershipEra: string,
): Digest32V1 {
  return ethers.keccak256(ethers.toUtf8Bytes(
    `dkg:rfc64:ownership:v1\n${contextGraphId}\n${ownerAddress.toLowerCase()}\n${ownershipEra}`,
  )) as Digest32V1;
}

function canonicalNonNegativeIntegerV1(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be a canonical non-negative integer`);
  }
  return BigInt(value);
}

function canonicalU64V1(value: string, label: string): DecimalU64V1 {
  const parsed = canonicalNonNegativeIntegerV1(value, label);
  if (parsed > MAX_U64_V1) throw new Error(`${label} exceeds uint64`);
  return parsed.toString(10) as DecimalU64V1;
}
