import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  assertContextGraphIdV1,
  assertNetworkIdV1,
  type ContextGraphIdV1,
  type NetworkIdV1,
} from './author-catalog-codec.js';
import {
  assertSignedControlEnvelope,
  assertUnsignedControlEnvelope,
  canonicalizeSignedControlEnvelopeBytes,
  canonicalizeUnsignedControlEnvelopeBytes,
  computeControlObjectDigestHex,
  parseCanonicalSignedControlEnvelope,
  parseCanonicalUnsignedControlEnvelope,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from './sync-control-object.js';
import {
  assertCanonicalChainId,
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalTimestampMs,
  parseCanonicalDecimalU64,
  type ChainIdV1,
  type DecimalU256V1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type TimestampMsV1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

export const CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1 = 'ContextGraphPolicyV1' as const;
export const MEMBER_ROSTER_OBJECT_TYPE_V1 = 'MemberRosterV1' as const;
export const CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1 = 'cg-shared-v1' as const;
export const MAX_CONTEXT_GRAPH_POLICY_PAYLOAD_BYTES_V1 = 8 * 1024;
export const MAX_MEMBER_ROSTER_PAYLOAD_BYTES_V1 = 4 * 1024 * 1024;
export const MAX_MEMBER_ROSTER_ENTRIES_V1 = 16_384;
export const MEMBER_ROSTER_ROLES_V1 = Object.freeze([
  'holder',
  'ingress-host',
  'provider',
] as const);
export const CONTEXT_GRAPH_ACCESS_POLICY_VALUES_V1 = Object.freeze([0, 1] as const);
export const CONTEXT_GRAPH_PUBLISH_POLICY_VALUES_V1 = Object.freeze([0, 1] as const);

export type ContextGraphAccessPolicyV1 = 0 | 1;
export type ContextGraphPublishPolicyV1 = 0 | 1;
export type MemberRosterRoleV1 = (typeof MEMBER_ROSTER_ROLES_V1)[number];

export interface FinalizedChainPolicySourceV1 {
  readonly kind: 'finalized-chain';
  readonly chainId: ChainIdV1;
  readonly contractAddress: EvmAddressV1;
  readonly blockNumber: DecimalU64V1;
  readonly blockHash: Digest32V1;
}

export interface OwnerSignedUnregisteredPolicySourceV1 {
  readonly kind: 'owner-signed-unregistered';
  readonly ownerAddress: EvmAddressV1;
  readonly ownerAuthorityEra: DecimalU64V1;
}

export type ContextGraphPolicySourceV1 =
  | FinalizedChainPolicySourceV1
  | OwnerSignedUnregisteredPolicySourceV1;

export interface ContextGraphPolicyV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly governanceChainId: ChainIdV1 | null;
  readonly governanceContractAddress: EvmAddressV1 | null;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly era: DecimalU64V1;
  readonly version: DecimalU64V1;
  readonly previousPolicyDigest: Digest32V1 | null;
  readonly accessPolicy: ContextGraphAccessPolicyV1;
  readonly publishPolicy: ContextGraphPublishPolicyV1;
  readonly publishAuthority: EvmAddressV1 | null;
  readonly publishAuthorityAccountId: DecimalU256V1;
  readonly projectionId: typeof CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1;
  readonly administrativeDelegationDigest: Digest32V1 | null;
  readonly source: ContextGraphPolicySourceV1;
  readonly effectiveAt: TimestampMsV1;
  readonly issuedAt: TimestampMsV1;
}

export interface MemberRosterEntryV1 {
  readonly agentAddress: EvmAddressV1;
  readonly roles: readonly MemberRosterRoleV1[];
}

export interface MemberRosterV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly era: DecimalU64V1;
  readonly version: DecimalU64V1;
  readonly previousRosterDigest: Digest32V1 | null;
  readonly policyDigest: Digest32V1;
  readonly administrativeDelegationDigest: Digest32V1 | null;
  readonly members: readonly MemberRosterEntryV1[];
  readonly issuedAt: TimestampMsV1;
}

export type UnsignedContextGraphPolicyEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1;
  readonly payload: ContextGraphPolicyV1;
};
export type SignedContextGraphPolicyEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1;
  readonly payload: ContextGraphPolicyV1;
};
export type UnsignedMemberRosterEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof MEMBER_ROSTER_OBJECT_TYPE_V1;
  readonly payload: MemberRosterV1;
};
export type SignedMemberRosterEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof MEMBER_ROSTER_OBJECT_TYPE_V1;
  readonly payload: MemberRosterV1;
};

export type CgPolicyObjectCodecErrorCode =
  | 'cg-policy-schema'
  | 'cg-policy-scalar'
  | 'cg-policy-type'
  | 'cg-policy-governance'
  | 'cg-policy-publish-domain'
  | 'cg-policy-array'
  | 'cg-policy-order'
  | 'cg-policy-duplicate'
  | 'cg-policy-role'
  | 'cg-policy-payload-too-large';

export class CgPolicyObjectCodecError extends Error {
  constructor(
    readonly code: CgPolicyObjectCodecErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'CgPolicyObjectCodecError';
  }
}

export function assertContextGraphPolicyV1(
  value: unknown,
): asserts value is ContextGraphPolicyV1 {
  validateContextGraphPolicySnapshotV1(value);
}

export function assertContextGraphAccessPolicyV1(
  value: unknown,
  label = 'accessPolicy',
): asserts value is ContextGraphAccessPolicyV1 {
  assertPolicyEnum(value, label);
}

export function assertContextGraphPublishPolicyV1(
  value: unknown,
  label = 'publishPolicy',
): asserts value is ContextGraphPublishPolicyV1 {
  assertPolicyEnum(value, label);
}

export function canonicalizeContextGraphPolicyPayloadV1(
  policy: ContextGraphPolicyV1,
): string {
  return validateContextGraphPolicySnapshotV1(policy).canonical;
}

export function canonicalizeContextGraphPolicyPayloadBytesV1(
  policy: ContextGraphPolicyV1,
): Uint8Array {
  return new TextEncoder().encode(canonicalizeContextGraphPolicyPayloadV1(policy));
}

export function parseCanonicalContextGraphPolicyPayloadV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): ContextGraphPolicyV1 {
  rejectOversizedInput(input, MAX_CONTEXT_GRAPH_POLICY_PAYLOAD_BYTES_V1, 'CG policy');
  const value = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_CONTEXT_GRAPH_POLICY_PAYLOAD_BYTES_V1,
      MAX_CONTEXT_GRAPH_POLICY_PAYLOAD_BYTES_V1,
    ),
    maxDepth: Math.min(options.maxDepth ?? 2, 2),
  });
  return validateContextGraphPolicySnapshotV1(value).snapshot;
}

export function assertMemberRosterV1(value: unknown): asserts value is MemberRosterV1 {
  validateMemberRosterSnapshotV1(value);
}

export function canonicalizeMemberRosterPayloadV1(roster: MemberRosterV1): string {
  return validateMemberRosterSnapshotV1(roster).canonical;
}

export function canonicalizeMemberRosterPayloadBytesV1(roster: MemberRosterV1): Uint8Array {
  return new TextEncoder().encode(canonicalizeMemberRosterPayloadV1(roster));
}

export function parseCanonicalMemberRosterPayloadV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): MemberRosterV1 {
  rejectOversizedInput(input, MAX_MEMBER_ROSTER_PAYLOAD_BYTES_V1, 'member roster');
  const value = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_MEMBER_ROSTER_PAYLOAD_BYTES_V1,
      MAX_MEMBER_ROSTER_PAYLOAD_BYTES_V1,
    ),
    maxDepth: Math.min(options.maxDepth ?? 4, 4),
  });
  return validateMemberRosterSnapshotV1(value).snapshot;
}

export function assertUnsignedContextGraphPolicyEnvelopeV1(
  envelope: UnsignedControlEnvelopeV1,
): asserts envelope is UnsignedContextGraphPolicyEnvelopeV1 {
  validateUnsignedContextGraphPolicyEnvelopeSnapshotV1(envelope);
}

export function assertSignedContextGraphPolicyEnvelopeV1(
  envelope: SignedControlEnvelopeV1,
): asserts envelope is SignedContextGraphPolicyEnvelopeV1 {
  validateSignedContextGraphPolicyEnvelopeSnapshotV1(envelope);
}

