import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { SyncRow } from './snapshot-cache.js';
import { compareRows } from './row-serialization.js';

interface SnapshotEntry { readonly graph: string; readonly rowCount: number }

/** Bound bulk work by both graph count and the already-admitted row counts. */
export function exactGraphSnapshotBatchWidth(
  store: TripleStore,
  entries: readonly SnapshotEntry[],
  start: number,
  remainingRows: number,
  pagedGraphs: ReadonlySet<string>,
): number {
  const pressure = store.getPressureSnapshot?.();
  const urgent = pressure && (pressure.ackQueued > 0 || (pressure.healthQueued ?? 0) > 0
    || pressure.normalQueued > 0 || pressure.normalInflight > 0
    || pressure.ackInflight > 0 || (pressure.healthInflight ?? 0) > 0);
  const busy = pressure && (pressure.backgroundQueued > 0 || pressure.backgroundInflight > 0);
  const graphLimit = urgent ? 8 : !pressure || busy ? 32 : 64;
  const rowLimit = Math.min(2048, remainingRows);
  let rows = 0;
  let width = 0;
  for (let i = start; i < entries.length && width < graphLimit; i += 1) {
    const entry = entries[i]!;
    if (pagedGraphs.has(entry.graph) || rows + entry.rowCount > rowLimit) break;
    rows += entry.rowCount;
    width += 1;
  }
  // A large or previously paged graph keeps its existing single-graph path.
  return Math.max(1, width);
}

/** Read admitted graphs in entry order, with sorted rows and independent count checks. */
export async function readExactGraphSnapshotBatch(
  store: TripleStore,
  entries: readonly SnapshotEntry[],
  maxResponseBytes: number,
): Promise<SyncRow[]> {
  const expected = new Map(entries.map(entry => [entry.graph, entry.rowCount]));
  const total = entries.reduce((sum, entry) => sum + entry.rowCount, 0);
  if (entries.length === 0 || entries.length > 64 || expected.size !== entries.length
    || entries.some(entry => !Number.isSafeInteger(entry.rowCount) || entry.rowCount <= 0)
    || total > 2048) {
    throw new Error('Invalid bounded exact-graph snapshot batch');
  }
  const values = entries.map(entry => `<${assertSafeIri(entry.graph)}>`).join(' ');
  // sparql-scan-allow: R2 -- at most 64 admitted exact graph IRIs, 2048 planned rows plus a sentinel
  const result = await store.query(`
    SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${values} }
      GRAPH ?g { ?s ?p ?o }
    }
    LIMIT ${total + 1}
  `, {
    priority: 'background', source: 'sync.responder.readExactGraphSnapshotBatch', maxResponseBytes,
  });
  if (result.type !== 'bindings') throw new Error('Sync exact-graph snapshot returned non-binding rows');
  const byGraph = new Map<string, SyncRow[]>();
  for (const row of result.bindings) {
    const { g, s, p, o } = row;
    if (!expected.has(g!) || !s || !p || !o) {
      throw new Error('Sync exact-graph snapshot returned an unadmitted graph or malformed row');
    }
    const graphRows = byGraph.get(g!) ?? [];
    if (graphRows.length + 1 > expected.get(g!)!) {
      throw new Error(`Sync exact-graph plan changed while reading ${g}: surplus rows`);
    }
    graphRows.push({ g: g!, s, p, o });
    byGraph.set(g!, graphRows);
  }
  const rows: SyncRow[] = [];
  for (const entry of entries) {
    const graphRows = byGraph.get(entry.graph) ?? [];
    const count = graphRows.length;
    if (count !== entry.rowCount) {
      throw new Error(`Sync exact-graph plan changed while reading ${entry.graph}: expected ${entry.rowCount} rows, found ${count}`);
    }
    // Sort bounded graph runs here, before the next awaited store request.
    // Sorting a whole unordered snapshot at the end blocks interactive reads.
    graphRows.sort(compareRows);
    rows.push(...graphRows);
  }
  return rows;
}
