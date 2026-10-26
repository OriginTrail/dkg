// SPDX-License-Identifier: Apache-2.0
import type { DurableRecoveryRoundDecision } from './durable-recovery-round.js';
import type { MissingDurableAsset, DurableHoldingsOptions } from './requester/durable-data-holdings.js';

export type DurableRecoveryAction =
  | { readonly kind: 'graph-round'; readonly peerId: string }
  | { readonly kind: 'exact-batch'; readonly peerId: string; readonly assets: readonly MissingDurableAsset[] };

const versionOf = (asset: MissingDurableAsset) => `${asset.ual}\0${asset.assertionVersion}`;

/** Owns the ordered missing-asset work and the one-way fallback to full rounds. */
export class DurableRecoveryFetchPolicy {
  private pending: Extract<DurableRecoveryAction, { kind: 'exact-batch' }>[] = [];
  private readonly fetched = new Set<string>();
  private fullGraph = false;
  private readonly confirmedHeldCopies = new Set<string>();

  holdings(exactAvailable: boolean): DurableHoldingsOptions {
    return { ownerFetchesMissingAssets: exactAvailable && !this.fullGraph,
      confirmedHeldCopies: this.confirmedHeldCopies };
  }

  nextExact(): Extract<DurableRecoveryAction, { kind: 'exact-batch' }> | undefined {
    const action = this.pending.shift();
    if (action) for (const asset of action.assets) this.fetched.add(versionOf(asset));
    return action;
  }

  queueMissing(peerId: string, batches: readonly (readonly MissingDurableAsset[])[]): number {
    const repeated = batches.flat().filter(asset => this.fetched.has(versionOf(asset))).length;
    if (repeated > 0) this.useFullGraph();
    else this.pending = batches.map(assets => ({ kind: 'exact-batch', peerId, assets }));
    return repeated;
  }

  recordRound(decision: DurableRecoveryRoundDecision, advanced: boolean): void {
    if (advanced && decision.strategy === 'full' && decision.continuation === 'full-graph') this.useFullGraph();
  }

  recordExact(complete: boolean): void {
    if (!complete) this.useFullGraph();
  }

  useFullGraph(): void {
    this.fullGraph = true;
    this.pending = [];
  }
}
