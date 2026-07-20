import { compareCanonicalCbor } from '../protocol/canonical-cbor.js';
import { decodeProtocolTuple, encodeProtocolTuple } from '../protocol/codec.js';
import { protocolTupleId } from '../protocol/hashes.js';
import {
  verifyThresholdSignedProtocolTuple,
  type WalThresholdAuthority,
} from '../protocol/signatures.js';
import { WAL_V1_ENUMS, type CborProtocolValue, type ProtocolTuple } from '../protocol/schema.js';
import { verifyWalObjectV1 } from '../protocol/wal-object.js';
import {
  decodeDkgPayloadEnvelope,
  encodePublicDkgPayload,
  type EncodedDkgPayloadEnvelope,
} from '../privacy/index.js';
import { rdfError } from './errors.js';
import { bytesEqualV1 } from './keys.js';
import { canonicalizeAbsoluteIriV1 } from './nquads.js';
import {
  RDF_ADAPTER_VERSION_V1,
  RDF_POLICY_MEDIA_TYPE_V1,
  type RdfPolicyAdmissionV1,
  type RdfPolicyInputV1,
} from './types.js';

const HARD_MAXIMUM_WAL_OBJECT_BYTES = 8_589_934_592;
const HARD_MAXIMUM_QUADS_PER_MUTATION = 1_000_000n;
const HARD_MAXIMUM_GRAPH_PREFIXES = 64;
const RDF_POLICY_KIND = BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY);
const DETERMINISTIC_CBOR = BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR);

function sortedUnique<Value extends CborProtocolValue>(
  values: readonly Value[],
  label: string,
): readonly Value[] {
  const output = [...values].sort(compareCanonicalCbor);
  for (let index = 1; index < output.length; index += 1) {
    if (compareCanonicalCbor(output[index - 1]!, output[index]!) === 0) {
      rdfError('WAL_RDF_POLICY_INVALID', label + ' contains a duplicate value');
    }
  }
  return output;
}

function bytes(value: Uint8Array, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    rdfError('WAL_RDF_POLICY_INVALID', label + ' must be exactly ' + length + ' bytes');
  }
  return new Uint8Array(value);
}

function positiveU64(value: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
    rdfError('WAL_RDF_POLICY_INVALID', label + ' must be a positive u64');
  }
  return value;
}

function knownPayloadKind(value: bigint): boolean {
  return Object.values(WAL_V1_ENUMS.payloadKind).some(candidate => BigInt(candidate) === value);
}

function normalizeIriList(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) rdfError('WAL_RDF_POLICY_INVALID', label + ' must be an array');
  return sortedUnique(values.map((value, index) =>
    canonicalizeAbsoluteIriV1(value, label + '[' + index + ']')), label);
}

export function createRdfPolicyV1(input: RdfPolicyInputV1): ProtocolTuple<'RdfPolicyV1'> {
  const adapterVersion = input.adapterVersion ?? RDF_ADAPTER_VERSION_V1;
  const tuple: ProtocolTuple<'RdfPolicyV1'> = [
    1n,
    adapterVersion,
    normalizeIriList(input.allowedGraphPrefixes, 'allowedGraphPrefixes'),
    positiveU64(input.maxQuadsPerMutation, 'maxQuadsPerMutation'),
    positiveU64(input.maxWalObjectBytes, 'maxWalObjectBytes'),
    normalizeIriList(input.singleValuedPredicates ?? [], 'singleValuedPredicates'),
    normalizeIriList(input.multiValuedPredicates ?? [], 'multiValuedPredicates'),
    sortedUnique((input.sharedWriteLogicalKeys ?? []).map((value, index) =>
      bytes(value, 32, 'sharedWriteLogicalKeys[' + index + ']')), 'sharedWriteLogicalKeys'),
    sortedUnique((input.resolverAddresses ?? []).map((value, index) =>
      bytes(value, 20, 'resolverAddresses[' + index + ']')), 'resolverAddresses'),
    sortedUnique((input.expiryAuthorityAddresses ?? []).map((value, index) =>
      bytes(value, 20, 'expiryAuthorityAddresses[' + index + ']')), 'expiryAuthorityAddresses'),
    sortedUnique([...input.allowedPayloadKinds], 'allowedPayloadKinds'),
  ];
  validateRdfPolicyV1(tuple);
  return tuple;
}

