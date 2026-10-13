// SPDX-License-Identifier: Apache-2.0
import { withMaterializationLock } from '@origintrail-official/dkg-publisher';
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
    const replacements: AtomicAssetReplacement[] = [];
    for (const asset of assets) {
      const replacement = await prepareGraphScopedReplacementUnderLock({
        store: params.store, asset, options, assertCurrent, requireCurrentMetadata: params.requireCurrentMetadata,
      });
      if (!replacement) return params.stale();
      replacements.push(replacement);
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
  const ordered = [...assets].sort((a,b) => `${a.metaGraph}\0${a.ual}` < `${b.metaGraph}\0${b.ual}` ? -1 : 1);
  const lock = (index: number): Promise<T | 'quarantined'> => index < ordered.length
    ? withMaterializationLock(ordered[index]!.metaGraph, ordered[index]!.ual, () => lock(index + 1), { signal: options.signal })
    : apply();
  return params.lockAlreadyHeldByCaller ? apply() : lock(0);
}
