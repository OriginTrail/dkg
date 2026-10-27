// SPDX-License-Identifier: Apache-2.0
import { graphScopedDurableManifestPrefixAtOffset, type GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import type { HeldAssetsProof } from './held-assets-contracts.js';

export interface StoredPrefixProof {
  assertCurrent(): void;
  close(): void;
  covers(ual: string): boolean;
}
export type StoredDurablePrefix = (
  manifest: GraphScopedDurableManifestPlan, offset: number, signal?: AbortSignal,
) => Promise<StoredPrefixProof>;

/** Owns one graph settlement's proof, including checkpoint rejection and disposal. */
export class DurableGraphSettlementGuard {
  private current: { proof: StoredPrefixProof; reject(): void;
    retained?: { manifest: GraphScopedDurableManifestPlan; proof: HeldAssetsProof } } | undefined;

  constructor(private readonly assertNotAborted: () => void) {}

  adopt(proof: StoredPrefixProof, reject: () => void = () => {}): void {
    if (this.current) throw new Error('Graph settlement already owns a content proof');
    this.current = { proof, reject };
  }

  adoptHoldings(manifest: GraphScopedDurableManifestPlan, proof: HeldAssetsProof, assertOwnership: () => void): void {
    this.adopt({ assertCurrent: () => { assertOwnership(); proof.assertCurrent(); },
      close: proof.close, covers: ual => proof.held.has(ual) });
    this.current!.retained = { manifest, proof };
  }

  /** A fresh DATA round will replace its own assets and needs no reused-prefix watch. */
  releaseUnneededHoldings(): void { if (this.current?.retained) this.close(); }

  async acquire(capability: StoredDurablePrefix | undefined, manifest: GraphScopedDurableManifestPlan,
    offset: number, reject: () => void, signal?: AbortSignal): Promise<void> {
    if (this.current?.retained) {
      this.current.reject = reject;
      try {
        this.assertCurrent(); signal?.throwIfAborted();
        const prefix = graphScopedDurableManifestPrefixAtOffset(manifest, offset);
        if (!prefix || this.current.retained.manifest.contextGraphId !== manifest.contextGraphId
          || this.current.retained.manifest.manifestDigest !== manifest.manifestDigest) {
          throw new Error('Cannot project held proof onto another manifest');
        }
        const uals = new Set(manifest.descriptors.slice(0, prefix.descriptorCount).map(descriptor => descriptor.ual));
        this.current.retained.proof.retain(uals);
        this.current.retained = undefined;
        this.assertCurrent();
      } catch (error) { if (!signal?.aborted) reject(); throw error; }
      return;
    }
    if (this.current) throw new Error('Graph settlement already owns a prefix proof');
    try {
      if (!capability) throw new Error('Cannot prove stored durable prefix');
      this.adopt(await capability(manifest, offset, signal), reject);
    }
    catch (error) { if (!signal?.aborted) reject(); throw error; }
  }

  readonly assertPrefixCurrent = (): void => {
    try { this.current?.proof.assertCurrent(); }
    catch (error) { this.current?.reject(); throw error; }
  };

  readonly assertCurrent = (): void => { this.assertPrefixCurrent(); this.assertNotAborted(); };

  covers(ual: string): boolean { return this.current?.proof.covers(ual) ?? false; }

  close(): void { this.current?.proof.close(); this.current = undefined; }
}
