// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDurableManifestPlan } from '../durable-integrity.js';

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
  private current: { proof: StoredPrefixProof; reject(): void } | undefined;

  constructor(private readonly assertNotAborted: () => void) {}

  async acquire(capability: StoredDurablePrefix | undefined, manifest: GraphScopedDurableManifestPlan,
    offset: number, reject: () => void, signal?: AbortSignal): Promise<void> {
    if (this.current) throw new Error('Graph settlement already owns a prefix proof');
    try {
      if (!capability) throw new Error('Cannot prove stored durable prefix');
      this.current = { proof: await capability(manifest, offset, signal), reject };
    }
    catch (error) { reject(); throw error; }
  }

  readonly assertPrefixCurrent = (): void => {
    try { this.current?.proof.assertCurrent(); }
    catch (error) { this.current?.reject(); throw error; }
  };

  readonly assertCurrent = (): void => { this.assertPrefixCurrent(); this.assertNotAborted(); };

  covers(ual: string): boolean { return this.current?.proof.covers(ual) ?? false; }

  close(): void { this.current?.proof.close(); this.current = undefined; }
}
