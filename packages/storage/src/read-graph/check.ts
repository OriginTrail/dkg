// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that a read graph equals the union of its member graphs, in both
 * directions, with the statements of `./statements.ts`:
 *
 * - `missing`: a member graph holds a triple the read graph lacks
 *   ({@link readGraphMissingTripleAsk}, per member graph);
 * - `unheld`: the read graph holds a triple no member holds. The sampled check
 *   probes subjects ({@link readGraphUnheldSubjectAsk}); the full check
 *   compares the read graph's size ({@link readGraphSizeQuery}) with the
 *   number of distinct member triples ({@link readGraphFirstHolderCountQuery}
 *   summed over the members).
 *
 * A result counts only if no write touched the read graph while it ran. Every
 * write that touches a member graph holds the read graph's lock while it is
 * sent, so the sampled check holds that lock for its probes, and the full
 * check runs without it, in chunks: a chunk counts only if the lock was free
 * when it started and when it ended and nobody took it in between. A chunk a
 * write overlapped runs again; after `attempts` runs the check stops as
 * `interrupted`.
 *
 * Only a `ready` read graph is checked. A mismatch marks it dirty under its
 * lock, in the state mirror first and then with a compare-and-set in the
 * store, and raises an alert: a log line and `dkg.store.read_graph_mismatches_total`.
 * Checks read the store below the read-graph layer, on the background lane.
 */

import { assertSafeIri, compareCodePoint, contextGraphDataUri, escapeSparqlLiteral, getMetrics, MemoryLayer, parseReadGraphIri } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../adapters/blazegraph.js';
import { nonEmptyNamedGraphEnumerationPattern } from '../adapters/graph-enumeration-query.js';
import { readCompleteGraphCatalog } from '../graph-catalog-internal-limit.js';
import { readGraphInventoryByPrefix } from '../graph-inventory-materialization.js';
import { readGraphPartitionMaintenanceStore } from '../read-graph-partition-store.js';
import { withDefaultStoreWorkPriority } from '../store-priority-scheduler.js';
import { findTripleStoreCapability, type QueryOptions, type TripleStore } from '../triple-store.js';
import { matchesGraphNameTest, readGraphMembership } from './membership.js';
import { readGraphLayerOf, type ReadGraphStore } from './read-graph-store.js';
import { noteUnstoredReadGraphMark } from './mark-journal.js';
import { readReadGraphRegistry } from './registry.js';
import { nextReadGraphState, readGraphStateCompareAndSet, type ReadGraphStateRow } from './state.js';
import {
  readGraphFirstHolderCountQuery,
  readGraphMissingTripleAsk,
  readGraphSizeQuery,
  readGraphUnheldSubjectAsk,
  type ReadGraphTarget,
} from './statements.js';

export type ReadGraphCheckMode = 'sampled' | 'full';
export type ReadGraphCheckOutcome = 'consistent' | 'mismatch' | 'skipped' | 'interrupted';
/** `missing`: a member holds a triple the read graph lacks. `unheld`: the read graph holds one no member holds. */
export type ReadGraphCheckDirection = 'missing' | 'unheld';

export interface ReadGraphCheckResult {
  readonly readGraph: string;
  readonly mode: ReadGraphCheckMode;
  readonly outcome: ReadGraphCheckOutcome;
  readonly direction?: ReadGraphCheckDirection;
}

export interface ReadGraphCheckOptions {
  readonly signal?: AbortSignal;
  /** Sampled check: member graphs probed. */
  readonly sampleGraphs?: number;
  /** Sampled check: subjects probed in each sampled member graph. */
  readonly sampleSubjects?: number;
  /** Full check: member graphs per chunk. */
  readonly chunkGraphs?: number;
  /** Full check: runs of one chunk before the check stops as `interrupted`. */
  readonly attempts?: number;
  readonly random?: () => number;
  /** Receives the alert of a mismatch. */
  readonly alert?: (message: string) => void;
}

const DEFAULTS = { sampleGraphs: 8, sampleSubjects: 4, chunkGraphs: 64, attempts: 3 } as const;
const SOURCE = 'storage.readGraphCheck';
const INTERRUPTED = Symbol('interrupted');

interface CheckContext {
  readonly readGraph: string;
  readonly layer: ReadGraphStore;
  /** The adapter below the layer: probes, counts and the dirty mark go here. */
  readonly target: TripleStore;
  /** The store as given: its catalog lists member graphs cheaply, for samples only, since it may lag behind the store. */
  readonly catalog: TripleStore;
  readonly row: ReadGraphStateRow;
  readonly read: ReadGraphTarget;
  readonly root: string;
  readonly options: QueryOptions;
}

