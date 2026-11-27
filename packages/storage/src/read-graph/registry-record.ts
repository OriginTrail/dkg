// SPDX-License-Identifier: Apache-2.0

/**
 * The registry that a context graph's ready read graphs follow, recorded in
 * its state graph, so a start-up can tell whether the registry changed while
 * no process kept those read graphs' marks.
 *
 * The layer marks a read graph dirty when a write changes its membership:
 * before the write where the write's arguments show the registry it leaves,
 * and after it where only reading the registry again tells. A process that
 * stops between such a write and its marks leaves rows `ready` under a
 * registry that no longer holds, and the registry a later start-up reads
 * shows nothing of it. So start-up compares each context graph's registry
 * with this record, and marks a ready row dirty when its membership differs
 * between the two, or when there is no record. The builder records the
 * registry before it builds under it, and start-up after its marks, so every
 * ready row of a context graph follows its record.
 *
 * The record is one literal on the state graph itself: `v1`, then
 * `sub:{name}` per registered sub-graph and `child:{root}` per registered
 * child context graph, separated by spaces. Neither a valid sub-graph name nor
 * a safe IRI holds a space, a quote or a backslash, so the literal needs no
 * escapes. State rows are found by their own predicates, so the record is
 * never taken for one.
 */

import { assertSafeIri, readGraphStateGraphIri, validateSubGraphName, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { noteReadGraphPartitionsOfRuntime } from './data-directories.js';
import { noteStoreMayHoldReadGraphPartitions } from '../read-graph-partition-store.js';
import type { QueryOptions, TripleStore } from '../triple-store.js';
import { readGraphMembership, type ReadGraphRegistrySnapshot, type WorkingMemoryIdentityRule } from './membership.js';
import { RECORDED_REGISTRIES as RECORDED } from './recorded-registries.js';
import { sameRegistry } from './registry-recognition.js';
import type { ReadGraphBackendRuntime } from './runtime.js';

export const READ_GRAPH_REGISTRY_RECORD_PREDICATE = 'http://dkg.io/ontology/readGraphRegistry';

const FORMAT = 'v1';
const STATE_GRAPH_PREFIX = 'did:dkg:context-graph:';
const STATE_GRAPH_SUFFIX = '/_~read/state';

/** Every context graph's record, in any state graph. Read with {@link parseReadGraphRegistryRecords}. */
export function readGraphRegistryRecordsQuery(): string {
  return `SELECT ?stateGraph ?record WHERE {
  GRAPH ?stateGraph { ?stateGraph <${READ_GRAPH_REGISTRY_RECORD_PREDICATE}> ?record }
  FILTER(STRSTARTS(STR(?stateGraph), "${STATE_GRAPH_PREFIX}") && STRENDS(STR(?stateGraph), "${STATE_GRAPH_SUFFIX}"))
}`;
}

/**
 * The records of a {@link readGraphRegistryRecordsQuery} answer, by context
 * graph. A context graph with more than one record, or one that does not
 * parse, gets `undefined`: it has no record to trust.
 */
export function parseReadGraphRegistryRecords(
  bindings: readonly Readonly<Record<string, string | undefined>>[],
): Map<string, ReadGraphRegistrySnapshot | undefined> {
  const found = new Map<string, Array<ReadGraphRegistrySnapshot | undefined>>();
  for (const binding of bindings) {
    const { stateGraph, record } = binding;
    if (stateGraph === undefined || record === undefined) continue;
    const contextGraphId = contextGraphOfStateGraph(stateGraph);
    if (contextGraphId === undefined) continue;
    found.set(contextGraphId, [...(found.get(contextGraphId) ?? []), decodeRecord(contextGraphId, record)]);
  }
  return new Map([...found].map(([contextGraphId, records]) => [contextGraphId, records.length === 1 ? records[0] : undefined]));
}

/**
 * Replace a context graph's record with `snapshot`. A snapshot the format
 * cannot carry leaves no record, so the next start-up marks the context
 * graph's ready rows dirty.
 */
export function readGraphRegistryRecordUpdate(snapshot: ReadGraphRegistrySnapshot): string {
  const graph = assertSafeIri(readGraphStateGraphIri(snapshot.contextGraphId));
  const drop = `DELETE WHERE { GRAPH <${graph}> { <${graph}> <${READ_GRAPH_REGISTRY_RECORD_PREDICATE}> ?record } }`;
  const record = encodeRecord(snapshot);
  if (record === undefined) return drop;
  return `${drop};\nINSERT DATA { GRAPH <${graph}> { <${graph}> <${READ_GRAPH_REGISTRY_RECORD_PREDICATE}> "${record}" } }`;
}

/** Whether a read graph's membership differs between two registries of its context graph. */
export function readGraphMembershipDiffers(
  key: ReadGraphKey,
  before: ReadGraphRegistrySnapshot,
  after: ReadGraphRegistrySnapshot,
  identity: WorkingMemoryIdentityRule,
): boolean {
  return JSON.stringify(readGraphMembership(key, before, identity)) !== JSON.stringify(readGraphMembership(key, after, identity));
}


/** Forget what the stored records hold, so each is written again: the store may hold older ones. */
export function forgetReadGraphRegistryRecords(runtime: ReadGraphBackendRuntime): void {
  RECORDED.delete(runtime);
}

/** Note what a context graph's stored record holds, as start-up read or wrote it. */
export function noteReadGraphRegistryRecord(runtime: ReadGraphBackendRuntime, snapshot: ReadGraphRegistrySnapshot): void {
  let recorded = RECORDED.get(runtime);
  if (!recorded) {
    recorded = new Map();
    RECORDED.set(runtime, recorded);
  }
  recorded.set(snapshot.contextGraphId, snapshot);
}

/**
 * Record a context graph's registry, unless the stored record already holds
 * it. The caller holds a registry every ready row of the context graph follows.
 * The record lives in the read-graph partition, so before it is written the
 * store, `dataDir` where there is one, and each of the runtime's data
 * directories (`./data-directories.ts`) note that the partition may exist:
 * unscoped reads leave it out from then on, across a restart too, and a
 * rollback from any of those directories drops it.
 */
export async function recordReadGraphRegistry(
  store: TripleStore,
  runtime: ReadGraphBackendRuntime,
  snapshot: ReadGraphRegistrySnapshot,
  options: QueryOptions = {},
  dataDir?: string,
): Promise<void> {
  const recorded = RECORDED.get(runtime)?.get(snapshot.contextGraphId);
  if (recorded !== undefined && sameRegistry(recorded, snapshot)) return;
  if (!store.update) throw new Error('This store cannot record a read-graph registry: it has no update()');
  noteReadGraphPartitionsOfRuntime(runtime, dataDir);
  noteStoreMayHoldReadGraphPartitions(store);
  await store.update(readGraphRegistryRecordUpdate(snapshot), { ...options, source: 'storage.readGraphRegistryRecord' });
  if (encodeRecord(snapshot) !== undefined) noteReadGraphRegistryRecord(runtime, snapshot);
}

function encodeRecord(snapshot: ReadGraphRegistrySnapshot): string | undefined {
  const tokens = [FORMAT];
  for (const name of [...snapshot.subGraphNames].sort()) {
    if (!validateSubGraphName(name).valid) return undefined;
    tokens.push(`sub:${name}`);
  }
  for (const root of [...snapshot.childContextGraphRoots].sort()) {
    try {
      assertSafeIri(root);
    } catch {
      return undefined;
    }
    if (/[\s"\\]/.test(root)) return undefined;
    tokens.push(`child:${root}`);
  }
  return tokens.join(' ');
}

function decodeRecord(contextGraphId: string, term: string): ReadGraphRegistrySnapshot | undefined {
  const literal = parseRdfLiteralTerm(term, { combineSurrogatePairs: true });
  if (!literal || literal.kind === 'language') return undefined;
  const [format, ...tokens] = literal.value.split(' ');
  if (format !== FORMAT) return undefined;
  const subGraphNames: string[] = [];
  const childContextGraphRoots: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('sub:')) subGraphNames.push(token.slice('sub:'.length));
    else if (token.startsWith('child:')) childContextGraphRoots.push(token.slice('child:'.length));
    else return undefined;
  }
  return { contextGraphId, subGraphNames, childContextGraphRoots };
}

function contextGraphOfStateGraph(stateGraph: string): string | undefined {
  if (!stateGraph.startsWith(STATE_GRAPH_PREFIX) || !stateGraph.endsWith(STATE_GRAPH_SUFFIX)) return undefined;
  const contextGraphId = stateGraph.slice(STATE_GRAPH_PREFIX.length, -STATE_GRAPH_SUFFIX.length);
  try {
    return readGraphStateGraphIri(contextGraphId) === stateGraph ? contextGraphId : undefined;
  } catch {
    // An id that can have no read graphs.
    return undefined;
  }
}
