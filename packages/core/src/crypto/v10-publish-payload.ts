/**
 * OT-RFC-38 / LU-5 — encrypted V10 publish payload for curated CGs.
 *
 * The minimal-viable encryption layer cores wrap around inline
 * publish-intent bytes so storage-attestation can sign on ciphertext
 * the cores cannot decrypt. Keyed via the publisher's swm-sender-key
 * `chainKey` snapshot: all members of the curated CG who hold this
 * chainKey (delivered via the setup package + intermediate ratchet
 * steps) can recompute the same payload key and decrypt later.
 *
 * Scheme (intentionally simple — full key lifecycle / per-message
 * ratchet integration arrives with LU-6 substrate split + LU-8
 * member post-decrypt verification):
 *
 *   - Payload key  = HKDF-SHA256(chainKey, salt='', info=`dkg.v10-publish-payload-key.v1|${cgId}`)
 *   - Nonce        = 12 random bytes (per encryption call)
 *   - Cipher       = AES-256-GCM
 *   - Auth tag     = 16 bytes appended by GCM
 *   - Wire layout  = [4-byte LE magic 'V10P'] [12-byte nonce] [ciphertext || tag]
 *
 * The magic prefix lets future versions distinguish encrypted-payload
 * wire shapes without an explicit version field on the protobuf side.
 *
 * Limitation tracked for LU-8: a member who is behind the publisher's
 * chain-key ratchet won't yet hold the right `chainKey` snapshot.
 * They must catch up to the publisher's current SWM state (LU-7) to
 * derive the same key. For the §1.1 unblocker that's acceptable —
 * the curator and members are roughly in sync at publish time.
 *
 * Cores receiving the ciphertext do NOT attempt to decrypt. They sign
 * the V10 ACK digest verbatim against the publisher's claimed
 * merkleRoot/byteSize; the merkle-root verification happens at
 * member side post-decryption (LU-8).
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const V10_PUBLISH_PAYLOAD_MAGIC = new TextEncoder().encode('V10P');
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_INFO_PREFIX = 'dkg.v10-publish-payload-key.v1|';

function derivePayloadKey(chainKey: Uint8Array, contextGraphId: string): Uint8Array {
  if (chainKey.length !== KEY_BYTES) {
    throw new Error(
      `v10-publish-payload: chainKey must be ${KEY_BYTES} bytes (got ${chainKey.length})`,
    );
  }
  const info = new TextEncoder().encode(HKDF_INFO_PREFIX + contextGraphId);
  return new Uint8Array(
    hkdfSync('sha256', Buffer.from(chainKey), Buffer.alloc(0), info, KEY_BYTES) as ArrayBuffer,
  );
}

export interface EncryptV10PublishPayloadInput {
  chainKey: Uint8Array;
  contextGraphId: string;
  plaintext: Uint8Array;
  /** Test seam. Defaults to `crypto.randomBytes(12)`. */
  nonce?: Uint8Array;
}

export function encryptV10PublishPayload(input: EncryptV10PublishPayloadInput): Uint8Array {
  const key = derivePayloadKey(input.chainKey, input.contextGraphId);
  const nonce = input.nonce ?? new Uint8Array(randomBytes(NONCE_BYTES));
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`v10-publish-payload: nonce must be ${NONCE_BYTES} bytes (got ${nonce.length})`);
  }
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(input.plaintext)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Layout: [4 magic] [12 nonce] [ciphertext] [16 tag]
  const out = new Uint8Array(V10_PUBLISH_PAYLOAD_MAGIC.length + nonce.length + encrypted.length + tag.length);
  out.set(V10_PUBLISH_PAYLOAD_MAGIC, 0);
  out.set(nonce, V10_PUBLISH_PAYLOAD_MAGIC.length);
  out.set(encrypted, V10_PUBLISH_PAYLOAD_MAGIC.length + nonce.length);
  out.set(tag, V10_PUBLISH_PAYLOAD_MAGIC.length + nonce.length + encrypted.length);
  return out;
}

export interface DecryptV10PublishPayloadInput {
  chainKey: Uint8Array;
  contextGraphId: string;
  encryptedPayload: Uint8Array;
}

export function decryptV10PublishPayload(input: DecryptV10PublishPayloadInput): Uint8Array {
  const buf = input.encryptedPayload;
  const headerLen = V10_PUBLISH_PAYLOAD_MAGIC.length + NONCE_BYTES;
  if (buf.length < headerLen + AUTH_TAG_BYTES) {
    throw new Error(
      `v10-publish-payload: ciphertext too short (got ${buf.length}, need >= ${headerLen + AUTH_TAG_BYTES})`,
    );
  }
  for (let i = 0; i < V10_PUBLISH_PAYLOAD_MAGIC.length; i++) {
    if (buf[i] !== V10_PUBLISH_PAYLOAD_MAGIC[i]) {
      throw new Error('v10-publish-payload: magic prefix mismatch — not an encrypted v10 publish payload');
    }
  }
  const nonce = buf.slice(V10_PUBLISH_PAYLOAD_MAGIC.length, headerLen);
  const ciphertextEnd = buf.length - AUTH_TAG_BYTES;
  const ciphertext = buf.slice(headerLen, ciphertextEnd);
  const tag = buf.slice(ciphertextEnd);
  const key = derivePayloadKey(input.chainKey, input.contextGraphId);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  decipher.setAuthTag(Buffer.from(tag));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext)),
    decipher.final(),
  ]);
  return new Uint8Array(plaintext);
}

/**
 * Test/debug helper — returns true iff `buf` carries the
 * v10-publish-payload magic prefix.
 */
export function isEncryptedV10PublishPayload(buf: Uint8Array): boolean {
  if (buf.length < V10_PUBLISH_PAYLOAD_MAGIC.length) return false;
  for (let i = 0; i < V10_PUBLISH_PAYLOAD_MAGIC.length; i++) {
    if (buf[i] !== V10_PUBLISH_PAYLOAD_MAGIC[i]) return false;
  }
  return true;
}
