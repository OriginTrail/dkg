/**
 * Sync-ingest oversize-literal guard (OT-RFC-56 §4.1/§4.2 — the 2026-07-08
 * mainnet poison-literal incident).
 *
 * The protocol invariant: no replicated RDF literal may exceed
 * `DKG_RDF_LITERAL_SAFE_MUTF8_BYTES` (60,000 Java-MUTF-8 bytes). Blazegraph
 * physically cannot store literals above `JAVA_WRITE_UTF_MAX_BYTES` (65,535):
 * its adapter throws `OversizedRdfLiteralError` on insert. Before this guard,
 * a synced page containing one such literal threw inside the per-CG sync
 * loop BEFORE the offset checkpoint advanced, so the identical page was
 * re-fetched from every peer forever — the observed retry storm. Oxigraph
 * has no such limit, so oxigraph-backed nodes stored and re-served the same
 * quads — a permanent split-brain.
 *
 * The fix is FILTER-BEFORE-INSERT at the sync storeInsert seams: conforming
 * quads store normally, oversized quads are dropped and tombstoned, and —
 * because sync completeness is an offset page-cursor, not quad-set
 * reconciliation — the phase then completes normally and the cursor advances
 * past the page. A deliberate refusal terminates the conversation instead of
 * looping.
 *
 * Graph-class semantics (why not one uniform drop):
 *  - `_shared_memory` graphs are EXEMPT from the pre-filter: large SWM
 *    literals are legitimate there — `SharedMemoryLiteralBlobStore` (default
 *    on local Oxigraph stores) externalizes literal terms above 65,536 bytes
 *    into content-addressed blobs on insert and re-hydrates them on query, so
 *    the wire legitimately carries raw large SWM text between blob-capable
 *    nodes. On a Blazegraph node (no blob wrapper) such an insert still
 *    throws; the guard's BACKSTOP (below) converts that throw into
 *    tombstone-and-continue instead of a loop. Serving refs instead of
 *    hydrated text network-wide is the durable fix — tracked in OT-RFC-56.
 *  - `_verifiable_memory` graphs must never be PARTIALLY stored (their
 *    content is Merkle-committed; a missing quad breaks proof verification),
 *    so an oversized quad there drops that graph's ENTIRE batch contribution
 *    (quarantine, RFC-56 §4.3) rather than the single quad.
 *  - `externalLiteralRef`-typed terms always pass (they are ~100-byte
 *    placeholders by construction).
 */

