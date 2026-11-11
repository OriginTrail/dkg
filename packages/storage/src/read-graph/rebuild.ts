// SPDX-License-Identifier: Apache-2.0

/**
 * The jobs that build read graphs: the backfill of a new read graph, the
 * rebuild of one that is not ready, the scoped repair of one after a change of
 * its members, and the removal of one.
 *
 * A job works below the read-graph layer, on the store that
 * `readGraphPartitionMaintenanceStore` returns, and holds the read graph's lock
 * in the backend's runtime for each step, so its steps and the writes the layer
 * maintains are serialized per read graph. Each batch is one lock hold and one
 * request with one operation, fenced by the state and generation the job
 * started with (`readGraphStateFencePattern`): an operation of an earlier job,
 * or of a job that a newer change of the row overtook, changes nothing.
 *
 * Every change of a row is checked ({@link ReadGraphJob.transition}): the
 * mirror first for a change that takes the read graph out of service, then the
 * compare-and-set, then a read of the stored row, which the mirror then takes.
 * Publishing `ready` is the one change into service: the mirror takes it only
 * after the stored row reads back `ready`, in the same lock hold.
 *
 * After its row is in place, a job waits for the writes that were in flight
 * through any layer over the backend (`runtime.writes.settled`): they decided
 * their read graphs before the row existed. Then it empties the read graph,
 * lists its members from the backend itself, so writes through another store
 * object over the backend are listed too, and copies them. A write that lands
 * meanwhile is maintained by the layer under the same lock; a member it adds
 * after the listing is maintained, and one it adds before is listed.
 */

import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import {
  MemoryLayer,
  assertSafeIri,
  compareCodePoint,
  contextGraphDataUri,
  isReadGraphPartitionIri,
  parseReadGraphIri,
  readGraphIri,
  type ReadGraphKey,
} from '@origintrail-official/dkg-core';
import { isReadGraphStateGraph } from '../graph-enumeration-visibility.js';
import { readGraphInventoryByPrefix } from '../graph-inventory-materialization.js';
import { assertGraphCatalogWithinInternalLimit, readCompleteGraphCatalog } from '../graph-catalog-internal-limit.js';
import { noteReadGraphPartitions } from '../read-graph-partition-marker.js';
import { noteStoreMayHoldReadGraphPartitions, readGraphPartitionMaintenanceStore } from '../read-graph-partition-store.js';
import type { QueryOptions, TripleStore } from '../triple-store.js';
import { missingReadGraphMethods } from './adapter-contract.js';
import { memberGraphListingQuery } from './check.js';
import { matchesGraphNameTest, readGraphMembership, workingMemoryIdentityRule, type GraphNameTest } from './membership.js';
import { readGraphLayerOf, readGraphRuntimeOf } from './read-graph-store.js';
import { readReadGraphRegistryFacts, registrySnapshotOfFacts, sameRegistry, type ReadGraphRegistryFact } from './registry-recognition.js';
import { noteUnstoredReadGraphMark } from './mark-journal.js';
import { syncReadGraphRuntimeWithRecovery } from './recovery.js';
import { recordReadGraphRegistry } from './registry-record.js';
import { ReadGraphLocks, type InMemoryReadGraphStateMirror, type ReadGraphBackendRuntime } from './runtime.js';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  isReadGraphRowAccepted,
  newReadGraphGeneration,
  nextReadGraphState,
  parseReadGraphStateRows,
  readGraphStateCompareAndSet,
  readGraphStateReset,
  readGraphStateRowQuery,
  type ReadGraphStateRow,
  type ReadGraphTransition,
  type ReadGraphVersions,
} from './state.js';
import {
  readGraphBackfillBatch,
  readGraphFencedDrop,
  readGraphHoldsTripleAsk,
  readGraphRepairLeave,
  type ReadGraphFence,
} from './statements.js';

/** How a job cuts its work. Each batch is one lock hold and one request. */
export interface ReadGraphBatching {
  /** Member graphs in the first copy batch; later batches grow or shrink toward {@link targetBatchMs}. */
  readonly graphsPerBatch: number;
  readonly maxGraphsPerBatch: number;
  /** The most triples one drop batch removes; later batches shrink toward {@link targetBatchMs}. */
  readonly triplesPerDrop: number;
  /** The time one copy batch should take. */
  readonly targetBatchMs: number;
  /**
   * After each batch the job waits this share of the batch's time, and longer
   * while foreground work is queued on the store, so it never takes the store
   * from foreground work for long. An engine without store lanes runs a batch
   * beside queries; the pause is its time slice.
   */
  readonly pauseRatio: number;
}

