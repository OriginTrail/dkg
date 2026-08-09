import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import { snapshotDataArray, snapshotExactDataRecord } from './sync-wire-objects.js';
import { type Digest32V1 } from './sync-wire-scalars.js';
import {
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileForkResolutionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordEnvelopeV1,
} from './system-record-agent-profile-control-codecs-v1-internal.js';
import { digest } from './system-record-agent-profile-primitives-v1-internal.js';
import {
  digestSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
} from './system-record-limits-v1.js';
import {
  bindSignableSystemRecordPolicyV1,
  signableSystemRecordStaticPolicyV1,
  type BoundSignableSystemRecordPolicyV1,
  type SignableSystemRecordKindV1,
  type SignableSystemRecordObjectV1,
} from './system-record-signable-object-policy-v1-internal.js';
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
  const { objectKind, validated } = validateDispatchedSignedEnvelopeV1(value);
  return canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1[objectKind],
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
  const policy = signableSystemRecordStaticPolicyV1('head');
  return validateSignedEnvelope(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1[policy.objectKind],
      maxDepth: policy.maxJsonDepth,
    }),
    'head',
  );
}

export function parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(
  input: string | Uint8Array,
): SignedAgentProfileAuthorityTransitionEnvelopeV1 {
  const policy = signableSystemRecordStaticPolicyV1('transition');
  return validateSignedEnvelope(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1[policy.objectKind],
      maxDepth: policy.maxJsonDepth,
    }),
    'transition',
  );
}

export function parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(
  input: string | Uint8Array,
): SignedAgentProfileForkResolutionEnvelopeV1 {
  const policy = signableSystemRecordStaticPolicyV1('fork');
  return validateSignedEnvelope(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1[policy.objectKind],
      maxDepth: policy.maxJsonDepth,
    }),
    'fork',
  );
}

function validateSignedEnvelope(
  value: unknown,
  kind: 'head',
): SignedAgentProfileHeadEnvelopeV1;
function validateSignedEnvelope(
  value: unknown,
  kind: 'transition',
): SignedAgentProfileAuthorityTransitionEnvelopeV1;
function validateSignedEnvelope(
  value: unknown,
  kind: 'fork',
): SignedAgentProfileForkResolutionEnvelopeV1;
function validateSignedEnvelope(
  value: unknown,
  expectedKind?: SignableSystemRecordKindV1,
): SignedSystemRecordEnvelopeV1<SignableSystemRecordObjectV1>;
function validateSignedEnvelope(
  value: unknown,
  expectedKind?: SignableSystemRecordKindV1,
): SignedSystemRecordEnvelopeV1<SignableSystemRecordObjectV1> {
  return validateSignedEnvelopeWithPolicy(value, expectedKind).validated;
}

function validateSignedEnvelopeWithPolicy(
  value: unknown,
  expectedKind?: SignableSystemRecordKindV1,
): Readonly<{
  validated: SignedSystemRecordEnvelopeV1<SignableSystemRecordObjectV1>;
  policy: BoundSignableSystemRecordPolicyV1;
}> {
  const envelope = snapshotExactDataRecord(
    value,
    ['object', 'objectDigest', 'signatures'],
    'signed system-record envelope',
  );
  const policy = bindSignableSystemRecordPolicyV1(envelope.object);
  if (expectedKind !== undefined && policy.kind !== expectedKind) {
    fail('system-record-schema', `signed envelope does not contain a ${expectedKind} object`);
  }
  digest(envelope.objectDigest, 'objectDigest');
  if (envelope.objectDigest !== policy.objectDigest) {
    fail('system-record-binding', 'signed envelope objectDigest does not match the object');
  }
  let signatureEntries: readonly unknown[];
  try {
    signatureEntries = snapshotDataArray(envelope.signatures, 'signed envelope signatures', {
      minLength: policy.requiredRoles.length,
      maxLength: policy.requiredRoles.length,
    });
  } catch (cause) {
    fail(
      'system-record-signature',
      'signed envelope has the wrong closed signature cardinality',
      cause,
    );
  }
  const signatures = signatureEntries.map((entry, index) =>
    validateSystemRecordSignatureEntryV1(entry, policy.requiredRoles[index], policy),
  );
  const validated = Object.freeze({
    object: policy.object,
    objectDigest: envelope.objectDigest,
    signatures: Object.freeze(signatures),
  });
  return Object.freeze({ validated, policy });
}

export function validateDispatchedSignedEnvelopeV1(value: unknown): {
  readonly kind: SignableSystemRecordKindV1;
  readonly objectKind: BoundSignableSystemRecordPolicyV1['objectKind'];
  readonly validated: SignedSystemRecordEnvelopeV1<SignableSystemRecordObjectV1>;
  readonly policy: BoundSignableSystemRecordPolicyV1;
} {
  const { validated, policy } = validateSignedEnvelopeWithPolicy(value);
  return Object.freeze({
    kind: policy.kind,
    objectKind: policy.objectKind,
    validated,
    policy,
  });
}
