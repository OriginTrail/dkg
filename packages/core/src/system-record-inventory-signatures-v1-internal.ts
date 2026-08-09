import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { verifyAsync as verifyEd25519 } from '@noble/ed25519';

import {
  canonicalizeJsonBytes,
  type CanonicalJsonValue,
} from './canonical-json.js';
import {
  concatSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  type SystemRecordPeerPublicKeyV1,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
  SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
  SYSTEM_RECORD_SIGNATURE_DOMAINS_V1,
} from './system-record-limits-v1.js';
import {
  validateRootDescriptor,
  validateSignedRootDescriptor,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordRootDescriptorObjectV1,
} from './system-record-inventory-codecs-v1-internal.js';
import { type Digest32V1, assertCanonicalDigest } from './sync-wire-scalars.js';

const UTF8 = new TextEncoder();

export function buildSystemRecordProviderSignatureMessageV1(
  descriptor: SystemRecordRootDescriptorObjectV1,
  descriptorObjectDigest: Digest32V1,
  providerPeerId: string,
): Uint8Array {
  const validatedDescriptor = validateRootDescriptor(descriptor);
  assertCanonicalDigest(descriptorObjectDigest);
  const tuple: CanonicalJsonValue = [
    validatedDescriptor.kind,
    validatedDescriptor.networkId,
    providerPeerId,
    descriptorObjectDigest,
  ];
  return concatSystemRecordBytesV1(
    UTF8.encode(SYSTEM_RECORD_SIGNATURE_DOMAINS_V1.provider),
    canonicalizeJsonBytes(tuple),
  );
}

export async function verifySignedSystemRecordRootDescriptorEnvelopeV1(
  envelope: SignedSystemRecordRootDescriptorEnvelopeV1,
  providerPeerPublicKey: SystemRecordPeerPublicKeyV1,
): Promise<boolean> {
  const validated = validateSignedRootDescriptor(envelope);
  const keyBytes = decodeUnpaddedBase64UrlV1(
    providerPeerPublicKey,
    SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
    'providerPeerPublicKey',
  );
  if (peerIdFromPublicKey(publicKeyFromRaw(keyBytes)).toString() !== validated.providerPeerId) {
    return false;
  }
  const signature = decodeUnpaddedBase64UrlV1(
    validated.signature,
    SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
    'provider signature',
  );
  return verifyEd25519(
    signature,
    buildSystemRecordProviderSignatureMessageV1(
      validated.object,
      validated.objectDigest,
      validated.providerPeerId,
    ),
    keyBytes,
  );
}
