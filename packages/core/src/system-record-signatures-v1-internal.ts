import { secp256k1 } from '@noble/curves/secp256k1.js';
import { verifyAsync as verifyEd25519 } from '@noble/ed25519';

import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import { keccak256 } from './crypto/keccak.js';
import { type NetworkIdV1 } from './sync-wire-identifiers.js';
import { snapshotDataArray, snapshotExactDataRecord } from './sync-wire-objects.js';
import {
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalHexBytes,
  type Digest32V1,
} from './sync-wire-scalars.js';
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
  type SystemRecordEip1271EvidenceV1,
  type SystemRecordNoSignatureEvidenceV1,
  type SystemRecordSignatureEntryV1,
  type SystemRecordSignatureRoleV1,
} from './system-record-agent-profile-control-codecs-v1-internal.js';
import {
  computeAgentProfileHeadObjectDigestV1,
  validateAgentProfileHeadObjectV1,
  type AgentProfileHeadObjectV1,
} from './system-record-agent-profile-head-codec-v1-internal.js';
import {
  digest,
  numericChainIdForNetworkV1,
  snapshotSystemRecordDataRecord,
} from './system-record-agent-profile-primitives-v1-internal.js';
import {
  copyBoundedSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  digestSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
  SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
  SYSTEM_RECORD_EIP191_MAX_S,
  SYSTEM_RECORD_EIP191_SIGNATURE_BYTES,
  SYSTEM_RECORD_MAX_EIP1271_SIGNATURE_BYTES,
  SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
  SYSTEM_RECORD_MAX_SIGNED_HEAD_JSON_DEPTH,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  SYSTEM_RECORD_SIGNATURE_DOMAINS_V1,
} from './system-record-limits-v1.js';

const UTF8 = new TextEncoder();

const SIGNATURE_ROLE_ORDER: Readonly<Record<SystemRecordSignatureRoleV1, number>> = {
  peer: 0,
  'prior-evm': 1,
  'next-evm': 2,
  'current-evm': 3,
};

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
  const { kind, validated } = validateDispatchedSignedEnvelope(value);
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
  const object =
    kind === 'head'
      ? validateAgentProfileHeadObjectV1(envelope.object)
      : kind === 'transition'
        ? validateAuthorityTransition(envelope.object)
        : validateForkResolution(envelope.object);
  const expectedDigest =
    kind === 'head'
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
  const requiredRoles: readonly SystemRecordSignatureRoleV1[] =
    kind === 'transition'
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
    validateSignatureEntry(entry, requiredRoles[index], object),
  );
  return Object.freeze({
    object,
    objectDigest: envelope.objectDigest,
    signatures: Object.freeze(signatures),
  });
}

