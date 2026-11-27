// SPDX-License-Identifier: Apache-2.0
import { withMaterializationLocks } from '@origintrail-official/dkg-publisher';
import { storeLaneInflightLimit, type AtomicAssetReplacement, type QueryOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import type { VerifiedGraphScopedAsset, GraphScopedMaterializationOutcome } from './graph-scoped-materialization.js';
import { prepareGraphScopedReplacementUnderLock } from './graph-scoped-replacement.js';

/** One physical publication lifetime for singleton and grouped recovery. */
export async function executeGraphScopedPublication<T extends GraphScopedMaterializationOutcome>(params: {
  store: TripleStore; assets: readonly VerifiedGraphScopedAsset[]; options: QueryOptions;
  assertCurrent(): void; shouldQuarantineCommitted?(): boolean;
  lockAlreadyHeldByCaller?: boolean; requireCurrentMetadata: boolean;
  stale(): T; complete(): T;
  /**
   * Given, the outcome when every asset is a same-version replay the store
   * already holds exactly: nothing is written. A binding that changed
   * meanwhile still writes and quarantines, as for any other copy.
   */
  unchanged?(): T;
  publish(replacements: AtomicAssetReplacement[], options: QueryOptions): Promise<void>;
  quarantine(replacements: AtomicAssetReplacement[], options: QueryOptions): Promise<void>;
}): Promise<T | 'quarantined'> {
  const { assets, options, assertCurrent } = params;
  const apply = async (): Promise<T | 'quarantined'> => {
    assertCurrent();
    // Keep the complete lock set, but never queue this group's reads behind its
    // own preparations. Unknown lane capacity conservatively permits one member.
    const width = storeLaneInflightLimit(params.store, options.priority) ?? 1;
    const replacements: AtomicAssetReplacement[] = [];
    let held = 0;
    for (let offset = 0; offset < assets.length; offset += width) {
      // Drain every started preparation before inspecting failures or releasing locks.
      const prepared = await Promise.allSettled(assets.slice(offset, offset + width).map(asset =>
        prepareGraphScopedReplacementUnderLock({ store: params.store, asset, options,
          assertCurrent, requireCurrentMetadata: params.requireCurrentMetadata,
          detectHeldCopy: params.unchanged !== undefined })));
      for (const result of prepared) {
        if (result.status === 'rejected') throw result.reason;
        if (!result.value) return params.stale();
        replacements.push(result.value.replacement);
        if (result.value.held) held += 1;
      }
    }
    assertCurrent();
    if (params.unchanged && held === replacements.length && !params.shouldQuarantineCommitted?.()) {
      return params.unchanged();
    }
    // Once dispatched, publication and any quarantine drain under every lock.
    const { signal: _signal, ...commitOptions } = options;
    await params.publish(replacements, commitOptions);
    if (params.shouldQuarantineCommitted?.()) {
      await params.quarantine(replacements.map(a => ({ ...a, graphQuads: [], metadataQuads: [] })), commitOptions);
      return 'quarantined';
    }
    return params.complete();
  };
  return params.lockAlreadyHeldByCaller ? apply()
    : withMaterializationLocks(assets, apply, { signal: options.signal });
}