/**
 * Check one read graph. A store without the read-graph layer, or a read graph
 * that is not `ready`, is `skipped`. A store error ends the check and is
 * thrown, after it is counted.
 */
export async function checkReadGraph(
  store: TripleStore,
  readGraph: string,
  mode: ReadGraphCheckMode,
  options: ReadGraphCheckOptions = {},
): Promise<ReadGraphCheckResult> {
  const startedAt = performance.now();
  const layerLabel = layerOf(readGraph);
  try {
    const result = await withDefaultStoreWorkPriority('background', () => runCheck(store, readGraph, mode, options));
    record(mode, result.outcome, layerLabel, startedAt, result.direction);
    return result;
  } catch (error) {
    record(mode, 'error', layerLabel, startedAt);
    throw error;
  }
}

async function runCheck(store: TripleStore, readGraph: string, mode: ReadGraphCheckMode, options: ReadGraphCheckOptions): Promise<ReadGraphCheckResult> {
  const context = await contextOf(store, readGraph, options);
  if (!context) return { readGraph, mode, outcome: 'skipped' };
  const verdict = mode === 'sampled' ? await sampled(context, options) : await full(context, options);
  if (verdict === 'consistent' || verdict === 'skipped' || verdict === 'interrupted') return { readGraph, mode, outcome: verdict };
  return { readGraph, mode, outcome: 'mismatch', direction: verdict.direction };
}

async function contextOf(store: TripleStore, readGraph: string, options: ReadGraphCheckOptions): Promise<CheckContext | undefined> {
  const layer = readGraphLayerOf(store);
  const key = parseReadGraphIri(readGraph);
  const row = layer?.runtime.mirror.get(readGraph);
  if (!layer || !key || row?.state !== 'ready') return undefined;
  const target = readGraphPartitionMaintenanceStore(store);
  const queryOptions: QueryOptions = { signal: options.signal, priority: 'background', source: SOURCE };
  const contextGraphId = key.scope.contextGraphId;
  let registry = layer.runtime.registries.get(contextGraphId);
  if (!registry) {
    registry = await readReadGraphRegistry(target, contextGraphId, queryOptions);
    layer.runtime.registries.set(registry);
  }
  const membership = readGraphMembership(key, registry, layer.runtime.workingMemoryIdentity);
  return {
    readGraph, layer, target, catalog: store, row,
    read: { readGraph, membership },
    root: contextGraphDataUri(contextGraphId),
    options: queryOptions,
  };
}

type Verdict = 'consistent' | 'skipped' | 'interrupted' | { readonly direction: ReadGraphCheckDirection };

/**
 * Probe a sample of member graphs, and a sample of their subjects, under the
 * read graph's lock. The sample comes from the catalog: a member it has not
 * seen yet waits for a later sample or the full check.
 */
async function sampled(context: CheckContext, options: ReadGraphCheckOptions): Promise<Verdict> {
  const members = await memberGraphs(context, context.catalog);
  const sample = pick(members, options.sampleGraphs ?? DEFAULTS.sampleGraphs, options.random ?? Math.random);
  return context.layer.runtime.locks.withLocks([context.readGraph], async (): Promise<Verdict> => {
    if (!unchanged(context)) return 'skipped';
    for (const graph of sample) {
      if (await ask(context, readGraphMissingTripleAsk(context.readGraph, graph))) return mismatch(context, 'missing', 'sampled', options);
      for (const subject of await subjects(context, graph, options.sampleSubjects ?? DEFAULTS.sampleSubjects)) {
        const probe = unheldProbe(context, subject);
        if (probe && await ask(context, probe)) return mismatch(context, 'unheld', 'sampled', options);
      }
    }
    return 'consistent';
  });
}

/** Every member graph, then the read graph's size against its members' distinct triples, without holding the lock. */
/**
 * Equal sizes prove equality only once every member counted is known to hold
 * no triple the read graph lacks. Both phases therefore list the members from
 * the store itself, never from a catalog that may lag behind it, and a member
 * that appears after its chunk ran is probed in the window of the count.
 */
