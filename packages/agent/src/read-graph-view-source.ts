// SPDX-License-Identifier: Apache-2.0
import { ViewSemanticsDeltaSampler, type ViewReadGraphs } from '@origintrail-official/dkg-query';
import { MemoryLayer, parseReadGraphIri, recordViewSemanticsDelta } from '@origintrail-official/dkg-core';
import {
  nextReadGraphState, readGraphLayerOf, readGraphModeOf, readGraphStateCompareAndSet, viewSemanticsOf, workingMemoryIdentityRule,
  type ReadGraphBackendRuntime, type ReadGraphStateRow, type ReadGraphStore, type WorkingMemoryIdentityRule,
} from '@origintrail-official/dkg-storage';

/**
 * The read graphs that merged view queries may read on this node, taken from
 * its store's read-graph layer:
 * - a read graph is kept where `query.readGraphs` is `build` or `serve` for
 *   its context graph and layer, and serves requests only under `serve`; one
 *   kept but not served still answers the semantic-delta sampler;
 * - its state is the row in the backend's process-wide mirror, and its write
 *   lock is the layer's own, which every maintained write takes;
 * - the working-memory identity rule and the default semantics
 *   (`query.viewSemantics`) are the runtime's.
 *
 * Every field reads the runtime when it is called, so a setting, a rule or a
 * row that changes later is seen. A store without a read-graph layer has no
 * source, and every view query on it is per asset.
 */
export function viewReadGraphsOf(store: unknown): ViewReadGraphs | undefined {
  const runtime = readGraphLayerOf(store)?.runtime;
  if (runtime === undefined) return undefined;
  return {
    keeps: (key) => readGraphModeOf(runtime.modes, key) !== 'off',
    serves: (key) => readGraphModeOf(runtime.modes, key) === 'serve',
    withWriteLock: (readGraph, work) => runtime.locks.withLocks([readGraph], work),
    state: (readGraph) => runtime.mirror.get(readGraph),
    get identity() {
      return runtime.workingMemoryIdentity;
    },
    defaultSemantics: (contextGraphId) => viewSemanticsOf(runtime.viewSemantics, contextGraphId),
  };
}

/**
 * The query engine's options for merged view queries: the read-graph source
 * and, with it, the semantic-delta sampler, which counts each classified
 * sample in the node's metrics. A store without a read-graph layer gets
 * neither.
 */
export function viewQueryEngineOptionsOf(store: unknown): {
  readonly readGraphs?: ViewReadGraphs;
  readonly viewSemanticsDelta?: ViewSemanticsDeltaSampler;
} {
  const readGraphs = viewReadGraphsOf(store);
  return readGraphs === undefined
    ? {}
    : { readGraphs, viewSemanticsDelta: new ViewSemanticsDeltaSampler({ onDelta: recordViewSemanticsDelta }) };
}

/** The node as its working-memory identity rule sees it. Either value may be absent. */
export interface ReadGraphNodeIdentity {
  readonly defaultAgentAddress?: string;
  readonly peerId?: string;
}

const INSTALLED = new WeakMap<ReadGraphBackendRuntime, { readonly node: ReadGraphNodeIdentity; readonly rule: WorkingMemoryIdentityRule }>();

/**
 * Give the backend's read-graph runtime the node's working-memory identity
 * rule: every agent owns the drafts written under its own address, and the
 * default agent also those written under the node's peer ID. Merged view
 * queries and the layer's maintenance both map drafts to agents with it.
 *
 * The agent installs it at start, and again when its default agent changes,
 * right after it changes its own default and before anything is awaited. A
 * new rule that gives the drafts under the peer ID to another agent marks the
 * working-memory read graphs of both agents dirty in the mirror and installs
 * itself in that same synchronous step, so no reader sees the new owner with
 * a read graph built for the old one, nor the old rule beside the new default.
 * The marks then reach the store under each read graph's lock; the builder
 * rebuilds those read graphs. A store without a read-graph layer is left as
 * it is.
 */
export async function installReadGraphWorkingMemoryIdentity(store: unknown, node: ReadGraphNodeIdentity): Promise<void> {
  const layer = readGraphLayerOf(store);
  if (layer === null) return;
  const { runtime } = layer;
  const rule = workingMemoryIdentityRule(node);
  const previous = INSTALLED.get(runtime);
  const affected = new Set<string>();
  if (previous !== undefined) {
    for (const peerId of [previous.node.peerId, node.peerId]) {
      if (peerId === undefined) continue;
      const before = previous.rule.ownerOf(peerId);
      const after = rule.ownerOf(peerId);
      if (before === after) continue;
      for (const owner of [before, after]) if (owner !== undefined) affected.add(owner);
    }
  }
  // Nothing is awaited from here until both are visible.
  const marked = affected.size > 0 ? markWorkingMemoryReadGraphsDirty(runtime, affected) : [];
  runtime.workingMemoryIdentity = rule;
  INSTALLED.set(runtime, { node, rule });
  for (const { readGraph, before } of marked) await storeDirtyMark(layer, readGraph, before);
}

/** Mark dirty, in the mirror, the working-memory read graphs of `agents` that have a row; returns each with its row before. */
function markWorkingMemoryReadGraphsDirty(
  runtime: ReadGraphBackendRuntime,
  agents: ReadonlySet<string>,
): Array<{ readonly readGraph: string; readonly before: ReadGraphStateRow }> {
  const marked: Array<{ readonly readGraph: string; readonly before: ReadGraphStateRow }> = [];
  for (const row of runtime.mirror.rows()) {
    const key = parseReadGraphIri(row.readGraph);
    if (key?.layer !== MemoryLayer.WorkingMemory || !agents.has(key.agentAddress) || row.state === 'dirty') continue;
    const dirty = nextReadGraphState(row, { kind: 'mark-dirty' });
    if (dirty === undefined) continue;
    runtime.mirror.set(dirty);
    marked.push({ readGraph: row.readGraph, before: row });
  }
  return marked;
}

/**
 * Store a dirty mark under the read graph's lock. A row that something
 * published meanwhile is marked dirty again. If the store keeps an older row,
 * a rebuild starts from it, as for the layer's own dirty marks.
 */
async function storeDirtyMark(layer: ReadGraphStore, readGraph: string, before: ReadGraphStateRow): Promise<void> {
  const { runtime } = layer;
  await runtime.locks.withLocks([readGraph], async () => {
    const current = runtime.mirror.get(readGraph);
    const from = current !== undefined && current.state !== 'dirty' ? current : before;
    const dirty = nextReadGraphState(from, { kind: 'mark-dirty' });
    if (dirty === undefined) return;
    if (from === current) runtime.mirror.set(dirty);
    await layer.innerStore.update?.(readGraphStateCompareAndSet(from, dirty), { source: 'agent.readGraphIdentityChange' })
      .catch(() => undefined);
  });
}
