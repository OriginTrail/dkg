// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, parseReadGraphIri, readGraphStateGraphIri } from '@origintrail-official/dkg-core';
import { isReadGraphStateGraph } from './graph-enumeration-visibility.js';
import { mayHoldReadGraphPartitions, noteReadGraphPartitions } from './read-graph-partition-marker.js';
import { noteStoreMayHoldReadGraphPartitions, readGraphPartitionMaintenanceStore } from './read-graph-partition-store.js';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  MAX_READ_GRAPH_GENERATION,
  READ_GRAPH_STATE_PREDICATES,
  newReadGraphGeneration,
  parseReadGraphStateRows,
  readGraphStateCompareAndSet,
  readGraphStateRowsQuery,
  type ReadGraphStateRow,
} from './read-graph/state.js';
import type { UpdateOptions, TripleStore } from './triple-store.js';

/** Rows per mark operation: on Blazegraph one operation costs about as much for one row as for a thousand. */
const ROWS_PER_OPERATION = 1_000;
/** Operations per request when damaged rows are created again; one row's operations are never split. */
const OPERATIONS_PER_REQUEST = 256;

type StateBinding = Readonly<Record<string, string | undefined>>;

/**
 * This release recognizes read graphs but does not maintain them, so at start
 * it marks every read graph it finds dirty: none stays `ready` across writes
 * that nothing maintained. One lookup on the state predicate finds the rows.
 * Only rows in a context graph's own state graph count: a graph whose IRI only
 * ends like one is ordinary data and stays as it is. When there are rows, it
 * notes in `dataDir` that the store holds read-graph partitions, for the
 * rollback, and, below the partition guard, moves each row that is not dirty
 * to dirty with the next generation, one operation per thousand rows that
 * names each row's state graph and read graph. A damaged row of a read graph
 * is removed from the state graphs that hold it and created again, dirty. Rows found, or a note left by an interrupted drop, also mark the
 * store for this process as one that may hold partitions. Returns how many
 * read graphs were marked, and reports a non-zero count through `log`.
 */
export async function markReadGraphsDirtyAtStart(
  store: TripleStore,
  options: { readonly dataDir?: string; readonly signal?: AbortSignal; readonly log?: (message: string) => void } = {},
): Promise<number> {
  const target = readGraphPartitionMaintenanceStore(store);
  const storeOptions: UpdateOptions = { signal: options.signal, priority: 'background', source: 'storage.readGraphStartup' };
  const result = await target.query(readGraphStateRowsQuery(), storeOptions);
  if (result.type !== 'bindings') throw new Error('Read-graph start-up expected state-row bindings');
  const bindings = result.bindings.filter(binding => binding.stateGraph !== undefined && isReadGraphStateGraph(binding.stateGraph));
  const found = bindings.length > 0;
  if (found && options.dataDir !== undefined) noteReadGraphPartitions(options.dataDir);
  if (found || (options.dataDir !== undefined && mayHoldReadGraphPartitions(options.dataDir))) {
    noteStoreMayHoldReadGraphPartitions(target);
  }
  if (!found) return 0;
  const { rows, damaged } = parseReadGraphStateRows(bindings);
  const notDirty = rows.filter(row => row.state !== 'dirty');
  const advancing = notDirty.filter(row => row.generation < MAX_READ_GRAPH_GENERATION);
  // A damaged row, or one whose generation cannot grow, is created again.
  const recreated = [...damaged, ...notDirty.filter(row => row.generation >= MAX_READ_GRAPH_GENERATION).map(row => row.readGraph)]
    .filter(readGraph => parseReadGraphIri(readGraph) !== undefined);
  const requests: string[] = [];
  for (let at = 0; at < advancing.length; at += ROWS_PER_OPERATION) {
    requests.push(markDirty(advancing.slice(at, at + ROWS_PER_OPERATION)));
  }
  let batch: string[] = [];
  for (const operations of recreated.map(readGraph => recreateDirty(readGraph, bindings))) {
    if (batch.length > 0 && batch.length + operations.length > OPERATIONS_PER_REQUEST) {
      requests.push(batch.join(';\n'));
      batch = [];
    }
    batch.push(...operations);
  }
  if (batch.length > 0) requests.push(batch.join(';\n'));
  const marked = advancing.length + recreated.length;
  if (marked === 0) return 0;
  if (!target.update) throw new Error('This store cannot mark its read graphs dirty: it has no update()');
  for (const request of requests) await target.update(request, storeOptions);
  options.log?.(`Marked ${marked} read graph(s) dirty: this release does not maintain read graphs`);
  return marked;
}

/** One operation that moves each row, unless it is dirty, to dirty with the next generation, in its own state graph. */
function markDirty(rows: readonly ReadGraphStateRow[]): string {
  const p = READ_GRAPH_STATE_PREDICATES;
  const pairs = rows.map(({ readGraph }) => {
    const stateGraph = readGraphStateGraphIri(parseReadGraphIri(readGraph)!.scope.contextGraphId);
    return `(<${assertSafeIri(stateGraph)}> <${assertSafeIri(readGraph)}>)`;
  }).join(' ');
  // sparql-scan-allow: R2 -- ?stateGraph and ?readGraph are VALUES-bound to at most 1,000 exact pairs found at start
  return `DELETE { GRAPH ?stateGraph { ?readGraph <${p.state}> ?state . ?readGraph <${p.generation}> ?generation } }\n`
    + `INSERT { GRAPH ?stateGraph { ?readGraph <${p.state}> "dirty" . ?readGraph <${p.generation}> ?nextGeneration } }\n`
    + `WHERE {\n  VALUES (?stateGraph ?readGraph) { ${pairs} }\n`
    + `  GRAPH ?stateGraph { ?readGraph <${p.state}> ?state . ?readGraph <${p.generation}> ?generation }\n`
    + `  FILTER(!sameTerm(?state, "dirty"))\n  BIND(?generation + 1 AS ?nextGeneration)\n}`;
}

/** Remove a read graph's row from the state graphs that hold it, then create it, dirty, in its own. */
function recreateDirty(readGraph: string, bindings: readonly StateBinding[]): string[] {
  const subject = assertSafeIri(readGraph);
  const predicates = Object.values(READ_GRAPH_STATE_PREDICATES).map(predicate => `<${predicate}>`).join(' ');
  const holding = new Set(bindings.filter(binding => binding.readGraph === readGraph).map(binding => binding.stateGraph!));
  const removals = [...holding].map(stateGraph => `DELETE { GRAPH <${assertSafeIri(stateGraph)}> { <${subject}> ?field ?value } }\n`
    + `WHERE { VALUES ?field { ${predicates} } GRAPH <${stateGraph}> { <${subject}> ?field ?value } }`);
  return [...removals, readGraphStateCompareAndSet(undefined, {
    readGraph,
    state: 'dirty',
    generation: newReadGraphGeneration(),
    ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion,
    builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion,
  })];
}
