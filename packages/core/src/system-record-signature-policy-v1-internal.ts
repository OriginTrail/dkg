import { secp256k1 } from '@noble/curves/secp256k1.js';

import {
  canonicalizeJsonBytes,
  type CanonicalJsonValue,
} from './canonical-json.js';
import { type NetworkIdV1 } from './sync-wire-identifiers.js';
import { snapshotExactDataRecord } from './sync-wire-objects.js';
import {
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalHexBytes,
  type Digest32V1,
} from './sync-wire-scalars.js';
import {
  type SystemRecordEip1271EvidenceV1,
  type SystemRecordNoSignatureEvidenceV1,
  type SystemRecordSignatureEntryV1,
  type SystemRecordSignatureRoleV1,
} from './system-record-agent-profile-control-codecs-v1-internal.js';
import {
  digest,
  numericChainIdForNetworkV1,
} from './system-record-agent-profile-primitives-v1-internal.js';
import {
  concatSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  failSystemRecordObjectV1 as fail,
  systemRecordHexToBytesV1,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
  SYSTEM_RECORD_EIP191_MAX_S,
  SYSTEM_RECORD_EIP191_SIGNATURE_BYTES,
  SYSTEM_RECORD_MAX_EIP1271_SIGNATURE_BYTES,
  SYSTEM_RECORD_SIGNATURE_DOMAINS_V1,
} from './system-record-limits-v1.js';
import {
  bindSignableSystemRecordPolicyV1,
  type BoundSignableSystemRecordPolicyV1,
  type SignableSystemRecordObjectV1,
} from './system-record-signable-object-policy-v1-internal.js';

const UTF8 = new TextEncoder();

const SIGNATURE_ROLE_ORDER: Readonly<Record<SystemRecordSignatureRoleV1, number>> = {
  peer: 0,
  'prior-evm': 1,
  'next-evm': 2,
  'current-evm': 3,
};

export function validateSystemRecordSignatureEntryV1(
  value: unknown,
  requiredRole: SystemRecordSignatureRoleV1,
  policy: BoundSignableSystemRecordPolicyV1,
): SystemRecordSignatureEntryV1 {
  const entry = snapshotExactDataRecord(
    value,
    ['role', 'suite', 'signer', 'evidence', 'signature'],
    `signature entry ${requiredRole}`,
  );
  if (entry.role !== requiredRole || SIGNATURE_ROLE_ORDER[requiredRole] === undefined) {
    fail('system-record-signature', 'signature roles are missing, extra, duplicated, or reordered');
  }
  const isPeer = requiredRole === 'peer';
  let evidence: SystemRecordSignatureEntryV1['evidence'];
  if (isPeer) {
    if (entry.suite !== 'ed25519-v1' || entry.signer !== policy.object.peerId) {
      fail('system-record-signature', 'peer signature suite/signer is invalid');
    }
    evidence = exactNoneEvidence(entry.evidence);
    decodeUnpaddedBase64UrlV1(
      entry.signature,
      SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
      'Ed25519 signature',
    );
  } else {
    const issuer = policy.issuerForRole(requiredRole);
    if (entry.signer !== issuer) {
      fail('system-record-signature', `${requiredRole} signer does not match the object authority`);
    }
    if (entry.suite === 'eip191-personal-sign-digest-v1') {
      evidence = exactNoneEvidence(entry.evidence);
      assertCanonicalEip191SignatureV1(entry.signature);
    } else if (entry.suite === 'eip1271-current-finalized-v1') {
      evidence = validateEip1271Evidence(entry.evidence, issuer, policy.object.networkId);
      try {
        assertCanonicalHexBytes(
          entry.signature,
          'EIP-1271 signature',
          1,
          SYSTEM_RECORD_MAX_EIP1271_SIGNATURE_BYTES,
        );
      } catch (cause) {
        fail('system-record-signature', 'EIP-1271 signature bytes are invalid', cause);
      }
    } else {
      fail('system-record-signature', 'EVM signature suite is invalid');
    }
  }
  return Object.freeze({ ...entry, evidence }) as unknown as SystemRecordSignatureEntryV1;
}

