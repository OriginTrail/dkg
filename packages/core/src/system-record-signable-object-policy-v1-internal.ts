import { type CanonicalJsonValue } from './canonical-json.js';
import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  validateAuthorityTransition,
  validateForkResolution,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type SystemRecordSignatureRoleV1,
} from './system-record-agent-profile-control-codecs-v1-internal.js';
import {
  computeAgentProfileHeadObjectDigestV1,
  validateAgentProfileHeadObjectV1,
  type AgentProfileHeadObjectV1,
} from './system-record-agent-profile-head-codec-v1-internal.js';
import { snapshotSystemRecordDataRecord } from './system-record-agent-profile-primitives-v1-internal.js';
import { failSystemRecordObjectV1 as fail } from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
  SYSTEM_RECORD_MAX_SIGNED_HEAD_JSON_DEPTH,
  type SystemRecordObjectKindV1,
} from './system-record-limits-v1.js';
import { type Digest32V1 } from './sync-wire-scalars.js';

export type SignableSystemRecordObjectV1 =
  | AgentProfileHeadObjectV1
  | AgentProfileAuthorityTransitionV1
  | AgentProfileForkResolutionV1;

export type SignableSystemRecordKindV1 = 'head' | 'transition' | 'fork';
type SignableSystemRecordObjectTypeV1 = SignableSystemRecordObjectV1['objectType'];

interface SignableSystemRecordDescriptorDefinitionV1<T extends SignableSystemRecordObjectV1> {
  readonly kind: SignableSystemRecordKindV1;
  readonly objectType: T['objectType'];
  readonly objectKind: SystemRecordObjectKindV1;
  readonly maxJsonDepth: number;
  readonly validate: (value: unknown) => T;
  readonly digest: (object: T) => Digest32V1;
  readonly bindRoles: (object: T) => readonly SignableSystemRecordRolePolicyV1[];
}

interface SignableSystemRecordDescriptorV1 {
  readonly kind: SignableSystemRecordKindV1;
  readonly objectType: SignableSystemRecordObjectTypeV1;
  readonly objectKind: SystemRecordObjectKindV1;
  readonly maxJsonDepth: number;
  readonly bind: (value: unknown) => BoundSignableSystemRecordPolicyV1;
}

interface SignableSystemRecordRolePolicyV1 {
  readonly role: SystemRecordSignatureRoleV1;
  readonly issuer?: string;
  readonly signatureMessageTuple: (objectDigest: Digest32V1) => CanonicalJsonValue;
}

export interface BoundSignableSystemRecordPolicyV1 {
  readonly kind: SignableSystemRecordKindV1;
  readonly objectKind: SystemRecordObjectKindV1;
  readonly maxJsonDepth: number;
  readonly object: SignableSystemRecordObjectV1;
  readonly objectDigest: Digest32V1;
  readonly requiredRoles: readonly SystemRecordSignatureRoleV1[];
  readonly issuerForRole: (
    role: Exclude<SystemRecordSignatureRoleV1, 'peer'>,
  ) => string;
  readonly signatureMessageTuple: (
    objectDigest: Digest32V1,
    role: SystemRecordSignatureRoleV1,
  ) => CanonicalJsonValue;
}

export interface SignableSystemRecordStaticPolicyV1 {
  readonly kind: SignableSystemRecordKindV1;
  readonly objectKind: SystemRecordObjectKindV1;
  readonly maxJsonDepth: number;
}

const SIGNABLE_SYSTEM_RECORD_DESCRIPTORS_V1 = Object.freeze({
  'agent-profile-head': defineDescriptor<AgentProfileHeadObjectV1>({
    kind: 'head',
    objectType: 'agent-profile-head',
    objectKind: 'agent-profile-head',
    maxJsonDepth: SYSTEM_RECORD_MAX_SIGNED_HEAD_JSON_DEPTH,
    validate: validateAgentProfileHeadObjectV1,
    digest: computeAgentProfileHeadObjectDigestV1,
    bindRoles: (object) => Object.freeze([
      defineRolePolicy('peer', (objectDigest) => [
        object.objectType, objectDigest, object.networkId, recordKey(object),
        object.authoritySequence, object.version,
      ]),
      defineRolePolicy('current-evm', (objectDigest) => [
        object.objectType, objectDigest, object.networkId, recordKey(object),
        object.authoritySequence, object.version, 'current-evm', object.evmIssuer,
      ], object.evmIssuer),
    ]),
  }),
  'authority-transition': defineDescriptor<AgentProfileAuthorityTransitionV1>({
    kind: 'transition',
    objectType: 'authority-transition',
    objectKind: 'authority-transition',
    maxJsonDepth: SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
    validate: validateAuthorityTransition,
    digest: computeAgentProfileAuthorityTransitionDigestV1,
    bindRoles: (object) => Object.freeze([
      defineRolePolicy('peer', (objectDigest) => [
        object.objectType, objectDigest, object.networkId, recordKey(object),
        object.priorAuthoritySequence, object.nextAuthoritySequence,
        object.priorHeadDigest, 'peer',
      ]),
      ...(object.mode === 'co-signed' ? [
        defineRolePolicy('prior-evm', (objectDigest) => [
          object.objectType, objectDigest, object.networkId, recordKey(object),
          object.priorAuthoritySequence, object.nextAuthoritySequence,
          object.priorHeadDigest, 'prior-evm', object.priorEvmIssuer,
        ], object.priorEvmIssuer),
      ] : []),
      defineRolePolicy('next-evm', (objectDigest) => [
        object.objectType, objectDigest, object.networkId, recordKey(object),
        object.priorAuthoritySequence, object.nextAuthoritySequence,
        object.priorHeadDigest, 'next-evm', object.nextEvmIssuer,
      ], object.nextEvmIssuer),
    ]),
  }),
  'fork-resolution': defineDescriptor<AgentProfileForkResolutionV1>({
    kind: 'fork',
    objectType: 'fork-resolution',
    objectKind: 'fork-resolution',
    maxJsonDepth: SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
    validate: validateForkResolution,
    digest: computeAgentProfileForkResolutionDigestV1,
    bindRoles: (object) => Object.freeze([
      defineRolePolicy('peer', (objectDigest) => [
        object.objectType, objectDigest, object.networkId, recordKey(object),
        object.authoritySequence, object.forkedVersion, object.resolutionVersion, 'peer',
      ]),
      defineRolePolicy('current-evm', (objectDigest) => [
        object.objectType, objectDigest, object.networkId, recordKey(object),
        object.authoritySequence, object.forkedVersion, object.resolutionVersion,
        'current-evm', object.evmIssuer,
      ], object.evmIssuer),
    ]),
  }),
}) satisfies Readonly<
  Record<SignableSystemRecordObjectTypeV1, SignableSystemRecordDescriptorV1>
