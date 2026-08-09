import { type Digest32V1 } from './sync-wire-scalars.js';
import {
  digestSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  type SystemRecordObjectKindV1,
} from './system-record-limits-v1.js';
import {
  computeSignedSystemRecordEnvelopeDigestV1,
  parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
  parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
} from './system-record-signatures-v1-internal.js';
import {
  parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1,
} from './system-record-inventory-codecs-v1-internal.js';

export interface SystemRecordArtifactIdentitiesV1 {
  readonly semanticDigest: Digest32V1;
  readonly cacheDigest: Digest32V1;
}

interface SystemRecordObjectIdentityDescriptorV1 {
  readonly derive: (canonicalBytes: Uint8Array) => SystemRecordArtifactIdentitiesV1;
}

function byteIdentity(domain: string): SystemRecordObjectIdentityDescriptorV1 {
  return Object.freeze({
    derive: (canonicalBytes: Uint8Array) => {
      const digest = digestSystemRecordBytesV1(domain, canonicalBytes);
      return Object.freeze({ semanticDigest: digest, cacheDigest: digest });
    },
  });
}

function signedEnvelopeIdentity<TEnvelope extends Readonly<{ objectDigest: Digest32V1 }>>(
  parse: (canonicalBytes: Uint8Array) => TEnvelope,
  cacheDigest: (
    envelope: TEnvelope,
    canonicalBytes: Uint8Array,
  ) => Digest32V1,
): SystemRecordObjectIdentityDescriptorV1 {
  return Object.freeze({
    derive: (canonicalBytes: Uint8Array) => {
      const envelope = parse(canonicalBytes);
      return Object.freeze({
        semanticDigest: envelope.objectDigest,
        cacheDigest: cacheDigest(envelope, canonicalBytes),
      });
    },
  });
}

export const SYSTEM_RECORD_OBJECT_IDENTITY_DESCRIPTORS_V1 = Object.freeze({
  'root-descriptor': signedEnvelopeIdentity(
    parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1,
    (_envelope, canonicalBytes) => digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.signedRootDescriptorEnvelope,
      canonicalBytes,
    ),
  ),
  'inventory-internal': byteIdentity(SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryInternal),
  'inventory-leaf': byteIdentity(SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryLeaf),
  'agent-profile-head': signedEnvelopeIdentity(
    parseCanonicalSignedAgentProfileHeadEnvelopeV1,
    (envelope) => computeSignedSystemRecordEnvelopeDigestV1(envelope),
  ),
  'authority-transition': signedEnvelopeIdentity(
    parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
    (envelope) => computeSignedSystemRecordEnvelopeDigestV1(envelope),
  ),
  'fork-resolution': signedEnvelopeIdentity(
    parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1,
    (envelope) => computeSignedSystemRecordEnvelopeDigestV1(envelope),
  ),
  'conflict-evidence': byteIdentity(SYSTEM_RECORD_DIGEST_DOMAINS_V1.conflictEvidence),
  'owned-subject-table': byteIdentity(SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable),
  'profile-bundle': byteIdentity(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle),
} satisfies Readonly<
  Record<SystemRecordObjectKindV1, SystemRecordObjectIdentityDescriptorV1>
>);

export function deriveSystemRecordArtifactIdentitiesV1(
  objectKind: SystemRecordObjectKindV1,
  canonicalBytes: Uint8Array,
  label: string,
): SystemRecordArtifactIdentitiesV1 {
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_RECORD_OBJECT_IDENTITY_DESCRIPTORS_V1, objectKind)) {
    fail('system-record-closure', `${label} artifact identity is invalid`);
  }
  const identities = SYSTEM_RECORD_OBJECT_IDENTITY_DESCRIPTORS_V1[objectKind].derive(canonicalBytes);
  if (identities.semanticDigest.length !== 66 || identities.cacheDigest.length !== 66) {
    fail('system-record-closure', `${label} artifact identity is invalid`);
  }
  return identities;
}
