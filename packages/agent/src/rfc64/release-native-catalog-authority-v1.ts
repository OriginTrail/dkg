// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertContextGraphAccessPolicyV1,
  computeContextGraphPolicyObjectDigestV1,
  snapshotContextGraphPublishDomainV1,
  type ChainIdV1,
  type ContextGraphAccessPolicyV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type ContextGraphPublishDomainV1,
  type DecimalU64V1,
  type DecimalU256V1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
  type NetworkIdV1,
  type TimestampMsV1,
  type UnsignedContextGraphPolicyEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS } from '../dkg-agent-constants.js';

const ZERO_U64 = '0' as DecimalU64V1;
const ZERO_U256 = '0' as DecimalU256V1;
const ZERO_TIMESTAMP = '0' as TimestampMsV1;
const LOCAL_ROSTER_VERSION_RADIX_V1 = 10_000_000_000_000n;
const MAX_U64_V1 = (1n << 64n) - 1n;
type Rfc64CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly Rfc64CanonicalJsonValue[]
  | { readonly [key: string]: Rfc64CanonicalJsonValue };
const AUTHORITY_SNAPSHOT_FIELDS_V1 = Object.freeze([
  'chainId',
  'governanceContract',
  'contextGraphId',
  'owner',
  'active',
  'accessPolicy',
  'publishPolicy',
  'publishAuthority',
  'publishAuthorityAccountId',
  'participantAgents',
  'nameHash',
  'ownershipEra',
  'policyVersion',
  'rosterVersion',
  'sourceBlockNumber',
  'sourceBlockHash',
] as const);

interface Rfc64ParsedAuthoritySnapshotBaseV1 {
  readonly chainId: ChainIdV1;
  readonly governanceContract: EvmAddressV1;
  readonly contextGraphId: DecimalU256V1;
  readonly owner: EvmAddressV1;
  readonly active: boolean;
  readonly accessPolicy: ContextGraphAccessPolicyV1;
  readonly participantAgents: readonly EvmAddressV1[];
  readonly nameHash: Digest32V1;
  readonly ownershipEra: DecimalU64V1;
  readonly policyVersion: DecimalU64V1;
  readonly rosterVersion: DecimalU64V1;
  readonly sourceBlockNumber: DecimalU64V1;
  readonly sourceBlockHash: Digest32V1;
}

export type Rfc64ParsedAuthoritySnapshotV1 = Readonly<
  Rfc64ParsedAuthoritySnapshotBaseV1 & ContextGraphPublishDomainV1
>;

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

/** Snapshot, validate, and normalize the untrusted chain-adapter authority boundary once. */
export function parseRfc64AuthoritySnapshotV1(
  input: unknown,
  expectedContextGraphId: bigint,
): Rfc64ParsedAuthoritySnapshotV1 {
  if (expectedContextGraphId < 0n) {
    throw new Error('expected Context Graph ID must be non-negative');
  }
  const record = snapshotExactAuthorityRecordV1(input);
  const contextGraphId = canonicalDecimalU256V1(record.contextGraphId, 'contextGraphId');
  if (contextGraphId !== expectedContextGraphId.toString(10)) {
    throw new Error('authority snapshot Context Graph ID does not match the requested ID');
  }
  const chainId = canonicalChainIdV1(record.chainId, 'chainId');
  const governanceContract = normalizedAddressV1(
    record.governanceContract,
    'governanceContract',
  );
  const owner = normalizedAddressV1(record.owner, 'owner');
  if (typeof record.active !== 'boolean') {
    throw new Error('active must be a boolean');
  }
  assertContextGraphAccessPolicyV1(record.accessPolicy, 'accessPolicy');
  const publishDomain = snapshotContextGraphPublishDomainV1(
    record.publishPolicy,
    record.publishAuthority === null
      ? null
      : normalizedAddressV1(record.publishAuthority, 'publishAuthority'),
    canonicalDecimalU256V1(
      record.publishAuthorityAccountId,
      'publishAuthorityAccountId',
    ),
  );
  const participantAgents = snapshotParticipantAgentsV1(record.participantAgents);
  return Object.freeze({
    chainId,
    governanceContract,
    contextGraphId,
    owner,
    active: record.active,
    accessPolicy: record.accessPolicy,
    ...publishDomain,
    participantAgents,
    nameHash: normalizedDigestV1(record.nameHash, 'nameHash'),
    ownershipEra: canonicalDecimalU64V1(record.ownershipEra, 'ownershipEra'),
    policyVersion: canonicalDecimalU64V1(record.policyVersion, 'policyVersion'),
    rosterVersion: canonicalDecimalU64V1(record.rosterVersion, 'rosterVersion'),
    sourceBlockNumber: canonicalDecimalU64V1(record.sourceBlockNumber, 'sourceBlockNumber'),
    sourceBlockHash: normalizedDigestV1(record.sourceBlockHash, 'sourceBlockHash'),
  } satisfies Rfc64ParsedAuthoritySnapshotV1);
}