export const DEFAULT_READ_GRAPH_BATCHING: ReadGraphBatching = Object.freeze({
  graphsPerBatch: 16,
  maxGraphsPerBatch: 256,
  triplesPerDrop: 10_000,
  targetBatchMs: 200,
  pauseRatio: 1,
});

/** What a job works with. */
export interface ReadGraphJobContext {
  /** A store object over the backend, as `createTripleStore` builds it. Jobs work below its read-graph layer. */
  readonly store: TripleStore;
  /** The node's data directory, where a job notes that the store may hold read-graph partitions. */
  readonly dataDir?: string;
  readonly signal?: AbortSignal;
  readonly versions?: ReadGraphVersions;
  readonly batching?: Partial<ReadGraphBatching>;
  /** The `source` label of the job's store requests. */
  readonly source?: string;
}

/** A build, a scoped repair, a removal, or a dirty mark, which reports its row and no result. */
export type ReadGraphJobKind = 'build' | 'repair' | 'remove' | 'mark';

export interface ReadGraphJobResult {
  readonly readGraph: string;
  readonly kind: ReadGraphJobKind;
  /**
   * `done`: the stored row reads back as the job left it. `current`: there was
   * nothing to do. `lost`: a newer change of the row overtook the job, which
   * ended there; plan again from the stored row.
   */
  readonly outcome: 'done' | 'current' | 'lost';
  /** The stored row when the job ended. */
  readonly row: ReadGraphStateRow | undefined;
  readonly batches: number;
  readonly durationMs: number;
}

/** The input of a scoped repair. */
export interface ReadGraphRepairInput {
  /** Graphs that joined the read graph, with their contents intact. */
  readonly joined: readonly string[];
  /** Graphs that left the read graph, with their contents still the ones it holds. */
  readonly leaving: readonly string[];
  /** The membership after the change, which holds the joined graphs and none of the leaving ones. */
  readonly membership: GraphNameTest;
}

/** How a job's first step under the lock ended: the job goes on from `started`, or ends there. */
type Begun<Extra = object> =
  | ({ readonly ended?: undefined; readonly started: ReadGraphStateRow } & Extra)
  | { readonly ended: 'current' | 'lost'; readonly row: ReadGraphStateRow | undefined };

/** A job cannot proceed on this read graph; it stays out of service. */
export class ReadGraphJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadGraphJobError';
  }
}

const SOURCE = 'storage.readGraphBuild';
/** Drop batches between two reads of the stored row, which a drop under a stale fence would never end without. */
const DROPS_PER_ROW_CHECK = 32;
/** The fewest triples a drop batch removes once its size follows its time. */
const MIN_TRIPLES_PER_DROP = 500;
const MAX_PAUSE_MS = 2_000;
const PRESSURE_POLL_MS = 50;
const MAX_PRESSURE_WAIT_MS = 5_000;

/**
 * Build a read graph to the union of its members: create it when it has no
 * row, rebuild it when its row is not ready or carries versions this release
 * does not accept, and leave it when it is ready.
 */
export async function buildReadGraph(context: ReadGraphJobContext, key: ReadGraphKey): Promise<ReadGraphJobResult> {
  const job = new ReadGraphJob(context, readGraphIri(key), 'build');
  return withReadGraphBackgroundSlot(job.runtime, () => build(job, key));
}

async function build(job: ReadGraphJob, key: ReadGraphKey): Promise<ReadGraphJobResult> {
  await job.refreshRegistry(key.scope.contextGraphId);
  const begun = await job.locked(async (): Promise<Begun<{ readonly membership: GraphNameTest }>> => {
    const stored = await job.reconcile();
    if (stored?.state === 'ready' && isReadGraphRowAccepted(stored, job.versions)) return { ended: 'current', row: stored };
    let started: ReadGraphStateRow | undefined;
    if (stored === undefined) {
      job.noteMayHoldPartitions();
      started = await job.transition(undefined, { kind: 'create', readGraph: job.readGraph, generation: newReadGraphGeneration(), versions: job.versions });
    } else {
      const dirty = stored.state === 'dirty' ? stored : await job.transition(stored, { kind: 'mark-dirty' });
      started = dirty?.state === 'dirty' ? await job.transition(dirty, { kind: 'start-rebuild', versions: job.versions }) : dirty;
    }
    if (started?.state !== 'building' && started?.state !== 'rebuilding') return { ended: 'lost', row: started };
    return { started, membership: await job.membership(key) };
  });
  if (begun.ended !== undefined) return job.result(begun.ended, begun.row);
  const { started, membership } = begun;
  const inService = job.mirrorHolds(started);
  if (!(await job.settledUnderRegistry(key.scope.contextGraphId, inService))) return job.lost();
  if (!(await job.drop(started, inService))) return job.lost();
  const members = await job.members(membership);
  if (!(await job.copy(started, members.constants, inService, 1)) || !(await job.copy(started, members.listed, inService))) return job.lost();
  return job.publish(started, inService);
}