export function assertCanonicalEip191SignatureV1(value: unknown): asserts value is string {
  try {
    assertCanonicalHexBytes(
      value,
      'EIP-191 signature',
      SYSTEM_RECORD_EIP191_SIGNATURE_BYTES,
      SYSTEM_RECORD_EIP191_SIGNATURE_BYTES,
    );
  } catch (cause) {
    fail('system-record-signature', 'EIP-191 signature bytes are invalid', cause);
  }
  const bytes = systemRecordHexToBytesV1(value as string);
  const s = bytesToBigInt(bytes.subarray(32, 64));
  if (s === 0n || s > SYSTEM_RECORD_EIP191_MAX_S) {
    fail('system-record-signature', 'EIP-191 signature must use canonical low-s form');
  }
  try {
    secp256k1.Signature.fromBytes(bytes.subarray(0, 64), 'compact');
  } catch (cause) {
    fail('system-record-signature', 'EIP-191 compact signature is not canonical', cause);
  }
  if (bytes[64] !== 27 && bytes[64] !== 28) {
    fail('system-record-signature', 'EIP-191 recovery byte must be 27 or 28');
  }
}

export function buildSystemRecordSignatureMessageV1(
  object: SignableSystemRecordObjectV1,
  objectDigest: Digest32V1,
  role: SystemRecordSignatureRoleV1,
): Uint8Array {
  return buildSystemRecordSignatureMessageFromPolicyV1(
    bindSignableSystemRecordPolicyV1(object),
    objectDigest,
    role,
  );
}

export function buildSystemRecordSignatureMessageFromPolicyV1(
  policy: BoundSignableSystemRecordPolicyV1,
  objectDigest: Digest32V1,
  role: SystemRecordSignatureRoleV1,
): Uint8Array {
  digest(objectDigest, 'objectDigest');
  const tuple: CanonicalJsonValue = policy.signatureMessageTuple(objectDigest, role);
  const domain = role === 'peer'
    ? SYSTEM_RECORD_SIGNATURE_DOMAINS_V1.peer
    : SYSTEM_RECORD_SIGNATURE_DOMAINS_V1.evm;
  return concatSystemRecordBytesV1(UTF8.encode(domain), canonicalizeJsonBytes(tuple));
}

function validateEip1271Evidence(
  value: unknown,
  issuer: string,
  networkId: NetworkIdV1,
): SystemRecordEip1271EvidenceV1 {
  const evidence = snapshotExactDataRecord(
    value,
    ['kind', 'chainId', 'contractAddress', 'finalizedBlockNumber', 'finalizedBlockHash'],
    'EIP-1271 evidence',
  );
  if (evidence.kind !== 'eip1271-current-finalized') {
    fail('system-record-signature', 'EIP-1271 evidence kind is invalid');
  }
  try {
    assertCanonicalChainId(evidence.chainId);
    assertCanonicalEvmAddress(evidence.contractAddress);
    assertCanonicalDecimalU64(evidence.finalizedBlockNumber);
    assertCanonicalDigest(evidence.finalizedBlockHash);
  } catch (cause) {
    fail('system-record-signature', 'EIP-1271 finalized evidence is invalid', cause);
  }
  if (evidence.contractAddress !== issuer) {
    fail('system-record-binding', 'EIP-1271 contract does not match signer');
  }
  if (evidence.chainId !== numericChainIdForNetworkV1(networkId)) {
    fail('system-record-binding', 'EIP-1271 evidence chainId does not match the record network');
  }
  return Object.freeze({ ...evidence }) as unknown as SystemRecordEip1271EvidenceV1;
}

function exactNoneEvidence(value: unknown): SystemRecordNoSignatureEvidenceV1 {
  const evidence = snapshotExactDataRecord(value, ['kind'], 'signature evidence');
  if (evidence.kind !== 'none') fail('system-record-signature', 'signature evidence must be none');
  return Object.freeze({ kind: 'none' });
}

function bytesToBigInt(value: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(value).toString('hex')}`);
}
