// SPDX-License-Identifier: Apache-2.0

/**
 * The start-up of a release that maintains read graphs: once per process,
 * after the store is built and before anything writes.
 *
 * It reads every row once. The read graphs the process maintains (their mode
 * is `build` or `serve`, and the adapter declares every method the layer
 * plans) keep a `ready` row built under versions this release accepts, whose
 * membership the registry recorded for its context graph still gives
 * (`./registry-record.ts`): the layer maintained every write since it was
 * published, no registry change went unmarked, and no dirty mark of it
 * stayed unstored (`./mark-journal.ts`); without a data directory, where no
 * journal can keep such a mark, none stays ready. Every other row of
 * theirs gets a new generation and the state `dirty`, whatever its state, so
 * nothing an earlier process left in flight passes a fence; a damaged row, or
 * one whose generation cannot grow, is replaced by a dirty row at a new random
 * generation. A working-memory read graph is marked dirty as well, because the
 * identity rule it was built under is not recorded. The rows it does not
 * maintain take the rule of a release that does not maintain read graphs:
 * dirty, unless they already are.
 *
 * It then reads the rows back, makes the backend's mirror hold exactly the
 * maintained ones, reads the registry of each context graph that has one, so
 * the layer maintains every write from the first, and records that registry.
 * Without anything to
 * maintain it is the start-up of a release that does not maintain read graphs
 * (`markReadGraphsDirtyAtStart`), after a look for registry records that
 * outlived their state rows.
 */

import { MemoryLayer, parseReadGraphIri, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { isReadGraphStateGraph } from '../graph-enumeration-visibility.js';
import { mayHoldReadGraphPartitions, noteReadGraphPartitions } from '../read-graph-partition-marker.js';
import { markReadGraphsDirtyAtStart } from '../read-graph-partition-startup.js';
import { noteStoreMayHoldReadGraphPartitions, readGraphPartitionMaintenanceStore } from '../read-graph-partition-store.js';
import type { QueryOptions, TripleStore } from '../triple-store.js';
import { missingReadGraphMethods } from './adapter-contract.js';
import { clearUnstoredReadGraphMarks, readUnstoredReadGraphMarks, useReadGraphMarkJournal } from './mark-journal.js';
import { syncReadGraphRuntimeWithRecovery } from './recovery.js';
import type { ReadGraphBackendRuntime } from './runtime.js';
import { readGraphLayerOf } from './read-graph-store.js';
import { readReadGraphRegistryFacts, registrySnapshotOfFacts, sameRegistry, type ReadGraphRegistryFact } from './registry-recognition.js';
import {
  noteReadGraphRegistryRecord,
  parseReadGraphRegistryRecords,
  readGraphMembershipDiffers,
  readGraphRegistryRecordsQuery,
  recordReadGraphRegistry,
} from './registry-record.js';
import type { ReadGraphRegistrySnapshot } from './membership.js';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  MAX_READ_GRAPH_GENERATION,
  isReadGraphRowAccepted,
  newReadGraphGeneration,
  parseReadGraphStateRows,
  nextReadGraphState,
  readGraphStateMarkDirty,
  readGraphStateMarkDirtyAtStart,
  readGraphStateReset,
  readGraphStateRowsQuery,
  type ReadGraphStateRow,
  type ReadGraphVersions,
} from './state.js';

/** Rows per start-up mark: on Blazegraph one operation costs about as much for one row as for a thousand. */
const ROWS_PER_MARK = 1_000;
/** Operations per request when rows are replaced; one row's two operations are never split. */
const OPERATIONS_PER_REQUEST = 256;

export interface ReadGraphStartOptions {
  readonly dataDir?: string;
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
  /**
   * Whether this process maintains the read graph of a key: its mode is
   * `build` or `serve`. Without it the process maintains none.
   */
  readonly maintains?: (key: ReadGraphKey) => boolean;
  readonly versions?: ReadGraphVersions;
}

export interface ReadGraphStartResult {
  /** Rows marked dirty or replaced. */
  readonly marked: number;
  /** Rows the mirror holds afterwards: the read graphs the layer maintains from now on. */
  readonly maintained: number;
}

