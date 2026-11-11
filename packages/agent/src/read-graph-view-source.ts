// SPDX-License-Identifier: Apache-2.0
import { ViewSemanticsDeltaSampler, type ViewReadGraphs } from '@origintrail-official/dkg-query';
import { recordViewSemanticsDelta } from '@origintrail-official/dkg-core';
import {
  installWorkingMemoryIdentity, readGraphLayerOf, readGraphModeOf, viewSemanticsOf, type WorkingMemoryNodeIdentity,
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
export type ReadGraphNodeIdentity = WorkingMemoryNodeIdentity;

/**
 * Give the backend's read-graph runtime the node's working-memory identity
 * rule: every agent owns the drafts written under its own address, and the
 * default agent also those written under the node's peer ID. Merged view
 * queries and the layer's maintenance both map drafts to agents with it.
 *
 * The agent installs it at start, and again when its default agent changes,
 * right after it changes its own default and before anything is awaited.
 * Storage's `installWorkingMemoryIdentity` compares it with the rule the
 * runtime holds and, in the same synchronous step, marks dirty in the mirror
 * every working-memory read graph whose agent owns other addresses under it.
 * So no reader sees the new owner with a read graph built for the old one,
 * nor the old rule beside the new default. The marks then reach the store,
 * and the identity is recorded in the node's data directory. A store without
 * a read-graph layer is left as it is.
 */
export async function installReadGraphWorkingMemoryIdentity(store: unknown, node: ReadGraphNodeIdentity): Promise<void> {
  const layer = readGraphLayerOf(store);
  if (layer === null) return;
  await installWorkingMemoryIdentity({ store: layer, source: 'agent.readGraphIdentityChange' }, node);
}