>;

const SIGNABLE_SYSTEM_RECORD_DESCRIPTOR_BY_OBJECT_TYPE_V1 = indexSignableDescriptorsV1<string>(
  (descriptor) => descriptor.objectType,
);
const SIGNABLE_SYSTEM_RECORD_DESCRIPTOR_BY_KIND_V1 =
  indexSignableDescriptorsV1<SignableSystemRecordKindV1>((descriptor) => descriptor.kind);

export function bindSignableSystemRecordPolicyV1(
  value: unknown,
): BoundSignableSystemRecordPolicyV1 {
  const record = snapshotSystemRecordDataRecord(value, 'signed envelope object');
  const descriptor = typeof record.objectType === 'string'
    ? SIGNABLE_SYSTEM_RECORD_DESCRIPTOR_BY_OBJECT_TYPE_V1.get(record.objectType)
    : undefined;
  return descriptor?.bind(record)
    ?? fail('system-record-schema', 'signed envelope object type is unsupported');
}

export function signableSystemRecordStaticPolicyV1(
  kind: SignableSystemRecordKindV1,
): SignableSystemRecordStaticPolicyV1 {
  const descriptor = SIGNABLE_SYSTEM_RECORD_DESCRIPTOR_BY_KIND_V1.get(kind)
    ?? fail('system-record-schema', 'signable object kind is unsupported');
  return Object.freeze({
    kind: descriptor.kind,
    objectKind: descriptor.objectKind,
    maxJsonDepth: descriptor.maxJsonDepth,
  });
}

function defineDescriptor<T extends SignableSystemRecordObjectV1>(
  definition: SignableSystemRecordDescriptorDefinitionV1<T>,
): SignableSystemRecordDescriptorV1 {
  return Object.freeze({
    kind: definition.kind,
    objectType: definition.objectType,
    objectKind: definition.objectKind,
    maxJsonDepth: definition.maxJsonDepth,
    bind: (value: unknown) => bindDescriptor(definition, value),
  });
}

function bindDescriptor<T extends SignableSystemRecordObjectV1>(
  descriptor: SignableSystemRecordDescriptorDefinitionV1<T>,
  value: unknown,
): BoundSignableSystemRecordPolicyV1 {
  const object = descriptor.validate(value);
  const rolePolicies = Object.freeze([...descriptor.bindRoles(object)]);
  return Object.freeze({
    kind: descriptor.kind,
    objectKind: descriptor.objectKind,
    maxJsonDepth: descriptor.maxJsonDepth,
    object,
    objectDigest: descriptor.digest(object),
    requiredRoles: Object.freeze(rolePolicies.map(({ role }) => role)),
    issuerForRole: (role: Exclude<SystemRecordSignatureRoleV1, 'peer'>) => {
      const issuer = rolePolicy(rolePolicies, role, object.objectType).issuer;
      return issuer ?? invalidRole(role, object.objectType);
    },
    signatureMessageTuple: (
      objectDigest: Digest32V1,
      role: SystemRecordSignatureRoleV1,
    ) => rolePolicy(rolePolicies, role, object.objectType).signatureMessageTuple(objectDigest),
  });
}

function indexSignableDescriptorsV1<K extends string>(
  keyOf: (descriptor: SignableSystemRecordDescriptorV1) => K,
): ReadonlyMap<K, SignableSystemRecordDescriptorV1> {
  const index = new Map<K, SignableSystemRecordDescriptorV1>();
  for (const descriptor of Object.values(SIGNABLE_SYSTEM_RECORD_DESCRIPTORS_V1)) {
    const key = keyOf(descriptor);
    if (index.has(key)) {
      fail('system-record-schema', `duplicate signable descriptor key ${key}`);
    }
    index.set(key, descriptor);
  }
  return index;
}

function defineRolePolicy(
  role: SystemRecordSignatureRoleV1,
  signatureMessageTuple: (objectDigest: Digest32V1) => CanonicalJsonValue,
  issuer?: string,
): SignableSystemRecordRolePolicyV1 {
  return Object.freeze({ role, issuer, signatureMessageTuple });
}

function rolePolicy(
  policies: readonly SignableSystemRecordRolePolicyV1[],
  role: SystemRecordSignatureRoleV1,
  objectType: string,
): SignableSystemRecordRolePolicyV1 {
  return policies.find((candidate) => candidate.role === role)
    ?? invalidRole(role, objectType);
}

function recordKey(
  object: SignableSystemRecordObjectV1,
): CanonicalJsonValue {
  return [object.networkId, object.peerId];
}

function invalidRole(role: string, objectType: string): never {
  fail('system-record-signature', `${role} is not valid for ${objectType}`);
}