/** Start read graphs on a store before anything writes. See the module documentation. */
export async function startReadGraphs(store: TripleStore, options: ReadGraphStartOptions = {}): Promise<ReadGraphStartResult> {
  const layer = readGraphLayerOf(store);
  const maintains = options.maintains;
  if (!maintains || !layer || missingReadGraphMethods(layer.innerStore, layer.adapterCapabilities).length > 0) {
    await noteRecordOnlyPartitions(store, options);
    return { marked: await markReadGraphsDirtyAtStart(store, options), maintained: 0 };
  }
  const target = readGraphPartitionMaintenanceStore(store);
  const versions = options.versions ?? CURRENT_READ_GRAPH_VERSIONS;
  const queryOptions: QueryOptions = { priority: 'background', source: 'storage.readGraphStartup', ...(options.signal ? { signal: options.signal } : {}) };
  const { mirror, registries } = layer.runtime;
  // Another start-up of this process loaded the backend's mirror, and its store objects maintain their writes by it:
  // clearing it would let those writes pass unmaintained. Only this data directory's journal is applied.
  if (STARTED.has(layer.runtime)) {
    const marked = options.dataDir === undefined ? 0 : await markJournaledRows(target, layer.runtime, options.dataDir, queryOptions);
    return { marked, maintained: mirror.size };
  }
  STARTED.add(layer.runtime);
  // The backend's recovery generation now is the one later restarts are told by.
  syncReadGraphRuntimeWithRecovery(store, layer.runtime);
  for (const row of mirror.rows()) mirror.remove(row.readGraph);

  const found = await stateRows(target, queryOptions);
  // A registry record can outlive the last state row of its context graph: the partition exists all the same.
  const records = await registryRecords(target, queryOptions);
  const holdsPartitions = found.count > 0 || records.size > 0;
  if (holdsPartitions && options.dataDir !== undefined) noteReadGraphPartitions(options.dataDir);
  if (holdsPartitions || (options.dataDir !== undefined && mayHoldReadGraphPartitions(options.dataDir))) {
    noteStoreMayHoldReadGraphPartitions(target);
  }
  // The marks a process could not store from here on go to the data directory's journal.
  const journaled = options.dataDir !== undefined ? readUnstoredReadGraphMarks(options.dataDir) : new Map<string, Set<number>>();
  if (options.dataDir !== undefined) useReadGraphMarkJournal(layer.runtime, options.dataDir);
  if (found.count === 0) return { marked: 0, maintained: 0 };

  const maintained = (readGraph: string) => {
    const key = parseReadGraphIri(readGraph);
    return key !== undefined && maintains(key);
  };
  // The registry of each context graph with a row that could stay ready, and the one recorded for its ready rows.
  const current = new Map<string, { readonly snapshot: ReadGraphRegistrySnapshot; readonly facts: ReadGraphRegistryFact[] }>();
  const readRegistry = async (contextGraphId: string) => {
    let read = current.get(contextGraphId);
    if (!read) {
      const facts = await readReadGraphRegistryFacts(target, contextGraphId, queryOptions);
      read = { snapshot: registrySnapshotOfFacts(contextGraphId, facts), facts };
      current.set(contextGraphId, read);
    }
    return read;
  };
  // A maintained row that may stay ready, if its registry did not move. Without a data directory, no journal kept
  // the dirty marks the store refused, so no ready row can be trusted across a start.
  const mayKeep = (row: ReadGraphStateRow) => options.dataDir !== undefined && maintained(row.readGraph) && keepsReady(row, versions)
    && journaled.get(row.readGraph)?.has(row.generation) !== true;
  for (const row of found.rows) if (mayKeep(row)) await readRegistry(parseReadGraphIri(row.readGraph)!.scope.contextGraphId);
  const followsRecord = (row: ReadGraphStateRow) => {
    const key = parseReadGraphIri(row.readGraph)!;
    const record = records.get(key.scope.contextGraphId);
    return record !== undefined
      && !readGraphMembershipDiffers(key, record, current.get(key.scope.contextGraphId)!.snapshot, layer.runtime.workingMemoryIdentity);
  };
  const marked: string[] = [];
  const replaced = found.damaged.filter((readGraph) => parseReadGraphIri(readGraph) !== undefined);
  for (const row of found.rows) {
    if (maintained(row.readGraph) ? mayKeep(row) && followsRecord(row) : row.state === 'dirty') continue;
    (row.generation < MAX_READ_GRAPH_GENERATION ? marked : replaced).push(row.readGraph);
  }
  if (marked.length + replaced.length > 0) {
    if (!target.update) throw new Error('This store cannot mark its read graphs dirty: it has no update()');
    for (let at = 0; at < marked.length; at += ROWS_PER_MARK) {
      await target.update(readGraphStateMarkDirtyAtStart(marked.slice(at, at + ROWS_PER_MARK)), queryOptions);
    }
    const resets = replaced.map((readGraph) => readGraphStateReset({
      readGraph,
      state: 'dirty',
      generation: newReadGraphGeneration(),
      ruleVersion: versions.ruleVersion,
      builderVersion: versions.builderVersion,
    }));
    const perRequest = OPERATIONS_PER_REQUEST / 2;
    for (let at = 0; at < resets.length; at += perRequest) {
      await target.update(resets.slice(at, at + perRequest).join(';\n'), queryOptions);
    }
  }

  // Every row the journal named is marked now, or moved on before.
  if (options.dataDir !== undefined && journaled.size > 0) clearUnstoredReadGraphMarks(options.dataDir);
  const after = await stateRows(target, queryOptions);
  for (const row of after.rows) if (maintained(row.readGraph)) mirror.set(row);
  // Before anything writes: the facts go in with the snapshot, so the layer predicts its first registry write from them.
  // Every row that does not follow this registry is dirty now, so it is the one to record.
  for (const contextGraphId of mirror.contextGraphIds()) {
    const { snapshot, facts } = await readRegistry(contextGraphId);
    registries.set(snapshot, facts);
    const record = records.get(contextGraphId);
    if (record !== undefined && sameRegistry(record, snapshot)) noteReadGraphRegistryRecord(layer.runtime, record);
    else await recordReadGraphRegistry(target, layer.runtime, snapshot, queryOptions, options.dataDir);
  }
  const count = marked.length + replaced.length;
  if (count > 0) options.log?.(`Marked ${count} read graph(s) dirty at start; ${mirror.size} are maintained`);
  return { marked: count, maintained: mirror.size };
}