export function validateRdfPolicyV1(
  policy: ProtocolTuple<'RdfPolicyV1'>,
  supportedAdapterVersions: readonly bigint[] = [RDF_ADAPTER_VERSION_V1],
): void {
  try {
    encodeProtocolTuple('RdfPolicyV1', policy);
  } catch (error) {
    return rdfError('WAL_RDF_POLICY_INVALID', 'RdfPolicyV1 is not a canonical exact tuple', error);
  }
  if (!supportedAdapterVersions.includes(policy[1])) {
    rdfError('WAL_RDF_ADAPTER_VERSION', 'RDF policy adapter version is not supported');
  }
  if (policy[2].length === 0 || policy[2].length > HARD_MAXIMUM_GRAPH_PREFIXES) {
    rdfError('WAL_RDF_POLICY_INVALID', 'allowedGraphPrefixes must contain between 1 and 64 values');
  }
  normalizeIriList(policy[2], 'allowedGraphPrefixes');
  if (positiveU64(policy[3], 'maxQuadsPerMutation') > HARD_MAXIMUM_QUADS_PER_MUTATION) {
    rdfError('WAL_RDF_POLICY_INVALID', 'maxQuadsPerMutation exceeds the protocol hard limit');
  }
  const maximumBytes = positiveU64(policy[4], 'maxWalObjectBytes');
  if (maximumBytes > BigInt(HARD_MAXIMUM_WAL_OBJECT_BYTES)) {
    rdfError('WAL_RDF_POLICY_INVALID', 'maxWalObjectBytes exceeds the protocol hard limit');
  }
  normalizeIriList(policy[5], 'singleValuedPredicates');
  normalizeIriList(policy[6], 'multiValuedPredicates');
  const single = new Set(policy[5]);
  if (policy[6].some(predicate => single.has(predicate))) {
    rdfError('WAL_RDF_POLICY_INVALID', 'one predicate cannot be both single-valued and multi-valued');
  }
  if (policy[10].length === 0 || policy[10].some(value => !knownPayloadKind(value))) {
    rdfError('WAL_RDF_POLICY_INVALID', 'allowedPayloadKinds must contain only known payload kinds');
  }
}

export function encodeRdfPolicyV1(policy: ProtocolTuple<'RdfPolicyV1'>): Uint8Array {
  validateRdfPolicyV1(policy);
  return encodeProtocolTuple('RdfPolicyV1', policy);
}

export function decodeRdfPolicyV1(
  canonicalBytes: Uint8Array,
  supportedAdapterVersions: readonly bigint[] = [RDF_ADAPTER_VERSION_V1],
): ProtocolTuple<'RdfPolicyV1'> {
  let policy: ProtocolTuple<'RdfPolicyV1'>;
  try {
    policy = decodeProtocolTuple('RdfPolicyV1', canonicalBytes);
  } catch (error) {
    return rdfError('WAL_RDF_POLICY_INVALID', 'invalid canonical RdfPolicyV1 bytes', error);
  }
  validateRdfPolicyV1(policy, supportedAdapterVersions);
  return policy;
}

export function encodeRdfPolicyPayloadV1(
  policy: ProtocolTuple<'RdfPolicyV1'>,
): EncodedDkgPayloadEnvelope {
  return encodePublicDkgPayload({
    payloadKind: RDF_POLICY_KIND,
    codec: DETERMINISTIC_CBOR,
    mediaType: RDF_POLICY_MEDIA_TYPE_V1,
    contentBytes: encodeRdfPolicyV1(policy),
  });
}

export interface AdmitSignedRdfPolicyInputV1 {
  /**
   * This must be the current checkpoint returned by WalAuthorityLifecycle.
   * This function verifies its ID and threshold signatures but does not choose
   * which checkpoint is current.
   */
  readonly currentMembershipCheckpoint: ProtocolTuple<'MembershipCheckpointV1'>;
  readonly expectedMembershipCheckpointId: Uint8Array;
  readonly expectedAuthoritySetId: Uint8Array;
  readonly membershipAuthority: WalThresholdAuthority;
  readonly canonicalWalObjectBytes: Uint8Array;
  /** Exact active view in which the caller intends to author a mutation. */
  readonly targetNamespaceId: Uint8Array;
  /** Optional pin for the policy object's own carrier namespace. */
  readonly expectedPolicyNamespaceId?: Uint8Array;
  readonly supportedAdapterVersions?: readonly bigint[];
  readonly maximumWalObjectBytes?: number;
}

