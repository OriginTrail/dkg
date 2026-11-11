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
import type { ReadGraphStateMirror, ReadGraphStateRow } from './state.js';

/**
 * Locks per read graph. A caller takes the locks of every read graph it works
 * on in one call, and they are taken in code-point order of the read-graph
 * IRIs, so two callers that share read graphs never wait on each other in a
 * cycle. Locks are held until the work settles, whether it succeeds or not.
 */
export class ReadGraphLocks {
  private readonly tails = new Map<string, Promise<void>>();

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

  private async acquire(readGraph: string): Promise<() => void> {
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

  get(contextGraphId: string): ReadGraphRegistrySnapshot | undefined {
    return this.snapshots.get(contextGraphId);
  }

  /** The facts behind a snapshot, or `undefined` when the snapshot was set without them. */
  facts(contextGraphId: string): readonly ReadGraphRegistryFact[] | undefined {
    return this.factsByContextGraph.get(contextGraphId);
  }

  set(snapshot: ReadGraphRegistrySnapshot, facts?: readonly ReadGraphRegistryFact[]): void {
    this.snapshots.set(snapshot.contextGraphId, Object.freeze({
      contextGraphId: snapshot.contextGraphId,
      subGraphNames: Object.freeze([...snapshot.subGraphNames]),
      childContextGraphRoots: Object.freeze([...snapshot.childContextGraphRoots]),
    }));
    if (facts) this.factsByContextGraph.set(snapshot.contextGraphId, Object.freeze([...facts]));
    else this.factsByContextGraph.delete(snapshot.contextGraphId);
  }

  /** Forget a snapshot, so the next use reads the registry again. */
  invalidate(contextGraphId: string): void {
    this.snapshots.delete(contextGraphId);
    this.factsByContextGraph.delete(contextGraphId);
  }

  clear(): void {
    this.snapshots.clear();
    this.factsByContextGraph.clear();
  }
}

/** Everything the read-graph layer keeps for one backend, shared by every store object over it. */
export interface ReadGraphBackendRuntime {
  /** The backend's identity, or `undefined` for a runtime that belongs to one store object. */
  readonly backend: string | undefined;
  readonly locks: ReadGraphLocks;
  readonly mirror: InMemoryReadGraphStateMirror;
  readonly registries: ReadGraphRegistryCache;
  /**
   * The rule that maps a working-memory draft graph to its agent. The agent
   * sets the node's rule; until it does, every agent owns only the drafts
   * written under its own address.
   */
  workingMemoryIdentity: WorkingMemoryIdentityRule;
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
    workingMemoryIdentity: workingMemoryIdentityRule({}),
  };
}

const ENDPOINT_OPTIONS = ['updateEndpoint', 'queryEndpoint', 'url'] as const;

/**
 * The backend a store configuration names: its update endpoint (or its only
 * endpoint) for a server, its absolute path for an engine on disk. `undefined`
 * for an engine in memory, which no other store object can reach.
 */
export function readGraphBackendIdentity(config: TripleStoreConfig): string | undefined {
  // The in-memory engine ignores every location option.
  if (config.backend === 'oxigraph') return undefined;
  const options = config.options ?? {};
  const text = (key: string): string | undefined => {
    const value = options[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  };
  for (const key of ENDPOINT_OPTIONS) {
    const endpoint = text(key);
    if (endpoint !== undefined) return `endpoint:${normalizedUrl(endpoint)}`;
  }
  const path = text('path');
  return path === undefined ? undefined : `path:${resolve(path)}`;
}

function normalizedUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}
