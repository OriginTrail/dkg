// SPDX-License-Identifier: Apache-2.0

import { VM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { deleteByPatternWithoutCount, type TripleStore } from '@origintrail-official/dkg-storage';

/**
 * OT-RFC-43 A2 — idempotent per-layer pointer (re)stamp on the lifecycle URN.
 * Drop-then-set the single value for `pred`. Uses `deleteByPattern` + `insert`
 * (NOT a SPARQL UPDATE string) because the oxigraph storage adapter's
 * `query()` rejects DELETE/INSERT — `stampLayerPointerSparql` is reserved for
 * backends that accept UPDATE via query(). `merkleHex` is stored bare (no 0x).
 */
export async function stampLifecyclePointer(
  store: TripleStore, lifecycleUri: string, pred: string, merkleHex: string, metaGraph: string,
): Promise<void> {
  const bare = merkleHex.startsWith('0x') ? merkleHex.slice(2) : merkleHex;
  await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: pred, graph: metaGraph });
  await store.insert([{ subject: lifecycleUri, predicate: pred, object: JSON.stringify(bare), graph: metaGraph }]);
}

/**
 * RFC ka-metadata-trim Phase 2 — divergence-only wm/swm pointer stamp.
 * `dkg:vmCurrentAssertion` is always materialised; the wm/swm pointers are
 * only written when they DIVERGE from the current VM value (the common
 * "all three equal" steady state is implicit). When the new value equals
 * VM, any prior row for `pred` is deleted instead (drop-then-skip), so a
 * stale divergent pointer never lingers. Readers COALESCE a missing wm/swm
 * to the vm value (see `agent.assertion.history()`), which also keeps
 * old-store rows (always materialised) readable unchanged.
 */
export async function stampLifecyclePointerIfDivergedFromVm(
  store: TripleStore, lifecycleUri: string, pred: string, merkleHex: string, metaGraph: string,
): Promise<void> {
  const bare = merkleHex.startsWith('0x') ? merkleHex.slice(2) : merkleHex;
  let vmBare: string | undefined;
  try {
    const result = await store.query(
      `SELECT ?vm WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${VM_CURRENT_ASSERTION_PRED}> ?vm } } LIMIT 1`,
      { source: 'agent.publish.pointerVmGuard' },
    );
    const raw = result.type === 'bindings' ? result.bindings[0]?.['vm'] : undefined;
    vmBare = raw === undefined ? undefined : parseRdfLiteralTerm(raw)?.value;
  } catch {
    // On a failed VM read fall back to the always-write behaviour below —
    // an extra convergent row is harmless (readers COALESCE), a missing
    // divergent row is not.
  }
  if (vmBare !== undefined && vmBare === bare) {
    await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: pred, graph: metaGraph });
    return;
  }
  await stampLifecyclePointer(store, lifecycleUri, pred, bare, metaGraph);
}