function validateSignatureEntry(
  value: unknown,
  requiredRole: SystemRecordSignatureRoleV1,
  object:
    | AgentProfileHeadObjectV1
    | AgentProfileAuthorityTransitionV1
    | AgentProfileForkResolutionV1,
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
    if (entry.suite !== 'ed25519-v1' || entry.signer !== object.peerId) {
      fail('system-record-signature', 'peer signature suite/signer is invalid');
    }
    evidence = exactNoneEvidence(entry.evidence);
    decodeUnpaddedBase64UrlV1(
      entry.signature,
      SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
      'Ed25519 signature',
    );
  } else {
    const issuer = issuerForRole(object, requiredRole);
    if (entry.signer !== issuer) {
      fail('system-record-signature', `${requiredRole} signer does not match the object authority`);
    }
    if (entry.suite === 'eip191-personal-sign-digest-v1') {
      evidence = exactNoneEvidence(entry.evidence);
      assertCanonicalEip191SignatureV1(entry.signature);
    } else if (entry.suite === 'eip1271-current-finalized-v1') {
      evidence = validateEip1271Evidence(entry.evidence, issuer, object.networkId);
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
  return Object.freeze({
    ...entry,
    evidence,
  }) as unknown as SystemRecordSignatureEntryV1;
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
  const bytes = hexToBytes(value as string);
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
  object:
    | AgentProfileHeadObjectV1
    | AgentProfileAuthorityTransitionV1
    | AgentProfileForkResolutionV1,
  objectDigest: Digest32V1,
  role: SystemRecordSignatureRoleV1,
): Uint8Array {
  digest(objectDigest, 'objectDigest');
  const kind = classifyEnvelopeObject(object);
  const validatedObject =
    kind === 'head'
      ? validateAgentProfileHeadObjectV1(object)
      : kind === 'transition'
        ? validateAuthorityTransition(object)
        : validateForkResolution(object);
  const recordKey: CanonicalJsonValue = [validatedObject.networkId, validatedObject.peerId];
  let tuple: CanonicalJsonValue;
  if (validatedObject.objectType === 'agent-profile-head') {
    if (role !== 'peer' && role !== 'current-evm')
      fail('system-record-signature', 'head role is invalid');
    tuple = [
      'agent-profile-head',
      objectDigest,
      validatedObject.networkId,
      recordKey,
      validatedObject.authoritySequence,
      validatedObject.version,
      ...(role === 'peer' ? [] : ['current-evm', validatedObject.evmIssuer]),
    ];
  } else if (validatedObject.objectType === 'authority-transition') {
    if (role !== 'peer' && role !== 'prior-evm' && role !== 'next-evm') {
      fail('system-record-signature', 'transition role is invalid');
    }
    tuple = [
      'authority-transition',
      objectDigest,
      validatedObject.networkId,
      recordKey,
      validatedObject.priorAuthoritySequence,
      validatedObject.nextAuthoritySequence,
      validatedObject.priorHeadDigest,
      role,
      ...(role === 'peer' ? [] : [issuerForRole(validatedObject, role)]),
    ];
  } else {
    if (role !== 'peer' && role !== 'current-evm')
      fail('system-record-signature', 'resolution role is invalid');
    tuple = [
      'fork-resolution',
      objectDigest,
      validatedObject.networkId,
      recordKey,
      validatedObject.authoritySequence,
      validatedObject.forkedVersion,
      validatedObject.resolutionVersion,
      role,
      ...(role === 'peer' ? [] : [validatedObject.evmIssuer]),
    ];
  }
  const domain =
    role === 'peer'
      ? SYSTEM_RECORD_SIGNATURE_DOMAINS_V1.peer
      : SYSTEM_RECORD_SIGNATURE_DOMAINS_V1.evm;
  return concatBytes(UTF8.encode(domain), canonicalizeJsonBytes(tuple));
}

export interface VerifySystemRecordEnvelopeOptionsV1 {
  readonly verifyEip1271?: (
    entry: SystemRecordSignatureEntryV1,
    personalMessageHash: Uint8Array,
  ) => boolean | Promise<boolean>;
}

/** Cryptographically verify a structurally valid envelope without opening a materializer capability. */
export async function verifySignedSystemRecordEnvelopeV1<
  T extends
    | AgentProfileHeadObjectV1
    | AgentProfileAuthorityTransitionV1
    | AgentProfileForkResolutionV1,
>(
  envelope: SignedSystemRecordEnvelopeV1<T>,
  options: VerifySystemRecordEnvelopeOptionsV1 = {},
): Promise<boolean> {
  const verifyEip1271 = options.verifyEip1271;
  if (verifyEip1271 !== undefined && typeof verifyEip1271 !== 'function') return false;
  const { validated } = validateDispatchedSignedEnvelope(envelope) as {
    readonly validated: SignedSystemRecordEnvelopeV1<T>;
  };
  const publicKey = decodeUnpaddedBase64UrlV1(
    validated.object.peerPublicKey,
    SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
    'peerPublicKey',
  );
  for (const entry of validated.signatures) {
    const message = buildSystemRecordSignatureMessageV1(
      validated.object,
      validated.objectDigest,
      entry.role,
    );
    if (entry.role === 'peer') {
      const signature = decodeUnpaddedBase64UrlV1(
        entry.signature,
        SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
        'Ed25519 signature',
      );
      if (!(await verifyEd25519(signature, message, publicKey))) return false;
      continue;
    }
    const personalHash = eip191PersonalMessageHashV1(message);
    if (entry.suite === 'eip191-personal-sign-digest-v1') {
      if (recoverEip191SignerV1(entry.signature, personalHash) !== entry.signer) return false;
    } else if (verifyEip1271 === undefined || (await verifyEip1271(entry, personalHash)) !== true) {
      return false;
    }
  }
  return true;
}

export function eip191PersonalMessageHashV1(message: Uint8Array): Uint8Array {
  const ownedMessage = copyBoundedSystemRecordBytesV1(
    message,
    SYSTEM_RECORD_OBJECT_CAPS_V1['agent-profile-head'],
    'EIP-191 personal message',
  );
  const prefix = UTF8.encode(`\x19Ethereum Signed Message:\n${ownedMessage.byteLength}`);
  return keccak256(concatBytes(prefix, ownedMessage));
}

export function recoverEip191SignerV1(signature: string, personalHash: Uint8Array): string {
  assertCanonicalEip191SignatureV1(signature);
  const ownedPersonalHash = copyBoundedSystemRecordBytesV1(
    personalHash,
    32,
    'EIP-191 personal message hash',
  );
  if (ownedPersonalHash.byteLength !== 32)
    fail('system-record-signature', 'personal message hash must be 32 bytes');
  try {
    const bytes = hexToBytes(signature);
    const compact = secp256k1.Signature.fromBytes(bytes.subarray(0, 64), 'compact').addRecoveryBit(
      bytes[64] - 27,
    );
    const publicKey = compact.recoverPublicKey(ownedPersonalHash).toBytes(false);
    return `0x${Buffer.from(keccak256(publicKey.subarray(1)).subarray(12)).toString('hex')}`;
  } catch (cause) {
    fail('system-record-signature', 'EIP-191 signature recovery failed', cause);
  }
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
  const expectedChainId = numericChainIdForNetworkV1(networkId);
  if (evidence.chainId !== expectedChainId) {
    fail('system-record-binding', 'EIP-1271 evidence chainId does not match the record network');
  }
  return Object.freeze({
    ...evidence,
  }) as unknown as SystemRecordEip1271EvidenceV1;
}

function exactNoneEvidence(value: unknown): SystemRecordNoSignatureEvidenceV1 {
  const evidence = snapshotExactDataRecord(value, ['kind'], 'signature evidence');
  if (evidence.kind !== 'none') fail('system-record-signature', 'signature evidence must be none');
  return Object.freeze({ kind: 'none' });
}

function issuerForRole(
  object:
    | AgentProfileHeadObjectV1
    | AgentProfileAuthorityTransitionV1
    | AgentProfileForkResolutionV1,
  role: Exclude<SystemRecordSignatureRoleV1, 'peer'>,
): string {
  if (object.objectType === 'authority-transition') {
    if (role === 'prior-evm') return object.priorEvmIssuer;
    if (role === 'next-evm') return object.nextEvmIssuer;
  } else if (role === 'current-evm') {
    return object.evmIssuer;
  }
  fail('system-record-signature', `${role} is not valid for ${object.objectType}`);
}

function classifyEnvelopeObject(value: unknown): 'head' | 'transition' | 'fork' {
  const record = snapshotSystemRecordDataRecord(value, 'signed envelope object');
  if (record.objectType === 'agent-profile-head') return 'head';
  if (record.objectType === 'authority-transition') return 'transition';
  if (record.objectType === 'fork-resolution') return 'fork';
  fail('system-record-schema', 'signed envelope object type is unsupported');
}

function validateDispatchedSignedEnvelope(value: unknown): {
  readonly kind: 'head' | 'transition' | 'fork';
  readonly validated: SignedSystemRecordEnvelopeV1<unknown>;
} {
  const envelope = snapshotExactDataRecord(
    value,
    ['object', 'objectDigest', 'signatures'],
    'signed system-record envelope',
  );
  const kind = classifyEnvelopeObject(envelope.object);
  return Object.freeze({
    kind,
    validated: validateSignedEnvelope(envelope, kind),
  });
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

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

function bytesToBigInt(value: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(value).toString('hex')}`);
}

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}
