/**
 * OT-RFC-38 LU-11 / OT-RFC-39 — URI helpers for per-chunk ciphertext
 * persistence on hosting cores.
 *
 * Cores receive chunked SWM gossip envelopes (`type =
 * 'share-write-chunked'`), strip the 32-byte `batchId` prefix from
 * the envelope payload, and persist the remaining ciphertext bytes
 * under a deterministic triple-store URI so the V2 ACK verifier can
 * look every chunk up by `(cgId, batchId, chunkIndex)` and recompute
 * the publisher's claimed `ciphertextChunksRoot`.
 *
 * Storage layout:
 *
 *   Named graph:  urn:dkg:swm:ciphertext-chunks/<sanitizedCanonicalCgId>
 *   Subject:      urn:dkg:swm:v10-publish-ciphertext-chunk/<batchIdHex>/<chunkIndex>
 *   Predicate:    urn:dkg:swm:v10-publish-ciphertext-chunk-bytes
 *   Object:       "<base64(ciphertext_chunk_bytes)>"
 *
 * Two-level shape (one named graph per cgId, one subject per
 * `(batchId, chunkIndex)` tuple) keeps the per-cgId chunk set
 * trivially droppable on a `dropGraph(<chunks-graph>)` call without
 * fanning out across thousands of subject deletes — useful for the
 * eviction/TTL passes a future LU-11 patch will add. Subject URIs
 * keep `batchId` first so the SPARQL "list every chunk for one
 * batch" query (V2 ACK verify path) needs only a STRSTARTS on the
 * full per-batch prefix, no cross-batch scan.
 *
 * **Codex review on PR #715** — `(batchId, chunkIndex)` is NOT a
 * globally unique storage key on its own: two CGs publishing
 * identical V10 KCs would share a batchId (it's a plaintext-derived
 * merkleRoot), so a wildcard `GRAPH ?g` lookup risks returning the
 * wrong CG's ciphertext bytes and corrupting either the V2 ACK
 * verify or the curated random-sampling proof. The fix is operational:
 * BOTH persist AND lookup sites canonicalize the CG id (cleartext or
 * numeric → curator-committed `nameHash` via `gossipWireIdFor` in
 * `dkg-agent`) BEFORE computing `ciphertextChunkStoreGraph`. The
 * per-CG named graph then provides the discriminator the subject URI
 * alone cannot. See the persist site in
 * `dkg-agent.ingestSwmCiphertextChunkEnvelope`, the V2 ACK lookup in
 * `storage-ack-handler.loadChunk`, the responder lookup in
 * `dkg-agent.handleGetCiphertextChunk`, and the prover-side lookup in
 * `random-sampling/ciphertext-chunks-extractor.extractCiphertextChunksFromStore`
 * — every one converges on the wire-form `nameHash` so per-CG
 * isolation holds without changing the subject URI shape.
 *
 * `batchId` MUST be a 32-byte buffer (the V10 KC merkleRoot). The
 * helpers stringify it via lowercase 0x-prefixed hex so the same
 * key shape rounds back from the publisher's PublishIntent on the
 * verify side without any normalisation drift.
 */

/** Predicate IRI under which the base64-encoded chunk bytes are stored. */
export const CIPHERTEXT_CHUNK_PREDICATE = 'urn:dkg:swm:v10-publish-ciphertext-chunk-bytes';

const CIPHERTEXT_CHUNK_SUBJECT_PREFIX = 'urn:dkg:swm:v10-publish-ciphertext-chunk';
const CIPHERTEXT_CHUNK_GRAPH_PREFIX = 'urn:dkg:swm:ciphertext-chunks';

function sanitizeForUri(s: string): string {
  // Percent-encode anything that would break IRI parsing
  // (whitespace, punctuation, non-ASCII). The cgId surface includes
  // both numeric on-chain ids ("42") and cleartext names with
  // arbitrary characters — both routes through the same helper.
  return encodeURIComponent(s);
}

function bytesToHexNoPrefix(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) {
    out += b[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Per-cgId named graph holding every chunk for that CG. */
export function ciphertextChunkStoreGraph(cgId: string): string {
  return `${CIPHERTEXT_CHUNK_GRAPH_PREFIX}/${sanitizeForUri(cgId)}`;
}

/** Per-(batchId, chunkIndex) subject URI. */
export function ciphertextChunkStoreSubject(batchId: Uint8Array, chunkIndex: number): string {
  if (batchId.length !== 32) {
    throw new Error(
      `ciphertextChunkStoreSubject requires a 32-byte batchId (V10 KC merkleRoot); got ${batchId.length}`,
    );
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error(
      `ciphertextChunkStoreSubject requires a non-negative integer chunkIndex; got ${chunkIndex}`,
    );
  }
  return `${CIPHERTEXT_CHUNK_SUBJECT_PREFIX}/0x${bytesToHexNoPrefix(batchId)}/${chunkIndex}`;
}

/** Per-batch subject prefix used by SPARQL queries that scan all chunks for one batch. */
export function ciphertextChunkStoreBatchPrefix(batchId: Uint8Array): string {
  if (batchId.length !== 32) {
    throw new Error(
      `ciphertextChunkStoreBatchPrefix requires a 32-byte batchId; got ${batchId.length}`,
    );
  }
  return `${CIPHERTEXT_CHUNK_SUBJECT_PREFIX}/0x${bytesToHexNoPrefix(batchId)}/`;
}
