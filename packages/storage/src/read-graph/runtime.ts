// SPDX-License-Identifier: Apache-2.0

/**
 * The read-graph layer's state for one backend: the per-read-graph locks, the
 * state mirror and the registry snapshots of the context graphs.
 *
 * One process can hold several store objects over one backend, such as the
 * daemon's own and a publisher runtime's, each built by `createTripleStore`.
 * Writes through different objects must still be serialized per read graph,
 * and a state change made through one must be seen through the other, so this
 * state belongs to the backend, not to a store object: every store object over
 * the same backend shares one {@link ReadGraphBackendRuntime}.
 * {@link readGraphBackendIdentity} names the backend. A store with no location
 * that another object could reach, such as an engine in memory, gets a runtime
 * of its own.
 */

import { resolve } from 'node:path';
import { compareCodePoint, parseReadGraphIri } from '@origintrail-official/dkg-core';
import type { TripleStoreConfig } from '../triple-store-composition.js';
import { workingMemoryIdentityRule, type ReadGraphRegistrySnapshot, type WorkingMemoryIdentityRule } from './membership.js';
import type { ReadGraphRegistryFact } from './registry-recognition.js';
import type { ReadGraphModes, ViewSemanticsSettings } from './settings.js';
import type { ReadGraphStateMirror, ReadGraphStateRow } from './state.js';

/**
 * Locks per read graph. A caller takes the locks of every read graph it works
 * on in one call, and they are taken in code-point order of the read-graph
 * IRIs, so two callers that share read graphs never wait on each other in a
 * cycle. Locks are held until the work settles, whether it succeeds or not.
 */
export class ReadGraphLocks {
  private readonly tails = new Map<string, Promise<void>>();
  /** How often each lock was asked for; never pruned, so it only grows. */
  private readonly requests = new Map<string, number>();

  async withLocks<T>(readGraphs: Iterable<string>, work: () => Promise<T>): Promise<T> {
    const order = [...new Set(readGraphs)].sort(compareCodePoint);
    const releases: Array<() => void> = [];
    try {
      for (const readGraph of order) releases.push(await this.acquire(readGraph));
      return await work();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  /** Whether a caller holds the lock of a read graph or waits for it. */
  isLocked(readGraph: string): boolean {
    return this.tails.has(readGraph);
  }

  /**
   * How many times the lock of a read graph has been asked for in this
   * process, counted when it is asked for. Work that ran while the lock was
   * free at its start and its end, with the same count, overlapped no holder.
   */
  turns(readGraph: string): number {
    return this.requests.get(readGraph) ?? 0;
  }

  private async acquire(readGraph: string): Promise<() => void> {
    this.requests.set(readGraph, this.turns(readGraph) + 1);
    const previous = this.tails.get(readGraph) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const tail = previous.then(() => held);
    this.tails.set(readGraph, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(readGraph) === tail) this.tails.delete(readGraph);
    };
  }
}

/**
 * The process-wide copy of a backend's state rows. The layer maintains the read
 * graphs that have a row here, whatever their state; a backend without rows
 * gets exactly today's requests. Whoever loads or changes a row in the store
 * records it here before it dispatches the write that commits it.
 */
export class InMemoryReadGraphStateMirror implements ReadGraphStateMirror {
  private readonly byReadGraph = new Map<string, ReadGraphStateRow>();
  /** How many rows each context graph has. */
  private readonly perContextGraph = new Map<string, number>();

  get(readGraph: string): ReadGraphStateRow | undefined {
    return this.byReadGraph.get(readGraph);
  }

  set(row: ReadGraphStateRow): void {
    if (!this.byReadGraph.has(row.readGraph)) this.count(row.readGraph, 1);
    this.byReadGraph.set(row.readGraph, Object.freeze({ ...row }));
  }

  remove(readGraph: string): void {
    if (this.byReadGraph.delete(readGraph)) this.count(readGraph, -1);
  }

  /** The context graphs that have at least one row. */
  contextGraphIds(): readonly string[] {
    return [...this.perContextGraph.keys()];
  }

