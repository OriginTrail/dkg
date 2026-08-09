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

interface SignableSystemRecordDescriptorV1<T extends SignableSystemRecordObjectV1> {
  readonly kind: SignableSystemRecordKindV1;
  readonly objectType: T['objectType'];
  readonly objectKind: SystemRecordObjectKindV1;
  readonly maxJsonDepth: number;
  readonly validate: (value: unknown) => T;
  readonly digest: (object: T) => Digest32V1;
  readonly requiredRoles: (object: T) => readonly SystemRecordSignatureRoleV1[];
  readonly issuerForRole: (
    object: T,
    role: Exclude<SystemRecordSignatureRoleV1, 'peer'>,
  ) => string;
  readonly signatureMessageTuple: (
    object: T,
    objectDigest: Digest32V1,
    role: SystemRecordSignatureRoleV1,
  ) => CanonicalJsonValue;
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

const HEAD_ROLES = Object.freeze(['peer', 'current-evm'] as const);
const TRANSITION_CO_SIGNED_ROLES = Object.freeze(['peer', 'prior-evm', 'next-evm'] as const);
const TRANSITION_EXPIRED_ROLES = Object.freeze(['peer', 'next-evm'] as const);

const SIGNABLE_SYSTEM_RECORD_DESCRIPTORS_V1 = Object.freeze({
  'agent-profile-head': defineDescriptor<AgentProfileHeadObjectV1>({
    kind: 'head',
    objectType: 'agent-profile-head',
    objectKind: 'agent-profile-head',
    maxJsonDepth: SYSTEM_RECORD_MAX_SIGNED_HEAD_JSON_DEPTH,
    validate: validateAgentProfileHeadObjectV1,
    digest: computeAgentProfileHeadObjectDigestV1,
    requiredRoles: () => HEAD_ROLES,
    issuerForRole: (object, role) => {
      if (role === 'current-evm') return object.evmIssuer;
      return invalidRole(role, object.objectType);
    },
    signatureMessageTuple: (object, objectDigest, role) => {
      if (role !== 'peer' && role !== 'current-evm') return invalidRole(role, object.objectType);
      return [
        object.objectType, objectDigest, object.networkId, recordKey(object),
        object.authoritySequence, object.version,
        ...(role === 'peer' ? [] : ['current-evm', object.evmIssuer]),
      ];
    },
  }),
  'authority-transition': defineDescriptor<AgentProfileAuthorityTransitionV1>({
    kind: 'transition',
    objectType: 'authority-transition',
    objectKind: 'authority-transition',
    maxJsonDepth: SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
    validate: validateAuthorityTransition,
    digest: computeAgentProfileAuthorityTransitionDigestV1,
    requiredRoles: (object) => object.mode === 'co-signed'
      ? TRANSITION_CO_SIGNED_ROLES
      : TRANSITION_EXPIRED_ROLES,
    issuerForRole: (object, role) => {
      if (role === 'prior-evm') return object.priorEvmIssuer;
      if (role === 'next-evm') return object.nextEvmIssuer;
      return invalidRole(role, object.objectType);
    },
    signatureMessageTuple: (object, objectDigest, role) => {
      if (role !== 'peer' && role !== 'prior-evm' && role !== 'next-evm') {
        return invalidRole(role, object.objectType);
      }
      return [
        object.objectType, objectDigest, object.networkId, recordKey(object),
        object.priorAuthoritySequence, object.nextAuthoritySequence,
        object.priorHeadDigest, role,
        ...(role === 'peer' ? [] : [
          role === 'prior-evm' ? object.priorEvmIssuer : object.nextEvmIssuer,
        ]),
      ];
    },
  }),
  'fork-resolution': defineDescriptor<AgentProfileForkResolutionV1>({
    kind: 'fork',
    objectType: 'fork-resolution',
    objectKind: 'fork-resolution',
    maxJsonDepth: SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
    validate: validateForkResolution,
    digest: computeAgentProfileForkResolutionDigestV1,
    requiredRoles: () => HEAD_ROLES,
    issuerForRole: (object, role) => {
      if (role === 'current-evm') return object.evmIssuer;
      return invalidRole(role, object.objectType);
    },
    signatureMessageTuple: (object, objectDigest, role) => {
      if (role !== 'peer' && role !== 'current-evm') return invalidRole(role, object.objectType);
      return [
        object.objectType, objectDigest, object.networkId, recordKey(object),
        object.authoritySequence, object.forkedVersion, object.resolutionVersion, role,
        ...(role === 'peer' ? [] : [object.evmIssuer]),
      ];
    },
  }),
});

export function bindSignableSystemRecordPolicyV1(
  value: unknown,
): BoundSignableSystemRecordPolicyV1 {
  const record = snapshotSystemRecordDataRecord(value, 'signed envelope object');
  if (record.objectType === 'agent-profile-head') {
    return bindDescriptor(SIGNABLE_SYSTEM_RECORD_DESCRIPTORS_V1['agent-profile-head'], record);
  }
  if (record.objectType === 'authority-transition') {
    return bindDescriptor(SIGNABLE_SYSTEM_RECORD_DESCRIPTORS_V1['authority-transition'], record);
  }
  if (record.objectType === 'fork-resolution') {
    return bindDescriptor(SIGNABLE_SYSTEM_RECORD_DESCRIPTORS_V1['fork-resolution'], record);
  }
  return fail('system-record-schema', 'signed envelope object type is unsupported');
}

export function signableSystemRecordStaticPolicyV1(
  kind: SignableSystemRecordKindV1,
): SignableSystemRecordStaticPolicyV1 {
  const descriptor = kind === 'head'
    ? SIGNABLE_SYSTEM_RECORD_DESCRIPTORS_V1['agent-profile-head']
    : kind === 'transition'
      ? SIGNABLE_SYSTEM_RECORD_DESCRIPTORS_V1['authority-transition']
      : SIGNABLE_SYSTEM_RECORD_DESCRIPTORS_V1['fork-resolution'];
  return Object.freeze({
    kind: descriptor.kind,
    objectKind: descriptor.objectKind,
    maxJsonDepth: descriptor.maxJsonDepth,
  });
}

function defineDescriptor<T extends SignableSystemRecordObjectV1>(
  descriptor: SignableSystemRecordDescriptorV1<T>,
): SignableSystemRecordDescriptorV1<T> {
  return Object.freeze(descriptor);
}

function bindDescriptor<T extends SignableSystemRecordObjectV1>(
  descriptor: SignableSystemRecordDescriptorV1<T>,
  value: unknown,
): BoundSignableSystemRecordPolicyV1 {
  const object = descriptor.validate(value);
  return Object.freeze({
    kind: descriptor.kind,
    objectKind: descriptor.objectKind,
    maxJsonDepth: descriptor.maxJsonDepth,
    object,
    objectDigest: descriptor.digest(object),
    requiredRoles: Object.freeze([...descriptor.requiredRoles(object)]),
    issuerForRole: (role: Exclude<SystemRecordSignatureRoleV1, 'peer'>) =>
      descriptor.issuerForRole(object, role),
    signatureMessageTuple: (
      objectDigest: Digest32V1,
      role: SystemRecordSignatureRoleV1,
    ) =>
      descriptor.signatureMessageTuple(object, objectDigest, role),
  });
}

function recordKey(
  object: SignableSystemRecordObjectV1,
): CanonicalJsonValue {
  return [object.networkId, object.peerId];
}

function invalidRole(role: string, objectType: string): never {
  fail('system-record-signature', `${role} is not valid for ${objectType}`);
}