export function assertUnsignedMemberRosterEnvelopeV1(
  envelope: UnsignedControlEnvelopeV1,
): asserts envelope is UnsignedMemberRosterEnvelopeV1 {
  validateUnsignedMemberRosterEnvelopeSnapshotV1(envelope);
}

export function assertSignedMemberRosterEnvelopeV1(
  envelope: SignedControlEnvelopeV1,
): asserts envelope is SignedMemberRosterEnvelopeV1 {
  validateSignedMemberRosterEnvelopeSnapshotV1(envelope);
}

export function canonicalizeUnsignedContextGraphPolicyEnvelopeBytesV1(
  envelope: UnsignedControlEnvelopeV1,
): Uint8Array {
  const snapshot = validateUnsignedContextGraphPolicyEnvelopeSnapshotV1(envelope);
  return canonicalizeUnsignedControlEnvelopeBytes(snapshot);
}

export function canonicalizeSignedContextGraphPolicyEnvelopeBytesV1(
  envelope: SignedControlEnvelopeV1,
): Uint8Array {
  const snapshot = validateSignedContextGraphPolicyEnvelopeSnapshotV1(envelope);
  return canonicalizeSignedControlEnvelopeBytes(snapshot);
}

export function canonicalizeUnsignedMemberRosterEnvelopeBytesV1(
  envelope: UnsignedControlEnvelopeV1,
): Uint8Array {
  const snapshot = validateUnsignedMemberRosterEnvelopeSnapshotV1(envelope);
  return canonicalizeUnsignedControlEnvelopeBytes(snapshot);
}

export function canonicalizeSignedMemberRosterEnvelopeBytesV1(
  envelope: SignedControlEnvelopeV1,
): Uint8Array {
  const snapshot = validateSignedMemberRosterEnvelopeSnapshotV1(envelope);
  return canonicalizeSignedControlEnvelopeBytes(snapshot);
}

export function computeContextGraphPolicyObjectDigestV1(
  envelope: UnsignedControlEnvelopeV1,
): Digest32V1 {
  const snapshot = validateUnsignedContextGraphPolicyEnvelopeSnapshotV1(envelope);
  return asDigest(computeControlObjectDigestHex(snapshot));
}

export function computeMemberRosterObjectDigestV1(
  envelope: UnsignedControlEnvelopeV1,
): Digest32V1 {
  const snapshot = validateUnsignedMemberRosterEnvelopeSnapshotV1(envelope);
  return asDigest(computeControlObjectDigestHex(snapshot));
}

export function parseCanonicalUnsignedContextGraphPolicyEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedContextGraphPolicyEnvelopeV1 {
  const envelope = parseCanonicalUnsignedControlEnvelope(input, options);
  return validateUnsignedContextGraphPolicyEnvelopeSnapshotV1(envelope);
}

export function parseCanonicalSignedContextGraphPolicyEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedContextGraphPolicyEnvelopeV1 {
  const envelope = parseCanonicalSignedControlEnvelope(input, options);
  return validateSignedContextGraphPolicyEnvelopeSnapshotV1(envelope);
}

export function parseCanonicalUnsignedMemberRosterEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedMemberRosterEnvelopeV1 {
  const envelope = parseCanonicalUnsignedControlEnvelope(input, options);
  return validateUnsignedMemberRosterEnvelopeSnapshotV1(envelope);
}

export function parseCanonicalSignedMemberRosterEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedMemberRosterEnvelopeV1 {
  const envelope = parseCanonicalSignedControlEnvelope(input, options);
  return validateSignedMemberRosterEnvelopeSnapshotV1(envelope);
}

function validateUnsignedContextGraphPolicyEnvelopeSnapshotV1(
  value: unknown,
): UnsignedContextGraphPolicyEnvelopeV1 {
  assertUnsignedContextGraphPolicyEnvelopePlainV1(value);
  const snapshot = clonePlainData(value, 'unsigned CG policy envelope');
  assertUnsignedContextGraphPolicyEnvelopePlainV1(snapshot);
  return snapshot;
}

function validateSignedContextGraphPolicyEnvelopeSnapshotV1(
  value: unknown,
): SignedContextGraphPolicyEnvelopeV1 {
  assertSignedContextGraphPolicyEnvelopePlainV1(value);
  const snapshot = clonePlainData(value, 'signed CG policy envelope');
  assertSignedContextGraphPolicyEnvelopePlainV1(snapshot);
  return snapshot;
}