import {
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  JAVA_WRITE_UTF_MAX_BYTES,
  rdfLiteralTermMutf8ByteLength,
  isOversizedRdfLiteralError,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { EXTERNAL_LITERAL_REF_DATATYPE } from '@origintrail-official/dkg-storage';

const SHARED_MEMORY_INFIX = '/_shared_memory';
const VERIFIABLE_MEMORY_INFIX = '/_verifiable_memory';

export type OversizeDropKind = 'oversize' | 'vm-quarantine' | 'store-reject';

export interface OversizeDrop {
  quad: Quad;
  bytes: number;
  kind: OversizeDropKind;
}

export interface OversizeFilterResult {
  kept: Quad[];
  dropped: OversizeDrop[];
}

function isSharedMemoryGraph(graph: string | undefined): boolean {
  return !!graph && graph.includes(SHARED_MEMORY_INFIX);
}

function isVerifiableMemoryGraph(graph: string | undefined): boolean {
  return !!graph && graph.includes(VERIFIABLE_MEMORY_INFIX);
}

function isExternalLiteralRefTerm(object: string): boolean {
  return object.endsWith(`^^<${EXTERNAL_LITERAL_REF_DATATYPE}>`);
}

/**
 * Literal MUTF-8 size of a quad object term, or `undefined` when the term is
 * not a literal (IRIs/blank nodes always pass) or is an external-literal ref.
 */
function literalBytes(object: string): number | undefined {
  if (isExternalLiteralRefTerm(object)) return undefined;
  return rdfLiteralTermMutf8ByteLength(object);
}

/**
 * Pre-insert filter at the PROTOCOL limit (60,000). Pure. `_shared_memory`
 * graphs pass through untouched (see module doc); `_verifiable_memory`
 * graphs are all-or-nothing per graph.
 */
export function filterOversizedSyncQuads(quads: readonly Quad[]): OversizeFilterResult {
  const dropped: OversizeDrop[] = [];
  // First pass: find VM graphs with at least one oversized quad — those
  // graphs' entire batch contribution is quarantined (never partial-store a
  // Merkle-committed graph).
  const quarantinedVmGraphs = new Set<string>();
  for (const q of quads) {
    if (!isVerifiableMemoryGraph(q.graph)) continue;
    const bytes = literalBytes(q.object);
    if (bytes !== undefined && bytes > DKG_RDF_LITERAL_SAFE_MUTF8_BYTES) {
      quarantinedVmGraphs.add(q.graph!);
    }
  }

  const kept: Quad[] = [];
  for (const q of quads) {
    if (q.graph && quarantinedVmGraphs.has(q.graph)) {
      dropped.push({ quad: q, bytes: literalBytes(q.object) ?? 0, kind: 'vm-quarantine' });
      continue;
    }
    if (isSharedMemoryGraph(q.graph) || isVerifiableMemoryGraph(q.graph)) {
      kept.push(q); // exempt from the per-quad pre-filter (see module doc)
      continue;
    }
    const bytes = literalBytes(q.object);
    if (bytes !== undefined && bytes > DKG_RDF_LITERAL_SAFE_MUTF8_BYTES) {
      dropped.push({ quad: q, bytes, kind: 'oversize' });
      continue;
    }
    kept.push(q);
  }
  return { kept, dropped };
}

/**
 * BACKSTOP split at the STORE hard limit (65,535), applied only after a
 * store insert has already thrown `OversizedRdfLiteralError` — i.e. for
 * exempted graphs on a non-blob-capable store (Blazegraph), or any seam the
 * pre-filter missed. VM graphs keep all-or-nothing semantics here too.
 */
export function splitStoreRejectedQuads(quads: readonly Quad[]): OversizeFilterResult {
  const quarantinedVmGraphs = new Set<string>();
  for (const q of quads) {
    if (!isVerifiableMemoryGraph(q.graph)) continue;
    const bytes = literalBytes(q.object);
    if (bytes !== undefined && bytes > JAVA_WRITE_UTF_MAX_BYTES) {
      quarantinedVmGraphs.add(q.graph!);
    }
  }
  const kept: Quad[] = [];
  const dropped: OversizeDrop[] = [];
  for (const q of quads) {
    if (q.graph && quarantinedVmGraphs.has(q.graph)) {
      dropped.push({ quad: q, bytes: literalBytes(q.object) ?? 0, kind: 'vm-quarantine' });
      continue;
    }
    const bytes = literalBytes(q.object);
    if (bytes !== undefined && bytes > JAVA_WRITE_UTF_MAX_BYTES) {
      dropped.push({ quad: q, bytes, kind: 'store-reject' });
      continue;
    }
    kept.push(q);
  }
  return { kept, dropped };
}

export interface OversizeGuardHooks {
  /** Persist/record the dropped quads (tombstones). Must not throw. */
  recordDrops: (drops: OversizeDrop[], seam: string) => void;
}

/**
 * Wrap a sync-ingest insert with the oversize guard: pre-filter at the
 * protocol limit, insert the conforming quads, and — if the store STILL
 * rejects with `OversizedRdfLiteralError` (exempted graphs on Blazegraph, or
 * a missed edge) — split at the store hard limit, tombstone the offenders,
 * and retry ONCE with the remainder. Any other error, or a second oversize
 * rejection, propagates unchanged: this guard converts exactly one failure
 * class (permanent, size-based refusals) into converge-minus-poison; it must
 * never mask transient store failures.
 *
 * Returns the quads actually handed to the store (post-filter), so callers
 * keep accurate inserted-count accounting.
 */
export async function insertWithOversizeGuard(
  insert: (quads: Quad[]) => Promise<void>,
  quads: readonly Quad[],
  hooks: OversizeGuardHooks,
  seam: string,
): Promise<Quad[]> {
  const { kept, dropped } = filterOversizedSyncQuads(quads);
  if (dropped.length > 0) hooks.recordDrops(dropped, seam);
  if (kept.length === 0) return kept;
  try {
    await insert(kept);
    return kept;
  } catch (err) {
    if (!isOversizedRdfLiteralError(err)) throw err;
    const backstop = splitStoreRejectedQuads(kept);
    if (backstop.dropped.length === 0) throw err; // not size-explicable → real error
    hooks.recordDrops(backstop.dropped, `${seam}:store-reject`);
    if (backstop.kept.length === 0) return [];
    await insert(backstop.kept); // second oversize throw here propagates — no loop, loud failure
    return backstop.kept;
  }
}