/**
 * Repair a dirty read graph whose old contents are still in the store: copy
 * the graphs that joined and retract the intact graphs that left, under the
 * state `repairing`. Only a row built under the current rule and an accepted
 * builder can be repaired; any other row, or one that is not dirty, ends the
 * job `lost`, for a full build.
 */
export async function repairReadGraph(
  context: ReadGraphJobContext,
  key: ReadGraphKey,
  input: ReadGraphRepairInput,
): Promise<ReadGraphJobResult> {
  const job = new ReadGraphJob(context, readGraphIri(key), 'repair');
  for (const graph of input.joined) if (!matchesGraphNameTest(input.membership, graph)) throw new ReadGraphJobError(`A joined graph must be a member: ${graph}`);
  for (const graph of input.leaving) if (matchesGraphNameTest(input.membership, graph)) throw new ReadGraphJobError(`A leaving graph must not be a member: ${graph}`);
  return withReadGraphBackgroundSlot(job.runtime, () => repair(job, input));
}

async function repair(job: ReadGraphJob, input: ReadGraphRepairInput): Promise<ReadGraphJobResult> {
  const begun = await job.locked(async (): Promise<Begun> => {
    const stored = await job.reconcile();
    // A row that had to be replaced says nothing about the contents: they need a full build.
    if (job.replacedRow || stored?.state !== 'dirty' || !isReadGraphRowAccepted(stored, job.versions)) return { ended: 'lost', row: stored };
    const started = await job.transition(stored, { kind: 'start-repair', versions: job.versions });
    return started?.state === 'repairing' ? { started } : { ended: 'lost', row: started };
  });
  if (begun.ended !== undefined) return job.result(begun.ended, begun.row);
  const { started } = begun;
  const inService = job.mirrorHolds(started);
  if (!(await job.settledUnderRegistry(parseReadGraphIri(job.readGraph)!.scope.contextGraphId, inService))) return job.lost();
  const joined = [...new Set(input.joined)].sort(compareCodePoint);
  if (!(await job.copy(started, joined, inService))) return job.lost();
  const leaving = [...new Set(input.leaving)].sort(compareCodePoint);
  const retractions = leaving.length === 0 ? [] : readGraphRepairLeave({ readGraph: job.readGraph, membership: input.membership }, fenceOf(started), leaving);
  for (const retraction of retractions) {
    if (!(await job.batch(inService, () => job.send(retraction)))) return job.lost();
  }
  return job.publish(started, inService);
}

/**
 * Remove a read graph: dirty first, out of the mirror so that writes stop
 * maintaining it, then, once the writes in flight have settled, empty it in
 * fenced batches and remove its row. A read graph without a row that still
 * holds triples gets a dirty row first, so the drop is fenced too.
 */
export async function removeReadGraph(context: ReadGraphJobContext, readGraph: string): Promise<ReadGraphJobResult> {
  if (!parseReadGraphIri(readGraph)) throw new ReadGraphJobError(`Not a read-graph IRI: ${readGraph}`);
  const job = new ReadGraphJob(context, readGraph, 'remove');
  return withReadGraphBackgroundSlot(job.runtime, () => remove(job));
}

async function remove(job: ReadGraphJob): Promise<ReadGraphJobResult> {
  const readGraph = job.readGraph;
  const begun = await job.locked(async (): Promise<Begun> => {
    let stored = await job.reconcile(false);
    if (stored === undefined) {
      job.runtime.mirror.remove(readGraph);
      if (!(await job.holdsTriple())) return { ended: 'current', row: undefined };
      stored = await job.reset();
    } else if (stored.state !== 'dirty') {
      stored = await job.transition(stored, { kind: 'mark-dirty' });
    }
    job.runtime.mirror.remove(readGraph);
    return stored?.state === 'dirty' ? { started: stored } : { ended: 'lost', row: stored };
  });
  if (begun.ended !== undefined) return job.result(begun.ended, begun.row);
  const dirty = begun.started;
  await job.settled();
  if (!(await job.drop(dirty, () => true))) return job.lost();
  // A row that reads back after the removal is in the mirror again, and maintained.
  const removed = await job.locked(() => job.transition(dirty, { kind: 'remove' }));
  return job.result(removed === undefined ? 'done' : 'lost', removed);
}

/**
 * Mark a read graph dirty from its stored row, as a checked change under its
 * lock: for a check that finds it wrong, or a change of a rule it was built
 * under. A damaged row is replaced by a dirty one; a read graph without a row
 * stays without one. Returns the stored row afterwards, which the mirror holds.
 */
