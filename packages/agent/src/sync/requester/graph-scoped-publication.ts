// SPDX-License-Identifier: Apache-2.0
import { withMaterializationLocks } from '@origintrail-official/dkg-publisher';
import type { AtomicAssetReplacement, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import type { VerifiedGraphScopedAsset, GraphScopedMaterializationOutcome } from './graph-scoped-materialization.js';
import { prepareGraphScopedReplacementUnderLock } from './graph-scoped-replacement.js';

/** One physical publication lifetime for singleton and grouped recovery. */
export async function executeGraphScopedPublication<T extends GraphScopedMaterializationOutcome>(params: {
  store: TripleStore; assets: readonly VerifiedGraphScopedAsset[]; options: QueryOptions;
  assertCurrent(): void; shouldQuarantineCommitted?(): boolean;
  lockAlreadyHeldByCaller?: boolean; requireCurrentMetadata: boolean;
  stale(): T; complete(): T;
  publish(replacements: AtomicAssetReplacement[], options: QueryOptions): Promise<void>;
  quarantine(replacements: AtomicAssetReplacement[], options: QueryOptions): Promise<void>;
}): Promise<T | 'quarantined'> {
  const { assets, options, assertCurrent } = params;
  const apply = async (): Promise<T | 'quarantined'> => {
    assertCurrent();
    // At most eight members, under the complete ordered lock set. Drain every
    // preparation before inspecting results or releasing any member lock.
    const prepared = await Promise.allSettled(assets.map(asset =>
      prepareGraphScopedReplacementUnderLock({ store: params.store, asset, options,
        assertCurrent, requireCurrentMetadata: params.requireCurrentMetadata })));
    const replacements: AtomicAssetReplacement[] = [];
    for (const result of prepared) {
      if (result.status === 'rejected') throw result.reason;
      if (!result.value) return params.stale();
      replacements.push(result.value);
    }
    assertCurrent();
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
