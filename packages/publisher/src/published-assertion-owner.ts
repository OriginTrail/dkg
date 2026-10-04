// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { SHARE_OPERATION_ID_PRED } from './metadata.js';

/** Publication owns the captured lifecycle operation, including explicit legacy absence. */
export async function isPublishedAssertionOwner(
  store: TripleStore, graph: string, lifecycle: string, expected: string | null,
): Promise<boolean> {
  const result = await store.query(`SELECT ?operation WHERE { GRAPH <${assertSafeIri(graph)}> {
    <${assertSafeIri(lifecycle)}> <${SHARE_OPERATION_ID_PRED}> ?operation
  } } LIMIT 2`);
  if (result.type !== 'bindings' || result.bindings.length > 1) return false;
  if (result.bindings.length === 0) return expected === null;
  try {
    const value: unknown = JSON.parse(result.bindings[0]!['operation']!);
    return typeof value === 'string' && value.length > 0 && value === expected;
  } catch { return false; }
}
