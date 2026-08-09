import { secp256k1 } from '@noble/curves/secp256k1.js';
import { verifyAsync as verifyEd25519 } from '@noble/ed25519';

import { keccak256 } from './crypto/keccak.js';
import {
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type SignedSystemRecordEnvelopeV1,
  type SystemRecordSignatureEntryV1,
} from './system-record-agent-profile-control-codecs-v1-internal.js';
import { type AgentProfileHeadObjectV1 } from './system-record-agent-profile-head-codec-v1-internal.js';
import {
  concatSystemRecordBytesV1,
  copyBoundedSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  failSystemRecordObjectV1 as fail,
  systemRecordHexToBytesV1,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
  SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
} from './system-record-limits-v1.js';
import {
  validateDispatchedSignedEnvelopeV1,
} from './system-record-signed-envelope-codecs-v1-internal.js';
import {
  assertCanonicalEip191SignatureV1,
  buildSystemRecordSignatureMessageV1,
} from './system-record-signature-policy-v1-internal.js';

export {
  assertSignedAgentProfileAuthorityTransitionEnvelopeV1,
  assertSignedAgentProfileForkResolutionEnvelopeV1,
  assertSignedAgentProfileHeadEnvelopeV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeSignedSystemRecordEnvelopeDigestV1,
  parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
  parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
} from './system-record-signed-envelope-codecs-v1-internal.js';
export {
  assertCanonicalEip191SignatureV1,
  buildSystemRecordSignatureMessageV1,
} from './system-record-signature-policy-v1-internal.js';

const UTF8 = new TextEncoder();

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
  const { validated } = validateDispatchedSignedEnvelopeV1(envelope) as {
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
  return keccak256(concatSystemRecordBytesV1(prefix, ownedMessage));
}

export function recoverEip191SignerV1(
  signature: string,
  personalHash: Uint8Array,
): string {
  assertCanonicalEip191SignatureV1(signature);
  const ownedPersonalHash = copyBoundedSystemRecordBytesV1(
    personalHash,
    32,
    'EIP-191 personal message hash',
  );
  if (ownedPersonalHash.byteLength !== 32) {
    fail('system-record-signature', 'personal message hash must be 32 bytes');
  }
  try {
    const bytes = systemRecordHexToBytesV1(signature);
    const compact = secp256k1.Signature
      .fromBytes(bytes.subarray(0, 64), 'compact')
      .addRecoveryBit(bytes[64] - 27);
    const publicKey = compact.recoverPublicKey(ownedPersonalHash).toBytes(false);
    return `0x${Buffer.from(keccak256(publicKey.subarray(1)).subarray(12)).toString('hex')}`;
  } catch (cause) {
    fail('system-record-signature', 'EIP-191 signature recovery failed', cause);
  }
}