export async function markReadGraphDirty(context: ReadGraphJobContext, readGraph: string): Promise<ReadGraphStateRow | undefined> {
  if (!parseReadGraphIri(readGraph)) throw new ReadGraphJobError(`Not a read-graph IRI: ${readGraph}`);
  const job = new ReadGraphJob(context, readGraph, 'mark');
  return job.locked(() => job.markDirtyHeld());
}

const SLOTS = new WeakMap<ReadGraphBackendRuntime, ReadGraphLocks>();

/**
 * Run heavy background work on a backend's read graphs one job at a time, in
 * the order asked. Build, repair and removal take this slot themselves, and
 * the scheduled checks and the checks run on request take it for each read
 * graph they check.
 */
export function withReadGraphBackgroundSlot<T>(runtime: ReadGraphBackendRuntime, work: () => Promise<T>): Promise<T> {
  let slot = SLOTS.get(runtime);
  if (!slot) {
    slot = new ReadGraphLocks();
    SLOTS.set(runtime, slot);
  }
  return slot.withLocks(['background'], work);
}

/**
 * Bring the runtime's registry of a context graph up to what is stored,
 * holding no lock on entry. The facts are read without locks, then installed,
 * snapshot and facts, under the locks of every read graph of the context
 * graph with a row: the locks the layer takes for every write that may change
 * the registry. If the cache changed meanwhile, the facts read are older than
 * that change, and they are read again. When the cache held another snapshot,
 * every one of those read graphs is marked dirty before the new one is
 * installed: the layer maintained it under the old membership, and nothing
 * may be built or served from the two mixed. Facts that changed under the
 * same membership are installed the same way, without marks: the layer
 * predicts later writes from them. The registry it ends with is
 * recorded (`./registry-record.ts`) before it returns, so nothing is built
 * under a registry that a start-up would not find recorded. Returns whether
 * the cached snapshot changed.
 */
export async function refreshReadGraphRegistry(context: ReadGraphJobContext, contextGraphId: string): Promise<boolean> {
  const layer = readGraphLayerOf(context.store);
  if (!layer) throw new ReadGraphJobError('This store has no read-graph layer');
  const runtime = layer.runtime;
  const target = readGraphPartitionMaintenanceStore(context.store);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const version = runtime.registries.version(contextGraphId);
    const facts = await readReadGraphRegistryFacts(target, contextGraphId, jobOptions(context));
    const fresh = registrySnapshotOfFacts(contextGraphId, facts);
    const cached = runtime.registries.get(contextGraphId);
    const changed = cached !== undefined && !sameRegistry(cached, fresh);
    // The same membership can come from other facts, and the layer predicts later writes from the facts.
    const cachedFacts = runtime.registries.facts(contextGraphId);
    if (cached !== undefined && !changed && cachedFacts !== undefined && sameFacts(cachedFacts, facts)) {
      await recordReadGraphRegistry(target, runtime, fresh, jobOptions(context), context.dataDir);
      return false;
    }
    const affected = runtime.mirror.rows().map((row) => row.readGraph)
      .filter((readGraph) => parseReadGraphIri(readGraph)?.scope.contextGraphId === contextGraphId);
    const installed = await runtime.locks.withLocks(affected, async () => {
      if (runtime.registries.version(contextGraphId) !== version) return false;
      if (changed) for (const readGraph of affected) await new ReadGraphJob(context, readGraph, 'mark').markDirtyHeld();
      runtime.registries.set(fresh, facts);
      // After the marks: every ready row of the context graph follows this registry.
      await recordReadGraphRegistry(target, runtime, fresh, jobOptions(context), context.dataDir);
      return true;
    });
    if (installed) return changed;
  }
  throw new ReadGraphJobError(`The registry of ${contextGraphId} kept changing while it was read`);
}

/** Two lists of registry facts hold the same facts, in any order. */
function sameFacts(left: readonly ReadGraphRegistryFact[], right: readonly ReadGraphRegistryFact[]): boolean {
  const keys = (facts: readonly ReadGraphRegistryFact[]) => new Set(facts.map((fact) => JSON.stringify([fact.graph, fact.subject, fact.predicate, fact.object])));
  const [a, b] = [keys(left), keys(right)];
  return a.size === b.size && [...b].every((key) => a.has(key));
}

const INSTALLED_IDENTITIES = new WeakMap<ReadGraphBackendRuntime, string>();

/**
 * Install the node's working-memory identity rule on the store's read-graph
 * runtime. When the identity differs from the one installed before, every
 * working-memory read graph with a row is marked dirty under its lock first,
 * because it was built and maintained under the old rule. The first install
 * in a process marks nothing: start-up has already marked them dirty.
 */
