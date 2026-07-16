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
 *    LIMITATION (review): the quarantine is batch-local — if a VM graph's
 *    quads span multiple sync PAGES and an oversized quad arrives on a later
 *    page, earlier pages were already stored, leaving a partial VM graph. This
 *    is not a regression (pre-fix, earlier pages were stored too and the
 *    oversized page then looped forever), and a partial VM graph simply fails
 *    Merkle verification (reader-safe). Producer guards make oversized VM
 *    unpublishable going forward, so this only concerns legacy/foreign data;
 *    a persistent per-graph-version quarantine marker is a tracked follow-up.
 */

import {
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  JAVA_WRITE_UTF_MAX_BYTES,
  rdfLiteralTermMutf8ByteLength,
  isOversizedRdfLiteralError,
} from '@origintrail-official/dkg-core';
import {
  partitionConnectedBlankNodeComponents,
  type Quad,
} from '@origintrail-official/dkg-storage';

// Match `_shared_memory` / `_verifiable_memory` as a full path SEGMENT — the
// bucket graph (`…/_shared_memory`) and its per-KA descendants
// (`…/_shared_memory/{author}/{n}`), but NOT the sibling `…/_shared_memory_meta`
// graph. Review caught a `.includes('/_shared_memory')` bug that wrongly
// exempted the meta graph, which the blob store does NOT externalize — so
// oversized meta literals slipped past the guard. Meta graphs fall through to
// the normal per-quad drop (they never legitimately hold large literals).
const SHARED_MEMORY_SEGMENT_RE = /\/_shared_memory(\/|$)/;
const VERIFIABLE_MEMORY_SEGMENT_RE = /\/_verifiable_memory(\/|$)/;

export type OversizeDropKind =
  | 'oversize'
  | 'vm-quarantine'
  | 'store-reject'
  | 'blank-node-component-quarantine';

export interface OversizeDrop {
  quad: Quad;
  bytes: number;
  kind: OversizeDropKind;
}

export interface OversizeFilterResult {
  kept: Quad[];
  dropped: OversizeDrop[];
}

/**
 * Maximum estimated serialized size handed to one TripleStore.insert call by
 * sync ingest. This is intentionally adapter-neutral: it stays far below the
 * managed Oxigraph HTTP limit and also bounds the N-Quads/SPARQL string that
 * Blazegraph and generic SPARQL adapters materialize in JavaScript.
 */
export const SYNC_STORE_INSERT_BATCH_MAX_BYTES = 8 * 1024 * 1024;

const SYNC_STORE_INSERT_QUAD_SYNTAX_BYTES = 256;

/**
 * Conservative cross-adapter serialized-size estimate. Generic SPARQL and
 * Oxigraph use UTF-8; Blazegraph ASCII-escapes non-ASCII code points, so use
 * the larger representation for every term.
 */
export function estimateSyncStoreInsertQuadBytes(quad: Quad): number {
  let bytes = SYNC_STORE_INSERT_QUAD_SYNTAX_BYTES;
  for (const value of [quad.subject, quad.predicate, quad.object, quad.graph ?? '']) {
    let utf8Bytes = 0;
    let blazegraphAsciiBytes = 0;
    for (const char of value) {
      const codePoint = char.codePointAt(0)!;
      if (codePoint <= 0x7f) {
        utf8Bytes += 1;
        blazegraphAsciiBytes += 1;
      } else if (codePoint <= 0x7ff) {
        utf8Bytes += 2;
        blazegraphAsciiBytes += 6;
      } else if (codePoint <= 0xffff) {
        utf8Bytes += 3;
        blazegraphAsciiBytes += 6;
      } else {
        utf8Bytes += 4;
        // Blazegraph's ASCII-safe N-Quads form uses a UTF-16 surrogate pair.
        blazegraphAsciiBytes += 12;
      }
    }
    bytes += Math.max(utf8Bytes, blazegraphAsciiBytes);
  }
  return bytes;
}

interface SyncInsertUnit {
  quads: Quad[];
  estimatedBytes: number;
  blankNodeLabels: Set<string>;
}

/**
 * Turn a quad stream into indivisible insert units. Ground quads remain
 * independent, while quads connected through blank-node labels are grouped
 * transitively. Blank-node labels are scoped to one RDF load/update operation,
 * so splitting one component across insert calls changes the represented RDF
 * graph even when the same label text appears in both calls.
 */
function buildSyncInsertUnits(quads: readonly Quad[]): SyncInsertUnit[] {
  return partitionConnectedBlankNodeComponents(
    quads,
    (quad) => [quad.subject, quad.object, quad.graph],
  ).map((component) => ({
    quads: component.items,
    estimatedBytes: component.items.reduce(
      (total, quad) => total + estimateSyncStoreInsertQuadBytes(quad),
      0,
    ),
    blankNodeLabels: component.blankNodeLabels,
  }));
}

/**
 * Classify indivisible components before the first store mutation. A component
 * larger than the adapter-neutral insert bound cannot be split without changing
 * blank-node identity, so sync deliberately tombstones the complete component
 * and consumes the page instead of throwing before cursor advancement.
 */
