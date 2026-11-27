/**
 * One-shot boot sweep of resident oversized literals (OT-RFC-56 §4.4).
 *
 * The ingest guard (oversize-filter.ts) stops NEW poison from entering via
 * sync — but data already resident from before the guard stays in the local
 * store and keeps being served to peers. In a decentralized network there is
 * no fleet delete: the only remediation channel we control is the release
 * itself, so each upgraded node self-cleans at boot. Once ingest everywhere
 * refuses re-entry, a local delete finally STICKS.
 *
 * Semantics (mirror the ingest filter's graph classes):
 *  - Only mutable graphs are swept. `_verifiable_memory` graphs are never
 *    touched (Merkle-committed — a partial delete breaks proof verification),
 *    and `_shared_memory` graphs are exempt (large SWM literals are
 *    legitimate there via the blob-store rehydration flow).
 *  - Candidates are over-selected with a cheap SPARQL `STRLEN` filter
 *    (chars ≤ MUTF-8 bytes ≤ 3×chars, so every >60,000-byte term has
 *    >19,000 chars — the filter can miss nothing), then each candidate is
 *    verified EXACTLY with the protocol's MUTF-8 byte measure before
 *    deletion. Deletes are precise full-quad `deleteByPattern` calls —
 *    offenders are rare by construction, so per-quad deletion cost is moot.
 *  - Gated by a marker file (`<dataDir>/.oversize-sweep-v1.done`), written
 *    only after a fully successful sweep: a failed/partial sweep logs and
 *    retries on the next boot. No dataDir ⇒ in-memory store ⇒ nothing
 *    resident to sweep ⇒ skip.
 *
 * On Blazegraph-backed nodes the sweep finds nothing (the adapter never
 * accepted oversized literals) and just writes the marker — a cheap no-op.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  rdfLiteralTermMutf8ByteLength,
} from '@origintrail-official/dkg-core';
import {
  deleteByPatternWithoutCount,
  type Quad,
} from '@origintrail-official/dkg-storage';
import type { OversizeDrop } from './oversize-filter.js';

const SWEEP_MARKER = '.oversize-sweep-v1.done';
// Match `_shared_memory` / `_verifiable_memory` as a full path SEGMENT — same
// predicate as the ingest filter. The bucket + per-KA descendants are exempt
// (SWM: legit blob-externalized large literals; VM: never partial-delete a
// Merkle graph), but the sibling `…/_shared_memory_meta` is NOT exempt and IS
// swept — it can hold resident poison and is not externalized.
const SHARED_MEMORY_SEGMENT_RE = /\/_shared_memory(\/|$)/;
const VERIFIABLE_MEMORY_SEGMENT_RE = /\/_verifiable_memory(\/|$)/;
// Over-select threshold in SPARQL CHARACTERS (STRLEN counts code points). Java
// MUTF-8 is up to 6 bytes per code point (astral chars = surrogate pair, 3+3),
// so a >60,000-BYTE literal has > 60,000/6 = 10,000 code points. 9,000 is a
// safe floor that cannot miss an over-limit literal even when it is entirely
// astral (emoji / CJK-Ext-B / math alphanumerics — review finding); the exact
// MUTF-8 byte check in JS re-verifies each candidate, so a lower threshold only
// costs a few extra verifications, never a missed offender.
const STRLEN_OVERSELECT_CHARS = 9_000;

export interface OversizeSweepStore {
  listGraphs(): Promise<string[]>;
  query(sparql: string): Promise<{ type: string; quads?: Quad[] }>;
  deleteByPattern(pattern: Partial<Quad>): Promise<number>;
}

export interface OversizeSweepOptions {
  store: OversizeSweepStore;
  /** Marker-file directory. Absent ⇒ in-memory store ⇒ skip. */
  dataDir?: string;
  recordDrops: (drops: OversizeDrop[], seam: string) => void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
}

export interface OversizeSweepResult {
  ran: boolean;
  scannedGraphs: number;
  sweptQuads: number;
}

function isExemptGraph(graph: string): boolean {
  return SHARED_MEMORY_SEGMENT_RE.test(graph) || VERIFIABLE_MEMORY_SEGMENT_RE.test(graph);
}

/**
 * Run the sweep if the marker allows it. Never throws: a sweep failure must
 * not brick the boot — it logs, leaves the marker unwritten, and retries on
 * the next start.
 */
export async function runOversizeSweep(options: OversizeSweepOptions): Promise<OversizeSweepResult> {
  const { store, dataDir, recordDrops, logInfo, logWarn } = options;
  const skipped: OversizeSweepResult = { ran: false, scannedGraphs: 0, sweptQuads: 0 };
  if (!dataDir) return skipped;
  const markerPath = join(dataDir, SWEEP_MARKER);
  try {
    if (existsSync(markerPath)) return skipped;
  } catch {
    return skipped;
  }

  let scannedGraphs = 0;
  let sweptQuads = 0;
  try {
    const graphs = (await store.listGraphs()).filter((g) => !isExemptGraph(g));
    const startedAt = Date.now();
    for (const graph of graphs) {
      scannedGraphs += 1;
      // Over-select candidates cheaply in the store, verify exactly below.
      const result = await store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } ` +
        `FILTER(isLiteral(?o) && STRLEN(STR(?o)) > ${STRLEN_OVERSELECT_CHARS}) }`,
      );
      const candidates = result.type === 'quads' && result.quads ? result.quads : [];
      const offenders: OversizeDrop[] = [];
      for (const q of candidates) {
        const bytes = rdfLiteralTermMutf8ByteLength(q.object);
        if (bytes !== undefined && bytes > DKG_RDF_LITERAL_SAFE_MUTF8_BYTES) {
          offenders.push({ quad: { ...q, graph }, bytes, kind: 'oversize' });
        }
      }
      for (const offender of offenders) {
        await deleteByPatternWithoutCount(store, {
          graph,
          subject: offender.quad.subject,
          predicate: offender.quad.predicate,
          object: offender.quad.object,
        });
        sweptQuads += 1;
      }
      if (offenders.length > 0) {
        recordDrops(offenders, 'sweep');
        logWarn(
          `oversize sweep: removed ${offenders.length} resident oversized literal(s) from ${graph} ` +
          `(largest ${Math.max(...offenders.map((o) => o.bytes))} bytes). ` +
          `Ingest now refuses re-entry; see docs/use-dkg/large-content.md.`,
        );
      }
    }
    await writeFile(markerPath, `${new Date().toISOString()} scanned=${scannedGraphs} swept=${sweptQuads}\n`, 'utf8');
    logInfo(
      `oversize sweep complete: ${scannedGraphs} graph(s) scanned, ${sweptQuads} quad(s) removed ` +
      `in ${Date.now() - startedAt}ms (marker ${SWEEP_MARKER} written)`,
    );
    return { ran: true, scannedGraphs, sweptQuads };
  } catch (err) {
    // No marker on failure — the sweep retries next boot.
    logWarn(
      `oversize sweep failed after ${scannedGraphs} graph(s) / ${sweptQuads} removal(s) — ` +
      `will retry next boot: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ran: true, scannedGraphs, sweptQuads };
  }
}