function validateUnsignedMemberRosterEnvelopeSnapshotV1(
  value: unknown,
): UnsignedMemberRosterEnvelopeV1 {
  assertUnsignedMemberRosterEnvelopePlainV1(value);
  const snapshot = clonePlainData(value, 'unsigned member roster envelope');
  assertUnsignedMemberRosterEnvelopePlainV1(snapshot);
  return snapshot;
}

function validateSignedMemberRosterEnvelopeSnapshotV1(
  value: unknown,
): SignedMemberRosterEnvelopeV1 {
  assertSignedMemberRosterEnvelopePlainV1(value);
  const snapshot = clonePlainData(value, 'signed member roster envelope');
  assertSignedMemberRosterEnvelopePlainV1(snapshot);
  return snapshot;
}

function assertUnsignedContextGraphPolicyEnvelopePlainV1(
  value: unknown,
): asserts value is UnsignedContextGraphPolicyEnvelopeV1 {
  const envelope = value as UnsignedControlEnvelopeV1;
  assertUnsignedControlEnvelope(envelope);
  assertObjectType(envelope.objectType, CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1);
  validateContextGraphPolicyPlainV1(envelope.payload);
}

function assertSignedContextGraphPolicyEnvelopePlainV1(
  value: unknown,
): asserts value is SignedContextGraphPolicyEnvelopeV1 {
  const envelope = value as SignedControlEnvelopeV1;
  assertSignedControlEnvelope(envelope);
  assertObjectType(envelope.objectType, CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1);
  validateContextGraphPolicyPlainV1(envelope.payload);
}

function assertUnsignedMemberRosterEnvelopePlainV1(
  value: unknown,
): asserts value is UnsignedMemberRosterEnvelopeV1 {
  const envelope = value as UnsignedControlEnvelopeV1;
  assertUnsignedControlEnvelope(envelope);
  assertObjectType(envelope.objectType, MEMBER_ROSTER_OBJECT_TYPE_V1);
  validateMemberRosterPlainV1(envelope.payload);
}

function assertSignedMemberRosterEnvelopePlainV1(
  value: unknown,
): asserts value is SignedMemberRosterEnvelopeV1 {
  const envelope = value as SignedControlEnvelopeV1;
  assertSignedControlEnvelope(envelope);
  assertObjectType(envelope.objectType, MEMBER_ROSTER_OBJECT_TYPE_V1);
  validateMemberRosterPlainV1(envelope.payload);
}

function assertContextGraphPolicyStructureV1(
  value: unknown,
): asserts value is ContextGraphPolicyV1 {
  if (!isPlainRecord(value)) fail('cg-policy-schema', 'CG policy must be a plain object');
  closed(value, [
    'accessPolicy',
    'administrativeDelegationDigest',
    'contextGraphId',
    'effectiveAt',
    'era',
    'governanceChainId',
    'governanceContractAddress',
    'issuedAt',
    'networkId',
    'ownershipTransitionDigest',
    'previousPolicyDigest',
    'projectionId',
    'publishAuthority',
    'publishAuthorityAccountId',
    'publishPolicy',
    'source',
    'version',
  ], 'CG policy');
  scalar(() => assertNetworkIdV1(value.networkId));
  scalar(() => assertContextGraphIdV1(value.contextGraphId));
  assertGovernancePair(value.governanceChainId, value.governanceContractAddress);
  optionalDigest(value.ownershipTransitionDigest, 'ownershipTransitionDigest');
  u64(value.era, 'era');
  u64(value.version, 'version');
  optionalDigest(value.previousPolicyDigest, 'previousPolicyDigest');
  assertContextGraphAccessPolicyV1(value.accessPolicy);
  assertContextGraphPublishPolicyV1(value.publishPolicy);
  if (value.publishAuthority !== null) {
    scalar(() => assertCanonicalEvmAddress(value.publishAuthority, 'publishAuthority'));
  }
  scalar(() => assertCanonicalDecimalU256(
    value.publishAuthorityAccountId,
    'publishAuthorityAccountId',
  ));
  if (value.publishPolicy === 1) {
    if (value.publishAuthority !== null || value.publishAuthorityAccountId !== '0') {
      fail(
        'cg-policy-publish-domain',
        'open contribution requires null publishAuthority and account ID zero',
      );
    }
  } else if (value.publishAuthority === null) {
    fail('cg-policy-publish-domain', 'curated contribution requires publishAuthority');
  }
  if (value.projectionId !== CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1) {
    fail('cg-policy-scalar', 'projectionId must be cg-shared-v1');
  }
  optionalDigest(value.administrativeDelegationDigest, 'administrativeDelegationDigest');
  assertPolicySource(
    value.source,
    value.governanceChainId,
    value.governanceContractAddress,
    value.ownershipTransitionDigest,
  );
  scalar(() => assertCanonicalTimestampMs(value.effectiveAt, 'effectiveAt'));
  scalar(() => assertCanonicalTimestampMs(value.issuedAt, 'issuedAt'));
}

