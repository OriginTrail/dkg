/**
 * OT-RFC-38 / LU-5 / LU-11 — encrypted V10 publish payload for curated
 * CGs.
 *
 * Two AEAD shapes live here:
 *
 * 1. **Single-blob** (`encryptV10PublishPayload`, LU-5): the entire
 *    merged plaintext for a curated batch is one AES-256-GCM call with
 *    a random nonce. Wraps `PublishIntent.stagingQuads` as one opaque
 *    blob. Still exported for backwards compatibility with any caller
 *    that hasn't migrated to the chunked path.
 *
 * 2. **Chunked** (`encryptChunked`, LU-11): per-SWM-message ciphertexts
 *    keyed to a curator-assigned `swmMessageIndex` so cores can persist
 *    one ciphertext per (cgId, batchId, chunkId) and RFC-39 random
 *    sampling can sample uniformly over chunkIds. Nonces are
 *    **deterministic** — derived from `(publishOperationId, chunkIndex)`
 *    via HKDF — so an in-flight publisher retry against the same
 *    `publishOperationId` reproduces bit-identical ciphertext (the only
 *    way to keep the on-chain `ciphertextChunksRoot` stable across
 *    attempts without re-attesting). A *new* `publishOperationId` MUST
 *    be allocated whenever the chunk-set changes, otherwise nonce
 *    reuse against the same key on different plaintext breaks AES-GCM.
 *
 * Shared format (each chunk in the chunked path AND the single LU-5
 * payload):
 *
 *   - Payload key  = HKDF-SHA256(chainKey, salt='', info=`dkg.v10-publish-payload-key.v1|${cgId}`)
 *   - Nonce        = 12 bytes (random for single-blob; deterministic per
 *                    `(publishOperationId, chunkIndex)` for chunked)
 *   - Cipher       = AES-256-GCM
 *   - Auth tag     = 16 bytes appended by GCM
 *   - Wire layout  = [4-byte LE magic 'V10P'] [12-byte nonce] [ciphertext || tag]
 *
 * Cores receiving the ciphertext do NOT attempt to decrypt. They sign
 * the V10 ACK digest verbatim against the publisher's claimed
 * `merkleRoot`/`byteSize` (single-blob) or `ciphertextChunksRoot`
 * (chunked); member-side post-decrypt verification (LU-8) catches
 * any plaintext mismatch.
 *
 * Members who fell behind the publisher's chain-key ratchet must catch
 * up to the publisher's current SWM state (LU-7) before they can derive
 * the right `chainKey` snapshot and decrypt. The same constraint
 * applies to both single-blob and chunked.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const V10_PUBLISH_PAYLOAD_MAGIC = new TextEncoder().encode('V10P');
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_INFO_PREFIX = 'dkg.v10-publish-payload-key.v1|';
const CHUNK_NONCE_INFO_PREFIX = 'dkg.v10-publish-payload-chunk-nonce.v1|';

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

/**
 * Deterministic 12-byte nonce derived from the publisher's
 * `publishOperationId` plus the in-batch `chunkIndex`. Two reasons HKDF
 * is the right tool here rather than a raw counter:
 *
 *   - The IKM (`publishOperationId`) is short and low-entropy; HKDF's
 *     extract step folds in the chunkIndex via `info` to produce a
 *     well-distributed output even when only one of the two inputs
 *     changes.
 *   - The output is bit-identical across retries of the same
 *     `(publishOperationId, chunkIndex)` pair — required so retried
 *     publishes produce the same `ciphertextChunksRoot`.
 *
 * **Invariant**: a single `publishOperationId` MUST NEVER be reused
 * against different plaintext at the same chunkIndex under the same
 * payload key. The publisher allocates a fresh `publishOperationId`
 * for each logical publish attempt; retries that change the chunk-set
 * MUST also rotate the `publishOperationId`.
 */
export function deriveChunkNonce(publishOperationId: string, chunkIndex: number): Uint8Array {
  if (!publishOperationId) {
    throw new Error('v10-publish-payload: publishOperationId must be a non-empty string');
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error(
      `v10-publish-payload: chunkIndex must be a non-negative integer (got ${chunkIndex})`,
    );
  }
  const info = new TextEncoder().encode(
    `${CHUNK_NONCE_INFO_PREFIX}${publishOperationId}|${chunkIndex}`,
  );
  // IKM is the publishOperationId bytes themselves; the chunkIndex
  // varies through `info`. HKDF treats both as deterministic inputs.
  return new Uint8Array(
    hkdfSync(
      'sha256',
      Buffer.from(publishOperationId, 'utf8'),
      Buffer.alloc(0),
      info,
      NONCE_BYTES,
    ) as ArrayBuffer,
  );
}

/**
 * Per-payload AES-256-GCM encrypt with the shared 'V10P'-magic wire
 * layout. Shared between {@link encryptV10PublishPayload} (single blob,
 * random nonce) and {@link encryptChunked} (per-chunk, deterministic
 * nonce).
 */
