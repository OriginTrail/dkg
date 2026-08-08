import { canonicalizeJson, canonicalizeJsonBytes, parseCanonicalJson } from './canonical-json.js';
import { workspaceAgentEncryptionKeyId } from './crypto/workspace-encryption.js';
import { classifyAgentProfileOwnedSubjectV1 } from './agent-profile-schema-model-v1.js';
import {
  agentRootAddressV1,
  assertAgentRootV1,
  compareSystemRecordBytesV1,
  copyBoundedSystemRecordBytesV1,
  digestSystemRecordBytesV1,
  digestSystemRecordJsonV1,
} from './system-record-agent-profile-primitives-v1-internal.js';
import { failSystemRecordObjectV1 as fail } from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_ARRAY_JSON_DEPTH,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
} from './system-record-limits-v1.js';
import { snapshotDataArray } from './sync-wire-objects.js';
import type { Digest32V1 } from './sync-wire-scalars.js';

const UTF8 = new TextEncoder();

export type OwnedSubjectTableObjectV1 = readonly string[];

export {
  AGENT_PROFILE_LINK_PREDICATES_V1,
  AGENT_PROFILE_SCHEMA_TERMS_V1,
  classifyAgentProfileOwnedSubjectV1,
  deriveAgentProfileOwnedSubjectV1,
  isAllowedAgentProfilePredicateV1,
} from './agent-profile-schema-model-v1.js';
export type {
  AgentProfileExactLinkedSubjectKindV1,
  AgentProfileIndexedSubjectKindV1,
  AgentProfileLinkedSubjectKindV1,
  AgentProfileOwnedSubjectKindV1,
} from './agent-profile-schema-model-v1.js';

export const EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1 = digestSystemRecordJsonV1(
  SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable,
  [],
  SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
);

export function assertDerivedAgentEncryptionSubjectV1(
  rootSubject: string,
  subject: string,
  publicKeyBytes: Uint8Array,
): void {
  assertAgentRootV1(rootSubject);
  let ownedPublicKey: Uint8Array;
  try {
    ownedPublicKey = copyBoundedSystemRecordBytesV1(publicKeyBytes, 32, 'x25519 public key');
  } catch (cause) {
    fail('system-record-binding', 'x25519 public key must contain exactly 32 bytes', cause);
  }
  if (ownedPublicKey.byteLength !== 32) {
    fail('system-record-binding', 'x25519 public key must contain exactly 32 bytes');
  }
  const address = agentRootAddressV1(rootSubject);
  if (address === undefined) fail('system-record-binding', 'agent root address is invalid');
  const expected = workspaceAgentEncryptionKeyId(address, ownedPublicKey);
  if (subject !== expected) {
    fail(
      'system-record-binding',
      'x25519 owned subject is not derived from its root and public key',
    );
  }
}

export function assertOwnedSubjectTableObjectV1(
  rootSubject: string,
  value: unknown,
): asserts value is OwnedSubjectTableObjectV1 {
  validateOwnedSubjectTableObjectV1(rootSubject, value);
}

function validateOwnedSubjectTableObjectV1(
  rootSubject: string,
  value: unknown,
): OwnedSubjectTableObjectV1 {
  assertAgentRootV1(rootSubject);
  let subjects: readonly unknown[];
  try {
    subjects = snapshotDataArray(value, 'owned-subject table', {
      maxLength: SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
    });
  } catch (cause) {
    fail('system-record-limit', 'owned-subject table exceeds its closed-array bound', cause);
  }
  let previous: Uint8Array | undefined;
  let encodedLowerBound = 2;
  for (const candidate of subjects) {
    if (
      typeof candidate !== 'string' ||
      candidate.length > SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'] ||
      classifyAgentProfileOwnedSubjectV1(rootSubject, candidate) === null
    ) {
      fail('system-record-binding', 'owned-subject table contains an invalid subject');
    }
    const bytes = UTF8.encode(candidate);
    encodedLowerBound += bytes.byteLength + (previous === undefined ? 2 : 3);
    if (encodedLowerBound > SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table']) {
      fail('system-record-limit', 'owned-subject table exceeds its encoded byte cap');
    }
    if (previous !== undefined && compareSystemRecordBytesV1(previous, bytes) >= 0) {
      fail('system-record-order', 'owned-subject table must be UTF-8 sorted and duplicate-free');
    }
    previous = bytes;
  }
  canonicalizeJson(subjects as readonly string[], {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
  });
  return subjects as OwnedSubjectTableObjectV1;
}

export function canonicalizeOwnedSubjectTableObjectV1(
  rootSubject: string,
  value: OwnedSubjectTableObjectV1,
): Uint8Array {
  return canonicalizeJsonBytes(validateOwnedSubjectTableObjectV1(rootSubject, value), {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
  });
}

export function parseCanonicalOwnedSubjectTableObjectV1(
  rootSubject: string,
  input: string | Uint8Array,
): OwnedSubjectTableObjectV1 {
  const parsed = parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
    maxDepth: SYSTEM_RECORD_MAX_ARRAY_JSON_DEPTH,
  });
  return validateOwnedSubjectTableObjectV1(rootSubject, parsed);
}

export function computeOwnedSubjectTableDigestV1(
  rootSubject: string,
  value: OwnedSubjectTableObjectV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable,
    canonicalizeOwnedSubjectTableObjectV1(rootSubject, value),
  );
}