export async function installWorkingMemoryIdentity(
  context: ReadGraphJobContext,
  node: { readonly defaultAgentAddress?: string; readonly peerId?: string },
): Promise<void> {
  const runtime = readGraphRuntimeOf(context.store);
  if (!runtime) return;
  const identity = JSON.stringify([node.defaultAgentAddress ?? null, node.peerId ?? null]);
  const installed = INSTALLED_IDENTITIES.get(runtime);
  if (identity === installed) return;
  if (installed !== undefined) {
    const workingMemory = runtime.mirror.rows().map((row) => row.readGraph)
      .filter((readGraph) => parseReadGraphIri(readGraph)?.layer === MemoryLayer.WorkingMemory);
    await runtime.locks.withLocks(workingMemory, async () => {
      for (const readGraph of workingMemory) await new ReadGraphJob(context, readGraph, 'mark').markDirtyHeld();
    });
  }
  runtime.workingMemoryIdentity = workingMemoryIdentityRule(node);
  INSTALLED_IDENTITIES.set(runtime, identity);
}

/**
 * The stored row of one read graph, read below the layer. `damaged` when its
 * row is damaged or misplaced.
 */
export async function readStoredReadGraphRow(
  store: TripleStore,
  readGraph: string,
  options: QueryOptions = {},
): Promise<{ readonly row: ReadGraphStateRow | undefined; readonly damaged: boolean }> {
  const result = await store.query(readGraphStateRowQuery(readGraph), options);
  if (result.type !== 'bindings') throw new Error('A read-graph state read expected bindings');
  const bindings = result.bindings.filter((binding) => binding.readGraph === readGraph
    && binding.stateGraph !== undefined && isReadGraphStateGraph(binding.stateGraph));
  const { rows, damaged } = parseReadGraphStateRows(bindings);
  return { row: rows[0], damaged: damaged.length > 0 };
}

/**
 * The names to list for a membership test: the exact IRIs it can hold and the
 * prefixes every other member starts with. `undefined` when the test has a
 * branch that no IRI or prefix bounds. A `not` only filters.
 */
export function readGraphEnumerationRoots(test: GraphNameTest): { readonly iris: readonly string[]; readonly prefixes: readonly string[] } | undefined {
  const iris = new Set<string>();
  const prefixes = new Set<string>();
  const walk = (inner: GraphNameTest): boolean => {
    switch (inner.kind) {
      case 'equals': iris.add(inner.iri); return true;
      case 'prefix':
      case 'one-segment-after':
      case 'address-after': prefixes.add(inner.prefix); return true;
      case 'any': return inner.tests.every(walk);
      // Every branch of `all` must hold, so one bounded branch bounds it.
      case 'all': return inner.tests.some((branch) => readGraphEnumerationRoots(branch) !== undefined && walk(branch));
      default: return false;
    }
  };
  if (!walk(test)) return undefined;
  const sorted = [...prefixes].sort(compareCodePoint);
  const outer = sorted.filter((prefix, index) => !sorted.slice(0, index).some((shorter) => prefix.startsWith(shorter)));
  return { iris: [...iris].filter((iri) => !outer.some((prefix) => iri.startsWith(prefix))).sort(compareCodePoint), prefixes: outer };
}

/** One job on one read graph. */
class ReadGraphJob {
  readonly runtime: ReadGraphBackendRuntime;
  readonly maintenance: TripleStore;
  readonly versions: ReadGraphVersions;
  readonly batching: ReadGraphBatching;
  private readonly options: QueryOptions;
  private readonly started = performance.now();
  private batches = 0;
  /** Whether this job replaced a damaged row. */
  replacedRow = false;

  constructor(private readonly context: ReadGraphJobContext, readonly readGraph: string, private readonly kind: ReadGraphJobKind) {
    const layer = readGraphLayerOf(context.store);
    if (!layer) throw new ReadGraphJobError('This store has no read-graph layer');
    // A row in the mirror makes the layer maintain every write to its members: only where the adapter can.
    if (kind !== 'remove' && missingReadGraphMethods(layer.innerStore, layer.adapterCapabilities).length > 0) {
      throw new ReadGraphJobError('This store\'s adapter cannot maintain read graphs');
    }
    this.runtime = layer.runtime;
    syncReadGraphRuntimeWithRecovery(context.store, this.runtime);
    this.maintenance = readGraphPartitionMaintenanceStore(context.store);
    if (!this.maintenance.update) throw new ReadGraphJobError('This store cannot build read graphs: it has no update()');
    this.versions = context.versions ?? CURRENT_READ_GRAPH_VERSIONS;
    this.batching = { ...DEFAULT_READ_GRAPH_BATCHING, ...context.batching };
    this.options = jobOptions(context);
  }

  locked<T>(work: () => Promise<T>): Promise<T> {
    this.context.signal?.throwIfAborted();
    return this.runtime.locks.withLocks([this.readGraph], work);
  }