function validateContextGraphPolicySnapshotV1(value: unknown): {
  readonly snapshot: ContextGraphPolicyV1;
  readonly canonical: string;
} {
  const bounded = validateContextGraphPolicyPlainV1(value);
  const snapshot = clonePlainData(bounded.snapshot, 'CG policy');
  return validateContextGraphPolicyPlainV1(snapshot);
}

function validateContextGraphPolicyPlainV1(value: unknown): {
  readonly snapshot: ContextGraphPolicyV1;
  readonly canonical: string;
} {
  assertContextGraphPolicyStructureV1(value);
  return { snapshot: value, canonical: canonicalizePolicyAfterStructure(value) };
}

function assertPolicySource(
  source: unknown,
  governanceChainId: unknown,
  governanceContractAddress: unknown,
  ownershipTransitionDigest: unknown,
): void {
  if (!isPlainRecord(source)) {
    fail('cg-policy-schema', 'policy source must be a closed object');
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(source, 'kind');
  if (
    !kindDescriptor?.enumerable
    || !Object.prototype.hasOwnProperty.call(kindDescriptor, 'value')
    || typeof kindDescriptor.value !== 'string'
  ) {
    fail('cg-policy-schema', 'policy source kind must be an enumerable data field');
  }
  const kind = kindDescriptor.value;
  if (kind === 'finalized-chain') {
    closed(source, [
      'blockHash',
      'blockNumber',
      'chainId',
      'contractAddress',
      'kind',
    ], 'finalized-chain policy source');
    scalar(() => assertCanonicalChainId(source.chainId));
    scalar(() => assertCanonicalEvmAddress(source.contractAddress, 'contractAddress'));
    u64(source.blockNumber, 'blockNumber');
    scalar(() => assertCanonicalDigest(source.blockHash, 'blockHash'));
    if (
      governanceChainId === null
      || governanceContractAddress === null
      || governanceChainId !== source.chainId
      || governanceContractAddress !== source.contractAddress
    ) {
      fail('cg-policy-governance', 'finalized source must equal the governance tuple');
    }
    return;
  }
  if (kind === 'owner-signed-unregistered') {
    closed(source, ['kind', 'ownerAddress', 'ownerAuthorityEra'], 'owner policy source');
    scalar(() => assertCanonicalEvmAddress(source.ownerAddress, 'ownerAddress'));
    u64(source.ownerAuthorityEra, 'ownerAuthorityEra');
    if (governanceChainId !== null || governanceContractAddress !== null) {
      fail('cg-policy-governance', 'unregistered source requires a null governance tuple');
    }
    if (ownershipTransitionDigest !== null) {
      fail('cg-policy-governance', 'unregistered source requires a null ownership transition');
    }
    return;
  }
  fail('cg-policy-schema', 'policy source kind is not supported by v1');
}

function assertMemberRosterStructureV1(value: unknown): asserts value is MemberRosterV1 {
  if (!isPlainRecord(value)) fail('cg-policy-schema', 'member roster must be a plain object');
  closed(value, [
    'administrativeDelegationDigest',
    'contextGraphId',
    'era',
    'issuedAt',
    'members',
    'networkId',
    'ownershipTransitionDigest',
    'policyDigest',
    'previousRosterDigest',
    'version',
  ], 'member roster');
  scalar(() => assertNetworkIdV1(value.networkId));
  scalar(() => assertContextGraphIdV1(value.contextGraphId));
  optionalDigest(value.ownershipTransitionDigest, 'ownershipTransitionDigest');
  u64(value.era, 'era');
  u64(value.version, 'version');
  optionalDigest(value.previousRosterDigest, 'previousRosterDigest');
  scalar(() => assertCanonicalDigest(value.policyDigest, 'policyDigest'));
  optionalDigest(value.administrativeDelegationDigest, 'administrativeDelegationDigest');
  assertDenseArray(value.members, 'members', MAX_MEMBER_ROSTER_ENTRIES_V1);
  let previousAddress: string | undefined;
  for (let index = 0; index < value.members.length; index += 1) {
    const member = value.members[index];
    if (!isPlainRecord(member)) fail('cg-policy-schema', `member ${index} must be an object`);
    closed(member, ['agentAddress', 'roles'], `member ${index}`);
    const agentAddressValue = member.agentAddress;
    scalar(() => assertCanonicalEvmAddress(agentAddressValue, `members[${index}].agentAddress`));
    const agentAddress = agentAddressValue as EvmAddressV1;
    if (previousAddress !== undefined && previousAddress >= agentAddress) {
      fail(
        previousAddress === agentAddress ? 'cg-policy-duplicate' : 'cg-policy-order',
        'members must be strictly sorted by agentAddress',
      );
    }
    previousAddress = agentAddress;
    assertDenseArray(member.roles, `members[${index}].roles`, MEMBER_ROSTER_ROLES_V1.length);
    let previousRole: MemberRosterRoleV1 | undefined;
    let previousRoleIndex = -1;
    for (let roleIndex = 0; roleIndex < member.roles.length; roleIndex += 1) {
      const roleValue = member.roles[roleIndex];
      if (typeof roleValue !== 'string') {
        fail('cg-policy-role', 'member role must be a string');
      }
      const canonicalRoleIndex = memberRosterRoleIndexV1(roleValue);
      if (canonicalRoleIndex < 0) {
        fail('cg-policy-role', `unknown member role ${roleValue}`);
      }
      const role = roleValue as MemberRosterRoleV1;
      if (previousRole !== undefined && previousRoleIndex >= canonicalRoleIndex) {
        fail(
          previousRole === role ? 'cg-policy-duplicate' : 'cg-policy-order',
          'member roles must be strictly sorted',
        );
      }
      previousRole = role;
      previousRoleIndex = canonicalRoleIndex;
    }
  }
  scalar(() => assertCanonicalTimestampMs(value.issuedAt, 'issuedAt'));
}

function validateMemberRosterSnapshotV1(value: unknown): {
  readonly snapshot: MemberRosterV1;
  readonly canonical: string;
} {
  const bounded = validateMemberRosterPlainV1(value);
  const snapshot = clonePlainData(bounded.snapshot, 'member roster');
  return validateMemberRosterPlainV1(snapshot);
}

function validateMemberRosterPlainV1(value: unknown): {
  readonly snapshot: MemberRosterV1;
  readonly canonical: string;
} {
  assertMemberRosterStructureV1(value);
  return { snapshot: value, canonical: canonicalizeRosterAfterStructure(value) };
}

function clonePlainData<T>(value: T, label: string): T {
  assertStablePlainDataShape(value, label, 0, new Set<object>());
  try {
    return structuredClone(value);
  } catch (cause) {
    fail('cg-policy-schema', `${label} must be stable structured-cloneable JSON data`, cause);
  }
}

function assertStablePlainDataShape(
  value: unknown,
  label: string,
  depth: number,
  ancestors: Set<object>,
): void {
  if (depth > 64) fail('cg-policy-schema', `${label} exceeds the generic nesting cap`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('cg-policy-schema', `${label} contains a non-JSON number`);
    return;
  }
  if (typeof value !== 'object') {
    fail('cg-policy-schema', `${label} contains a non-JSON implementation value`);
  }
  if (ancestors.has(value)) fail('cg-policy-schema', `${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail('cg-policy-schema', `${label} contains a non-ordinary array`);
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.some((key) => typeof key !== 'string')
        || keys.length !== value.length + 1
      ) {
        fail('cg-policy-schema', `${label} contains a sparse or custom array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          fail('cg-policy-schema', `${label} contains an array accessor`);
        }
        assertStablePlainDataShape(
          descriptor.value,
          `${label}[${index}]`,
          depth + 1,
          ancestors,
        );
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('cg-policy-schema', `${label} contains a non-plain object`);
    }
    const keys = Reflect.ownKeys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string') {
        fail('cg-policy-schema', `${label} contains a symbol property`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail('cg-policy-schema', `${label} contains an object accessor`);
      }
      assertStablePlainDataShape(
        descriptor.value,
        `${label}.${key}`,
        depth + 1,
        ancestors,
      );
    }
  } finally {
    ancestors.delete(value);
  }
}

