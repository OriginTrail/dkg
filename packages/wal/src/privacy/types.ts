import type { PrivateDisclosureRequest } from '../authority/types.js';
import type { ProtocolTuple } from '../protocol/schema.js';

export interface WalPayloadCoordinates {
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  writerEpoch: bigint;
  sequence: bigint;
}

export interface DkgPayloadMetadata {
  payloadKind: bigint;
  codec: bigint;
  mediaType: string;
}

export interface PrivatePayloadNonceClaim extends WalPayloadCoordinates {
  keyEpoch: bigint;
  nonce: Uint8Array;
  claimedAtMs?: number;
}

export interface PrivatePayloadNonceRegistry {
  claimPrivatePayloadNonce(input: PrivatePayloadNonceClaim): void;
}

export interface EncryptPrivateDkgPayloadInput extends WalPayloadCoordinates, DkgPayloadMetadata {
  epochKey: Uint8Array;
  keyEpoch: bigint;
  plaintext: Uint8Array;
  nonceRegistry: PrivatePayloadNonceRegistry;
  /** Fixed nonce seam for conformance tests; production omits it. */
  nonce?: Uint8Array;
}

export interface DecryptPrivateDkgPayloadInput extends WalPayloadCoordinates {
  epochKey: Uint8Array;
  envelopeBytes: Uint8Array;
  expectedKeyEpoch: bigint;
  expectedPayloadKind: bigint;
  expectedCodec: bigint;
  expectedMediaType: string;
  /** Adapter semantic validation (for example the expected policy object). */
  validatePlaintext?: (plaintext: Uint8Array) => boolean;
}

export interface EncodePublicDkgPayloadInput extends DkgPayloadMetadata {
  contentBytes: Uint8Array;
}

export interface EncodedDkgPayloadEnvelope {
  tuple: ProtocolTuple<'DkgPayloadEnvelopeV1'>;
  canonicalBytes: Uint8Array;
}

export type PrivateDisclosureResult<Value> =
  | { status: 'denied' }
  | { status: 'allowed'; value: Value };

export interface PrivatePayloadAuthorityGate {
  authorizePrivateDisclosure(request: PrivateDisclosureRequest, evaluatedAtMs?: number): Promise<boolean>;
}