function encryptOnePayload(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`v10-publish-payload: nonce must be ${NONCE_BYTES} bytes (got ${nonce.length})`);
  }
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Layout: [4 magic] [12 nonce] [ciphertext] [16 tag]
  const out = new Uint8Array(
    V10_PUBLISH_PAYLOAD_MAGIC.length + nonce.length + encrypted.length + tag.length,
  );
  out.set(V10_PUBLISH_PAYLOAD_MAGIC, 0);
  out.set(nonce, V10_PUBLISH_PAYLOAD_MAGIC.length);
  out.set(encrypted, V10_PUBLISH_PAYLOAD_MAGIC.length + nonce.length);
  out.set(tag, V10_PUBLISH_PAYLOAD_MAGIC.length + nonce.length + encrypted.length);
  return out;
}

/**
 * Per-payload AES-256-GCM decrypt with the shared 'V10P'-magic wire
 * layout. Shared between {@link decryptV10PublishPayload} (single blob)
 * and {@link decryptChunked} (per-chunk).
 */
function decryptOnePayload(key: Uint8Array, encryptedPayload: Uint8Array): Uint8Array {
  const buf = encryptedPayload;
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
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  decipher.setAuthTag(Buffer.from(tag));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext)),
    decipher.final(),
  ]);
  return new Uint8Array(plaintext);
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
  return encryptOnePayload(key, input.plaintext, nonce);
}

export interface DecryptV10PublishPayloadInput {
  chainKey: Uint8Array;
  contextGraphId: string;
  encryptedPayload: Uint8Array;
}

export function decryptV10PublishPayload(input: DecryptV10PublishPayloadInput): Uint8Array {
  const key = derivePayloadKey(input.chainKey, input.contextGraphId);
  return decryptOnePayload(key, input.encryptedPayload);
}

export interface EncryptChunkedInput {
  chainKey: Uint8Array;
  contextGraphId: string;
  /**
   * Per-SWM-message plaintexts in chunkId order. `plaintextChunks[i]`
   * MUST correspond to `swmMessageIndex == i` on the gossip envelope
   * commit 4 of LU-11 will add.
   */
  plaintextChunks: Uint8Array[];
  /**
   * Unique-per-publish-attempt identifier feeding nonce derivation. The
   * publisher binds this to the operation-scoped `publishOperationId`
   * so two attempts of the same logical batch get two different
   * `publishOperationId`s and never reuse a `(key, nonce)` pair on
   * different plaintext at the same chunk index.
   */
  publishOperationId: string;
}

export interface EncryptChunkedResult {
  /**
   * Per-chunk wire-encoded ciphertexts in chunkId order. Each entry is
   * `[4 magic 'V10P'][12 nonce][ciphertext][16 tag]` and is
   * round-trippable through {@link decryptChunked} OR {@link
   * decryptV10PublishPayload} on a single element (same wire shape).
   */
  ciphertextChunks: Uint8Array[];
}

/**
 * Per-SWM-message chunked AEAD entry-point.
 *
 * Each chunk is encrypted with a deterministic nonce derived from
 * `(publishOperationId, chunkIndex)` so a publisher retry against the
 * same `publishOperationId` reproduces bit-identical ciphertext — a
 * precondition for keeping the on-chain `ciphertextChunksRoot` stable
 * across attempts.
 */
export function encryptChunked(input: EncryptChunkedInput): EncryptChunkedResult {
  const key = derivePayloadKey(input.chainKey, input.contextGraphId);
  const ciphertextChunks = input.plaintextChunks.map((plaintext, chunkIndex) => {
    const nonce = deriveChunkNonce(input.publishOperationId, chunkIndex);
    return encryptOnePayload(key, plaintext, nonce);
  });
  return { ciphertextChunks };
}

export interface DecryptChunkedInput {
  chainKey: Uint8Array;
  contextGraphId: string;
  /** Per-chunk wire-encoded ciphertexts (output of {@link encryptChunked}). */
  ciphertextChunks: Uint8Array[];
}

export interface DecryptChunkedResult {
  plaintextChunks: Uint8Array[];
}

/**
 * Decrypt every chunk emitted by {@link encryptChunked} in-order. The
 * nonce is embedded in each wire chunk so callers don't need to know
 * the `publishOperationId` again at decrypt time — this is intentional
 * so members can decrypt a curated batch by reading the on-disk
 * ciphertext alone.
 */
export function decryptChunked(input: DecryptChunkedInput): DecryptChunkedResult {
  const key = derivePayloadKey(input.chainKey, input.contextGraphId);
  const plaintextChunks = input.ciphertextChunks.map((encryptedPayload) =>
    decryptOnePayload(key, encryptedPayload),
  );
  return { plaintextChunks };
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
