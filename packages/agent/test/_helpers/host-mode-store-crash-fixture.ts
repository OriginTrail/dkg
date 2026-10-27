/**
 * Shared fixture of the SWM host-mode store crash tests: the crash child
 * (`host-mode-store-crash-child.ts`) writes these payloads, and
 * `test/swm/host-mode-store-crash.e2e.test.ts` compares what survives a kill -9
 * against them byte for byte.
 */

/** Size of every ciphertext envelope the child appends. */
export const PAYLOAD_BYTES = 64;

/**
 * The envelope the child appends as frame `seqno`: PAYLOAD_BYTES bytes, each
 * equal to the seqno. The child's appends are sequential from a fresh store, so
 * the n-th append is seqno n and carries payloadFor(n).
 */
export function payloadFor(seqno: number): Uint8Array {
  return new Uint8Array(PAYLOAD_BYTES).fill(seqno);
}

/** The envelope the parent appends after recovery (a seqno the child never wrote). */
export const RECOVERY_APPEND_FILL = 0xee;