function memberRosterRoleIndexV1(value: string): number {
  for (let index = 0; index < MEMBER_ROSTER_ROLES_V1.length; index += 1) {
    if (MEMBER_ROSTER_ROLES_V1[index] === value) return index;
  }
  return -1;
}

function assertGovernancePair(chainId: unknown, contractAddress: unknown): void {
  if ((chainId === null) !== (contractAddress === null)) {
    fail('cg-policy-governance', 'governance chain and contract must be jointly null/non-null');
  }
  if (chainId !== null) scalar(() => assertCanonicalChainId(chainId));
  if (contractAddress !== null) {
    scalar(() => assertCanonicalEvmAddress(contractAddress, 'governanceContractAddress'));
  }
}

function assertPolicyEnum(value: unknown, label: string): asserts value is 0 | 1 {
  if (value !== 0 && value !== 1) fail('cg-policy-scalar', `${label} must be JSON number 0 or 1`);
}

function optionalDigest(value: unknown, label: string): void {
  if (value !== null) scalar(() => assertCanonicalDigest(value, label));
}

function u64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail('cg-policy-scalar', `${label} must be canonical DecimalU64V1`, cause);
  }
}

function scalar(operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    fail('cg-policy-scalar', 'policy/roster scalar is not canonical', cause);
  }
}

