// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import { canonicalQuadKey } from './quad-key.js';

/**
 * Own the one-round metadata commit policy for graph-scoped snapshots.
 * Per-KA writes, finalized-twin suppression, the final bulk append and counter
 * compensation all consult this object so a caller cannot update only one of
 * those ledgers and accidentally resurrect retired SWM metadata.
 */
type FinalizedTwinMetadataDisposition = 'preserve' | 'suppress-metadata';
export type FinalizedTwinReconciler = (
  contextGraphId: string,
  descriptor: GraphScopedSwmRecoveryDescriptor,
) => Promise<FinalizedTwinMetadataDisposition>;
/** This node retired this exact snapshot as a finalized twin, and Verified Memory still proves it. */
export type HeldFinalizedTwinCheck = (
  contextGraphId: string,
  descriptor: GraphScopedSwmRecoveryDescriptor,
) => Promise<boolean>;

export class GraphScopedSnapshotCommitCoordinator {
  readonly #verifiedKeys: ReadonlySet<string>;
  readonly #writtenKeys = new Set<string>();
  readonly #suppressedKeys = new Set<string>();
  readonly #settledEarlierKeys = new Set<string>();
  readonly #reconcileFinalizedTwin: FinalizedTwinReconciler | undefined;
  readonly #heldAsRetiredFinalizedTwin: HeldFinalizedTwinCheck | undefined;

  constructor(
    verifiedMeta: readonly Quad[],
    reconcileFinalizedTwin: FinalizedTwinReconciler | undefined,
    heldAsRetiredFinalizedTwin?: HeldFinalizedTwinCheck,
  ) {
    this.#verifiedKeys = new Set(verifiedMeta.map(canonicalQuadKey));
    this.#reconcileFinalizedTwin = reconcileFinalizedTwin;
    this.#heldAsRetiredFinalizedTwin = heldAsRetiredFinalizedTwin;
  }

  unwrittenVerifiedRows(descriptor: GraphScopedSwmRecoveryDescriptor): Quad[] {
    return descriptor.metadataQuads.filter((quad) => {
      const key = canonicalQuadKey(quad);
      return this.#verifiedKeys.has(key)
        && !this.#writtenKeys.has(key)
        && !this.#suppressedKeys.has(key);
    });
  }

  recordWritten(rows: readonly Quad[]): void {
    for (const quad of rows) this.#writtenKeys.add(canonicalQuadKey(quad));
  }

  /**
   * Rows of a ref an earlier round of this transfer resolved. That round
   * committed or withheld them under the asset's lock and the store may have
   * moved on since, so the bulk append leaves them alone. The asset's own commit
   * still writes them when this round has to materialize the ref again.
   */
  recordSettledEarlier(rows: readonly Quad[]): void {
    for (const quad of rows) this.#settledEarlierKeys.add(canonicalQuadKey(quad));
  }

  /**
   * GH#2273 — ROW-level suppression for identity-preserving decisions. Only
   * the specific rows named here are withheld from this round's remaining
   * writes (`insertVerifiedDescriptorMeta` and the bulk append both honour the
   * same ledger). Deliberately NOT descriptor-level: after a head repair the
   * head subject holds only what the repair re-inserted, and suppressing a
   * descriptor's WHOLE metadata there would withhold the four required head
   * rows too, leaving a head the resolver permanently fails closed on. The
   * key identity with `verifiedMetaForInsert` holds because canonicalization
   * only REMOVES rows — a canonicalizer that rewrites rows would silently
   * break this ledger.
   */
  suppressRows(rows: readonly Quad[]): void {
    for (const quad of rows) {
      const key = canonicalQuadKey(quad);
      if (this.#verifiedKeys.has(key)) this.#suppressedKeys.add(key);
    }
  }

  suppressedRows(rows: readonly Quad[]): Quad[] {
    return rows.filter((quad) => this.#suppressedKeys.has(canonicalQuadKey(quad)));
  }

  #suppress(descriptor: GraphScopedSwmRecoveryDescriptor): void {
    for (const quad of descriptor.metadataQuads) {
      const key = canonicalQuadKey(quad);
      if (this.#verifiedKeys.has(key)) this.#suppressedKeys.add(key);
    }
  }

  /**
   * Own post-materialization reconciliation and its metadata disposition as
   * one commit decision. The caller cannot retire a twin without updating the
   * same ledger that filters the round's final bulk append.
   */
  async reconcileAfterMaterialization(params: {
    contextGraphId: string;
    descriptor: GraphScopedSwmRecoveryDescriptor;
    onDeferred: (cause: unknown) => void;
  }): Promise<void> {
    if (!this.#reconcileFinalizedTwin) return;
    try {
      const disposition = await this.#reconcileFinalizedTwin(
        params.contextGraphId,
        params.descriptor,
      );
      if (disposition === 'suppress-metadata') this.#suppress(params.descriptor);
    } catch (cause) {
      // Snapshot materialization is already durable. Preserve the twin and
      // retry on a later pass instead of reclassifying a successful sync.
      params.onDeferred(cause);
    }
  }

  /**
   * True for a snapshot that an earlier round wrote, found finalized in
   * Verified Memory with the same bytes, and retired
   * (`finalized-swm-twin-memo.ts`), when the same proof passes again now (it
   * retires a copy a share brought back). Writing it again would only see it
   * retired again, so the caller counts the asset as held and writes nothing,
   * and its metadata stays out of the round's writes, as the retirement left it.
   */
  async holdRetiredFinalizedTwin(contextGraphId: string, descriptor: GraphScopedSwmRecoveryDescriptor): Promise<boolean> {
    if (this.#heldAsRetiredFinalizedTwin === undefined) return false;
    if (!(await this.#heldAsRetiredFinalizedTwin(contextGraphId, descriptor))) return false;
    this.#suppress(descriptor);
    return true;
  }

  bulkRows(rows: readonly Quad[]): Quad[] {
    // Every row committed under a KA lock stays owned by that commit. A
    // finalizer may retire the head after the lock releases and before this
    // append; even byte-identical replay would then resurrect a torn head.
    return rows.filter((quad) => {
      const key = canonicalQuadKey(quad);
      return !this.#writtenKeys.has(key) && !this.#suppressedKeys.has(key) && !this.#settledEarlierKeys.has(key);
    });
  }

}
