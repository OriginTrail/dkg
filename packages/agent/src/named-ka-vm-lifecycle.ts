// SPDX-License-Identifier: Apache-2.0

import { deleteByPatternWithoutCount, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  buildNamedKaVmLifecycleMutation,
  namedKaVmLifecycleExecutor,
  type PublishedNamedKaVmLifecycleInput,
} from './internal/named-ka-vm-lifecycle-mutation.js';

export type { PublishedNamedKaVmLifecycleInput } from './internal/named-ka-vm-lifecycle-mutation.js';

/** Canonical idempotent writer used by both normal publish and tx recovery. */
export async function applyPublishedNamedKaVmLifecycle(
  store: TripleStore,
  input: PublishedNamedKaVmLifecycleInput,
): Promise<void> {
  const execute = namedKaVmLifecycleExecutor(store);
  if (execute && await execute(input)) return;

  // Raw/unknown wrappers and unsupported updates retain the ordered compatibility path.
  // Build first to validate every term, including optional pointers, before any mutation.
  const { replacements } = buildNamedKaVmLifecycleMutation(input);
  for (const quad of replacements) {
    await deleteByPatternWithoutCount(store, {
      subject: quad.subject, predicate: quad.predicate, graph: quad.graph,
    });
    await store.insert([quad]);
  }
}