  async send(update: string): Promise<void> {
    this.context.signal?.throwIfAborted();
    await this.maintenance.update!(update, this.options);
  }

  stored() {
    return readStoredReadGraphRow(this.maintenance, this.readGraph, this.options);
  }

  /**
   * One checked change of the row, under the lock the caller holds, planned
   * from the stored row `from`. Returns the stored row read back afterwards,
   * which the mirror then holds. A request that failed but whose change reads
   * back counts as done. One that failed and did not land throws; if it would
   * have taken the read graph out of service, the mirror stays out of service
   * even where the stored row still says ready: that row shows only that the
   * change did not land, not that the contents are fit to serve.
   */
  async transition(from: ReadGraphStateRow | undefined, change: ReadGraphTransition): Promise<ReadGraphStateRow | undefined> {
    const to = nextReadGraphState(from, change);
    if (change.kind !== 'publish-ready') setMirror(this.runtime.mirror, this.readGraph, to);
    let failure: { readonly error: unknown } | undefined;
    try {
      await this.send(readGraphStateCompareAndSet(from, to));
    } catch (error) {
      failure = { error };
    }
    let stored: Awaited<ReturnType<ReadGraphJob['stored']>>;
    try {
      stored = await this.stored();
    } catch (error) {
      // Neither the change nor its read landed: the store may still hold the row the change was planned from.
      if (failure && to?.state !== 'ready' && from !== undefined) noteUnstoredReadGraphMark(this.runtime, this.readGraph, from.generation);
      throw error;
    }
    if (stored.damaged) throw new ReadGraphJobError(`The state row of ${this.readGraph} is damaged`);
    if (failure && !sameRow(stored.row, to)) {
      if (to?.state === 'ready' || stored.row?.state !== 'ready') setMirror(this.runtime.mirror, this.readGraph, stored.row);
      else noteUnstoredReadGraphMark(this.runtime, this.readGraph, stored.row!.generation);
      throw failure.error;
    }
    setMirror(this.runtime.mirror, this.readGraph, stored.row);
    return stored.row;
  }

  /**
   * The stored row, made to agree with the mirror, under the lock the caller
   * holds. A damaged row is replaced by a dirty one at a new generation. A
   * stored row the mirror does not hold exactly is marked dirty from what is
   * stored: a write of the row failed or lost, and only a new generation fences
   * out what it may have left in flight. `follow` false leaves a mirror that
   * holds no row as it is.
   */
  async reconcile(follow = true): Promise<ReadGraphStateRow | undefined> {
    const stored = await this.stored();
    if (stored.damaged) return this.reset();
    const mirrored = this.runtime.mirror.get(this.readGraph);
    if (stored.row === undefined || sameRow(stored.row, mirrored) || (!follow && mirrored === undefined)) return stored.row;
    return this.transition(stored.row, { kind: 'mark-dirty' });
  }

  /** Replace whatever is stored with a dirty row at a new generation, under the lock the caller holds. */
  async reset(): Promise<ReadGraphStateRow | undefined> {
    const row: ReadGraphStateRow = {
      readGraph: this.readGraph,
      state: 'dirty',
      generation: newReadGraphGeneration(),
      ruleVersion: this.versions.ruleVersion,
      builderVersion: this.versions.builderVersion,
    };
    this.noteMayHoldPartitions();
    this.replacedRow = true;
    this.runtime.mirror.set(row);
    await this.send(readGraphStateReset(row));
    const stored = await this.stored();
    if (stored.damaged) throw new ReadGraphJobError(`The state row of ${this.readGraph} is damaged`);
    setMirror(this.runtime.mirror, this.readGraph, stored.row);
    return stored.row;
  }

  /** Mark the read graph dirty from its stored row, under the lock the caller holds. */
  async markDirtyHeld(): Promise<ReadGraphStateRow | undefined> {
    const stored = await this.stored();
    if (stored.damaged) return this.reset();
    if (stored.row === undefined) {
      this.runtime.mirror.remove(this.readGraph);
      return undefined;
    }
    return this.transition(stored.row, { kind: 'mark-dirty' });
  }

  /**
   * Bring the runtime's registry snapshot of a context graph up to what is
   * stored, holding no lock on entry. When the cache holds another snapshot,
   * every read graph of the context graph with a row is marked dirty under its
   * lock before the cache takes the new one: the layer maintained it under the
   * old membership, and a build must not mix the two.
   */
  async refreshRegistry(contextGraphId: string): Promise<void> {
    await refreshReadGraphRegistry(this.context, contextGraphId);
  }

  noteMayHoldPartitions(): void {
    if (this.context.dataDir !== undefined) noteReadGraphPartitions(this.context.dataDir);
    noteStoreMayHoldReadGraphPartitions(this.maintenance);
  }