interface SyncInsertUnitFilterResult extends OversizeFilterResult {
  keptUnits: SyncInsertUnit[];
}

function quarantineOversizedBlankNodeComponents(
  units: readonly SyncInsertUnit[],
): SyncInsertUnitFilterResult {
  const oversizedUnits = new Set<SyncInsertUnit>();
  const quarantinedVmGraphs = new Set<string>();
  for (const unit of units) {
    if (
      unit.blankNodeLabels.size === 0 ||
      unit.estimatedBytes <= SYNC_STORE_INSERT_BATCH_MAX_BYTES
    ) continue;
    oversizedUnits.add(unit);
    for (const quad of unit.quads) {
      if (isVerifiableMemoryGraph(quad.graph)) quarantinedVmGraphs.add(quad.graph!);
    }
  }

  const keptUnits: SyncInsertUnit[] = [];
  const dropped: OversizeDrop[] = [];
  for (const unit of units) {
    const touchesQuarantinedVmGraph = unit.quads.some(
      (quad) => quad.graph !== undefined && quarantinedVmGraphs.has(quad.graph),
    );
    if (oversizedUnits.has(unit) || touchesQuarantinedVmGraph) {
      for (const quad of unit.quads) {
        dropped.push({
          quad,
          bytes: estimateSyncStoreInsertQuadBytes(quad),
          kind: touchesQuarantinedVmGraph
            ? 'vm-quarantine'
            : 'blank-node-component-quarantine',
        });
      }
    } else {
      keptUnits.push(unit);
    }
  }
  return {
    keptUnits,
    kept: keptUnits.flatMap((unit) => unit.quads),
    dropped,
  };
}

async function insertInBoundedBatches(
  insert: (quads: Quad[]) => Promise<void>,
  units: readonly SyncInsertUnit[],
): Promise<void> {
  let batch: Quad[] = [];
  let batchBytes = 0;
  for (const unit of units) {
    if (
      batch.length > 0 &&
      batchBytes + unit.estimatedBytes > SYNC_STORE_INSERT_BATCH_MAX_BYTES
    ) {
      await insert(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(...unit.quads);
    batchBytes += unit.estimatedBytes;
  }
  if (batch.length > 0) await insert(batch);
}

function isSharedMemoryGraph(graph: string | undefined): boolean {
  return !!graph && SHARED_MEMORY_SEGMENT_RE.test(graph);
}

function isVerifiableMemoryGraph(graph: string | undefined): boolean {
  return !!graph && VERIFIABLE_MEMORY_SEGMENT_RE.test(graph);
}

/**
 * Literal MUTF-8 size of a quad object term, or `undefined` when the term is
 * not a literal (IRIs / blank nodes always pass).
 *
 * NOTE: every literal is measured — including `externalLiteralRef` placeholder
 * terms. A real ref is ~100 bytes so it passes anyway; the earlier
 * datatype-suffix exemption was a peer-exploitable bypass (a hostile peer could
 * attach the ref datatype to a 70KB value and evade both the pre-filter and the
 * backstop, re-arming the retry loop — review finding).
 */
function literalBytes(object: string): number | undefined {
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
 * Inserts are split into bounded byte-estimated batches. RDF inserts are
 * idempotent, so a later batch failure remains safe to retry from the phase
 * checkpoint; successful earlier batches do not duplicate graph state. The
 * batching also releases shared store admission between chunks so reserved
 * ACK/health work can proceed during a large catch-up.
 *
 * Returns the quads actually handed to the store (post-filter) — callers use it
 * for cache-invalidation / meta-dirty marking. (The runners' inserted-count
 * SUMMARY metric still keys off pre-filter length, so it can slightly over-count
 * on an all-oversize page; that is log-only, with no convergence/cursor/backoff
 * effect — review-confirmed cosmetic, tracked separately.)
 */
export async function insertWithOversizeGuard(
  insert: (quads: Quad[]) => Promise<void>,
  quads: readonly Quad[],
  hooks: OversizeGuardHooks,
  seam: string,
): Promise<Quad[]> {
  const literalFilter = filterOversizedSyncQuads(quads);
  if (literalFilter.dropped.length > 0) hooks.recordDrops(literalFilter.dropped, seam);
  const componentFilter = quarantineOversizedBlankNodeComponents(
    buildSyncInsertUnits(literalFilter.kept),
  );
  if (componentFilter.dropped.length > 0) {
    hooks.recordDrops(componentFilter.dropped, `${seam}:blank-node-component-quarantine`);
  }
  if (componentFilter.kept.length === 0) return componentFilter.kept;
  try {
    await insertInBoundedBatches(insert, componentFilter.keptUnits);
    return componentFilter.kept;
  } catch (err) {
    if (!isOversizedRdfLiteralError(err)) throw err;
    const backstop = splitStoreRejectedQuads(componentFilter.kept);
    if (backstop.dropped.length === 0) throw err; // not size-explicable → real error
    hooks.recordDrops(backstop.dropped, `${seam}:store-reject`);
    if (backstop.kept.length === 0) return [];
    // Second oversize throw here propagates — no loop, loud failure.
    await insertInBoundedBatches(insert, buildSyncInsertUnits(backstop.kept));
    return backstop.kept;
  }
}
