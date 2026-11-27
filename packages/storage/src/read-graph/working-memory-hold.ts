// SPDX-License-Identifier: Apache-2.0

/**
 * Working-memory read graphs held from building. When the node changes its
 * working-memory identity but cannot remove the record of the identity before
 * (`./working-memory-identity.ts`), that record could make a later start keep
 * read graphs built under the new identity. So until a later installation
 * removes it, no working-memory read graph of the backend is built or
 * repaired: a later start finds only read graphs built under the recorded
 * identity, or dirty ones.
 */

import { MemoryLayer, type ReadGraphKey } from '@origintrail-official/dkg-core';
import type { ReadGraphBackendRuntime } from './runtime.js';

const HELD = new WeakSet<ReadGraphBackendRuntime>();

/** Hold the working-memory read graphs of a backend, or release them. */
export function holdWorkingMemoryReadGraphs(runtime: ReadGraphBackendRuntime, held: boolean): void {
  if (held) HELD.add(runtime);
  else HELD.delete(runtime);
}

/** Whether the working-memory read graphs of a backend are held. */
export function workingMemoryReadGraphsHeld(runtime: ReadGraphBackendRuntime): boolean {
  return HELD.has(runtime);
}

/** Whether the read graph of `key` may not be built or repaired now. */
export function isHeldReadGraph(runtime: ReadGraphBackendRuntime, key: ReadGraphKey): boolean {
  return key.layer === MemoryLayer.WorkingMemory && HELD.has(runtime);
}
