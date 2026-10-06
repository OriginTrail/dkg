// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphAuthorityReadOptions, ContextGraphAuthoritySnapshot } from './chain-adapter.js';
import type { ContextGraphAuthorityIndexId } from './context-graph-authority-index-id.js';

/**
 * Logical finalized-authority capability. Callers provide the complete target
 * set for one operation; the chain implementation owns validation, projection,
 * and the single finalized anchor.
 */
export interface ContextGraphAuthorityIndexRevisionReader {
  /**
   * Resolve one RFC-64 authority binding at the index's finalized anchor.
   * This intentionally differs from the public current-state name resolver.
   */
  resolveFinalizedContextGraphIdByNameHash?(
    nameHash: string,
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<bigint | null>;
  /**
   * Resolve many unique name commitments from one finalized index projection.
   * Missing and zero-hash commitments are omitted; ambiguity fails closed.
   */
  resolveFinalizedContextGraphIdsByNameHashes?(
    nameHashes: readonly string[],
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ReadonlyMap<string, bigint>>;
  /**
   * Resolve a name commitment and its complete authority state atomically at
   * one finalized anchor. RFC-64 consumers should prefer this over composing
   * the single-name ID resolver with a later snapshot read.
   */
  resolveFinalizedContextGraphAuthoritySnapshotByNameHash?(
    nameHash: string,
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ContextGraphAuthoritySnapshot | null>;
  /**
   * Resolve many name commitments and their complete authority state from one
   * finalized index projection. Missing and zero-hash commitments are omitted;
   * ambiguity fails the whole projection closed.
   */
  resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes?(
    nameHashes: readonly string[],
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>>;
  /**
   * Retained-only counterpart: never initializes, refreshes or calls a provider.
   * `undefined` is an unproven cache miss; an empty map is proven name absence.
   */
  peekFinalizedContextGraphAuthoritySnapshotsByNameHashes?(
    nameHashes: readonly string[],
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot> | undefined>;
  readContextGraphAuthorityIndexRevisions(
    contextGraphIds: readonly ContextGraphAuthorityIndexId[],
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ReadonlyMap<ContextGraphAuthorityIndexId, string>>;
  /**
   * Read complete authority snapshots for many graphs at one finalized anchor.
   * Responsibility selection and immediate authority acceptance share this
   * projection. Optional so older/custom adapters retain their point-read path.
   */
  readContextGraphAuthorityIndexSnapshots?(
    contextGraphIds: readonly ContextGraphAuthorityIndexId[],
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ReadonlyMap<
    ContextGraphAuthorityIndexId,
    ContextGraphAuthoritySnapshot
  >>;
  /** Await the physical shared-index scans underlying detached/cancelled waiters. */
  whenIdle(): Promise<void>;
}