async function full(context: CheckContext, options: ReadGraphCheckOptions): Promise<Verdict> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const chunk = options.chunkGraphs ?? DEFAULTS.chunkGraphs;
  const missingIn = async (graphs: readonly string[]) => {
    for (const graph of graphs) {
      if (await ask(context, readGraphMissingTripleAsk(context.readGraph, graph))) return true;
    }
    return false;
  };
  const probed = new Set<string>();
  const members = await storedMemberGraphs(context);
  for (let at = 0; at < members.length; at += chunk) {
    const graphs = members.slice(at, at + chunk);
    const found = await withoutWrites(context, attempts, () => missingIn(graphs));
    if (found === INTERRUPTED) return 'interrupted';
    if (found === 'skipped') return 'skipped';
    if (found) return markUnderLock(context, 'missing', options);
    for (const graph of graphs) probed.add(graph);
    await yieldLane(options.signal);
  }
  // The size of the read graph must equal the number of distinct member triples.
  const counted = await withoutWrites(context, attempts, async () => {
    const graphs = await storedMemberGraphs(context);
    if (await missingIn(graphs.filter((graph) => !probed.has(graph)))) return 'missing' as const;
    let distinct = 0;
    for (const graph of graphs) {
      distinct += await count(context, readGraphFirstHolderCountQuery(context.read, graph));
      await yieldLane(options.signal);
    }
    return { distinct, size: await count(context, readGraphSizeQuery(context.readGraph)) };
  });
  if (counted === INTERRUPTED) return 'interrupted';
  if (counted === 'skipped') return 'skipped';
  if (counted === 'missing') return markUnderLock(context, 'missing', options);
  if (counted.size === counted.distinct) return 'consistent';
  return markUnderLock(context, counted.size > counted.distinct ? 'unheld' : 'missing', options);
}

/**
 * Run `work` until one run overlaps no write to the read graph: its lock was
 * free when the run started and when it ended, and nobody took it in between.
 */
async function withoutWrites<T>(context: CheckContext, attempts: number, work: () => Promise<T>): Promise<T | 'skipped' | typeof INTERRUPTED> {
  const { locks } = context.layer.runtime;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Wait for the writes that hold or wait for the lock now.
    await locks.withLocks([context.readGraph], async () => undefined);
    if (locks.isLocked(context.readGraph)) continue;
    const turns = locks.turns(context.readGraph);
    const value = await work();
    if (!unchanged(context)) return 'skipped';
    if (!locks.isLocked(context.readGraph) && locks.turns(context.readGraph) === turns) return value;
  }
  return INTERRUPTED;
}

/** Mark the read graph dirty for a mismatch found without its lock, if its row has not moved on since. */
async function markUnderLock(context: CheckContext, direction: ReadGraphCheckDirection, options: ReadGraphCheckOptions): Promise<Verdict> {
  return context.layer.runtime.locks.withLocks([context.readGraph], async () =>
    unchanged(context) ? mismatch(context, direction, 'full', options) : 'skipped');
}

/** Under the read graph's lock: mark it dirty, in the mirror first, then in the store, and alert. */
async function mismatch(context: CheckContext, direction: ReadGraphCheckDirection, mode: ReadGraphCheckMode, options: ReadGraphCheckOptions): Promise<Verdict> {
  const dirty = nextReadGraphState(context.row, { kind: 'mark-dirty' })!;
  context.layer.runtime.mirror.set(dirty);
  let stored = 'it is marked dirty';
  try {
    await context.target.update?.(readGraphStateCompareAndSet(context.row, dirty), { ...context.options });
  } catch (error) {
    stored = `it is marked dirty in this process, but its stored state could not be changed (${error instanceof Error ? error.message : String(error)})`;
    noteUnstoredReadGraphMark(context.layer.runtime, context.readGraph, context.row.generation);
  }
  const what = direction === 'missing'
    ? 'a member graph holds a triple it lacks'
    : 'it holds a triple that no member graph holds';
  (options.alert ?? ((message: string) => console.error(message)))(
    `[read-graph-check] Read graph <${context.readGraph}> does not equal the union of its member graphs `
      + `(${mode} check): ${what}. ${stored[0]!.toUpperCase()}${stored.slice(1)}, and is rebuilt before it serves again.`,
  );
  return { direction };
}

/** The row this check started from is still the mirror's. */
function unchanged(context: CheckContext): boolean {
  const row = context.layer.runtime.mirror.get(context.readGraph);
  return row !== undefined && row.state === 'ready' && row.generation === context.row.generation;
}

/**
 * The member graphs the store holds now, enumerated by one query rather than
 * read from any graph list an adapter or a decorator may cache: the adapter's
 * own listing form ({@link memberGraphListingQuery}), narrowed to the context
 * graph, under the internal catalog ceiling.
 */
async function storedMemberGraphs(context: CheckContext): Promise<string[]> {
  const query = memberGraphListingQuery(context.target, context.root);
  const result = await readCompleteGraphCatalog(context.options, (internal) => context.target.query(query, internal));
  if (result.type !== 'bindings') throw new Error('A read-graph check expected graph bindings');
  const graphs = result.bindings.map((row) => row['g']).filter((graph): graph is string => typeof graph === 'string');
  return [...new Set(graphs)].filter((graph) => matchesGraphNameTest(context.read.membership, graph)).sort(compareCodePoint);
}