/** A maintained row that stays `ready`: built under accepted versions, outside working memory. */
function keepsReady(row: ReadGraphStateRow, versions: ReadGraphVersions): boolean {
  return row.state === 'ready' && isReadGraphRowAccepted(row, versions)
    && parseReadGraphIri(row.readGraph)?.layer !== MemoryLayer.WorkingMemory;
}

/**
 * With read graphs off, start-up looks for state rows only. A registry record
 * can outlive every state row of its context graph, so the records are looked
 * for too, and a store that holds one is noted as holding read-graph
 * partitions. A store that cannot be asked is noted all the same: unscoped
 * reads leaving out a partition that does not exist cost little.
 */
async function noteRecordOnlyPartitions(store: TripleStore, options: ReadGraphStartOptions): Promise<void> {
  const target = readGraphPartitionMaintenanceStore(store);
  const queryOptions: QueryOptions = { priority: 'background', source: 'storage.readGraphStartup', ...(options.signal ? { signal: options.signal } : {}) };
  try {
    if ((await registryRecords(target, queryOptions)).size === 0) return;
  } catch (error) {
    options.signal?.throwIfAborted();
    options.log?.(`Read-graph registry records could not be listed at start (${error instanceof Error ? error.message : String(error)}); unscoped reads leave the read-graph partition out`);
  }
  if (options.dataDir !== undefined) noteReadGraphPartitions(options.dataDir);
  noteStoreMayHoldReadGraphPartitions(target);
}

/** Runtimes a start-up of this process loaded. */
const STARTED = new WeakSet<ReadGraphBackendRuntime>();

/**
 * Mark the journaled rows of a running mirror dirty: those it holds ready at a
 * journaled generation, in the mirror and then in the store. The journal is
 * removed once every mark is stored.
 */
async function markJournaledRows(target: TripleStore, runtime: ReadGraphBackendRuntime, dataDir: string, options: QueryOptions): Promise<number> {
  const journaled = readUnstoredReadGraphMarks(dataDir);
  let marked = 0;
  for (const [readGraph, generations] of journaled) {
    const row = runtime.mirror.get(readGraph);
    if (row?.state !== 'ready' || !generations.has(row.generation)) continue;
    runtime.mirror.set(nextReadGraphState(row, { kind: 'mark-dirty' })!);
    if (!target.update) throw new Error('This store cannot mark its read graphs dirty: it has no update()');
    await target.update(readGraphStateMarkDirty(readGraph), options);
    marked += 1;
  }
  if (journaled.size > 0) clearUnstoredReadGraphMarks(dataDir);
  return marked;
}

async function registryRecords(store: TripleStore, options: QueryOptions) {
  const result = await store.query(readGraphRegistryRecordsQuery(), options);
  if (result.type !== 'bindings') throw new Error('Read-graph start-up expected registry-record bindings');
  return parseReadGraphRegistryRecords(result.bindings);
}

async function stateRows(store: TripleStore, options: QueryOptions) {
  const result = await store.query(readGraphStateRowsQuery(), options);
  if (result.type !== 'bindings') throw new Error('Read-graph start-up expected state-row bindings');
  const bindings = result.bindings.filter((binding) => binding.stateGraph !== undefined && isReadGraphStateGraph(binding.stateGraph));
  return { count: bindings.length, ...parseReadGraphStateRows(bindings) };
}