  private count(readGraph: string, delta: number): void {
    const contextGraphId = parseReadGraphIri(readGraph)?.scope.contextGraphId;
    if (contextGraphId === undefined) return;
    const next = (this.perContextGraph.get(contextGraphId) ?? 0) + delta;
    if (next > 0) this.perContextGraph.set(contextGraphId, next);
    else this.perContextGraph.delete(contextGraphId);
  }

  rows(): readonly ReadGraphStateRow[] {
    return [...this.byReadGraph.values()];
  }

  /** The number of rows. */
  get size(): number {
    return this.byReadGraph.size;
  }
}

/**
 * The registry snapshots of context graphs, as the layer last read or
 * recognized them, with the registry facts they come from when the layer
 * read those.
 */
export class ReadGraphRegistryCache {
  private readonly snapshots = new Map<string, ReadGraphRegistrySnapshot>();
  private readonly factsByContextGraph = new Map<string, readonly ReadGraphRegistryFact[]>();
  /** When each context graph's entry last changed, and when every entry last did. */
  private readonly changedAt = new Map<string, number>();
  private clearedAt = 0;
  private changes = 0;

  get(contextGraphId: string): ReadGraphRegistrySnapshot | undefined {
    return this.snapshots.get(contextGraphId);
  }

  /** The facts behind a snapshot, or `undefined` when the snapshot was set without them or they were forgotten. */
  facts(contextGraphId: string): readonly ReadGraphRegistryFact[] | undefined {
    return this.factsByContextGraph.get(contextGraphId);
  }

  /**
   * A number that changes whenever a context graph's entry is set or
   * forgotten. A reader that started at one version installs what it read only
   * if the version is still the same: otherwise a newer entry is there.
   */
  version(contextGraphId: string): number {
    return Math.max(this.changedAt.get(contextGraphId) ?? 0, this.clearedAt);
  }

  set(snapshot: ReadGraphRegistrySnapshot, facts?: readonly ReadGraphRegistryFact[]): void {
    this.snapshots.set(snapshot.contextGraphId, Object.freeze({
      contextGraphId: snapshot.contextGraphId,
      subGraphNames: Object.freeze([...snapshot.subGraphNames]),
      childContextGraphRoots: Object.freeze([...snapshot.childContextGraphRoots]),
    }));
    if (facts) this.factsByContextGraph.set(snapshot.contextGraphId, Object.freeze([...facts]));
    else this.factsByContextGraph.delete(snapshot.contextGraphId);
    this.changed(snapshot.contextGraphId);
  }

  /**
   * Forget the facts but keep the snapshot: writes go on being maintained by
   * it, and the facts are read again before the next write that may change
   * the registry.
   */
  forgetFacts(contextGraphId: string): void {
    this.factsByContextGraph.delete(contextGraphId);
    this.changed(contextGraphId);
  }

  /** Forget a snapshot, so the next use reads the registry again. */
  invalidate(contextGraphId: string): void {
    this.snapshots.delete(contextGraphId);
    this.factsByContextGraph.delete(contextGraphId);
    this.changed(contextGraphId);
  }

  clear(): void {
    this.snapshots.clear();
    this.factsByContextGraph.clear();
    this.clearedAt = ++this.changes;
  }

  private changed(contextGraphId: string): void {
    this.changedAt.set(contextGraphId, ++this.changes);
  }
}

/**
 * The writes in flight through the read-graph layers over a backend. A write
 * decides which read graphs it maintains from the rows and registries it sees
 * when it starts, so one that started before a read graph's row existed can
 * commit unmaintained after a backfill has copied its graph. Work that starts
 * on a read graph waits for those writes with {@link settled}.
 */
export class ReadGraphWriteTracker {
  private readonly inFlight = new Set<Promise<unknown>>();

  /** Count a write from now until it settles. The promise returned settles as the write does. */
  track<T>(write: Promise<T>): Promise<T> {
    this.inFlight.add(write);
    return write.finally(() => {
      this.inFlight.delete(write);
    });
  }

  /** The number of writes in flight. */
  get size(): number {
    return this.inFlight.size;
  }

