// SPDX-License-Identifier: Apache-2.0
import type { ViewReadGraphs } from '@origintrail-official/dkg-query';
import { MemoryLayer, parseReadGraphIri } from '@origintrail-official/dkg-core';
import {
  nextReadGraphState, readGraphLayerOf, readGraphModeOf, readGraphStateCompareAndSet, viewSemanticsOf, workingMemoryIdentityRule,
  type ReadGraphBackendRuntime, type ReadGraphStore, type WorkingMemoryIdentityRule,
} from '@origintrail-official/dkg-storage';

/**
 * The read graphs that merged view queries may read on this node, taken from
 * its store's read-graph layer:
 * - a read graph is kept for merged queries only where the node serves it:
 *   `query.readGraphs` is `serve` for its context graph and layer;
 * - its state is the row in the backend's process-wide mirror;
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
    keeps: (key) => readGraphModeOf(runtime.modes, key) === 'serve',
    state: (readGraph) => runtime.mirror.get(readGraph),
    get identity() {
      return runtime.workingMemoryIdentity;
    },
    defaultSemantics: (contextGraphId) => viewSemanticsOf(runtime.viewSemantics, contextGraphId),
  };
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
 * The agent installs it at start, and again when its default agent changes.
 * A new rule that gives the drafts under the peer ID to another agent first
 * marks the working-memory read graphs of both agents dirty, under their
 * locks, so neither is served with contents built under the previous rule;
 * the builder rebuilds them. A store without a read-graph layer is left as it
 * is.
 */
export async function installReadGraphWorkingMemoryIdentity(store: unknown, node: ReadGraphNodeIdentity): Promise<void> {
  const layer = readGraphLayerOf(store);
  if (layer === null) return;
  const rule = workingMemoryIdentityRule(node);
  const previous = INSTALLED.get(layer.runtime);
  if (previous !== undefined) {
    const affected = new Set<string>();
    for (const peerId of [previous.node.peerId, node.peerId]) {
      if (peerId === undefined) continue;
      const before = previous.rule.ownerOf(peerId);
      const after = rule.ownerOf(peerId);
      if (before === after) continue;
      for (const owner of [before, after]) if (owner !== undefined) affected.add(owner);
    }
    if (affected.size > 0) await markWorkingMemoryReadGraphsDirty(layer, affected);
  }
  layer.runtime.workingMemoryIdentity = rule;
  INSTALLED.set(layer.runtime, { node, rule });
}

/** Mark dirty the working-memory read graphs of `agents` that have a row: in the mirror first, then in the store. */
async function markWorkingMemoryReadGraphsDirty(layer: ReadGraphStore, agents: ReadonlySet<string>): Promise<void> {
  const { runtime } = layer;
  for (const { readGraph } of runtime.mirror.rows()) {
    const key = parseReadGraphIri(readGraph);
    if (key?.layer !== MemoryLayer.WorkingMemory || !agents.has(key.agentAddress)) continue;
    await runtime.locks.withLocks([readGraph], async () => {
      const row = runtime.mirror.get(readGraph);
      if (row === undefined || row.state === 'dirty') return;
      const dirty = nextReadGraphState(row, { kind: 'mark-dirty' });
      if (dirty === undefined) return;
      runtime.mirror.set(dirty);
      // If the store keeps the older row, a rebuild starts from it, as for the layer's own dirty marks.
      await layer.innerStore.update?.(readGraphStateCompareAndSet(row, dirty), { source: 'agent.readGraphIdentityChange' })
        .catch(() => undefined);
    });
  }
}
