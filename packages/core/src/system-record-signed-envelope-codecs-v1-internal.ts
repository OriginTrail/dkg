import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import { snapshotDataArray, snapshotExactDataRecord } from './sync-wire-objects.js';
import { type Digest32V1 } from './sync-wire-scalars.js';
import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  validateAuthorityTransition,
  validateForkResolution,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileForkResolutionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordEnvelopeV1,
  type SystemRecordSignatureRoleV1,
} from './system-record-agent-profile-control-codecs-v1-internal.js';
import {
  computeAgentProfileHeadObjectDigestV1,
  validateAgentProfileHeadObjectV1,
  type AgentProfileHeadObjectV1,
} from './system-record-agent-profile-head-codec-v1-internal.js';
import {
  digest,
  snapshotSystemRecordDataRecord,
} from './system-record-agent-profile-primitives-v1-internal.js';
import {
  digestSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
  SYSTEM_RECORD_MAX_SIGNED_HEAD_JSON_DEPTH,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
} from './system-record-limits-v1.js';
import { validateSystemRecordSignatureEntryV1 } from './system-record-signature-policy-v1-internal.js';

export function assertSignedAgentProfileHeadEnvelopeV1(
  value: unknown,
): asserts value is SignedAgentProfileHeadEnvelopeV1 {
  validateSignedEnvelope(value, 'head');
}

export function assertSignedAgentProfileAuthorityTransitionEnvelopeV1(
  value: unknown,
): asserts value is SignedAgentProfileAuthorityTransitionEnvelopeV1 {
  validateSignedEnvelope(value, 'transition');
}

export function assertSignedAgentProfileForkResolutionEnvelopeV1(
  value: unknown,
): asserts value is SignedAgentProfileForkResolutionEnvelopeV1 {
  validateSignedEnvelope(value, 'fork');
}

export function canonicalizeSignedSystemRecordEnvelopeV1<T>(
  value: SignedSystemRecordEnvelopeV1<T>,
): Uint8Array {
  const { kind, validated } = validateDispatchedSignedEnvelopeV1(value);
  return canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1[objectKindForEnvelope(kind)],
  });
}

export function computeSignedSystemRecordEnvelopeDigestV1<T>(
  value: SignedSystemRecordEnvelopeV1<T>,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.signedEnvelope,
    canonicalizeSignedSystemRecordEnvelopeV1(value),
  );
}

export function parseCanonicalSignedAgentProfileHeadEnvelopeV1(
  input: string | Uint8Array,
): SignedAgentProfileHeadEnvelopeV1 {
  return validateSignedEnvelope(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['agent-profile-head'],
      maxDepth: SYSTEM_RECORD_MAX_SIGNED_HEAD_JSON_DEPTH,
    }),
    'head',
  ) as SignedAgentProfileHeadEnvelopeV1;
}

export function parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(
  input: string | Uint8Array,
): SignedAgentProfileAuthorityTransitionEnvelopeV1 {
  return validateSignedEnvelope(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['authority-transition'],
      maxDepth: SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
    }),
    'transition',
  ) as SignedAgentProfileAuthorityTransitionEnvelopeV1;
}

export function parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(
  input: string | Uint8Array,
): SignedAgentProfileForkResolutionEnvelopeV1 {
  return validateSignedEnvelope(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['fork-resolution'],
      maxDepth: SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
    }),
    'fork',
  ) as SignedAgentProfileForkResolutionEnvelopeV1;
}

function validateSignedEnvelope(
  value: unknown,
  kind: 'head' | 'transition' | 'fork',
): SignedSystemRecordEnvelopeV1<unknown> {
  const envelope = snapshotExactDataRecord(
    value,
    ['object', 'objectDigest', 'signatures'],
    'signed system-record envelope',
  );
  const object = kind === 'head'
    ? validateAgentProfileHeadObjectV1(envelope.object)
    : kind === 'transition'
      ? validateAuthorityTransition(envelope.object)
      : validateForkResolution(envelope.object);
  const expectedDigest = kind === 'head'
    ? computeAgentProfileHeadObjectDigestV1(object as AgentProfileHeadObjectV1)
    : kind === 'transition'
      ? computeAgentProfileAuthorityTransitionDigestV1(
          object as AgentProfileAuthorityTransitionV1,
        )
      : computeAgentProfileForkResolutionDigestV1(object as AgentProfileForkResolutionV1);
  digest(envelope.objectDigest, 'objectDigest');
  if (envelope.objectDigest !== expectedDigest) {
    fail('system-record-binding', 'signed envelope objectDigest does not match the object');
  }
  const requiredRoles: readonly SystemRecordSignatureRoleV1[] = kind === 'transition'
    ? (object as AgentProfileAuthorityTransitionV1).mode === 'co-signed'
      ? ['peer', 'prior-evm', 'next-evm']
      : ['peer', 'next-evm']
    : ['peer', 'current-evm'];
  let signatureEntries: readonly unknown[];
  try {
    signatureEntries = snapshotDataArray(envelope.signatures, 'signed envelope signatures', {
      minLength: requiredRoles.length,
      maxLength: requiredRoles.length,
    });
  } catch (cause) {
    fail(
      'system-record-signature',
      'signed envelope has the wrong closed signature cardinality',
      cause,
    );
  }
  const signatures = signatureEntries.map((entry, index) =>
    validateSystemRecordSignatureEntryV1(entry, requiredRoles[index], object),
  );
  return Object.freeze({
    object,
    objectDigest: envelope.objectDigest,
    signatures: Object.freeze(signatures),
  });
}

function classifyEnvelopeObject(value: unknown): 'head' | 'transition' | 'fork' {
  const record = snapshotSystemRecordDataRecord(value, 'signed envelope object');
  if (record.objectType === 'agent-profile-head') return 'head';
  if (record.objectType === 'authority-transition') return 'transition';
  if (record.objectType === 'fork-resolution') return 'fork';
  fail('system-record-schema', 'signed envelope object type is unsupported');
}

export function validateDispatchedSignedEnvelopeV1(value: unknown): {
  readonly kind: 'head' | 'transition' | 'fork';
  readonly validated: SignedSystemRecordEnvelopeV1<unknown>;
} {
  const envelope = snapshotExactDataRecord(
    value,
    ['object', 'objectDigest', 'signatures'],
    'signed system-record envelope',
  );
  const kind = classifyEnvelopeObject(envelope.object);
  return Object.freeze({ kind, validated: validateSignedEnvelope(envelope, kind) });
}

function objectKindForEnvelope(
  value: 'head' | 'transition' | 'fork',
): 'agent-profile-head' | 'authority-transition' | 'fork-resolution' {
  return value === 'head'
    ? 'agent-profile-head'
    : value === 'transition'
      ? 'authority-transition'
      : 'fork-resolution';
}