  /** The membership of the read graph under the registry snapshot the layer maintains with, read when there is none. */
  async membership(key: ReadGraphKey): Promise<GraphNameTest> {
    const contextGraphId = key.scope.contextGraphId;
    if (!this.runtime.registries.get(contextGraphId)) await refreshReadGraphRegistry(this.context, contextGraphId);
    const registry = this.runtime.registries.get(contextGraphId)!;
    return readGraphMembership(key, registry, this.runtime.workingMemoryIdentity);
  }

  /** Whether the mirror still holds the row a job started with. */
  mirrorHolds(row: ReadGraphStateRow): () => boolean {
    return () => sameRow(this.runtime.mirror.get(this.readGraph), row);
  }

  settled(): Promise<void> {
    return this.runtime.writes.settled(this.context.signal);
  }

  /**
   * Wait for the writes in flight, then read the registry again. A write that
   * began before the row existed passed the registry by, so the membership
   * the job took may be older than what it left. A change marks this row
   * dirty, and the job, no longer in service, must end before it copies.
   * Returns whether the row is still the job's.
   */
  async settledUnderRegistry(contextGraphId: string, inService: () => boolean): Promise<boolean> {
    await this.settled();
    await this.refreshRegistry(contextGraphId);
    return inService();
  }

  async holdsTriple(): Promise<boolean> {
    const result = await this.maintenance.query(readGraphHoldsTripleAsk(this.readGraph), this.options);
    if (result.type !== 'boolean') throw new Error('A read-graph emptiness check expected a boolean');
    return result.value;
  }

  /** Empty the read graph in fenced batches, sized by time like the copies. `false` when its row moved on. */
  async drop(row: ReadGraphStateRow, inService: () => boolean): Promise<boolean> {
    const fence = fenceOf(row);
    const most = this.batching.triplesPerDrop;
    const least = Math.min(MIN_TRIPLES_PER_DROP, most);
    let limit = most;
    for (let drops = 0; await this.holdsTriple(); drops += 1) {
      if (drops > 0 && drops % DROPS_PER_ROW_CHECK === 0 && !sameRow((await this.stored()).row, row)) return false;
      const drop = readGraphFencedDrop(this.readGraph, fence, { limit });
      const began = performance.now();
      if (!(await this.batch(inService, () => this.send(drop), false))) return false;
      const elapsed = performance.now() - began;
      limit = Math.max(least, Math.min(most, nextBatchSize(limit, elapsed, { ...this.batching, maxGraphsPerBatch: most })));
      await this.pause(elapsed);
    }
    return true;
  }

  /**
   * The member graphs, listed once per job from the backend, so writes through
   * every store object over it are seen. The membership's constant names come
   * first: the root graph and the shared-memory bucket can be large, so each
   * gets a batch of its own. An absent constant copies nothing.
   */
  async members(membership: GraphNameTest): Promise<{ readonly constants: readonly string[]; readonly listed: readonly string[] }> {
    const roots = readGraphEnumerationRoots(membership);
    if (!roots) throw new ReadGraphJobError(`The members of ${this.readGraph} cannot be listed by name`);
    const listed = new Set<string>();
    const add = (graphs: readonly string[], prefix: string) => {
      for (const graph of graphs) {
        if (graph.startsWith(prefix) && !isReadGraphPartitionIri(graph) && matchesGraphNameTest(membership, graph)) listed.add(graph);
      }
    };
    if (roots.prefixes.length > 0 && !this.maintenance.readGraphInventory && !this.maintenance.listGraphsByPrefix) {
      // Without a prefix listing, one listing of the context graph's own graphs, as a full check lists them: the whole
      // store's list can exceed its internal limit, and must not stop a build of a small context graph.
      // Under the catalog's internal ceiling, as any complete list is read.
      const root = contextGraphDataUri(parseReadGraphIri(this.readGraph)!.scope.contextGraphId);
      const listing = memberGraphListingQuery(this.maintenance, root);
      const result = await readCompleteGraphCatalog(this.options, (internal) => this.maintenance.query(listing, internal));
      const graphs = result.type === 'bindings' ? result.bindings.flatMap((binding) => (binding.g === undefined ? [] : [binding.g])) : [];
      assertGraphCatalogWithinInternalLimit(graphs);
      for (const prefix of roots.prefixes) add(graphs, prefix);
    } else {
      for (const prefix of roots.prefixes) add((await readGraphInventoryByPrefix(this.maintenance, prefix, this.options)).graphs, prefix);
    }
    const constants = roots.iris.filter((iri) => matchesGraphNameTest(membership, iri));
    const unnamed = [...constants, ...listed].filter((graph) => !isSafeName(graph));
    if (unnamed.length > 0) throw new ReadGraphJobError(`${unnamed.length} member graph(s) of ${this.readGraph} have names no operation can carry`);
    return { constants, listed: [...listed].sort(compareCodePoint) };
  }