export function admitSignedRdfPolicyV1(input: AdmitSignedRdfPolicyInputV1): RdfPolicyAdmissionV1 {
  const maximumWalObjectBytes = input.maximumWalObjectBytes ?? HARD_MAXIMUM_WAL_OBJECT_BYTES;
  if (
    !Number.isSafeInteger(maximumWalObjectBytes)
    || maximumWalObjectBytes <= 0
    || maximumWalObjectBytes > HARD_MAXIMUM_WAL_OBJECT_BYTES
  ) rdfError('WAL_RDF_POLICY_INVALID', 'maximumWalObjectBytes is outside the protocol range');
  if (!(input.canonicalWalObjectBytes instanceof Uint8Array)) {
    rdfError('WAL_RDF_POLICY_INVALID', 'policy WAL object must be canonical bytes');
  }
  if (input.canonicalWalObjectBytes.length > maximumWalObjectBytes) {
    rdfError('WAL_RDF_OBJECT_TOO_LARGE', 'policy WAL object exceeds the local admission limit');
  }
  const membership = input.currentMembershipCheckpoint;
  try {
    verifyThresholdSignedProtocolTuple('MembershipCheckpointV1', membership, input.membershipAuthority);
  } catch (error) {
    return rdfError('WAL_RDF_POLICY_INVALID', 'current membership checkpoint signature is invalid', error);
  }
  const membershipCheckpointId = protocolTupleId('MembershipCheckpointV1', membership);
  if (!bytesEqualV1(membershipCheckpointId, bytes(input.expectedMembershipCheckpointId, 32, 'expectedMembershipCheckpointId'))) {
    rdfError('WAL_RDF_POLICY_SUBSTITUTION', 'membership checkpoint ID does not match current authority state');
  }
  if (!bytesEqualV1(membership[12], bytes(input.expectedAuthoritySetId, 32, 'expectedAuthoritySetId'))) {
    rdfError('WAL_RDF_POLICY_SUBSTITUTION', 'membership checkpoint names a different authority set');
  }
  let verified;
  try {
    verified = verifyWalObjectV1(input.canonicalWalObjectBytes);
  } catch (error) {
    return rdfError('WAL_RDF_POLICY_INVALID', 'RDF policy must be carried by a valid signed WalObjectV1', error);
  }
  if (!bytesEqualV1(verified.walObjectId, membership[9])) {
    rdfError('WAL_RDF_POLICY_SUBSTITUTION', 'signed membership does not name this RDF policy object');
  }
  const targetNamespaceId = bytes(input.targetNamespaceId, 32, 'targetNamespaceId');
  if (
    input.expectedPolicyNamespaceId !== undefined
    && !bytesEqualV1(
      verified.tuple[1],
      bytes(input.expectedPolicyNamespaceId, 32, 'expectedPolicyNamespaceId'),
    )
  ) rdfError('WAL_RDF_POLICY_SUBSTITUTION', 'RDF policy object is in the wrong carrier namespace');
  if (!membership[8].some(namespaceId => bytesEqualV1(namespaceId, verified.tuple[1]))) {
    rdfError('WAL_RDF_UNAUTHORIZED', 'RDF policy namespace is not active in current membership');
  }
  if (!membership[8].some(namespaceId => bytesEqualV1(namespaceId, targetNamespaceId))) {
    rdfError('WAL_RDF_UNAUTHORIZED', 'RDF mutation target namespace is not active in current membership');
  }
  if (!membership[5].some(writerId => bytesEqualV1(writerId, verified.writerId))) {
    rdfError('WAL_RDF_UNAUTHORIZED', 'RDF policy writer is not authorized by current membership');
  }
  let envelope: ProtocolTuple<'DkgPayloadEnvelopeV1'>;
  try {
    envelope = decodeDkgPayloadEnvelope(verified.payloadBytes);
  } catch (error) {
    return rdfError('WAL_RDF_POLICY_INVALID', 'RDF policy payload envelope is invalid', error);
  }
  if (
    envelope[1] !== RDF_POLICY_KIND
    || envelope[2] !== DETERMINISTIC_CBOR
    || envelope[3] !== RDF_POLICY_MEDIA_TYPE_V1
    || envelope[4] !== null
  ) rdfError('WAL_RDF_POLICY_INVALID', 'RDF policy payload envelope kind, codec, media type, or visibility is invalid');
  const policy = decodeRdfPolicyV1(
    envelope[5],
    input.supportedAdapterVersions ?? [RDF_ADAPTER_VERSION_V1],
  );
  if (!policy[10].includes(RDF_POLICY_KIND)) {
    rdfError('WAL_RDF_POLICY_INVALID', 'RDF policy does not permit the RDF_POLICY payload kind');
  }
  if (BigInt(input.canonicalWalObjectBytes.length) > policy[4]) {
    rdfError('WAL_RDF_OBJECT_TOO_LARGE', 'RDF policy object exceeds its own signed byte limit');
  }
  return {
    policyObjectId: new Uint8Array(verified.walObjectId),
    policy,
    membershipCheckpointId,
    namespaceId: new Uint8Array(targetNamespaceId),
    policyNamespaceId: new Uint8Array(verified.tuple[1]),
    writerId: new Uint8Array(verified.writerId),
    canonicalWalObjectBytes: new Uint8Array(input.canonicalWalObjectBytes),
  };
}
