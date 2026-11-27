// SPDX-License-Identifier: Apache-2.0

import type { TripleStore } from '../triple-store.js';
import { readGraphRuntimeOf } from './read-graph-store.js';
import { invalidateReadGraphRuntime } from './recovery.js';

/**
 * Note that `store` was restored to an earlier state by a means its recovery
 * generation does not tell (`./recovery.ts`): every read graph goes out of
 * service and is rebuilt from what the store holds. A store without the
 * read-graph layer needs nothing.
 */
export function noteReadGraphStoreRestored(store: TripleStore): void {
  const runtime = readGraphRuntimeOf(store);
  if (runtime) invalidateReadGraphRuntime(runtime);
}