function closed(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  try {
    assertExactKeys(record, keys, label);
  } catch (cause) {
    fail('cg-policy-schema', `${label} has an invalid field set`, cause);
  }
}

function assertDenseArray(value: unknown, label: string, maxLength: number): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('cg-policy-array', `${label} must be an ordinary array`);
  }
  if (value.length > maxLength) {
    fail('cg-policy-array', `${label} exceeds ${maxLength} entries`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== value.length + 1) {
    fail('cg-policy-array', `${label} must be dense and contain no custom properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('cg-policy-array', `${label} must contain ordinary enumerable values`);
    }
  }
}

function canonicalizePolicyAfterStructure(policy: ContextGraphPolicyV1): string {
  try {
    return canonicalizeJson(policy as unknown as CanonicalJsonValue, {
      maxBytes: MAX_CONTEXT_GRAPH_POLICY_PAYLOAD_BYTES_V1,
      maxDepth: 2,
    });
  } catch (cause) {
    fail('cg-policy-payload-too-large', 'CG policy exceeds its canonical cap', cause);
  }
}

function canonicalizeRosterAfterStructure(roster: MemberRosterV1): string {
  try {
    return canonicalizeJson(roster as unknown as CanonicalJsonValue, {
      maxBytes: MAX_MEMBER_ROSTER_PAYLOAD_BYTES_V1,
      maxDepth: 4,
    });
  } catch (cause) {
    fail('cg-policy-payload-too-large', 'member roster exceeds its canonical cap', cause);
  }
}

function assertObjectType(actual: string, expected: string): void {
  if (actual !== expected) fail('cg-policy-type', `objectType must be exactly ${expected}`);
}

function asDigest(value: string): Digest32V1 {
  assertCanonicalDigest(value, 'objectDigest');
  return value;
}

function rejectOversizedInput(input: string | Uint8Array, maxBytes: number, label: string): void {
  if (typeof input === 'string' && input.length > maxBytes) {
    fail('cg-policy-payload-too-large', `${label} exceeds ${maxBytes} bytes`);
  }
  const bytes = typeof input === 'string'
    ? new TextEncoder().encode(input).byteLength
    : input.byteLength;
  if (bytes > maxBytes) fail('cg-policy-payload-too-large', `${label} exceeds ${maxBytes} bytes`);
}

function fail(code: CgPolicyObjectCodecErrorCode, message: string, cause?: unknown): never {
  throw new CgPolicyObjectCodecError(code, message, cause === undefined ? {} : { cause });
}