  /**
   * Resolves once every write in flight now has settled, whether it succeeded
   * or failed; writes that start later are not waited for. Call it holding no
   * read-graph lock and outside any write: a write that waits for a lock its
   * caller holds never settles. An aborted `signal` rejects the wait with its
   * reason; the writes go on.
   */
  settled(signal?: AbortSignal): Promise<void> {
    // allSettled reads the set when called, so writes that start later are not waited for.
    const all = Promise.allSettled(this.inFlight).then(() => undefined);
    if (!signal) return all;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void all.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
    });
  }
}

/** Everything the read-graph layer keeps for one backend, shared by every store object over it. */
export interface ReadGraphBackendRuntime {
  /** The backend's identity, or `undefined` for a runtime that belongs to one store object. */
  readonly backend: string | undefined;
  readonly locks: ReadGraphLocks;
  readonly mirror: InMemoryReadGraphStateMirror;
  readonly registries: ReadGraphRegistryCache;
  /** The writes in flight through every layer over the backend. */
  readonly writes: ReadGraphWriteTracker;
  /**
   * The rule that maps a working-memory draft graph to its agent. The agent
   * sets the node's rule; until it does, every agent owns only the drafts
   * written under its own address.
   */
  workingMemoryIdentity: WorkingMemoryIdentityRule;
  /** Where the node keeps read graphs; all `off` until a store configuration sets them. */
  modes: ReadGraphModes;
  /** What a view query without `semantics` gets; `per-asset` until a store configuration sets it. */
  viewSemantics: ViewSemanticsSettings;
  /**
   * Whether the backend may hold read-graph partitions, as recorded by
   * `noteStoreMayHoldReadGraphPartitions` through any store object over it.
   * Unset means not recorded.
   */
  mayHoldPartitions?: boolean;
}

const SHARED_RUNTIMES = new Map<string, ReadGraphBackendRuntime>();

/**
 * The runtime of a backend: the same object for every call with the same
 * identity in this process. `undefined` gives a new runtime that belongs to
 * the caller alone.
 */
export function readGraphBackendRuntime(backend: string | undefined): ReadGraphBackendRuntime {
  if (backend === undefined) return newRuntime(undefined);
  let runtime = SHARED_RUNTIMES.get(backend);
  if (!runtime) {
    runtime = newRuntime(backend);
    SHARED_RUNTIMES.set(backend, runtime);
  }
  return runtime;
}

function newRuntime(backend: string | undefined): ReadGraphBackendRuntime {
  return {
    backend,
    locks: new ReadGraphLocks(),
    mirror: new InMemoryReadGraphStateMirror(),
    registries: new ReadGraphRegistryCache(),
    writes: new ReadGraphWriteTracker(),
    workingMemoryIdentity: workingMemoryIdentityRule({}),
    modes: {},
    viewSemantics: {},
  };
}

/**
 * The backend a store configuration names. A built-in adapter is named by the
 * option it reads its location from (`createTripleStore`): the endpoint it
 * writes to for a server, the absolute path for an engine on disk; its other
 * options cannot change which store objects share a runtime. An adapter
 * registered under another name is named by the first location option it
 * carries (an update or query endpoint, a URL, a path), so its store objects
 * over one backend share a runtime too. `undefined` for an engine in memory,
 * and for a configuration with no location: such a store gets a runtime of its
 * own.
 */
export function readGraphBackendIdentity(config: TripleStoreConfig): string | undefined {
  const options = config.options ?? {};
  const text = (key: string): string | undefined => {
    const value = options[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  };
  const endpoint = (url: string | undefined) => (url === undefined ? undefined : `endpoint:${normalizedUrl(url)}`);
  switch (config.backend) {
    case 'blazegraph': return endpoint(text('url'));
    case 'sparql-http': return endpoint(text('updateEndpoint') ?? text('queryEndpoint'));
    case 'oxigraph-persistent':
    case 'oxigraph-worker': {
      const path = text('path');
      return path === undefined ? undefined : `path:${resolve(path)}`;
    }
    case 'oxigraph': return undefined;
    default: {
      const url = text('updateEndpoint') ?? text('queryEndpoint') ?? text('url');
      if (url !== undefined) return endpoint(url);
      const path = text('path');
      return path === undefined ? undefined : `path:${resolve(path)}`;
    }
  }
}

function normalizedUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}
