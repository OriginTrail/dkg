// SPDX-License-Identifier: Apache-2.0

/**
 * A store whose contents went back to an earlier state, as when a supervised
 * embedded engine's worker exits and its replacement reloads the last
 * snapshot. The process's state mirror, registry cache and registry records
 * may then describe writes the store no longer holds, a build or an
 * acknowledged dirty mark among them. Neither the mirror nor a stored row can
 * be trusted alone, so every read graph is taken out of service, and the
 * cached registries and records are forgotten. The builder then finds each
 * stored row apart from the mirror, marks it dirty from what is stored, and
 * rebuilds it; a read graph whose row the snapshot lacks is built again.
 *
 * A supervised backend tells of such a restart by its recovery generation
 * (`../store-recovery-generation.ts`), which the layer reads before each query
 * and write and the builder before each job.
 */

import { asStoreRecoveryGenerationReader, type StoreRecoveryGenerationReader } from '../store-recovery-generation.js';
import type { TripleStore } from '../triple-store.js';
import { RECORDED_REGISTRIES } from './recorded-registries.js';
import type { ReadGraphBackendRuntime } from './runtime.js';
import { nextReadGraphState } from './state.js';

const READERS = new WeakMap<ReadGraphBackendRuntime, StoreRecoveryGenerationReader>();
const SEEN = new WeakMap<ReadGraphBackendRuntime, number>();

/** Take every read graph of a runtime out of service, and forget its cached registries and records. */
export function invalidateReadGraphRuntime(runtime: ReadGraphBackendRuntime): void {
  for (const row of runtime.mirror.rows()) {
    if (row.state !== 'dirty') runtime.mirror.set(nextReadGraphState(row, { kind: 'mark-dirty' })!);
  }
  runtime.registries.clear();
  RECORDED_REGISTRIES.delete(runtime);
}

/**
 * Invalidate the runtime when `store`'s backend restarted since the runtime
 * last looked. The first look only notes the generation. A store without a
 * supervised backend never restarts this way.
 */
export function syncReadGraphRuntimeWithRecovery(store: TripleStore, runtime: ReadGraphBackendRuntime): void {
  // Only a reader that was found is kept: a backend may register its reader after the layer first looks.
  let read = READERS.get(runtime);
  if (read === undefined) {
    read = asStoreRecoveryGenerationReader(store);
    if (read !== undefined) READERS.set(runtime, read);
  }
  const generation = read?.()?.generation;
  if (generation === undefined) return;
  const seen = SEEN.get(runtime);
  SEEN.set(runtime, generation);
  if (seen !== undefined && seen !== generation) invalidateReadGraphRuntime(runtime);
}
