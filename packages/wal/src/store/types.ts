import type { WalObjectId } from '../reconciliation/ids.js';

/**
 * Durable storage for complete, canonical, signature-verified WalObjectV1 bytes.
 *
 * Transfer ranges, temporary paths, provider sessions, quarantine, RDF, and
 * compaction policy deliberately do not appear in this contract.
 */
export abstract class WalObjectStore {
  abstract has(id: WalObjectId): Promise<boolean>;

  /** Offsets address the complete canonical WalObjectV1 encoding. */
  abstract read(
    id: WalObjectId,
    offset?: bigint,
    length?: number,
  ): AsyncIterable<Uint8Array>;

  /**
   * Stream, verify, and atomically admit one complete object. Repeating the
   * same object ID is idempotent.
   */
  abstract put(
    expectedId: WalObjectId,
    bytes: AsyncIterable<Uint8Array>,
  ): Promise<void>;

  /** IDs are yielded once in unsigned lexicographic byte order. */
  abstract ids(): AsyncIterable<WalObjectId>;
}
