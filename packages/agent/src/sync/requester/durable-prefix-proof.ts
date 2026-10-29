// SPDX-License-Identifier: Apache-2.0
import { graphScopedDurableManifestPrefixAtOffset, type GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import { runBoundedOperation } from '../../bounded-operation.js';
import type { HeldAssetsProof, HeldAssetContentSource } from './held-assets-contracts.js';

/** Optional whole-manifest optimization must leave most of the recovery lifetime for DATA. */
export const DURABLE_HOLDINGS_SCAN_BUDGET_MS = 30_000;

/** Owns the graph's content proof from its first read through settlement or failure. */
export class DurableGraphSettlementGuard {
  private current: { manifest: GraphScopedDurableManifestPlan; proof: HeldAssetsProof; reject?(): void } | undefined;

  constructor(private readonly assertNotAborted: () => void, private readonly source?: HeldAssetContentSource) {}

  private async prove(manifest: GraphScopedDurableManifestPlan,
    descriptors: GraphScopedDurableManifestPlan['descriptors'], signal?: AbortSignal): Promise<HeldAssetsProof | undefined> {
    if (this.current) throw new Error('Graph settlement already owns a content proof');
    if (!this.source) return undefined;
    this.source.assertOwnership(); this.assertNotAborted(); signal?.throwIfAborted();
    const proof = await this.source.prove({ contextGraphId: manifest.contextGraphId, descriptors, signal });
    if (!proof) return undefined;
    try {
      // A timed-out scan can finish after DATA owns a different prefix proof.
      // Retire only this late result; never replace or close the new owner.
      signal?.throwIfAborted(); this.source.assertOwnership(); this.assertNotAborted();
      if (this.current) throw new Error('Graph settlement already owns a content proof');
      this.current = { manifest, proof };
      this.assertCurrent(); return proof;
    } catch (error) {
      if (this.current?.proof === proof) this.current = undefined;
      proof.close(); throw error;
    }
  }

  /** Planning borrows evidence; only this scope can narrow or dispose its proof. */
  async proveHoldings(manifest: GraphScopedDurableManifestPlan, signal?: AbortSignal):
    Promise<Pick<HeldAssetsProof, 'held' | 'reconcile'> | undefined> {
    return runBoundedOperation(scanSignal => this.prove(manifest, manifest.descriptors, scanSignal), {
      signal, timeoutMs: DURABLE_HOLDINGS_SCAN_BUDGET_MS, label: 'Durable holdings preflight',
    });
  }

  /** A fresh DATA round replaces its own assets and needs no reused-prefix watch. */
  releaseUnneededHoldings(): void { this.close(); }

  /** Fresh and already-held prefixes use the same projection and invalidation path. */
  async acquire(manifest: GraphScopedDurableManifestPlan, offset: number,
    reject: () => void, signal?: AbortSignal): Promise<void> {
    try {
      const prefix = graphScopedDurableManifestPrefixAtOffset(manifest, offset);
      if (!prefix) throw new Error('Cannot prove stored durable prefix');
      const descriptors = manifest.descriptors.slice(0, prefix.descriptorCount);
      if (!this.current) await this.prove(manifest, descriptors, signal);
      const current = this.current;
      if (!current) throw new Error('Cannot prove stored durable prefix');
      current.reject = reject;
      this.assertCurrent(); signal?.throwIfAborted();
      if (current.manifest.contextGraphId !== manifest.contextGraphId
        || current.manifest.manifestDigest !== manifest.manifestDigest) {
        throw new Error('Cannot project held proof onto another manifest');
      }
      const uals = new Set(descriptors.map(descriptor => descriptor.ual));
      if ([...uals].some(ual => !current.proof.held.has(ual))) throw new Error('Stored durable prefix is missing or corrupt');
      current.proof.retain(uals);
      this.assertCurrent();
    } catch (error) { if (!signal?.aborted) reject(); throw error; }
  }

  readonly assertPrefixCurrent = (): void => {
    if (!this.current) return;
    try { this.source!.assertOwnership(); this.current.proof.assertCurrent(); }
    catch (error) { this.current.reject?.(); throw error; }
  };

  readonly assertCurrent = (): void => { this.assertPrefixCurrent(); this.assertNotAborted(); };

  covers(ual: string): boolean { return this.current?.proof.held.has(ual) ?? false; }

  close(): void { this.current?.proof.close(); this.current = undefined; }
}