  /** Copy member graphs in fenced batches, `size` graphs at a time or sized by time. `false` when the row moved on. */
  async copy(row: ReadGraphStateRow, graphs: readonly string[], inService: () => boolean, size?: number): Promise<boolean> {
    const fence = fenceOf(row);
    let next = size ?? this.batching.graphsPerBatch;
    for (let at = 0; at < graphs.length;) {
      const chunk = graphs.slice(at, at + next);
      const began = performance.now();
      if (!(await this.batch(inService, () => this.send(readGraphBackfillBatch(this.readGraph, fence, chunk)), false))) return false;
      at += chunk.length;
      const elapsed = performance.now() - began;
      if (size === undefined) next = nextBatchSize(next, elapsed, this.batching);
      await this.pause(elapsed);
    }
    return true;
  }

  /** One batch: one lock hold, sent only while the row is still the job's. `false` when it is not. */
  async batch(inService: () => boolean, send: () => Promise<void>, pause = true): Promise<boolean> {
    const began = performance.now();
    const sent = await this.locked(async () => {
      if (!inService()) return false;
      await send();
      return true;
    });
    if (sent) {
      this.batches += 1;
      if (pause) await this.pause(performance.now() - began);
    }
    return sent;
  }

  /** Publish `ready`: the compare-and-set, the read-back and the mirror in one lock hold. */
  async publish(row: ReadGraphStateRow, inService: () => boolean): Promise<ReadGraphJobResult> {
    const published = await this.locked(async () => {
      if (!inService()) return { lost: true as const };
      return { row: await this.transition(row, { kind: 'publish-ready' }) };
    });
    if ('lost' in published) return this.lost();
    const done = published.row?.state === 'ready' && published.row.generation === row.generation;
    return this.result(done ? 'done' : 'lost', published.row);
  }

  async lost(): Promise<ReadGraphJobResult> {
    return this.result('lost', (await this.stored()).row);
  }

  result(outcome: ReadGraphJobResult['outcome'], row: ReadGraphStateRow | undefined): ReadGraphJobResult {
    return { readGraph: this.readGraph, kind: this.kind, outcome, row, batches: this.batches, durationMs: Math.round(performance.now() - this.started) };
  }

  /** A turn for the event loop, then this batch's share of time, and longer while foreground work waits on the store. */
  private async pause(elapsedMs: number): Promise<void> {
    const signal = this.context.signal;
    await nextTurn(undefined, signal ? { signal } : undefined);
    const wait = Math.min(elapsedMs * this.batching.pauseRatio, MAX_PAUSE_MS);
    if (wait >= 1) await sleep(wait, undefined, signal ? { signal } : undefined);
    for (let waited = 0; foregroundQueued(this.context.store) && waited < MAX_PRESSURE_WAIT_MS; waited += PRESSURE_POLL_MS) {
      await sleep(PRESSURE_POLL_MS, undefined, signal ? { signal } : undefined);
    }
  }
}

function jobOptions(context: ReadGraphJobContext): QueryOptions {
  return { priority: 'background', source: context.source ?? SOURCE, ...(context.signal ? { signal: context.signal } : {}) };
}

function fenceOf(row: ReadGraphStateRow): ReadGraphFence {
  return { state: row.state, generation: row.generation };
}

function setMirror(mirror: InMemoryReadGraphStateMirror, readGraph: string, row: ReadGraphStateRow | undefined): void {
  if (row) mirror.set(row);
  else mirror.remove(readGraph);
}

function sameRow(left: ReadGraphStateRow | undefined, right: ReadGraphStateRow | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.readGraph === right.readGraph && left.state === right.state && left.generation === right.generation
    && left.ruleVersion === right.ruleVersion && left.builderVersion === right.builderVersion;
}

/** Halve a batch that took more than its target time; double one that took under a quarter of it. */
function nextBatchSize(size: number, elapsedMs: number, batching: ReadGraphBatching): number {
  if (elapsedMs > batching.targetBatchMs) return Math.max(1, Math.floor(size / 2));
  return elapsedMs < batching.targetBatchMs / 4 ? Math.min(batching.maxGraphsPerBatch, size * 2) : size;
}

function foregroundQueued(store: TripleStore): boolean {
  const pressure = store.getPressureSnapshot?.();
  return pressure !== undefined && pressure.normalQueued + pressure.ackQueued + (pressure.healthQueued ?? 0) > 0;
}

function isSafeName(graph: string): boolean {
  try {
    assertSafeIri(graph);
    return true;
  } catch {
    return false;
  }
}