/** Compose a deterministic policy/roster generation from finalized chain evidence. */
export function composeRfc64FinalizedCatalogAuthorityV1(input: Readonly<{
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly snapshot: Rfc64ParsedAuthoritySnapshotV1;
}>): Rfc64ReleaseNativeAuthoritySnapshotV1 {
  const { snapshot } = input;
  const policy = Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: snapshot.chainId,
    governanceContractAddress: snapshot.governanceContract,
    ownershipTransitionDigest: ownershipTransitionDigestV1(
      input.contextGraphId,
      snapshot.owner,
      snapshot.ownershipEra,
    ),
    era: snapshot.ownershipEra,
    version: snapshot.policyVersion,
    previousPolicyDigest: null,
    accessPolicy: snapshot.accessPolicy,
    publishPolicy: snapshot.publishPolicy,
    publishAuthority: snapshot.publishAuthority,
    publishAuthorityAccountId: snapshot.publishAuthorityAccountId,
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: Object.freeze({
      kind: 'finalized-chain',
      chainId: snapshot.chainId,
      contractAddress: snapshot.governanceContract,
      blockNumber: snapshot.sourceBlockNumber,
      blockHash: snapshot.sourceBlockHash,
    }),
    effectiveAt: ZERO_TIMESTAMP,
    issuedAt: ZERO_TIMESTAMP,
  } satisfies ContextGraphPolicyV1);
  return finishAuthorityV1(
    policy,
    snapshot.owner,
    snapshot.accessPolicy === 1 ? snapshot.participantAgents : [],
    snapshot.rosterVersion,
    'finalized-chain',
  );
}

/** Compose the owner-signed release-native generation for a local unregistered CG. */
export function composeRfc64UnregisteredCatalogAuthorityV1(
  input: Rfc64UnregisteredAuthorityInputV1,
): Rfc64ReleaseNativeAuthoritySnapshotV1 {
  const rosterVersion = canonicalU64V1(input.rosterVersion, 'unregistered roster version');
  const publishAuthority = input.publishPolicy === 0 ? input.ownerAddress : null;
  const policy = Object.freeze({
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
      ? canonicalDecimalU256V1(
        input.publishAuthorityAccountId,
        'unregistered publish authority account ID',
      )
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
  } satisfies ContextGraphPolicyV1);
  return finishAuthorityV1(
    policy,
    input.ownerAddress,
    input.accessPolicy === 1 ? input.memberAddresses : [],
    rosterVersion,
    'owner-signed-unregistered',
  );
}

function finishAuthorityV1<const Policy extends ContextGraphPolicyV1 & Rfc64CanonicalJsonValue>(
  policy: Policy,
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
  } satisfies UnsignedContextGraphPolicyEnvelopeV1;
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
      members: snapshotMemberRosterV1(memberAddresses),
      issuedAt: ZERO_TIMESTAMP,
    } satisfies MemberRosterV1);
  return Object.freeze({ policy, policyDigest, roster, source });
}

function ownershipTransitionDigestV1(
  contextGraphId: ContextGraphIdV1,
  ownerAddress: EvmAddressV1,
  ownershipEra: DecimalU64V1,
): Digest32V1 {
  return normalizedDigestV1(ethers.keccak256(ethers.toUtf8Bytes(
    `dkg:rfc64:ownership:v1\n${contextGraphId}\n${ownerAddress.toLowerCase()}\n${ownershipEra}`,
  )), 'ownership transition digest');
}

function snapshotExactAuthorityRecordV1(
  input: unknown,
): Readonly<Record<(typeof AUTHORITY_SNAPSHOT_FIELDS_V1)[number], unknown>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('authority snapshot must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('authority snapshot must be a plain data object');
  }
  const actualKeys = Reflect.ownKeys(input);
  const expectedKeys = [...AUTHORITY_SNAPSHOT_FIELDS_V1].sort();
  if (
    actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || (actualKeys as string[]).sort().some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('authority snapshot has unknown or missing fields');
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of AUTHORITY_SNAPSHOT_FIELDS_V1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`authority snapshot ${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot) as Readonly<
    Record<(typeof AUTHORITY_SNAPSHOT_FIELDS_V1)[number], unknown>
  >;
}

function snapshotParticipantAgentsV1(value: unknown): readonly EvmAddressV1[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('participantAgents must be an ordinary array');
  }
  if (value.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
    throw new Error(
      `participantAgents cannot exceed ${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses`,
    );
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== value.length + 1
    || !keys.includes('length')
  ) {
    throw new Error('participantAgents must be dense and unadorned');
  }
  const members = new Set<EvmAddressV1>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('participantAgents entries must be enumerable data properties');
    }
    members.add(normalizedAddressV1(descriptor.value, `participantAgents[${index}]`));
  }
  return Object.freeze([...members].sort());
}

function snapshotMemberRosterV1(
  memberAddresses: readonly EvmAddressV1[],
): MemberRosterV1['members'] {
  const members = new Set<EvmAddressV1>();
  for (const address of memberAddresses) {
    members.add(normalizedAddressV1(address, 'member address'));
    if (members.size > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
      throw new Error(
        `member roster cannot exceed ${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses`,
      );
    }
  }
  return Object.freeze([...members]
    .sort()
    .map((agentAddress) => Object.freeze({
      agentAddress,
      roles: Object.freeze(['holder', 'provider'] as const),
    })));
}

function canonicalChainIdV1(value: unknown, label: string): ChainIdV1 {
  assertCanonicalChainId(value, label);
  return value;
}

function canonicalDecimalU64V1(value: unknown, label: string): DecimalU64V1 {
  assertCanonicalDecimalU64(value, label);
  return value;
}

function canonicalDecimalU256V1(value: unknown, label: string): DecimalU256V1 {
  assertCanonicalDecimalU256(value, label);
  return value;
}

function normalizedAddressV1(value: unknown, label: string): EvmAddressV1 {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length !== 42) throw new Error(`${label} must be a 20-byte hex address`);
  const normalized = value.toLowerCase();
  assertCanonicalEvmAddress(normalized, label);
  return normalized;
}

function normalizedDigestV1(value: unknown, label: string): Digest32V1 {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length !== 66) throw new Error(`${label} must be a 32-byte hex digest`);
  const normalized = value.toLowerCase();
  assertCanonicalDigest(normalized, label);
  return normalized;
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