/**
 * The query that lists the context graph's graphs that hold a quad: its root
 * graph and the graphs under `root/`, not those of a context graph whose ID
 * extends this one. It takes the form the store's adapter lists its graphs
 * with, so that the store itself narrows the list. Blazegraph applies that
 * narrowing to the graph names of its quads, but not to its named-graph
 * enumeration, which the other adapters read.
 */
export function memberGraphListingQuery(target: TripleStore, root: string): string {
  const under = `FILTER(?g = <${assertSafeIri(root)}> || STRSTARTS(STR(?g), "${escapeSparqlLiteral(`${root}/`)}"))`;
  if (findTripleStoreCapability(target, (candidate): candidate is BlazegraphStore => candidate instanceof BlazegraphStore)) {
    // sparql-scan-allow: R2 -- Blazegraph's own graph listing (as its listGraphs), narrowed to one context graph, on the background lane
    return `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } ${under} }`;
  }
  return `SELECT ?g WHERE { ${nonEmptyNamedGraphEnumerationPattern('g')} ${under} }`;
}

/** The member graphs of the read graph in `store`'s graph list, in code-point order. */
async function memberGraphs(context: CheckContext, store: TripleStore): Promise<string[]> {
  const listed = await readGraphInventoryByPrefix(store, `${context.root}/`, context.options);
  return [...new Set([context.root, ...listed.graphs])]
    .filter((graph) => matchesGraphNameTest(context.read.membership, graph))
    .sort(compareCodePoint);
}

/** Up to `limit` IRI subjects of one member graph. */
async function subjects(context: CheckContext, graph: string, limit: number): Promise<string[]> {
  if (limit < 1) return [];
  const result = await context.target.query(
    `SELECT DISTINCT ?s WHERE { GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o } FILTER(isIRI(?s)) } LIMIT ${Math.floor(limit)}`,
    context.options,
  );
  if (result.type !== 'bindings') return [];
  return result.bindings.map((row) => row['s']).filter((value): value is string => typeof value === 'string');
}

/** The unheld probe of a subject, or `undefined` for one the probe cannot name (a blank node, an unsafe IRI). */
function unheldProbe(context: CheckContext, subject: string): string | undefined {
  try {
    return readGraphUnheldSubjectAsk(context.read, subject);
  } catch {
    return undefined;
  }
}

async function ask(context: CheckContext, sparql: string): Promise<boolean> {
  const result = await context.target.query(sparql, context.options);
  if (result.type !== 'boolean') throw new Error('A read-graph check expected a boolean answer');
  return result.value;
}

async function count(context: CheckContext, sparql: string): Promise<number> {
  const result = await context.target.query(sparql, context.options);
  const value = result.type === 'bindings' ? result.bindings[0]?.['n'] : undefined;
  const match = value === undefined ? null : /^"?(\d+)/.exec(value);
  if (!match) throw new Error('A read-graph check expected a count');
  return Number(match[1]);
}

function pick<T>(items: readonly T[], limit: number, random: () => number): T[] {
  if (items.length <= limit) return [...items];
  const pool = [...items];
  for (let at = 0; at < limit; at += 1) {
    const swap = at + Math.floor(random() * (pool.length - at));
    [pool[at], pool[swap]] = [pool[swap]!, pool[at]!];
  }
  return pool.slice(0, limit);
}

async function yieldLane(signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
}

const LAYER_LABELS: Record<MemoryLayer, string> = {
  [MemoryLayer.WorkingMemory]: 'wm',
  [MemoryLayer.SharedWorkingMemory]: 'swm',
  [MemoryLayer.VerifiableMemory]: 'vm',
};

function layerOf(readGraph: string): string {
  const key = parseReadGraphIri(readGraph);
  return key ? LAYER_LABELS[key.layer] : 'other';
}

function record(mode: ReadGraphCheckMode, outcome: ReadGraphCheckOutcome | 'error', layer: string, startedAt: number, direction?: ReadGraphCheckDirection): void {
  try {
    const metrics = getMetrics();
    metrics.storeReadGraphChecksTotal.add(1, { mode, outcome, layer });
    metrics.storeReadGraphCheckMs.record(Math.max(0, performance.now() - startedAt), { mode, outcome });
    if (direction) metrics.storeReadGraphMismatchesTotal.add(1, { mode, direction, layer });
  } catch {
    // Telemetry must never change a check's result.
  }
}
